import test from 'node:test';
import assert from 'node:assert/strict';
import { executeDeterministicWork, validateComputeRequest } from '../src/workers/compute.js';
import { createWorkerServer } from '../src/workers/server.js';

test('bounded compute is deterministic and returns verifiable output digest', async () => {
  const input = validateComputeRequest({ taskId: 'fixture', iterations: 1000, seed: 7 });
  const first = await executeDeterministicWork(input, { chunkSize: 100 });
  const second = await executeDeterministicWork(input, { chunkSize: 333 });
  assert.deepEqual(first, second);
  assert.match(first.outputSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => validateComputeRequest({ iterations: 0 }), /from 1/);
  assert.throws(() => validateComputeRequest({ iterations: 11 }, { maxIterations: 10 }), /from 1 to 10/);
  assert.throws(() => validateComputeRequest({ iterations: 1, seed: -1 }), /seed/);
  assert.throws(() => validateComputeRequest(null), /object body/);
});

test('worker health, configured labels, bounded execution, and actual timing endpoints', async t => {
  const worker = createWorkerServer({ nodeId: 'test-edge', role: 'edge', port: 8000,
    capacityMips: 1234, executionSlots: 1, configuredMemoryMB: 512,
    simulatedNetworkRttMs: 18, maxIterations: 100_000, maxPendingTasks: 4 });
  await new Promise((resolve, reject) => {
    worker.server.once('error', reject);
    worker.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => worker.close());
  const address = worker.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const health = await fetch(`${base}/health`).then(response => response.json());
  assert.deepEqual(health, { healthy: true, nodeId: 'test-edge', role: 'edge' });
  const metrics = await fetch(`${base}/metrics`).then(response => response.json());
  assert.equal(metrics.configuredCapacityMips, 1234);
  assert.equal(metrics.simulatedNetworkRttMs, 18);
  assert.equal(metrics.networkDelayKind, 'simulated-configuration');

  const response = await fetch(`${base}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ taskId: 'worker-task-1', iterations: 20_000, seed: 11 }) });
  assert.equal(response.status, 200);
  const outcome = await response.json();
  assert.equal(outcome.nodeId, 'test-edge');
  assert.equal(outcome.taskId, 'worker-task-1');
  assert.equal(outcome.result.iterations, 20_000);
  assert.match(outcome.result.outputSha256, /^[a-f0-9]{64}$/);
  assert.ok(outcome.measurements.queueingMs >= 0);
  assert.ok(outcome.measurements.executionMs >= 0);

  const invalid = await fetch(`${base}/execute`, { method: 'POST', body: JSON.stringify({ iterations: 0 }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid-task');
  assert.equal((await fetch(`${base}/unknown`)).status, 404);
});
