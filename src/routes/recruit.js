'use strict';
// ============================================================================
// b112 — Wren Recruit: ADMIN (manager-only) API. Mounted at /api/recruit.
//
// Non-staff personal data (applicants / CVs) → strictly manager-level.
// The Roost "Recruitment" page (editions/admin/public/recruitment.html) is the
// only UI. Additive: appends a new router; does not touch existing routes.
//
//   Vacancies   GET/POST /vacancies · GET/PATCH/DELETE /vacancies/:id
//   Applicants  GET /applicants · GET/POST /applicants · PATCH /applicants/:id
//               GET /applicants/:id/cv           (stream CV, manager-only)
//   Events      GET/POST /applicants/:id/events
//   Email       GET /email-templates?applicant_id=  ·  POST /applicants/:id/email
//   Hire        POST /applicants/:id/hire  → staff record + induction assignment
// ============================================================================
const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();

const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const EMAIL_LIVE = () => process.env.EMAIL_GATEWAY_LIVE === 'on';
const STAFF_MAILBOX = process.env.GATEWAY_MAILBOX || 'staff@example-nursery.co.uk';

const STAGES = ['applied', 'shortlist', 'interview', 'offer', 'hired', 'rejected'];
const CHECK_KEYS = ['dbs', 'rtw', 'references', 'quals'];

router.use(authenticate);

// ── manager gate (whole module) ──────────────────────────────────────────────
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher'];
function isManager(user) { return !!user && MANAGER_ROLES.includes(String(user.role || '').toLowerCase()); }
router.use((req, res, next) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Recruitment is manager-only.' });
  next();
});
router.use(express.json({ limit: '256kb' }));

function actor(req) { return Number(req.user && req.user.id) || 0; }

// ════════════════════════════════════════════════════════════════════════════
// VACANCIES
// ════════════════════════════════════════════════════════════════════════════
router.get('/vacancies', async (req, res) => {
  try {
    const db = getPool();
    const where = [];
    const params = [];
    if (req.query.status && ['open', 'closed'].includes(req.query.status)) {
      params.push(req.query.status); where.push(`v.status = $${params.length}`);
    }
    const { rows } = await db.query(
      `SELECT v.*,
              (SELECT COUNT(*) FROM ${SCHEMA()}.recruit_applicants a WHERE a.vacancy_id = v.id)::int AS applicant_count
         FROM ${SCHEMA()}.recruit_vacancies v
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY v.status, v.created_at DESC, v.id DESC`, params);
    res.json({ vacancies: rows });
  } catch (e) { console.error('[recruit] vacancies list:', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/vacancies/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM ${SCHEMA()}.recruit_vacancies WHERE id=$1`, [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Vacancy not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/vacancies', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) return res.status(400).json({ error: 'title is required' });
    const status = ['open', 'closed'].includes(b.status) ? b.status : 'open';
    const { rows } = await getPool().query(
      `INSERT INTO ${SCHEMA()}.recruit_vacancies
         (title, room_role, description_md, salary_range, hours, employment_type, status, published, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,false),$9) RETURNING *`,
      [String(b.title).trim(), b.room_role || null, b.description_md || null,
       b.salary_range || null, b.hours || null, b.employment_type || 'permanent',
       status, b.published === true || b.published === 'true', actor(req)]);
    res.status(201).json(rows[0]);
  } catch (e) { console.error('[recruit] vacancy create:', e.message); res.status(500).json({ error: e.message }); }
});

router.patch('/vacancies/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const sets = [], vals = []; let i = 1;
    const col = (name, val) => { sets.push(`${name}=$${i++}`); vals.push(val); };
    if (b.title != null)          col('title', String(b.title).trim());
    if (b.room_role !== undefined) col('room_role', b.room_role || null);
    if (b.description_md !== undefined) col('description_md', b.description_md || null);
    if (b.salary_range !== undefined) col('salary_range', b.salary_range || null);
    if (b.hours !== undefined)    col('hours', b.hours || null);
    if (b.employment_type !== undefined) col('employment_type', b.employment_type || 'permanent');
    if (b.status != null && ['open', 'closed'].includes(b.status)) col('status', b.status);
    if (b.published != null)      col('published', b.published === true || b.published === 'true');
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at=now()');
    vals.push(id);
    const { rows } = await db.query(
      `UPDATE ${SCHEMA()}.recruit_vacancies SET ${sets.join(', ')} WHERE id=$${i} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Vacancy not found' });
    res.json(rows[0]);
  } catch (e) { console.error('[recruit] vacancy patch:', e.message); res.status(500).json({ error: e.message }); }
});

