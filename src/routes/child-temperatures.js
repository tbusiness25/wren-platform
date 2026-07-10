const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// POST / — record a temperature
router.post('/', async (req, res) => {
  const { child_id, temperature, method, notes } = req.body;
  if (!child_id || !temperature) {
    return res.status(400).json({ error: 'child_id and temperature required' });
  }

  const temp = parseFloat(temperature);
  if (isNaN(temp) || temp < 30 || temp > 45) {
    return res.status(400).json({ error: 'Temperature must be between 30 and 45°C' });
  }

  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO child_temperatures (child_id, temperature, taken_by, method, notes)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `, [child_id, temp, req.user.id, method || null, notes || null]);

    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId — history for a child, newest first
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT t.*, s.first_name || ' ' || s.last_name as staff_name
      FROM child_temperatures t
      LEFT JOIN staff s ON s.id = t.taken_by
      WHERE t.child_id = $1
      ORDER BY t.taken_at DESC
      LIMIT 100
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
