/**
 * delay: does not sleep the worker thread. Returns a `rescheduleAt` timestamp;
 * the executor persists this step as succeeded (delay elapsed=false is tracked
 * via the queue_jobs.run_at column) and the worker moves on to other runs.
 * A restart during a delay is safe: run_at survives in Postgres, so the job
 * simply isn't claimable until its time comes.
 */
async function execute({ params }) {
  const seconds = Number(params.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`delay.seconds must be a non-negative number, got '${params.seconds}'`);
  }
  const rescheduleAt = new Date(Date.now() + seconds * 1000);
  return { output: { waited_seconds: seconds }, rescheduleAt };
}

module.exports = { execute };
