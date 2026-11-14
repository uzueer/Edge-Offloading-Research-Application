/**
 * Latency model conventions:
 * - Latencies and timestamps are milliseconds (timestamps are Unix epoch ms).
 * - Workload is million instructions (MI); capacity is million instructions/sec
 *   (MIPS), so execution time is 1000 * MI / MIPS milliseconds.
 * - Queue work is total MI ahead. We model it as fluid work shared evenly by
 *   identical slots: wait = 1000 * workAheadMI / (MIPS * slots).
 * - A task offload is treated as a request-and-result transaction, so the
 *   network component is the measured/configured round-trip time (RTT). The RTT
 *   is included exactly once in total predicted latency.
 */

function finiteNonNegative(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite, non-negative number`);
  }
  return value;
}

function positive(value, name) {
  finiteNonNegative(value, name);
  if (value === 0) throw new RangeError(`${name} must be greater than zero`);
  return value;
}

function validateTask(task) {
  if (!task || typeof task !== 'object') throw new TypeError('task is required');
  finiteNonNegative(task.workloadMI, 'task.workloadMI');
  if (task.memoryMB !== undefined) finiteNonNegative(task.memoryMB, 'task.memoryMB');
  if (task.minCapacityMips !== undefined) finiteNonNegative(task.minCapacityMips, 'task.minCapacityMips');
}

function validateNode(node) {
  if (!node || typeof node !== 'object') throw new TypeError('node is required');
  if (typeof node.id !== 'string' || !node.id) throw new TypeError('node.id must be a non-empty string');
  if (typeof node.healthy !== 'boolean') throw new TypeError(`node ${node.id} healthy must be boolean`);
  if (!node.resources || typeof node.resources !== 'object') throw new TypeError(`node ${node.id} resources are required`);
  positive(node.resources.capacityMips, `node ${node.id} capacityMips`);
  positive(node.resources.executionSlots, `node ${node.id} executionSlots`);
  finiteNonNegative(node.resources.availableMemoryMB, `node ${node.id} availableMemoryMB`);
}

/** Estimate request/result network delay from a fresh RTT measurement. */
export function estimateNetworkDelayMs(measurement, { nowMs, maxAgeMs }) {
  if (!measurement || typeof measurement !== 'object') throw new TypeError('network measurement is required');
  finiteNonNegative(measurement.rttMs, 'measurement.rttMs');
  finiteNonNegative(measurement.measuredAtMs, 'measurement.measuredAtMs');
  finiteNonNegative(nowMs, 'nowMs');
  finiteNonNegative(maxAgeMs, 'maxAgeMs');
  if (measurement.measuredAtMs > nowMs) throw new RangeError('measurement timestamp is in the future');
  if (nowMs - measurement.measuredAtMs > maxAgeMs) throw new RangeError('network measurement is stale');
  return measurement.rttMs;
}

/** Estimate task execution duration from workload MI and node capacity MIPS. */
export function estimateExecutionTimeMs(task, node) {
  validateTask(task);
  validateNode(node);
  return 1000 * task.workloadMI / node.resources.capacityMips;
}

/** Estimate wait until service starts using queued MI and parallel execution slots. */
export function estimateQueueingDelayMs(queue, node) {
  validateNode(node);
  if (!queue || typeof queue !== 'object') throw new TypeError('queue is required');
  const ahead = queue.workAheadMI;
  finiteNonNegative(ahead, 'queue.workAheadMI');
  return 1000 * ahead / (node.resources.capacityMips * node.resources.executionSlots);
}

/** Sum already-computed components; network is deliberately not inferred here. */
export function calculateTotalPredictedLatencyMs({ networkDelayMs, queueingDelayMs, executionTimeMs }) {
  finiteNonNegative(networkDelayMs, 'networkDelayMs');
  finiteNonNegative(queueingDelayMs, 'queueingDelayMs');
  finiteNonNegative(executionTimeMs, 'executionTimeMs');
  const total = networkDelayMs + queueingDelayMs + executionTimeMs;
  if (!Number.isFinite(total)) throw new RangeError('total predicted latency is not finite');
  return total;
}

/** Return eligibility plus reasons. Network freshness is a prediction prerequisite, not resource eligibility. */
export function checkNodeEligibility(task, node) {
  validateTask(task);
  validateNode(node);
  const reasons = [];
  if (!node.healthy) reasons.push('unhealthy');
  if (node.resources.availableMemoryMB < (task.memoryMB ?? 0)) reasons.push('insufficient-memory');
  if (node.resources.capacityMips < (task.minCapacityMips ?? 0)) reasons.push('insufficient-capacity');
  return { eligible: reasons.length === 0, reasons };
}

/**
 * Data shapes: Task={id, workloadMI, memoryMB?, minCapacityMips?, queue:{workAheadMI}};
 * Node={id, role:'edge'|'cloud', healthy, resources:{capacityMips, executionSlots,
 * availableMemoryMB}, network:{rttMs, measuredAtMs}}. Predictions are estimates,
 * never actual measurements.
 */
export function predictNodeLatency(task, node, { nowMs, maxMeasurementAgeMs }) {
  const networkDelayMs = estimateNetworkDelayMs(node.network, { nowMs, maxAgeMs: maxMeasurementAgeMs });
  const queue = task.queue ?? { workAheadMI: node.workAheadMI };
  const queueingDelayMs = estimateQueueingDelayMs(queue, node);
  const executionTimeMs = estimateExecutionTimeMs(task, node);
  return {
    networkDelayMs,
    queueingDelayMs,
    executionTimeMs,
    totalPredictedLatencyMs: calculateTotalPredictedLatencyMs({ networkDelayMs, queueingDelayMs, executionTimeMs }),
  };
}
