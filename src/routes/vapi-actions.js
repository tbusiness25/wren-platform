const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — list pending/in_progress actions, sorted by urgency + recency
router.get('/', async (req, res) => {
  const status = req.query.status || null;
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT id, started_at, ended_at, from_number, to_number,
             summary, action_status, action_summary, action_notes,
             action_completed_at, urgency, outcome, reviewed_by, reviewed_at
      FROM vapi_calls
      WHERE ($1::text IS NULL OR action_status = $1)
        AND (action_status IS NULL OR action_status NOT IN ('archived','no_action_needed') OR $1 IS NOT NULL)
      ORDER BY
        CASE urgency WHEN 'urgent' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        started_at DESC
      LIMIT 100
    `, [status]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id — full detail including transcript
router.get('/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT * FROM vapi_calls WHERE id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id — update action_status or action_notes
router.patch('/:id', async (req, res) => {
  const { action_status, action_notes } = req.body;
  const validStatuses = ['pending','in_progress','done','no_action_needed','archived'];
  if (action_status && !validStatuses.includes(action_status)) {
    return res.status(400).json({ error: 'Invalid action_status' });
  }
  const db = getPool();
  try {
    const completedAt = action_status === 'done' ? 'now()' : 'action_completed_at';
    const { rows } = await db.query(`
      UPDATE vapi_calls SET
        action_status = COALESCE($1, action_status),
        action_notes  = COALESCE($2, action_notes),
        action_completed_at = CASE WHEN $1 = 'done' THEN now() ELSE action_completed_at END,
        reviewed_by   = COALESCE(reviewed_by, $3),
        reviewed_at   = COALESCE(reviewed_at, now())
      WHERE id = $4 RETURNING id, action_status, action_notes, action_completed_at
    `, [action_status||null, action_notes||null, req.user.id, req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/archive
router.post('/:id/archive', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      "UPDATE vapi_calls SET action_status='archived' WHERE id=$1 RETURNING id",
      [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /stats/summary — counts for header badges
router.get('/stats/summary', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE action_status = 'pending' OR action_status IS NULL)    AS pending,
        COUNT(*) FILTER (WHERE action_status = 'in_progress')   AS in_progress,
        COUNT(*) FILTER (WHERE action_status = 'done' AND action_completed_at::date = CURRENT_DATE) AS done_today
      FROM vapi_calls
      WHERE started_at > now() - interval '30 days'
    `);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
