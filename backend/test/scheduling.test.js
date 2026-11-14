import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateTotalPredictedLatencyMs,
  checkNodeEligibility,
  estimateExecutionTimeMs,
  estimateNetworkDelayMs,
  estimateQueueingDelayMs,
} from '../src/latency-model.js';
import { createEdgeOnlyScheduler, createLatencyAwareScheduler, createRoundRobinScheduler } from '../src/schedulers.js';

const nowMs = 1_000_000;
const task = (overrides = {}) => ({ id: 'task-1', workloadMI: 10, memoryMB: 100, queue: { workAheadMI: 0 }, ...overrides });
const node = (id, overrides = {}) => ({
  id,
  role: id.startsWith('edge') ? 'edge' : 'cloud',
  healthy: true,
  resources: { capacityMips: 1000, executionSlots: 1, availableMemoryMB: 1024 },
  network: { rttMs: 20, measuredAtMs: nowMs },
  ...overrides,
});

test('network RTT remains in milliseconds for the request/result transaction and rejects missing, stale, and future observations', () => {
  assert.equal(estimateNetworkDelayMs({ rttMs: 24, measuredAtMs: 900 }, { nowMs: 1000, maxAgeMs: 100 }), 24);
  assert.throws(() => estimateNetworkDelayMs(undefined, { nowMs: 1000, maxAgeMs: 10 }), /required/);
  assert.throws(() => estimateNetworkDelayMs({ rttMs: 2, measuredAtMs: 0 }, { nowMs: 1000, maxAgeMs: 10 }), /stale/);
  assert.throws(() => estimateNetworkDelayMs({ rttMs: 2, measuredAtMs: 1001 }, { nowMs: 1000, maxAgeMs: 10 }), /future/);
});

test('execution estimate respects workload and node processing capacity in MI, MIPS, and ms', () => {
  assert.equal(estimateExecutionTimeMs(task({ workloadMI: 10 }), node('n1')), 10);
  assert.equal(estimateExecutionTimeMs(task({ workloadMI: 10 }), node('n2', { resources: { capacityMips: 2000, executionSlots: 1, availableMemoryMB: 1024 } })), 5);
  assert.equal(estimateExecutionTimeMs(task({ workloadMI: 1e9 }), node('big')), 1e9);
});

test('queue approximation handles zero, one, and multiple tasks of work and parallel slots', () => {
  const n = node('n', { resources: { capacityMips: 1000, executionSlots: 2, availableMemoryMB: 1000 } });
  assert.equal(estimateQueueingDelayMs({ workAheadMI: 0 }, n), 0);
  assert.equal(estimateQueueingDelayMs({ workAheadMI: 10 }, n), 5);
  assert.equal(estimateQueueingDelayMs({ workAheadMI: 30 }, n), 15);
  assert.equal(estimateQueueingDelayMs({ workAheadMI: 10 }, node('single')), 10);
});

test('total latency is the sum of three millisecond components exactly once', () => {
  assert.equal(calculateTotalPredictedLatencyMs({ networkDelayMs: 3, queueingDelayMs: 5, executionTimeMs: 12 }), 20);
  assert.throws(() => calculateTotalPredictedLatencyMs({ networkDelayMs: -1, queueingDelayMs: 0, executionTimeMs: 0 }), /non-negative/);
  assert.throws(() => calculateTotalPredictedLatencyMs({ networkDelayMs: 1e308, queueingDelayMs: 1e308, executionTimeMs: 0 }), /not finite/);
});

test('eligibility excludes unhealthy and resource-ineligible nodes', () => {
  assert.deepEqual(checkNodeEligibility(task(), node('down', { healthy: false })), { eligible: false, reasons: ['unhealthy'] });
  const lowMemory = node('small', { resources: { capacityMips: 1000, executionSlots: 1, availableMemoryMB: 8 } });
  assert.deepEqual(checkNodeEligibility(task(), lowMemory), { eligible: false, reasons: ['insufficient-memory'] });
  const slow = node('slow', { resources: { capacityMips: 20, executionSlots: 1, availableMemoryMB: 1000 } });
  assert.equal(checkNodeEligibility(task({ minCapacityMips: 50 }), slow).eligible, false);
  assert.throws(() => estimateExecutionTimeMs(task({ workloadMI: -1 }), node('n')), /workloadMI/);
  assert.throws(() => estimateExecutionTimeMs(task(), node('n', { resources: { capacityMips: 0, executionSlots: 1, availableMemoryMB: 1 } })), /greater than zero/);
  assert.throws(() => estimateExecutionTimeMs(task(), node('n', { resources: { capacityMips: Infinity, executionSlots: 1, availableMemoryMB: 1 } })), /finite/);
});

