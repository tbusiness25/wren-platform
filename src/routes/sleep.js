const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /today — all sleep checks for today
router.get('/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sc.*, c.first_name, c.last_name, c.room_id,
             s.first_name || ' ' || s.last_name as staff_name
      FROM sleep_checks sc
      JOIN children c ON c.id = sc.child_id
      LEFT JOIN staff s ON s.id = sc.staff_id
      WHERE sc.check_time >= CURRENT_DATE
      ORDER BY sc.check_time DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/today
router.get('/child/:childId/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sc.*, s.first_name || ' ' || s.last_name as staff_name
      FROM sleep_checks sc
      LEFT JOIN staff s ON s.id = sc.staff_id
      WHERE sc.child_id=$1 AND sc.check_time >= CURRENT_DATE
      ORDER BY sc.check_time
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST / — record sleep check
router.post('/', async (req, res) => {
  const { child_id, is_sleeping, position, notes } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO sleep_checks (child_id, staff_id, is_sleeping, position, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [child_id, req.user.id, is_sleeping !== false, position, notes]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
