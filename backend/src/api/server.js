import { createDatabasePool } from '../db/pool.js';
import { runMigrations } from '../db/migrate.js';
import { createRepository } from '../db/repository.js';
import { createApp } from './app.js';
import { createWorkerClient } from './workers.js';

const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RangeError('API_PORT must be an integer from 1 to 65535');
const pool = createDatabasePool();

try {
  await runMigrations(pool);
  const app = createApp({
    pool,
    repository: createRepository(pool),
    workerClient: createWorkerClient({ timeoutMs: Number(process.env.WORKER_TIMEOUT_MS ?? 10_000),
      simulateNetwork: process.env.SIMULATE_NETWORK !== 'false' }),
    maxMeasurementAgeMs: Number(process.env.MAX_MEASUREMENT_AGE_MS ?? 30_000),
    maxIterations: Number(process.env.MAX_TASK_ITERATIONS ?? 10_000_000),
  });
  const server = app.listen(port, '0.0.0.0', () => process.stdout.write(`Edge offloading API listening on ${port}\n`));
  const shutdown = async () => {
    server.close(async () => { await pool.end(); process.exit(0); });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
} catch (error) {
  await pool.end();
  process.stderr.write(`API startup failed: ${error.message}\n`);
  process.exitCode = 1;
}
