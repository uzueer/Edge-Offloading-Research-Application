import { checkNodeEligibility, predictNodeLatency } from './latency-model.js';

function validateInput({ task, nodes }) {
  if (!task || !Array.isArray(nodes)) throw new TypeError('schedule input requires task and nodes[]');
  const ids = new Set();
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.id) throw new TypeError('every node requires a non-empty id');
    if (ids.has(node.id)) throw new RangeError(`duplicate node id: ${node.id}`);
    ids.add(node.id);
  }
}

function eligibilityFor(task, nodes) {
  return nodes.map(node => ({ node, ...checkNodeEligibility(task, node) }));
}

function result(algorithm, selectedNode, candidates, details = {}) {
  return {
    algorithm,
    selectedNode: selectedNode ?? null,
    decision: selectedNode ? 'scheduled' : 'no-eligible-node',
    candidates,
    ...details,
  };
}

/** Round Robin keeps a cursor over the supplied node order and skips ineligible nodes. */
export function createRoundRobinScheduler() {
  let cursor = 0;
  return {
    schedule(input) {
      validateInput(input);
      const { task, nodes } = input;
      const assessed = eligibilityFor(task, nodes);
      const candidates = assessed.map(({ node, eligible, reasons }) => ({ nodeId: node.id, eligible, reasons }));
      if (!nodes.length) return result('round-robin', null, candidates);
      for (let step = 0; step < nodes.length; step++) {
        const index = (cursor + step) % nodes.length;
        if (assessed[index].eligible) {
          cursor = (index + 1) % nodes.length;
          return result('round-robin', nodes[index], candidates);
        }
      }
      return result('round-robin', null, candidates);
    },
  };
}

/** Restrict candidate pool to edge roles, then apply common health/resource checks. */
export function createEdgeOnlyScheduler() {
  return {
    schedule(input) {
      validateInput(input);
      const { task, nodes } = input;
      const candidates = nodes.map(node => {
        const roleAllowed = node.role === 'edge';
        const check = roleAllowed
          ? checkNodeEligibility(task, node)
          : { eligible: false, reasons: ['not-edge-node'] };
        return { nodeId: node.id, eligible: check.eligible, reasons: check.reasons };
      });
      const selected = nodes.find(node => candidates.find(c => c.nodeId === node.id)?.eligible);
      return result('edge-only', selected, candidates);
    },
  };
}

/** Choose minimum predicted total latency; ties resolve by ascending node id. */
export function createLatencyAwareScheduler({ maxMeasurementAgeMs }) {
  if (typeof maxMeasurementAgeMs !== 'number' || !Number.isFinite(maxMeasurementAgeMs) || maxMeasurementAgeMs < 0) {
    throw new RangeError('maxMeasurementAgeMs must be finite and non-negative');
  }
  return {
    schedule(input) {
      validateInput(input);
      const { task, nodes, nowMs } = input;
      const candidates = nodes.map(node => {
        const eligibility = checkNodeEligibility(task, node);
        if (!eligibility.eligible) return { nodeId: node.id, eligible: false, reasons: eligibility.reasons, estimate: null };
        try {
          return {
            nodeId: node.id,
            eligible: true,
            reasons: [],
            estimate: predictNodeLatency(task, node, { nowMs, maxMeasurementAgeMs }),
          };
        } catch (error) {
          if (!(error instanceof RangeError) && !(error instanceof TypeError)) throw error;
          return { nodeId: node.id, eligible: false, reasons: [`invalid-latency-input: ${error.message}`], estimate: null };
        }
      });
      const ranked = candidates
        .filter(candidate => candidate.eligible)
        .slice()
        .sort((a, b) => a.estimate.totalPredictedLatencyMs - b.estimate.totalPredictedLatencyMs || a.nodeId.localeCompare(b.nodeId));
      const selectedNode = ranked.length ? nodes.find(node => node.id === ranked[0].nodeId) : null;
      return result('latency-aware', selectedNode, candidates, {
        selectedEstimate: ranked[0]?.estimate ?? null,
      });
    },
  };
}
