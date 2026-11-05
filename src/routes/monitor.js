'use strict';
/**
 * routes/monitor.js — nursery business watchdog (finance/staffing/absence).
 *
 * Mount (server-unified.js): app.use('/api/monitor', require('../../src/routes/monitor'));
 *
 *   GET  /api/monitor/alerts            open alerts, newest first (auth)
 *   POST /api/monitor/alerts/:id/resolve   resolve one alert (auth)
 *   POST /api/monitor/run               run checks on demand (manager-only)
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { runChecks } = require('../services/nursery-monitor');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── b264: per-tenant, not LADN-only ──────────────────────────────────────────
// This module used to write `ladn.monitor_alerts` from whatever schema the process was
// connected to, so mounting it in any other edition would have read and written
// Your Nursery' production rows. The SQL is now unqualified and follows the pool's
// search_path (src/db/pool.js ← PG_SCHEMA), which is correct: the business watchdog's alerts are
// a per-setting feature, not a shared one.
//
// `monitor_alerts` currently exists only in the ladn schema, because that is the only
// edition where this feature has been rolled out. Mounted elsewhere these routes
// will now 500 on a missing relation — which is the intended outcome. A loud error
// is the correct answer to "this edition has not got this feature yet"; silently
// serving another nursery's rows is not. To roll it out, add the table to that
// schema; do NOT re-qualify the SQL.

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// Alert `detail` can contain child names tied to welfare/absence flags → manager-only
// for EVERY monitor route (not just /run), so non-management staff can't read it. (H2 fix)
router.use(managerOnly);

// GET /api/monitor/alerts — open (unresolved) alerts, newest first.
// ?all=1 includes resolved; ?category=financial filters.
router.get('/alerts', async (req, res) => {
  try {
    const db = getPool();
    const params = [];
    const where = [];
    if (!req.query.all) where.push('resolved_at IS NULL');
    if (req.query.category) { params.push(req.query.category); where.push(`category = $${params.length}`); }
    const sql = `
      SELECT id, category, severity, title, detail, entity_type, entity_id,
             created_at, resolved_at, resolved_by
      FROM monitor_alerts
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END,
        created_at DESC
      LIMIT 500`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.error('monitor /alerts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/monitor/alerts/:id/resolve
router.post('/alerts/:id/resolve', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad id' });
    const { rows } = await db.query(`
      UPDATE monitor_alerts
         SET resolved_at = now(), resolved_by = $2
       WHERE id = $1 AND resolved_at IS NULL
       RETURNING id, resolved_at, resolved_by
    `, [id, req.user.id || null]);
    if (!rows.length) return res.status(404).json({ error: 'not found or already resolved' });
    res.json(rows[0]);
  } catch (err) {
    console.error('monitor resolve error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/monitor/run — manager-only on-demand run (upserts new alerts, no Telegram).
router.post('/run', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const alerts = await runChecks(db);
    let inserted = 0;
    for (const a of alerts) {
      const { rows } = await db.query(`
        INSERT INTO monitor_alerts (category, severity, title, detail, entity_type, entity_id, fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (fingerprint) DO NOTHING
        RETURNING id
      `, [a.category, a.severity, a.title, a.detail, a.entity_type, a.entity_id, a._fp]);
      if (rows.length) inserted++;
    }
    res.json({ evaluated: alerts.length, inserted });
  } catch (err) {
    console.error('monitor run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
