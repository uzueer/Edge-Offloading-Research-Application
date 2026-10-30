import { randomInt, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createEdgeOnlyScheduler, createLatencyAwareScheduler, createRoundRobinScheduler } from '../schedulers.js';
import { predictNodeLatency } from '../latency-model.js';
import { buildTrace, summarizeRun } from './metrics.js';

export const EXPERIMENT_ALGORITHMS = ['round-robin', 'edge-only', 'latency-aware'];

function finiteInRange(value, name, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw Object.assign(new RangeError(`${name} must be between ${min} and ${max}`), { statusCode: 400 });
  }
  return value;
}

function integerInRange(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw Object.assign(new RangeError(`${name} must be an integer between ${min} and ${max}`), { statusCode: 400 });
  }
  return value;
}

function normalizeConfiguration(input, workers, maxIterations) {
  const taskCount = integerInRange(input.taskCount ?? 9, 'taskCount', 1, 100);
  const repetitions = integerInRange(input.repetitions ?? 1, 'repetitions', 1, 30);
  const workloadMIMin = finiteInRange(input.workloadMIMin ?? 1, 'workloadMIMin', 0, 1e9);
  const workloadMIMax = finiteInRange(input.workloadMIMax ?? 10, 'workloadMIMax', workloadMIMin, 1e9);
  const iterationsMin = integerInRange(input.iterationsMin ?? 10_000, 'iterationsMin', 1, maxIterations);
  const iterationsMax = integerInRange(input.iterationsMax ?? 50_000, 'iterationsMax', iterationsMin, maxIterations);
  const arrivalIntervalMs = integerInRange(input.arrivalIntervalMs ?? 0, 'arrivalIntervalMs', 0, 60_000);
  const memoryMB = finiteInRange(input.memoryMB ?? 64, 'memoryMB', 0, 1e9);
  const minCapacityMips = finiteInRange(input.minCapacityMips ?? 0, 'minCapacityMips', 0, 1e9);
  const randomSeed = input.randomSeed === undefined ? randomInt(0, 0x1_0000_0000) : integerInRange(input.randomSeed, 'randomSeed', 0, 0xffff_ffff);
  const name = input.name ?? `Offloading experiment ${new Date().toISOString()}`;
  if (typeof name !== 'string' || name.trim() === '' || name.length > 500) throw Object.assign(new TypeError('name must be a non-empty string up to 500 characters'), { statusCode: 400 });
  const knownIds = new Set(workers.map(worker => worker.id));
  const nodeProfiles = input.nodeProfiles ?? {};
  if (!nodeProfiles || typeof nodeProfiles !== 'object' || Array.isArray(nodeProfiles)) throw Object.assign(new TypeError('nodeProfiles must be an object keyed by node id'), { statusCode: 400 });
  for (const [id, profile] of Object.entries(nodeProfiles)) {
    if (!knownIds.has(id)) throw Object.assign(new TypeError(`nodeProfiles contains unknown node ${id}`), { statusCode: 400 });
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw Object.assign(new TypeError(`nodeProfiles.${id} must be an object`), { statusCode: 400 });
    if (profile.capacityMips !== undefined) finiteInRange(profile.capacityMips, `nodeProfiles.${id}.capacityMips`, 0.001, 1e9);
    if (profile.executionSlots !== undefined) integerInRange(profile.executionSlots, `nodeProfiles.${id}.executionSlots`, 1, 1024);
    if (profile.availableMemoryMB !== undefined) finiteInRange(profile.availableMemoryMB, `nodeProfiles.${id}.availableMemoryMB`, 0, 1e9);
    if (profile.networkRttMs !== undefined) finiteInRange(profile.networkRttMs, `nodeProfiles.${id}.networkRttMs`, 0, 60_000);
    for (const key of Object.keys(profile)) {
      if (!['capacityMips', 'executionSlots', 'availableMemoryMB', 'networkRttMs'].includes(key)) {
        throw Object.assign(new TypeError(`unsupported node profile field ${id}.${key}`), { statusCode: 400 });
      }
    }
  }
  return { name, taskCount, repetitions, workloadMIMin, workloadMIMax, iterationsMin, iterationsMax,
    arrivalIntervalMs, memoryMB, minCapacityMips, randomSeed, nodeProfiles };
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function newScheduler(algorithm, maxMeasurementAgeMs) {
  if (algorithm === 'round-robin') return createRoundRobinScheduler();
  if (algorithm === 'edge-only') return createEdgeOnlyScheduler();
  return createLatencyAwareScheduler({ maxMeasurementAgeMs });
}

function profileNode(node, configuration) {
  const profile = configuration.nodeProfiles[node.id] ?? {};
  const networkRttMs = profile.networkRttMs ?? node.simulatedNetworkRttMs;
  return {
    ...node,
    resources: {
      ...node.resources,
      capacityMips: profile.capacityMips ?? node.resources.capacityMips,
      executionSlots: profile.executionSlots ?? node.resources.executionSlots,
      availableMemoryMB: profile.availableMemoryMB ?? node.resources.availableMemoryMB,
    },
    network: node.healthy ? { rttMs: networkRttMs, measuredAtMs: Date.now() } : null,
    simulatedNetworkRttMs: networkRttMs,
    networkDelayKind: Object.hasOwn(profile, 'networkRttMs') ? 'simulated-experiment-configuration' : node.networkDelayKind,
  };
}

async function waitForIdle(workerClient, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const states = await workerClient.inspectAll();
    const busy = states.some(({ node }) => node.status && (node.status.activeTasks > 0 || node.status.queuedTasks > 0));
    if (!busy) return;
    await wait(25);
  }
  throw new Error('workers did not return to an idle initial state before the next algorithm replay');
}

