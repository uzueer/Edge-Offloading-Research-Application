import { performance } from 'node:perf_hooks';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function configuredWorkers(env = process.env) {
  const number = (key, fallback) => env[key] === undefined ? fallback : Number(env[key]);
  return [
    { id: 'edge-1', role: 'edge', url: env.WORKER_EDGE_1_URL ?? `http://localhost:${number('EDGE_1_PORT', 8101)}`,
      capacityMips: number('EDGE_1_CAPACITY_MIPS', 1600), executionSlots: number('EDGE_1_EXECUTION_SLOTS', 1), memoryMB: number('EDGE_1_MEMORY_MB', 1024), simulatedNetworkRttMs: number('EDGE_1_NETWORK_RTT_MS', 8) },
    { id: 'edge-2', role: 'edge', url: env.WORKER_EDGE_2_URL ?? `http://localhost:${number('EDGE_2_PORT', 8102)}`,
      capacityMips: number('EDGE_2_CAPACITY_MIPS', 2200), executionSlots: number('EDGE_2_EXECUTION_SLOTS', 2), memoryMB: number('EDGE_2_MEMORY_MB', 2048), simulatedNetworkRttMs: number('EDGE_2_NETWORK_RTT_MS', 14) },
    { id: 'cloud-1', role: 'cloud', url: env.WORKER_CLOUD_1_URL ?? `http://localhost:${number('CLOUD_1_PORT', 8103)}`,
      capacityMips: number('CLOUD_1_CAPACITY_MIPS', 5000), executionSlots: number('CLOUD_1_EXECUTION_SLOTS', 4), memoryMB: number('CLOUD_1_MEMORY_MB', 8192), simulatedNetworkRttMs: number('CLOUD_1_NETWORK_RTT_MS', 40) },
  ];
}

export function createWorkerClient({ workers = configuredWorkers(), timeoutMs = 5000, simulateNetwork = true } = {}) {
  const byId = new Map(workers.map(worker => [worker.id, worker]));

  async function fetchJson(url, init = {}) {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  }

  async function inspect(worker) {
    const startedAt = performance.now();
    try {
      const [{ response: healthResponse, body: health }, { response: metricsResponse, body: metrics }] = await Promise.all([
        fetchJson(`${worker.url}/health`), fetchJson(`${worker.url}/metrics`),
      ]);
      if (!healthResponse.ok || !metricsResponse.ok || health.nodeId !== worker.id) {
        throw new Error(`worker ${worker.id} health/metrics response was invalid`);
      }
      const measuredRttMs = performance.now() - startedAt;
      return {
        node: {
          id: worker.id,
          role: worker.role,
          healthy: health.healthy === true,
          resources: {
            capacityMips: Number(metrics.configuredCapacityMips),
            executionSlots: Number(metrics.configuredExecutionSlots),
            availableMemoryMB: Number(metrics.configuredMemoryMB),
          },
          workAheadMI: Number(metrics.workAheadMI),
          network: { rttMs: Number(metrics.simulatedNetworkRttMs), measuredAtMs: Date.now() },
          networkDelayKind: metrics.networkDelayKind,
          simulatedNetworkRttMs: Number(metrics.simulatedNetworkRttMs),
          measuredProbeRttMs: measuredRttMs,
          status: metrics,
          error: null,
        },
      };
    } catch (error) {
      return {
        node: {
          id: worker.id, role: worker.role, healthy: false,
          resources: { capacityMips: worker.capacityMips, executionSlots: worker.executionSlots, availableMemoryMB: worker.memoryMB },
          workAheadMI: 0,
          network: null,
          networkDelayKind: 'simulated-configuration',
          simulatedNetworkRttMs: worker.simulatedNetworkRttMs,
          measuredProbeRttMs: null,
          status: null,
          error: error.message,
        },
      };
    }
  }

  return {
    workers,
    getWorker(nodeId) { return byId.get(nodeId) ?? null; },
    async inspectAll() { return Promise.all(workers.map(inspect)); },
    async execute(nodeId, task) {
      const worker = byId.get(nodeId);
      if (!worker) throw new RangeError(`unknown worker ${nodeId}`);
      const simulatedRttMs = task.simulatedNetworkRttMs ?? worker.simulatedNetworkRttMs;
      if (!Number.isFinite(simulatedRttMs) || simulatedRttMs < 0) throw new RangeError('simulated RTT must be finite and non-negative');
      const oneWayDelayMs = simulateNetwork ? simulatedRttMs / 2 : 0;
      if (oneWayDelayMs > 0) await sleep(oneWayDelayMs);
      const { response, body } = await fetchJson(`${worker.url}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ taskId: task.taskId, iterations: task.iterations, seed: task.seed, workloadMI: task.workloadMI }),
      });
      if (oneWayDelayMs > 0) await sleep(oneWayDelayMs);
      if (!response.ok) {
        const error = new Error(body.message ?? body.error ?? `worker returned HTTP ${response.status}`);
        error.statusCode = response.status;
        error.workerBody = body;
        error.network = { delayMs: simulateNetwork ? simulatedRttMs : null, kind: simulateNetwork ? 'simulated' : null };
        throw error;
      }
      return {
        ...body,
        network: { delayMs: simulateNetwork ? simulatedRttMs : null, kind: simulateNetwork ? 'simulated' : null },
      };
    },
  };
}

export { configuredWorkers };
