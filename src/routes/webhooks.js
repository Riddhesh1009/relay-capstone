const express = require('express');
const pool = require('../db/pool');
const { enqueueRun } = require('../services/runService');

const router = express.Router();

// POST /hooks/:workflowId - secret in X-Relay-Secret, no other auth
router.post('/:workflowId', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM workflows WHERE id = $1`, [req.params.workflowId]);
  if (rows.length === 0) {
    return res.status(404).json({ error: { message: 'Workflow not found', code: 'not_found' } });
  }
  const workflow = rows[0];

  const providedSecret = req.headers['x-relay-secret'];
  if (!workflow.webhook_secret || providedSecret !== workflow.webhook_secret) {
    return res.status(401).json({ error: { message: 'Missing or invalid webhook secret', code: 'unauthorized' } });
  }

  if (workflow.status !== 'published') {
    return res.status(409).json({
      error: { message: `Workflow '${workflow.id}' is not published`, code: 'not_published' },
    });
  }

  const runId = await enqueueRun({
    workflow,
    triggerType: 'webhook',
    input: req.body || {},
  });

  res.status(202).json({ run_id: runId, id: runId });
});

module.exports = router;
