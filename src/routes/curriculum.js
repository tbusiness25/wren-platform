const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

router.get('/plans', async (req, res) => {
  const { room_id, term } = req.query;
  try {
    const db = getPool();
    const params = [];
    let where = 'WHERE 1=1';
    if (room_id) { params.push(room_id); where += ` AND cp.room_id=$${params.length}`; }
    if (term) { params.push(term); where += ` AND cp.term=$${params.length}`; }
    const { rows } = await db.query(`
      SELECT cp.*, r.name as room_name,
             s.first_name || ' ' || s.last_name as staff_name
      FROM curriculum_plans cp
      LEFT JOIN rooms r ON r.id = cp.room_id
      LEFT JOIN staff s ON s.id = cp.staff_id
      ${where}
      ORDER BY cp.week_start DESC LIMIT 50
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/plans', async (req, res) => {
  const { room_id, title, term, week_number, week_start } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO curriculum_plans (room_id, staff_id, title, term, week_number, week_start)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [room_id, req.user.id, title, term, week_number, week_start]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/plans/:id', async (req, res) => {
  const { title, term, week_number, week_start, status } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE curriculum_plans
      SET title=COALESCE($1,title), term=COALESCE($2,term),
          week_number=COALESCE($3,week_number), week_start=COALESCE($4,week_start),
          status=COALESCE($5,status)
      WHERE id=$6 RETURNING *
    `, [title, term, week_number, week_start, status, req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/plans/:id/publish', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE curriculum_plans SET status='published', published_at=NOW()
      WHERE id=$1 RETURNING *
    `, [req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Activity bank ───────────────────────────────────────────────────────────

// GET /api/curriculum/activities — activity library
router.get('/activities', async (req, res) => {
  try {
    const { category, eyfs_area, age_range, search } = req.query;
    let q = 'SELECT * FROM curriculum_activities WHERE 1=1';
    const params = [];
    if (category) { params.push(category); q += ` AND category=$${params.length}`; }
    if (age_range && age_range !== 'all') { params.push(age_range); q += ` AND (age_range=$${params.length} OR age_range='all')`; }
    if (eyfs_area) { params.push(eyfs_area); q += ` AND $${params.length}=ANY(eyfs_areas)`; }
    if (search) { params.push(`%${search.toLowerCase()}%`); q += ` AND (LOWER(name) LIKE $${params.length} OR LOWER(description) LIKE $${params.length})`; }
    q += ' ORDER BY is_library DESC, name ASC LIMIT 200';
    const { rows } = await getPool().query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/curriculum/activities — add custom activity
router.post('/activities', async (req, res) => {
  try {
    const { name, description, category, eyfs_areas, age_range, resources_needed, parent_tip } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await getPool().query(
      `INSERT INTO curriculum_activities(name, description, category, eyfs_areas, age_range, resources_needed, parent_tip, is_library, created_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,false,$8) RETURNING *`,
      [name, description || null, category || null, eyfs_areas || null, age_range || null, resources_needed || null, parent_tip || null, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Planned activities (drag-drop planner) ──────────────────────────────────

// GET /api/curriculum/planned?date_from=&date_to=&room_id=
router.get('/planned', async (req, res) => {
  try {
    const { date_from, date_to, room_id } = req.query;
    let q = `
      SELECT pa.*, a.name AS activity_name, a.category, a.eyfs_areas, a.color,
        s.first_name || ' ' || s.last_name AS led_by_name
      FROM planned_activities pa
      LEFT JOIN curriculum_activities a ON a.id = pa.activity_id
      LEFT JOIN staff s ON s.id = pa.led_by
      WHERE 1=1
    `;
    const params = [];
    if (date_from) { params.push(date_from); q += ` AND pa.plan_date >= $${params.length}`; }
    if (date_to) { params.push(date_to); q += ` AND pa.plan_date <= $${params.length}`; }
    if (room_id) { params.push(parseInt(room_id)); q += ` AND (pa.room_id = $${params.length} OR pa.room_id IS NULL)`; }
    q += ' ORDER BY pa.plan_date, pa.slot';
    const { rows } = await getPool().query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/curriculum/planned — place activity on a slot
router.post('/planned', async (req, res) => {
  try {
    const { plan_date, room_id, slot, activity_id, custom_title, custom_notes, led_by } = req.body;
    if (!plan_date || !slot) return res.status(400).json({ error: 'plan_date and slot required' });
    const { rows } = await getPool().query(
      `INSERT INTO planned_activities(plan_date, room_id, slot, activity_id, custom_title, custom_notes, led_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [plan_date, room_id || null, slot, activity_id || null, custom_title || null, custom_notes || null, led_by || req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/curriculum/planned/:id — remove from slot
router.delete('/planned/:id', async (req, res) => {
  try {
    await getPool().query('DELETE FROM planned_activities WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/curriculum/planned/copy-week — copy last week's plan to this week
router.post('/planned/copy-week', async (req, res) => {
  try {
    const { from_date, to_date, room_id } = req.body;
    if (!from_date || !to_date) return res.status(400).json({ error: 'from_date and to_date required' });
    const db = getPool();
    const srcEnd = new Date(new Date(from_date).getTime() + 4 * 86400000).toISOString().slice(0, 10);
    const { rows: src } = await db.query(
      `SELECT * FROM planned_activities WHERE plan_date BETWEEN $1 AND $2 AND (room_id=$3 OR room_id IS NULL)`,
      [from_date, srcEnd, room_id]
    );
    if (!src.length) return res.json({ copied: 0 });
    const offset = new Date(to_date) - new Date(from_date);
    let copied = 0;
    for (const row of src) {
      const newDate = new Date(new Date(row.plan_date).getTime() + offset).toISOString().slice(0, 10);
      await db.query(
        `INSERT INTO planned_activities(plan_date, room_id, slot, activity_id, custom_title, custom_notes, led_by)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [newDate, row.room_id, row.slot, row.activity_id, row.custom_title, row.custom_notes, row.led_by]
      ).catch(() => {});
      copied++;
    }
    res.json({ copied });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/curriculum/environment-assessments — list past assessments
router.get('/environment-assessments', async (req, res) => {
  try {
    const { scale, room_id } = req.query;
    let q = `SELECT ea.*, r.name AS room_name
             FROM environment_assessments ea
             LEFT JOIN rooms r ON r.id = ea.room_id
             WHERE 1=1`;
    const params = [];
    if (scale)   { params.push(scale);            q += ` AND ea.scale=$${params.length}`; }
    if (room_id) { params.push(parseInt(room_id)); q += ` AND ea.room_id=$${params.length}`; }
    q += ' ORDER BY ea.assessed_at DESC LIMIT 50';
    const { rows } = await getPool().query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/curriculum/environment-assessments — save new assessment
router.post('/environment-assessments', async (req, res) => {
  try {
    const { scale, room_id, assessed_at, scores, overall_avg } = req.body;
    if (!scale || !assessed_at) return res.status(400).json({ error: 'scale and assessed_at required' });
    const { rows } = await getPool().query(
      `INSERT INTO environment_assessments(scale, room_id, assessed_at, assessor_id, scores, overall_avg)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [scale, room_id || null, assessed_at, req.user?.id || null, JSON.stringify(scores || {}), overall_avg || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
