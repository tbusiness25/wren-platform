// @ts-check  (b508, 2026-10-18) — this file is type-checked. jsconfig.json has
// checkJs:false, so only files carrying this comment are checked; see jsconfig.json
// for how to run it. Keep it passing, or take the comment off deliberately.
// NOTE: this comment must stay the FIRST thing in the file — above 'use strict' —
// or TypeScript ignores it and the file is silently not checked.
const { Pool } = require('pg');
const { resolveConnection, schema, assertInstancePlacement, describe } = require('./connection');

let pool;

function getPool() {
  if (!pool) {
    // b264: connection details now come from src/db/connection.js so that this pool
    // and the eighteen modules that build their own agree on one answer. Behaviour is
    // unchanged for every container in service today — the resolver reads the same
    // PG_* variables, in the same order, with PG_DB winning as before.
    assertInstancePlacement();          // no-op unless PG_ENFORCE_INSTANCE=true
    const conn = resolveConnection();
    pool = new Pool({
      ...conn,
      options: `-c search_path=${schema()},public`,
      max: 10,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => {
      console.error('DB pool error:', err.message);
    });
    if (process.env.PG_LOG_TARGET === 'true') console.log('[db] ' + describe());
  }
  return pool;
}

// b333: the pool if this process already made one, else null — never creates it. Lets a
// library read a settings row without keeping a short script alive on a fresh pool.
function peekPool() { return pool || null; }

module.exports = { getPool, peekPool };
