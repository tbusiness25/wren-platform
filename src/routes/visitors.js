const express = require('express');
const router  = express.Router();
const pool    = require('../db/pool').getPool();
const authenticate = require('../middleware/auth');

// Staff-only gate middleware
router.use(authenticate);
router.use((req, res, next) => {
  if (req.user.role === 'parent') {
    return res.status(403).json({ error: 'Staff access required' });
  }
  next();
});

// POST / — sign a visitor in
router.post('/', async (req, res) => {
  try {
    const {
      name,
      organisation,
      purpose,
      visiting_whom,
      dbs_seen,
      id_seen,
      car_reg,
      notes
    } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Visitor name is required' });
    }

    const result = await pool.query(`
      INSERT INTO ladn.visitor_log (
        name, organisation, purpose, visiting_whom,
        dbs_seen, id_seen, car_reg, notes, signed_in_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [
      name,
      organisation || null,
      purpose || null,
      visiting_whom || null,
      !!dbs_seen,
      !!id_seen,
      car_reg || null,
      notes || null,
      req.user.id
    ]);

    res.json({ visitor: result.rows[0] });
  } catch (err) {
    console.error('Error signing in visitor:', err);
    res.status(500).json({ error: 'Failed to sign in visitor' });
  }
});

// POST /:id/sign-out — sign a visitor out
router.post('/:id/sign-out', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await pool.query(`
      UPDATE ladn.visitor_log
      SET left_at = now()
      WHERE id = $1 AND left_at IS NULL
      RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Visitor not found or already signed out' });
    }

    res.json({ visitor: result.rows[0] });
  } catch (err) {
    console.error('Error signing out visitor:', err);
    res.status(500).json({ error: 'Failed to sign out visitor' });
  }
});

// GET /today — today's visitors
router.get('/today', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        v.*,
        s.first_name || ' ' || s.last_name AS signed_in_by_name
      FROM ladn.visitor_log v
      LEFT JOIN ladn.staff s ON v.signed_in_by = s.id
      WHERE DATE(v.arrived_at) = CURRENT_DATE
      ORDER BY v.arrived_at DESC
    `);

    res.json({ visitors: result.rows });
  } catch (err) {
    console.error('Error fetching today\'s visitors:', err);
    res.status(500).json({ error: 'Failed to fetch visitors' });
  }
});

// GET / — history with date range
router.get('/', async (req, res) => {
  try {
    const { from, to } = req.query;

    let query = `
      SELECT
        v.*,
        s.first_name || ' ' || s.last_name AS signed_in_by_name
      FROM ladn.visitor_log v
      LEFT JOIN ladn.staff s ON v.signed_in_by = s.id
      WHERE 1=1
    `;
    const params = [];

    if (from) {
      params.push(from);
      query += ` AND DATE(v.arrived_at) >= $${params.length}`;
    }

    if (to) {
      params.push(to);
      query += ` AND DATE(v.arrived_at) <= $${params.length}`;
    }

    query += ` ORDER BY v.arrived_at DESC LIMIT 200`;

    const result = await pool.query(query, params);

    res.json({ visitors: result.rows });
  } catch (err) {
    console.error('Error fetching visitor history:', err);
    res.status(500).json({ error: 'Failed to fetch visitor history' });
  }
});

module.exports = router;
