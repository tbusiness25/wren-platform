const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const { recordAudit } = require('../utils/audit');
const trainingMatrix = require('../lib/training-matrix');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// ── b404 — certificate upload for an "Add training record" form on the ──────
// staff profile (on behalf of another staff member). Mirrors the magazine
// upload pattern in staff-reading.js: a local disk store under data/, a
// random filename, a route-level mime/size filter, served back through a
// small authenticated GET route below (cpd.js already sits entirely behind
// router.use(authenticate), and 'cpd' is already in server-unified.js's
// parent-blocklist, so no further gating is needed here).
const CPD_CERT_DIR = process.env.CPD_CERT_DIR || path.join(__dirname, '../../data/cpd-certificates');
fs.mkdirSync(CPD_CERT_DIR, { recursive: true });

const cpdCertUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, CPD_CERT_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `cpd-cert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^(application\/pdf|image\/(jpeg|png|webp))$/.test(file.mimetype);
    cb(ok ? null : new Error('Certificate must be a PDF, JPG, PNG or WebP'), ok);
  },
});

// GET /certificate/:filename — serve an uploaded CPD certificate. Any
// authenticated staff member (same rule as the magazines shelf's file route);
// filenames are random and not guessable, and cpd.js carries no parent access
// at all (blocked upstream in server-unified.js).
router.get('/certificate/:filename', (req, res) => {
  const name = path.basename(req.params.filename);
  const full = path.join(CPD_CERT_DIR, name);
  if (!full.startsWith(CPD_CERT_DIR) || !fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(full);
});

// GET / — list CPD records (own by default, all if manager)
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const isManager = hasRole(req.user, ['manager','deputy_manager','admin']);
    const staffFilter = isManager && req.query.staff_id
      ? parseInt(req.query.staff_id)
      : isManager ? null : req.user.id;

    let where = staffFilter ? 'WHERE cr.staff_id=$1' : '';
    const params = staffFilter ? [staffFilter] : [];

    const { rows } = await db.query(`
      SELECT cr.*, s.first_name || ' ' || s.last_name as staff_name
      FROM cpd_records cr
      LEFT JOIN staff s ON s.id = cr.staff_id
      ${where}
      ORDER BY cr.completion_date DESC NULLS LAST
      LIMIT 200
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /summary — per-staff CPD summary
router.get('/summary', async (req, res) => {
  // login-20261023: everyone's training record (expired/expiring) is an employee record — managers only.
  // Each person still sees their own training through the self-scoped routes.
  if (!['manager', 'deputy_manager', 'admin', 'owner'].includes(req.user && req.user.role) && Number(req.user && req.user.id) !== 1) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.id, s.first_name || ' ' || s.last_name as name, s.role,
        COUNT(cr.id) as total_courses,
        SUM(cr.hours) as total_hours,
        COUNT(cr.id) FILTER (WHERE cr.expiry_date < CURRENT_DATE) as expired_count,
        COUNT(cr.id) FILTER (WHERE cr.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 60) as expiring_soon
      FROM staff s
      LEFT JOIN cpd_records cr ON cr.staff_id = s.id
      WHERE s.is_active = true AND COALESCE(s.is_demo, false) = false
      GROUP BY s.id, s.first_name, s.last_name, s.role
      ORDER BY s.last_name
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /
// b404: now also accepts multipart/form-data with an optional single
// 'certificate' file, so an "add training record" form can attach a
// certificate in the same request. A plain JSON POST (no file) still works
// exactly as before — multer passes straight through when the request isn't
// multipart, and express.json() (mounted ahead of every router) has already
// parsed req.body in that case.
router.post('/', (req, res) => {
  cpdCertUpload.single('certificate')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    // b170: optional category ('safeguarding'|'first_aid'|'food_hygiene'|'send'|'general')
    // and course_level — additive, used by the safeguarding-CPD dashboard to bucket records.
    const { staff_id, course_name, provider, completion_date, expiry_date, is_mandatory, hours, notes, category, course_level } = req.body;
    const _drop = () => { if (req.file) { try { fs.unlinkSync(req.file.path); } catch (_) {} } };
    if (!course_name) { _drop(); return res.status(400).json({ error: 'course_name required' }); }
    const targetStaff = staff_id || req.user.id;
    // b500 review: the Training tab trusts cpd_records (category + expiry) as the statutory record, so recording
    // for somebody ELSE is manager-only — same rule POST /mandatory below already applies.
    // (kept through the b404 port: the multipart upload does not loosen it)
    if (Number(targetStaff) !== Number(req.user.id) && !hasRole(req.user, ['manager','deputy_manager','admin'])) {
      _drop(); return res.status(403).json({ error: 'Manager access required to record training for other staff' });
    }
    const certificateUrl = req.file ? `/api/cpd/certificate/${req.file.filename}` : null;
    try {
      const db = getPool();
      const { rows } = await db.query(`
        INSERT INTO cpd_records (staff_id,course_name,provider,completion_date,expiry_date,is_mandatory,hours,notes,category,course_level,certificate_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
      `, [targetStaff, course_name, provider||null, completion_date||null,
          expiry_date||null, is_mandatory||false, hours||null, notes||null,
          category||null, course_level||null, certificateUrl]);
      notify('course_completed', 'staff', targetStaff,
        `CPD recorded: ${course_name}`,
        `${provider ? provider + ' — ' : ''}${completion_date || 'no date'}${hours ? ', ' + hours + 'h' : ''}`,
        { relatedTable: 'cpd_records', relatedId: rows[0].id }
      );
      res.status(201).json(rows[0]);
    } catch(e) {
      _drop();
      res.status(500).json({ error: e.message });
    }
  });
});

