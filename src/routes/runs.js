const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);

// GET /runs/:id - status + steps[] (node_id, status, resolved input/output, timing, tokens)
router.get('/:id', async (req, res) => {
  const { rows: runRows } = await pool.query(`SELECT * FROM runs WHERE id = $1`, [req.params.id]);
  if (runRows.length === 0) {
    return res.status(404).json({ error: { message: 'Run not found', code: 'not_found' } });
  }
  const run = runRows[0];

  const { rows: steps } = await pool.query(
    `SELECT id, node_id, node_type AS type, sequence, status, attempt, resolved_input AS input,
            output, tokens_prompt, tokens_completion, idempotency_key, error, started_at, finished_at, duration_ms
     FROM steps WHERE run_id = $1 ORDER BY sequence ASC`,
    [run.id]
  );

  // Attach approval_id for any 'waiting' step, per API_CONTRACT.md example trace shape.
  const { rows: approvals } = await pool.query(
    `SELECT id, step_id, status FROM approvals WHERE run_id = $1`,
    [run.id]
  );
  const approvalByStepId = new Map(approvals.map((a) => [a.step_id, a]));

  const enrichedSteps = steps.map((s) => {
    const approval = approvalByStepId.get(s.id);
    return {
      node_id: s.node_id,
      type: s.type,
      status: s.status,
      attempt: s.attempt,
      input: s.input,
      output: s.output,
      tokens_prompt: s.tokens_prompt,
      tokens_completion: s.tokens_completion,
      idempotency_key: s.idempotency_key,
      error: s.error,
      started_at: s.started_at,
      finished_at: s.finished_at,
      duration_ms: s.duration_ms,
      ...(approval ? { approval_id: approval.id, approval_status: approval.status } : {}),
    };
  });

  res.json({
    run_id: run.id,
    id: run.id,
    workflow_id: run.workflow_id,
    status: run.status,
    trigger_type: run.trigger_type,
    input: run.input,
    steps_executed: run.steps_executed,
    ai_tokens_used: run.ai_tokens_used,
    error: run.error,
    started_at: run.started_at,
    finished_at: run.finished_at,
    created_at: run.created_at,
    steps: enrichedSteps,
  });
});

// GET /runs - list, optional ?workflow_id= / ?status= filters (console convenience, not fixed contract)
router.get('/', async (req, res) => {
  const clauses = [];
  const params = [];
  if (req.query.workflow_id) {
    params.push(req.query.workflow_id);
    clauses.push(`workflow_id = $${params.length}`);
  }
  if (req.query.status) {
    params.push(req.query.status);
    clauses.push(`status = $${params.length}`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, workflow_id, status, trigger_type, steps_executed, created_at, started_at, finished_at
     FROM runs ${where} ORDER BY created_at DESC LIMIT 100`,
    params
  );
  res.json({ runs: rows });
});

// POST /runs/:id/cancel
router.post('/:id/cancel', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM runs WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: { message: 'Run not found', code: 'not_found' } });
  }
  const run = rows[0];
  if (TERMINAL.has(run.status)) {
    return res.status(409).json({ error: { message: `Run is already ${run.status}`, code: 'already_terminal' } });
  }

  // Cooperative cancellation: flip a flag the worker checks between steps.
  // A queued run with no in-flight step can be cancelled immediately.
  if (run.status === 'queued') {
    await pool.query(`UPDATE runs SET status='cancelled', finished_at=now() WHERE id = $1`, [run.id]);
  } else {
    await pool.query(`UPDATE runs SET cancel_requested = true WHERE id = $1`, [run.id]);
    if (run.status === 'waiting_approval') {
      // No queue job is polling this run right now (approval routes are what
      // re-enqueue it) - close the pending approval and finalize immediately.
      await pool.query(`UPDATE approvals SET status='rejected' WHERE run_id = $1 AND status = 'pending'`, [run.id]);
      await pool.query(
        `UPDATE runs SET status='cancelled', finished_at=now(),
                error = jsonb_build_object('message','cancelled by operator','code','cancelled') WHERE id = $1`,
        [run.id]
      );
    }
  }

  res.json({ id: run.id, status: 'cancelling' });
});

module.exports = router;
