import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrace, deterministicRandom, summarizeRun } from '../src/experiments/metrics.js';
import { exportExperimentCsv, exportExperimentJson } from '../src/experiments/export.js';

test('seeded traces are repeatable and contain equivalent task inputs and controlled arrivals', () => {
  const configuration = { taskCount: 3, workloadMIMin: 1, workloadMIMax: 5,
    iterationsMin: 10, iterationsMax: 20, arrivalIntervalMs: 4, memoryMB: 8, minCapacityMips: 100 };
  assert.deepEqual(buildTrace(configuration, 123), buildTrace(configuration, 123));
  const trace = buildTrace(configuration, 123);
  assert.deepEqual(trace.map(task => task.arrivalOffsetMs), [0, 4, 8]);
  assert.ok(trace.every(task => task.iterations >= 10 && task.iterations <= 20));
  assert.notDeepEqual(buildTrace(configuration, 124), trace);
  assert.equal(deterministicRandom(1)(), deterministicRandom(1)());
});

test('research metrics calculate response percentiles, rates, throughput, queue, execution, overhead, distribution, and prediction error', () => {
  const result = summarizeRun([
    { status: 'succeeded', nodeId: 'edge-1', actualResponseMs: 10, actualQueueingMs: 1,
      actualExecutionMs: 6, schedulingOverheadMs: 0.5, predictionErrorMs: 2 },
    { status: 'succeeded', nodeId: 'cloud-1', actualResponseMs: 20, actualQueueingMs: 3,
      actualExecutionMs: 12, schedulingOverheadMs: 0.3, predictionErrorMs: -1 },
    { status: 'failed', nodeId: null, actualResponseMs: 5, schedulingOverheadMs: 0.2, predictionErrorMs: null },
  ], 2000);
  assert.equal(result.meanResponseTimeMs, 15);
  assert.equal(result.medianResponseTimeMs, 10);
  assert.equal(result.p95ResponseTimeMs, 20);
  assert.equal(result.throughputTasksPerSecond, 1);
  assert.equal(result.successRate, 2 / 3);
  assert.equal(result.failureRate, 1 / 3);
  assert.equal(result.meanQueueingTimeMs, 2);
  assert.equal(result.meanExecutionTimeMs, 9);
  assert.equal(result.meanSchedulingOverheadMs, 1 / 3);
  assert.deepEqual(result.taskDistribution, { 'edge-1': 1, 'cloud-1': 1 });
  assert.equal(result.meanPredictionErrorMs, 0.5);
  assert.equal(result.meanAbsolutePredictionErrorMs, 1.5);
});

test('CSV and JSON exports preserve configuration and nested result data safely', () => {
  const experiment = { id: 'exp-1', configuration: { randomSeed: 7, label: 'test' } };
  const results = [{ runId: 1, repetition: 0, randomSeed: 7, algorithm: 'latency-aware', taskId: 'task-1',
    nodeId: 'edge-1', predictedLatencyMs: 2, actualResponseMs: 3, recordedAt: new Date(0),
    metrics: { resultType: 'task', message: 'quoted "value"' } }];
  const csv = exportExperimentCsv(experiment, results);
  assert.match(csv, /"experiment_id"/);
  assert.match(csv, /"\{""randomSeed"":7/);
  const json = JSON.parse(exportExperimentJson(experiment, results));
  assert.deepEqual(json.experiment.configuration, experiment.configuration);
  assert.equal(json.results[0].metrics.message, 'quoted "value"');
  assert.throws(() => summarizeRun([], -1), /wallTimeMs/);
});
