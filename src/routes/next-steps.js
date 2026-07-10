'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const NS_SELECT = `
  SELECT ns.*,
    c.first_name || ' ' || c.last_name AS child_name,
    c.first_name AS child_first_name,
    r.name AS room_name,
    s.first_name || ' ' || s.last_name AS staff_name,
    o.observation_text AS source_obs_text,
    o.created_at AS source_obs_date,
    fs.statement_text AS framework_statement_text,
    fs.area AS framework_area,
    pa.plan_date AS planned_date,
    pa.slot AS planned_slot
  FROM next_steps ns
  JOIN children c ON c.id = ns.child_id
  LEFT JOIN rooms r ON r.id = c.room_id
  LEFT JOIN staff s ON s.id = ns.staff_id
  LEFT JOIN observations o ON o.id = ns.observation_id
  LEFT JOIN framework_statements fs ON fs.id = ns.framework_statement_id
  LEFT JOIN planned_activities pa ON pa.id = ns.planned_activity_id
`;

// GET / — list with optional child, status, room filters
router.get('/', async (req, res) => {
  const { child_id, status, room_id, limit = 100 } = req.query;
  const db = getPool();
  let sql = NS_SELECT + ' WHERE 1=1';
  const params = [];
  if (child_id) { params.push(child_id);  sql += ` AND ns.child_id=$${params.length}`; }
  if (status)   { params.push(status);    sql += ` AND ns.status=$${params.length}`; }
  if (room_id)  { params.push(room_id);   sql += ` AND r.id=$${params.length}`; }
  params.push(Math.min(parseInt(limit) || 100, 500));
  sql += ` ORDER BY ns.created_at DESC LIMIT $${params.length}`;
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /by-child/:child_id — all next steps for a child, grouped by status
router.get('/by-child/:child_id', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      NS_SELECT + ' WHERE ns.child_id=$1 ORDER BY ns.status, ns.created_at DESC',
      [req.params.child_id]
    );
    const grouped = { pending: [], planned: [], completed: [], cancelled: [] };
    rows.forEach(r => { (grouped[r.status] || grouped.pending).push(r); });
    res.json(grouped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(NS_SELECT + ' WHERE ns.id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id — update status, framework link, due date
router.patch('/:id', async (req, res) => {
  const { status, framework_statement_id, due_by, description } = req.body;
  const VALID = new Set(['pending','planned','completed','cancelled']);
  if (status && !VALID.has(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const { rows } = await getPool().query(`
      UPDATE next_steps SET
        status                 = COALESCE($1, status),
        framework_statement_id = COALESCE($2, framework_statement_id),
        due_by                 = COALESCE($3::date, due_by),
        description            = COALESCE($4, description),
        updated_at             = NOW()
      WHERE id=$5
      RETURNING *
    `, [status || null, framework_statement_id || null,
        due_by || null, description || null,
        req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/promote-to-activity — convert next_step → planned_activity (scope=individual)
router.post('/:id/promote-to-activity', async (req, res) => {
  const { plan_date, slot, led_by } = req.body;
  const db = getPool();
  try {
    const { rows: nsRows } = await db.query('SELECT * FROM next_steps WHERE id=$1', [req.params.id]);
    if (!nsRows.length) return res.status(404).json({ error: 'Next step not found' });
    const ns = nsRows[0];
    if (ns.status === 'completed' || ns.status === 'cancelled')
      return res.status(400).json({ error: `Cannot promote a ${ns.status} next step` });

    const { rows: paRows } = await db.query(`
      INSERT INTO planned_activities
        (child_id, next_step_id, source_observation_id, scope, plan_date, slot, led_by,
         title, description, status, created_at)
      VALUES ($1, $2, $3, 'individual', $4, $5, $6, $7, $8, 'planned', NOW())
      RETURNING *
    `, [ns.child_id, ns.id, ns.observation_id,
        plan_date || null, slot || null, led_by || req.user.id,
        ns.description,
        `Individual activity from next step: ${ns.description.slice(0, 100)}`]);

    const pa = paRows[0];

    // Link back to next_step and mark as planned
    await db.query(`
      UPDATE next_steps
        SET status='planned', planned_activity_id=$1, updated_at=NOW()
      WHERE id=$2
    `, [pa.id, ns.id]);

    res.status(201).json({ planned_activity: pa, next_step_id: ns.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/mark-completed — link to an observation that evidences completion
router.post('/:id/mark-completed', async (req, res) => {
  const { completed_observation_id } = req.body;
  try {
    const { rows } = await getPool().query(`
      UPDATE next_steps
        SET status='completed',
            completed_observation_id=$1,
            updated_at=NOW()
      WHERE id=$2
      RETURNING *
    `, [completed_observation_id || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
