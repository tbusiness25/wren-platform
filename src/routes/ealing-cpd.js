'use strict';
/**
 * b322 — the Ealing CPD catalogue, and asking to go on a course.
 *
 * Mounted at /api/ealing-cpd on Roost, Nest (EY) and Seed (HR), because all
 * three people in this loop sign in somewhere different: the practitioner who
 * wants the course is on the EY tablet or HR, and the manager who has to find
 * cover is on Roost.
 *
 * ── WHAT TOBY ASKED FOR ─────────────────────────────────────────────────────
 * "if staff are interested they can press on a course look at what it contains
 * what dates it is And then ask to do it by clicking the button And then we sort
 * out staffing and say yes."
 *
 * The phrase that shapes this file is "we sort out staffing". A request that
 * lands on a manager as a bare name and a date makes them go and open the rota.
 * So GET /requests answers the staffing question IN the request: for every date
 * of the course it runs the same ratio engine the absence gatekeeper uses,
 * with the requesting staff member excluded, and says whether the floor still
 * works without them.
 *
 * ── APPROVAL IS NOT A BOOKING, AND THE CODE SAYS SO ─────────────────────────
 * Wren cannot book a place. ealingcpd.org.uk has no API and booking is behind a
 * login we are not going to automate against (Toby's rule: public course details
 * only, never scrape behind the login). Pretending otherwise would be the worst
 * possible failure here — a staff member who believes they have a place, and a
 * course that nobody actually booked.
 *
 * So the status ladder is explicit and the UI wording follows it:
 *   pending  → approved  → booked   → attended  → ladn.cpd_records
 *                declined            cancelled
 * 'approved' means "you may go, I will book it". 'booked' is a human action a
 * manager records after doing it on Ealing's site.
 *
 * ── PERMISSIONS ─────────────────────────────────────────────────────────────
 * Three capabilities, checked with requireCapabilityLevel (NOT hasCapability):
 * hasCapability ignores the level, so a 'view' grant would open the approve
 * route. Anyone who can view can look; 'edit' on .request can ask; 'approve' on
 * .manage can answer.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireCapabilityLevel, capabilityLevel } = require('../lib/capabilities');
const store = require('../lib/ealing-cpd-store');
const ratio = require('../services/ratio-engine');

// Every route below is authenticated. There is no global /api gate in
// server-unified.js — each router mounts its own — and without this line
// req.user is undefined, capabilityLevel(undefined) returns null, and every
// route 403s including the ones a manager should pass. It fails closed, which
// is the right direction, but it fails closed for everybody.
router.use(authenticate);

const CAP_VIEW = 'cpd-catalogue.view';
const CAP_REQUEST = 'cpd-catalogue.request';
const CAP_MANAGE = 'cpd-catalogue.manage';

const clean = (v, n = 2000) => (v == null ? null : String(v).trim().slice(0, n) || null);
const idOf = (v) => { const n = parseInt(v, 10); return Number.isInteger(n) && n > 0 ? n : null; };

// ── catalogue ───────────────────────────────────────────────────────────────

/**
 * GET /catalogue — what Ealing are running that has not happened yet.
 *
 * The `last_date >= today` filter is the expiry rule, applied at read time
 * rather than trusted to the archive sweep. "A past course drops out of the
 * catalogue" is then true by construction: even if expireCourses() never ran,
 * yesterday's course is not in this list.
 */
