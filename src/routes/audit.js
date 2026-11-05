'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// POST /api/audit/beacon — client-side events (page_view / click / session_end).
// b164 (2026-07-27). Registered BEFORE the manager gate: every signed-in staff
// member's portal reports usage; only READING the log stays manager-only.
router.post('/beacon', async (req, res) => {
  try {
    const events = Array.isArray(req.body?.events) ? req.body.events.slice(0, 50) : [];
    const ALLOWED = new Set(['page_view', 'click', 'session_end']);
    const db = getPool();
    for (const ev of events) {
      const t = String(ev?.t || '');
      if (!ALLOWED.has(t)) continue;
      await db.query(
        `INSERT INTO audit_log (actor_type, actor_id, actor_email, action, entity_type, entity_id, edition, ip, user_agent, meta)
         VALUES ($1,$2,$3,$4,'ui',$5,$6,$7,$8,$9)`,
        [req.user.role || 'staff', req.user.id || null, req.user.email || null, t,
         String(ev.page || '').slice(0, 120) || null,
         req._portal || null,
         (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim(),
         String(req.headers['user-agent'] || '').slice(0, 250),
         JSON.stringify({
           label: String(ev.label || '').slice(0, 64) || undefined,
           page: String(ev.page || '').slice(0, 120) || undefined,
           dur_s: Number.isFinite(+ev.dur_s) ? Math.round(+ev.dur_s) : undefined,
           auto: true,
         })]).catch(() => {});
    }
    res.json({ ok: true, accepted: events.length });
  } catch (e) {
    res.status(200).json({ ok: false }); // beacons must never error loudly
  }
});

// All remaining audit endpoints are manager-only
router.use((req, res, next) => {
  const allowed = ['manager', 'deputy_manager', 'admin'];
  if (!hasRole(req.user, allowed)) return res.status(403).json({ error: 'Forbidden' });
  next();
});

// GET /api/audit/usage?days=14 — per-staff per-day usage rollup (b164):
// session span (first→last event), time-on-portal, and action counts — the
// "how long are staff using it, and are they using it correctly?" view.
router.get('/usage', async (req, res) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 14));
    const { rows } = await getPool().query(
      `SELECT a.actor_id,
              COALESCE(s.first_name || ' ' || s.last_name, a.actor_email, 'unknown') AS staff,
              a.occurred_at::date AS day,
              min(a.occurred_at) AS first_event,
              max(a.occurred_at) AS last_event,
              round(extract(epoch FROM max(a.occurred_at) - min(a.occurred_at)) / 60.0)::int AS span_minutes,
              count(*) FILTER (WHERE a.action = 'login')::int AS logins,
              count(*) FILTER (WHERE a.action = 'page_view')::int AS page_views,
              count(*) FILTER (WHERE a.action = 'click')::int AS clicks,
              count(*) FILTER (WHERE a.action = 'view')::int AS api_views,
              count(*) FILTER (WHERE a.action = 'create')::int AS creates,
              count(*) FILTER (WHERE a.action = 'update')::int AS updates,
              count(*) FILTER (WHERE a.action = 'delete')::int AS deletes,
              count(*) FILTER (WHERE a.action = 'download')::int AS downloads,
              string_agg(DISTINCT a.edition, ',') AS portals
         FROM audit_log a
         LEFT JOIN staff s ON s.id = a.actor_id
        WHERE a.occurred_at > now() - ($1 || ' days')::interval
          AND a.actor_id IS NOT NULL
        GROUP BY 1, 2, 3
        ORDER BY day DESC, staff`, [days]);
    res.json({ days, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit — paginated log with filters
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const {
      from, to,
      actor_id, entity_type, action,
      q,
      page = 1,
      per_page = 50,
    } = req.query;

    const conditions = [];
    const params = [];

    if (from) { params.push(from); conditions.push(`occurred_at >= $${params.length}`); }
    if (to)   { params.push(to);   conditions.push(`occurred_at <= $${params.length}::timestamptz + interval '1 day'`); }
    if (actor_id)    { params.push(actor_id);    conditions.push(`actor_id = $${params.length}`); }
    if (entity_type) { params.push(entity_type); conditions.push(`entity_type = $${params.length}`); }
    if (action)      { params.push(action);      conditions.push(`action = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const n = params.length;
      conditions.push(`(actor_email ILIKE $${n} OR entity_id ILIKE $${n} OR meta::text ILIKE $${n})`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const offset = (Math.max(1, parseInt(page)) - 1) * parseInt(per_page);
    params.push(parseInt(per_page));
    params.push(offset);

    const sql = `
      SELECT a.*,
             s.first_name || ' ' || s.last_name AS actor_name
      FROM audit_log a
      LEFT JOIN staff s ON s.id = a.actor_id
      ${where}
      ORDER BY a.occurred_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `;

    const countSql = `SELECT count(*)::int AS total FROM audit_log ${where}`;
    const countParams = params.slice(0, params.length - 2);

    const [{ rows }, { rows: countRows }] = await Promise.all([
      db.query(sql, params),
      db.query(countSql, countParams),
    ]);

    res.json({ rows, total: countRows[0].total, page: parseInt(page), per_page: parseInt(per_page) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit/staff-list — for actor filter dropdown
router.get('/staff-list', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT DISTINCT a.actor_id AS id, s.first_name || ' ' || s.last_name AS name
       FROM audit_log a
       JOIN staff s ON s.id = a.actor_id
       WHERE a.actor_id IS NOT NULL
       ORDER BY name`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/audit/export.csv — CSV download of filtered results
router.get('/export.csv', async (req, res) => {
  try {
    const db = getPool();
    const { from, to, actor_id, entity_type, action, q } = req.query;

    const conditions = [];
    const params = [];

    if (from) { params.push(from); conditions.push(`occurred_at >= $${params.length}`); }
    if (to)   { params.push(to);   conditions.push(`occurred_at <= $${params.length}::timestamptz + interval '1 day'`); }
    if (actor_id)    { params.push(actor_id);    conditions.push(`actor_id = $${params.length}`); }
    if (entity_type) { params.push(entity_type); conditions.push(`entity_type = $${params.length}`); }
    if (action)      { params.push(action);      conditions.push(`action = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      const n = params.length;
      conditions.push(`(actor_email ILIKE $${n} OR entity_id ILIKE $${n} OR meta::text ILIKE $${n})`);
    }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const sql = `
      SELECT a.id, a.occurred_at, a.actor_type, a.actor_id,
             COALESCE(s.first_name || ' ' || s.last_name, a.actor_email) AS actor,
             a.action, a.entity_type, a.entity_id, a.edition, a.ip
      FROM audit_log a
      LEFT JOIN staff s ON s.id = a.actor_id
      ${where}
      ORDER BY a.occurred_at DESC
      LIMIT 10000
    `;
    const { rows } = await db.query(sql, params);

    const header = 'id,occurred_at,actor_type,actor_id,actor,action,entity_type,entity_id,edition,ip\n';
    const csv = header + rows.map(r =>
      [r.id, r.occurred_at, r.actor_type, r.actor_id, r.actor, r.action, r.entity_type, r.entity_id, r.edition, r.ip]
        .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-log-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