export function createExperimentService({ repository, workerClient, refreshNodes, maxIterations = 10_000_000,
  maxMeasurementAgeMs = 30_000 } = {}) {
  if (!repository?.createExperiment || !workerClient?.execute || !workerClient?.inspectAll || typeof refreshNodes !== 'function') {
    throw new TypeError('repository, workerClient, and refreshNodes are required');
  }
  const progressByExperiment = new Map();

  async function dispatchTask({ experimentId, runId, algorithm, configuration, scheduler, traceEntry, policyStart, onFinished,
    previousTurn, releaseTurn }) {
    await previousTurn;
    try {
      return await dispatchTaskInOrder({ experimentId, runId, algorithm, configuration, scheduler, traceEntry,
        policyStart, onFinished, releaseTurn });
    } finally {
      releaseTurn();
    }
  }

  async function dispatchTaskInOrder({ experimentId, runId, algorithm, configuration, scheduler, traceEntry,
    policyStart, onFinished, releaseTurn }) {
    const taskId = `${experimentId}-r${traceEntry.repetition}-${algorithm}-t${traceEntry.index + 1}`;
    const requestStartedAt = performance.now();
    const submittedAt = new Date();
    await repository.createTask({ id: taskId, workloadMI: traceEntry.workloadMI,
      memoryMB: traceEntry.memoryMB, minCapacityMips: traceEntry.minCapacityMips,
      payload: { iterations: traceEntry.iterations, seed: traceEntry.seed, traceTaskId: traceEntry.traceTaskId,
        arrivalOffsetMs: traceEntry.arrivalOffsetMs, experimentId, runId, algorithm } });

    const liveNodes = (await refreshNodes()).map(node => profileNode(node, configuration));
    const task = { id: taskId, workloadMI: traceEntry.workloadMI,
      memoryMB: traceEntry.memoryMB, minCapacityMips: traceEntry.minCapacityMips };
    const nowMs = Date.now();
    const schedulerStartedAt = performance.now();
    const decision = scheduler.schedule({ task, nodes: liveNodes, nowMs });
    const schedulingOverheadMs = performance.now() - schedulerStartedAt;
    await repository.saveSchedulingDecision({ taskId, ...decision });
    const selectedNode = decision.selectedNode ? liveNodes.find(node => node.id === decision.selectedNode.id) : null;

    let prediction = null;
    if (selectedNode) {
      const candidatePrediction = decision.candidates.find(candidate => candidate.nodeId === selectedNode.id)?.estimate;
      try {
        prediction = candidatePrediction ?? predictNodeLatency(task, selectedNode, { nowMs, maxMeasurementAgeMs });
      } catch {
        prediction = null;
      }
    }

    let status = 'failed';
    let nodeId = selectedNode?.id ?? null;
    let executionResult = null;
    let actualNetworkMs = null;
    let actualNetworkKind = null;
    let actualQueueingMs = null;
    let actualExecutionMs = null;
    let actualResponseMs;
    let errorMessage = null;
    let modelledActualLatencyMs = null;
    const executionStartedAt = new Date();

    if (!selectedNode) {
      releaseTurn();
      errorMessage = 'No healthy, resource-eligible node was available for the selected policy.';
      actualResponseMs = performance.now() - requestStartedAt;
      await repository.recordTaskExecution({ taskId, status: 'failed', actualResponseMs,
        error: errorMessage, finishedAt: new Date() });
    } else {
      try {
        await repository.markTaskScheduled(taskId);
        await repository.markTaskRunning(taskId);
        const outcomePromise = workerClient.execute(selectedNode.id, {
          taskId, iterations: traceEntry.iterations, seed: traceEntry.seed,
          workloadMI: traceEntry.workloadMI, simulatedNetworkRttMs: selectedNode.simulatedNetworkRttMs,
        });
        releaseTurn();
        const outcome = await outcomePromise;
        actualResponseMs = performance.now() - requestStartedAt;
        status = 'succeeded';
        executionResult = outcome.result;
        actualNetworkMs = outcome.network.delayMs;
        actualNetworkKind = outcome.network.kind;
        actualQueueingMs = outcome.measurements.queueingMs;
        actualExecutionMs = outcome.measurements.executionMs;
        modelledActualLatencyMs = [actualNetworkMs, actualQueueingMs, actualExecutionMs].every(Number.isFinite)
          ? actualNetworkMs + actualQueueingMs + actualExecutionMs : null;
        await repository.recordTaskExecution({ taskId, nodeId, status, actualNetworkMs, actualNetworkKind,
          actualQueueingMs, actualExecutionMs, actualResponseMs, result: executionResult,
          startedAt: executionStartedAt, finishedAt: new Date() });
      } catch (error) {
        actualResponseMs = performance.now() - requestStartedAt;
        errorMessage = error.message;
        actualNetworkMs = error.network?.delayMs ?? null;
        actualNetworkKind = error.network?.kind ?? null;
        await repository.recordTaskExecution({ taskId, nodeId, status: 'failed', actualNetworkMs, actualNetworkKind,
          actualResponseMs, error: errorMessage, startedAt: executionStartedAt, finishedAt: new Date() });
      }
    }

    const predictionErrorMs = prediction && modelledActualLatencyMs !== null
      ? modelledActualLatencyMs - prediction.totalPredictedLatencyMs : null;
    const metrics = {
      resultType: 'task',
      traceTaskId: traceEntry.traceTaskId,
      taskIndex: traceEntry.index,
      workloadMI: traceEntry.workloadMI,
      iterations: traceEntry.iterations,
      taskSeed: traceEntry.seed,
      arrivalOffsetMs: traceEntry.arrivalOffsetMs,
      status,
      schedulingOverheadMs,
      predictedComponents: prediction,
      predictedLatencyMs: prediction?.totalPredictedLatencyMs ?? null,
      actualNetworkMs,
      actualNetworkKind,
      actualQueueingMs,
      actualExecutionMs,
      modelledActualLatencyMs,
      actualResponseMs,
      predictionErrorMs,
      error: errorMessage,
      taskResult: executionResult,
      algorithmStartedAtOffsetMs: performance.now() - policyStart,
      submittedAt: submittedAt.toISOString(),
    };
    await repository.saveExperimentResult({ runId, algorithm, taskId, nodeId, metrics,
      predictedLatencyMs: metrics.predictedLatencyMs, actualResponseMs });
    const row = { taskId, status, nodeId, actualResponseMs, actualQueueingMs, actualExecutionMs,
      schedulingOverheadMs, predictionErrorMs, modelledActualLatencyMs };
    onFinished(row);
    return row;
  }

  async function executeRun(experiment, run, progress) {
    await repository.updateExperimentRun(run.id, { status: 'running', startedAt: new Date() });
    const traceSeed = (experiment.randomSeed + run.repetition * 0x9e37_79b9) >>> 0;
    const trace = buildTrace(experiment.configuration, traceSeed).map(entry => ({ ...entry, repetition: run.repetition }));
    const orderStartIndex = run.repetition % EXPERIMENT_ALGORITHMS.length;
    const orderedAlgorithms = [...EXPERIMENT_ALGORITHMS.slice(orderStartIndex), ...EXPERIMENT_ALGORITHMS.slice(0, orderStartIndex)];
    const summaries = {};

    for (const algorithm of orderedAlgorithms) {
      await waitForIdle(workerClient);
      const scheduler = newScheduler(algorithm, maxMeasurementAgeMs);
      const startedAt = performance.now();
      const tasks = [];
      let launchChain = Promise.resolve();
      for (const entry of trace) {
        const dueAt = startedAt + entry.arrivalOffsetMs;
        const delay = dueAt - performance.now();
        if (delay > 0) await wait(delay);
        const previousTurn = launchChain;
        let releaseTurn;
        launchChain = new Promise(resolve => { releaseTurn = resolve; });
        tasks.push(dispatchTask({ experimentId: experiment.id, runId: run.id, algorithm,
          configuration: experiment.configuration, scheduler, traceEntry: entry, policyStart: startedAt,
          onFinished: () => { progress.completedTasks++; }, previousTurn, releaseTurn }));
      }
      const taskRows = await Promise.all(tasks);
      const wallTimeMs = performance.now() - startedAt;
      const summary = summarizeRun(taskRows, wallTimeMs);
      summary.runWallTimeMs = wallTimeMs;
      summary.policyOrderIndex = orderedAlgorithms.indexOf(algorithm);
      summaries[algorithm] = { summary, taskRows };
    }

    const latencyAwareMean = summaries['latency-aware']?.summary.meanResponseTimeMs;
    const relativePerformanceImprovement = {};
    for (const baseline of ['round-robin', 'edge-only']) {
      const baselineMean = summaries[baseline]?.summary.meanResponseTimeMs;
      relativePerformanceImprovement[baseline] = baselineMean > 0 && latencyAwareMean !== null && latencyAwareMean !== undefined
        ? ((baselineMean - latencyAwareMean) / baselineMean) * 100 : null;
    }
    for (const algorithm of EXPERIMENT_ALGORITHMS) {
      const data = summaries[algorithm];
      await repository.saveExperimentResult({ runId: run.id, algorithm, metrics: {
        resultType: 'aggregate', traceSeed, summary: data.summary,
        latencyAwareRelativePerformanceImprovementPercent: relativePerformanceImprovement,
      }, actualResponseMs: data.summary.meanResponseTimeMs });
    }
    await repository.updateExperimentRun(run.id, { status: 'succeeded', finishedAt: new Date() });
    progress.completedRuns++;
  }

  async function executeAll(experiment, runs, progress) {
    progress.status = 'running';
    try {
      for (const run of runs) {
        progress.currentRepetition = run.repetition;
        try {
          await executeRun(experiment, run, progress);
        } catch (error) {
          await repository.updateExperimentRun(run.id, { status: 'failed', finishedAt: new Date() });
          throw error;
        }
      }
      progress.status = 'succeeded';
    } catch (error) {
      progress.status = 'failed';
      progress.error = error.message;
    }
  }

  return {
    async start(input) {
      const configuration = normalizeConfiguration(input, workerClient.workers, maxIterations);
      const id = randomUUID();
      const experiment = await repository.createExperiment({ id, name: configuration.name,
        configuration, randomSeed: configuration.randomSeed, repetitions: configuration.repetitions });
      const runs = [];
      for (let repetition = 0; repetition < configuration.repetitions; repetition++) {
        const seed = (configuration.randomSeed + repetition * 0x9e37_79b9) >>> 0;
        runs.push(await repository.createExperimentRun({ experimentId: id, repetition, randomSeed: seed }));
      }
      const progress = { experimentId: id, status: 'pending', completedRuns: 0, completedTasks: 0,
        totalRuns: runs.length, totalTasks: runs.length * configuration.taskCount * EXPERIMENT_ALGORITHMS.length,
        currentRepetition: null, error: null };
      progressByExperiment.set(id, progress);
      setImmediate(() => { void executeAll({ ...experiment, configuration }, runs, progress); });
      return { ...experiment, runs: runs.map(run => ({ ...run, id: Number(run.id) })), progress };
    },

    getProgress(id) { return progressByExperiment.get(id) ?? null; },
  };
}
