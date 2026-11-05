// Parent-reported absence / holiday — admin/staff-facing (authed) read surface.
// Parents submit via server-unified.js /welcome/absence/* (CF-Access email scoped),
// which also applies the absence to the register (attendance.absent=true).
// Table: parent_reported_absences.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /api/parent-absence?scope=upcoming|all — reported absences with child names.
router.get('/', async (req, res) => {
  const scope = ['upcoming', 'all', 'current'].includes(req.query.scope) ? req.query.scope : 'upcoming';
  const where = scope === 'upcoming' ? "a.end_date >= CURRENT_DATE AND a.status='reported'"
              : scope === 'current'  ? "CURRENT_DATE BETWEEN a.start_date AND a.end_date AND a.status='reported'"
              : 'TRUE';
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT a.*, c.first_name, c.last_name, rm.name AS room_name
      FROM parent_reported_absences a
      JOIN children c ON c.id = a.child_id
      LEFT JOIN rooms rm ON rm.id = c.room_id
      WHERE ${where}
      ORDER BY a.start_date ASC, a.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/parent-absence/child/:childId — one child's reported absences
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM parent_reported_absences WHERE child_id=$1 ORDER BY start_date DESC`,
      [parseInt(req.params.childId, 10)]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
