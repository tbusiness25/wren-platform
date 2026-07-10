const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager'];

// Submit a wellbeing check-in
router.post('/checkin', async (req, res) => {
  const db = getPool();
  const { mood_score, workload_score, supported_score, notes, is_concern } = req.body;
  if (!mood_score || !workload_score || !supported_score) {
    return res.status(400).json({ error: 'mood_score, workload_score, supported_score required' });
  }
  try {
    const { rows } = await db.query(`
      INSERT INTO wellbeing_checkins
        (staff_id, mood_score, workload_score, supported_score, notes, is_concern)
      VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [req.user.id, mood_score, workload_score, supported_score, notes || null, is_concern || false]);
    res.status(201).json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// My check-in history (last 12 months)
router.get('/my', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT * FROM wellbeing_checkins
      WHERE staff_id = $1
        AND checked_in_at > NOW() - INTERVAL '12 months'
      ORDER BY checked_in_at DESC`,
      [req.user.id]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Date of last check-in (to surface "due" prompts)
router.get('/my/last', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT checked_in_at FROM wellbeing_checkins
      WHERE staff_id = $1
      ORDER BY checked_in_at DESC LIMIT 1`,
      [req.user.id]);
    res.json({ last_checkin: rows[0]?.checked_in_at || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: latest check-in per active staff member
router.get('/all', async (req, res) => {
  if (!MANAGER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.role,
        w.mood_score, w.workload_score, w.supported_score,
        w.is_concern, w.checked_in_at
      FROM staff s
      LEFT JOIN LATERAL (
        SELECT * FROM wellbeing_checkins ww
        WHERE ww.staff_id = s.id
        ORDER BY ww.checked_in_at DESC LIMIT 1
      ) w ON true
      WHERE s.is_active = true
      ORDER BY s.first_name, s.last_name`);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manager: full history for one staff member
router.get('/staff/:staffId', async (req, res) => {
  if (!MANAGER_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT * FROM wellbeing_checkins
      WHERE staff_id = $1
      ORDER BY checked_in_at DESC`,
      [req.params.staffId]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
