const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

async function ensureTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS primary_action_plans (
      id           SERIAL PRIMARY KEY,
      child_id     INTEGER REFERENCES children(id) ON DELETE CASCADE,
      staff_id     INTEGER,
      focus        TEXT NOT NULL,
      targets      JSONB NOT NULL DEFAULT '[]',
      rag          CHAR(1) NOT NULL DEFAULT 'A',
      status       TEXT NOT NULL DEFAULT 'active',
      start_date   DATE,
      review_date  DATE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// GET /
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    await ensureTable(db);
    const { child_id, status } = req.query;
    let where = 'WHERE 1=1';
    const vals = [];
    if (child_id) { vals.push(child_id); where += ` AND ap.child_id=$${vals.length}`; }
    if (status)   { vals.push(status);   where += ` AND ap.status=$${vals.length}`; }
    const { rows } = await db.query(`
      SELECT ap.*, c.first_name || ' ' || c.last_name AS child_name,
             c.year_group, c.class_group
      FROM primary_action_plans ap
      LEFT JOIN children c ON c.id = ap.child_id
      ${where}
      ORDER BY ap.created_at DESC
    `, vals);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT ap.*, c.first_name || ' ' || c.last_name AS child_name
       FROM primary_action_plans ap LEFT JOIN children c ON c.id=ap.child_id
       WHERE ap.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /
router.post('/', async (req, res) => {
  const { child_id, focus, targets, rag, status, start_date, review_date } = req.body;
  if (!child_id || !focus) return res.status(400).json({ error: 'child_id and focus required' });
  try {
    const db = getPool();
    await ensureTable(db);
    const { rows } = await db.query(`
      INSERT INTO primary_action_plans (child_id, staff_id, focus, targets, rag, status, start_date, review_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [child_id, req.user.id, focus, JSON.stringify(targets||[]), rag||'A', status||'active',
        start_date||null, review_date||null]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id
router.patch('/:id', async (req, res) => {
  const allowed = ['focus','targets','rag','status','start_date','review_date'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (req.body[k] !== undefined) {
      vals.push(k === 'targets' ? JSON.stringify(req.body[k]) : req.body[k]);
      sets.push(`${k}=$${vals.length}`);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  vals.push(req.params.id);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE primary_action_plans SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,
      vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const db = getPool();
    await db.query('DELETE FROM primary_action_plans WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
