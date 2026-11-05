'use strict';
// Automation runner (2026-07-15) — every few minutes, fire any enabled automation
// whose next_run_at is due, then reschedule it. Safe actions only (see routes/automations.js).
// Idempotent-ish: advances next_run_at before running so a slow action can't double-fire.
const { getPool } = require('../db/pool');
const automations = require('../routes/automations');

const INTERVAL_MS = 5 * 60 * 1000;

async function tick() {
  const pool = getPool();
  let due;
  try {
    const { rows } = await pool.query(
      "SELECT * FROM automations WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= now() ORDER BY next_run_at LIMIT 25");
    due = rows;
  } catch (e) {
    // table not created yet in this tenant — nothing to do
    return;
  }
  for (const a of due) {
    try {
      // reschedule first so a failure or slow run doesn't re-fire the same due row
      const next = automations.computeNextRun(a.schedule || {}, new Date());
      await pool.query('UPDATE automations SET next_run_at=$2 WHERE id=$1', [a.id, next]);
      const result = await automations.executeAutomation(pool, a);
      await pool.query('UPDATE automations SET last_run_at=now(), last_result=$2 WHERE id=$1', [a.id, result]);
      await automations.recordRun(pool, a.id, result);
      console.log(`[automation-runner] ran #${a.id} "${a.name}" → ${result}`);
    } catch (e) {
      console.error(`[automation-runner] #${a.id} failed:`, e.message);
      const errResult = 'error: ' + e.message;
      await pool.query('UPDATE automations SET last_result=$2 WHERE id=$1', [a.id, errResult]).catch(() => {});
      await automations.recordRun(pool, a.id, errResult).catch(() => {});
    }
  }
}

function startAutomationRunner() {
  // small delay so the pool/tenant is ready
  setTimeout(() => { tick().catch(() => {}); }, 20000);
  setInterval(() => { tick().catch(() => {}); }, INTERVAL_MS);
  console.log('[automation-runner] started (every 5 min)');
}

module.exports = { startAutomationRunner, tick };
