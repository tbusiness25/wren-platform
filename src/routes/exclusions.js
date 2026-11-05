// Secondary school exclusions log
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — list exclusions
router.get('/', async (req, res) => {
  const { child_id, type, from, to, class_group } = req.query;
  try {
    const db = getPool();
    const params = [];
    const conds = [];
    let pi = 1;
    if (child_id) { conds.push('e.child_id=$'+pi++); params.push(parseInt(child_id)); }
    if (type) { conds.push('e.type=$'+pi++); params.push(type); }
    if (from) { conds.push('e.date>=$'+pi++); params.push(from); }
    if (to) { conds.push('e.date<=$'+pi++); params.push(to); }
    if (class_group) { conds.push('c.class_group=$'+pi++); params.push(class_group); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';
    const { rows } = await db.query(`
      SELECT e.*, c.first_name, c.last_name, c.class_group, c.year_group,
             s.first_name||' '||s.last_name as logged_by_name
      FROM exclusions e
      JOIN children c ON c.id=e.child_id
      LEFT JOIN staff s ON s.id=e.logged_by
      ${where}
      ORDER BY e.date DESC
      LIMIT 500
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST / — log exclusion
router.post('/', async (req, res) => {
  const { child_id, date, type, reason, days, reinstatement_date, governors_review, notes } = req.body;
  if (!child_id || !type || !reason) return res.status(400).json({ error: 'child_id, type, reason required' });
  if (!['fixed_term','permanent','lunchtime'].includes(type)) return res.status(400).json({ error: 'invalid type' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO exclusions (child_id, date, type, reason, days, reinstatement_date, governors_review, notes, logged_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [child_id, date||new Date().toISOString().slice(0,10), type, reason, days||1, reinstatement_date||null, governors_review||false, notes||null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /stats — summary per pupil
router.get('/stats', async (req, res) => {
  const { class_group, from } = req.query;
  try {
    const db = getPool();
    const f = from || new Date(new Date().getFullYear(), 8, 1).toISOString().slice(0,10);
    const params = [f];
    let extra = class_group ? ' AND c.class_group=$2' : '';
    if (class_group) params.push(class_group);
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.class_group, c.year_group,
        COUNT(*) FILTER (WHERE e.type='fixed_term') as fixed_term_count,
        COUNT(*) FILTER (WHERE e.type='permanent') as permanent_count,
        COUNT(*) FILTER (WHERE e.type='lunchtime') as lunchtime_count,
        COALESCE(SUM(e.days) FILTER (WHERE e.type='fixed_term'),0) as total_days_excluded
      FROM children c
      LEFT JOIN exclusions e ON e.child_id=c.id AND e.date>=$1
      WHERE c.is_active=true${extra}
      GROUP BY c.id, c.first_name, c.last_name, c.class_group, c.year_group
      HAVING COUNT(e.id) > 0
      ORDER BY total_days_excluded DESC
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
