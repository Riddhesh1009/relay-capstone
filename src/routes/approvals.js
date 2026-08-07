const express = require('express');
const pool = require('../db/pool');

const router = express.Router();

// GET /approvals?status=pending
router.get('/', async (req, res) => {
  const status = req.query.status;
  const params = [];
  let where = '';
  if (status) {
    params.push(status);
    where = `WHERE a.status = $1`;
  }
  const { rows } = await pool.query(
    `SELECT a.id, a.run_id, a.node_id, a.message, a.status, a.decided_by, a.decided_at, a.created_at,
            r.workflow_id
     FROM approvals a JOIN runs r ON r.id = a.run_id
     ${where}
     ORDER BY a.created_at ASC`,
    params
  );
  res.json(rows);
});

async function decide(req, res, decision) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT * FROM approvals WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { message: 'Approval not found', code: 'not_found' } });
    }
    const approval = rows[0];
    if (approval.status !== 'pending') {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: { message: `Approval already ${approval.status}`, code: 'already_decided' },
      });
    }

    const decidedBy = req.body?.decided_by || 'demo-approver';

    await client.query(
      `UPDATE approvals SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
      [approval.id, decision, decidedBy]
    );

    if (decision === 'approved') {
      // Resume the run: advance past the approval node and re-enqueue.
      const { rows: runRows } = await client.query(`SELECT * FROM runs WHERE id = $1 FOR UPDATE`, [approval.run_id]);
      const run = runRows[0];
      const node = run.definition_snapshot.nodes.find((n) => n.id === approval.node_id);
      const nextNodeId = node?.next ?? null;

      await client.query(
        `UPDATE steps SET status='succeeded' WHERE id = $1`,
        [approval.step_id]
      );

      if (nextNodeId === null) {
        await client.query(
          `UPDATE runs SET status='succeeded', current_node_id=NULL, finished_at=now() WHERE id = $1`,
          [run.id]
        );
      } else {
        await client.query(`UPDATE runs SET status='running', current_node_id=$2 WHERE id = $1`, [
          run.id,
          nextNodeId,
        ]);
        await client.query(
          `INSERT INTO queue_jobs (run_id, status, run_at) VALUES ($1, 'pending', now())`,
          [run.id]
        );
      }
    } else {
      // Rejected: run ends cancelled - same terminal state as /runs/:id/cancel, two doors.
      await client.query(
        `UPDATE steps SET status='failed', error=$2 WHERE id = $1`,
        [approval.step_id, JSON.stringify({ message: 'approval rejected' })]
      );
      await client.query(
        `UPDATE runs SET status='cancelled', finished_at=now(),
                error = jsonb_build_object('message','approval rejected','code','approval_rejected')
         WHERE id = $1`,
        [approval.run_id]
      );
    }

    await client.query('COMMIT');
    res.json({ id: approval.id, status: decision });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

router.post('/:id/approve', (req, res) => decide(req, res, 'approved'));
router.post('/:id/reject', (req, res) => decide(req, res, 'rejected'));

module.exports = router;