// Delete — only when no applicants; otherwise close it (keeps the audit trail).
router.delete('/vacancies/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows: [c] } = await db.query(
      `SELECT COUNT(*)::int AS n FROM ${SCHEMA()}.recruit_applicants WHERE vacancy_id=$1`, [id]);
    if (c.n > 0) {
      await db.query(`UPDATE ${SCHEMA()}.recruit_vacancies SET status='closed', published=false, updated_at=now() WHERE id=$1`, [id]);
      return res.json({ ok: true, closed: true, note: 'Vacancy has applicants — closed instead of deleted.' });
    }
    const { rowCount } = await db.query(`DELETE FROM ${SCHEMA()}.recruit_vacancies WHERE id=$1`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'Vacancy not found' });
    res.json({ ok: true, deleted: true });
  } catch (e) { console.error('[recruit] vacancy delete:', e.message); res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// APPLICANTS
// ════════════════════════════════════════════════════════════════════════════
function pubApplicant(a) {
  return {
    id: a.id, vacancy_id: a.vacancy_id, vacancy_title: a.vacancy_title || null,
    name: a.name, email: a.email, phone: a.phone,
    cover_text: a.cover_text, source: a.source, stage: a.stage,
    stage_notes: a.stage_notes || [], checklist: a.checklist || {},
    has_cv: !!a.cv_path, cv_filename: a.cv_filename,
    cv_url: a.cv_path ? `/api/recruit/applicants/${a.id}/cv` : null,
    // b213 — what they said they hold, and the EYFS answers they wrote.
    // Passed through untouched for a human to read; nothing here is scored.
    qualification: a.qualification || null,
    assessment: a.assessment || null,
    assessment_submitted_at: a.assessment_submitted_at || null,
    gdpr_consent_at: a.gdpr_consent_at, hired_staff_id: a.hired_staff_id,
    rejected_at: a.rejected_at, anonymised_at: a.anonymised_at,
    created_at: a.created_at, updated_at: a.updated_at,
  };
}

router.get('/applicants', async (req, res) => {
  try {
    const db = getPool();
    const where = [], params = [];
    if (req.query.vacancy_id) { params.push(parseInt(req.query.vacancy_id, 10)); where.push(`a.vacancy_id = $${params.length}`); }
    if (req.query.stage && STAGES.includes(req.query.stage)) { params.push(req.query.stage); where.push(`a.stage = $${params.length}`); }
    const { rows } = await db.query(
      `SELECT a.*, v.title AS vacancy_title
         FROM ${SCHEMA()}.recruit_applicants a
         LEFT JOIN ${SCHEMA()}.recruit_vacancies v ON v.id = a.vacancy_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.created_at DESC, a.id DESC`, params);
    res.json({ applicants: rows.map(pubApplicant) });
  } catch (e) { console.error('[recruit] applicants list:', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/applicants/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { rows } = await db.query(
      `SELECT a.*, v.title AS vacancy_title FROM ${SCHEMA()}.recruit_applicants a
         LEFT JOIN ${SCHEMA()}.recruit_vacancies v ON v.id = a.vacancy_id WHERE a.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Applicant not found' });
    const { rows: events } = await db.query(
      `SELECT e.*, s.first_name || ' ' || s.last_name AS by_name
         FROM ${SCHEMA()}.recruit_events e
         LEFT JOIN ${SCHEMA()}.staff s ON s.id = e.created_by
        WHERE e.applicant_id=$1 ORDER BY e.at DESC, e.id DESC`, [id]);
    res.json({ ...pubApplicant(rows[0]), events });
  } catch (e) { console.error('[recruit] applicant get:', e.message); res.status(500).json({ error: e.message }); }
});

// Manual add (a walk-in / phone applicant a manager keys in).
router.post('/applicants', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'name is required' });
    const stage = STAGES.includes(b.stage) ? b.stage : 'applied';
    const { rows } = await getPool().query(
      `INSERT INTO ${SCHEMA()}.recruit_applicants
         (vacancy_id, name, email, phone, cover_text, source, stage, gdpr_consent_at)
       VALUES ($1,$2,$3,$4,$5,COALESCE($6,'manual'),$7, CASE WHEN $8 THEN now() ELSE NULL END)
       RETURNING *`,
      [b.vacancy_id || null, String(b.name).trim(), b.email || null, b.phone || null,
       b.cover_text || null, b.source || null, stage, b.gdpr_consent === true || b.gdpr_consent === 'true']);
    res.status(201).json(pubApplicant(rows[0]));
  } catch (e) { console.error('[recruit] applicant create:', e.message); res.status(500).json({ error: e.message }); }
});

// PATCH — move stage (kanban drag), toggle checklist, edit fields.
router.patch('/applicants/:id', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const { rows: [cur] } = await db.query(
      `SELECT * FROM ${SCHEMA()}.recruit_applicants WHERE id=$1`, [id]);
    if (!cur) return res.status(404).json({ error: 'Applicant not found' });

    const sets = [], vals = []; let i = 1;
    const col = (name, val) => { sets.push(`${name}=$${i++}`); vals.push(val); };

    let stageChanged = false, newStage = cur.stage;
    if (b.stage != null && STAGES.includes(b.stage) && b.stage !== cur.stage) {
      newStage = b.stage; stageChanged = true;
      col('stage', newStage);
      // rejected_at is the retention clock; set on entering, clear on leaving.
      if (newStage === 'rejected') col('rejected_at', new Date());
      else if (cur.stage === 'rejected') col('rejected_at', null);
      // append to stage_notes history
      const hist = Array.isArray(cur.stage_notes) ? cur.stage_notes : [];
      hist.push({ at: new Date().toISOString(), by: actor(req), from: cur.stage, to: newStage, note: b.note || null });
      col('stage_notes', JSON.stringify(hist));
    }
    if (b.checklist && typeof b.checklist === 'object') {
      const merged = Object.assign({}, cur.checklist || {});
      for (const k of CHECK_KEYS) if (k in b.checklist) merged[k] = !!b.checklist[k];
      col('checklist', JSON.stringify(merged));
    }
    if (b.name != null)        col('name', String(b.name).trim());
    if (b.email !== undefined) col('email', b.email || null);
    if (b.phone !== undefined) col('phone', b.phone || null);
    if (b.cover_text !== undefined) col('cover_text', b.cover_text || null);
    if (b.vacancy_id !== undefined) col('vacancy_id', b.vacancy_id || null);

    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    sets.push('updated_at=now()');
    vals.push(id);
    const { rows } = await db.query(
      `UPDATE ${SCHEMA()}.recruit_applicants SET ${sets.join(', ')} WHERE id=$${i}
       RETURNING *, (SELECT title FROM ${SCHEMA()}.recruit_vacancies v WHERE v.id=recruit_applicants.vacancy_id) AS vacancy_title`, vals);

    if (stageChanged) {
      await db.query(
        `INSERT INTO ${SCHEMA()}.recruit_events (applicant_id, type, notes, created_by)
         VALUES ($1,'stage_change',$2,$3)`,
        [id, `${cur.stage} → ${newStage}${b.note ? ' — ' + String(b.note).slice(0, 300) : ''}`, actor(req)]);
    }
    res.json(pubApplicant(rows[0]));
  } catch (e) { console.error('[recruit] applicant patch:', e.message); res.status(500).json({ error: e.message }); }
});

// Stream a CV (manager-only; enforced by the module gate).
router.get('/applicants/:id/cv', async (req, res) => {
  try {
    const { rows: [a] } = await getPool().query(
      `SELECT cv_path, cv_filename, cv_mime FROM ${SCHEMA()}.recruit_applicants WHERE id=$1`,
      [parseInt(req.params.id, 10)]);
    if (!a || !a.cv_path) return res.status(404).json({ error: 'No CV on file' });
    if (!fs.existsSync(a.cv_path)) return res.status(404).json({ error: 'CV file not on disk' });
    if (a.cv_mime) res.setHeader('Content-Type', a.cv_mime);
    const dl = String(req.query.download || '') === '1';
    res.setHeader('Content-Disposition',
      `${dl ? 'attachment' : 'inline'}; filename="${(a.cv_filename || 'cv').replace(/["\\]/g, '')}"`);
    fs.createReadStream(a.cv_path).pipe(res);
  } catch (e) { console.error('[recruit] cv:', e.message); res.status(500).json({ error: e.message }); }
});

