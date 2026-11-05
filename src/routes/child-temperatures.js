const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// Self-healing additive migration (item 9, 2026-07-29): temperature entries need
// to record parent verbal consent + whether Calpol was given, matching the EyLog
// practitioner flow. Runs once, lazily, on first request so pool ordering is safe.
// Additive only — existing callers (admin child-profile) are unaffected.
let _schemaReady = null;
function ensureSchema() {
  if (_schemaReady) return _schemaReady;
  const db = getPool();
  _schemaReady = Promise.all([
    db.query(`ALTER TABLE child_temperatures ADD COLUMN IF NOT EXISTS consent_verbal boolean DEFAULT false`),
    db.query(`ALTER TABLE child_temperatures ADD COLUMN IF NOT EXISTS calpol_given   boolean DEFAULT false`),
  ]).catch(e => { _schemaReady = null; throw e; });
  return _schemaReady;
}

// POST / — record a temperature
router.post('/', async (req, res) => {
  const { child_id, temperature, method, notes,
          taken_at, consent_verbal, calpol_given } = req.body;
  if (!child_id || !temperature) {
    return res.status(400).json({ error: 'child_id and temperature required' });
  }

  const temp = parseFloat(temperature);
  if (isNaN(temp) || temp < 30 || temp > 45) {
    return res.status(400).json({ error: 'Temperature must be between 30 and 45°C' });
  }

  // Accept an explicit "time taken" (full ISO timestamp) from the tablet; fall
  // back to now() when omitted (e.g. the admin child-profile caller).
  let when = null;
  if (taken_at) {
    const d = new Date(taken_at);
    if (!isNaN(d.getTime())) when = d.toISOString();
  }

  try {
    await ensureSchema();
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO child_temperatures
        (child_id, temperature, taken_by, method, notes, taken_at, consent_verbal, calpol_given)
      VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7, $8)
      RETURNING *
    `, [child_id, temp, req.user.id, method || null, notes || null,
        when, !!consent_verbal, !!calpol_given]);

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
