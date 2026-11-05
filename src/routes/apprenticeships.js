'use strict';
/**
 * b317 — apprenticeships and the off-the-job training log.
 *
 * Mounted at /api/apprenticeships on every portal (Roost, HR, EY), because the
 * three people who touch this record sign in to three different ones: the
 * manager on Roost, the apprentice on HR, and the mentor on whichever they have
 * open when they finish teaching something.
 *
 * ── WHAT THIS EXISTS FOR ────────────────────────────────────────────────────
 * Toby, 2026-09-11: "childcare is so practical, most of it is just staff showing
 * you when you're on ratio". That is not a problem with the training — practical
 * training, shadowing and mentoring are all eligible off-the-job training under
 * the funding rules. It is a problem with the RECORD: none of it is written
 * down, so at the end of the year none of it can be evidenced.
 *
 * So the design point is not the log, it is WHERE the log gets written. An entry
 * form on a screen nobody opens collects nothing. The workbook route below
 * (POST /workbook-offer/:progressId) exists so that the moment a room leader
 * signs off an induction item — the moment the teaching actually happened — one
 * tap turns it into evidence, pre-filled.
 *
 * ── WHO CAN SEE IT ──────────────────────────────────────────────────────────
 * A training record is staff data. Three people, and nobody else:
 *   - a manager
 *   - the apprentice themselves
 *   - their NAMED mentor (apprenticeships.mentor_staff_id)
 * Not "any room leader", not "anyone in the room". When an apprenticeship is
 * created for somebody who already has an induction assignment, the mentor
 * defaults to that assignment's room leader, because in practice that is who it
 * is — but it is then a named, visible, changeable fact rather than an implicit
 * one, and the person it names is the only one the offer appears for.
 *
 * ── WHAT THIS NEVER DOES ────────────────────────────────────────────────────
 * It never emails a training record anywhere. Export is a download the manager
 * asks for and hands to the provider. There is no Swift integration and this
 * build does not invent one: Swift publishes nothing about an employer portal or
 * an API, and an integration written against a guess is worse than a CSV.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const R = require('../lib/otj-rules');
const PDFDoc = require('pdfkit');

router.use(authenticate);

// ── who is who ──────────────────────────────────────────────────────────────
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];
function isManager(user) {
  if (!user) return false;
  if (Number(user.id) === 1) return true;
  return MANAGER_ROLES.includes(String(user.role_original || user.role || ''));
}
function uid(req) { return Number(req.user && req.user.id); }
function requireManager(req, res, next) {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Manager only' });
  next();
}

/** The three-person rule, in one place. */
function canSee(user, app) {
  if (!app) return false;
  if (isManager(user)) return true;
  const me = Number(user && user.id);
  return Number(app.staff_id) === me || Number(app.mentor_staff_id) === me;
}

// ── shared SQL ──────────────────────────────────────────────────────────────
// logged_minutes is computed in the SELECT rather than kept as a running total
// on the row: a total that is maintained is a total that can drift, and this is
// the number a funding auditor adds up themselves.
const APP_SELECT = `
  SELECT a.*,
         s.first_name || ' ' || s.last_name              AS staff_name,
         s.date_of_birth                                 AS staff_dob,
         s.role                                          AS staff_role,
         rm.name                                         AS room_name,
         m.first_name || ' ' || m.last_name              AS mentor_name,
         st.title                                        AS standard_name,
         st.min_otj_hours                                AS standard_min_hours,
         st.source_url                                   AS standard_source_url,
         st.retrieved_on                                 AS standard_retrieved_on,
         st.typical_duration_months                      AS standard_duration_months,
         COALESCE((SELECT sum(e.minutes) FROM otj_entries e
                    WHERE e.apprenticeship_id = a.id), 0)::int AS logged_minutes,
         COALESCE((SELECT count(*) FROM otj_entries e
                    WHERE e.apprenticeship_id = a.id), 0)::int AS entry_count,
         (SELECT max(e.entry_date) FROM otj_entries e
                    WHERE e.apprenticeship_id = a.id)          AS last_entry_date
    FROM apprenticeships a
    JOIN staff s        ON s.id  = a.staff_id
    LEFT JOIN staff m   ON m.id  = a.mentor_staff_id
    LEFT JOIN rooms rm  ON rm.id = s.room_id
    LEFT JOIN apprenticeship_standards st ON st.code = a.standard_code
`;

const ENTRY_SELECT = `
  SELECT e.*,
         d.first_name || ' ' || d.last_name AS delivered_by_name,
         v.first_name || ' ' || v.last_name AS verified_by_name,
         c.first_name || ' ' || c.last_name AS created_by_name
    FROM otj_entries e
    LEFT JOIN staff d ON d.id = e.delivered_by
    LEFT JOIN staff v ON v.id = e.verified_by
    LEFT JOIN staff c ON c.id = e.created_by
`;

function ymd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  // pg returns DATE as a local-midnight JS Date — toISOString() would shift it
  // back a day in BST. Read the local parts.
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function todayYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
}

/** Attach the derived progress block. Never invents a target. */
function withProgress(row) {
  const p = R.progress({
    targetHours: row.otj_target_hours,
    loggedMinutes: row.logged_minutes,
    endDate: ymd(row.expected_end_date),
    today: todayYmd(),
    plannedWeekly: row.planned_weekly_hours,
  });
  const age = R.ageOn(ymd(row.staff_dob), todayYmd());
  return Object.assign({}, row, {
    start_date: ymd(row.start_date),
    expected_end_date: ymd(row.expected_end_date),
    last_entry_date: ymd(row.last_entry_date),
    standard_retrieved_on: ymd(row.standard_retrieved_on),
    staff_dob: undefined,                  // a date of birth is not this screen's business
    staff_age: age,
    is_young_worker: age != null && age < 18,
    progress: p,
  });
}

