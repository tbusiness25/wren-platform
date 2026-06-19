const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const https = require('https');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || 'wren',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'wren',
});

const schema = () => process.env.PG_SCHEMA || 'demo_primary';

// GET /api/behaviour-points — list points with filters
// class_id, pupil_id, type, date_from, date_to, date=today
router.get('/', async (req, res) => {
  const s = schema();
  const { pupil_id, type, date_from, date_to, date, class_id } = req.query;
  try {
    let where = ['1=1'];
    const vals = [];
    if (pupil_id)  { vals.push(pupil_id);  where.push(`bp.pupil_id=$${vals.length}`); }
    if (type)      { vals.push(type);       where.push(`bp.type=$${vals.length}`); }
    if (date === 'today') {
      where.push('bp.awarded_at::date = CURRENT_DATE');
    } else {
      if (date_from) { vals.push(date_from);  where.push(`bp.awarded_at::date>=$${vals.length}`); }
      if (date_to)   { vals.push(date_to);    where.push(`bp.awarded_at::date<=$${vals.length}`); }
    }
    if (class_id) {
      vals.push(class_id);
      where.push(`ch.year_group = (SELECT year_group::text FROM ${s}.classes WHERE id=$${vals.length})`);
    }
    const { rows } = await pool.query(
      `SELECT bp.*, CONCAT(ch.first_name,' ',ch.last_name) AS pupil_name, CONCAT(st.first_name,' ',st.last_name) AS teacher_name
       FROM ${s}.behaviour_points bp
       LEFT JOIN ${s}.children ch ON ch.id=bp.pupil_id
       LEFT JOIN ${s}.staff st ON st.id=bp.awarded_by_teacher_id
       WHERE ${where.join(' AND ')} ORDER BY bp.awarded_at DESC LIMIT 500`, vals
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/behaviour-points/today-totals?class_id=X
// Returns [{pupil_id, name, photo_url, total_today}] for all active pupils in a class
router.get('/today-totals', async (req, res) => {
  const s = schema();
  const { class_id } = req.query;
  if (!class_id) return res.status(400).json({ error: 'class_id required' });
  try {
    const { rows } = await pool.query(`
      SELECT ch.id AS pupil_id,
             CONCAT(ch.first_name,' ',ch.last_name) AS name,
             ch.first_name, ch.last_name,
             ch.photo_url,
             COALESCE(SUM(CASE WHEN bp.type='positive' THEN bp.points ELSE 0 END) FILTER (WHERE bp.awarded_at::date = CURRENT_DATE), 0) AS total_today,
             COALESCE(SUM(CASE WHEN bp.type='negative' THEN bp.points ELSE 0 END) FILTER (WHERE bp.awarded_at::date = CURRENT_DATE), 0) AS negatives_today
      FROM ${s}.children ch
      LEFT JOIN ${s}.behaviour_points bp ON bp.pupil_id=ch.id
      WHERE ch.is_active=true
        AND ch.year_group = (SELECT year_group::text FROM ${s}.classes WHERE id=$1)
      GROUP BY ch.id, ch.first_name, ch.last_name, ch.photo_url
      ORDER BY ch.last_name, ch.first_name
    `, [class_id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/behaviour-points/settings — read categories from wren_settings
router.get('/settings', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT value FROM ${s}.wren_settings WHERE key='behaviour_categories'`
    );
    const categories = rows.length ? rows[0].value.categories : ['Respectful','Resilient','Ready','Reflective','Resourceful'];
    const { rows: modeRows } = await pool.query(
      `SELECT value FROM ${s}.wren_settings WHERE key='behaviour_notification_mode'`
    );
    const notification = modeRows.length ? modeRows[0].value : { mode: 'digest', time: '17:00', enabled: true };
    res.json({ categories, notification });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/behaviour-points/settings — save categories
router.post('/settings', async (req, res) => {
  const s = schema();
  const { categories, notification } = req.body;
  try {
    if (categories) {
      await pool.query(
        `INSERT INTO ${s}.wren_settings (key, value) VALUES ('behaviour_categories', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`,
        [JSON.stringify({ categories })]
      );
    }
    if (notification) {
      await pool.query(
        `INSERT INTO ${s}.wren_settings (key, value) VALUES ('behaviour_notification_mode', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`,
        [JSON.stringify(notification)]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/behaviour-points/notify-now — trigger digest notification immediately
router.post('/notify-now', async (req, res) => {
  const s = schema();
  try {
    // Fetch unnotified points from today grouped by pupil
    const { rows } = await pool.query(`
      SELECT bp.pupil_id,
             CONCAT(ch.first_name,' ',ch.last_name) AS pupil_name,
             SUM(CASE WHEN bp.type='positive' THEN bp.points ELSE 0 END) AS positive_points,
             SUM(CASE WHEN bp.type='negative' THEN bp.points ELSE 0 END) AS negative_points,
             string_agg(DISTINCT bp.category, ', ' ORDER BY bp.category) AS categories,
             ch.parent_1_email, ch.parent_2_email
      FROM ${s}.behaviour_points bp
      JOIN ${s}.children ch ON ch.id=bp.pupil_id
      WHERE bp.awarded_at::date = CURRENT_DATE AND bp.parent_notified=false
      GROUP BY bp.pupil_id, ch.first_name, ch.last_name, ch.parent_1_email, ch.parent_2_email
    `);

    if (!rows.length) return res.json({ ok: true, sent: 0, message: 'No unnotified points today' });

    // Mark as notified
    await pool.query(
      `UPDATE ${s}.behaviour_points SET parent_notified=true WHERE awarded_at::date=CURRENT_DATE AND parent_notified=false`
    );

    // Post to n8n webhook if configured
    const N8N_WEBHOOK = process.env.BEHAVIOUR_NOTIFY_WEBHOOK;
    if (N8N_WEBHOOK) {
      try {
        const payload = JSON.stringify({ trigger: 'notify-now', date: new Date().toISOString().slice(0,10), pupils: rows });
        const url = new URL(N8N_WEBHOOK);
        const options = {
          hostname: url.hostname, port: url.port || 443,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        };
        const lib = url.protocol === 'https:' ? https : require('http');
        lib.request(options, r => r.resume()).on('error', () => {}).end(payload);
      } catch (_) {}
    }

    res.json({ ok: true, sent: rows.length, pupils: rows.map(r => r.pupil_name) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Leaderboard: top pupils by house points
router.get('/leaderboard', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(
      `SELECT ch.id, CONCAT(ch.first_name,' ',ch.last_name) AS name, h.house_name, h.colour,
        COALESCE(SUM(CASE WHEN bp.type='positive' THEN bp.points ELSE 0 END),0) AS positive_points,
        COALESCE(SUM(CASE WHEN bp.type='negative' THEN bp.points ELSE 0 END),0) AS negative_points
       FROM ${s}.children ch
       LEFT JOIN ${s}.pupil_house ph ON ph.pupil_id=ch.id
       LEFT JOIN ${s}.houses h ON h.id=ph.house_id
       LEFT JOIN ${s}.behaviour_points bp ON bp.pupil_id=ch.id
       WHERE ch.is_active=true
       GROUP BY ch.id, ch.first_name, ch.last_name, h.house_name, h.colour
       ORDER BY positive_points DESC LIMIT 50`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// House totals
router.get('/houses', async (req, res) => {
  const s = schema();
  try {
    const { rows } = await pool.query(`SELECT * FROM ${s}.houses ORDER BY points_total DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/behaviour-points — award points
router.post('/', async (req, res) => {
  const s = schema();
  const { pupil_id, awarded_by_teacher_id, type, category, points, reason } = req.body;
  try {
    const { rows } = await pool.query(
      `INSERT INTO ${s}.behaviour_points (pupil_id,awarded_by_teacher_id,type,category,points,reason,parent_notified)
       VALUES ($1,$2,$3,$4,$5,$6,false) RETURNING *`,
      [pupil_id, awarded_by_teacher_id || 1, type || 'positive', category, points || 1, reason || null]
    );
    if ((type || 'positive') === 'positive') {
      await pool.query(
        `UPDATE ${s}.houses h SET points_total=points_total+$1
         FROM ${s}.pupil_house ph WHERE ph.pupil_id=$2 AND ph.house_id=h.id`,
        [points || 1, pupil_id]
      );
    }

    // Instant notification trigger if mode=instant
    try {
      const { rows: modeRows } = await pool.query(
        `SELECT value FROM ${s}.wren_settings WHERE key='behaviour_notification_mode'`
      );
      const mode = modeRows.length ? modeRows[0].value : {};
      if (mode.mode === 'instant' && mode.enabled && process.env.BEHAVIOUR_NOTIFY_WEBHOOK) {
        const pupilRow = await pool.query(
          `SELECT CONCAT(first_name,' ',last_name) AS name, parent_1_email FROM ${s}.children WHERE id=$1`,
          [pupil_id]
        );
        const payload = JSON.stringify({ trigger: 'instant', point: rows[0], pupil: pupilRow.rows[0] });
        const url = new URL(process.env.BEHAVIOUR_NOTIFY_WEBHOOK);
        const lib = url.protocol === 'https:' ? https : require('http');
        lib.request({ hostname: url.hostname, port: url.port||443, path: url.pathname, method: 'POST',
          headers: {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}
        }, r => r.resume()).on('error',()=>{}).end(payload);
      }
    } catch (_) {}

    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
