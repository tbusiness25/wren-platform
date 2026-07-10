const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — list behaviour log
router.get('/', async (req, res) => {
  const { child_id, behaviour_type, limit = 100 } = req.query;
  try {
    const db = getPool();
    const conditions = [];
    const params = [];
    let pi = 1;
    if (child_id) { conditions.push(`b.child_id=$${pi++}`); params.push(parseInt(child_id)); }
    if (behaviour_type) { conditions.push(`b.behaviour_type=$${pi++}`); params.push(behaviour_type); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT b.*, c.first_name || ' ' || c.last_name as child_name,
        s.first_name || ' ' || s.last_name as staff_name
      FROM behaviour_log b
      LEFT JOIN children c ON c.id = b.child_id
      LEFT JOIN staff s ON s.id = b.staff_id
      ${where}
      ORDER BY b.log_date DESC, b.created_at DESC
      LIMIT $${pi}
    `, [...params, parseInt(limit)]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /points/:childId — points balance
router.get('/points/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT
        COALESCE(SUM(CASE WHEN behaviour_type='positive' THEN points ELSE 0 END),0) as positive_points,
        COALESCE(SUM(CASE WHEN behaviour_type='negative' THEN ABS(points) ELSE 0 END),0) as negative_points,
        COALESCE(SUM(points),0) as balance,
        COUNT(*) FILTER (WHERE behaviour_type='positive') as positive_count,
        COUNT(*) FILTER (WHERE behaviour_type='negative') as negative_count
      FROM behaviour_log
      WHERE child_id=$1
    `, [req.params.childId]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /
router.post('/', async (req, res) => {
  const { child_id, behaviour_type, category, description, points, parent_notified, log_date } = req.body;
  if (!child_id || !behaviour_type || !description) {
    return res.status(400).json({ error: 'child_id, behaviour_type and description required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO behaviour_log (child_id,staff_id,log_date,behaviour_type,category,description,points,parent_notified)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [child_id, req.user.id, log_date||new Date().toISOString().split('T')[0],
        behaviour_type, category||null, description,
        behaviour_type==='negative' ? -(Math.abs(points||1)) : Math.abs(points||1),
        parent_notified||false]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
