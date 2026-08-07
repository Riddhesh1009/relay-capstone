const fs = require('fs');
const path = require('path');
const pool = require('./pool');
const { validateDefinition } = require('../lib/catalogValidator');

const SEED_PATH = path.join(__dirname, '..', '..', 'data', 'seed_workflows.json');

async function run() {
  const raw = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  const workflows = raw.workflows || [];

  for (const def of workflows) {
    const errors = validateDefinition(def);
    if (errors.length) {
      console.error(`[seed] ${def.id} failed validation, skipping:`, errors);
      continue;
    }

    const secret = def.trigger && def.trigger.type === 'webhook' ? def.trigger.secret : null;

    await pool.query(
      `INSERT INTO workflows (id, name, description, status, definition, webhook_secret)
       VALUES ($1, $2, $3, 'published', $4, $5)
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             status = 'published',
             definition = EXCLUDED.definition,
             webhook_secret = EXCLUDED.webhook_secret,
             updated_at = now()`,
      [def.id, def.name, def.description || null, JSON.stringify(def), secret]
    );
    console.log(`[seed] loaded ${def.id} (published)`);
  }

  await pool.end();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
