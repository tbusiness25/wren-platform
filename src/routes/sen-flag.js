'use strict';
// b120 SEN early-flagging — SENCO/manager-only decision-support suggestions.
// Never diagnosis: every row is a human-reviewed suggestion with cited evidence.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const MGR_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'business_manager']);

// SENCO/manager gate — role check first (cheap), falls back to the staff.is_send_lead
// flag for a non-manager who is nonetheless the tagged SENCO.
async function requireSenco(req, res, next) {
  if (MGR_ROLES.has(req.user.role)) return next();
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT is_send_lead FROM staff WHERE id = $1', [req.user.id]);
    if (rows[0] && rows[0].is_send_lead) return next();
  } catch (e) { return res.status(500).json({ error: e.message }); }
  return res.status(403).json({ error: 'Forbidden — SENCO/manager access only' });
}
router.use(requireSenco);

// GET / — list suggestions, default open ('new') only
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const status = req.query.status || 'new';
    const params = [];
    let where = '';
    if (status !== 'all') { params.push(status); where = `WHERE sfs.status = $${params.length}`; }
    const { rows } = await db.query(`
      SELECT sfs.*, c.first_name || ' ' || c.last_name AS child_name, c.date_of_birth,
        r.name AS room_name, s.first_name || ' ' || s.last_name AS reviewed_by_name
      FROM sen_flag_suggestions sfs
      LEFT JOIN children c ON c.id = sfs.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = sfs.reviewed_by
      ${where}
      ORDER BY sfs.status = 'new' DESC, sfs.created_at DESC
    `, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /count — open-suggestion count (badge)
router.get('/count', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query("SELECT COUNT(*)::int AS count FROM sen_flag_suggestions WHERE status = 'new'");
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id — evidence drill-down
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sfs.*, c.first_name || ' ' || c.last_name AS child_name, c.date_of_birth,
        c.home_language, r.name AS room_name, s.first_name || ' ' || s.last_name AS reviewed_by_name
      FROM sen_flag_suggestions sfs
      LEFT JOIN children c ON c.id = sfs.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = sfs.reviewed_by
      WHERE sfs.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/review — accept (actioned) / dismiss / mark reviewed
router.put('/:id/review', async (req, res) => {
  const { status, review_note } = req.body;
  if (!['reviewed', 'dismissed', 'actioned'].includes(status)) {
    return res.status(400).json({ error: 'status must be reviewed, dismissed or actioned' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE sen_flag_suggestions
      SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW()
      WHERE id = $4 RETURNING *
    `, [status, review_note || null, req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const suggestion = rows[0];

    // Accept → link into the SEN register watchlist flow (only if not already registered).
    if (status === 'actioned') {
      const { rows: existing } = await db.query('SELECT id FROM sen_register WHERE child_id = $1', [suggestion.child_id]);
      if (!existing.length) {
        await db.query(`
          INSERT INTO sen_register (child_id, sen_type, primary_need, created_by)
          VALUES ($1, 'monitoring', $2, $3)
        `, [suggestion.child_id, `AI early-flag (${suggestion.flag_area.replace(/_/g, ' ')}): ${suggestion.summary}`, req.user.id]);
      }
    }
    res.json(suggestion);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
