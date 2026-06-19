const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const EventEmitter = require('events');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || 'wren',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'wren',
});

const schema = () => process.env.PG_SCHEMA || 'demo_primary';

// In-process SSE bus for real-time class display (per class_id)
const sseClients = new Map();
const sseBus = new EventEmitter();
sseBus.setMaxListeners(500);

function emitToClass(class_id, data) {
  const clients = sseClients.get(String(class_id));
  if (!clients) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => { try { res.write(payload); } catch (_) {} });
}

function weekMonday(d = new Date()) {
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1);
  return new Date(d.setDate(diff)).toISOString().slice(0, 10);
}

// GET /api/points/categories
// Returns categories visible for awarding (negatives filtered unless enabled)
router.get('/categories', async (req, res) => {
  const s = schema();
  try {
    const { rows: sRows } = await pool.query(
      `SELECT negative_points_enabled FROM ${s}.wp_school_settings WHERE school_id=1`
    );
    const negEnabled = sRows[0]?.negative_points_enabled ?? false;
    const { rows } = await pool.query(
      `SELECT * FROM ${s}.wp_categories WHERE school_id=1
       ${negEnabled ? '' : 'AND is_negative=false'}
       ORDER BY sort_order, id`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/points/class-grid?class_id=X&week=YYYY-MM-DD
router.get('/class-grid', async (req, res) => {
  const s = schema();
  const { class_id, week } = req.query;
  if (!class_id) return res.status(400).json({ error: 'class_id required' });
  const ws = week || weekMonday();
  try {
    const { rows } = await pool.query(`
      SELECT ch.id, ch.first_name, ch.last_name, ch.photo_url,
        COALESCE(SUM(CASE WHEN a.value > 0 THEN a.value ELSE 0 END), 0)::int AS positive_total,
        COALESCE(SUM(CASE WHEN a.value < 0 THEN a.value ELSE 0 END), 0)::int AS negative_total,
        COALESCE(SUM(a.value), 0)::int AS week_total
      FROM ${s}.children ch
      LEFT JOIN ${s}.wp_awards a
        ON a.child_id = ch.id
        AND a.awarded_at::date >= $2::date
        AND a.awarded_at::date <  ($2::date + INTERVAL '7 days')
      WHERE ch.is_active = true
        AND ch.year_group = (SELECT year_group::text FROM ${s}.classes WHERE id=$1)
      GROUP BY ch.id, ch.first_name, ch.last_name, ch.photo_url
      ORDER BY ch.last_name, ch.first_name
    `, [class_id, ws]);
    res.json({ week_start: ws, children: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/points/feed?child_id=X&limit=50&offset=0
// Awards feed for a single child — private to staff/manager/that child's parents
router.get('/feed', async (req, res) => {
  const s = schema();
  const { child_id, limit = 50, offset = 0 } = req.query;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const { rows } = await pool.query(`
      SELECT a.id, a.awarded_at, a.value, a.reason_text, a.photo_id,
        cat.name AS category_name, cat.icon AS category_icon,
        CONCAT(st.first_name, ' ', st.last_name) AS awarded_by_name
      FROM ${s}.wp_awards a
      JOIN ${s}.wp_categories cat ON cat.id = a.category_id
      JOIN ${s}.staff st          ON st.id  = a.awarded_by_staff_id
      WHERE a.child_id = $1
      ORDER BY a.awarded_at DESC
      LIMIT $2 OFFSET $3
    `, [child_id, limit, offset]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/points/leaderboard?class_id=X&week=YYYY-MM-DD
// Weekly totals only — no per-award detail, no comparison between children
router.get('/leaderboard', async (req, res) => {
  const s = schema();
  const { class_id, week } = req.query;
  if (!class_id) return res.status(400).json({ error: 'class_id required' });
  const ws = week || weekMonday();
  try {
    const { rows } = await pool.query(`
      SELECT ch.id, ch.first_name, ch.photo_url,
        COALESCE(SUM(CASE WHEN a.value > 0 THEN a.value ELSE 0 END), 0)::int AS week_total,
        string_agg(DISTINCT cat.icon, '' ORDER BY cat.icon) AS category_icons
      FROM ${s}.children ch
      LEFT JOIN ${s}.wp_awards a
        ON a.child_id = ch.id
        AND a.awarded_at::date >= $2::date
        AND a.awarded_at::date <  ($2::date + INTERVAL '7 days')
      LEFT JOIN ${s}.wp_categories cat ON cat.id = a.category_id AND a.value > 0
      WHERE ch.is_active = true
        AND ch.year_group = (SELECT year_group::text FROM ${s}.classes WHERE id=$1)
      GROUP BY ch.id, ch.first_name, ch.photo_url
      ORDER BY week_total DESC, ch.first_name
    `, [class_id, ws]);
    res.json({ week_start: ws, pupils: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/points/award
router.post('/award', async (req, res) => {
  const s = schema();
  const { child_id, category_id, awarded_by_staff_id, reason_text, photo_id, class_id } = req.body;
  if (!child_id || !category_id || !awarded_by_staff_id) {
    return res.status(400).json({ error: 'child_id, category_id, awarded_by_staff_id required' });
  }
  try {
    const { rows: cats } = await pool.query(
      `SELECT c.*, s.negative_points_enabled
       FROM ${s}.wp_categories c, ${s}.wp_school_settings s
       WHERE c.id=$1 AND s.school_id=1`,
      [category_id]
    );
    if (!cats.length) return res.status(400).json({ error: 'Category not found' });
    const cat = cats[0];
    if (cat.is_negative && !cat.negative_points_enabled) {
      return res.status(403).json({ error: 'Negative points are not enabled for this school' });
    }
    const value = cat.is_negative ? -Math.abs(cat.default_value) : cat.default_value;

    const { rows } = await pool.query(`
      INSERT INTO ${s}.wp_awards (child_id, category_id, awarded_by_staff_id, value, reason_text, photo_id)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [child_id, category_id, awarded_by_staff_id, value, reason_text || null, photo_id || null]);

    const award = rows[0];

    const { rows: childRows } = await pool.query(
      `SELECT first_name, last_name, photo_url FROM ${s}.children WHERE id=$1`, [child_id]
    );
    const child = childRows[0] || {};

    // Push to any open whiteboard streams for this class
    if (class_id) {
      emitToClass(class_id, {
        type: 'award',
        award_id: award.id,
        child_id,
        child_name: `${child.first_name} ${child.last_name}`,
        child_first: child.first_name,
        child_photo: child.photo_url,
        category_name: cat.name,
        category_icon: cat.icon,
        value,
        reason_text: reason_text || null,
        awarded_at: award.awarded_at,
      });
    }

    res.status(201).json({ ...award, category: cat, child });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/points/child/:childId — recent awards for a specific child (parent portal)
router.get('/child/:childId', async (req, res) => {
  const s = schema();
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const { rows } = await pool.query(
      `SELECT a.id, a.awarded_at, a.value as points, a.reason_text as reason,
              c.name as category
       FROM ${s}.wp_awards a
       LEFT JOIN ${s}.wp_categories c ON c.id = a.category_id
       WHERE a.child_id = $1
       ORDER BY a.awarded_at DESC
       LIMIT $2`,
      [req.params.childId, limit]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/points/stream?class_id=X  — SSE for whiteboard real-time display
router.get('/stream', (req, res) => {
  const { class_id } = req.query;
  if (!class_id) return res.status(400).end();

  res.set({
    'Content-Type':    'text/event-stream',
    'Cache-Control':   'no-cache',
    'X-Accel-Buffering': 'no',
    'Connection':      'keep-alive',
  });
  res.flushHeaders();
  res.write(': connected\n\n');

  const key = String(class_id);
  if (!sseClients.has(key)) sseClients.set(key, new Set());
  sseClients.get(key).add(res);

  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 25000);

  req.on('close', () => {
    clearInterval(keepalive);
    sseClients.get(key)?.delete(res);
    if (sseClients.get(key)?.size === 0) sseClients.delete(key);
  });
});

module.exports = router;
