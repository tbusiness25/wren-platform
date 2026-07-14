'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /api/collectors/:childId — list all authorised collectors for a child
router.get('/:childId', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, child_id, name, relationship, phone, password_word, can_collect, photo_url, notes, created_at
       FROM authorised_collectors
       WHERE child_id=$1
       ORDER BY name`,
      [req.params.childId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/collectors — add a new authorised collector
router.post('/', async (req, res) => {
  const { child_id, name, relationship, phone, password_word, can_collect, photo_url, notes } = req.body;
  if (!child_id || !name) return res.status(400).json({ error: 'child_id and name required' });

  try {
    const { rows } = await getPool().query(
      `INSERT INTO authorised_collectors (child_id, name, relationship, phone, password_word, can_collect, photo_url, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (child_id, name) DO UPDATE
         SET relationship=$3, phone=$4, password_word=$5, can_collect=$6, photo_url=$7, notes=$8
       RETURNING *`,
      [child_id, name, relationship || null, phone || null, password_word || null,
       can_collect !== false, photo_url || null, notes || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/collectors/:id — update an existing collector
router.put('/:id', async (req, res) => {
  const { name, relationship, phone, password_word, can_collect, photo_url, notes } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  try {
    const { rows } = await getPool().query(
      `UPDATE authorised_collectors
       SET name=$1, relationship=$2, phone=$3, password_word=$4, can_collect=$5, photo_url=$6, notes=$7
       WHERE id=$8
       RETURNING *`,
      [name, relationship || null, phone || null, password_word || null,
       can_collect !== false, photo_url || null, notes || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Collector not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/collectors/:id — remove a collector
router.delete('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `DELETE FROM authorised_collectors WHERE id=$1 RETURNING id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Collector not found' });
    res.json({ ok: true, deleted_id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
