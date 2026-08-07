const config = require('../config/env');

/**
 * Platform APIs use `Authorization: Bearer <demo-token>`. Per API_CONTRACT.md,
 * a single demo token covering builder/operator/approver is fine for Must Have.
 * NOT applied to the webhook route - that uses X-Relay-Secret instead.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || token !== config.demoToken) {
    return res.status(401).json({ error: { message: 'Missing or invalid platform token', code: 'unauthorized' } });
  }
  next();
}

module.exports = { requireAuth };