async function loadApp(db, id) {
  const { rows } = await db.query(`${APP_SELECT} WHERE a.id = $1`, [id]);
  return rows[0] || null;
}

// ════════════════════════════════════════════════════════════════════════════
// THE RULES — served, never hard-coded in a page
// ════════════════════════════════════════════════════════════════════════════
// The activity lists, the reasons an activity is refused, the 187 floor and the
// young-worker limits all come from here, so a screen cannot drift away from
// what the API actually enforces, and the refusal text a user reads is the same
// string in both places.
router.get('/rules', (req, res) => {
  res.json({
    floor_hours: R.OTJ_FLOOR_HOURS,
    activity_types: R.ACTIVITY_TYPES,
    excluded_types: R.EXCLUDED_TYPES,
    young_worker: R.YOUNG_WORKER,
    provider_note: 'Ask Swift which e-portfolio they use (OneFile, Aptem, Bud, Smart Assessor…) — several have APIs, and if theirs does, this can feed it directly. Until then, export and hand them the file.',
    sources: [
      { what: 'What counts, what does not, paid hours, and the evidence tests',
        url: 'https://www.gov.uk/government/publications/apprenticeships-off-the-job-training' },
      { what: 'The 187-hour floor and prior learning',
        url: 'https://www.gov.uk/guidance/apprenticeship-funding-rules' },
      { what: 'Young-worker limits',
        url: 'https://www.legislation.gov.uk/uksi/1998/1833' },
    ],
  });
});

