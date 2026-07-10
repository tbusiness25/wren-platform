const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /child/:childId
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT fw.*, s.first_name || ' ' || s.last_name as observed_by_name
      FROM first_words fw
      LEFT JOIN staff s ON s.id = fw.observed_by
      WHERE fw.child_id=$1
      ORDER BY fw.date_observed ASC, fw.id ASC
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET / — all first words for staff's room (baby room only)
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT fw.*, c.first_name || ' ' || c.last_name as child_name,
        c.room_id, s.first_name || ' ' || s.last_name as observed_by_name
      FROM first_words fw
      JOIN children c ON c.id = fw.child_id
      LEFT JOIN staff s ON s.id = fw.observed_by
      WHERE c.room_id = 1  -- Baby Room
      ORDER BY c.first_name, c.last_name, fw.date_observed
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /
router.post('/', async (req, res) => {
  const { child_id, word, date_observed, context, photo_url, audio_url, shared_with_parents } = req.body;
  if (!child_id || !word) return res.status(400).json({ error: 'child_id and word required' });
  try {
    const db = getPool();
    // Check for duplicate word
    const { rows: existing } = await db.query(
      'SELECT id FROM first_words WHERE child_id=$1 AND LOWER(word)=LOWER($2)', [child_id, word]
    );
    if (existing.length) return res.status(409).json({ error: 'Word already recorded for this child' });
    const { rows } = await db.query(`
      INSERT INTO first_words (child_id, word, date_observed, context, observed_by, photo_url, audio_url, shared_with_parents)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [child_id, word.trim(), date_observed||new Date().toISOString().split('T')[0],
        context||null, req.user.id, photo_url||null, audio_url||null,
        shared_with_parents !== false]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const { context, photo_url, audio_url, shared_with_parents } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE first_words SET
        context=COALESCE($1,context), photo_url=COALESCE($2,photo_url),
        audio_url=COALESCE($3,audio_url), shared_with_parents=COALESCE($4,shared_with_parents)
      WHERE id=$5 RETURNING *
    `, [context, photo_url, audio_url, shared_with_parents, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const db = getPool();
    await db.query('DELETE FROM first_words WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
