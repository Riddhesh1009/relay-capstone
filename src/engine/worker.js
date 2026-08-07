const os = require('os');
const pool = require('../db/pool');
const config = require('../config/env');
const { processStep } = require('./executor');
const { getProvider } = require('../adapters/aiProvider');

const WORKER_ID = `${os.hostname()}:${process.pid}`;
const LEASE_SECONDS = 30; // a job claimed longer ago than this, still in_progress, is presumed crashed

const provider = getProvider();
let stopping = false;

/**
 * Claims the next runnable job:
 *  - status='pending' AND run_at <= now(), OR
 *  - status='in_progress' AND locked_at older than the lease -> a crashed
 *    worker's job, reclaimed automatically (no manual intervention needed).
 * FOR UPDATE SKIP LOCKED makes this safe with multiple worker processes.
 */
async function claimJob(client) {
  const { rows } = await client.query(
    `SELECT * FROM queue_jobs
     WHERE (status = 'pending' AND run_at <= now())
        OR (status = 'in_progress' AND locked_at < now() - interval '${LEASE_SECONDS} seconds')
     ORDER BY run_at ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`
  );
  if (rows.length === 0) return null;
  const job = rows[0];
  await client.query(
    `UPDATE queue_jobs SET status='in_progress', locked_by=$2, locked_at=now(), attempts = attempts + 1 WHERE id = $1`,
    [job.id, WORKER_ID]
  );
  return job;
}

async function handleCancellation(client, run) {
  await client.query(`UPDATE approvals SET status='rejected' WHERE run_id = $1 AND status = 'pending'`, [run.id]);
  await client.query(
    `UPDATE runs SET status='cancelled', finished_at=now(),
            error = jsonb_build_object('message','cancelled by operator','code','cancelled') WHERE id = $1`,
    [run.id]
  );
}

async function tick() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const job = await claimJob(client);
    if (!job) {
      await client.query('ROLLBACK');
      return false; // nothing to do
    }

    const { rows: runRows } = await client.query(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [job.run_id]);
    const run = runRows[0];

    if (!run || ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      // stale job for a run that's already terminal - close it out
      await client.query(`UPDATE queue_jobs SET status='done' WHERE id = $1`, [job.id]);
      await client.query('COMMIT');
      return true;
    }

    // Cooperative cancellation: checked between steps, not mid-step.
    if (run.cancel_requested) {
      if (run.status === 'queued') {
        await client.query(`UPDATE runs SET status='cancelled', finished_at=now() WHERE id = $1`, [run.id]);
      } else {
        await handleCancellation(client, run);
      }
      await client.query(`UPDATE queue_jobs SET status='done' WHERE id = $1`, [job.id]);
      await client.query('COMMIT');
      return true;
    }

    if (run.status === 'queued') {
      await client.query(`UPDATE runs SET status='running', started_at = COALESCE(started_at, now()) WHERE id = $1`, [
        run.id,
      ]);
      run.status = 'running';
    }

    const result = await processStep(client, run, provider);

    if (!result.done) {
      await client.query(`UPDATE queue_jobs SET status='pending', run_at=$2, locked_by=NULL WHERE id = $1`, [
        job.id,
        result.rescheduleAt || new Date(),
      ]);
    } else {
      await client.query(`UPDATE queue_jobs SET status='done' WHERE id = $1`, [job.id]);
    }

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[worker] tick error:', err);
    return true; // don't hot-loop on a persistent error
  } finally {
    client.release();
  }
}

async function loop() {
  console.log(`[worker] ${WORKER_ID} starting, polling every ${config.workerPollMs}ms`);
  while (!stopping) {
    const didWork = await tick();
    if (!didWork) {
      await new Promise((r) => setTimeout(r, config.workerPollMs));
    }
  }
  console.log('[worker] stopped');
}

process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});

if (require.main === module) {
  loop();
}

module.exports = { tick, loop, WORKER_ID };
