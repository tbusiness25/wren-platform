'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// All audit endpoints are manager-only
router.use(authenticate);
router.use((req, res, next) => {
  const allowed = ['manager', 'deputy_manager', 'admin'];
  if (!allowed.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  next();
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
    if (to)   { params.push(to);   conditions.push(`occurred_at <= $${params.length} + interval '1 day'`); }
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
    if (to)   { params.push(to);   conditions.push(`occurred_at <= $${params.length} + interval '1 day'`); }
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
