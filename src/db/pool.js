const { Pool } = require('pg');

let pool;

function getPool() {
  if (!pool) {
    const schema = process.env.PG_SCHEMA || 'ladn';
    pool = new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5434'),
      database: process.env.PG_DB || 'wren',
      user: process.env.PG_USER || 'wren',
      password: process.env.PG_PASSWORD,
      options: `-c search_path=${schema},public`,
      max: 10,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => {
      console.error('DB pool error:', err.message);
    });
  }
  return pool;
}

module.exports = { getPool };
