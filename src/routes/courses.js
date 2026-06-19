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

    const [{ rows: sections }, { rows: questions }] = await Promise.all([
      db.query(`SELECT * FROM course_sections WHERE course_id=$1 ORDER BY sort_order`, [req.params.id]),
      db.query(`SELECT id, question_text, option_a, option_b, option_c, option_d, explanation
                FROM course_quiz_questions WHERE course_id=$1 ORDER BY sort_order`, [req.params.id]),
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
      `SELECT id, correct_option FROM course_quiz_questions WHERE course_id=$1`,
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

module.exports = router;
