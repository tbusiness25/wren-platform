const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /today — all sleep checks for today (optionally filtered by child_id)
router.get('/today', async (req, res) => {
  try {
    const db = getPool();
    const { child_id } = req.query;
    let query = `
      SELECT sc.*, c.first_name, c.last_name, c.room_id,
             s.first_name || ' ' || s.last_name as staff_name
      FROM sleep_checks sc
      JOIN children c ON c.id = sc.child_id
      LEFT JOIN staff s ON s.id = sc.staff_id
      WHERE (sc.check_time >= CURRENT_DATE OR sc.checked_at >= CURRENT_DATE)
    `;
    const params = [];
    if (child_id) {
      params.push(child_id);
      query += ` AND sc.child_id = $1`;
    }
    query += ` ORDER BY COALESCE(sc.checked_at, sc.check_time) DESC`;
    const { rows } = await db.query(query, params);
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

// POST /check — record sleep check (new endpoint with full fields)
router.post('/check', async (req, res) => {
  const { child_id, position, breathing_ok, notes, photo_url } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    // Get staff initial from first name
    const staffResult = await db.query(
      `SELECT first_name, last_name FROM staff WHERE id=$1`,
      [req.user.id]
    );
    const staff_initial = staffResult.rows[0]?.first_name?.[0]?.toUpperCase() || 'X';

    const { rows } = await db.query(`
      INSERT INTO sleep_checks (
        child_id, staff_id, staff_initial, checked_at,
        position, breathing_ok, notes, photo_url, is_sleeping
      )
      VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, true)
      RETURNING *
    `, [child_id, req.user.id, staff_initial, position, breathing_ok, notes, photo_url]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST / — record sleep check (legacy endpoint, kept for compatibility)
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