// ════════════════════════════════════════════════════════════════════════════
// STANDARDS — the published minimum hours, each with the URL it came from
// ════════════════════════════════════════════════════════════════════════════
router.get('/standards', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT code, title, level, version, min_otj_hours, typical_duration_months,
              source_url, retrieved_on, is_active
         FROM apprenticeship_standards
        WHERE is_active = true OR $1 = true
        ORDER BY level NULLS LAST, title`, [String(req.query.all || '') === '1']);
    res.json({
      count: rows.length,
      standards: rows.map(r => Object.assign({}, r, { retrieved_on: ymd(r.retrieved_on) })),
      note: 'min_otj_hours is the figure the standard itself publishes ("Minimum hours for compliance"). Where it is null, Wren has not verified one — take it from the training plan rather than assuming a percentage. The 20% rule ended on 1 August 2025.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Add or correct a standard. A manager may add one Wren does not ship, but the
// source URL is required with the hours — an unsourced figure is a guess, and a
// guess here is what the whole build exists to avoid.
router.post('/standards', requireManager, async (req, res) => {
  try {
    const b = req.body || {};
    const code = String(b.code || '').trim().toUpperCase();
    if (!/^ST\d{3,5}$/.test(code)) return res.status(400).json({ error: 'code must look like ST0135.' });
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title is required.' });
    const hours = (b.min_otj_hours === '' || b.min_otj_hours == null) ? null : parseInt(b.min_otj_hours, 10);
    if (hours != null && (!isFinite(hours) || hours <= 0)) {
      return res.status(400).json({ error: 'min_otj_hours must be a whole number of hours, or left blank.' });
    }
    const src = String(b.source_url || '').trim();
    if (hours != null && !/^https?:\/\//i.test(src)) {
      return res.status(400).json({
        error: 'Where did that figure come from? A source URL is required alongside published hours — the standard\'s page on the Skills England site carries it as "Minimum hours for compliance".',
      });
    }
    const { rows } = await getPool().query(`
      INSERT INTO apprenticeship_standards
        (code, title, level, version, min_otj_hours, typical_duration_months, source_url, retrieved_on)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, CURRENT_DATE))
      ON CONFLICT (code) DO UPDATE SET
        title = EXCLUDED.title, level = EXCLUDED.level, version = EXCLUDED.version,
        min_otj_hours = EXCLUDED.min_otj_hours,
        typical_duration_months = EXCLUDED.typical_duration_months,
        source_url = EXCLUDED.source_url, retrieved_on = EXCLUDED.retrieved_on
      RETURNING *`,
      [code, title,
       b.level == null || b.level === '' ? null : parseInt(b.level, 10),
       b.version ? String(b.version).trim() : null,
       hours,
       b.typical_duration_months == null || b.typical_duration_months === '' ? null : parseInt(b.typical_duration_months, 10),
       src || null,
       b.retrieved_on ? String(b.retrieved_on).slice(0, 10) : null]);
    res.status(201).json(Object.assign({}, rows[0], { retrieved_on: ymd(rows[0].retrieved_on) }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// THE WORKBOOK OFFER — the piece that makes the rest of it get used
// ════════════════════════════════════════════════════════════════════════════
// Registered BEFORE /:id so 'workbook-offer' stays a literal path segment.

/**
 * GET /workbook-offer/:progressId
 * "This item has just been signed off. Is there an off-the-job entry in it?"
 *
 * Returns { offer: false, reason } when there is not — the caller shows nothing.
 * Returns { offer: true, prefill: {...} } when there is, with minutes and the
 * "what was new" line already filled in from the item, so recording it is one
 * tap and an optional correction rather than a form.
 */
router.get('/workbook-offer/:progressId', async (req, res) => {
  try {
    const db = getPool();
    const pid = parseInt(req.params.progressId, 10);
    if (!isFinite(pid)) return res.status(400).json({ error: 'Bad progress id' });

    const ctx = await workbookContext(db, pid);
    if (!ctx.ok) return res.json({ offer: false, reason: ctx.reason });
    if (!canSee(req.user, ctx.app)) return res.json({ offer: false, reason: 'not_permitted' });

    const { rows: dup } = await db.query(
      `SELECT id, minutes FROM otj_entries WHERE source = 'workbook' AND source_ref = $1`, [pid]);
    if (dup.length) {
      return res.json({
        offer: false, reason: 'already_recorded', entry_id: dup[0].id,
        message: `Already recorded as ${Math.round(dup[0].minutes / 6) / 10} hours of off-the-job training.`,
      });
    }

    res.json({
      offer: true,
      apprenticeship_id: ctx.app.id,
      staff_name: ctx.app.staff_name,
      prefill: {
        entry_date: ymd(ctx.progress.signed_off_at || ctx.progress.completed_at) || todayYmd(),
        minutes: ctx.item.otj_minutes || 30,
        activity_type: 'practical',
        delivery_method: 'Taught on the floor',
        ksb_ref: ctx.item.section || null,
        what_was_new: ctx.item.description
          ? String(ctx.item.description).trim().slice(0, 400)
          : `Taught and signed off: ${ctx.item.title}`,
        delivered_by: ctx.progress.signed_off_by || uid(req),
        in_paid_hours: true,
      },
      item_title: ctx.item.title,
      note: 'Check the minutes and say what was new in your own words — that line is the evidence.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * POST /workbook-offer/:progressId
 * Take the offer. One action, one entry, verified by the person who signed the
 * item off — which is exactly what the evidence needs to name.
 *
 * The unique index on (source_ref) where source='workbook' means pressing this
 * twice is a 409 rather than two hours in the total.
 */
router.post('/workbook-offer/:progressId', async (req, res) => {
  try {
    const db = getPool();
    const pid = parseInt(req.params.progressId, 10);
    if (!isFinite(pid)) return res.status(400).json({ error: 'Bad progress id' });

    const ctx = await workbookContext(db, pid);
    if (!ctx.ok) return res.status(400).json({ error: workbookReasonText(ctx.reason) });
    if (!canSee(req.user, ctx.app)) {
      return res.status(403).json({ error: "Only a manager, the apprentice or their named mentor can record off-the-job training." });
    }

    const body = Object.assign({
      entry_date: ymd(ctx.progress.signed_off_at || ctx.progress.completed_at) || todayYmd(),
      minutes: ctx.item.otj_minutes || 30,
      activity_type: 'practical',
      what_was_new: ctx.item.description || `Taught and signed off: ${ctx.item.title}`,
      ksb_ref: ctx.item.section || null,
      delivery_method: 'Taught on the floor',
      in_paid_hours: true,
    }, req.body || {});

    const v = R.validateEntry(body);
    if (!v.ok) return res.status(400).json({ error: v.error, field: v.field, rule: v.rule });

    // WHO VERIFIED IT. An item SIGNED OFF is verified by whoever signed it — that
    // is what a sign-off is. An item the starter merely ticked 'done' on their own
    // workbook is not verified by anybody yet, and it must not be verified by
    // them: an apprentice cannot confirm their own hours, which is the same rule
    // POST /:id/entries and PATCH /entries/:id already enforce. Falling back to
    // uid(req) here made a starter's own tick self-verifying — found by
    // scripts/b317-render-probe.js against the real HR page, 2026-09-11.
    const selfLogged = Number(ctx.app.staff_id) === uid(req) && !isManager(req.user);
    const verifier = ctx.progress.signed_off_by || (selfLogged ? null : uid(req));
    // Likewise: the starter did not deliver their own training. Where nobody
    // signed the item off and none was named, leave it blank rather than
    // recording the apprentice as their own trainer.
    const deliveredBy = pickStaffId(body.delivered_by)
      || ctx.progress.signed_off_by
      || (selfLogged ? null : uid(req));

    const { rows } = await db.query(`
      INSERT INTO otj_entries
        (apprenticeship_id, staff_id, entry_date, minutes, activity_type, delivery_method,
         ksb_ref, what_was_new, delivered_by, in_paid_hours, compensated, compensation_note,
         verified_by, verified_at, source, source_ref, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'workbook',$15,$16)
      RETURNING id`,
      [ctx.app.id, ctx.app.staff_id, v.value.entry_date, v.value.minutes, v.value.activity_type,
       v.value.delivery_method, v.value.ksb_ref, v.value.what_was_new, deliveredBy,
       v.value.in_paid_hours, v.value.compensated, v.value.compensation_note,
       verifier, verifier ? new Date() : null, pid, uid(req)]);

    const fresh = await loadApp(db, ctx.app.id);
    res.status(201).json({
      entry_id: rows[0].id,
      apprenticeship: withProgress(fresh),
      awaiting_verification: !verifier,
    });
  } catch (e) {
    if (String(e.code) === '23505') {
      return res.status(409).json({ error: 'That workbook item has already been recorded as off-the-job training.' });
    }
    res.status(500).json({ error: e.message });
  }
});

/** Everything the offer needs, or the reason there is no offer. */
async function workbookContext(db, progressId) {
  const { rows } = await db.query(`
    SELECT ip.id AS progress_id, ip.status, ip.completed_at, ip.signed_off_at, ip.signed_off_by,
           ti.id AS item_id, ti.title, ti.description, ti.section, ti.item_type,
           COALESCE(ti.otj_eligible, true) AS otj_eligible, ti.otj_minutes,
           ia.staff_id
      FROM induction_item_progress ip
      JOIN induction_template_items ti ON ti.id = ip.item_id
      JOIN induction_assignments ia    ON ia.id = ip.assignment_id
     WHERE ip.id = $1`, [progressId]);
  if (!rows.length) return { ok: false, reason: 'no_such_item' };
  const r = rows[0];
  if (r.status !== 'signed_off' && r.status !== 'done') return { ok: false, reason: 'not_complete' };
  if (r.otj_eligible === false) return { ok: false, reason: 'not_eligible' };

  const { rows: apps } = await db.query(
    `${APP_SELECT} WHERE a.staff_id = $1 AND a.status = 'active'`, [r.staff_id]);
  if (!apps.length) return { ok: false, reason: 'not_an_apprentice' };

  return { ok: true, progress: r, item: r, app: apps[0] };
}

function workbookReasonText(reason) {
  return ({
    no_such_item: 'That workbook item does not exist.',
    not_complete: 'That workbook item has not been completed or signed off yet.',
    not_eligible: 'That workbook item is not off-the-job training — onboarding, paperwork and policy acknowledgements do not count.',
    not_an_apprentice: 'That member of staff has no active apprenticeship record.',
    not_permitted: 'Not permitted.',
  })[reason] || 'No off-the-job entry can be made from that item.';
}

function pickStaffId(v) {
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : null;
}

// ════════════════════════════════════════════════════════════════════════════
// YOUNG WORKERS — who on the payroll is under 18, and what the limits are
// ════════════════════════════════════════════════════════════════════════════
// Registered before /:id. Manager-only: a date of birth is not open data, and
// this returns nothing but the age and the flag, never the date itself.
router.get('/young-workers', requireManager, async (req, res) => {
  try {
    const today = todayYmd();
    const { rows } = await getPool().query(`
      SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.role,
             s.date_of_birth, rm.name AS room_name
        FROM staff s LEFT JOIN rooms rm ON rm.id = s.room_id
       WHERE s.is_active = true
         AND COALESCE(s.terminated, false) = false
         AND s.date_of_birth IS NOT NULL
         AND s.date_of_birth > (CURRENT_DATE - INTERVAL '18 years')
       ORDER BY s.date_of_birth DESC`);
    res.json({
      count: rows.length,
      limits: R.YOUNG_WORKER,
      staff: rows.map(r => ({
        id: r.id, name: r.name, role: r.role, room_name: r.room_name,
        age: R.ageOn(ymd(r.date_of_birth), today),
        // The date they stop being a young worker — the rota stops warning then.
        eighteenth: addYears(ymd(r.date_of_birth), 18),
      })),
      note: 'Staff with no date of birth recorded cannot be checked. The rota warns only where a date of birth is on file.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function addYears(ymdStr, n) {
  if (!ymdStr) return null;
  const [y, m, d] = ymdStr.split('-').map(Number);
  return `${y + n}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ════════════════════════════════════════════════════════════════════════════