// ── Events ────────────────────────────────────────────────────────────────────
router.get('/applicants/:id/events', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT e.*, s.first_name || ' ' || s.last_name AS by_name
         FROM ${SCHEMA()}.recruit_events e LEFT JOIN ${SCHEMA()}.staff s ON s.id = e.created_by
        WHERE e.applicant_id=$1 ORDER BY e.at DESC, e.id DESC`, [parseInt(req.params.id, 10)]);
    res.json({ events: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/applicants/:id/events', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const type = ['interview', 'call', 'note', 'email'].includes(b.type) ? b.type : 'note';
    const { rows: [ex] } = await db.query(`SELECT id FROM ${SCHEMA()}.recruit_applicants WHERE id=$1`, [id]);
    if (!ex) return res.status(404).json({ error: 'Applicant not found' });
    const { rows } = await db.query(
      `INSERT INTO ${SCHEMA()}.recruit_events (applicant_id, type, at, notes, created_by)
       VALUES ($1,$2,COALESCE($3, now()),$4,$5) RETURNING *`,
      [id, type, b.at || null, b.notes || null, actor(req)]);
    res.status(201).json(rows[0]);
  } catch (e) { console.error('[recruit] event create:', e.message); res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// EMAIL — templated, editable drafts, never auto-sent
// ════════════════════════════════════════════════════════════════════════════
function fillTemplate(str, ctx) {
  return String(str || '')
    .replace(/\{name\}/g, ctx.name || 'there')
    .replace(/\{vacancy\}/g, ctx.vacancy || 'the role')
    .replace(/\{date\}/g, ctx.date || '[date & time to be confirmed]');
}

// GET /email-templates?applicant_id= — returns the 3 templates with placeholders
// pre-filled from the applicant/vacancy so the manager gets an editable draft.
router.get('/email-templates', async (req, res) => {
  try {
    const db = getPool();
    let ctx = { name: '', vacancy: '' };
    if (req.query.applicant_id) {
      const { rows } = await db.query(
        `SELECT a.name, v.title AS vacancy FROM ${SCHEMA()}.recruit_applicants a
           LEFT JOIN ${SCHEMA()}.recruit_vacancies v ON v.id=a.vacancy_id WHERE a.id=$1`,
        [parseInt(req.query.applicant_id, 10)]);
      if (rows.length) {
        ctx.name = (rows[0].name || '').split(' ')[0] || rows[0].name || '';
        ctx.vacancy = rows[0].vacancy || '';
      }
    }
    const { rows: tpls } = await db.query(
      `SELECT template_key, name, subject, body FROM ${SCHEMA()}.recruit_email_templates ORDER BY sort_order, id`);
    res.json({
      templates: tpls.map(t => ({
        template_key: t.template_key, name: t.name,
        subject: fillTemplate(t.subject, ctx), body: fillTemplate(t.body, ctx),
      })),
    });
  } catch (e) { console.error('[recruit] templates:', e.message); res.status(500).json({ error: e.message }); }
});

// POST /applicants/:id/email — send an (already-edited) draft to the candidate.
// Manager-triggered only. Gated behind EMAIL_GATEWAY_LIVE (dry-run everywhere
// else). Logs a recruit_event so the audit trail is complete.
router.post('/applicants/:id/email', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const { subject, body, template_key } = req.body || {};
    if (!subject || !body) return res.status(400).json({ error: 'subject and body are required' });

    const { rows: [a] } = await db.query(
      `SELECT id, name, email FROM ${SCHEMA()}.recruit_applicants WHERE id=$1`, [id]);
    if (!a) return res.status(404).json({ error: 'Applicant not found' });
    if (!a.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email))
      return res.status(400).json({ error: 'This applicant has no valid email address on file.' });

    let messageId = 'dev-dry-run', dryRun = true;
    const footer = `\n\n—\nYour Nursery\n123 Example Lane, Your Town, AB1 2CD · 020 7946 0000`;
    if (EMAIL_LIVE()) {
      const gmail = require('../lib/gmail-sender');
      const r = await gmail.sendViaGmail({
        to: a.email, subject: String(subject).slice(0, 300),
        text: String(body) + footer, from: STAFF_MAILBOX,
      });
      messageId = r.messageId; dryRun = false;
    } else {
      console.log(`[recruit] EMAIL DRY RUN → ${a.email}: "${subject}"`);
    }

    await db.query(
      `INSERT INTO ${SCHEMA()}.recruit_events (applicant_id, type, notes, created_by)
       VALUES ($1,'email',$2,$3)`,
      [id, `${template_key ? '[' + template_key + '] ' : ''}${String(subject).slice(0, 200)}${dryRun ? ' (dry-run)' : ''}`, actor(req)]);

    res.json({ ok: true, dry_run: dryRun, message_id: messageId });
  } catch (e) { console.error('[recruit] email:', e.message); res.status(500).json({ error: 'Could not send email: ' + e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// HIRE — create a minimal staff record + auto-assign an induction template
// ════════════════════════════════════════════════════════════════════════════
router.post('/applicants/:id/hire', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const { rows: [a] } = await db.query(
      `SELECT a.*, v.room_role FROM ${SCHEMA()}.recruit_applicants a
         LEFT JOIN ${SCHEMA()}.recruit_vacancies v ON v.id=a.vacancy_id WHERE a.id=$1`, [id]);
    if (!a) return res.status(404).json({ error: 'Applicant not found' });
    if (a.hired_staff_id) return res.status(409).json({ error: 'Already hired', staff_id: a.hired_staff_id });

    // Split the name; default role practitioner (manager refines in Staff admin).
    const parts = String(a.name || '').trim().split(/\s+/);
    const firstName = b.first_name || parts.shift() || 'New';
    const lastName  = b.last_name  || (parts.length ? parts.join(' ') : 'Starter');
    const role = b.role && String(b.role).trim() ? String(b.role).trim() : 'practitioner';
    const roomId = Number.isInteger(b.room_id) ? b.room_id : null;

    // NEVER touch id=1 — this always INSERTs a brand-new staff row.
    const { rows: [staff] } = await db.query(
      `INSERT INTO ${SCHEMA()}.staff
         (first_name, last_name, email, phone, role, room_id, is_active, employment_type, contract_start, notes)
       VALUES ($1,$2,$3,$4,$5,$6,true,$7, CURRENT_DATE, $8)
       RETURNING id, first_name, last_name, role`,
      [firstName, lastName, a.email || null, a.phone || null, role, roomId,
       b.employment_type || 'permanent', `Created from Wren Recruit application #${a.id}.`]);

    // Auto-assign an induction template (prefer one matching the role, else first active).
    let assignmentId = null, templateName = null, inductionNote = 'no active induction template found — assign manually';
    try {
      const { rows: tpls } = await db.query(
        `SELECT id, name, role_target FROM ${SCHEMA()}.induction_templates WHERE is_active=true ORDER BY id`);
      if (tpls.length) {
        const match = tpls.find(t => Array.isArray(t.role_target) && t.role_target.includes(role)) || tpls[0];
        const { rows: [asg] } = await db.query(
          `INSERT INTO ${SCHEMA()}.induction_assignments
             (staff_id, template_id, assigned_by, start_date, status)
           VALUES ($1,$2,$3, CURRENT_DATE, 'in_progress') RETURNING id`,
          [staff.id, match.id, actor(req)]);
        assignmentId = asg.id; templateName = match.name;
        await db.query(
          `INSERT INTO ${SCHEMA()}.induction_item_progress (assignment_id, item_id, status)
           SELECT $1, ti.id, 'pending' FROM ${SCHEMA()}.induction_template_items ti
            WHERE ti.template_id=$2 ON CONFLICT (assignment_id, item_id) DO NOTHING`,
          [assignmentId, match.id]);
        inductionNote = `induction "${templateName}" assigned`;
      }
    } catch (ie) { console.error('[recruit] induction assign failed:', ie.message); inductionNote = 'induction assign failed: ' + ie.message; }

    // Mark applicant hired + log event.
    const hist = Array.isArray(a.stage_notes) ? a.stage_notes : [];
    hist.push({ at: new Date().toISOString(), by: actor(req), from: a.stage, to: 'hired', note: `staff #${staff.id} created; ${inductionNote}` });
    await db.query(
      `UPDATE ${SCHEMA()}.recruit_applicants
         SET stage='hired', hired_staff_id=$2, rejected_at=NULL, stage_notes=$3, updated_at=now() WHERE id=$1`,
      [id, staff.id, JSON.stringify(hist)]);
    await db.query(
      `INSERT INTO ${SCHEMA()}.recruit_events (applicant_id, type, notes, created_by)
       VALUES ($1,'stage_change',$2,$3)`,
      [id, `Hired → staff #${staff.id} (${staff.first_name} ${staff.last_name}); ${inductionNote}`, actor(req)]);

    // Manager notification.
    try {
      await db.query(
        `INSERT INTO ${SCHEMA()}.notifications
           (recipient_type, category, title, body, link, related_table, related_id, priority)
         VALUES ('all-managers','recruit_hire',$1,$2,$3,'staff',$4,'normal')`,
        [`New starter created`, `${firstName} ${lastName} hired — ${inductionNote}. Complete their staff profile.`,
         `/staff.html?id=${staff.id}`, staff.id]);
    } catch (_) {}

    res.status(201).json({
      ok: true, staff_id: staff.id, staff_name: `${staff.first_name} ${staff.last_name}`,
      induction_assignment_id: assignmentId, induction_template: templateName, induction_note: inductionNote,
    });
  } catch (e) { console.error('[recruit] hire:', e.message); res.status(500).json({ error: 'Hire failed: ' + e.message }); }
});

module.exports = router;
