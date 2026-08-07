const pool = require('../db/pool');
const { id } = require('../lib/ids');

/**
 * Creates a run with a frozen definition snapshot (DATA_MODEL.md: runs execute
 * their snapshot, not the live workflow) and enqueues its first queue_jobs row.
 * Returns the new run id.
 */
async function enqueueRun({ workflow, triggerType, input }) {
  const runId = id('run');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO runs (id, workflow_id, definition_snapshot, status, trigger_type, input)
       VALUES ($1,$2,$3,'queued',$4,$5)`,
      [runId, workflow.id, JSON.stringify(workflow.definition), triggerType, JSON.stringify(input)]
    );
    await client.query(
      `INSERT INTO queue_jobs (run_id, status, run_at) VALUES ($1, 'pending', now())`,
      [runId]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return runId;
}

module.exports = { enqueueRun };
