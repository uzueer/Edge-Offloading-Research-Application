import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/api/app.js';
import { createWorkerClient } from '../src/api/workers.js';
import { createDatabasePool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createRepository } from '../src/db/repository.js';

const databaseUrl = process.env.DATABASE_URL;
const runIntegration = process.env.RUN_API_INTEGRATION === '1';

test('Express API monitors workers, schedules, executes, persists prediction and measured outcome', {
  skip: !(databaseUrl && runIntegration) && 'set DATABASE_URL and RUN_API_INTEGRATION=1 with all workers running',
}, async () => {
  const pool = createDatabasePool({ connectionString: databaseUrl });
  const prefix = `api-it-${randomUUID()}`;
  let server;
  let experimentId;
  try {
    await runMigrations(pool);
    const repository = createRepository(pool);
    const app = createApp({ pool, repository, workerClient: createWorkerClient({ timeoutMs: 5000 }) });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}`;

    const health = await fetch(`${base}/health`).then(response => response.json());
    assert.deepEqual(health, { healthy: true, database: 'connected' });
    const nodes = await fetch(`${base}/nodes`).then(response => response.json());
    assert.deepEqual(nodes.nodes.map(node => node.id).sort(), ['cloud-1', 'edge-1', 'edge-2']);
    assert.ok(nodes.nodes.every(node => node.healthy));
    assert.ok(nodes.nodes.every(node => node.configuredNetworkKind === 'simulated-configuration'));

    const submit = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `${prefix}-success`, algorithm: 'latency-aware', workloadMI: 2,
        iterations: 50_000, seed: 42, memoryMB: 16 }) });
    assert.equal(submit.status, 201);
    const completed = await submit.json();
    assert.equal(completed.task.status, 'succeeded');
    assert.equal(completed.decision.selectedNode.id, 'edge-1');
    assert.equal(completed.execution.actualNetworkKind, 'simulated');
    assert.equal(completed.execution.actualNetworkMs, 8);
    assert.equal(completed.execution.result.iterations, 50_000);
    assert.ok(completed.decision.candidates.find(candidate => candidate.nodeId === 'edge-1').estimate.totalPredictedLatencyMs > 0);
    const duplicate = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `${prefix}-success`, algorithm: 'round-robin', workloadMI: 1, iterations: 1 }) });
    assert.equal(duplicate.status, 409);

    const retrieved = await fetch(`${base}/tasks/${prefix}-success`).then(response => response.json());
    assert.equal(retrieved.task.status, 'succeeded');
    assert.equal(retrieved.decision.selectedNodeId, 'edge-1');
    assert.equal(retrieved.task.execution.actualNetworkKind, 'simulated');

    const roundRobin = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `${prefix}-round-robin`, algorithm: 'round-robin', workloadMI: 1,
        iterations: 1000, seed: 3 }) });
    assert.equal(roundRobin.status, 201);
    assert.equal((await roundRobin.json()).task.status, 'succeeded');

    const noEligible = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `${prefix}-ineligible`, algorithm: 'edge-only', workloadMI: 1,
        iterations: 100, memoryMB: 1e9 }) });
    assert.equal(noEligible.status, 503);
    const rejected = await noEligible.json();
    assert.equal(rejected.task.status, 'failed');
    assert.equal(rejected.decision.selectedNode, null);
    const invalid = await fetch(`${base}/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workloadMI: -1, iterations: 1 }) });
    assert.equal(invalid.status, 400);

    const experimentResponse = await fetch(`${base}/experiments`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'API experiment fixture', taskCount: 3, repetitions: 1,
        workloadMIMin: 1, workloadMIMax: 2, iterationsMin: 2000, iterationsMax: 4000,
        arrivalIntervalMs: 2, memoryMB: 16, randomSeed: 55,
        nodeProfiles: { 'edge-2': { networkRttMs: 16, capacityMips: 2400 } } }) });
    assert.equal(experimentResponse.status, 202);
    const startedExperiment = await experimentResponse.json();
    experimentId = startedExperiment.id;
    assert.equal(startedExperiment.configuration.randomSeed, 55);
    let experimentStatus;
    for (let attempt = 0; attempt < 200; attempt++) {
      experimentStatus = await fetch(`${base}/experiments/${experimentId}`).then(response => response.json());
      if (experimentStatus.experiment.runs.every(run => ['succeeded', 'failed'].includes(run.status))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(experimentStatus.experiment.runs.every(run => run.status === 'succeeded'), JSON.stringify(experimentStatus));
    const exported = await fetch(`${base}/experiments/${experimentId}/results`).then(response => response.json());
    const taskResults = exported.results.filter(result => result.metrics.resultType === 'task');
    const aggregateResults = exported.results.filter(result => result.metrics.resultType === 'aggregate');
    assert.equal(taskResults.length, 9);
    assert.equal(aggregateResults.length, 3);
    for (const traceTaskId of ['trace-task-1', 'trace-task-2', 'trace-task-3']) {
      const sameInput = taskResults.filter(result => result.metrics.traceTaskId === traceTaskId)
        .map(result => [result.metrics.workloadMI, result.metrics.iterations, result.metrics.taskSeed]);
      assert.equal(new Set(sameInput.map(input => JSON.stringify(input))).size, 1);
    }
    const csv = await fetch(`${base}/experiments/${experimentId}/export?format=csv`).then(response => response.text());
    assert.match(csv, /"traceTaskId"/);
    const jsonExport = await fetch(`${base}/experiments/${experimentId}/export?format=json`).then(response => response.json());
    assert.equal(jsonExport.experiment.configuration.randomSeed, 55);
    assert.equal((await fetch(`${base}/experiments/${experimentId}/export?format=xml`)).status, 400);
  } finally {
    await new Promise(resolve => server ? server.close(resolve) : resolve());
    await pool.query('DELETE FROM task_executions WHERE task_id = ANY($1::text[])', [[`${prefix}-success`, `${prefix}-round-robin`, `${prefix}-ineligible`]]).catch(() => {});
    await pool.query('DELETE FROM scheduling_decisions WHERE task_id = ANY($1::text[])', [[`${prefix}-success`, `${prefix}-round-robin`, `${prefix}-ineligible`]]).catch(() => {});
    await pool.query('DELETE FROM tasks WHERE id = ANY($1::text[])', [[`${prefix}-success`, `${prefix}-round-robin`, `${prefix}-ineligible`]]).catch(() => {});
    if (experimentId) {
      const taskRows = await pool.query(`SELECT DISTINCT r.task_id FROM experiment_results r
        JOIN experiment_runs er ON er.id = r.run_id WHERE er.experiment_id = $1 AND r.task_id IS NOT NULL`, [experimentId]);
      const experimentTaskIds = taskRows.rows.map(row => row.task_id);
      await pool.query('DELETE FROM experiment_results WHERE run_id IN (SELECT id FROM experiment_runs WHERE experiment_id = $1)', [experimentId]).catch(() => {});
      if (experimentTaskIds.length) {
        await pool.query('DELETE FROM task_executions WHERE task_id = ANY($1::text[])', [experimentTaskIds]).catch(() => {});
        await pool.query('DELETE FROM scheduling_decisions WHERE task_id = ANY($1::text[])', [experimentTaskIds]).catch(() => {});
        await pool.query('DELETE FROM tasks WHERE id = ANY($1::text[])', [experimentTaskIds]).catch(() => {});
      }
      await pool.query('DELETE FROM experiment_runs WHERE experiment_id = $1', [experimentId]).catch(() => {});
      await pool.query('DELETE FROM experiments WHERE id = $1', [experimentId]).catch(() => {});
    }
    await pool.end();
  }
});
