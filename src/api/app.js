import express from 'express';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createEdgeOnlyScheduler, createLatencyAwareScheduler, createRoundRobinScheduler } from '../schedulers.js';
import { createExperimentService } from '../experiments/service.js';
import { exportExperimentCsv, exportExperimentJson } from '../experiments/export.js';

const ALGORITHMS = new Set(['round-robin', 'edge-only', 'latency-aware']);
const UINT32_MAX = 0xffff_ffff;

function positiveInt(value, name, max) {
  if (!Number.isSafeInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw Object.assign(new RangeError(`${name} must be an integer from 1 to ${max ?? 'safe integer max'}`), { statusCode: 400 });
  }
  return value;
}

function nonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw Object.assign(new RangeError(`${name} must be finite and non-negative`), { statusCode: 400 });
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 200) {
    throw Object.assign(new TypeError(`${name} must be a non-empty string up to 200 characters`), { statusCode: 400 });
  }
  return value;
}

function createSchedulers(maxMeasurementAgeMs) {
  return {
    'round-robin': createRoundRobinScheduler(),
    'edge-only': createEdgeOnlyScheduler(),
    'latency-aware': createLatencyAwareScheduler({ maxMeasurementAgeMs }),
  };
}

export function createApp({ pool, repository, workerClient, experimentService: injectedExperimentService,
  maxMeasurementAgeMs = 30_000, maxIterations = 10_000_000 } = {}) {
  if (!pool?.query || !repository || !workerClient?.inspectAll || !workerClient?.execute) {
    throw new TypeError('pool, repository, and workerClient dependencies are required');
  }
  const schedulers = createSchedulers(maxMeasurementAgeMs);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb', strict: true }));

  async function refreshNodes() {
    const observedAt = new Date();
    const inspections = await workerClient.inspectAll();
    const nodes = [];
    for (const { node } of inspections) {
      await repository.upsertNode(node);
      if (node.measuredProbeRttMs !== null) {
        await repository.recordNodeMeasurement({ nodeId: node.id, type: 'network_rtt', value: node.measuredProbeRttMs,
          unit: 'ms', source: 'api-health-probe', observedAt });
      }
      await repository.recordNodeMeasurement({ nodeId: node.id, type: 'network_rtt', value: node.simulatedNetworkRttMs,
        unit: 'ms', source: node.networkDelayKind ?? 'simulated-configuration', observedAt });
      nodes.push({ ...node, network: node.healthy ? { rttMs: node.simulatedNetworkRttMs, measuredAtMs: observedAt.getTime() } : null });
    }
    return nodes;
  }
  const experimentService = injectedExperimentService ?? createExperimentService({ repository, workerClient,
    refreshNodes, maxIterations, maxMeasurementAgeMs });

  app.get('/health', async (_request, response) => {
    await pool.query('SELECT 1');
    response.json({ healthy: true, database: 'connected' });
  });

  app.get('/nodes', async (_request, response) => {
    const nodes = await refreshNodes();
    response.json({ nodes: nodes.map(({ network, ...node }) => ({
      ...node,
      configuredNetworkRttMs: node.simulatedNetworkRttMs,
      configuredNetworkKind: node.networkDelayKind,
      predictionNetworkMeasurement: network,
    })) });
  });

  app.get('/nodes/:nodeId/measurements', async (request, response) => {
    const nodeId = requiredString(request.params.nodeId, 'nodeId');
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      return response.status(400).json({ error: 'invalid-limit', message: 'limit must be an integer from 1 to 1000' });
    }
    response.json({ measurements: await repository.getRecentMeasurements(nodeId, limit) });
  });

  app.post('/tasks', async (request, response) => {
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new TypeError('JSON object body is required'), { statusCode: 400 });
    const algorithm = body.algorithm ?? 'latency-aware';
    if (!ALGORITHMS.has(algorithm)) throw Object.assign(new TypeError('algorithm must be round-robin, edge-only, or latency-aware'), { statusCode: 400 });
    const taskId = body.id === undefined ? randomUUID() : requiredString(body.id, 'id');
    const workloadMI = nonNegative(body.workloadMI, 'workloadMI');
    const iterations = positiveInt(body.iterations, 'iterations', maxIterations);
    const seed = body.seed ?? 1;
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > UINT32_MAX) throw Object.assign(new RangeError('seed must be an integer from 0 to 4294967295'), { statusCode: 400 });
    const memoryMB = nonNegative(body.memoryMB ?? 0, 'memoryMB');
    const minCapacityMips = nonNegative(body.minCapacityMips ?? 0, 'minCapacityMips');
    const requestStartedAt = performance.now();
    const submittedAt = new Date();
    await repository.createTask({ id: taskId, workloadMI, memoryMB, minCapacityMips,
      payload: { iterations, seed }, workAheadMI: 0 });

    const nodes = await refreshNodes();
    const schedulerInput = {
      task: { id: taskId, workloadMI, memoryMB, minCapacityMips },
      nodes,
      nowMs: Date.now(),
    };
    const schedulingStartedAt = performance.now();
    const decision = schedulers[algorithm].schedule(schedulerInput);
    const schedulingOverheadMs = performance.now() - schedulingStartedAt;
    const persistedDecision = await repository.saveSchedulingDecision({ taskId, ...decision });

    if (!decision.selectedNode) {
      const execution = await repository.recordTaskExecution({ taskId, status: 'failed',
        actualResponseMs: performance.now() - requestStartedAt,
        error: 'No healthy, resource-eligible node was available for the selected policy.', finishedAt: new Date() });
      return response.status(503).json({ task: { id: taskId, status: 'failed' }, decision: { ...decision, decisionId: persistedDecision.id },
        execution, schedulingOverheadMs, submittedAt });
    }

    const selected = nodes.find(node => node.id === decision.selectedNode.id);
    await repository.markTaskScheduled(taskId);
    await repository.markTaskRunning(taskId);
    const startedAt = new Date();
    try {
      const workerResult = await workerClient.execute(selected.id, {
        taskId, iterations, seed, workloadMI, simulatedNetworkRttMs: selected.simulatedNetworkRttMs,
      });
      const actualResponseMs = performance.now() - requestStartedAt;
      const execution = await repository.recordTaskExecution({
        taskId, nodeId: selected.id, status: 'succeeded',
        actualNetworkMs: workerResult.network.delayMs,
        actualNetworkKind: workerResult.network.kind,
        actualQueueingMs: workerResult.measurements.queueingMs,
        actualExecutionMs: workerResult.measurements.executionMs,
        actualResponseMs,
        result: workerResult.result,
        startedAt,
        finishedAt: new Date(),
      });
      return response.status(201).json({
        task: { id: taskId, status: 'succeeded', workloadMI, iterations, seed },
        decision: { ...decision, decisionId: persistedDecision.id, schedulingOverheadMs },
        execution,
        worker: { nodeId: selected.id, configuredCapacityMips: selected.resources.capacityMips,
          configuredNetworkRttMs: selected.simulatedNetworkRttMs, networkKind: selected.networkDelayKind },
        submittedAt,
      });
    } catch (error) {
      const execution = await repository.recordTaskExecution({
        taskId, nodeId: selected.id, status: 'failed',
        actualNetworkMs: error.network?.delayMs ?? null,
        actualNetworkKind: error.network?.kind ?? null,
        actualResponseMs: performance.now() - requestStartedAt,
        error: error.message,
        startedAt,
        finishedAt: new Date(),
      });
      const failureStatus = error.statusCode === 429 ? 503 : ['TimeoutError', 'AbortError'].includes(error.name) ? 504 : 502;
      return response.status(failureStatus).json({
        task: { id: taskId, status: 'failed' }, decision: { ...decision, decisionId: persistedDecision.id }, execution,
        workerError: 'selected worker did not complete the task', schedulingOverheadMs,
      });
    }
  });

  app.get('/tasks/:taskId', async (request, response) => {
    const taskId = requiredString(request.params.taskId, 'taskId');
    const task = await repository.getTask(taskId);
    if (!task) return response.status(404).json({ error: 'task-not-found' });
    const decision = await repository.getLatestDecision(taskId);
    response.json({ task, decision });
  });

  app.post('/experiments', async (request, response) => {
    const experiment = await experimentService.start(request.body ?? {});
    response.status(202).json(experiment);
  });

  app.get('/experiments', async (request, response) => {
    const limit = request.query.limit === undefined ? 100 : Number(request.query.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      return response.status(400).json({ error: 'invalid-limit', message: 'limit must be an integer from 1 to 500' });
    }
    response.json({ experiments: await repository.listExperiments(limit) });
  });

  app.get('/experiments/:experimentId/export', async (request, response) => {
    const experiment = await repository.getExperiment(requiredString(request.params.experimentId, 'experimentId'));
    if (!experiment) return response.status(404).json({ error: 'experiment-not-found' });
    const results = await repository.getExperimentResults(experiment.id);
    const format = request.query.format ?? 'json';
    if (format === 'csv') {
      response.type('text/csv; charset=utf-8');
      response.set('content-disposition', `attachment; filename="experiment-${experiment.id}.csv"`);
      return response.send(exportExperimentCsv(experiment, results));
    }
    if (format !== 'json') return response.status(400).json({ error: 'unsupported-format', message: 'format must be json or csv' });
    response.type('application/json; charset=utf-8');
    response.set('content-disposition', `attachment; filename="experiment-${experiment.id}.json"`);
    return response.send(exportExperimentJson(experiment, results));
  });

  app.get('/experiments/:experimentId/results', async (request, response) => {
    const experimentId = requiredString(request.params.experimentId, 'experimentId');
    const experiment = await repository.getExperiment(experimentId);
    if (!experiment) return response.status(404).json({ error: 'experiment-not-found' });
    response.json({ experimentId, results: await repository.getExperimentResults(experimentId) });
  });

  app.get('/experiments/:experimentId', async (request, response) => {
    const experimentId = requiredString(request.params.experimentId, 'experimentId');
    const experiment = await repository.getExperiment(experimentId);
    if (!experiment) return response.status(404).json({ error: 'experiment-not-found' });
    response.json({ experiment, progress: experimentService.getProgress(experimentId) });
  });

  app.use((error, _request, response, next) => {
    if (response.headersSent) return next(error);
    if (error.code === '23505') return response.status(409).json({ error: 'duplicate-resource', message: 'A record with this identifier already exists.' });
    if (error.code?.startsWith('23')) return response.status(400).json({ error: 'constraint-violation', message: 'The request conflicts with database constraints.' });
    const status = error.statusCode ?? (error instanceof RangeError || error instanceof TypeError ? 400 : 500);
    return response.status(status).json({ error: status === 500 ? 'internal-error' : 'invalid-request',
      message: status === 500 ? 'The request could not be completed.' : error.message });
  });

  return app;
}