router.get('/catalogue', requireCapabilityLevel(CAP_VIEW, 'view'), async (req, res) => {
  try {
    const db = getPool();
    const today = store.todayYmd();
    const mine = idOf(req.user && req.user.id);
    const search = clean(req.query.q, 120);
    const mode = clean(req.query.mode, 20);

    const params = [today, mine];
    let extra = '';
    if (search) { params.push(`%${search}%`); extra += ` AND (c.title ILIKE $${params.length} OR c.course_code ILIKE $${params.length})`; }
    if (mode && ['online', 'in_person', 'hybrid'].includes(mode)) { params.push(mode); extra += ` AND c.delivery_mode = $${params.length}`; }

    const { rows } = await db.query(`
      SELECT c.id, c.course_code, c.title, c.provider, c.venue, c.delivery_mode,
             c.start_time, c.end_time, c.price_text, c.is_free, c.price_note,
             c.parts_total, c.first_date, c.last_date, c.booking_deadline,
             c.booking_url, c.needs_review, c.confidence,
             (SELECT count(*) FROM ealing_cpd_sessions s WHERE s.course_id = c.id) AS session_count,
             (SELECT json_agg(json_build_object('date', s.session_date, 'start_time', s.start_time,
                                                'end_time', s.end_time, 'part', s.part_number)
                              ORDER BY s.session_date)
                FROM ealing_cpd_sessions s WHERE s.course_id = c.id) AS sessions,
             mr.id AS my_request_id, mr.status AS my_request_status,
             (SELECT count(*) FROM ealing_cpd_requests r
               WHERE r.course_id = c.id AND r.status IN ('pending','approved','booked')) AS interest_count
        FROM ealing_cpd_courses c
        LEFT JOIN LATERAL (
          SELECT r.id, r.status FROM ealing_cpd_requests r
           WHERE r.course_id = c.id AND r.staff_id = $2
           ORDER BY r.requested_at DESC LIMIT 1
        ) mr ON true
       WHERE c.status = 'active'
         AND (c.last_date IS NULL OR c.last_date >= $1::date)
         ${extra}
       ORDER BY c.first_date NULLS LAST, c.title
       LIMIT 300`, params);

    res.json({ today, courses: rows });
  } catch (e) {
    console.error('[ealing-cpd] catalogue:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/** GET /courses/:id — one course, its dates, and where I stand on it. */
router.get('/courses/:id', requireCapabilityLevel(CAP_VIEW, 'view'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT c.*, l.subject AS source_subject, l.from_email AS source_from, l.parsed_at
         FROM ealing_cpd_courses c
         LEFT JOIN ealing_cpd_email_log l ON l.message_id = c.source_message_id
        WHERE c.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    const { rows: sessions } = await db.query(
      `SELECT id, session_date, start_time, end_time, part_number, calendar_event_id
         FROM ealing_cpd_sessions WHERE course_id = $1 ORDER BY session_date`, [id]);

    const mine = idOf(req.user && req.user.id);
    const { rows: myReq } = await db.query(
      `SELECT id, status, staff_note, requested_at, decided_at, decision_reason, booking_ref
         FROM ealing_cpd_requests WHERE course_id = $1 AND staff_id = $2
         ORDER BY requested_at DESC LIMIT 1`, [id, mine]);

    // Who else has asked — a name list only for people who can manage requests.
    let others = [];
    const lvl = await capabilityLevel(req.user, CAP_MANAGE);
    if (lvl) {
      const { rows: o } = await db.query(
        `SELECT r.id, r.status, r.staff_id, s.first_name, s.last_name
           FROM ealing_cpd_requests r JOIN staff s ON s.id = r.staff_id
          WHERE r.course_id = $1 ORDER BY r.requested_at`, [id]);
      others = o;
    }

    res.json({ course: rows[0], sessions, my_request: myReq[0] || null, requests: others });
  } catch (e) {
    console.error('[ealing-cpd] course detail:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── asking ──────────────────────────────────────────────────────────────────

/** POST /courses/:id/request — "ask to do it by clicking the button". */
router.post('/courses/:id/request', requireCapabilityLevel(CAP_REQUEST, 'edit'), async (req, res) => {
  const id = idOf(req.params.id);
  const staffId = idOf(req.user && req.user.id);
  if (!id || !staffId) return res.status(400).json({ error: 'bad_request' });
  try {
    const db = getPool();
    const { rows: course } = await db.query(
      `SELECT id, title, first_date, last_date, status FROM ealing_cpd_courses WHERE id = $1`, [id]);
    if (!course.length) return res.status(404).json({ error: 'not_found' });
    // Asking to go on something that has already happened is always a mistake,
    // and a 400 saying so is more use than a request nobody can action.
    if (course[0].last_date && course[0].last_date < new Date(store.todayYmd())) {
      return res.status(400).json({ error: 'course_past', message: 'That course has already run.' });
    }

    const { rows } = await db.query(
      `INSERT INTO ealing_cpd_requests (course_id, staff_id, staff_note)
       VALUES ($1,$2,$3)
       ON CONFLICT (course_id, staff_id) WHERE status IN ('pending','approved','booked')
       DO NOTHING
       RETURNING id, status`,
      [id, staffId, clean(req.body && req.body.note, 1000)]);

    if (!rows.length) {
      return res.status(409).json({ error: 'already_requested', message: 'You have already asked about this course.' });
    }

    await notifyManagers(db, id, staffId, course[0].title, rows[0].id);
    res.status(201).json({ ok: true, request: rows[0] });
  } catch (e) {
    console.error('[ealing-cpd] request:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/** POST /requests/:id/withdraw — changed my mind, before anyone answered. */
router.post('/requests/:id/withdraw', requireCapabilityLevel(CAP_REQUEST, 'edit'), async (req, res) => {
  const id = idOf(req.params.id);
  const staffId = idOf(req.user && req.user.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE ealing_cpd_requests
          SET status = 'withdrawn', updated_at = now()
        WHERE id = $1 AND staff_id = $2 AND status = 'pending'
        RETURNING id`, [id, staffId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found_or_decided' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[ealing-cpd] withdraw:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/** GET /my-requests — what I have asked for and what came back. */
router.get('/my-requests', requireCapabilityLevel(CAP_VIEW, 'view'), async (req, res) => {
  const staffId = idOf(req.user && req.user.id);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT r.id, r.status, r.staff_note, r.requested_at, r.decided_at, r.decision_reason,
              r.booking_ref, r.attended_at,
              c.id AS course_id, c.title, c.course_code, c.first_date, c.last_date,
              c.venue, c.delivery_mode, c.booking_url
         FROM ealing_cpd_requests r JOIN ealing_cpd_courses c ON c.id = r.course_id
        WHERE r.staff_id = $1
        ORDER BY r.requested_at DESC LIMIT 100`, [staffId]);
    res.json(rows);
  } catch (e) {
    console.error('[ealing-cpd] my-requests:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── answering ───────────────────────────────────────────────────────────────

/**
 * GET /requests — the manager's queue, WITH the staffing position.
 *
 * `?status=pending` by default. Each row carries a `ratio` block computed by the
 * absence gatekeeper's engine for every date of the course, excluding the
 * requester. That is the actual question a manager is answering, so it is
 * answered here rather than left as an exercise with the rota open in another
 * tab.
 */
router.get('/requests', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  const status = clean(req.query.status, 20) || 'pending';
  try {
    const db = getPool();
    const params = [];
    let where = '';
    if (status !== 'all') { params.push(status); where = ` WHERE r.status = $${params.length}`; }

    const { rows } = await db.query(
      `SELECT r.id, r.status, r.staff_note, r.requested_at, r.decided_at, r.decision_reason,
              r.booking_ref, r.attended_at, r.ratio_snapshot,
              r.staff_id, s.first_name, s.last_name, s.role, s.job_title,
              c.id AS course_id, c.title, c.course_code, c.first_date, c.last_date,
              c.venue, c.delivery_mode, c.start_time, c.end_time, c.booking_url,
              c.price_text, c.price_note, c.booking_deadline, c.parts_total
         FROM ealing_cpd_requests r
         JOIN staff s ON s.id = r.staff_id
         JOIN ealing_cpd_courses c ON c.id = r.course_id
         ${where}
        ORDER BY c.first_date NULLS LAST, r.requested_at
        LIMIT 200`, params);

    // Live ratio only for requests still awaiting an answer. A decided request
    // shows the snapshot it was decided on — recomputing it would quietly
    // rewrite the evidence behind a decision already taken.
    for (const r of rows) {
      if (r.status === 'pending') r.ratio = await ratioForRequest(db, r.course_id, r.staff_id);
      else r.ratio = r.ratio_snapshot || null;
    }

    res.json(rows);
  } catch (e) {
    console.error('[ealing-cpd] requests:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/** GET /requests/:id/ratio — the staffing position on its own, recomputed now. */
router.get('/requests/:id/ratio', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT course_id, staff_id FROM ealing_cpd_requests WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(await ratioForRequest(db, rows[0].course_id, rows[0].staff_id));
  } catch (e) {
    console.error('[ealing-cpd] ratio:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /requests/:id/decision — { decision: 'approve'|'decline', reason }
 *
 * A decline REQUIRES a reason. "We sort out staffing and say yes" has an
 * implied no, and a no with no reason attached is the thing that stops people
 * asking again.
 */
router.post('/requests/:id/decision', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  const id = idOf(req.params.id);
  const decision = clean(req.body && req.body.decision, 20);
  const reason = clean(req.body && req.body.reason, 1000);
  if (!id || !['approve', 'decline'].includes(decision)) return res.status(400).json({ error: 'bad_request' });
  if (decision === 'decline' && !reason) {
    return res.status(400).json({ error: 'reason_required', message: 'Please say why, so they know whether to ask again.' });
  }
  try {
    const db = getPool();
    const { rows: existing } = await db.query(
      `SELECT r.id, r.course_id, r.staff_id, r.status, c.title
         FROM ealing_cpd_requests r JOIN ealing_cpd_courses c ON c.id = r.course_id
        WHERE r.id = $1`, [id]);
    if (!existing.length) return res.status(404).json({ error: 'not_found' });
    if (existing[0].status !== 'pending') {
      return res.status(409).json({ error: 'already_decided', status: existing[0].status });
    }

    // The evidence the decision was taken on, frozen at this moment.
    const snapshot = await ratioForRequest(db, existing[0].course_id, existing[0].staff_id);

    const { rows } = await db.query(
      `UPDATE ealing_cpd_requests
          SET status = $2, decided_by = $3, decided_at = now(),
              decision_reason = $4, ratio_snapshot = $5::jsonb, updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING id, status`,
      [id, decision === 'approve' ? 'approved' : 'declined',
       idOf(req.user && req.user.id), reason, JSON.stringify(snapshot)]);
    if (!rows.length) return res.status(409).json({ error: 'already_decided' });

    notifyStaff(existing[0].staff_id, decision, existing[0].title, reason, existing[0].course_id);
    res.json({ ok: true, request: rows[0], ratio: snapshot });
  } catch (e) {
    console.error('[ealing-cpd] decision:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /requests/:id/booked — the manager has booked it on Ealing's site.
 *
 * This is a human confirming a human action. Wren does not and cannot book, so
 * this endpoint records a fact rather than performing one; booking_ref is
 * Ealing's own confirmation reference, so there is something to quote if the
 * place goes missing.
 */
router.post('/requests/:id/booked', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE ealing_cpd_requests
          SET status = 'booked', booked_at = now(), booked_by = $2,
              booking_ref = $3, updated_at = now()
        WHERE id = $1 AND status = 'approved'
        RETURNING id, status, course_id, staff_id`,
      [id, idOf(req.user && req.user.id), clean(req.body && req.body.booking_ref, 120)]);
    if (!rows.length) return res.status(409).json({ error: 'not_approved', message: 'Approve the request before recording a booking.' });

    // The calendar entry stops saying "tentative" now that somebody is going.
    try {
      const { rows: who } = await db.query(
        `SELECT s.first_name, s.last_name FROM ealing_cpd_requests r
           JOIN staff s ON s.id = r.staff_id
          WHERE r.course_id = $1 AND r.status IN ('booked','attended')`, [rows[0].course_id]);
      await store.markCalendarBooked(db, rows[0].course_id,
        who.map(w => `${w.first_name || ''} ${w.last_name || ''}`.trim()).filter(Boolean));
    } catch (e) { console.error('[ealing-cpd] calendar update:', e.message); }

    res.json({ ok: true, request: rows[0] });
  } catch (e) {
    console.error('[ealing-cpd] booked:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/**
 * POST /requests/:id/attended — they went. This is where it becomes CPD.
 *
 * Writes the ordinary ladn.cpd_records row the setting would have written by
 * hand, and links it back. cpd_records is the table the SCR sweep, the
 * supervision screens and the inspection pack already read, so attendance
 * recorded here shows up everywhere those do — without this build inventing a
 * second, parallel notion of "training completed".
 */
router.post('/requests/:id/attended', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    const db = getPool();
    const { rows: r } = await db.query(
      `SELECT r.id, r.staff_id, r.status, r.cpd_record_id,
              c.title, c.course_code, c.provider, c.first_date, c.last_date
         FROM ealing_cpd_requests r JOIN ealing_cpd_courses c ON c.id = r.course_id
        WHERE r.id = $1`, [id]);
    if (!r.length) return res.status(404).json({ error: 'not_found' });
    if (!['approved', 'booked'].includes(r[0].status)) {
      return res.status(409).json({ error: 'bad_status', status: r[0].status });
    }
    if (r[0].cpd_record_id) return res.status(409).json({ error: 'already_recorded' });

    const completion = clean(req.body && req.body.completion_date, 10) || r[0].last_date || store.todayYmd();
    const hours = req.body && req.body.hours != null ? Number(req.body.hours) : null;

    const { rows: rec } = await db.query(
      `INSERT INTO cpd_records (staff_id, course_name, provider, completion_date, hours, notes, category)
       VALUES ($1,$2,$3,$4::date,$5,$6,'external')
       RETURNING id`,
      [r[0].staff_id,
       r[0].course_code ? `${r[0].title} (${r[0].course_code})` : r[0].title,
       r[0].provider || 'Ealing CPD Online',
       completion,
       Number.isFinite(hours) && hours > 0 ? hours : null,
       'Booked through the Ealing CPD catalogue in Wren.']);

    await db.query(
      `UPDATE ealing_cpd_requests
          SET status = 'attended', attended_at = now(), cpd_record_id = $2, updated_at = now()
        WHERE id = $1`, [id, rec[0].id]);

    res.json({ ok: true, cpd_record_id: rec[0].id });
  } catch (e) {
    console.error('[ealing-cpd] attended:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/** POST /requests/:id/cancel — a booked place given up. */
router.post('/requests/:id/cancel', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE ealing_cpd_requests
          SET status = 'cancelled', decision_reason = COALESCE($2, decision_reason), updated_at = now()
        WHERE id = $1 AND status IN ('approved','booked')
        RETURNING id, status`, [id, clean(req.body && req.body.reason, 500)]);
    if (!rows.length) return res.status(409).json({ error: 'bad_status' });
    res.json({ ok: true, request: rows[0] });
  } catch (e) {
    console.error('[ealing-cpd] cancel:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── the rota tie-in ─────────────────────────────────────────────────────────

/**
 * GET /rota-opportunities?from=&to= — Toby's rule, made visible.
 *
 * "on over-ratio days the priority is CPD". So for each day in the window this
 * reports the spare ratio headroom and which approved-but-not-yet-booked
 * requests could be taken on that day without dropping below the requirement
 * (the engine already keeps its +1 same-day-sickness spare).
 *
 * It suggests; it never books. The rota stays the manager's.
 */
router.get('/rota-opportunities', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  try {
    const db = getPool();
    const from = clean(req.query.from, 10) || store.todayYmd();
    const days = Math.min(parseInt(req.query.days, 10) || 28, 90);

    const { rows: pending } = await db.query(
      `SELECT r.id, r.staff_id, r.status, s.first_name, s.last_name,
              c.id AS course_id, c.title, c.course_code,
              (SELECT json_agg(x.session_date ORDER BY x.session_date)
                 FROM ealing_cpd_sessions x WHERE x.course_id = c.id) AS dates
         FROM ealing_cpd_requests r
         JOIN staff s ON s.id = r.staff_id
         JOIN ealing_cpd_courses c ON c.id = r.course_id
        WHERE r.status IN ('pending','approved')
          AND c.status = 'active'`);

    const out = [];
    for (let i = 0; i < days; i++) {
      const d = addDays(from, i);
      const candidates = pending.filter(p => (p.dates || []).some(x => ymdOf(x) === d));
      if (!candidates.length) continue;                 // only report days with something to say
      const day = await ratio.checkDate(db, d, null);
      if (day.weekend || day.booked.total === 0) continue;
      const headroom = day.available - day.need;        // staff we could release today
      out.push({
        date: d,
        headroom,
        available: day.available,
        needed: day.need,
        booked_children: day.booked.total,
        can_release: headroom > 0,
        note: headroom > 0
          ? `${headroom} spare above ratio — a good day to release someone for CPD.`
          : 'No spare above ratio on this day.',
        candidates: candidates.map(c => ({
          request_id: c.id, status: c.status, course_id: c.course_id,
          course: c.title, course_code: c.course_code,
          staff_id: c.staff_id, staff: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
        })),
      });
    }
    res.json({ from, days, opportunities: out });
  } catch (e) {
    console.error('[ealing-cpd] rota-opportunities:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── ingest control ──────────────────────────────────────────────────────────

/**
 * POST /rescan — re-read Ealing mail already in the queue.
 *
 * Populates the catalogue on day one (the 2026-27 programme is already sitting
 * in comms_email_queue) and re-applies parser improvements to mail already seen.
 * `force` re-parses emails the log says we have read.
 */
router.post('/rescan', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  try {
    const db = getPool();
    const summary = await store.rescanQueue(db, {
      limit: req.body && req.body.limit,
      sinceDays: req.body && req.body.since_days,
      force: !!(req.body && req.body.force),
    });
    res.json({ ok: true, ...summary });
  } catch (e) {
    console.error('[ealing-cpd] rescan:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/** GET /ingest-log — what we read, and what correctly yielded nothing. */
router.get('/ingest-log', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, email_id, subject, from_email, parsed_at, ok, reason, extraction,
              courses_found, courses_new, sessions_new
         FROM ealing_cpd_email_log ORDER BY parsed_at DESC LIMIT 100`);
    res.json(rows);
  } catch (e) {
    console.error('[ealing-cpd] ingest-log:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

/** PATCH /courses/:id — a manager correcting what the parser read. */
router.patch('/courses/:id', requireCapabilityLevel(CAP_MANAGE, 'approve'), async (req, res) => {
  const id = idOf(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad_id' });
  const b = req.body || {};
  const sets = [], vals = [id];
  const allow = {
    title: 300, venue: 300, description: 4000, delivery_mode: 20,
    start_time: 5, end_time: 5, price_text: 60, booking_url: 500, audience: 120,
  };
  for (const [k, len] of Object.entries(allow)) {
    if (b[k] !== undefined) { vals.push(clean(b[k], len)); sets.push(`${k} = $${vals.length}`); }
  }
  if (b.status !== undefined && ['active', 'archived'].includes(b.status)) {
    vals.push(b.status); sets.push(`status = $${vals.length}`);
  }
  if (b.needs_review !== undefined) { vals.push(!!b.needs_review); sets.push(`needs_review = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });

  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE ealing_cpd_courses SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $1 RETURNING id`, vals);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[ealing-cpd] patch course:', e.message);
    res.status(500).json({ error: 'server_error' });
  }
});

// ── helpers ─────────────────────────────────────────────────────────────────

function addDays(dateStr, n) {
  // Local components, never toISOString(): on a BST host the UTC conversion
  // shifts the date back a day for anything before 01:00.
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** pg returns DATE as a local-midnight JS Date — read local getters, not ISO. */
function ymdOf(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
}

/**
 * The staffing position on every date of a course, with this person taken off
 * the floor. Same engine as the absence gatekeeper, so a CPD day and a leave day
 * are judged by one set of rules rather than two that can disagree.
 */
async function ratioForRequest(db, courseId, staffId) {
  const { rows: sessions } = await db.query(
    'SELECT session_date FROM ealing_cpd_sessions WHERE course_id = $1 ORDER BY session_date', [courseId]);
  const days = [];
  for (const s of sessions) {
    const d = ymdOf(s.session_date);
    if (!d) continue;
    try {
      const v = await ratio.checkDate(db, d, staffId);
      days.push({
        date: d, pass: v.pass, weekend: v.weekend,
        available: v.available, needed: v.need, required: v.required,
        booked_children: v.booked ? v.booked.total : null,
        headroom: v.available - v.need,
        reason: v.reason,
      });
    } catch (e) {
      // An unreadable day is reported as unknown, never as a pass. A manager
      // seeing "couldn't check" will go and look; a manager seeing a false
      // green will not.
      days.push({ date: d, pass: null, reason: `Could not check staffing: ${e.message}` });
    }
  }
  const failing = days.filter(d => d.pass === false);
  const unknown = days.filter(d => d.pass === null);
  return {
    days,
    all_clear: failing.length === 0 && unknown.length === 0 && days.length > 0,
    failing_days: failing.map(d => d.date),
    unknown_days: unknown.map(d => d.date),
    summary: days.length === 0
      ? 'This course has no dates recorded.'
      : failing.length === 0 && unknown.length === 0
        ? `Cover works on ${days.length === 1 ? 'that date' : `all ${days.length} dates`} without them.`
        : `${failing.length} of ${days.length} date${days.length === 1 ? '' : 's'} would be short of ratio staff.`,
  };
}

async function notifyManagers(db, courseId, staffId, courseTitle, requestId) {
  try {
    const { notify } = require('../services/notification-dispatcher');
    const { rows: who } = await db.query(
      'SELECT first_name, last_name FROM staff WHERE id = $1', [staffId]);
    const name = who.length ? `${who[0].first_name || ''} ${who[0].last_name || ''}`.trim() : 'A staff member';
    const { rows: mgrs } = await db.query(
      `SELECT id FROM staff WHERE is_active = true
         AND lower(role) IN ('manager','deputy_manager','admin','owner','headteacher')`);
    for (const m of mgrs) {
      notify('cpd_request_pending', 'staff', m.id,
        `CPD request — ${courseTitle}`.slice(0, 120),
        `${name} has asked to attend. Check the staffing position and approve or decline.`,
        { relatedTable: 'ealing_cpd_requests', relatedId: requestId, link: '/ealing-cpd.html#requests' });
    }
  } catch (e) { console.error('[ealing-cpd] notify managers:', e.message); }
}

function notifyStaff(staffId, decision, courseTitle, reason, courseId) {
  try {
    const { notify } = require('../services/notification-dispatcher');
    const approved = decision === 'approve';
    notify('cpd_request_decided', 'staff', staffId,
      approved ? `Approved — ${courseTitle}` : `Not this time — ${courseTitle}`,
      approved
        ? 'Your manager will book the place on Ealing CPD Online and confirm it here.'
        : (reason || 'Speak to your manager if you would like to ask again.'),
      { relatedTable: 'ealing_cpd_courses', relatedId: courseId, link: '/cpd-catalogue.html' });
  } catch (e) { console.error('[ealing-cpd] notify staff:', e.message); }
}

module.exports = router;
