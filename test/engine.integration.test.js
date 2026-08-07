const { test } = require('node:test');
const assert = require('node:assert');
const { v4: uuidv4 } = require('uuid');
const pool = require('../src/db/pool');
const { processStep } = require('../src/engine/executor');
const { FakeAiProvider } = require('../src/adapters/aiProvider');

async function makeRun(definition, input = {}) {
  const runId = `run_test_${uuidv4().slice(0, 8)}`;
  const workflowId = `wf_test_${uuidv4().slice(0, 8)}`;
  await pool.query(
    `INSERT INTO workflows (id, name, status, definition) VALUES ($1,$2,'published',$3)`,
    [workflowId, 'test', JSON.stringify(definition)]
  );
  await pool.query(
    `INSERT INTO runs (id, workflow_id, definition_snapshot, status, trigger_type, input)
     VALUES ($1,$2,$3,'running',$4,$5)`,
    [runId, workflowId, JSON.stringify(definition), 'manual', JSON.stringify(input)]
  );
  const { rows } = await pool.query(`SELECT * FROM runs WHERE id = $1`, [runId]);
  return rows[0];
}

test('idempotency key is stable and does not include the attempt number', async () => {
  const definition = {
    id: 'wf_x',
    entry: 'n1',
    limits: { max_steps: 10 },
    nodes: [
      {
        id: 'n1',
        type: 'notify',
        params: { channel: 'chat', to: '#x', message: 'hi' },
        next: null,
      },
    ],
  };
  const run = await makeRun(definition);
  // We expect this to fail (no mock world running in this unit-test context)
  // and retry MAX_ATTEMPTS times - across all those attempts the idempotency
  // key on the persisted step must remain exactly `${run_id}:${node_id}`.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await processStep(client, run, new FakeAiProvider([]));
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK').catch(() => {});
  } finally {
    client.release();
  }

  const { rows } = await pool.query(`SELECT idempotency_key, attempt FROM steps WHERE run_id = $1`, [run.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].idempotency_key, `${run.id}:n1`);
  assert.ok(rows[0].attempt >= 1, 'expected at least one attempt to have been recorded');
});

test('step cap stops a run before executing past limits.max_steps', async () => {
  const definition = {
    id: 'wf_loop',
    entry: 'a',
    limits: { max_steps: 2 },
    nodes: [
      { id: 'a', type: 'condition', params: { left: '1', op: 'equals', right: '1' }, on_true: 'a', on_false: 'a' },
    ],
  };
  const run = await makeRun(definition);

  const client = await pool.connect();
  try {
    // Drive the loop until the run is terminal or we've clearly run away (safety valve for the test itself)
    for (let i = 0; i < 10; i++) {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT * FROM runs WHERE id = $1`, [run.id]);
      const current = rows[0];
      if (['succeeded', 'failed', 'cancelled'].includes(current.status)) {
        await client.query('COMMIT');
        break;
      }
      await processStep(client, current, new FakeAiProvider([]));
      await client.query('COMMIT');
    }
  } finally {
    client.release();
  }

  const { rows: finalRun } = await pool.query(`SELECT * FROM runs WHERE id = $1`, [run.id]);
  assert.equal(finalRun[0].status, 'failed');
  assert.match(finalRun[0].error.code, /step_cap_exceeded/);
  assert.ok(finalRun[0].steps_executed <= definition.limits.max_steps + 1); // cap checked before execution
});

test('sensitive node without an approved approval is refused by the engine', async () => {
  const definition = {
    id: 'wf_sensitive',
    entry: 'refund',
    limits: { max_steps: 10 },
    nodes: [{ id: 'refund', type: 'order_action', params: { action: 'refund', order_id: 'ord_1' }, next: null }],
  };
  const run = await makeRun(definition);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await processStep(client, run, new FakeAiProvider([]));
    await client.query('COMMIT');
  } finally {
    client.release();
  }

  const { rows } = await pool.query(`SELECT * FROM runs WHERE id = $1`, [run.id]);
  assert.equal(rows[0].status, 'failed');
  assert.equal(rows[0].error.code, 'approval_required');

  // No step should have even attempted to call the mock world for this node.
  const { rows: steps } = await pool.query(`SELECT * FROM steps WHERE run_id = $1`, [run.id]);
  assert.equal(steps.length, 0);
});