// THE APPRENTICESHIPS
// ════════════════════════════════════════════════════════════════════════════

/** GET / — every apprenticeship the caller may see. */
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const mgr = isManager(req.user);
    const params = [];
    let where = '';
    if (!mgr) {
      params.push(uid(req));
      where = 'WHERE (a.staff_id = $1 OR a.mentor_staff_id = $1)';
    } else if (String(req.query.status || '') === 'active') {
      where = "WHERE a.status = 'active'";
    }
    const { rows } = await db.query(
      `${APP_SELECT} ${where} ORDER BY (a.status = 'active') DESC, a.start_date DESC NULLS LAST, a.id DESC`,
      params);
    res.json({ count: rows.length, apprenticeships: rows.map(withProgress) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** POST / — start an apprentice record. Manager only. */
router.post('/', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const b = req.body || {};
    const staffId = pickStaffId(b.staff_id);
    if (!staffId) return res.status(400).json({ error: 'staff_id is required.' });

    const { rows: st } = await db.query('SELECT id FROM staff WHERE id = $1', [staffId]);
    if (!st.length) return res.status(400).json({ error: 'No such member of staff.' });

    // The target: the standard's published figure less recorded prior learning,
    // floored at 187. An explicit value in the body wins, but is still floored.
    const prior = Math.max(0, Number(b.prior_learning_hours) || 0);
    let target = null;
    if (b.otj_target_hours !== undefined && b.otj_target_hours !== null && b.otj_target_hours !== '') {
      const t = R.validateTarget(b.otj_target_hours);
      if (!t.ok) return res.status(400).json({ error: t.error, field: 'otj_target_hours' });
      target = t.value;
    } else if (b.standard_code) {
      const { rows: std } = await db.query(
        'SELECT min_otj_hours FROM apprenticeship_standards WHERE code = $1', [String(b.standard_code).trim().toUpperCase()]);
      target = R.computeTarget(std.length ? std[0].min_otj_hours : null, prior).hours;
    }

    // The mentor defaults to whoever already leads this person's induction —
    // in practice the same person, and naming them is what lets the workbook
    // offer appear for them at all.
    let mentor = pickStaffId(b.mentor_staff_id);
    if (!mentor) {
      const { rows: lead } = await db.query(
        `SELECT room_leader_id FROM induction_assignments
          WHERE staff_id = $1 AND room_leader_id IS NOT NULL
          ORDER BY id DESC LIMIT 1`, [staffId]);
      if (lead.length) mentor = lead[0].room_leader_id;
    }

    const { rows } = await db.query(`
      INSERT INTO apprenticeships
        (staff_id, standard_code, standard_title, level, provider, start_date, expected_end_date,
         otj_target_hours, prior_learning_hours, planned_weekly_hours, mentor_staff_id,
         status, eportfolio, notes, created_by)
      VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,''),'Swift'),$6,$7,$8,$9,$10,$11,
              COALESCE(NULLIF($12,''),'active'),$13,$14,$15)
      RETURNING id`,
      [staffId,
       b.standard_code ? String(b.standard_code).trim().toUpperCase() : null,
       b.standard_title ? String(b.standard_title).trim() : null,
       b.level == null || b.level === '' ? null : parseInt(b.level, 10),
       b.provider ? String(b.provider).trim() : '',
       b.start_date ? String(b.start_date).slice(0, 10) : null,
       b.expected_end_date ? String(b.expected_end_date).slice(0, 10) : null,
       target, prior,
       b.planned_weekly_hours == null || b.planned_weekly_hours === '' ? null : Number(b.planned_weekly_hours),
       mentor,
       b.status ? String(b.status).trim() : '',
       b.eportfolio ? String(b.eportfolio).trim() : null,
       b.notes ? String(b.notes).trim() : null,
       uid(req)]);

    res.status(201).json(withProgress(await loadApp(db, rows[0].id)));
  } catch (e) {
    if (String(e.code) === '23505') {
      return res.status(409).json({ error: 'That member of staff already has an active apprenticeship record.' });
    }
    if (String(e.code) === '23514' && /target_floor/.test(e.constraint || '')) {
      return res.status(400).json({ error: `An off-the-job target cannot be below ${R.OTJ_FLOOR_HOURS} hours.` });
    }
    res.status(500).json({ error: e.message });
  }
});