test('latency-aware hand-check: selects 15 ms node over 20 ms and 35 ms; unhealthy node is filtered first', () => {
  const scheduler = createLatencyAwareScheduler({ maxMeasurementAgeMs: 1000 });
  const withEstimate = (id, total) => node(id, {
    resources: { capacityMips: 1000, executionSlots: 1, availableMemoryMB: 1000 },
    network: { rttMs: total, measuredAtMs: nowMs },
  });
  const input = { task: task({ workloadMI: 0 }), nodes: [withEstimate('first', 20), withEstimate('second', 35), withEstimate('third', 15)], nowMs };
  const decision = scheduler.schedule(input);
  assert.equal(decision.selectedNode.id, 'third');
  assert.deepEqual(decision.candidates.map(c => c.estimate.totalPredictedLatencyMs), [20, 35, 15]);
  input.nodes[2] = withEstimate('third', 15);
  input.nodes[2].healthy = false;
  assert.equal(scheduler.schedule(input).selectedNode.id, 'first');
});

test('latency-aware skips absent or stale network measurements and reports component breakdown', () => {
  const scheduler = createLatencyAwareScheduler({ maxMeasurementAgeMs: 50 });
  const fresh = node('fresh', { network: { rttMs: 10, measuredAtMs: nowMs } });
  const stale = node('stale', { network: { rttMs: 0, measuredAtMs: nowMs - 51 } });
  const missing = node('missing', { network: undefined });
  const d = scheduler.schedule({ task: task(), nodes: [stale, missing, fresh], nowMs });
  assert.equal(d.selectedNode.id, 'fresh');
  assert.equal(d.candidates[0].eligible, false);
  assert.match(d.candidates[0].reasons[0], /stale/);
  assert.match(d.candidates[1].reasons[0], /required/);
  assert.equal(d.selectedEstimate.networkDelayMs, 10);
  assert.equal(d.selectedEstimate.executionTimeMs, 10);
  assert.equal(d.selectedEstimate.totalPredictedLatencyMs, 20);
});

test('latency-aware tie breaks by node id and reports no eligible node', () => {
  const scheduler = createLatencyAwareScheduler({ maxMeasurementAgeMs: 10 });
  const a = node('a', { network: { rttMs: 0, measuredAtMs: nowMs } });
  const z = node('z', { network: { rttMs: 0, measuredAtMs: nowMs } });
  assert.equal(scheduler.schedule({ task: task({ workloadMI: 0 }), nodes: [z, a], nowMs }).selectedNode.id, 'a');
  const none = scheduler.schedule({ task: task(), nodes: [node('down', { healthy: false })], nowMs });
  assert.equal(none.selectedNode, null);
  assert.equal(none.decision, 'no-eligible-node');
  assert.throws(() => createLatencyAwareScheduler({ maxMeasurementAgeMs: -1 }), /non-negative/);
});

test('Round Robin rotates deterministically across eligible nodes and skips unavailable nodes', () => {
  const scheduler = createRoundRobinScheduler();
  const a = node('edge-1'), b = node('edge-2'), c = node('cloud-1');
  const nodes = [a, b, c];
  assert.equal(scheduler.schedule({ task: task(), nodes }).selectedNode.id, 'edge-1');
  assert.equal(scheduler.schedule({ task: task(), nodes }).selectedNode.id, 'edge-2');
  b.healthy = false;
  assert.equal(scheduler.schedule({ task: task(), nodes }).selectedNode.id, 'cloud-1');
  assert.equal(scheduler.schedule({ task: task(), nodes }).selectedNode.id, 'edge-1');
  assert.equal(scheduler.schedule({ task: task(), nodes: [] }).selectedNode, null);
});

test('Edge-only never selects cloud and reports unavailable edge cases', () => {
  const scheduler = createEdgeOnlyScheduler();
  const cloud = node('cloud-1', { role: 'cloud' });
  assert.equal(scheduler.schedule({ task: task(), nodes: [cloud] }).selectedNode, null);
  const decision = scheduler.schedule({ task: task(), nodes: [
    node('edge-1', { healthy: false }), node('edge-2'), cloud,
  ] });
  assert.equal(decision.selectedNode.id, 'edge-2');
  assert.equal(decision.candidates.find(c => c.nodeId === 'cloud-1').eligible, false);
  assert.equal(scheduler.schedule({ task: task(), nodes: [node('edge-1', { healthy: false }), cloud] }).selectedNode, null);
});
