const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const authenticate = require('../middleware/auth');
// b342: the src/ builder (keeps both ends of a pending sign-in switch admitted). scripts/sync-cf-allowlist.js is untouched —
// it is bind-mounted into prod, so editing it would have shipped this before review.
const { syncCFAllowlist } = require('../lib/cf-allowlist');
const { recordAudit } = require('../utils/audit');
const { hasCapability, requireCapability, requireCapabilityLevel,
        capabilityLevel, CAPABILITY_LEVELS: LEVELS } = require('../lib/capabilities');
// b268 — corrected age for children born premature (About Me → premature_weeks)
const { correctedAge } = require('../lib/corrected-age');
// b315 — the ONE room writer. children.room_id and child_bookings.room_id are two
// halves of one fact; setChildRoom() is the only thing allowed to move either.
const childRoom = require('../lib/child-room');
// b315 — the two dates a child's record calculates for itself.
const childDates = require('../lib/child-dates');
// b337 — one search across a child's own details AND their parents' (name,
// email, any-format phone), shared with the Ctrl+K global search.
const { searchChildren } = require('../lib/child-search');

router.use(authenticate);

const { buildScopeSQL } = require('../middleware/scope-filter');
// b96 enrolment lifecycle — confirmed/not-started children hidden from
// operational lists by default (?include=upcoming opts back in for admissions)
const { operationalChildFilter, effectiveStatusSQL, ensureEnrolmentMiddleware } = require('../utils/enrolment');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
router.use(ensureEnrolmentMiddleware(getPool));

// Validate :id is a positive integer — returns 404 for strings like "list"
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'Not found' });
  next();
});

// b324 (2026-09-11) — current_funded_hours comes from child_funding for the
// CURRENT term, which is where funding actually lives (per term, with type and
// code). The list's "Funded" filter, its "Xh funded" badge and the drawer used to
// read children.funded_hours — a column nothing in money reads and no child on
// production had set — so the filter showed nobody while 30 children were funded.
const CHILD_SELECT = `
  SELECT c.*, r.name as room_name,
    s.first_name || ' ' || s.last_name as key_person_name,
    (c.start_date IS NULL OR c.start_date <= CURRENT_DATE) AS started,
    ${effectiveStatusSQL('c')} AS enrolment_status_effective,
    cfn.total_hours_week AS current_funded_hours,
    cfn.funding_type     AS current_funding_type
  FROM children c
  LEFT JOIN rooms r ON r.id = c.room_id
  LEFT JOIN staff s ON s.id = c.key_person_id
  LEFT JOIN LATERAL (
    SELECT cf.total_hours_week, cf.funding_type
      FROM child_funding cf JOIN funding_terms ft ON ft.id = cf.term_id
     WHERE cf.child_id = c.id AND ft.is_current
     ORDER BY cf.total_hours_week DESC NULLS LAST LIMIT 1) cfn ON true
`;

// GET / — all active children (scope-filtered if applicable)
// Default: only children who have actually started (enrolment lifecycle, b96).
// ?include=upcoming — admissions view: also returns confirmed / not-yet-started
// children (any is_active=true row) with enrolment_status_effective for badges.
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const sf = req.scopeFilter;
    const baseWhere = req.query.include === 'upcoming'
      ? ' WHERE c.is_active=true'
      : ` WHERE ${operationalChildFilter('c')}`;
    let sql = CHILD_SELECT + baseWhere;
    let params = [];
    if (sf) {
      sql += ` AND c.${sf.sql}`;
      params = sf.params;
    }
    sql += ' ORDER BY c.first_name, c.last_name';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /search?q= — find a child by anything remembered about them: name, Wren