// b500 review: PUT/DELETE /:id had no role or ownership check — any signed-in member of staff could rewrite or
// delete anybody's training record (and the Training tab now reads these as the statutory record). Managers, or the
// record's own staff member (no page does the latter today; it keeps self-service possible).
async function _canTouchCpdRecord(req, id) {
  if (hasRole(req.user, ['manager','deputy_manager','admin'])) return true;
  const { rows } = await getPool().query('SELECT staff_id FROM cpd_records WHERE id=$1', [id]);
  return !!rows.length && Number(rows[0].staff_id) === Number(req.user.id);
}

// PUT /:id
router.put('/:id', async (req, res) => {
  const { course_name, provider, completion_date, expiry_date, is_mandatory, hours, notes } = req.body;
  try {
    if (!(await _canTouchCpdRecord(req, req.params.id))) return res.status(403).json({ error: 'Manager access required' });
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE cpd_records SET
        course_name=COALESCE($1,course_name),
        provider=COALESCE($2,provider),
        completion_date=COALESCE($3,completion_date),
        expiry_date=COALESCE($4,expiry_date),
        is_mandatory=COALESCE($5,is_mandatory),
        hours=COALESCE($6,hours),
        notes=COALESCE($7,notes)
      WHERE id=$8 RETURNING *
    `, [course_name, provider, completion_date, expiry_date, is_mandatory, hours, notes, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    if (!(await _canTouchCpdRecord(req, req.params.id))) return res.status(403).json({ error: 'Manager access required' });
    const db = getPool();
    await db.query('DELETE FROM cpd_records WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── MANDATORY TRAINING ────────────────────────────────────

// GET /mandatory — all mandatory training (manager: all staff; staff: own)
router.get('/mandatory', async (req, res) => {
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  try {
    const db = getPool();
    let q, p;
    if (isManager) {
      // Optional single-staff filter (used by the Roost staff-profile Training tab, b104).
      const sid = req.query.staff_id ? parseInt(req.query.staff_id, 10) : null;
      q = `SELECT mt.*, s.first_name || ' ' || s.last_name as staff_name, s.role
           FROM mandatory_training mt
           JOIN staff s ON s.id = mt.staff_id
           WHERE s.is_active=true AND COALESCE(s.is_demo, false) = false ${sid ? 'AND mt.staff_id=$1' : ''}
           ORDER BY s.last_name, mt.training_type`;
      p = sid ? [sid] : [];
    } else {
      q = `SELECT * FROM mandatory_training WHERE staff_id=$1 ORDER BY training_type`;
      p = [req.user.id];
    }
    const { rows } = await db.query(q, p);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /mandatory/:id — update completion/expiry (managers, or the record's own staff member)
router.put('/mandatory/:id', async (req, res) => {
  const { completed_date, expiry_date, provider, certificate_url } = req.body;
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  try {
    const db = getPool();
    if (!isManager) {
      const own = await db.query(`SELECT staff_id FROM mandatory_training WHERE id=$1`, [req.params.id]);
      if (!own.rows.length) return res.status(404).json({ error: 'Not found' });
      if (own.rows[0].staff_id !== req.user.id) return res.status(403).json({ error: 'Manager access required' });
    }
    const { rows } = await db.query(`
      UPDATE mandatory_training
      SET completed_date=$1, expiry_date=$2, provider=$3, certificate_url=$4
      WHERE id=$5 RETURNING *
    `, [completed_date||null, expiry_date||null, provider||null, certificate_url||null, req.params.id]);
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /mandatory — add new mandatory training record
router.post('/mandatory', async (req, res) => {
  const { staff_id, training_type, completed_date, expiry_date, provider } = req.body;
  if (!training_type) return res.status(400).json({ error: 'training_type required' });
  const targetStaff = staff_id || req.user.id;
  if (targetStaff !== req.user.id && !hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required to record training for other staff' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO mandatory_training (staff_id, training_type, completed_date, expiry_date, provider)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (staff_id, training_type) DO UPDATE SET
        completed_date=EXCLUDED.completed_date, expiry_date=EXCLUDED.expiry_date,
        provider=EXCLUDED.provider
      RETURNING *
    `, [targetStaff, training_type, completed_date||null, expiry_date||null, provider||null]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /mandatory/:id — remove a mandatory training record (manager only)
router.delete('/mandatory/:id', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) return res.status(403).json({ error: 'Manager access required' });
  try {
    const { rows } = await getPool().query(`DELETE FROM mandatory_training WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted_id: rows[0].id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// b170 — Safeguarding-CPD module: provider presets + a current/expiring/overdue
// dashboard combining cpd_records (external course completions), the existing
// safeguarding_training and mandatory_training tables. Additive to the CPD
// route above; does not change any existing endpoint's behaviour.
// ═════════════════════════════════════════════════════════════════════════════

// GET /providers — pre-fillable safeguarding/mandatory course providers
// (DfE Early Years Safeguarding, NSPCC, WRAP/Prevent, first aid, food hygiene…)
router.get('/providers', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, name, category, default_course_name, default_level, refresher_months, url
      FROM cpd_providers WHERE active = true ORDER BY category, name`);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /safeguarding-status — who's current / expiring-soon / overdue, across
// cpd_records (category = safeguarding/first_aid/food_hygiene/send/general),
// safeguarding_training and mandatory_training. Manager sees everyone; a
// staff member sees only their own status.
router.get('/safeguarding-status', async (req, res) => {
  const isManager = hasRole(req.user, ['manager','deputy_manager','admin']);
  const windowDays = Math.min(Math.max(parseInt(req.query.window_days, 10) || 60, 7), 365);
  try {
    const db = getPool();
    const staffFilter = isManager && req.query.staff_id ? parseInt(req.query.staff_id, 10)
      : isManager ? null : req.user.id;
    const params = [];
    let staffClause = '';
    if (staffFilter) { params.push(staffFilter); staffClause = `AND s.id = $${params.length}`; }

    // Pull every dated record across the three source tables into one shape.
    const { rows } = await db.query(`
      SELECT s.id AS staff_id, s.first_name || ' ' || s.last_name AS staff_name, s.role,
             x.source, x.course_name, x.provider, x.category, x.completion_date, x.expiry_date, x.certificate_url
      FROM staff s
      JOIN LATERAL (
        SELECT 'cpd_records' AS source, cr.course_name, cr.provider, COALESCE(cr.category, CASE WHEN cr.is_mandatory THEN 'general' END) AS category,
               cr.completion_date, cr.expiry_date, cr.certificate_url
        FROM cpd_records cr WHERE cr.staff_id = s.id AND cr.expiry_date IS NOT NULL
        UNION ALL
        SELECT 'safeguarding_training', st.training_type, st.provider, 'safeguarding',
               st.completed_date, st.expiry_date, NULL
        FROM safeguarding_training st WHERE st.staff_id = s.id AND st.expiry_date IS NOT NULL
        UNION ALL
        SELECT 'mandatory_training', mt.training_type, mt.provider, 'mandatory',
               mt.completed_date, mt.expiry_date, mt.certificate_url
        FROM mandatory_training mt WHERE mt.staff_id = s.id AND mt.expiry_date IS NOT NULL
      ) x ON true
      WHERE s.is_active = true AND COALESCE(s.is_demo, false) = false ${staffClause}
      ORDER BY x.expiry_date ASC`, params);

    const today = new Date(); today.setHours(0,0,0,0);
    const soon = new Date(today.getTime() + windowDays * 86400000);
    const bucket = r => {
      const exp = new Date(r.expiry_date);
      if (exp < today) return 'overdue';
      if (exp <= soon) return 'expiring_soon';
      return 'current';
    };
    const withBucket = rows.map(r => ({ ...r, status: bucket(r) }));
    res.json({
      window_days: windowDays,
      overdue: withBucket.filter(r => r.status === 'overdue'),
      expiring_soon: withBucket.filter(r => r.status === 'expiring_soon'),
      current: withBucket.filter(r => r.status === 'current'),
      counts: {
        overdue: withBucket.filter(r => r.status === 'overdue').length,
        expiring_soon: withBucket.filter(r => r.status === 'expiring_soon').length,
        current: withBucket.filter(r => r.status === 'current').length,
      },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /safeguarding-status/nudge — manager: send a reminder nudge (in-app +
// Telegram if linked) to staff with overdue/expiring-soon safeguarding CPD.
// Best-effort; marks cpd_records.reminder_sent_at where it can (cpd_records
// source only — safeguarding_training/mandatory_training have no such column).
router.post('/safeguarding-status/nudge', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) return res.status(403).json({ error: 'Manager access required' });
  const staffId = parseInt(req.body?.staff_id, 10);
  const courseName = String(req.body?.course_name || 'a safeguarding/mandatory course').slice(0, 200);
  if (!staffId) return res.status(400).json({ error: 'staff_id required' });
  try {
    const db = getPool();
    notify('course_due', 'staff', staffId, 'CPD renewal reminder',
      `${courseName} needs renewing soon — please book a refresher.`,
      { relatedTable: 'cpd_records' });
    await db.query(`
      UPDATE cpd_records SET reminder_sent_at = now()
      WHERE staff_id = $1 AND course_name = $2 AND expiry_date IS NOT NULL`, [staffId, courseName]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/quiz — save quiz score (own record, or manager/deputy)
router.put('/:id/quiz', async (req, res) => {
  const { quiz_score } = req.body;
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE cpd_records SET quiz_score=$1, quiz_completed_at=NOW()
      WHERE id=$2 ${isManager ? '' : 'AND staff_id=$3'} RETURNING *
    `, isManager ? [quiz_score, req.params.id] : [quiz_score, req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// b500 (2026-10-13) — Staff records → Training tab (Roost Settings). The
// matrix itself is computed once, server-side, in src/lib/training-matrix.js —
// see that file's header for why this is the only copy of the calculation.
// ═════════════════════════════════════════════════════════════════════════════

// Roost-only: these routes serve the Staff records page. `cpd` is on the HR portal's
// allow-list (HR's own self-service pages call /api/cpd/mandatory etc.), so the segment
// can't be Roost-gated wholesale — each b500 route says so itself. req._portal is set
// from the hostname, ahead of every router, and 'admin' is Roost.
function _roostManagerOnly(req, res) {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    res.status(403).json({ error: 'Manager access required' });
    return false;
  }
  if (req._portal && req._portal !== 'admin') {
    res.status(403).json({ error: 'roost_only', message: 'The training matrix is only available in Roost.' });
    return false;
  }
  return true;
}

function _validIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

// GET /training-matrix — course defs + per-staff latest completion/expiry/status.
router.get('/training-matrix', async (req, res) => {
  if (!_roostManagerOnly(req, res)) return;
  try {
    const includeInactive = String(req.query.include_inactive || '') === '1';
    const data = await trainingMatrix.computeTrainingMatrix(getPool(), { includeInactive });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /training-matrix/courses — edit the course list: name/validity/mandatory,
// or add a recognition pattern via the "Not mapped → map to…" action. Replaces
// the whole array (it's one small settings row, not a table) — the page always
// sends back the full list it just loaded, with one entry changed.
router.put('/training-matrix/courses', async (req, res) => {
  if (!_roostManagerOnly(req, res)) return;
  const v = trainingMatrix.validateCourses(req.body && req.body.courses);
  if (v.error) return res.status(400).json({ error: v.error });
  try {
    const db = getPool();
    const before = await trainingMatrix.loadCourses(db);
    await trainingMatrix.saveCourses(db, v.courses, req.user.id);
    recordAudit({ req, action: 'update', entity_type: 'training_matrix_courses', entity_id: null,
      diff: { old: { courses: before }, new: { courses: v.courses } } });
    res.json({ ok: true, courses: v.courses });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /bulk-record — "the whole team did first aid on Saturday": one completion
// record per staff member for the same course/date/provider. Never overwrites —
// training history is kept, so this always INSERTs a new cpd_records row (the
// Training tab's single-cell edit, which CAN update the latest record in place,
// goes through the existing PUT /:id above instead). Roost-only, manager-gated,
// same shape of per-row result reporting as POST /api/staff/bulk-update.
// A person who already has a record for the same course on the same date is
// reported as ok + skipped (a double-click or a re-run never makes a duplicate).
router.post('/bulk-record', async (req, res) => {
  if (!_roostManagerOnly(req, res)) return;
  const body = req.body || {};
  const staffIds = Array.from(new Set(Array.isArray(body.staff_ids)
    ? body.staff_ids.map(n => parseInt(n, 10)).filter(Number.isInteger)
    : []));
  const courseKey = String(body.course_key || '');
  const completionDate = body.completion_date || null;
  const provider = body.provider ? String(body.provider).slice(0, 200) : null;
  const notes = body.notes ? String(body.notes).slice(0, 1000) : null;
  if (!staffIds.length) return res.status(400).json({ error: 'staff_ids required' });
  if (staffIds.length > 200) return res.status(400).json({ error: 'Too many people in one go (max 200)' });
  if (!completionDate) return res.status(400).json({ error: 'completion_date required' });
  if (!_validIsoDate(completionDate)) return res.status(400).json({ error: 'completion_date must be YYYY-MM-DD' });
  if (completionDate > trainingMatrix.addDaysIso(new Date().toISOString().slice(0, 10), 1)) {
    return res.status(400).json({ error: 'completion_date cannot be in the future' });
  }
  try {
    const db = getPool();
    const courses = await trainingMatrix.loadCourses(db);
    const course = courses.find(c => c.key === courseKey);
    if (!course) return res.status(400).json({ error: 'Unknown course_key' });
    const expiry = course.validity_months ? trainingMatrix.addMonthsIso(completionDate, course.validity_months) : null;
    const { rows: found } = await db.query('SELECT id FROM staff WHERE id = ANY($1::int[])', [staffIds]);
    const exists = new Set(found.map(r => r.id));
    const results = [];
    for (const staffId of staffIds) {
      if (!exists.has(staffId)) { results.push({ staff_id: staffId, ok: false, error: 'Staff member not found' }); continue; }
      try {
        const dupe = await db.query(
          `SELECT id FROM cpd_records WHERE staff_id=$1 AND category=$2 AND completion_date=$3 LIMIT 1`,
          [staffId, course.key, completionDate]);
        if (dupe.rows.length) { results.push({ staff_id: staffId, ok: true, skipped: true, record_id: dupe.rows[0].id }); continue; }
        const { rows } = await db.query(`
          INSERT INTO cpd_records (staff_id, course_name, provider, completion_date, expiry_date, is_mandatory, notes, category)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
        `, [staffId, course.name, provider, completionDate, expiry, !!course.mandatory, notes, course.key]);
        recordAudit({ req, action: 'create', entity_type: 'cpd_records', entity_id: rows[0].id,
          meta: { staff_id: staffId, course_key: course.key, completion_date: completionDate, expiry_date: expiry, bulk: true } });
        results.push({ staff_id: staffId, ok: true, record_id: rows[0].id });
      } catch (e) {
        results.push({ staff_id: staffId, ok: false, error: e.message });
      }
    }
    res.json({ results, expiry_date: expiry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
