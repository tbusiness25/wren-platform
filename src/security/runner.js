'use strict';
const path = require('path');
const fs = require('fs');
const { getPool } = require('../db/pool');

const CHECKS_DIR = path.join(__dirname, 'checks');
const CHECK_TIMEOUT_MS = 30000;

let _checks = null;

function loadChecks() {
  if (_checks) return _checks;
  _checks = fs.readdirSync(CHECKS_DIR)
    .filter(f => f.endsWith('.js'))
    .map(f => {
      try { return require(path.join(CHECKS_DIR, f)); } catch (e) {
        console.error(`[security] Failed to load check ${f}:`, e.message);
        return null;
      }
    })
    .filter(Boolean);
  return _checks;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Check timed out')), ms)),
  ]);
}

async function runCheck(check) {
  const db = getPool();
  const start = Date.now();
  let result;

  try {
    result = await withTimeout(check.run(), CHECK_TIMEOUT_MS);
  } catch (e) {
    result = {
      status: 'error',
      finding: `Check failed with error: ${e.message}`,
      remediation: 'Review server logs for details.',
      evidence: { error: e.message },
    };
  }

  const duration = Date.now() - start;

  await db.query(`
    INSERT INTO security_check_results (check_key, ran_at, status, finding, remediation, evidence_json, duration_ms)
    VALUES ($1, now(), $2, $3, $4, $5, $6)
  `, [
    check.key,
    result.status,
    result.finding || null,
    result.remediation || null,
    result.evidence ? JSON.stringify(result.evidence) : null,
    duration,
  ]);

  return { key: check.key, status: result.status, duration };
}

async function getEnabledChecks() {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT check_key, frequency_hours, enabled FROM security_checks'
  );
  return new Map(rows.map(r => [r.check_key, r]));
}

async function getLatestResults() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT DISTINCT ON (check_key) check_key, ran_at, status
    FROM security_check_results
    ORDER BY check_key, ran_at DESC
  `);
  return new Map(rows.map(r => [r.check_key, r]));
}

async function runDueChecks() {
  const checks = loadChecks();
  const enabledMap = await getEnabledChecks();
  const latestMap = await getLatestResults();
  const now = Date.now();

  const due = checks.filter(c => {
    const meta = enabledMap.get(c.key);
    if (!meta || !meta.enabled) return false;
    const latest = latestMap.get(c.key);
    if (!latest) return true;
    const ageHours = (now - new Date(latest.ran_at).getTime()) / 3600000;
    return ageHours >= (meta.frequency_hours || 24);
  });

  if (due.length === 0) return { ran: 0 };

  const results = await Promise.all(due.map(c => runCheck(c)));
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const db = getPool();
  await db.query(`
    INSERT INTO security_check_runs (triggered_by, checks_run, pass_count, warn_count, fail_count, error_count)
    VALUES ('cron', $1, $2, $3, $4, $5)
  `, [results.length, counts.pass || 0, counts.warn || 0, counts.fail || 0, counts.error || 0]);

  return { ran: results.length, counts };
}

async function runAllChecks(triggeredBy = 'manual') {
  const checks = loadChecks();
  const enabledMap = await getEnabledChecks();

  const enabled = checks.filter(c => {
    const meta = enabledMap.get(c.key);
    return meta && meta.enabled;
  });

  const results = await Promise.all(enabled.map(c => runCheck(c)));
  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});

  const db = getPool();
  await db.query(`
    INSERT INTO security_check_runs (triggered_by, checks_run, pass_count, warn_count, fail_count, error_count)
    VALUES ($1, $2, $3, $4, $5, $6)
  `, [triggeredBy, results.length, counts.pass || 0, counts.warn || 0, counts.fail || 0, counts.error || 0]);

  return { ran: results.length, counts, results };
}

// Hourly cron: run any due checks
function startCron() {
  const INTERVAL_MS = 60 * 60 * 1000;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const r = await runDueChecks();
      if (r.ran > 0) console.log(`[security] Ran ${r.ran} due check(s):`, r.counts);
    } catch (e) {
      console.error('[security] Cron error:', e.message);
    } finally {
      running = false;
    }
  }

  setInterval(tick, INTERVAL_MS);
  // Run initial check after 30s to allow DB to settle on startup
  setTimeout(tick, 30000);
  console.log('[security] Hourly check cron started');
}

module.exports = { loadChecks, runAllChecks, runDueChecks, startCron };
