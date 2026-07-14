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

// GET /suggestions/:child_id — framework-gap next-step suggestions for a child.
// LADN assesses by COVERAGE: framework_tracker holds only 'observed' statements, so a
// GAP is a Development Matters (birth_to_5_la) statement at the child's working level
// that has NO tracker row yet. We surface the under-evidenced AREAS + sample statements
// so a practitioner can turn a real curriculum gap into a tracked next step.
const PRIMARY_FW = 'birth_to_5_la';
router.get('/suggestions/:child_id', async (req, res) => {
  const db = getPool();
  const childId = parseInt(req.params.child_id);
  if (!childId) return res.status(400).json({ error: 'Invalid child_id' });
  try {
    const { rows: cRows } = await db.query(
      "SELECT id, first_name || ' ' || last_name AS name FROM children WHERE id=$1", [childId]);
    if (!cRows.length) return res.status(404).json({ error: 'Child not found' });

    // Leading level = highest 'Range N' band the child has been observed in, plus its label.
    const { rows: lead } = await db.query(`
      SELECT MAX((substring(age_range from 'Range ([0-9]+)'))::int) AS lvl,
             (array_agg(age_range ORDER BY (substring(age_range from 'Range ([0-9]+)'))::int DESC))[1] AS band
      FROM framework_tracker
      WHERE child_id=$1 AND framework=$2 AND age_range ~ 'Range [0-9]+'`, [childId, PRIMARY_FW]);
    const lvl = lead[0] && lead[0].lvl;

    if (!lvl) {
      return res.json({ child_id: childId, child_name: cRows[0].name,
        has_assessment: false, leading_range: null, leading_band: null,
        total_gaps: 0, areas: [],
        message: 'Not enough framework-tracker data yet to suggest gaps for this child.' });
    }

    // Gaps at the leading band (+ one below, for consolidation), excluding statements
    // already observed OR already captured as an open next step for this child.
    const { rows: areas } = await db.query(`
      WITH gaps AS (
        SELECT fs.id, fs.area, fs.age_range, fs.statement_text,
               (substring(fs.age_range from 'Range ([0-9]+)'))::int AS rng
        FROM framework_statements fs
        WHERE fs.framework=$2
          AND fs.age_range ~ 'Range [0-9]+'
          AND (substring(fs.age_range from 'Range ([0-9]+)'))::int BETWEEN GREATEST($3::int-1,1) AND $3::int
          AND fs.id NOT IN (SELECT statement_id FROM framework_tracker
                            WHERE child_id=$1 AND framework=$2 AND statement_id IS NOT NULL)
          AND fs.id NOT IN (SELECT framework_statement_id FROM next_steps
                            WHERE child_id=$1 AND framework_statement_id IS NOT NULL
                              AND status IN ('pending','planned'))
      )
      SELECT area,
             count(*)::int AS gap_count,
             (array_agg(json_build_object('statement_id', id, 'text', statement_text,
                        'age_range', age_range) ORDER BY rng DESC, id))[1:3] AS samples
      FROM gaps GROUP BY area
      ORDER BY gap_count DESC, area`, [childId, PRIMARY_FW, lvl]);

    const total = areas.reduce((s, a) => s + a.gap_count, 0);
    res.json({ child_id: childId, child_name: cRows[0].name, has_assessment: true,
      leading_range: lvl, leading_band: lead[0].band, total_gaps: total, areas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /from-statement — turn a framework gap into a tracked (pending) next step.
router.post('/from-statement', async (req, res) => {
  const { child_id, statement_id, due_by } = req.body;
  if (!child_id || !statement_id)
    return res.status(400).json({ error: 'child_id and statement_id required' });
  const db = getPool();
  try {
    const { rows: st } = await db.query(
      'SELECT id, statement_text, area FROM framework_statements WHERE id=$1', [statement_id]);
    if (!st.length) return res.status(404).json({ error: 'Framework statement not found' });
    // Don't create a duplicate open next step for the same child + statement.
    const { rows: dup } = await db.query(
      "SELECT id FROM next_steps WHERE child_id=$1 AND framework_statement_id=$2 AND status IN ('pending','planned') LIMIT 1",
      [child_id, statement_id]);
    if (dup.length) return res.json({ id: dup[0].id, duplicate: true });
    const desc = `${st[0].area}: ${st[0].statement_text}`;
    const { rows } = await db.query(`
      INSERT INTO next_steps (child_id, staff_id, framework_statement_id, description, status, due_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, 'pending', $5::date, NOW(), NOW()) RETURNING *`,
      [child_id, req.user.id, statement_id, desc, due_by || null]);
    res.status(201).json(rows[0]);
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
