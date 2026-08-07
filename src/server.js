const express = require('express');
const path = require('path');
const config = require('./config/env');
const { requireAuth } = require('./routes/authMiddleware');

const workflowsRouter = require('./routes/workflows');
const runsRouter = require('./routes/runs');
const approvalsRouter = require('./routes/approvals');
const webhooksRouter = require('./routes/webhooks');

const app = express();
app.use(express.json({ limit: '1mb' }));

// Health check - no auth, useful for the smoke test / readiness probes
app.get('/health', (req, res) => res.json({ ok: true }));

// Webhook trigger route: NOT behind platform auth - guarded by X-Relay-Secret instead
app.use('/hooks', webhooksRouter);

// Platform APIs: single demo bearer token
app.use('/workflows', requireAuth, workflowsRouter);
app.use('/runs', requireAuth, runsRouter);
app.use('/approvals', requireAuth, approvalsRouter);

// Minimal console (static HTML/JS hitting the API above)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Central error handler - every rejection returns a clear { error: { message, code } } body
app.use((err, req, res, next) => {
  console.error('[api] unhandled error:', err);
  res.status(500).json({ error: { message: err.message || 'Internal error', code: 'internal_error' } });
});

app.listen(config.port, () => {
  console.log(`[api] Relay listening on :${config.port}`);
});

module.exports = app;