/** GET /:id — one apprenticeship, with its progress block. */
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!isFinite(id)) return res.status(400).json({ error: 'Bad id' });
    const app = await loadApp(getPool(), id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (!canSee(req.user, app)) return res.status(403).json({ error: 'Forbidden' });
    res.json(withProgress(app));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** PATCH /:id — manager only. */
router.patch('/:id', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const app = await loadApp(db, id);
    if (!app) return res.status(404).json({ error: 'Not found' });

    const b = req.body || {};
    const sets = [], params = [];
    let p = 1;
    const set = (col, val) => { sets.push(`${col} = $${p++}`); params.push(val); };

    if (b.standard_code !== undefined) set('standard_code', b.standard_code ? String(b.standard_code).trim().toUpperCase() : null);
    if (b.standard_title !== undefined) set('standard_title', b.standard_title ? String(b.standard_title).trim() : null);
    if (b.level !== undefined) set('level', b.level === '' || b.level == null ? null : parseInt(b.level, 10));
    if (b.provider !== undefined) set('provider', String(b.provider || 'Swift').trim() || 'Swift');
    if (b.start_date !== undefined) set('start_date', b.start_date ? String(b.start_date).slice(0, 10) : null);
    if (b.expected_end_date !== undefined) set('expected_end_date', b.expected_end_date ? String(b.expected_end_date).slice(0, 10) : null);
    if (b.planned_weekly_hours !== undefined) set('planned_weekly_hours', b.planned_weekly_hours === '' || b.planned_weekly_hours == null ? null : Number(b.planned_weekly_hours));
    if (b.mentor_staff_id !== undefined) set('mentor_staff_id', pickStaffId(b.mentor_staff_id));
    if (b.eportfolio !== undefined) set('eportfolio', b.eportfolio ? String(b.eportfolio).trim() : null);
    if (b.notes !== undefined) set('notes', b.notes ? String(b.notes).trim() : null);
    if (b.status !== undefined) {
      const s = String(b.status).trim();
      if (!['active', 'completed', 'withdrawn', 'paused'].includes(s)) {
        return res.status(400).json({ error: 'status must be active, completed, withdrawn or paused.' });
      }
      set('status', s);
    }
    if (b.prior_learning_hours !== undefined) {
      const pl = Number(b.prior_learning_hours);
      if (!isFinite(pl) || pl < 0) return res.status(400).json({ error: 'prior_learning_hours must be zero or more.' });
      set('prior_learning_hours', pl);
    }
    if (b.otj_target_hours !== undefined) {
      const t = R.validateTarget(b.otj_target_hours);
      if (!t.ok) return res.status(400).json({ error: t.error, field: 'otj_target_hours' });
      set('otj_target_hours', t.value);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update.' });

    sets.push('updated_at = now()');
    params.push(id);
    await db.query(`UPDATE apprenticeships SET ${sets.join(', ')} WHERE id = $${p}`, params);
    res.json(withProgress(await loadApp(db, id)));
  } catch (e) {
    if (String(e.code) === '23505') {
      return res.status(409).json({ error: 'That member of staff already has another active apprenticeship record.' });
    }
    if (String(e.code) === '23514' && /target_floor/.test(e.constraint || '')) {
      return res.status(400).json({ error: `An off-the-job target cannot be below ${R.OTJ_FLOOR_HOURS} hours.` });
    }
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /:id/recompute-target — set the target from the standard and the recorded
 * prior learning, and say what it did. Separate from PATCH because it is a
 * DECISION with a reason, not a field edit, and the reason is worth showing.
 */
router.post('/:id/recompute-target', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const app = await loadApp(db, id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    const t = R.computeTarget(app.standard_min_hours, app.prior_learning_hours);
    if (t.hours == null) {
      return res.status(400).json({
        error: 'No published figure is on file for that standard, so a target cannot be worked out. Add the standard with its hours and source URL first, or enter the target from the training plan.',
      });
    }
    await db.query('UPDATE apprenticeships SET otj_target_hours = $1, updated_at = now() WHERE id = $2', [t.hours, id]);
    res.json({ target: t, apprenticeship: withProgress(await loadApp(db, id)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// THE LOG
// ════════════════════════════════════════════════════════════════════════════

/** GET /:id/entries[?from=&to=] */
router.get('/:id/entries', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const app = await loadApp(db, id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (!canSee(req.user, app)) return res.status(403).json({ error: 'Forbidden' });

    const { where, params } = dateRange(id, req.query);
    const { rows } = await db.query(
      `${ENTRY_SELECT} ${where} ORDER BY e.entry_date DESC, e.id DESC`, params);
    res.json({
      count: rows.length,
      total_minutes: rows.reduce((a, r) => a + r.minutes, 0),
      entries: rows.map(r => Object.assign({}, r, { entry_date: ymd(r.entry_date) })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function dateRange(appId, q) {
  const params = [appId];
  let where = 'WHERE e.apprenticeship_id = $1';
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.from || ''))) { params.push(String(q.from).slice(0, 10)); where += ` AND e.entry_date >= $${params.length}`; }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.to || '')))   { params.push(String(q.to).slice(0, 10));   where += ` AND e.entry_date <= $${params.length}`; }
  return { where, params };
}

/** POST /:id/entries — record off-the-job training. */
router.post('/:id/entries', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const app = await loadApp(db, id);
    if (!app) return res.status(404).json({ error: 'Not found' });
    if (!canSee(req.user, app)) {
      return res.status(403).json({ error: 'Only a manager, the apprentice or their named mentor can record off-the-job training.' });
    }

    const v = R.validateEntry(req.body || {});
    if (!v.ok) return res.status(400).json({ error: v.error, field: v.field, rule: v.rule });

    // The apprentice's own entry is not self-verifying. A manager or the mentor
    // recording it verifies it in the same action; the apprentice's waits.
    const selfLogged = Number(app.staff_id) === uid(req) && !isManager(req.user);
    const b = req.body || {};
    const { rows } = await db.query(`
      INSERT INTO otj_entries
        (apprenticeship_id, staff_id, entry_date, minutes, activity_type, delivery_method,
         ksb_ref, what_was_new, delivered_by, in_paid_hours, compensated, compensation_note,
         verified_by, verified_at, source, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'manual',$15)
      RETURNING id`,
      [id, app.staff_id, v.value.entry_date, v.value.minutes, v.value.activity_type,
       v.value.delivery_method, v.value.ksb_ref, v.value.what_was_new,
       pickStaffId(b.delivered_by), v.value.in_paid_hours, v.value.compensated,
       v.value.compensation_note,
       selfLogged ? null : uid(req), selfLogged ? null : new Date(),
       uid(req)]);

    const { rows: full } = await db.query(`${ENTRY_SELECT} WHERE e.id = $1`, [rows[0].id]);
    res.status(201).json({
      entry: Object.assign({}, full[0], { entry_date: ymd(full[0].entry_date) }),
      apprenticeship: withProgress(await loadApp(db, id)),
      awaiting_verification: selfLogged,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/**
 * PATCH /entries/:entryId — correct an entry, or verify it.
 * Registered after the /:id routes but with its own literal prefix, so there is
 * no collision: '/entries/12' cannot match '/:id/entries'.
 */
router.patch('/entries/:entryId', async (req, res) => {
  try {
    const db = getPool();
    const eid = parseInt(req.params.entryId, 10);
    const { rows: er } = await db.query('SELECT * FROM otj_entries WHERE id = $1', [eid]);
    if (!er.length) return res.status(404).json({ error: 'Entry not found' });
    const entry = er[0];
    const app = await loadApp(db, entry.apprenticeship_id);
    if (!canSee(req.user, app)) return res.status(403).json({ error: 'Forbidden' });

    const b = req.body || {};

    // Verifying is its own act, and the apprentice cannot verify their own.
    if (b.verified !== undefined) {
      if (Number(app.staff_id) === uid(req) && !isManager(req.user)) {
        return res.status(403).json({ error: 'An apprentice cannot verify their own off-the-job training. Your manager or your mentor confirms it.' });
      }
      if (b.verified) {
        await db.query('UPDATE otj_entries SET verified_by = $1, verified_at = now() WHERE id = $2', [uid(req), eid]);
      } else {
        await db.query('UPDATE otj_entries SET verified_by = NULL, verified_at = NULL WHERE id = $1', [eid]);
      }
    }

    // Any field edit re-runs the whole rule set against the merged row, so an
    // entry cannot be edited INTO a shape the create path would have refused.
    const touched = ['entry_date', 'minutes', 'activity_type', 'delivery_method', 'ksb_ref',
                     'what_was_new', 'in_paid_hours', 'compensated', 'compensation_note']
      .some(k => b[k] !== undefined);
    if (touched) {
      const merged = {
        entry_date: b.entry_date !== undefined ? b.entry_date : ymd(entry.entry_date),
        minutes: b.minutes !== undefined ? b.minutes : entry.minutes,
        activity_type: b.activity_type !== undefined ? b.activity_type : entry.activity_type,
        delivery_method: b.delivery_method !== undefined ? b.delivery_method : entry.delivery_method,
        ksb_ref: b.ksb_ref !== undefined ? b.ksb_ref : entry.ksb_ref,
        what_was_new: b.what_was_new !== undefined ? b.what_was_new : entry.what_was_new,
        in_paid_hours: b.in_paid_hours !== undefined ? b.in_paid_hours : entry.in_paid_hours,
        compensated: b.compensated !== undefined ? b.compensated : entry.compensated,
        compensation_note: b.compensation_note !== undefined ? b.compensation_note : entry.compensation_note,
      };
      const v = R.validateEntry(merged);
      if (!v.ok) return res.status(400).json({ error: v.error, field: v.field, rule: v.rule });
      await db.query(`
        UPDATE otj_entries SET entry_date=$1, minutes=$2, activity_type=$3, delivery_method=$4,
               ksb_ref=$5, what_was_new=$6, in_paid_hours=$7, compensated=$8, compensation_note=$9
         WHERE id=$10`,
        [v.value.entry_date, v.value.minutes, v.value.activity_type, v.value.delivery_method,
         v.value.ksb_ref, v.value.what_was_new, v.value.in_paid_hours, v.value.compensated,
         v.value.compensation_note, eid]);
    }

    if (b.delivered_by !== undefined) {
      await db.query('UPDATE otj_entries SET delivered_by = $1 WHERE id = $2', [pickStaffId(b.delivered_by), eid]);
    }

    const { rows: full } = await db.query(`${ENTRY_SELECT} WHERE e.id = $1`, [eid]);
    res.json({
      entry: Object.assign({}, full[0], { entry_date: ymd(full[0].entry_date) }),
      apprenticeship: withProgress(await loadApp(db, entry.apprenticeship_id)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** DELETE /entries/:entryId — manager only. */
router.delete('/entries/:entryId', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const eid = parseInt(req.params.entryId, 10);
    const { rows } = await db.query('DELETE FROM otj_entries WHERE id = $1 RETURNING apprenticeship_id', [eid]);
    if (!rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json({ deleted: true, id: eid, apprenticeship: withProgress(await loadApp(db, rows[0].apprenticeship_id)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// EXPORT — for Swift, as a download. Never emailed anywhere.
// ════════════════════════════════════════════════════════════════════════════

async function exportData(db, id, q) {
  const app = await loadApp(db, id);
  if (!app) return null;
  const { where, params } = dateRange(id, q);
  const { rows } = await db.query(`${ENTRY_SELECT} ${where} ORDER BY e.entry_date, e.id`, params);
  return { app: withProgress(app), entries: rows };
}

const TYPE_LABEL = new Map(R.ACTIVITY_TYPES.map(t => [t.key, t.label]));

router.get('/:id/export.csv', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const data = await exportData(db, id, req.query);
    if (!data) return res.status(404).json({ error: 'Not found' });
    if (!canSee(req.user, data.app)) return res.status(403).json({ error: 'Forbidden' });

    const esc = v => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [];
    lines.push(['Apprentice', 'Standard', 'Level', 'Provider', 'Start', 'Expected end', 'Target hours', 'Hours logged']
      .map(esc).join(','));
    lines.push([data.app.staff_name,
                data.app.standard_name || data.app.standard_title || '',
                data.app.level || '', data.app.provider,
                data.app.start_date || '', data.app.expected_end_date || '',
                data.app.otj_target_hours == null ? 'not set' : data.app.otj_target_hours,
                data.app.progress.logged].map(esc).join(','));
    lines.push('');
    // Every column here is one of the evidence fields a funding auditor asks for.
    lines.push(['Date', 'Hours', 'Minutes', 'Activity type', 'Delivery method', 'KSB / area',
                'What was new (evidence)', 'Delivered by', 'In paid hours', 'Compensated',
                'Compensation', 'Verified by', 'Verified on', 'Recorded from']
      .map(esc).join(','));
    for (const e of data.entries) {
      lines.push([
        ymd(e.entry_date),
        (Math.round((e.minutes / 60) * 100) / 100).toFixed(2),
        e.minutes,
        TYPE_LABEL.get(e.activity_type) || e.activity_type,
        e.delivery_method || '',
        e.ksb_ref || '',
        e.what_was_new,
        e.delivered_by_name || '',
        e.in_paid_hours ? 'Yes' : 'No',
        e.compensated ? 'Yes' : 'No',
        e.compensation_note || '',
        e.verified_by_name || '',
        e.verified_at ? ymd(e.verified_at) : '',
        e.source === 'workbook' ? 'Workbook sign-off' : 'Entered',
      ].map(esc).join(','));
    }
    const totalMins = data.entries.reduce((a, e) => a + e.minutes, 0);
    lines.push(['TOTAL', (Math.round((totalMins / 60) * 100) / 100).toFixed(2), totalMins].map(esc).join(','));

    const slug = String(data.app.staff_name || 'apprentice').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="otj-${slug}-${todayYmd()}.csv"`,
    });
    res.send('﻿' + lines.join('\r\n'));   // BOM so Excel reads UTF-8
  } catch (e) { console.error('otj export.csv:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

router.get('/:id/export.pdf', async (req, res) => {
  try {
    const db = getPool();
    const id = parseInt(req.params.id, 10);
    const data = await exportData(db, id, req.query);
    if (!data) return res.status(404).json({ error: 'Not found' });
    if (!canSee(req.user, data.app)) return res.status(403).json({ error: 'Forbidden' });

    const a = data.app;
    const doc = new PDFDoc({ size: 'A4', layout: 'landscape', margins: { top: 38, bottom: 46, left: 36, right: 36 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    doc.fontSize(16).fillColor('#0f172a').font('Helvetica-Bold')
      .text('Off-the-job training record');
    doc.moveDown(0.1).font('Helvetica').fontSize(10.5).fillColor('#1e293b')
      .text(`${a.staff_name} · ${a.standard_name || a.standard_title || 'Apprenticeship'}${a.level ? ' (Level ' + a.level + ')' : ''} · ${a.provider}`);
    const range = [req.query.from, req.query.to].filter(Boolean);
    doc.fontSize(9).fillColor('#475569').text(
      `${a.start_date || '—'} to ${a.expected_end_date || '—'}`
      + `   ·   Target ${a.otj_target_hours == null ? 'not set' : a.otj_target_hours + ' hours'}`
      + `   ·   Logged ${a.progress.logged} hours`
      + (a.progress.per_week_needed != null ? `   ·   ${a.progress.per_week_needed} h/week needed from here` : '')
      + (range.length ? `   ·   filtered ${range.join(' to ')}` : '')
      + `   ·   generated ${todayYmd()}`);
    doc.moveDown(0.5);

    const x0 = 36;
    const widths = [58, 38, 86, 70, 300, 86, 40, 52];
    const header = ['Date', 'Hours', 'Activity', 'KSB / area', 'What was new (evidence)', 'Delivered by', 'Paid hrs', 'Verified'];
    const tableW = widths.reduce((s, w) => s + w, 0);
    let y = doc.y;

    // Column heights vary because the evidence line wraps, so each row measures
    // itself before it is drawn. Paginating on the MEASURED height is what keeps
    // a long evidence line from running off the bottom of the page.
    const drawRow = (cells, opts = {}) => {
      doc.font(opts.head || opts.total ? 'Helvetica-Bold' : 'Helvetica').fontSize(opts.head ? 8 : 8.5);
      let h = 0;
      cells.forEach((c, i) => {
        h = Math.max(h, doc.heightOfString(String(c == null ? '' : c), { width: widths[i] - 8 }));
      });
      h = Math.max(h + 7, 18);
      if (y + h > 520 && !opts.head) {
        doc.addPage({ size: 'A4', layout: 'landscape', margins: { top: 38, bottom: 46, left: 36, right: 36 } });
        y = 38;
        drawRow(header, { head: true });
        doc.font('Helvetica').fontSize(8.5);
      }
      let x = x0;
      doc.fillColor(opts.head ? '#334155' : '#1e293b');
      cells.forEach((c, i) => {
        doc.text(String(c == null ? '' : c), x + 4, y + 3, { width: widths[i] - 8, align: i === 1 ? 'right' : 'left' });
        x += widths[i];
      });
      y += h;
      doc.moveTo(x0, y).lineTo(x0 + tableW, y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    };

    drawRow(header, { head: true });
    for (const e of data.entries) {
      drawRow([
        ymd(e.entry_date),
        (Math.round((e.minutes / 60) * 100) / 100).toFixed(2),
        TYPE_LABEL.get(e.activity_type) || e.activity_type,
        e.ksb_ref || '—',
        e.what_was_new + (e.in_paid_hours ? '' : ` [outside paid hours — compensated: ${e.compensation_note || 'yes'}]`),
        e.delivered_by_name || '—',
        e.in_paid_hours ? 'Yes' : 'No*',
        e.verified_by_name ? (e.verified_by_name.split(' ')[0]) : '—',
      ]);
    }
    const totalMins = data.entries.reduce((s, e) => s + e.minutes, 0);
    drawRow(['TOTAL', (Math.round((totalMins / 60) * 100) / 100).toFixed(2), `${data.entries.length} entries`, '', '', '', '', ''], { total: true });

    // The footnote is written INSIDE the bottom margin on the current page. A
    // text() call below the bottom margin auto-paginates and leaves a blank page
    // behind it (memory/reference_pdfkit_footer_adds_blank_pages.md).
    doc.font('Helvetica').fontSize(7.5).fillColor('#94a3b8')
      .text('Off-the-job training is training that teaches new knowledge, skills or behaviours relevant to the standard, delivered in the apprentice\'s normal working hours. '
          + 'Progress reviews, standalone English and maths, exams and initial assessment are excluded and cannot be recorded here. '
          + '*Where an entry falls outside normal working hours it is marked, with the compensation agreed. Hours shown are as recorded in Wren.',
        x0, Math.min(y + 10, 530), { width: tableW });

    doc.end();
    const buf = await done;
    const slug = String(a.staff_name || 'apprentice').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="otj-${slug}-${todayYmd()}.pdf"`,
      'Content-Length': buf.length,
    });
    res.send(buf);
  } catch (e) { console.error('otj export.pdf:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

module.exports = router;
