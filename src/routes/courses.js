const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const isManager = r => ['manager','deputy_manager','admin'].includes(r);

// GET / — list courses (published only for staff; all for manager)
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const mgr = isManager(req.user.role);
    const where = mgr ? '' : `WHERE c.status = 'published'`;
    const { rows } = await db.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM course_sections s WHERE s.course_id = c.id) AS section_count,
        (SELECT COUNT(*) FROM course_quiz_questions q WHERE q.course_id = c.id) AS question_count,
        (SELECT COUNT(*) FROM course_attempts a WHERE a.course_id = c.id AND a.passed = true) AS pass_count,
        (SELECT COUNT(*) FROM course_attempts a WHERE a.course_id = c.id) AS attempt_count
      FROM courses c
      ${where}
      ORDER BY c.is_mandatory DESC, c.name
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /my-courses — courses with my attempt status (practitioner view)
router.get('/my-courses', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.*,
        (SELECT COUNT(*) FROM course_sections s WHERE s.course_id = c.id) AS section_count,
        a.id AS latest_attempt_id,
        a.score_pct,
        a.passed,
        a.completed_at,
        cert.id AS certificate_id
      FROM courses c
      LEFT JOIN course_attempts a ON a.course_id = c.id AND a.staff_id = $1
        AND a.id = (SELECT id FROM course_attempts WHERE course_id = c.id AND staff_id = $1 ORDER BY started_at DESC LIMIT 1)
      LEFT JOIN certificates cert ON cert.course_id = c.id AND cert.staff_id = $1
      WHERE c.status = 'published'
      ORDER BY c.is_mandatory DESC, c.name
    `, [req.user.id]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /attempts — list attempts (own for staff, all for manager)
router.get('/attempts', async (req, res) => {
  try {
    const db = getPool();
    const mgr = isManager(req.user.role);
    const staff_id = req.query.staff_id ? parseInt(req.query.staff_id) : req.user.id;
    const where = mgr && !req.query.staff_id ? '' : `WHERE a.staff_id = ${mgr ? staff_id : req.user.id}`;
    const { rows } = await db.query(`
      SELECT a.*, c.name AS course_name, c.cpd_hours,
        s.first_name || ' ' || s.last_name AS staff_name
      FROM course_attempts a
      JOIN courses c ON c.id = a.course_id
      JOIN staff s ON s.id = a.staff_id
      ${where}
      ORDER BY a.started_at DESC LIMIT 200
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /certificates — list certificates
router.get('/certificates', async (req, res) => {
  try {
    const db = getPool();
    const mgr = isManager(req.user.role);
    const staff_id = req.query.staff_id ? parseInt(req.query.staff_id) : req.user.id;
    const where = mgr && !req.query.staff_id ? '' : `WHERE cert.staff_id = ${mgr ? staff_id : req.user.id}`;
    const { rows } = await db.query(`
      SELECT cert.*, c.name AS course_name, c.cpd_hours, c.category,
        s.first_name || ' ' || s.last_name AS staff_name
      FROM certificates cert
      JOIN courses c ON c.id = cert.course_id
      JOIN staff s ON s.id = cert.staff_id
      ${where}
      ORDER BY cert.issued_at DESC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Course assignments / authorisation (manage) ─────────────────────────────
// NB: these literal-path GET routes MUST be declared before `GET /:id` so the
// router does not treat "assignments" as an :id.

// GET /assignments — manager: all assignments; staff: only own.
// Joins completion status from certificates / passed attempts so the matrix can
// render not-assigned / assigned / completed / authorised per staff per course.
router.get('/assignments', async (req, res) => {
  try {
    const db = getPool();
    const mgr = isManager(req.user.role);
    const params = [];
    let where = '';
    if (!mgr) { params.push(req.user.id); where = `WHERE ca.staff_id = $1`; }
    else if (req.query.staff_id) { params.push(parseInt(req.query.staff_id)); where = `WHERE ca.staff_id = $1`; }
    else if (req.query.course_id) { params.push(parseInt(req.query.course_id)); where = `WHERE ca.course_id = $1`; }
    const { rows } = await db.query(`
      SELECT ca.*,
        c.name AS course_name, c.cpd_hours, c.is_mandatory, c.category, c.status AS course_status,
        s.first_name || ' ' || s.last_name AS staff_name, s.role AS staff_role,
        ab.first_name || ' ' || ab.last_name AS assigned_by_name,
        au.first_name || ' ' || au.last_name AS authorised_by_name,
        cert.id AS certificate_id, cert.issued_at AS certificate_issued_at,
        (SELECT max(a.score_pct) FROM course_attempts a WHERE a.course_id = ca.course_id AND a.staff_id = ca.staff_id AND a.passed = true) AS best_passed_score
      FROM course_assignments ca
      JOIN courses c ON c.id = ca.course_id
      JOIN staff s   ON s.id = ca.staff_id
      LEFT JOIN staff ab ON ab.id = ca.assigned_by
      LEFT JOIN staff au ON au.id = ca.authorised_by
      LEFT JOIN certificates cert ON cert.course_id = ca.course_id AND cert.staff_id = ca.staff_id
      ${where}
      ORDER BY c.is_mandatory DESC, c.name, s.first_name
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /:id — course detail with sections and questions
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const mgr = isManager(req.user.role);
    const { rows: courses } = await db.query(
      `SELECT * FROM courses WHERE id = $1${mgr ? '' : " AND status = 'published'"}`,
      [req.params.id]
    );
    if (!courses.length) return res.status(404).json({ error: 'Not found' });

    // Table stores options as jsonb array + correct_index; the UI speaks
    // option_a..option_d letters — map in SQL (fixed 2026-07-07, was querying
    // nonexistent sort_order/option_a columns so EVERY course detail 500'd).
    const [{ rows: sections }, { rows: questions }] = await Promise.all([
      db.query(`SELECT * FROM course_sections WHERE course_id=$1 ORDER BY order_index`, [req.params.id]),
      db.query(`SELECT id, question_text,
                       options->>0 AS option_a, options->>1 AS option_b,
                       options->>2 AS option_c, options->>3 AS option_d, explanation
                FROM course_quiz_questions WHERE course_id=$1 ORDER BY order_index`, [req.params.id]),
    ]);

    res.json({ ...courses[0], sections, questions });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/publish — toggle publish/unpublish (manager only)
router.put('/:id/publish', async (req, res) => {
  if (!isManager(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE courses SET
        status = CASE WHEN status = 'published' THEN 'review' ELSE 'published' END,
        published_at = CASE WHEN status != 'published' THEN NOW() ELSE NULL END
       WHERE id = $1 RETURNING id, name, status`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/attempt — submit quiz attempt
router.post('/:id/attempt', async (req, res) => {
  const { answers } = req.body; // { question_id: selected_option, ... }
  if (!answers) return res.status(400).json({ error: 'answers required' });
  try {
    const db = getPool();
    const { rows: course } = await db.query(`SELECT * FROM courses WHERE id=$1 AND status='published'`, [req.params.id]);
    if (!course.length) return res.status(404).json({ error: 'Course not found or not published' });

    const { rows: questions } = await db.query(
      `SELECT id, chr(97 + correct_index) AS correct_option FROM course_quiz_questions WHERE course_id=$1`,
      [req.params.id]
    );
    if (!questions.length) return res.status(400).json({ error: 'No questions for this course' });

    let correct = 0;
    questions.forEach(q => {
      if (answers[q.id] && answers[q.id].toLowerCase() === q.correct_option.toLowerCase()) correct++;
    });
    const score_pct = Math.round((correct / questions.length) * 100);
    const passed = score_pct >= (course[0].pass_mark_pct || 80);

    const { rows: attempt } = await db.query(`
      INSERT INTO course_attempts (course_id, staff_id, score_pct, passed, answers_json, completed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `, [req.params.id, req.user.id, score_pct, passed, JSON.stringify(answers)]);

    // Issue certificate if passed and not already held
    let certificate = null;
    if (passed) {
      const exp = course[0].cpd_hours
        ? new Date(Date.now() + 3 * 365 * 86400000).toISOString().slice(0,10)
        : null;
      const { rows: cert } = await db.query(`
        INSERT INTO certificates (course_id, staff_id, attempt_id, expires_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (course_id, staff_id) DO UPDATE
          SET issued_at=NOW(), attempt_id=$3, expires_at=$4
        RETURNING *
      `, [req.params.id, req.user.id, attempt[0].id, exp]);
      certificate = cert[0];

      // Log CPD record (only if not already logged for this course)
      const existing = await db.query(
        `SELECT id FROM cpd_records WHERE staff_id=$1 AND course_name=$2 AND notes LIKE 'Completed online%' LIMIT 1`,
        [req.user.id, course[0].name]
      );
      if (!existing.rows.length) {
        await db.query(`
          INSERT INTO cpd_records (staff_id, course_name, provider, completion_date, hours, is_mandatory, notes)
          VALUES ($1, $2, 'Wren CPD Platform', NOW()::date, $3, $4, $5)
        `, [req.user.id, course[0].name, course[0].cpd_hours || 0, course[0].is_mandatory,
            `Completed online (${score_pct}%)`]);
      }
    }

    res.json({ attempt: attempt[0], score_pct, passed, certificate });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Manage: create / edit course (manager only) ─────────────────────────────

function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'course';
}

// POST / — create a new course shell (manager only)
router.post('/', async (req, res) => {
  if (!isManager(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name required' });
  try {
    const db = getPool();
    // ensure a unique slug
    let base = slugify(b.slug || b.name), slug = base, n = 1;
    while ((await db.query(`SELECT 1 FROM courses WHERE slug=$1`, [slug])).rows.length) {
      slug = `${base}-${++n}`;
    }
    const { rows } = await db.query(`
      INSERT INTO courses
        (slug, name, description, category, cpd_hours, duration_minutes,
         is_mandatory, pass_mark_pct, status, created_by, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'review',$9,NOW(),NOW())
      RETURNING *
    `, [slug, String(b.name).trim(), b.description || null, b.category || null,
        b.cpd_hours != null ? b.cpd_hours : null,
        b.duration_minutes != null ? parseInt(b.duration_minutes) : 25,
        b.is_mandatory === true,
        b.pass_mark_pct != null ? parseInt(b.pass_mark_pct) : 80,
        req.user.name || `staff:${req.user.id}`]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — edit course metadata (manager only). Only updates provided fields.
// (Path /:id never collides with /:id/publish — different path depth.)
router.put('/:id', async (req, res) => {
  if (!isManager(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  const b = req.body || {};
  const allowed = ['name','description','category','cpd_hours','duration_minutes',
                   'is_mandatory','pass_mark_pct','content_summary','target_audience'];
  const sets = [], vals = [];
  allowed.forEach(k => { if (b[k] !== undefined) { vals.push(b[k]); sets.push(`${k}=$${vals.length}`); } });
  if (!sets.length) return res.status(400).json({ error: 'No editable fields supplied' });
  vals.push(req.params.id);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE courses SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,
      vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Manage: assign a course to staff / room / all (manager only) ─────────────
// Body: { staff_ids:[..], room_id, all:true, required:bool, due_date, notes }
router.post('/:id/assign', async (req, res) => {
  if (!isManager(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  const b = req.body || {};
  try {
    const db = getPool();
    const { rows: course } = await db.query(`SELECT id, name FROM courses WHERE id=$1`, [req.params.id]);
    if (!course.length) return res.status(404).json({ error: 'Course not found' });

    // Resolve the set of target staff ids
    let targets = [];
    if (Array.isArray(b.staff_ids) && b.staff_ids.length) {
      targets = b.staff_ids.map(Number).filter(Boolean);
    } else if (b.all === true) {
      const { rows } = await db.query(`SELECT id FROM staff WHERE is_active IS NOT FALSE`);
      targets = rows.map(r => r.id);
    } else if (b.room_id) {
      const { rows } = await db.query(`SELECT id FROM staff WHERE is_active IS NOT FALSE AND room_id=$1`, [parseInt(b.room_id)]);
      targets = rows.map(r => r.id);
    }
    targets = [...new Set(targets)];
    if (!targets.length) return res.status(400).json({ error: 'No target staff (provide staff_ids, room_id, or all:true)' });

    const required = b.required !== false;
    const due = b.due_date || null;
    let assigned = 0;
    for (const sid of targets) {
      // Upsert: never downgrade a completed/authorised assignment back to "assigned".
      await db.query(`
        INSERT INTO course_assignments (course_id, staff_id, required, due_date, status, assigned_by, notes)
        VALUES ($1,$2,$3,$4,'assigned',$5,$6)
        ON CONFLICT (course_id, staff_id) DO UPDATE
          SET required=$3, due_date=$4, assigned_by=$5,
              notes=COALESCE($6, course_assignments.notes)
      `, [req.params.id, sid, required, due, req.user.id, b.notes || null]);
      assigned++;
    }
    res.json({ ok: true, course_id: Number(req.params.id), assigned, staff_ids: targets });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Manage: authorise / sign off a staff member's course completion ──────────
// Body: { staff_id, hours, completion_date, notes }
// Writes the assignment (status=authorised), a signed-off cpd_record, and a
// certificate so the practitioner's /my-courses reflects it.
router.post('/:id/authorise', async (req, res) => {
  if (!isManager(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  const b = req.body || {};
  const staffId = parseInt(b.staff_id);
  if (!staffId) return res.status(400).json({ error: 'staff_id required' });
  try {
    const db = getPool();
    const { rows: course } = await db.query(`SELECT * FROM courses WHERE id=$1`, [req.params.id]);
    if (!course.length) return res.status(404).json({ error: 'Course not found' });
    const c = course[0];
    const hours = b.hours != null ? b.hours : (c.cpd_hours || 0);
    const completedOn = b.completion_date || new Date().toISOString().slice(0,10);

    // 1) Upsert the assignment as authorised (create one if none existed).
    const { rows: asg } = await db.query(`
      INSERT INTO course_assignments
        (course_id, staff_id, required, status, assigned_by, authorised_by, authorised_at, notes)
      VALUES ($1,$2,true,'authorised',$3,$3,NOW(),$4)
      ON CONFLICT (course_id, staff_id) DO UPDATE
        SET status='authorised', authorised_by=$3, authorised_at=NOW(),
            notes=COALESCE($4, course_assignments.notes)
      RETURNING *
    `, [req.params.id, staffId, req.user.id, b.notes || null]);

    // 2) Signed-off CPD record (idempotent via marker in notes).
    const marker = `Authorised (course #${c.id})`;
    const existing = await db.query(
      `SELECT id FROM cpd_records WHERE staff_id=$1 AND course_name=$2 AND notes LIKE $3 LIMIT 1`,
      [staffId, c.name, '%' + marker + '%']);
    let cpd_record = existing.rows[0] || null;
    if (!cpd_record) {
      const exp = c.cpd_hours
        ? new Date(new Date(completedOn).getTime() + 3*365*86400000).toISOString().slice(0,10)
        : null;
      const { rows } = await db.query(`
        INSERT INTO cpd_records (staff_id, course_name, provider, completion_date, expiry_date, hours, is_mandatory, notes)
        VALUES ($1,$2,'Wren CPD Platform',$3,$4,$5,$6,$7)
        RETURNING id
      `, [staffId, c.name, completedOn, exp, hours, c.is_mandatory,
          `${marker}${b.notes ? ' — ' + b.notes : ''}`]);
      cpd_record = rows[0];
    }

    // 3) Certificate so practitioner /my-courses reflects the sign-off.
    const certExp = c.cpd_hours
      ? new Date(new Date(completedOn).getTime() + 3*365*86400000).toISOString().slice(0,10)
      : null;
    const { rows: cert } = await db.query(`
      INSERT INTO certificates (course_id, staff_id, attempt_id, expires_at)
      VALUES ($1,$2,NULL,$3)
      ON CONFLICT (staff_id, course_id) DO UPDATE SET issued_at=NOW(), expires_at=$3
      RETURNING id, uuid, issued_at, expires_at
    `, [req.params.id, staffId, certExp]);

    res.json({ ok: true, assignment: asg[0], cpd_record, certificate: cert[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /assignments/:assignmentId — remove an assignment (manager only).
// Does not touch cpd_records / certificates (those are kept records).
router.delete('/assignments/:assignmentId', async (req, res) => {
  if (!isManager(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `DELETE FROM course_assignments WHERE id=$1 RETURNING id`, [parseInt(req.params.assignmentId)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
