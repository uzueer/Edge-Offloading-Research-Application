import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { executeDeterministicWork, validateComputeRequest, DEFAULT_MAX_ITERATIONS } from './compute.js';

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function positiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and greater than zero`);
  return value;
}

function nonNegativeNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and non-negative`);
  return value;
}

function sendJson(response, status, body) {
  const data = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  response.end(data);
}

async function readJson(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error(`request body exceeds ${maxBytes} bytes`), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 });
  }
}

/** Creates an independently testable worker HTTP server. Capacity/network values are configured labels, not host measurements. */
export function createWorkerServer(config = {}) {
  const settings = {
    nodeId: config.nodeId ?? 'worker-local',
    role: config.role ?? 'edge',
    port: config.port ?? 8000,
    capacityMips: config.capacityMips ?? 1000,
    executionSlots: config.executionSlots ?? 1,
    configuredMemoryMB: config.configuredMemoryMB ?? 512,
    simulatedNetworkRttMs: config.simulatedNetworkRttMs ?? 0,
    maxIterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    maxPendingTasks: config.maxPendingTasks ?? 32,
    maxBodyBytes: config.maxBodyBytes ?? 16_384,
  };
  if (!settings.nodeId || typeof settings.nodeId !== 'string') throw new TypeError('nodeId must be a non-empty string');
  if (!['edge', 'cloud'].includes(settings.role)) throw new TypeError('role must be edge or cloud');
  positiveInteger(settings.port, 'port');
  positiveNumber(settings.capacityMips, 'capacityMips');
  positiveInteger(settings.executionSlots, 'executionSlots');
  positiveNumber(settings.configuredMemoryMB, 'configuredMemoryMB');
  nonNegativeNumber(settings.simulatedNetworkRttMs, 'simulatedNetworkRttMs');
  positiveInteger(settings.maxIterations, 'maxIterations');
  positiveInteger(settings.maxPendingTasks, 'maxPendingTasks');
  positiveInteger(settings.maxBodyBytes, 'maxBodyBytes');

  const pending = [];
  let activeTasks = 0;
  let activeWorkloadMI = 0;
  let completedTasks = 0;
  let rejectedTasks = 0;
  let failedTasks = 0;
  let shuttingDown = false;
  const startedAt = Date.now();

  function metrics() {
    return {
      nodeId: settings.nodeId,
      role: settings.role,
      health: shuttingDown ? 'shutting-down' : 'healthy',
      configuredCapacityMips: settings.capacityMips,
      configuredExecutionSlots: settings.executionSlots,
      configuredMemoryMB: settings.configuredMemoryMB,
      simulatedNetworkRttMs: settings.simulatedNetworkRttMs,
      networkDelayKind: 'simulated-configuration',
      activeTasks,
      queuedTasks: pending.length,
      workAheadMI: activeWorkloadMI + pending.reduce((total, item) => total + item.work.workloadMI, 0),
      queuedWorkMI: pending.reduce((total, item) => total + item.work.workloadMI, 0),
      availableSlots: Math.max(0, settings.executionSlots - activeTasks),
      completedTasks,
      failedTasks,
      rejectedTasks,
      uptimeSeconds: (Date.now() - startedAt) / 1000,
    };
  }

  function drainQueue() {
    while (!shuttingDown && activeTasks < settings.executionSlots && pending.length > 0) {
      const item = pending.shift();
      activeTasks++;
      activeWorkloadMI += item.work.workloadMI;
      item.startedAt = performance.now();
      void (async () => {
        try {
          const result = await executeDeterministicWork(item.work);
          const finishedAt = performance.now();
          completedTasks++;
          sendJson(item.response, 200, {
            taskId: item.work.taskId,
            nodeId: settings.nodeId,
            result,
            measurements: {
              queueingMs: item.startedAt - item.receivedAt,
              executionMs: finishedAt - item.startedAt,
              workerElapsedMs: finishedAt - item.receivedAt,
            },
            configured: {
              capacityMips: settings.capacityMips,
              executionSlots: settings.executionSlots,
              simulatedNetworkRttMs: settings.simulatedNetworkRttMs,
            },
          });
        } catch (error) {
          failedTasks++;
          sendJson(item.response, 500, { error: 'task-execution-failed', message: error.message, nodeId: settings.nodeId });
        } finally {
          activeTasks--;
          activeWorkloadMI -= item.work.workloadMI;
          drainQueue();
        }
      })();
    }
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://worker.local');
    if (request.method === 'GET' && url.pathname === '/health') {
      return sendJson(response, shuttingDown ? 503 : 200, { healthy: !shuttingDown, nodeId: settings.nodeId, role: settings.role });
    }
    if (request.method === 'GET' && url.pathname === '/metrics') return sendJson(response, 200, metrics());
    if (request.method !== 'POST' || url.pathname !== '/execute') {
      return sendJson(response, 404, { error: 'not-found' });
    }
    if (shuttingDown) return sendJson(response, 503, { error: 'worker-shutting-down' });
    let work;
    try {
      const body = await readJson(request, settings.maxBodyBytes);
      work = validateComputeRequest(body, { maxIterations: settings.maxIterations });
    } catch (error) {
      rejectedTasks++;
      return sendJson(response, error.statusCode ?? 400, { error: 'invalid-task', message: error.message });
    }
    if (pending.length + activeTasks >= settings.maxPendingTasks) {
      rejectedTasks++;
      return sendJson(response, 429, { error: 'worker-capacity-exceeded', nodeId: settings.nodeId });
    }
    pending.push({ work, response, receivedAt: performance.now() });
    drainQueue();
  });

  return {
    server,
    metrics,
    close() {
      shuttingDown = true;
      for (const item of pending.splice(0)) sendJson(item.response, 503, { error: 'worker-shutting-down' });
      return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

export function configFromEnvironment(env = process.env) {
  const numeric = (key, fallback) => env[key] === undefined ? fallback : Number(env[key]);
  return {
    nodeId: env.NODE_ID ?? 'worker-local',
    role: env.NODE_ROLE ?? 'edge',
    port: numeric('PORT', 8000),
    capacityMips: numeric('CAPACITY_MIPS', 1000),
    executionSlots: numeric('EXECUTION_SLOTS', 1),
    configuredMemoryMB: numeric('CONFIGURED_MEMORY_MB', 512),
    simulatedNetworkRttMs: numeric('SIMULATED_NETWORK_RTT_MS', 0),
    maxIterations: numeric('MAX_ITERATIONS', DEFAULT_MAX_ITERATIONS),
    maxPendingTasks: numeric('MAX_PENDING_TASKS', 32),
    maxBodyBytes: numeric('MAX_BODY_BYTES', 16_384),
  };
}
