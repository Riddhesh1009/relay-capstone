const express = require('express');
const pool = require('../db/pool');
const { id } = require('../lib/ids');
const { validateDefinition } = require('../lib/catalogValidator');
const { enqueueRun } = require('../services/runService');

const router = express.Router();

// GET /workflows - list with at least id and status
router.get('/', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, name, description, status, created_at, updated_at FROM workflows ORDER BY created_at DESC`
  );
  res.json({ workflows: rows });
});

// GET /workflows/:id - full definition
router.get('/:id', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM workflows WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: { message: 'Workflow not found', code: 'not_found' } });
  }
  res.json(rows[0]);
});

// POST /workflows - accepts a definition in the seed shape, creates a Draft
router.post('/', async (req, res) => {
  const def = req.body;
  if (!def || !def.id) {
    return res.status(400).json({ error: { message: "Definition must include 'id'", code: 'invalid_definition' } });
  }

  // Structural validation happens here too (not just at publish) so obviously
  // broken definitions are rejected early - but publish is the hard gate.
  const errors = validateDefinition(def);
  // At draft time we allow incomplete definitions (still being built) but not
  // garbage: reject only if it's not even parseable as workflow shape.
  if (!Array.isArray(def.nodes)) {
    return res.status(400).json({
      error: { message: "Definition must include a 'nodes' array", code: 'invalid_definition' },
    });
  }

  const secret = def.trigger?.type === 'webhook' ? def.trigger.secret : null;

  try {
    await pool.query(
      `INSERT INTO workflows (id, name, description, status, definition, webhook_secret)
       VALUES ($1,$2,$3,'draft',$4,$5)`,
      [def.id, def.name || def.id, def.description || null, JSON.stringify(def), secret]
    );
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: { message: `Workflow '${def.id}' already exists`, code: 'conflict' } });
    }
    throw err;
  }

  res.status(201).json({ id: def.id, status: 'draft', validation_warnings: errors });
});

// POST /workflows/:id/publish - validates against catalog, rejects with 4xx
router.post('/:id/publish', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM workflows WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: { message: 'Workflow not found', code: 'not_found' } });
  }
  const workflow = rows[0];
  const errors = validateDefinition(workflow.definition);
  if (errors.length > 0) {
    return res.status(422).json({
      error: { message: 'Definition failed publish validation', code: 'invalid_definition', details: errors },
    });
  }

  await pool.query(`UPDATE workflows SET status='published', updated_at=now() WHERE id = $1`, [workflow.id]);
  res.json({ id: workflow.id, status: 'published' });
});

// POST /workflows/:id/trigger - manual trigger, body { "input": {...} }
router.post('/:id/trigger', async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM workflows WHERE id = $1`, [req.params.id]);
  if (rows.length === 0) {
    return res.status(404).json({ error: { message: 'Workflow not found', code: 'not_found' } });
  }
  const workflow = rows[0];
  if (workflow.status !== 'published') {
    return res.status(409).json({
      error: { message: `Workflow '${workflow.id}' is not published`, code: 'not_published' },
    });
  }

  const runId = await enqueueRun({
    workflow,
    triggerType: 'manual',
    input: req.body?.input || {},
  });

  res.status(202).json({ run_id: runId, id: runId });
});

module.exports = router;
