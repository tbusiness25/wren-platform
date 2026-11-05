// Primary/Secondary behaviour log
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — behaviour log
router.get('/', async (req, res) => {
  const { child_id, class_group, type, from, to } = req.query;
  try {
    const db = getPool();
    const params = [];
    const conds = [];
    let pi = 1;
    if (child_id) { conds.push('b.child_id=$'+pi++); params.push(parseInt(child_id)); }
    if (type) { conds.push('b.type=$'+pi++); params.push(type); }
    if (from) { conds.push('b.date>=$'+pi++); params.push(from); }
    if (to) { conds.push('b.date<=$'+pi++); params.push(to); }
    if (class_group) { conds.push('c.class_group=$'+pi++); params.push(class_group); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT b.*, c.first_name, c.last_name, c.class_group, c.year_group,
             s.first_name||' '||s.last_name as logged_by_name
      FROM behaviour_log_primary b
      JOIN children c ON c.id=b.child_id
      LEFT JOIN staff s ON s.id=b.logged_by
      ${where}
      ORDER BY b.date DESC, b.created_at DESC
      LIMIT 500
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST / — log behaviour entry
router.post('/', async (req, res) => {
  const { child_id, date, type, category, description, action_taken, parent_notified } = req.body;
  if (!child_id || !type || !description) return res.status(400).json({ error: 'child_id, type, description required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO behaviour_log_primary (child_id, date, type, category, description, action_taken, parent_notified, logged_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [child_id, date || new Date().toISOString().slice(0,10), type, category||null, description, action_taken||null, parent_notified||false, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /summary — aggregate counts for admin dashboard
router.get('/summary', async (req, res) => {
  try {
    const db = getPool();
    const now = new Date();
    const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
    const f = `${startYear}-09-01`;
    const { rows } = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE type='positive') as positive,
        COUNT(*) FILTER (WHERE type='negative') as negative,
        COUNT(DISTINCT child_id) as pupils_involved
      FROM behaviour_log_primary
      WHERE date >= $1
    `, [f]);
    res.json(rows[0] || { total:0, positive:0, negative:0, pupils_involved:0 });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /stats — summary stats per pupil
router.get('/stats', async (req, res) => {
  const { class_group, from } = req.query;
  try {
    const db = getPool();
    const now2 = new Date();
    const sy2 = now2.getMonth() >= 8 ? now2.getFullYear() : now2.getFullYear() - 1;
    const f = from || `${sy2}-09-01`;
    const params = [f];
    let extraWhere = class_group ? ' AND c.class_group=$2' : '';
    if (class_group) params.push(class_group);
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.class_group, c.year_group,
        COUNT(*) FILTER (WHERE b.type='positive') as positive_count,
        COUNT(*) FILTER (WHERE b.type='negative') as negative_count
      FROM children c
      LEFT JOIN behaviour_log_primary b ON b.child_id=c.id AND b.date>=$1
      WHERE c.is_active=true${extraWhere}
      GROUP BY c.id, c.first_name, c.last_name, c.class_group, c.year_group
      ORDER BY negative_count DESC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
