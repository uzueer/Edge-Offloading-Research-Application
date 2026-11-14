import { configFromEnvironment, createWorkerServer } from '../src/workers/server.js';

const config = configFromEnvironment();
const worker = createWorkerServer(config);
worker.server.listen(config.port, '0.0.0.0', () => {
  process.stdout.write(`${config.nodeId} listening on ${config.port}; capacityMips=${config.capacityMips} (configured), simulatedNetworkRttMs=${config.simulatedNetworkRttMs}\n`);
});

async function shutdown() {
  await worker.close();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
