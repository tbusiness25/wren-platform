'use strict';
const express  = require('express');
const router   = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET / — list entries for a child or all recent
router.get('/', async (req, res) => {
  const { child_id, limit = 100 } = req.query;
  try {
    const db = getPool();
    const params = child_id ? [child_id, limit] : [limit];
    const { rows } = await db.query(`
      SELECT mb.*,
             c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as added_by_name
      FROM memory_box_entries mb
      LEFT JOIN children c ON c.id = mb.child_id
      LEFT JOIN staff s ON s.id = mb.added_by
      ${child_id ? 'WHERE mb.child_id=$1' : ''}
      ORDER BY mb.happened_on DESC, mb.created_at DESC
      LIMIT ${child_id ? '$2' : '$1'}
    `, params);
    res.json({ entries: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /recent — last 20 entries across all children (admin overview)
router.get('/recent', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT mb.*,
             c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as added_by_name
      FROM memory_box_entries mb
      LEFT JOIN children c ON c.id = mb.child_id
      LEFT JOIN staff s ON s.id = mb.added_by
      ORDER BY mb.created_at DESC LIMIT 20
    `);
    res.json({ entries: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST / — create entry
router.post('/', async (req, res) => {
  const { child_id, title, description, happened_on, milestone_type, is_shared_with_parent = true } = req.body;
  if (!child_id || !title || !happened_on) {
    return res.status(400).json({ error: 'child_id, title and happened_on required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO memory_box_entries
        (child_id, title, description, happened_on, milestone_type, added_by, is_shared_with_parent)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *
    `, [child_id, title, description || null, happened_on, milestone_type || null, req.user.id, is_shared_with_parent]);
    res.json({ entry: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id — update entry
router.put('/:id', async (req, res) => {
  const { title, description, happened_on, milestone_type, is_shared_with_parent } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE memory_box_entries
      SET title=$1, description=$2, happened_on=$3, milestone_type=$4,
          is_shared_with_parent=$5
      WHERE id=$6 RETURNING *
    `, [title, description || null, happened_on, milestone_type || null,
        is_shared_with_parent !== undefined ? is_shared_with_parent : true,
        req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ entry: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`DELETE FROM memory_box_entries WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /parent/:child_id — parent-scoped read only (shared entries only)
router.get('/parent/:child_id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT mb.id, mb.title, mb.description, mb.happened_on, mb.milestone_type, mb.created_at,
             s.first_name || ' ' || s.last_name as added_by_name
      FROM memory_box_entries mb
      LEFT JOIN staff s ON s.id = mb.added_by
      WHERE mb.child_id=$1 AND mb.is_shared_with_parent=true
      ORDER BY mb.happened_on DESC, mb.created_at DESC
    `, [req.params.child_id]);
    res.json({ entries: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