// id (123 or #123), EyLog ref, or a parent's name/email/phone (b337, 2026-09-17).
// Placed before /:id so "search" is never swallowed by the numeric-id route.
// Every result carries matched_field so the caller can show why it appeared.
router.get('/search', async (req, res) => {
  try {
    const db = getPool();
    const rows = await searchChildren(db, req.query.q, {
      limit: req.query.limit,
      scopeFilter: req.scopeFilter,
    });
    res.json({ query: String(req.query.q || '').trim(), results: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /inactive — the "Inactive children" section (2026-08-18).
// Children are hidden from every operational surface once their leave_date passes
// (operationalChildFilter + the nightly enrolment-status-roll set enrolment_status='left'
// and is_active=false). They still exist — records must be retained — so this is where
// staff can find them: past leavers, plus anyone deactivated manually.
// ?q= filters by name. Managers/leaders only; ordered most recently left first.
router.get('/inactive', requireCapability('children.archive'), async (req, res) => {
  if (!hasRole(req.user, CHILD_WRITE_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  try {
    const db = getPool();
    const params = [];
    let sql = CHILD_SELECT + `
      WHERE (c.is_active = false
             OR COALESCE(c.enrolment_status, '') = 'left'
             OR (c.leave_date IS NOT NULL AND c.leave_date < CURRENT_DATE))`;
    if (req.query.q && String(req.query.q).trim()) {
      params.push('%' + String(req.query.q).trim().toLowerCase() + '%');
      sql += ` AND (lower(c.first_name) LIKE $${params.length} OR lower(c.last_name) LIKE $${params.length})`;
    }
    sql += ` ORDER BY c.leave_date DESC NULLS LAST, c.first_name, c.last_name`;
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/reactivate — bring a child back onto the operational surfaces.
// Used when a leaver returns, or a leave_date was entered in error. Clears the
// leave_date so the nightly roll doesn't immediately archive them again.
router.post('/:id/reactivate', requireCapabilityLevel('children.archive', 'edit'), async (req, res) => {
  if (!hasRole(req.user, CHILD_WRITE_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE children SET is_active=true, enrolment_status='attending', leave_date=NULL,
              updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    recordAudit({ req, action: 'reactivate', entity_type: 'child', entity_id: req.params.id, meta: {} });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /by-room/:roomId
router.get('/by-room/:roomId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      CHILD_SELECT + ` WHERE ${operationalChildFilter('c')} AND c.room_id=$1 ORDER BY c.first_name`,
      [req.params.roomId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /attendance/today — today's attendance with sign-in status
router.get('/attendance/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.room_id,
             r.name as room_name, c.allergies, c.medical_notes,
             a.sign_in_time, a.sign_out_time, a.absent, a.absence_reason,
             a.id as attendance_id,
             CASE WHEN sr.id IS NOT NULL AND sr.is_active=true THEN true ELSE false END as is_on_sen_register,
             sr.sen_type,
             ev.events,
             -- 2026-10-28 (Toby): a child off today stays on the children screen, labelled.
             COALESCE(pra.absence_type, CASE WHEN ch.id IS NOT NULL THEN 'holiday' END) AS reported_absence,
             -- weeklybugs-20261031 (staff-app:19): the Scheduled list only showed a child once an
             -- attendance row existed for today (written at sign-in, or by the nightly EyLog
             -- import), so every child due in showed as NOT scheduled until they arrived. Same
             -- child_bookings weekday join /api/attendance/today already has (attendance.js).
             COALESCE(bk.booked, false) AS booked
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN attendance a ON a.child_id=c.id AND a.date=CURRENT_DATE AND a.session='full_day'
      LEFT JOIN LATERAL (
        SELECT p.absence_type FROM parent_reported_absences p
         WHERE p.child_id = c.id AND CURRENT_DATE BETWEEN p.start_date AND COALESCE(p.end_date, p.start_date)
           AND lower(COALESCE(p.status,'')) NOT IN ('rejected','cancelled','declined')
         ORDER BY p.created_at DESC LIMIT 1) pra ON true
      LEFT JOIN LATERAL (SELECT h.id FROM child_holidays h WHERE h.child_id = c.id AND h.date = CURRENT_DATE LIMIT 1) ch ON true
      LEFT JOIN LATERAL (
        SELECT true AS booked FROM child_bookings b
         WHERE b.child_id = c.id AND b.is_active = true
           AND CURRENT_DATE BETWEEN b.start_date AND COALESCE(b.end_date, DATE '2100-01-01')
           AND CASE EXTRACT(DOW FROM CURRENT_DATE)::int
                 WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed
                 WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
         LIMIT 1) bk ON true
      LEFT JOIN sen_register sr ON sr.child_id = c.id
      LEFT JOIN LATERAL (
        SELECT json_agg(json_build_object('event', e.event, 'at', e.at) ORDER BY e.at) AS events
        FROM attendance_events e WHERE e.child_id=c.id AND e.date=CURRENT_DATE
      ) ev ON true
      WHERE ${operationalChildFilter('c')}
      ORDER BY c.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/timeline — cross-entity chronological feed for one child (b154).
// Two calling conventions on the SAME route (kept additive — no duplicate mount):
//  - no `types` query param (legacy caller — editions/eyfs demo child-profile.html's
//    loadTimeline()): returns ONLY diary+observation items, unpaginated, in the exact
//    pre-b154 shape — byte-compatible so that existing consumer keeps working.
//  - `types` param present (Roost/EY child-profile Timeline tab, b154): full source
//    set, true server-side pagination via `before` (ISO timestamp cursor) + `limit`.
// Every item carries the legacy fields (kind/at/...) where applicable AND the common
// b154 shape: type, id, ts, title, snippet, author, link. Per-source role guards are
// reused from their owning routes rather than reinvented (message thread management-
// routing check mirrors messages.js; medicine gate reuses hasCapability from medicine.js).
const TIMELINE_TYPES = ['observation', 'diary', 'report', 'incident', 'message', 'attendance', 'medicine', 'milestone', 'home_activity'];
const TIMELINE_MANAGER_TIER = ['manager', 'deputy_manager', 'admin', 'senior_practitioner', 'room_leader'];

function mapTimelineRow(type, row, hasFinalised) {
  const base = { type, kind: type, id: row.id, ts: row.ts, at: row.ts };
  switch (type) {
    case 'diary':
      return {
        ...base,
        title: 'Daily Diary', snippet: row.notes || row.activities || row.meals || '',
        author: null, link: null, finalised: hasFinalised ? !!row.finalised_at : null,
        mood: row.mood, meals: row.meals, lunch: row.lunch, naps: row.naps,
        sleep_from: row.sleep_from, sleep_to: row.sleep_to,
        nappy: row.nappy, nappy_time: row.nappy_time,
        milk_amount_ml: row.milk_amount_ml, milk_time: row.milk_time,
        activities: row.activities, notes: row.notes, photo_urls: row.photo_urls || [],
      };
    case 'observation':
      return {
        ...base,
        title: row.title || 'Observation', snippet: (row.observation_text || '').slice(0, 160),
        author: row.staff_name || null, link: null,
        text: row.observation_text, eyfs_areas: row.eyfs_areas || [], staff: row.staff_name || null,
        photo_urls: row.photo_urls || [],
      };
    case 'report':
      return {
        ...base,
        title: (row.report_type || 'Report').replace(/_/g, ' '),
        snippet: row.shared_with_parents ? 'Shared with parents' : 'Not yet shared with parents',
        author: row.staff_name || null, link: null,
      };
    case 'incident':
      return {
        ...base,
        title: (row.incident_type || 'Incident').replace(/_/g, ' '),
        snippet: (row.description || '').slice(0, 160),
        author: row.staff_name || null, link: null, status: row.status,
      };
    case 'message':
      return {
        ...base,
        title: row.subject || '(no subject)', snippet: 'Message thread',
        author: null, link: `/messages.html?thread=${row.id}`,
      };
    case 'attendance':
      return {
        ...base,
        title: 'Absent', snippet: row.absence_reason || (row.session ? `Session: ${row.session}` : ''),
        author: null, link: null,
      };
    case 'medicine':
      return {
        ...base,
        title: row.medicine_name || 'Medicine given', snippet: row.dose ? `Dose: ${row.dose}` : '',
        author: row.staff_name || null, link: null,
      };
    case 'milestone':
      return {
        ...base,
        title: row.title || 'Milestone', snippet: (row.snippet_src || '').slice(0, 160),
        author: null, link: null, milestone_type: row.milestone_type,
      };
    case 'home_activity':
      // item 6 (2026-07-29) — a curriculum/activity-bank item a staff member sent to a
      // child's home learning (shared_items), surfaced on the child timeline so it's not
      // stranded on the separate "Home activities" card. Carries any attached docs.
      return {
        ...base,
        title: row.title || 'Home activity',
        snippet: (row.description || '').slice(0, 160),
        author: row.staff_name || null, link: null,
        item_type: row.item_type, description: row.description || null,
        attachments: Array.isArray(row.attachments) ? row.attachments : [],
      };
    default:
      return { ...base, title: type, snippet: '', author: null, link: null };
  }
}

router.get('/:id/timeline', async (req, res) => {
  try {
    const db = getPool();
    const cid = parseInt(req.params.id, 10);
    const legacyMode = req.query.types === undefined;
    const reqTypes = legacyMode
      ? ['observation', 'diary']
      : String(req.query.types || '').split(',').map(s => s.trim()).filter(t => TIMELINE_TYPES.includes(t));
    const wantTypes = reqTypes.length ? reqTypes : TIMELINE_TYPES;
    const limit = Math.min(parseInt(req.query.limit, 10) || (legacyMode ? 100 : 50), 200);
    const before = req.query.before && !isNaN(Date.parse(req.query.before)) ? new Date(req.query.before) : null;

    // Check if finalised_at column exists (may differ between DB schemas)
    const colCheck = await db.query(
      `SELECT count(*) > 0 AS has_col FROM information_schema.columns WHERE table_schema='ladn' AND table_name='daily_diary' AND column_name='finalised_at'`
    ).catch(() => ({ rows: [{ has_col: false }] }));
    const hasFinalised = colCheck.rows[0]?.has_col ?? false;

    const isManagerTier = hasRole(req.user, TIMELINE_MANAGER_TIER);
    const canSeeMedicine = wantTypes.includes('medicine') && await hasCapability(req.user, 'medicine_record');

    const sources = [];
    if (wantTypes.includes('diary')) {
      sources.push({ type: 'diary', p: db.query(`
        SELECT id, date, mood, meals, lunch, naps, sleep_from, sleep_to, nappy, nappy_time,
               milk_amount_ml, milk_time, activities, notes, photo_urls${hasFinalised ? ', finalised_at' : ''},
               COALESCE(created_at, date::timestamptz) AS ts
        FROM daily_diary
        WHERE child_id=$1 AND ($2::timestamptz IS NULL OR COALESCE(created_at, date::timestamptz) < $2)
        ORDER BY ts DESC LIMIT $3
      `, [cid, before, limit]) });
    }
    if (wantTypes.includes('observation')) {
      sources.push({ type: 'observation', p: db.query(`
        SELECT o.id, o.title, o.observation_text, o.eyfs_areas, o.photo_urls, o.created_at AS ts,
               s.first_name || ' ' || s.last_name AS staff_name
        FROM observations o
        LEFT JOIN staff s ON s.id = o.staff_id
        WHERE o.child_id=$1 AND ($2::timestamptz IS NULL OR o.created_at < $2)
        ORDER BY o.created_at DESC LIMIT $3
      `, [cid, before, limit]) });
    }
    if (wantTypes.includes('report')) {
      sources.push({ type: 'report', p: db.query(`
        SELECT r.id, r.report_type, r.created_at AS ts, r.shared_with_parents,
               s.first_name || ' ' || s.last_name AS staff_name
        FROM reports r
        LEFT JOIN staff s ON s.id = r.staff_id
        WHERE r.child_id=$1 AND ($2::timestamptz IS NULL OR r.created_at < $2)
        ORDER BY r.created_at DESC LIMIT $3
      `, [cid, before, limit]) });
    }
    if (wantTypes.includes('incident')) {
      sources.push({ type: 'incident', p: db.query(`
        SELECT i.id, i.incident_type, i.description, i.status,
               (i.incident_date + COALESCE(i.incident_time, '00:00'::time))::timestamptz AS ts,
               s.first_name || ' ' || s.last_name AS staff_name
        FROM incidents i
        LEFT JOIN staff s ON s.id = i.reported_by
        WHERE i.child_id=$1
          AND ($2::timestamptz IS NULL OR (i.incident_date + COALESCE(i.incident_time, '00:00'::time))::timestamptz < $2)
        ORDER BY ts DESC LIMIT $3
      `, [cid, before, limit]) });
    }
    if (wantTypes.includes('message')) {
      // Mirrors messages.js's management-routed-thread guard: practitioners don't see
      // threads routed to management unless directly assigned to them.
      const msgGuard = isManagerTier ? '' : `AND (t.recipient_type NOT IN ('management','manager') OR t.recipient_staff_id=$4)`;
      const msgParams = isManagerTier ? [cid, before, limit] : [cid, before, limit, req.user.id];
      sources.push({ type: 'message', p: db.query(`
        SELECT t.id, t.subject, t.last_message_at AS ts, t.recipient_type
        FROM message_threads t
        WHERE t.child_id=$1 AND ($2::timestamptz IS NULL OR t.last_message_at < $2)
        ${msgGuard}
        ORDER BY t.last_message_at DESC LIMIT $3
      `, msgParams) });
    }
    if (wantTypes.includes('attendance')) {
      sources.push({ type: 'attendance', p: db.query(`
        SELECT a.id, a.absence_reason, a.session, a.date::timestamptz AS ts
        FROM attendance a
        WHERE a.child_id=$1 AND a.absent=true
          AND ($2::timestamptz IS NULL OR a.date::timestamptz < $2)
        ORDER BY a.date DESC LIMIT $3
      `, [cid, before, limit]) });
    }
    if (canSeeMedicine) {
      sources.push({ type: 'medicine', p: db.query(`
        SELECT m.id, m.medicine_name, m.dose, m.time_given AS ts,
               s.first_name || ' ' || s.last_name AS staff_name
        FROM medicine_records m
        LEFT JOIN staff s ON s.id = m.staff_id
        WHERE m.child_id=$1 AND ($2::timestamptz IS NULL OR m.time_given < $2)
        ORDER BY m.time_given DESC LIMIT $3
      `, [cid, before, limit]) });
    }
    if (wantTypes.includes('milestone')) {
      sources.push({ type: 'milestone', p: db.query(`
        SELECT id, title, description AS snippet_src, milestone_type, happened_on::timestamptz AS ts
        FROM memory_box_entries
        WHERE child_id=$1 AND ($2::timestamptz IS NULL OR happened_on::timestamptz < $2)
        ORDER BY happened_on DESC LIMIT $3
      `, [cid, before, limit]) });
      sources.push({ type: 'milestone', p: db.query(`
        SELECT id, word AS title, context AS snippet_src, 'first_word' AS milestone_type, date_observed::timestamptz AS ts
        FROM first_words
        WHERE child_id=$1 AND ($2::timestamptz IS NULL OR date_observed::timestamptz < $2)
        ORDER BY date_observed DESC LIMIT $3
      `, [cid, before, limit]) });
    }
    if (wantTypes.includes('home_activity')) {
      sources.push({ type: 'home_activity', p: db.query(`
        SELECT si.id, si.item_type, si.title, si.description,
               COALESCE(si.attachments, '[]'::jsonb) AS attachments,
               si.shared_at AS ts,
               s.first_name || ' ' || s.last_name AS staff_name
        FROM shared_items si
        LEFT JOIN staff s ON s.id = si.shared_by
        WHERE si.child_id=$1 AND si.is_active=true
          AND ($2::timestamptz IS NULL OR si.shared_at < $2)
        ORDER BY si.shared_at DESC LIMIT $3
      `, [cid, before, limit]) });
    }

    const resolved = await Promise.all(sources.map(s => s.p));
    let items = [];
    resolved.forEach((r, i) => {
      const type = sources[i].type;
      for (const row of r.rows) items.push(mapTimelineRow(type, row, hasFinalised));
    });

    items.sort((a, b) => new Date(b.ts).getTime() - new Date(a.ts).getTime());
    res.json(items.slice(0, limit));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// b315 (2026-09-10) — THE PROFILE SUMMARY STRIP
//
// Toby: "like e-log, have little icons so have the days that they attend on
//        there. Have a colour for funded. Have an icon for allergies. Have an
//        icon for the room they're in and then have their date of [birth]. and
//        there have an icon for if they don't have a booking pattern."
//
// One call, because the strip sits above every tab of the record and must not
// cost six round trips to draw. Everything in it is read from the CANONICAL
// store: the room comes from the live booking (falling back to the profile only
// when there is no booking, which is itself reported), and the days come from
// child_bookings, not from anybody's summary of it.
//
// GDPR: this is a single child, fetched by a signed-in member of staff who can
// already read the profile. Nothing here is logged.
// ═══════════════════════════════════════════════════════════════════════════
router.get('/:id/summary', async (req, res) => {
  const childId = parseInt(req.params.id, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  try {
    const db = getPool();
    const { rows: crows } = await db.query(`
      SELECT c.id, c.date_of_birth, c.room_id, c.leave_date, c.is_active,
             c.transfer_planned_date, c.transfer_date_manual,
             COALESCE(c.leave_date_manual, false) AS leave_date_manual,
             r.name AS room_name,
             NULLIF(TRIM(COALESCE(c.allergies, '')), '')            AS allergies_profile,
             NULLIF(TRIM(COALESCE(am.food_allergies, '')), '')      AS allergies_about_me,
             c.allergens
        FROM children c
        LEFT JOIN rooms r ON r.id = c.room_id
        LEFT JOIN child_about_me am ON am.child_id = c.id
       WHERE c.id = $1`, [childId]);
    if (!crows.length) return res.status(404).json({ error: 'Not found' });
    const c = crows[0];
    const dob = childDates.ymd(c.date_of_birth);

    // Live booking patterns — plural on purpose. A child can hold two (three
    // funded days plus two private ones), and "which days are funded" is only
    // answerable by looking at each.
    const { rows: bookings } = await db.query(`
      SELECT b.id, b.room_id, rb.name AS room_name, b.mon, b.tue, b.wed, b.thu, b.fri,
             b.start_date::text AS start_date, b.end_date::text AS end_date,
             b.funded, b.session_type, b.start_time::text AS start_time,
             b.finish_time::text AS finish_time, b.repeat_mode, b.extra_session,
             b.exclude_from_funding, b.notes
        FROM child_bookings b
        LEFT JOIN rooms rb ON rb.id = b.room_id
       WHERE b.child_id = $1 AND b.is_active = true
         AND (b.end_date IS NULL OR b.end_date >= CURRENT_DATE)
       ORDER BY b.start_date, b.id`, [childId]);

    const today = childDates.ymd(new Date());
    const live = bookings.filter(b => (!b.start_date || b.start_date <= today));
    const upcoming = bookings.filter(b => b.start_date && b.start_date > today);

    // Per-day: booked at all, and funded on that day. A day is funded when the
    // booking that puts the child in on that day is a funded one.
    const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
    const days = {};
    for (const d of DAYS) {
      const on = live.filter(b => b[d]);
      days[d] = {
        booked: on.length > 0,
        funded: on.some(b => b.funded === true),
        // A day the child only attends from a future date — shown as booked-later,
        // never as booked now.
        upcoming: on.length === 0 && upcoming.some(b => b[d]),
      };
    }

    const room = await childRoom.canonicalRoom(db, childId, today);
    const inStep = c.room_id == null || room.source !== 'booking' || room.room_id === c.room_id;

    // An allergy icon appears ONLY when there is an allergy. There is deliberately
    // no "no allergies" tick: an absent icon must never be read as a
    // checked-and-cleared statement about a child's safety. b314 found the two
    // boxes (profile Allergies, All About Me → Food Allergies) disagreeing, so
    // both are asked and the answer says which had something in it.
    const allergenList = Array.isArray(c.allergens) ? c.allergens.filter(Boolean) : [];
    const allergySources = [];
    if (c.allergies_profile) allergySources.push('profile');
    if (c.allergies_about_me) allergySources.push('about_me');
    if (allergenList.length) allergySources.push('allergens');

    // The two calculated dates. Both are SUGGESTIONS. Where a person has decided
    // something different, the decision is returned alongside so the strip can
    // show the decision and still say what the rule would have given.
    const expectedLeave = childDates.expectedLeaveDate(dob);
    const expectedMove = childDates.expectedRoomMoveDate(dob);
    const leaveDate = childDates.ymd(c.leave_date);
    const plannedMove = childDates.ymd(c.transfer_planned_date);

    // Only a Baby Room child is heading for a room move. A child already in
    // Pre-school has made it; showing them a move date would be noise.
    const { rows: rr } = await db.query(
      `SELECT id, name, max_age_months FROM rooms ORDER BY COALESCE(min_age_months, 0), id`);
    const currentRoom = rr.find(r => r.id === (room.room_id || c.room_id)) || null;
    const nextRoom = currentRoom && currentRoom.max_age_months != null && currentRoom.max_age_months <= 24
      ? (rr.find(r => r.id !== currentRoom.id && (r.max_age_months == null || r.max_age_months > 24)) || null)
      : null;

    res.json({
      child_id: childId,
      is_active: c.is_active !== false,
      date_of_birth: dob,
      age: childDates.ageYearsMonths(dob, today),
      room: {
        id: room.room_id, name: room.room_name, source: room.source,
        profile_room_id: c.room_id, profile_room: c.room_name,
        in_step: inStep,
      },
      days,
      has_booking: live.length > 0,
      has_future_booking: upcoming.length > 0,
      bookings: live,
      upcoming_bookings: upcoming,
      any_funded: live.some(b => b.funded === true),
      allergy: {
        present: allergySources.length > 0,
        sources: allergySources,
        profile: c.allergies_profile || null,
        about_me: c.allergies_about_me || null,
        allergens: allergenList,
      },
      dates: {
        expected_leave_date: expectedLeave,
        leave_date: leaveDate,
        leave_date_manual: !!c.leave_date_manual,
        leave_overridden: !!(leaveDate && expectedLeave && leaveDate !== expectedLeave),
        expected_room_move_date: nextRoom ? expectedMove : null,
        room_move_to_room_id: nextRoom ? nextRoom.id : null,
        room_move_to_room: nextRoom ? nextRoom.name : null,
        transfer_planned_date: plannedMove,
        transfer_date_manual: !!c.transfer_date_manual,
        // Overridden means a PERSON decided; drifted means a stored date no
        // longer matches the rule and nobody claimed it, which the b206 nightly
        // recompute will straighten out. Calling the second one "set" would tell
        // a manager a decision exists where none does.
        move_overridden: !!(nextRoom && c.transfer_date_manual && plannedMove),
        move_drifted: !!(nextRoom && !c.transfer_date_manual && plannedMove
                         && expectedMove && plannedMove !== expectedMove),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /missing-fields — b354 (2026-09-24). Toby: "any children with missing
// fields like parent email or whatever should have a little icon next to it,
// similar to the allergies or not started". One bulk query rather than a
// per-child endpoint the list would otherwise N+1. children.parent_1_email /
// emergency_contact_*  are the b342-synced flat columns (contacts is the
// store; these are kept in step with it), so this reads the same surface an
// invoice or a keepsake send already reads — no second contacts lookup.
// Registered before GET /:id for the same reason as /room-drift above.
router.get('/missing-fields', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT c.id,
        (btrim(coalesce(c.parent_1_email,'')) = '' AND btrim(coalesce(c.parent_2_email,'')) = '') AS missing_parent_email,
        (btrim(coalesce(c.emergency_contact_1_name,'')) = '' AND btrim(coalesce(c.emergency_contact_2_name,'')) = '') AS missing_emergency_contact,
        (c.date_of_birth IS NULL) AS missing_dob,
        (btrim(coalesce(c.collection_password,'')) = '') AS missing_collection_password,
        fund.missing_declaration,
        fund.missing_30hr_code
      FROM children c
      LEFT JOIN LATERAL (
        SELECT bool_or(cf.declaration_signed IS NOT TRUE) AS missing_declaration,
               bool_or(cf.funding_type = 'extended' AND btrim(coalesce(cf.thirty_hour_code,'')) = '') AS missing_30hr_code
          FROM child_funding cf
          JOIN funding_terms ft ON ft.id = cf.term_id AND ft.is_current = true
         WHERE cf.child_id = c.id
      ) fund ON true
      WHERE c.is_active = true
    `);
    const FIELD_LABELS = {
      missing_parent_email: 'Parent email', missing_emergency_contact: 'Emergency contact',
      missing_dob: 'Date of birth', missing_collection_password: 'Collection password',
      missing_declaration: 'Funding declaration', missing_30hr_code: '30-hour code',
    };
    const out = {};
    for (const r of rows) {
      const missing = Object.keys(FIELD_LABELS).filter(k => r[k] === true).map(k => FIELD_LABELS[k]);
      if (missing.length) out[r.id] = missing;
    }
    res.json(out); // { [child_id]: ['Parent email', ...] } — only children with a gap are present
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /room-drift — every child whose profile room and live booking room
// disagree. b315's standing check: this must always return zero. Registered
// before GET /:id, which would otherwise swallow the word "room-drift" as an id.
// Child IDs and room names only — never a name.
router.get('/room-drift', async (req, res) => {
  try {
    const rows = await childRoom.roomDrift(getPool());
    res.json({ count: rows.length, drift: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      CHILD_SELECT + ' WHERE c.id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── b237: children.edit / .transfer / .archive on one PUT ────────────────────
// The matrix separates editing a child from MOVING one between rooms and from
// ARCHIVING one, but all three arrive as the same PUT /:id. Rather than invent
// new endpoints, inspect what the body actually does and demand the matching
// capability. children.edit is always required; transfer/archive stack on top.
// Room transfer is decided by comparison with the stored room_id, so an edit form
// that echoes the current room back unchanged is not treated as a transfer.
async function _requireChildWriteCaps(req, res, next) {
  const deny = cap => res.status(403).json({ error: 'capability_forbidden', capability: cap });
  try {
    // 'edit' level, not merely "holds the key": the shipped matrix grants a
    // practitioner children.edit at VIEW, which is precisely the distinction
    // requireCapabilityLevel exists to honour.
    const can = async (k) => LEVELS.indexOf(await capabilityLevel(req.user, k)) >= LEVELS.indexOf('edit');
    if (!(await can('children.edit'))) return deny('children.edit');

    const b = req.body || {};
    const archiving = b.is_active === false
      || b.enrolment_status === 'left'
      || (b.leave_date !== undefined && b.leave_date !== null && b.leave_date !== '');
    if (archiving && !(await can('children.archive'))) return deny('children.archive');

    if (b.room_id !== undefined && b.room_id !== null) {
      const { rows } = await getPool().query('SELECT room_id FROM children WHERE id=$1', [req.params.id]);
      const moving = rows.length && Number(rows[0].room_id) !== Number(b.room_id);
      if (moving && !(await can('children.transfer'))) return deny('children.transfer');
    }
    return next();
  } catch (e) {
    return deny('children.edit'); // fail closed
  }
}

const CHILD_WRITE_ROLES = ['manager','deputy_manager','admin','senior_practitioner','room_leader'];

// POST / — create child
router.post('/', requireCapabilityLevel('children.edit', 'edit'), async (req, res) => {
  if (!hasRole(req.user, CHILD_WRITE_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const { first_name, last_name, date_of_birth, room_id, key_person_id,
          parent_1_name, parent_1_email, parent_1_phone, allergies,
          medical_notes, photo_consent, funded_hours, start_date } = req.body;
  try {
    const db = getPool();
    // 2026-10-06 — start_date was typed into the modal and silently dropped.
    const { rows } = await db.query(`
      INSERT INTO children (first_name, last_name, date_of_birth, room_id, key_person_id,
        parent_1_name, parent_1_email, parent_1_phone, allergies, medical_notes,
        photo_consent, funded_hours, start_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      RETURNING *
    `, [first_name, last_name, date_of_birth, room_id, key_person_id,
        parent_1_name, parent_1_email, parent_1_phone, allergies,
        medical_notes, photo_consent || false, funded_hours || 0, start_date || null]);
    try { await require('../lib/family-access').ensureFamilyAccess(db, rows[0].id); } catch (_) {}
    recordAudit({ req, action: 'create', entity_type: 'child', entity_id: rows[0].id });
    res.status(201).json(rows[0]);
    // sync CF allowlist after child creation
    syncCFAllowlist().catch(e => console.error('CF sync:', e.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/profile — practitioner view (non-sensitive)
router.get('/:id/profile', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
        c.photo_url, c.room_id, r.name as room_name, c.is_demo,
        s.first_name as key_person_first, s.last_name as key_person_last,
        c.collection_password, c.allergies, c.dietary_requirements, c.medical_notes,
        c.parent_1_name, c.parent_1_phone, c.parent_2_name, c.parent_2_phone,
        c.emergency_contact_1_name, c.emergency_contact_1_phone,
        c.funded_hours, c.funded_hours_type, c.notes, c.send_needs,
        CASE WHEN sr.id IS NOT NULL AND sr.is_active=true THEN true ELSE false END as is_on_sen_register,
        sr.sen_type, sr.primary_need,
        cfn.total_hours_week AS current_funded_hours,   -- b324: this term's child_funding
        cfn.funding_type     AS current_funding_type
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = c.key_person_id
      LEFT JOIN sen_register sr ON sr.child_id = c.id
      LEFT JOIN LATERAL (
        SELECT cf.total_hours_week, cf.funding_type
          FROM child_funding cf JOIN funding_terms ft ON ft.id = cf.term_id
         WHERE cf.child_id = c.id AND ft.is_current
         ORDER BY cf.total_hours_week DESC NULLS LAST LIMIT 1) cfn ON true
      WHERE c.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const child = rows[0];
    // Today's diary summary
    const { rows: diary } = await db.query(
      'SELECT mood, meals, activities, notes FROM daily_diary WHERE child_id=$1 AND date=CURRENT_DATE',
      [req.params.id]
    );
    child.today_diary_summary = diary[0] || null;
    res.json(child);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id

// ── Room transfer propagation (b190, moved to src/lib/child-room.js by b315) ──
// Occupancy is computed from ladn.child_bookings.room_id, NOT children.room_id
// (see occupancy-calendar.js: `if (b.room_id !== roomId) continue`). Changing a
// child's room on the profile therefore used to leave every occupancy view showing
// them in the old room indefinitely — the bug that hid a Baby Room→Pre-school move.
//
// b315: the implementation now lives in src/lib/child-room.js so that the six
// code paths that move a child share one, and each of them records the move.
// This wrapper stays because five files import it by this name; new callers
// should use childRoom.setChildRoom(), which also writes children.room_id and
// the child_room_moves history rather than only half the job.
async function _propagateRoomChange(db, childId, newRoomId, transferDate) {
  const eff = childRoom.ymd(transferDate) || childRoom.ymd(new Date());
  const { rows: rn } = await db.query(`SELECT name FROM rooms WHERE id=$1`, [newRoomId]);
  if (rn.length) await db.query(`UPDATE children SET room=$1 WHERE id=$2`, [rn[0].name, childId]);
  return childRoom._transferBooking(db, childId, newRoomId, eff);
}

router.put('/:id', _requireChildWriteCaps, async (req, res) => {
  if (!hasRole(req.user, CHILD_WRITE_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const fields = ['first_name','last_name','date_of_birth','room_id','key_person_id',
    'parent_1_name','parent_1_email','parent_1_phone','parent_2_name','parent_2_email',
    'parent_2_phone','allergies','dietary_requirements','medical_notes','photo_consent',
    'media_consent','funded_hours','funded_hours_type','is_active','notes',
    'emergency_contact_1_name','emergency_contact_1_phone','send_needs','collection_password',
    'start_date','postcode','emergency_contact_2_name','emergency_contact_2_phone',
    'court_order','court_order_details','social_worker_name','social_worker_phone',
    'funding_billing_mode','stretch_weeks','status','gp_name','gp_phone',
    'leave_date','enrolment_status','eligibility_code','eligibility_code_expiry',
    // addresses-20261023: the child's full address (address_line2 / town need migrations/2026-10-23-addresses-town-line2.sql)
    'address_line1','address_line2','town'];
  const es = req.body.enrolment_status;
  if (es !== undefined && es !== null && !['confirmed','attending','left'].includes(es)) {
    return res.status(400).json({ error: 'Invalid enrolment_status (confirmed|attending|left)' });
  }
  const updates = [];
  const vals = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      vals.push(req.body[f]);
      updates.push(`${f}=$${vals.length}`);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(req.params.id);
  try {
    const db = getPool();

    // b315 — read the room BEFORE the write. A room change has to be handed to
    // childRoom.setChildRoom(), and that needs to know where the child came from;
    // once the UPDATE below has landed, nothing on the row remembers.
    let _prevRoomId;
    // 2026-10-23 (keyperson) — a key person change from the Roost profile is audited
    // old → new, in the same diff shape as EY Key Children (src/routes/key-children.js),
    // so one history covers both surfaces. Read before the write, like the room above.
    let _prevKp;
    if (req.body.key_person_id !== undefined) {
      const { rows: pk } = await db.query('SELECT key_person_id FROM children WHERE id=$1', [req.params.id]);
      _prevKp = pk.length ? pk[0].key_person_id : undefined;
    }
    if (req.body.room_id !== undefined) {
      const { rows: pr } = await db.query('SELECT room_id FROM children WHERE id=$1', [req.params.id]);
      _prevRoomId = pr.length ? pr[0].room_id : undefined;
    }
    // b315 — a leave date typed by a person is a DECISION, and must not be
    // silently recomputed when someone later corrects the date of birth. Mark it.
    // Clearing the field hands the child back to the calculated suggestion.
    if (req.body.leave_date !== undefined) {
      const ld = req.body.leave_date;
      vals.splice(vals.length - 1, 0, !!(ld && String(ld).trim()));
      updates.push(`leave_date_manual=$${vals.length - 1}`);
    }

    const { rows } = await db.query(
      `UPDATE children SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    // 2026-09-21 — a family's details live in two places (this row and ladn.contacts).
    // They had drifted so far apart that the Family tab showed an empty form while
    // contacts held every parent's phone. Mirror the edit so the gap cannot reopen;
    // best-effort, because a mirror failure must never fail the save.
    try {
      const { mirrorParentsToContacts } = require('../lib/family-contacts');
      await mirrorParentsToContacts(db, req.params.id, req.body, rows[0] || {});
    } catch (mErr) { console.error('[children] contact mirror failed:', mErr.message); }
    // b342 — the two emergency slots are mirrored the same way, so the store the parents' app and the
    // custom reports read never disagrees with what staff typed on the profile.
    try {
      const { mirrorEmergencyToContacts } = require('../lib/family-contacts');
      await mirrorEmergencyToContacts(db, parseInt(req.params.id, 10), req.body, rows[0] || {});
    } catch (mErr) { console.error('[children] emergency mirror failed:', mErr.message); }
    // 2026-10-06 — a parent email typed on the profile is what a new family was missing:
    // billing email, parents-app access and payment reference follow from it.
    if (req.body.parent_1_email !== undefined || req.body.parent_2_email !== undefined) {
      try { await require('../lib/family-access').ensureFamilyAccess(db, req.params.id); }
      catch (fErr) { console.error('[children] family access failed:', fErr.message); }
    }

    // Setting a past leave_date (or marking someone 'left') must take effect NOW, not at
    // 02:45 tomorrow. ~14 route files filter children on is_active alone rather than the
    // enrolment lifecycle, so until is_active flips a "left" child keeps appearing
    // everywhere and it looks like the change didn't save. The nightly
    // enrolment-status-roll still does this — this just stops the wait.
    try {
      const r0 = rows[0] || {};
      const leftNow = (r0.enrolment_status === 'left')
        || (r0.leave_date && new Date(r0.leave_date) < new Date(new Date().toDateString()));
      if (leftNow && r0.is_active) {
        await db.query(
          `UPDATE children SET is_active=false, enrolment_status='left', updated_at=NOW() WHERE id=$1`,
          [r0.id]);
        rows[0].is_active = false;
        rows[0].enrolment_status = 'left';
      }
    } catch (lErr) { console.error('[children] leave-date apply failed:', lErr.message); }

    // b314 (2026-09-10) — a leave date must bound the booking too.
    // The forecast and the projection count a place as taken for as long as the
    // booking runs, and a booking with no end_date runs forever. Setting a leave
    // date on the profile did not touch it, so a child leaving in December went
    // on occupying a place in the January forecast and the room looked full when
    // it was not. Only bookings that outlast the leave date are shortened; a
    // booking that already ends earlier is left alone.
    let _leave_bounded = 0;
    if (req.body.leave_date !== undefined && rows[0]) {
      try {
        const ld = rows[0].leave_date
          ? new Date(rows[0].leave_date).toISOString().slice(0, 10) : null;
        if (ld) {
          const u = await db.query(
            `UPDATE child_bookings SET end_date = $1::date
              WHERE child_id = $2 AND is_active = true
                AND (end_date IS NULL OR end_date > $1::date)`, [ld, rows[0].id]);
          _leave_bounded = u.rowCount || 0;
        }
      } catch (lbErr) { console.error('[children] leave-date booking bound failed:', lbErr.message); }
    }

    // b315 — a room change goes through the ONE room writer, which moves the
    // booking (what occupancy reads), keeps children.room_id in step (what the
    // register reads) and records the move in child_room_moves. The UPDATE above
    // has already written room_id, so _prevRoomId carries where they came from.
    let _transfer = null;
    let _room_move = null;
    if (req.body.room_id !== undefined && rows[0]
        && Number(_prevRoomId) !== Number(rows[0].room_id)) {
      try {
        _room_move = await childRoom.setChildRoom(db, {
          childId: rows[0].id,
          toRoomId: rows[0].room_id,
          effectiveDate: req.body.transfer_date || null,
          fromRoomId: _prevRoomId,
          actorId: req.user && req.user.id,
          source: 'profile',
        });
        if (_room_move && _room_move.booking && _room_move.booking.moved) {
          _transfer = _room_move.booking;   // shape kept for existing callers
        }
      } catch (tErr) { console.error('[children] room transfer propagation failed:', tErr.message); }
    }
    const _newKp = rows[0] ? rows[0].key_person_id : undefined;
    const _kpDiff = (_prevKp !== undefined && _newKp !== undefined && (_prevKp == null ? null : Number(_prevKp)) !== (_newKp == null ? null : Number(_newKp)))
      ? { key_person_id: { from: _prevKp == null ? null : Number(_prevKp), to: _newKp == null ? null : Number(_newKp) } } : undefined;
    recordAudit({ req, action: 'update', entity_type: 'child', entity_id: req.params.id,
      ...(_kpDiff ? { diff: _kpDiff } : {}),
      meta: { fields_changed: Object.keys(req.body).filter(k => fields.includes(k)),
              ...(_leave_bounded ? { bookings_bounded_by_leave_date: _leave_bounded } : {}),
              ...(_room_move ? { room_move: _room_move } : {}),
              ...(_transfer && _transfer.moved ? { room_transfer: _transfer } : {}) } });
    // b535 (2026-10-29) — a handful of fields on this row move the BILL: the funding
    // billing mode and stretch weeks, the funded-hours flags, the room, and the dates that
    // decide whether a month is a part month at all. When one of those is in the body, the
    // save says which invoices it has just made out of date (src/lib/invoice-pricing.js).
    // Scoped to those fields on purpose: a name or an address change must not pay for a
    // pricing scan. Never throws, so the save is unaffected either way.
    const _B535_BILLING_FIELDS = ['funding_billing_mode', 'stretch_weeks', 'funded_hours_15',
      'funded_hours_30', 'two_year_funded', 'funded_hours', 'room_id', 'room',
      'start_date', 'leave_date', 'status'];
    let _stale = null;
    if (_B535_BILLING_FIELDS.some(f => req.body[f] !== undefined)) {
      _stale = await require('../lib/invoice-pricing').staleForChild(db, req.params.id);
    }
    res.json({
      ...rows[0],
      ...(_transfer && _transfer.moved ? { room_transfer: _transfer } : {}),
      ...(_room_move ? { room_move: _room_move } : {}),
      ...(_leave_bounded ? { bookings_bounded_by_leave_date: _leave_bounded } : {}),
      ...(_stale ? { stale_invoices: _stale } : {}),
    });
    // sync CF allowlist after child update (email may have changed)
    syncCFAllowlist().catch(e => console.error('CF sync:', e.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tags ──────────────────────────────────────────────────────────────────────

const TAG_BOOL_MAP = {
  'SEND': { table: 'children', col: 'send_needs' },
  'LAC': { table: 'children', col: 'looked_after' },
  'Pupil Premium': { table: 'children', col: 'pupil_premium' },
  '15hr Funded': { table: 'children', col: 'funded_hours_15' },
  '30hr Funded': { table: 'children', col: 'funded_hours_30' },
  '2yr Funded': { table: 'children', col: 'two_year_funded' },
  'EAL': { table: 'about_me', col: 'eal' },
  'IEP': { table: 'about_me', col: 'individual_education_plan' },
  'IBP': { table: 'about_me', col: 'individual_behaviour_plan' },
  'Safeguarding': { table: 'about_me', col: 'safeguarding_flag' },
  'Children of Concern': { table: 'about_me', col: 'children_of_concern' },
  '1:1 Care': { table: 'about_me', col: 'one_to_one_care' },
};

// GET /api/tags/definitions — must come before /:id to avoid route conflict
router.get('/tags/definitions', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM tag_definitions WHERE is_active=true ORDER BY category, tag'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/tags
router.get('/:id/tags', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT ct.id, ct.tag, ct.tag_category, ct.added_at,
             td.colour, td.description, td.category
      FROM child_tags ct
      LEFT JOIN tag_definitions td ON td.tag=ct.tag
      WHERE ct.child_id=$1 ORDER BY ct.tag_category, ct.tag
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/tags
router.post('/:id/tags', async (req, res) => {
  const { role } = req.user;
  if (!['manager','deputy_manager','admin','room_leader','senior_practitioner'].includes(role))
    return res.status(403).json({ error: 'Insufficient role' });
  const { tag } = req.body;
  if (!tag) return res.status(400).json({ error: 'tag required' });
  const db = getPool();
  try {
    // Get tag definition for category
    const { rows: [def] } = await db.query('SELECT * FROM tag_definitions WHERE tag=$1', [tag]);
    await db.query(
      `INSERT INTO child_tags (child_id, tag, tag_category, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [req.params.id, tag, def?.category || 'general', req.user.id]
    );
    // Sync boolean fields
    const m = TAG_BOOL_MAP[tag];
    if (m) {
      if (m.table === 'children') {
        await db.query(`UPDATE children SET ${m.col}=true WHERE id=$1`, [req.params.id]);
      } else if (m.table === 'about_me') {
        await db.query(
          `INSERT INTO child_about_me (child_id, ${m.col}) VALUES ($1, true)
           ON CONFLICT (child_id) DO UPDATE SET ${m.col}=true, last_updated_at=NOW()`,
          [req.params.id]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id/tags/:tag
router.delete('/:id/tags/:tag', async (req, res) => {
  const { role } = req.user;
  if (!['manager','deputy_manager','admin','room_leader','senior_practitioner'].includes(role))
    return res.status(403).json({ error: 'Insufficient role' });
  try {
    await getPool().query(
      'DELETE FROM child_tags WHERE child_id=$1 AND tag=$2',
      [req.params.id, req.params.tag]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── About Me ─────────────────────────────────────────────────────────────────

// b268: the eleven questions the nursery's paper "All About Me" forms ask that
// had nowhere to go. Nine are ordinary text; two are safety fields —
// `food_texture` (choking risk, also read by the kitchen day sheet and the chef
// allergy briefing) and `premature_weeks` (drives corrected age wherever Wren
// shows age-banded developmental expectations).
const ABOUT_ME_B268_FIELDS = [
  'nickname', 'needs_help_with', 'communication_support',
  'premature_weeks', 'favourite_songs_rhymes', 'milk_vessel', 'feed_times',
  'finger_foods', 'spoon_foods', 'food_texture', 'sleep_method',
];
/** About Me columns typed integer — an empty string from a form must become NULL. */
const ABOUT_ME_INT_FIELDS = new Set(['premature_weeks', 'milk_amount_ml', 'feeds_per_day']);

/**
 * b268 — which half of the paper form applies to this child.
 * Drives which question set the About Me screen shows by default; a practitioner
 * can always reveal the other set, so this is a default and never a block.
 * Baby Room is "a room whose upper age bound is 2 or under", falling back to the
 * room name, falling back to the child's own age.
 */
function aboutMeAgeGroup(row) {
  if (!row) return 'preschool';
  const max = Number(row.max_age_months);
  if (Number.isFinite(max) && max > 0) return max <= 24 ? 'baby' : 'preschool';
  if (row.room_name && /baby|infant/i.test(row.room_name)) return 'baby';
  const months = Number(row.age_months);
  if (Number.isFinite(months)) return months < 24 ? 'baby' : 'preschool';
  return 'preschool';
}

// GET /:id/about-me
router.get('/:id/about-me', async (req, res) => {
  try {
    const db = getPool();
    const [amRes, ctxRes] = await Promise.all([
      db.query('SELECT * FROM child_about_me WHERE child_id=$1', [req.params.id]),
      db.query(`
        SELECT c.room_id, r.name AS room_name, r.max_age_months,
               (EXTRACT(YEAR FROM AGE(NOW(), c.date_of_birth)) * 12 +
                EXTRACT(MONTH FROM AGE(NOW(), c.date_of_birth)))::int AS age_months
        FROM children c LEFT JOIN rooms r ON r.id = c.room_id
        WHERE c.id = $1`, [req.params.id]),
    ]);
    const out = amRes.rows[0] || {};
    const ctx = ctxRes.rows[0] || null;
    // b268: room context so the screen can show the right half of the paper form.
    out.age_group = aboutMeAgeGroup(ctx);
    out.room_id = ctx ? ctx.room_id : null;
    out.room_name = ctx ? ctx.room_name : null;
    out.age_months = ctx ? ctx.age_months : null;
    // b268: corrected age, when the child was born early and is still under two.
    // Display only — the form still shows and saves the raw premature_weeks.
    const ca = correctedAge(out.age_months, out.premature_weeks);
    out.corrected_age_months = ca.corrected_age_months;
    out.corrected_age_label = ca.corrected_label || null;
    out.corrected_age_note = ca.note;
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/about-me (upsert)
router.put('/:id/about-me', requireCapabilityLevel('children.edit', 'edit'), async (req, res) => {
  if (!hasRole(req.user, CHILD_WRITE_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const db = getPool();
  const d = req.body;
  const fields = [
    'religion','first_language','other_languages','special_days','lives_with',
    'weekly_schedule','other_childcare_setting','key_person_other_setting',
    'interests','skills','fears','comforts','sleep_pattern','sleep_location','comforter',
    'nappy_size','nappy_type','potty_training',
    'breakfast_source','breakfast_notes','lunch_source','lunch_notes',
    'tea_source','tea_notes','milk_type','dietary_requirements','food_allergies',
    'food_preferences','medication','medical_notes',
    'gender_identity','pronouns','ethnicity','eal','send',
    'under_2_funded','two_year_funded','three_four_year_funded','thirty_hour_funded',
    'one_to_one_care','looked_after','pupil_premium','children_of_concern',
    'safeguarding_flag','individual_behaviour_plan','individual_education_plan',
    // b268 — paper-form parity (see ABOUT_ME_B268_FIELDS above)
    ...ABOUT_ME_B268_FIELDS,
  ];
  // b268: an empty text box arriving for an integer column is "not recorded",
  // not the string '' — Postgres rejects the latter and the whole save fails.
  const coerce = (f) => {
    const v = d[f];
    if (ABOUT_ME_INT_FIELDS.has(f)) {
      if (v === '' || v === null) return null;
      const n = parseInt(v, 10);
      return Number.isFinite(n) ? n : null;
    }
    return v;
  };
  const setClauses = fields.filter(f => d[f] !== undefined).map((f, i) => `${f}=$${i + 2}`);
  const vals = [req.params.id, ...fields.filter(f => d[f] !== undefined).map(coerce)];

  // Detect substantial content for completed_at
  const hasContent = ['interests','skills','lives_with','first_language'].some(f => d[f]);

  try {
    const existing = await db.query('SELECT id, completed_at FROM child_about_me WHERE child_id=$1', [req.params.id]);
    if (!existing.rows.length) {
      const flds = ['child_id', ...fields.filter(f => d[f] !== undefined)];
      const placeholders = flds.map((_,i) => `$${i+1}`).join(',');
      const insertVals = [req.params.id, ...fields.filter(f => d[f] !== undefined).map(coerce)];
      if (hasContent) { flds.push('completed_at', 'completed_by'); insertVals.push(new Date(), req.user?.role || 'staff'); }
      const { rows } = await db.query(
        `INSERT INTO child_about_me (${flds.join(',')}) VALUES (${flds.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,
        insertVals
      );
      return res.json(rows[0]);
    }
    if (!setClauses.length) return res.json(existing.rows[0]);
    const extra = hasContent && !existing.rows[0].completed_at
      ? `, completed_at=NOW(), completed_by='${req.user?.role || 'staff'}'` : '';
    const { rows } = await db.query(
      `UPDATE child_about_me SET ${setClauses.join(',')}, last_updated_at=NOW()${extra} WHERE child_id=$1 RETURNING *`,
      vals
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/photo — upload a child profile photo (2026-07-11; staff-portal only,
// served from /uploads/child-photos which is already GDPR-gated to admin/EY).
const _childPhotoDir = '/app/uploads/child-photos';
const _childPhotoUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb){ fs.mkdirSync(_childPhotoDir, { recursive: true }); cb(null, _childPhotoDir); },
    filename(req, file, cb){ const ext = (path.extname(file.originalname).toLowerCase()||'.jpg').replace('.jpeg','.jpg'); cb(null, String(req.params.id)+ext); },
  }),
  limits: { fileSize: 8*1024*1024 },
  fileFilter(req, file, cb){ cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)); },
});
router.post('/:id/photo', _childPhotoUpload.single('photo'), async (req, res) => {
  if (!hasRole(req.user, CHILD_WRITE_ROLES)) return res.status(403).json({ error: 'Insufficient role' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = '/uploads/child-photos/' + req.file.filename;
  try {
    await getPool().query('UPDATE children SET photo_url=$1, updated_at=NOW() WHERE id=$2', [url, req.params.id]);
    res.json({ photo_url: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Carer Restrictions (s06) ──────────────────────────────────────────────────

// GET /:id/restrictions — list all restrictions for a child
router.get('/:id/restrictions', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT r.*, s.first_name || ' ' || s.last_name as created_by_name
      FROM carer_restrictions r
      LEFT JOIN staff s ON s.id = r.created_by
      WHERE r.child_id=$1
      ORDER BY r.active DESC, r.created_at DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/restrictions — add a new restriction
router.post('/:id/restrictions', async (req, res) => {
  if (!hasRole(req.user, CHILD_WRITE_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const { restricted_person_name, restriction_type, court_order_ref, details } = req.body;
  if (!restricted_person_name || !restriction_type) {
    return res.status(400).json({ error: 'restricted_person_name and restriction_type required' });
  }
  const validTypes = ['no_collect','no_contact','court_order','other'];
  if (!validTypes.includes(restriction_type)) {
    return res.status(400).json({ error: 'Invalid restriction_type' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO carer_restrictions
        (child_id, restricted_person_name, restriction_type, court_order_ref, details, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [req.params.id, restricted_person_name, restriction_type, court_order_ref || null, details || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'carer_restriction', entity_id: rows[0].id,
      meta: { child_id: req.params.id, restricted_person_name, restriction_type } });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/restrictions/:restrictionId — deactivate/reactivate a restriction
router.put('/:id/restrictions/:restrictionId', async (req, res) => {
  if (!hasRole(req.user, CHILD_WRITE_ROLES)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const { active } = req.body;
  if (active === undefined) {
    return res.status(400).json({ error: 'active field required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE carer_restrictions SET active=$1 WHERE id=$2 AND child_id=$3 RETURNING *',
      [active, req.params.restrictionId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    recordAudit({ req, action: 'update', entity_type: 'carer_restriction', entity_id: req.params.restrictionId,
      meta: { child_id: req.params.id, active } });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// GET /:id/contacts — every contact on file for this child, including the people who
// do not fit the four flat slots on the child row (grandparents, family friends).
// Read-only: the profile shows them so nothing is hidden behind the form.
router.get('/:id/contacts', async (req, res) => {
  try {
    const { contactsForChild } = require('../lib/family-contacts');
    res.json({ contacts: await contactsForChild(getPool(), parseInt(req.params.id, 10)) });
  } catch (e) {
    console.error('[children] contacts list failed:', e.message);
    res.status(500).json({ error: 'Could not load the contacts' });
  }
});

// ── b342 (2026-09-21) — a family proposes who can collect; the office decides ─────────────────────────
// A parent's tick-box in the parents' app only ever sets contacts.collect_proposed. Nobody can collect
// on the strength of it: this is the one place a proposal becomes an authorised_collectors row.
// POST /:id/contacts/:contactId/collect   { decision: 'confirm' | 'decline' }
router.post('/:id/contacts/:contactId/collect', requireCapabilityLevel('children.edit', 'edit'), async (req, res) => {
  const childId = parseInt(req.params.id, 10), contactId = parseInt(req.params.contactId, 10);
  const decision = req.body && req.body.decision;
  if (!Number.isInteger(childId) || !Number.isInteger(contactId)) return res.status(400).json({ error: 'bad id' });
  if (!['confirm', 'decline'].includes(decision)) return res.status(400).json({ error: "decision must be 'confirm' or 'decline'" });
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id, full_name, relationship, primary_phone, collect_proposed
         FROM contacts WHERE id = $1 AND $2 = ANY(child_ids) AND is_emergency_contact`, [contactId, childId]);
    if (!rows.length) return res.status(404).json({ error: 'That contact is not an emergency contact on this child' });
    const c = rows[0];
    if (!c.collect_proposed) return res.status(409).json({ error: 'The family has not asked for this person to collect' });
    if (decision === 'confirm') {
      if (!c.full_name || !String(c.full_name).trim()) return res.status(409).json({ error: 'This contact has no name, so it cannot go on the collection list' });
      await db.query(
        `INSERT INTO authorised_collectors (child_id, name, relationship, phone, can_collect, notes)
         VALUES ($1, $2, $3, $4, true, 'Proposed by the family in the parents app; confirmed by the office')
         ON CONFLICT (child_id, name) DO UPDATE SET relationship = EXCLUDED.relationship, phone = EXCLUDED.phone, can_collect = true`,
        [childId, String(c.full_name).trim(), c.relationship || null, c.primary_phone || null]);
      await db.query('UPDATE contacts SET collect_proposed = false, collect_declined_at = NULL WHERE id = $1', [contactId]);
    } else {
      await db.query('UPDATE contacts SET collect_proposed = false, collect_declined_at = now() WHERE id = $1', [contactId]);
    }
    recordAudit({ req, action: 'update', entity_type: 'collection_proposal', entity_id: contactId,
      meta: { child_id: childId, child_ids: [childId], decision, summary: decision === 'confirm' ? 'Collection proposal confirmed by the office' : 'Collection proposal declined by the office' } });
    res.json({ ok: true, decision });
  } catch (e) {
    console.error('[children] collect decision failed:', e.message);
    res.status(500).json({ error: 'Could not record that decision' });
  }
});

// GET /:id/family-changes — what the family has changed themselves, newest first. Field NAMES only: the
// values are on the profile, and this list is a trail, not a second copy of a family's details.
router.get('/:id/family-changes', async (req, res) => {
  const childId = parseInt(req.params.id, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad id' });
  try {
    const { rows } = await getPool().query(
      `SELECT occurred_at, entity_type, actor_type, meta->>'summary' AS summary
         FROM audit_log
        WHERE entity_type IN ('family_details', 'emergency_contact', 'signin_email', 'collection_proposal')
          AND meta->'child_ids' @> to_jsonb($1::int)
        ORDER BY occurred_at DESC, id DESC LIMIT 25`, [childId]);
    res.json({ changes: rows.map(r => ({ at: r.occurred_at, kind: r.entity_type, by: r.actor_type === 'parent' ? 'the family' : 'the office', summary: r.summary })) });
  } catch (e) {
    console.error('[children] family-changes failed:', e.message);
    res.status(500).json({ error: 'Could not load the changes' });
  }
});

module.exports = router;
// b190 (2026-08-18): exported so the EyLog importer can reuse the ONE transfer
// implementation instead of writing a second one (scripts/eylog-import/
// apply-room-transfer.js). Additive - `router` stays the default export.
module.exports._propagateRoomChange = _propagateRoomChange;
