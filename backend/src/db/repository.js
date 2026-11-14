import { withTransaction } from './pool.js';

const ALGORITHMS = new Set(['round-robin', 'edge-only', 'latency-aware']);
const NODE_ROLES = new Set(['edge', 'cloud']);
const MEASUREMENT_UNITS = new Map([
  ['network_rtt', 'ms'], ['cpu_utilization', 'percent'], ['available_memory', 'MB'],
]);

function requiredString(value, name, maxLength = 256) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string up to ${maxLength} characters`);
  }
  return value;
}

function nonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function timestamp(value, name, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new TypeError(`${name} is required`);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
  return date;
}

function jsonObject(value, name, { optional = false } = {}) {
  if (optional && value === undefined) return null;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new TypeError(`${name} must be JSON serializable`);
  }
}

function validateEstimate(estimate, candidateIndex) {
  if (estimate === undefined || estimate === null) return [null, null, null, null];
  const network = nonNegative(estimate.networkDelayMs, `candidates[${candidateIndex}].estimate.networkDelayMs`);
  const queue = nonNegative(estimate.queueingDelayMs, `candidates[${candidateIndex}].estimate.queueingDelayMs`);
  const execution = nonNegative(estimate.executionTimeMs, `candidates[${candidateIndex}].estimate.executionTimeMs`);
  const total = nonNegative(estimate.totalPredictedLatencyMs, `candidates[${candidateIndex}].estimate.totalPredictedLatencyMs`);
  const expected = network + queue + execution;
  if (!Number.isFinite(expected) || Math.abs(expected - total) > Math.max(1e-6, Math.abs(expected) * 1e-9)) {
    throw new RangeError(`candidates[${candidateIndex}] total latency must equal its components`);
  }
  return [network, queue, execution, total];
}

export function createRepository(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('a PostgreSQL pool is required');
  }

  return {
    async upsertNode(node) {
      requiredString(node?.id, 'node.id');
      if (!NODE_ROLES.has(node.role)) throw new TypeError('node.role must be edge or cloud');
      const capacity = nonNegative(node.resources?.capacityMips, 'node.resources.capacityMips');
      const slots = positiveInteger(node.resources?.executionSlots, 'node.resources.executionSlots');
      const memory = nonNegative(node.resources?.availableMemoryMB, 'node.resources.availableMemoryMB');
      if (capacity === 0) throw new RangeError('node.resources.capacityMips must be greater than zero');
      if (typeof node.healthy !== 'boolean') throw new TypeError('node.healthy must be boolean');
      const { rows } = await pool.query(`
        INSERT INTO nodes(id, role, capacity_mips, execution_slots, available_memory_mb, healthy)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role,
          capacity_mips = EXCLUDED.capacity_mips, execution_slots = EXCLUDED.execution_slots,
          available_memory_mb = EXCLUDED.available_memory_mb, healthy = EXCLUDED.healthy,
          updated_at = now()
        RETURNING *`, [node.id, node.role, capacity, slots, memory, node.healthy]);
      return mapNode(rows[0]);
    },

    async recordNodeMeasurement(measurement) {
      requiredString(measurement?.nodeId, 'measurement.nodeId');
      if (!MEASUREMENT_UNITS.has(measurement.type)) throw new TypeError('unsupported measurement type');
      if (measurement.unit !== MEASUREMENT_UNITS.get(measurement.type)) {
        throw new TypeError(`measurement type ${measurement.type} requires unit ${MEASUREMENT_UNITS.get(measurement.type)}`);
      }
      const value = nonNegative(measurement.value, 'measurement.value');
      if (measurement.type === 'cpu_utilization' && value > 100) throw new RangeError('CPU utilization must not exceed 100 percent');
      const source = requiredString(measurement.source, 'measurement.source');
      const observedAt = timestamp(measurement.observedAt, 'measurement.observedAt');
      const { rows } = await pool.query(`
        INSERT INTO node_measurements(node_id, measurement_type, value, unit, source, observed_at)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [measurement.nodeId, measurement.type, value, measurement.unit, source, observedAt]);
      return mapMeasurement(rows[0]);
    },

    async createTask(task) {
      requiredString(task?.id, 'task.id');
      const workload = nonNegative(task.workloadMI, 'task.workloadMI');
      const memory = nonNegative(task.memoryMB ?? 0, 'task.memoryMB');
      const minCapacity = nonNegative(task.minCapacityMips ?? 0, 'task.minCapacityMips');
      const workAhead = nonNegative(task.workAheadMI ?? task.queue?.workAheadMI ?? 0, 'task.workAheadMI');
      const payload = jsonObject(task.payload ?? {}, 'task.payload');
      const { rows } = await pool.query(`
        INSERT INTO tasks(id, workload_mi, memory_mb, min_capacity_mips, work_ahead_mi, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING *`,
      [task.id, workload, memory, minCapacity, workAhead, payload]);
      return mapTask(rows[0]);
    },

    async saveSchedulingDecision(decision) {
      requiredString(decision?.taskId, 'decision.taskId');
      if (!ALGORITHMS.has(decision.algorithm)) throw new TypeError('unsupported scheduling algorithm');
      if (!Array.isArray(decision.candidates)) throw new TypeError('decision.candidates must be an array');
      const chosenId = decision.selectedNode?.id ?? decision.selectedNodeId ?? null;
      const selected = decision.decision === 'scheduled';
      if (selected !== (chosenId !== null)) throw new TypeError('selected node and decision outcome are inconsistent');
      if (selected && !decision.candidates.some(candidate => candidate.nodeId === chosenId && candidate.eligible)) {
        throw new RangeError('selected node must appear as eligible in decision candidates');
      }
      if (!selected && decision.candidates.some(candidate => candidate.eligible)) {
        throw new RangeError('cannot record no-eligible-node when an eligible candidate exists');
      }
      for (const [index, candidate] of decision.candidates.entries()) {
        requiredString(candidate.nodeId, `candidates[${index}].nodeId`);
        if (typeof candidate.eligible !== 'boolean') throw new TypeError(`candidates[${index}].eligible must be boolean`);
        if (!Array.isArray(candidate.reasons)) throw new TypeError(`candidates[${index}].reasons must be an array`);
        for (const reason of candidate.reasons) requiredString(reason, `candidates[${index}].reasons[]`);
        validateEstimate(candidate.estimate, index);
      }

      return withTransaction(pool, async client => {
        const { rows } = await client.query(`
          INSERT INTO scheduling_decisions(task_id, algorithm, selected_node_id, decision)
          VALUES ($1, $2, $3, $4) RETURNING *`,
        [decision.taskId, decision.algorithm, chosenId, selected ? 'scheduled' : 'no-eligible-node']);
        const saved = rows[0];
        for (const [index, candidate] of decision.candidates.entries()) {
          const [network, queue, execution, total] = validateEstimate(candidate.estimate, index);
          await client.query(`
            INSERT INTO decision_candidates(
              decision_id, node_id, eligible, ineligibility_reasons,
              predicted_network_delay_ms, predicted_queueing_delay_ms,
              predicted_execution_time_ms, predicted_total_latency_ms
            ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)`,
          [saved.id, candidate.nodeId, candidate.eligible, JSON.stringify(candidate.reasons), network, queue, execution, total]);
        }
        return mapDecision(saved, decision.candidates);
      });
    },

    async markTaskScheduled(taskId) {
      requiredString(taskId, 'taskId');
      const { rows } = await pool.query(`UPDATE tasks SET status = 'scheduled', updated_at = now()
        WHERE id = $1 AND status = 'submitted' RETURNING id, status, updated_at`, [taskId]);
      if (!rows[0]) throw new RangeError(`task ${taskId} does not exist or is not submitted`);
      return { id: rows[0].id, status: rows[0].status, updatedAt: rows[0].updated_at };
    },

    async markTaskRunning(taskId) {
      requiredString(taskId, 'taskId');
      const { rows } = await pool.query(`UPDATE tasks SET status = 'running', updated_at = now()
        WHERE id = $1 AND status = 'scheduled' RETURNING id, status, updated_at`, [taskId]);
      if (!rows[0]) throw new RangeError(`task ${taskId} does not exist or is not scheduled`);
      return { id: rows[0].id, status: rows[0].status, updatedAt: rows[0].updated_at };
    },

    async recordTaskExecution(execution) {
      requiredString(execution?.taskId, 'execution.taskId');
      if (!['succeeded', 'failed'].includes(execution.status)) throw new TypeError('execution.status must be succeeded or failed');
      const nodeId = execution.nodeId == null ? null : requiredString(execution.nodeId, 'execution.nodeId');
      const startedAt = timestamp(execution.startedAt, 'execution.startedAt', { optional: true });
      const finishedAt = timestamp(execution.finishedAt ?? new Date(), 'execution.finishedAt');
      const duration = key => execution[key] == null ? null : nonNegative(execution[key], `execution.${key}`);
      const actualNetwork = duration('actualNetworkMs');
      const actualQueue = duration('actualQueueingMs');
      const actualExecution = duration('actualExecutionMs');
      const actualResponse = duration('actualResponseMs');
      const actualNetworkKind = execution.actualNetworkKind ?? (actualNetwork === null ? null : 'measured');
      if (actualNetworkKind !== null && !['measured', 'simulated'].includes(actualNetworkKind)) {
        throw new TypeError('execution.actualNetworkKind must be measured or simulated');
      }
      if ((actualNetwork === null) !== (actualNetworkKind === null)) {
        throw new TypeError('actualNetworkMs and actualNetworkKind must both be set or both be null');
      }
      const error = execution.error == null ? null : requiredString(execution.error, 'execution.error', 4000);
      if (execution.status === 'succeeded' && error !== null) throw new TypeError('successful execution cannot have an error');
      if (execution.status === 'failed' && error === null) throw new TypeError('failed execution must include an error');
      const result = execution.status === 'succeeded' ? jsonObject(execution.result ?? {}, 'execution.result') : null;

      return withTransaction(pool, async client => {
        const taskUpdate = await client.query(`UPDATE tasks SET status = $2, updated_at = now()
          WHERE id = $1 AND status IN ('submitted', 'scheduled', 'running') RETURNING id`,
        [execution.taskId, execution.status]);
        if (!taskUpdate.rowCount) throw new RangeError(`task ${execution.taskId} does not exist or is already terminal`);
        const { rows } = await client.query(`
          INSERT INTO task_executions(
            task_id, node_id, status, actual_network_ms, actual_network_kind, actual_queueing_ms,
            actual_execution_ms, actual_response_ms, result, error, started_at, finished_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12) RETURNING *`,
        [execution.taskId, nodeId, execution.status, actualNetwork, actualNetworkKind, actualQueue, actualExecution,
          actualResponse, result, error, startedAt, finishedAt]);
        return mapExecution(rows[0]);
      });
    },

    async createExperiment(experiment) {
      requiredString(experiment?.id, 'experiment.id');
      const name = requiredString(experiment.name, 'experiment.name', 500);
      const configuration = jsonObject(experiment.configuration, 'experiment.configuration');
      const repetitions = positiveInteger(experiment.repetitions, 'experiment.repetitions');
      const seed = experiment.randomSeed ?? null;
      if (seed !== null && !Number.isSafeInteger(seed)) throw new RangeError('experiment.randomSeed must be a safe integer');
      const { rows } = await pool.query(`
        INSERT INTO experiments(id, name, configuration, random_seed, repetitions)
        VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING *`,
      [experiment.id, name, configuration, seed, repetitions]);
      return mapExperiment(rows[0]);
    },

    async createExperimentRun(run) {
      requiredString(run?.experimentId, 'run.experimentId');
      if (!Number.isSafeInteger(run.repetition) || run.repetition < 0) throw new RangeError('run.repetition must be a non-negative safe integer');
      const seed = run.randomSeed ?? null;
      if (seed !== null && !Number.isSafeInteger(seed)) throw new RangeError('run.randomSeed must be a safe integer');
      const { rows } = await pool.query(`
        INSERT INTO experiment_runs(experiment_id, repetition, random_seed, status, started_at)
        VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [run.experimentId, run.repetition, seed, run.status ?? 'pending', timestamp(run.startedAt, 'run.startedAt', { optional: true })]);
      return { ...rows[0], id: Number(rows[0].id), repetition: Number(rows[0].repetition),
        random_seed: numberOrNull(rows[0].random_seed) };
    },

    async updateExperimentRun(runId, { status, startedAt, finishedAt } = {}) {
      if (!Number.isSafeInteger(runId) || runId <= 0) throw new RangeError('runId must be a positive safe integer');
      if (!['running', 'succeeded', 'failed'].includes(status)) throw new TypeError('invalid experiment run status');
      const start = timestamp(startedAt, 'startedAt', { optional: true });
      const finish = timestamp(finishedAt, 'finishedAt', { optional: true });
      const { rows } = await pool.query(`UPDATE experiment_runs
        SET status = $2, started_at = COALESCE($3, started_at), finished_at = COALESCE($4, finished_at)
        WHERE id = $1 AND (
          (status = 'pending' AND $2 IN ('running', 'failed')) OR
          (status = 'running' AND $2 IN ('succeeded', 'failed'))
        ) RETURNING *`, [runId, status, start, finish]);
      if (!rows[0]) throw new RangeError(`experiment run ${runId} does not exist or cannot transition to ${status}`);
      return rows[0];
    },

    async saveExperimentResult(result) {
      if (!Number.isSafeInteger(result?.runId) || result.runId <= 0) throw new RangeError('result.runId must be a positive safe integer');
      if (!ALGORITHMS.has(result.algorithm)) throw new TypeError('unsupported result algorithm');
      const taskId = result.taskId == null ? null : requiredString(result.taskId, 'result.taskId');
      const nodeId = result.nodeId == null ? null : requiredString(result.nodeId, 'result.nodeId');
      const metrics = jsonObject(result.metrics, 'result.metrics');
      const predicted = result.predictedLatencyMs == null ? null : nonNegative(result.predictedLatencyMs, 'result.predictedLatencyMs');
      const actual = result.actualResponseMs == null ? null : nonNegative(result.actualResponseMs, 'result.actualResponseMs');
      const { rows } = await pool.query(`
        INSERT INTO experiment_results(run_id, algorithm, task_id, node_id, metrics, predicted_latency_ms, actual_response_ms)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7) RETURNING *`,
      [result.runId, result.algorithm, taskId, nodeId, metrics, predicted, actual]);
      return rows[0];
    },

    async getExperiment(id) {
      const { rows } = await pool.query('SELECT * FROM experiments WHERE id = $1', [requiredString(id, 'id')]);
      if (!rows[0]) return null;
      const experiment = mapExperiment(rows[0]);
      const runRows = await pool.query(`SELECT * FROM experiment_runs WHERE experiment_id = $1 ORDER BY repetition`, [id]);
      return { ...experiment, runs: runRows.rows.map(row => ({
        id: Number(row.id), repetition: row.repetition, randomSeed: numberOrNull(row.random_seed),
        status: row.status, startedAt: row.started_at, finishedAt: row.finished_at,
      })) };
    },

    async listExperiments(limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('limit must be an integer from 1 to 500');
      const { rows } = await pool.query('SELECT * FROM experiments ORDER BY created_at DESC LIMIT $1', [limit]);
      return rows.map(mapExperiment);
    },

    async getExperimentResults(experimentId) {
      requiredString(experimentId, 'experimentId');
      const { rows } = await pool.query(`SELECT r.id, r.run_id, e.repetition, e.random_seed, r.algorithm, r.task_id, r.node_id,
          r.metrics, r.predicted_latency_ms, r.actual_response_ms, r.recorded_at
        FROM experiment_results r JOIN experiment_runs e ON e.id = r.run_id
        WHERE e.experiment_id = $1 ORDER BY e.repetition, r.algorithm, r.task_id NULLS LAST, r.id`, [experimentId]);
      return rows.map(row => ({ id: Number(row.id), runId: Number(row.run_id), repetition: row.repetition,
        randomSeed: numberOrNull(row.random_seed),
        algorithm: row.algorithm, taskId: row.task_id, nodeId: row.node_id, metrics: row.metrics,
        predictedLatencyMs: numberOrNull(row.predicted_latency_ms), actualResponseMs: numberOrNull(row.actual_response_ms),
        recordedAt: row.recorded_at }));
    },

    async getNode(id) {
      const { rows } = await pool.query('SELECT * FROM nodes WHERE id = $1', [requiredString(id, 'id')]);
      return rows[0] ? mapNode(rows[0]) : null;
    },

    async getTask(id) {
      const { rows } = await pool.query(`SELECT t.*, e.id AS execution_id, e.node_id AS execution_node_id,
          e.status AS execution_status, e.actual_network_ms, e.actual_queueing_ms,
          e.actual_network_kind,
          e.actual_execution_ms, e.actual_response_ms, e.result AS execution_result,
          e.error AS execution_error, e.started_at, e.finished_at
        FROM tasks t LEFT JOIN task_executions e ON e.task_id = t.id WHERE t.id = $1`, [requiredString(id, 'id')]);
      if (!rows[0]) return null;
      const row = rows[0];
      return {
        ...mapTask(row),
        execution: row.execution_id == null ? null : {
          id: Number(row.execution_id), nodeId: row.execution_node_id, status: row.execution_status,
          actualNetworkMs: numberOrNull(row.actual_network_ms), actualNetworkKind: row.actual_network_kind,
          actualQueueingMs: numberOrNull(row.actual_queueing_ms),
          actualExecutionMs: numberOrNull(row.actual_execution_ms), actualResponseMs: numberOrNull(row.actual_response_ms),
          result: row.execution_result, error: row.execution_error, startedAt: row.started_at, finishedAt: row.finished_at,
        },
      };
    },

    async getLatestDecision(taskId) {
      const { rows } = await pool.query(`SELECT d.id, d.task_id, d.algorithm, d.selected_node_id, d.decision, d.created_at,
          c.node_id, c.eligible, c.ineligibility_reasons, c.predicted_network_delay_ms,
          c.predicted_queueing_delay_ms, c.predicted_execution_time_ms, c.predicted_total_latency_ms
        FROM scheduling_decisions d LEFT JOIN decision_candidates c ON c.decision_id = d.id
        WHERE d.task_id = $1 AND d.id = (SELECT max(id) FROM scheduling_decisions WHERE task_id = $1)
        ORDER BY c.node_id`, [requiredString(taskId, 'taskId')]);
      if (!rows.length) return null;
      const first = rows[0];
      return {
        id: Number(first.id), taskId: first.task_id, algorithm: first.algorithm,
        selectedNodeId: first.selected_node_id, decision: first.decision, createdAt: first.created_at,
        candidates: rows.filter(row => row.node_id !== null).map(row => ({
          nodeId: row.node_id, eligible: row.eligible, reasons: row.ineligibility_reasons,
          estimate: row.predicted_total_latency_ms == null ? null : {
            networkDelayMs: Number(row.predicted_network_delay_ms),
            queueingDelayMs: Number(row.predicted_queueing_delay_ms),
            executionTimeMs: Number(row.predicted_execution_time_ms),
            totalPredictedLatencyMs: Number(row.predicted_total_latency_ms),
          },
        })),
      };
    },

    async getRecentMeasurements(nodeId, limit = 100) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit must be an integer from 1 to 1000');
      const { rows } = await pool.query(`SELECT * FROM node_measurements WHERE node_id = $1
        ORDER BY observed_at DESC, id DESC LIMIT $2`, [requiredString(nodeId, 'nodeId'), limit]);
      return rows.map(mapMeasurement);
    },
  };
}

function numberOrNull(value) { return value == null ? null : Number(value); }
function mapNode(row) {
  return { id: row.id, role: row.role, healthy: row.healthy, resources: {
    capacityMips: Number(row.capacity_mips), executionSlots: row.execution_slots,
    availableMemoryMB: Number(row.available_memory_mb),
  }, updatedAt: row.updated_at };
}
function mapTask(row) {
  return { id: row.id, workloadMI: Number(row.workload_mi), memoryMB: Number(row.memory_mb),
    minCapacityMips: Number(row.min_capacity_mips), workAheadMI: Number(row.work_ahead_mi),
    status: row.status, payload: row.payload, createdAt: row.created_at, updatedAt: row.updated_at };
}
function mapMeasurement(row) {
  return { id: Number(row.id), nodeId: row.node_id, type: row.measurement_type,
    value: Number(row.value), unit: row.unit, source: row.source,
    observedAt: row.observed_at, recordedAt: row.recorded_at };
}
function mapDecision(row, candidates) {
  return { id: Number(row.id), taskId: row.task_id, algorithm: row.algorithm,
    selectedNodeId: row.selected_node_id, decision: row.decision, createdAt: row.created_at, candidates };
}
function mapExecution(row) {
  return { id: Number(row.id), taskId: row.task_id, nodeId: row.node_id, status: row.status,
    actualNetworkMs: numberOrNull(row.actual_network_ms), actualNetworkKind: row.actual_network_kind,
    actualQueueingMs: numberOrNull(row.actual_queueing_ms),
    actualExecutionMs: numberOrNull(row.actual_execution_ms), actualResponseMs: numberOrNull(row.actual_response_ms),
    result: row.result, error: row.error, startedAt: row.started_at, finishedAt: row.finished_at };
}
function mapExperiment(row) {
  return { id: row.id, name: row.name, configuration: row.configuration,
    randomSeed: row.random_seed == null ? null : Number(row.random_seed), repetitions: row.repetitions, createdAt: row.created_at };
}
