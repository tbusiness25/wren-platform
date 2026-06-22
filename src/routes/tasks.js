const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// GET /api/tasks/summary
router.get('/summary', async (req, res) => {
  const db = getPool();
  try {
    const today = new Date().toISOString().split('T')[0];
    const { rows: overdue } = await db.query(
      `SELECT t.id, t.title, t.due_date, t.priority,
              s.first_name || ' ' || s.last_name AS owner_name
       FROM tasks t LEFT JOIN staff s ON s.id = t.owner_staff_id
       WHERE t.status IN ('open','in_progress') AND t.due_date < $1
       ORDER BY t.due_date ASC LIMIT 3`,
      [today]
    );
    const { rows: todayTasks } = await db.query(
      `SELECT t.id, t.title, t.due_date, t.priority,
              s.first_name || ' ' || s.last_name AS owner_name
       FROM tasks t LEFT JOIN staff s ON s.id = t.owner_staff_id
       WHERE t.status IN ('open','in_progress') AND t.due_date = $1
       ORDER BY t.priority DESC LIMIT 3`,
      [today]
    );
    const { rows: countRow } = await db.query(
      `SELECT COUNT(*) AS total FROM tasks WHERE status IN ('open','in_progress')`
    );
    res.json({ overdue, today: todayTasks, total_open: parseInt(countRow[0].total) });
  } catch (err) {
    console.error('tasks summary error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/tasks
router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const { status, owner } = req.query;
    let q = `SELECT t.*, s.first_name || ' ' || s.last_name AS owner_name
             FROM tasks t LEFT JOIN staff s ON s.id = t.owner_staff_id WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND t.status = $${params.length}`; }
    if (owner)  { params.push(parseInt(owner)); q += ` AND t.owner_staff_id = $${params.length}`; }
    q += ' ORDER BY t.due_date ASC NULLS LAST, t.priority DESC, t.created_at DESC';
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (err) {
    console.error('tasks GET error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/tasks
router.post('/', async (req, res) => {
  const { title, description, status, priority, due_date, owner_staff_id,
          source, source_ref, linked_to, linked_id, time_of_day } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `INSERT INTO tasks (title, description, status, priority, due_date,
         owner_staff_id, created_by, source, source_ref, linked_to, linked_id,
         time_of_day)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [title, description || null, status || 'open', priority || 'medium',
       due_date || null, owner_staff_id || null, req.user.id,
       source || 'manual', source_ref || null, linked_to || null, linked_id || null,
       time_of_day || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('tasks POST error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// PUT /api/tasks/:id
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const allowed = ['title','description','status','priority','due_date',
                 'owner_staff_id','source','source_ref','linked_to','linked_id',
                 'time_of_day'];
  const updates = [];
  const vals = [];
  for (const f of allowed) {
    if (req.body[f] !== undefined) {
      vals.push(req.body[f]);
      updates.push(`${f} = $${vals.length}`);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  vals.push(new Date().toISOString());
  updates.push(`updated_at = $${vals.length}`);
  if (req.body.status === 'done') {
    vals.push(new Date().toISOString());
    updates.push(`completed_at = $${vals.length}`);
  }
  vals.push(id);
  const db = getPool();
  try {
    const { rows } = await db.query(
      `UPDATE tasks SET ${updates.join(', ')} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('tasks PUT error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// DELETE /api/tasks/:id
router.delete('/:id', async (req, res) => {
  const db = getPool();
  try {
    await db.query('DELETE FROM tasks WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('tasks DELETE error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

module.exports = router;
