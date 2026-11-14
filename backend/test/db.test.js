import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDatabasePool, withTransaction } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrate.js';
import { createRepository } from '../src/db/repository.js';

const databaseUrl = process.env.DATABASE_URL;

test('repository validates inputs before issuing SQL', async () => {
  let queries = 0;
  const pool = {
    async query() { queries++; throw new Error('query should not be reached'); },
    async connect() { throw new Error('connect should not be reached'); },
  };
  const repo = createRepository(pool);
  await assert.rejects(repo.upsertNode({ id: 'n', role: 'edge', healthy: true,
    resources: { capacityMips: 0, executionSlots: 1, availableMemoryMB: 1 } }), /greater than zero/);
  await assert.rejects(repo.recordNodeMeasurement({ nodeId: 'n', type: 'network_rtt', value: 5,
    unit: 'seconds', source: 'test', observedAt: new Date() }), /requires unit ms/);
  await assert.rejects(repo.createTask({ id: 't', workloadMI: -1 }), /non-negative/);
  await assert.rejects(repo.saveSchedulingDecision({ taskId: 't', algorithm: 'latency-aware',
    decision: 'scheduled', selectedNodeId: 'n', candidates: [] }), /eligible/);
  assert.equal(queries, 0);
});

test('PostgreSQL migrations, constraints, transactions, round-trip persistence, and restart retrieval', {
  skip: !databaseUrl && 'set DATABASE_URL to run PostgreSQL integration tests',
}, async () => {
  let pool = createDatabasePool({ connectionString: databaseUrl });
  const prefix = `it-${randomUUID()}`;
  const nodeIds = [`${prefix}-edge1`, `${prefix}-edge2`, `${prefix}-cloud`];
  const taskId = `${prefix}-task`;
  const experimentId = `${prefix}-experiment`;
  let runId;
  let poolClosed = false;
  let schemaReady = false;

  try {
    const applied = await runMigrations(pool);
    schemaReady = true;
    assert.ok(Array.isArray(applied));
    assert.deepEqual(await runMigrations(pool), [], 'migrations are idempotent');
    const repo = createRepository(pool);

    const nodes = [
      { id: nodeIds[0], role: 'edge', healthy: true, resources: { capacityMips: 1000, executionSlots: 1, availableMemoryMB: 2048 } },
      { id: nodeIds[1], role: 'edge', healthy: true, resources: { capacityMips: 1500, executionSlots: 2, availableMemoryMB: 3072 } },
      { id: nodeIds[2], role: 'cloud', healthy: true, resources: { capacityMips: 4000, executionSlots: 4, availableMemoryMB: 8192 } },
    ];
    for (const node of nodes) assert.equal((await repo.upsertNode(node)).id, node.id);
    assert.equal((await repo.getNode(nodeIds[1])).resources.capacityMips, 1500);

    await assert.rejects(pool.query(`INSERT INTO nodes(id, role, capacity_mips, execution_slots, available_memory_mb, healthy)
      VALUES ($1, 'bad-role', 1, 1, 1, true)`, [`${prefix}-invalid`]), /check constraint/i);

    await repo.recordNodeMeasurement({ nodeId: nodeIds[0], type: 'network_rtt', value: 24,
      unit: 'ms', source: 'integration-fixture', observedAt: new Date() });
    assert.equal((await repo.getRecentMeasurements(nodeIds[0]))[0].value, 24);

    await repo.createTask({ id: taskId, workloadMI: 20, memoryMB: 128, workAheadMI: 10, payload: { input: 7 } });
    await assert.rejects(withTransaction(pool, async client => {
      await client.query(`INSERT INTO nodes(id, role, capacity_mips, execution_slots, available_memory_mb, healthy)
        VALUES ($1, 'edge', 1, 1, 1, true)`, [`${prefix}-rollback`]);
      throw new Error('force rollback');
    }), /force rollback/);
    assert.equal(await repo.getNode(`${prefix}-rollback`), null);

    await repo.saveSchedulingDecision({ taskId, algorithm: 'latency-aware', selectedNodeId: nodeIds[2], decision: 'scheduled', candidates: [
      { nodeId: nodeIds[0], eligible: true, reasons: [], estimate: { networkDelayMs: 12, queueingDelayMs: 10, executionTimeMs: 20, totalPredictedLatencyMs: 42 } },
      { nodeId: nodeIds[1], eligible: false, reasons: ['unhealthy'], estimate: null },
      { nodeId: nodeIds[2], eligible: true, reasons: [], estimate: { networkDelayMs: 2, queueingDelayMs: 1, executionTimeMs: 5, totalPredictedLatencyMs: 8 } },
    ] });
    const savedDecision = await repo.getLatestDecision(taskId);
    assert.equal(savedDecision.candidates.find(candidate => candidate.nodeId === nodeIds[2]).estimate.totalPredictedLatencyMs, 8);

    await repo.createExperiment({ id: experimentId, name: 'integration persistence check',
      configuration: { trace: 'fixture', algorithms: ['round-robin'] }, randomSeed: 12, repetitions: 1 });
    const run = await repo.createExperimentRun({ experimentId, repetition: 0, randomSeed: 12 });
    runId = Number(run.id);
    await repo.saveExperimentResult({ runId, algorithm: 'latency-aware', taskId, nodeId: nodeIds[2],
      metrics: { schedulingOverheadMs: 0.1 }, predictedLatencyMs: 8, actualResponseMs: 9 });

    await repo.recordTaskExecution({ taskId, nodeId: nodeIds[2], status: 'succeeded',
      actualNetworkMs: 3, actualQueueingMs: 2, actualExecutionMs: 6, actualResponseMs: 11,
      result: { digest: 'fixture-digest' }, finishedAt: new Date() });
    assert.equal((await repo.getTask(taskId)).execution.actualResponseMs, 11);
    assert.equal((await repo.getTask(taskId)).execution.result.digest, 'fixture-digest');

    await pool.end();
    poolClosed = true;
    pool = createDatabasePool({ connectionString: databaseUrl });
    poolClosed = false;
    const reopenedRepo = createRepository(pool);
    assert.equal((await reopenedRepo.getTask(taskId)).execution.actualResponseMs, 11);
    assert.equal((await reopenedRepo.getLatestDecision(taskId)).selectedNodeId, nodeIds[2]);
    const savedResult = await pool.query('SELECT predicted_latency_ms, actual_response_ms FROM experiment_results WHERE run_id = $1', [runId]);
    assert.equal(Number(savedResult.rows[0].predicted_latency_ms), 8);
    assert.equal(Number(savedResult.rows[0].actual_response_ms), 9);
  } finally {
    if (poolClosed) pool = createDatabasePool({ connectionString: databaseUrl });
    if (schemaReady) {
      await pool.query('DELETE FROM experiment_results WHERE run_id = $1', [runId]);
      await pool.query('DELETE FROM experiment_runs WHERE experiment_id = $1', [experimentId]);
      await pool.query('DELETE FROM experiments WHERE id = $1', [experimentId]);
      await pool.query('DELETE FROM task_executions WHERE task_id = $1', [taskId]);
      await pool.query('DELETE FROM scheduling_decisions WHERE task_id = $1', [taskId]);
      await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
      await pool.query('DELETE FROM node_measurements WHERE node_id = ANY($1::text[])', [nodeIds]);
      await pool.query('DELETE FROM nodes WHERE id = ANY($1::text[])', [nodeIds]);
    }
    await pool.end();
  }
});
