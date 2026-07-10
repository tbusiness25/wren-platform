const express = require('express');
const router = express.Router();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || 'wren',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'wren',
});

const schema = () => process.env.PG_SCHEMA || 'demo_primary';

// GET /api/points-admin/settings
router.get('/settings', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ${s}.wp_school_settings WHERE school_id=1`
    );
    res.json(rows[0] || { school_id: 1, negative_points_enabled: false });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/points-admin/categories — all categories including negatives
router.get('/categories', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ${s}.wp_categories WHERE school_id=1 ORDER BY sort_order, id`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/points-admin/categories — create or update
router.post('/categories', async (req, res) => {
  const s = schema();
  const { id, name, icon, default_value, is_negative, sort_order } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  try {
    if (id) {
      const { rows } = await pool.query(
        `UPDATE ${s}.wp_categories
         SET name=$1, icon=$2, default_value=$3, is_negative=$4, sort_order=$5
         WHERE id=$6 AND school_id=1 RETURNING *`,
        [name.trim(), icon || '⭐', default_value || 1, !!is_negative, sort_order ?? 0, id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(rows[0]);
    } else {
      const { rows } = await pool.query(
        `INSERT INTO ${s}.wp_categories (school_id, name, icon, default_value, is_negative, sort_order)
         VALUES (1,$1,$2,$3,$4,$5) RETURNING *`,
        [name.trim(), icon || '⭐', default_value || 1, !!is_negative, sort_order ?? 0]
      );
      res.status(201).json(rows[0]);
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/points-admin/categories/:id
router.delete('/categories/:id', async (req, res) => {
  const s = schema();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM ${s}.wp_categories WHERE id=$1 AND school_id=1`,
      [req.params.id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/points-admin/research-acknowledge
// Records that admin has read the research — prerequisite for enabling negative points
router.post('/research-acknowledge', async (req, res) => {
  const s = schema();
  const { name } = req.body;
  if (!name || name.trim().length < 3) {
    return res.status(400).json({ error: 'Full name is required' });
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || req.socket?.remoteAddress
    || 'unknown';
  try {
    await pool.query(`
      INSERT INTO ${s}.wp_school_settings
        (school_id, research_acknowledged_by, research_acknowledged_at, research_acknowledged_ip)
      VALUES (1, $1, now(), $2)
      ON CONFLICT (school_id) DO UPDATE
        SET research_acknowledged_by=$1,
            research_acknowledged_at=now(),
            research_acknowledged_ip=$2
    `, [name.trim(), ip]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/points-admin/toggle-negative
// Body: { enabled: bool, staff_id: int }
// Requires research acknowledgement before enabling
router.post('/toggle-negative', async (req, res) => {
  const s = schema();
  const { enabled, staff_id } = req.body;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM ${s}.wp_school_settings WHERE school_id=1`
    );
    const settings = rows[0];

    if (enabled && !settings?.research_acknowledged_by) {
      return res.status(403).json({
        error: 'Research acknowledgement required before enabling negative points',
        code: 'RESEARCH_REQUIRED',
      });
    }

    await pool.query(`
      INSERT INTO ${s}.wp_school_settings
        (school_id, negative_points_enabled, negative_points_enabled_by, negative_points_enabled_at)
      VALUES (1, $1, $2, $3)
      ON CONFLICT (school_id) DO UPDATE
        SET negative_points_enabled=$1,
            negative_points_enabled_by=$2,
            negative_points_enabled_at=$3
    `, [!!enabled, staff_id || null, enabled ? new Date() : null]);

    res.json({ ok: true, negative_points_enabled: !!enabled });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/points-admin/audit
router.get('/audit', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(`
      SELECT
        ws.negative_points_enabled,
        ws.negative_points_enabled_at,
        ws.research_acknowledged_by,
        ws.research_acknowledged_at,
        ws.research_acknowledged_ip,
        CONCAT(st.first_name, ' ', st.last_name) AS enabled_by_name
      FROM ${s}.wp_school_settings ws
      LEFT JOIN ${s}.staff st ON st.id = ws.negative_points_enabled_by
      WHERE ws.school_id = 1
    `);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
