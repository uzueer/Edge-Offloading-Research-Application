const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function percentile(values, p) {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(p * ordered.length) - 1)];
}

function rates(values) {
  return values.filter(value => value !== null && Number.isFinite(value));
}

/** Aggregate real per-task run rows; all time metrics are milliseconds. */
export function summarizeRun(rows, wallTimeMs) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  if (!Number.isFinite(wallTimeMs) || wallTimeMs < 0) throw new RangeError('wallTimeMs must be finite and non-negative');
  const total = rows.length;
  const succeeded = rows.filter(row => row.status === 'succeeded');
  const failed = total - succeeded.length;
  const response = rates(succeeded.map(row => row.actualResponseMs));
  const queue = rates(succeeded.map(row => row.actualQueueingMs));
  const execution = rates(succeeded.map(row => row.actualExecutionMs));
  const overhead = rates(rows.map(row => row.schedulingOverheadMs));
  const predictionErrors = rates(succeeded.map(row => row.predictionErrorMs));
  const absoluteErrors = predictionErrors.map(Math.abs);
  const taskDistribution = {};
  for (const row of rows) {
    if (row.nodeId) taskDistribution[row.nodeId] = (taskDistribution[row.nodeId] ?? 0) + 1;
  }
  const medianResponse = percentile(response, 0.5);
  return {
    taskCount: total,
    succeededCount: succeeded.length,
    failedCount: failed,
    successRate: total ? succeeded.length / total : 0,
    failureRate: total ? failed / total : 0,
    meanResponseTimeMs: mean(response),
    medianResponseTimeMs: medianResponse,
    p95ResponseTimeMs: percentile(response, 0.95),
    throughputTasksPerSecond: wallTimeMs > 0 ? succeeded.length / (wallTimeMs / 1000) : null,
    meanQueueingTimeMs: mean(queue),
    meanExecutionTimeMs: mean(execution),
    meanSchedulingOverheadMs: mean(overhead),
    taskDistribution,
    predictionErrorCount: predictionErrors.length,
    meanPredictionErrorMs: mean(predictionErrors),
    meanAbsolutePredictionErrorMs: mean(absoluteErrors),
  };
}

export function deterministicRandom(seed) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new RangeError('seed must be an unsigned 32-bit integer');
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function buildTrace(configuration, seed) {
  const random = deterministicRandom(seed);
  const trace = [];
  for (let index = 0; index < configuration.taskCount; index++) {
    const workloadMI = configuration.workloadMIMin + random() * (configuration.workloadMIMax - configuration.workloadMIMin);
    const iterations = configuration.iterationsMin + Math.floor(random() * (configuration.iterationsMax - configuration.iterationsMin + 1));
    const taskSeed = Math.floor(random() * 4_294_967_296);
    trace.push({
      traceTaskId: `trace-task-${index + 1}`,
      index,
      workloadMI: Number(workloadMI.toFixed(6)),
      iterations,
      seed: taskSeed,
      arrivalOffsetMs: index * configuration.arrivalIntervalMs,
      memoryMB: configuration.memoryMB,
      minCapacityMips: configuration.minCapacityMips,
    });
  }
  return trace;
}
