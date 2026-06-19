'use strict';
// Regulatory feed — API routes.
// GET  /api/regulatory/sources               — list all sources
// GET  /api/regulatory/sources/:id/force-poll — trigger immediate poll
// PATCH /api/regulatory/sources/:id          — update is_active / poll_interval
// GET  /api/regulatory/alerts                — list alerts with filters
// GET  /api/regulatory/alerts/:id            — single alert detail
// PATCH /api/regulatory/alerts/:id           — update status / mark reviewed
// GET  /api/regulatory/policy-map            — source × policy links
// GET  /api/regulatory/insights              — stats for insights widget

const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const auth = require('../middleware/auth');

const schema = () => process.env.PG_SCHEMA || 'ladn';

// ── Sources ───────────────────────────────────────────────────────────────────

router.get('/sources', auth, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT rs.*,
             COUNT(ra.id) FILTER (WHERE ra.status = 'new') AS new_alerts,
             COUNT(ra.id) AS total_alerts
      FROM ${schema()}.regulatory_sources rs
      LEFT JOIN ${schema()}.regulatory_alerts ra ON ra.source_id = rs.id
      GROUP BY rs.id
      ORDER BY rs.importance, rs.name
    `);
    res.json(rows);
  } catch (e) {
    console.error('GET /regulatory/sources:', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/sources/:id', auth, async (req, res) => {
  const { is_active, poll_interval_hours } = req.body;
  try {
    const db = getPool();
    const sets = [];
    const vals = [];
    if (is_active !== undefined) { sets.push(`is_active=$${sets.length + 1}`); vals.push(is_active); }
    if (poll_interval_hours !== undefined) { sets.push(`poll_interval_hours=$${sets.length + 1}`); vals.push(poll_interval_hours); }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE ${schema()}.regulatory_sources SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    res.json(rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sources/:id/force-poll', auth, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM ${schema()}.regulatory_sources WHERE id=$1`, [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Source not found' });

    // Reset last_polled_at so the poller will pick it up immediately
    await db.query(
      `UPDATE ${schema()}.regulatory_sources SET last_polled_at=null WHERE id=$1`, [req.params.id]
    );

    // Fire-and-forget the poll
    const { runDueSources } = require('../services/regulatory-feed-poller');
    runDueSources(schema()).catch(e => console.error('force-poll error:', e));

    res.json({ ok: true, message: 'Poll triggered' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Alerts ────────────────────────────────────────────────────────────────────

router.get('/alerts', auth, async (req, res) => {
  const { status, source_id, importance, limit = 50, offset = 0 } = req.query;
  const wheres = [];
  const vals   = [];

  if (status)     { wheres.push(`ra.status=$${vals.length+1}`);            vals.push(status); }
  if (source_id)  { wheres.push(`ra.source_id=$${vals.length+1}`);         vals.push(source_id); }
  if (importance) { wheres.push(`rs.importance=$${vals.length+1}`);        vals.push(importance); }

  const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';

  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ra.*,
             rs.name AS source_name, rs.publisher, rs.importance, rs.category,
             st.first_name || ' ' || st.last_name AS reviewed_by_name,
             (SELECT COUNT(*) FROM ${schema()}.regulatory_policy_links rpl WHERE rpl.source_id = ra.source_id) AS policy_link_count,
             (ra.ai_analysis->'affected_policies') AS affected_policies_json
      FROM ${schema()}.regulatory_alerts ra
      JOIN ${schema()}.regulatory_sources rs ON rs.id = ra.source_id
      LEFT JOIN ${schema()}.staff st ON st.id = ra.reviewed_by
      ${where}
      ORDER BY ra.detected_at DESC
      LIMIT $${vals.length+1} OFFSET $${vals.length+2}
    `, [...vals, parseInt(limit), parseInt(offset)]);

    const { rows: cnt } = await db.query(
      `SELECT COUNT(*) FROM ${schema()}.regulatory_alerts ra
       JOIN ${schema()}.regulatory_sources rs ON rs.id = ra.source_id ${where}`, vals
    );

    res.json({ alerts: rows, total: parseInt(cnt[0].count) });
  } catch (e) {
    console.error('GET /regulatory/alerts:', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/alerts/:id', auth, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ra.*,
             rs.name AS source_name, rs.publisher, rs.importance, rs.category, rs.url AS source_url,
             st.first_name || ' ' || st.last_name AS reviewed_by_name
      FROM ${schema()}.regulatory_alerts ra
      JOIN ${schema()}.regulatory_sources rs ON rs.id = ra.source_id
      LEFT JOIN ${schema()}.staff st ON st.id = ra.reviewed_by
      WHERE ra.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Alert not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/alerts/:id', auth, async (req, res) => {
  const { status, related_workspace_id } = req.body;
  const staffId = req.user?.id;
  try {
    const db = getPool();
    const sets = [`status=$1`, `reviewed_by=$2`, `reviewed_at=now()`];
    const vals = [status, staffId, req.params.id];
    if (related_workspace_id !== undefined) {
      sets.push(`related_workspace_id=$${vals.length}`);
      vals.splice(vals.length - 1, 0, related_workspace_id);
    }
    const { rows } = await db.query(
      `UPDATE ${schema()}.regulatory_alerts SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    res.json(rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Policy map ────────────────────────────────────────────────────────────────

router.get('/policy-map', auth, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT rpl.*,
             rs.source_key, rs.name AS source_name, rs.publisher,
             rs.category
      FROM ${schema()}.regulatory_policy_links rpl
      JOIN ${schema()}.regulatory_sources rs ON rs.id = rpl.source_id
      ORDER BY rs.importance, rs.name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Insights widget ───────────────────────────────────────────────────────────

router.get('/insights', auth, async (req, res) => {
  try {
    const db = getPool();
    const [alerts30, openAlerts, avgDays, errorSources] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM ${schema()}.regulatory_alerts WHERE detected_at > now()-interval '30 days'`),
      db.query(`SELECT COUNT(*) FROM ${schema()}.regulatory_alerts WHERE status='new' AND ai_analysis->>'is_substantive'='true'`),
      db.query(`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (reviewed_at - detected_at))/86400)::numeric, 1) AS avg_days
                FROM ${schema()}.regulatory_alerts
                WHERE reviewed_at IS NOT NULL AND detected_at > now()-interval '90 days'`),
      db.query(`SELECT COUNT(*) FROM ${schema()}.regulatory_sources WHERE last_error IS NOT NULL AND is_active=true`),
    ]);
    res.json({
      alerts_last_30d:     parseInt(alerts30.rows[0].count),
      open_alerts:         parseInt(openAlerts.rows[0].count),
      avg_days_to_action:  parseFloat(avgDays.rows[0].avg_days) || null,
      sources_with_errors: parseInt(errorSources.rows[0].count),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Trigger AI analysis for a single alert (manual re-run) ────────────────────

router.post('/alerts/:id/analyse', auth, async (req, res) => {
  try {
    const db = getPool();
    // Reset ai_analysis to null so analyser picks it up
    await db.query(
      `UPDATE ${schema()}.regulatory_alerts SET ai_analysis=null, status='new' WHERE id=$1`, [req.params.id]
    );
    const { runAnalyser } = require('../services/regulatory-alert-analyser');
    runAnalyser(schema()).catch(e => console.error('manual analyse error:', e));
    res.json({ ok: true, message: 'Analysis queued' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
