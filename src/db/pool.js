const { Pool } = require('pg');
const config = require('../config/env');

const pool = new Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  // A backend/idle client error should not crash the process; log and move on.
  console.error('[pg pool] unexpected error on idle client', err);
});

module.exports = pool;
