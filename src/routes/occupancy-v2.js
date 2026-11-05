'use strict';
// ============================================================================
// OCCUPANCY V2 (b94, 2026-07-17) — month-by-month AGE-MIX forecast + editable
// persisted scenarios. Additive: new route file mounted at /api/occupancy-v2;
// nothing in occupancy.js / occupancy-sandbox.js is touched.
//
// Model (Toby's spec, kept deliberately simple):
//   • For each month M, a child counts if their [start_date, leave_date] window
//     overlaps M (NULL start = already started; NULL leave = still enrolled).
//   • Age band uses the child's age AT month M — whole calendar years at the
//     LAST day of M — so the baby→pre-school transition month IS the month of
//     the 2nd birthday ("transition month = birthday month").
//       baby   = under 2 at M      → Baby Room
//       two    = 2 at M            → Pre-school (2yo band)
//       three+ = 3 or 4 at M       → Pre-school (3+ band)
//   • A child aged >=5 at M with NO leave_date is EXCLUDED (assumed left for
//     school — same cut the old forecast used at 60 months); surfaced in
//     `aged_out_no_leave` so the gap is visible, not silent.
//   • Staff (EYFS statutory, per-age-band ceil then sum):
//       baby room:  ceil(baby / 3)
//       pre-school: ceil(two / 5) + ceil(three_plus / 8)
//     Months with total staff > 4 are flagged (Toby's max-4-staff target).
//
// Scenarios = real enrolment PLUS a JSON list of adjustments, persisted in
// occupancy_scenarios (CREATE TABLE IF NOT EXISTS — dev-safe, prod migration
// in ladn-ready/logs/b94-occupancy-v2.NOTES.md):
//   {type:'add_child',    label?, dob:'YYYY-MM-DD', start_date?, leave_date?}
//   {type:'remove_child', child_id, from?:'YYYY-MM-DD'}   // no from = never here
//   {type:'intake',       month:'YYYY-MM', count, age_years:2|3, stay_months?}
//   {type:'set_capacity', room:'baby'|'preschool', capacity}
//   {type:'mark_left',    child_id, from?:'YYYY-MM-DD'}   // b96: what-if a
//        likely-left child is closed off (leave_date = from, default today)
//
// b96 (2026-07-17) enrolment-lifecycle integration:
//   • NULL start_date + ZERO register attendance ever = NOT started (they were
//     previously assumed "already here", inflating every month). Excluded from
//     the forecast and surfaced in warnings.needs_start_date.
//   • Active started children with no register attendance in the last 21
//     nursery days = likely unrecorded leavers → warnings.likely_left (counted
//     in the forecast still — Toby decides; test the effect with mark_left).
// ============================================================================

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { ensureEnrolmentMiddleware } = require('../utils/enrolment'); // b96
// b315 — the ONE room writer. This file must not move a child itself.
const childRoom = require('../lib/child-room');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const RATIOS = { baby: 3, two: 5, threePlus: 8 };
const SCHOOL_AGE_YEARS = 5;
const MAX_STAFF_TARGET = 4;

router.use(authenticate);
router.use(ensureEnrolmentMiddleware(getPool));
// Leadership tool — same gate as the occupancy sandbox.
router.use((req, res, next) => {
  const role = req.user?.role;
  if (!['manager', 'deputy_manager', 'admin', 'room_leader'].includes(role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

// ── occupancy_scenarios table (idempotent, additive) ─────────────────────────
let _tableReady = false;
async function ensureTable(db) {
  if (_tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS occupancy_scenarios (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      notes       TEXT,
      adjustments JSONB NOT NULL DEFAULT '[]'::jsonb,
      settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by  INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  _tableReady = true;
}

// ── date helpers (string maths, no TZ drift) ─────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
function ymd(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
// Last day of month (y, m 1-12)
function monthLastDay(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
// Whole calendar years between dob and dateStr (both 'YYYY-MM-DD') — matches
// Postgres extract(year from age(date, dob)).
function ageYearsAt(dob, dateStr) {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [y, m, d] = dateStr.split('-').map(Number);
  let years = y - by;
  if (m < bm || (m === bm && d < bd)) years--;
  return years;
}
function isYm(s) { return /^\d{4}-\d{2}$/.test(s || ''); }
function isYmdStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }
// dob for a hypothetical child exactly `ageYears` old on the 1st of month 'YYYY-MM'
function dobForAgeAt(ym, ageYears) {
  const [y, m] = ym.split('-').map(Number);
  return ymd(y - ageYears, m, 1);
}

// ── roster load + scenario application ───────────────────────────────────────
async function loadRoster(db) {
  const { rows } = await db.query(`
    SELECT id, first_name || ' ' || COALESCE(left(last_name, 1) || '.', '') AS name,
           date_of_birth::text AS dob, start_date::text AS start_date,
           leave_date::text AS leave_date, enrolment_status,
           EXISTS (SELECT 1 FROM attendance a
                   WHERE a.child_id = children.id
                     AND COALESCE(a.absent, false) = false) AS has_attendance
    FROM children
    WHERE is_active = true AND date_of_birth IS NOT NULL
      AND COALESCE(is_demo, false) = false   -- 2026-07-23: demo/test children never
                                             -- count towards occupancy, ratios or staffing
    ORDER BY date_of_birth`);
  return rows.map(r => ({ id: r.id, name: (r.name || '').trim(), dob: r.dob,
    start_date: r.start_date, leave_date: r.leave_date,
    enrolment_status: r.enrolment_status || null,
    has_attendance: !!r.has_attendance,
    // b96: NULL start + never on the register = NOT started (was previously
    // treated as "already attending") — excluded from the forecast until a
    // start_date is set.
    needs_start_date: !r.start_date && !r.has_attendance,
    virtual: false }));
}

// b96: likely unrecorded leavers — active started children with zero PRESENT
// register rows across the last N distinct register days ("nursery days").
// Children who started inside the window are skipped (too new to judge).
const LIKELY_LEFT_WINDOW_DAYS = 21;
async function likelyLeft(db) {
  const { rows: days } = await db.query(
    `SELECT DISTINCT date::text AS date FROM attendance
     ORDER BY date DESC LIMIT $1`, [LIKELY_LEFT_WINDOW_DAYS]);
  if (!days.length) return { child_ids: [], count: 0, window_days: LIKELY_LEFT_WINDOW_DAYS, window_from: null, register_days_available: 0 };
  const windowFrom = days[days.length - 1].date;
  const { rows } = await db.query(`
    SELECT c.id FROM children c
    WHERE c.is_active = true
      AND COALESCE(c.is_demo, false) = false   -- demo children are never "likely left"
      AND COALESCE(c.enrolment_status, 'attending') <> 'confirmed'
      AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)
      AND (c.start_date IS NULL OR c.start_date < $1::date)          -- not brand-new
      AND (c.start_date IS NOT NULL OR EXISTS (
             SELECT 1 FROM attendance a WHERE a.child_id = c.id
               AND COALESCE(a.absent, false) = false))                -- has actually started
                                                                      -- (present rows only, so
                                                                      -- needs_start_date children
                                                                      -- aren't double-listed)
      AND NOT EXISTS (
        SELECT 1 FROM attendance a
        WHERE a.child_id = c.id AND a.date >= $1::date
          AND COALESCE(a.absent, false) = false)
    ORDER BY c.id`, [windowFrom]);
  return { child_ids: rows.map(r => r.id), count: rows.length,
    window_days: LIKELY_LEFT_WINDOW_DAYS, window_from: windowFrom,
    register_days_available: days.length };
}

function applyAdjustments(roster, adjustments) {
  const caps = {};
  let v = 0;
  let out = roster.map(c => ({ ...c }));
  for (const a of adjustments || []) {
    if (!a || typeof a !== 'object') continue;
    switch (a.type) {
      case 'remove_child': {
        const id = Number(a.child_id);
        if (a.from && isYmdStr(a.from)) {
          const c = out.find(x => !x.virtual && x.id === id);
          if (c) c.leave_date = a.from;           // end early
        } else {
          out = out.filter(x => x.virtual || x.id !== id); // never here
        }
        break;
      }
      case 'add_child':
        if (isYmdStr(a.dob)) {
          out.push({ id: 'v' + (++v), name: a.label || 'New child', dob: a.dob,
            start_date: isYmdStr(a.start_date) ? a.start_date : null,
            leave_date: isYmdStr(a.leave_date) ? a.leave_date : null, virtual: true,
            pattern_days: cleanDays(a.days) || null }); // b98: optional booked days
        }
        break;
      case 'intake': {
        if (!isYm(a.month)) break;
        const n = Math.min(Math.max(Number(a.count) || 0, 0), 30);
        const age = Number(a.age_years) === 3 ? 3 : Number(a.age_years) === 1 ? 1 : Number(a.age_years) === 0 ? 0 : 2;
        const [iy, im] = a.month.split('-').map(Number);
        const start = ymd(iy, im, 1);
        let leave = null;
        const stay = Number(a.stay_months);
        if (Number.isFinite(stay) && stay > 0) {
          const total = im - 1 + stay;
          leave = ymd(iy + Math.floor(total / 12), (total % 12) + 1, 1);
        }
        for (let i = 0; i < n; i++) {
          out.push({ id: 'v' + (++v), name: `Intake ${a.month} #${i + 1}`, dob: dobForAgeAt(a.month, age),
            start_date: start, leave_date: leave, virtual: true });
        }
        break;
      }
      case 'mark_left': {
        // b96: what-if for a likely-unrecorded-leaver — give them a leave_date
        // (default today) so the following months drop them.
        const id = Number(a.child_id);
        const c = out.find(x => !x.virtual && x.id === id);
        if (c) c.leave_date = isYmdStr(a.from) ? a.from : new Date().toISOString().slice(0, 10);
        break;
      }
      case 'set_capacity': {
        const cap = Number(a.capacity);
        if (['baby', 'preschool'].includes(a.room) && Number.isFinite(cap) && cap > 0) caps[a.room] = cap;
        break;
      }
      case 'set_pattern': {
        // b98: per-child weekly booked-days override (week-forecast only; the
        // monthly model ignores patterns). days = ISO weekday ints 1(Mon)–5(Fri).
        const days = cleanDays(a.days);
        if (!days) break;
        const c = out.find(x => String(x.id) === String(a.child_id));
        if (c) c.pattern_days = days;
        break;
      }
      default: break;
    }
  }
  return { roster: out, caps };
}

// ── b101: room resolution (age rule + child_room_moves override) ─────────────
// Room assignment at a date is the LATEST recorded move on/before that date; if
// none, the age rule (under-2 → Baby Room, 2+ → Pre-school). LADN moves some
// under-2s to pre-school EARLY, so the override can put an under-2 in Pre-school
// before their 2nd birthday. Ratio BAND stays age-based (EYFS is age-based, not
// room-based), so an early-moved under-2 is still staffed at 1:3 — just inside
// the Pre-school room's headcount.
//   opts.movesByChild : Map(child_id → [{to_room_id, moved_on}] sorted ASC)
//   opts.roomClassOf  : { [room_id]: 'baby' | 'preschool' }
// Both optional — absent (or a virtual scenario child) → pure age rule, i.e.
// output is byte-for-byte identical to the pre-b101 model.
function resolveRoom(c, ageDateStr, roomClassOf, movesByChild, roomDateStr) {
  const age = ageYearsAt(c.dob, ageDateStr);
  const moveDate = roomDateStr || ageDateStr;     // week model resolves the move at the actual day
  let room = age < 2 ? 'baby' : 'preschool';
  let room_source = 'age';
  let move = null;
  if (!c.virtual && movesByChild && movesByChild.has(c.id)) {
    for (const mv of movesByChild.get(c.id)) {
      if (mv.moved_on <= moveDate) move = mv; else break;   // list is sorted ascending
    }
    if (move && roomClassOf && roomClassOf[move.to_room_id]) {
      room = roomClassOf[move.to_room_id];
      room_source = 'override';
    } else { move = null; }
  }
  const band = age < 2 ? 'u2' : age === 2 ? 'two' : 'threePlus';
  return { age, room, room_source, band, move };
}
// Per-room, per-age-band EYFS staffing (under-2 1:3, 2yo 1:5, 3+ 1:8). Summed
// per band so a mixed room (e.g. an early-moved under-2 in Pre-school) is costed
// correctly. With no overrides each room holds one band → reduces to the old
// ceil(baby/3) / ceil(2yo/5)+ceil(3+/8) formula exactly.
function roomStaff(band) {
  return Math.ceil(band.u2 / RATIOS.baby) + Math.ceil(band.two / RATIOS.two) + Math.ceil(band.threePlus / RATIOS.threePlus);
}

// b134 (2026-07-22) — Pre-school age-mix (2/3/4) + exact fractional ratio staffing.
// Additive only: never changes a ratio or the statutory ceil above, just makes
// the fractional slack/shortfall (e.g. "5 rostered, exact need 3.7") visible.
const round2 = n => Math.round(n * 100) / 100;
// Same ratios/shape as roomStaff() but unrounded — call on the SAME band tally
// (rooms.baby / rooms.preschool) so it reduces to the ceil exactly when no
// override mixes bands into a room. `total` is summed from the raw fractions
// (not from the rounded two/three_plus) to avoid compounding rounding error.
function roomStaffExact(band) {
  const u2 = band.u2 / RATIOS.baby, two = band.two / RATIOS.two, threePlus = band.threePlus / RATIOS.threePlus;
  return { two: round2(two), three_plus: round2(threePlus), total: round2(u2 + two + threePlus) };
}
// Split the threePlus band by exact age (3 vs 4+, the Sept school-leaver
// cohort) — same 1:8 ratio for both, this is visibility only. Call inline
// alongside `rooms[room][band]++` where `age` is already in scope.
function bumpAgeMix(mix, room, band, age) {
  if (band === 'two') mix[room].two++;
  else if (band === 'threePlus') { if (age === 3) mix[room].three++; else mix[room].four++; }
}
// Same split from an already-tallied child list (buildRegister keeps per-child
// objects with .band/.age, so no need to re-derive age there).
function ageMixTally(list) {
  const t = { two: 0, three: 0, four: 0 };
  for (const c of list) {
    if (c.band === 'two') t.two++;
    else if (c.band === 'threePlus') { if (c.age === 3) t.three++; else t.four++; }
  }
  return t;
}

// ── core month-by-month model ────────────────────────────────────────────────
function forecastSeries(roster, fromY, fromM /* 1-12 */, months, caps, opts = {}) {
  const { movesByChild, roomClassOf, detail } = opts;
  const series = [];
  for (let k = 0; k < months; k++) {
    const y = fromY + Math.floor((fromM - 1 + k) / 12);
    const m = ((fromM - 1 + k) % 12) + 1;
    const first = ymd(y, m, 1);
    const last = ymd(y, m, monthLastDay(y, m));
    const rooms = { baby: { u2: 0, two: 0, threePlus: 0 }, preschool: { u2: 0, two: 0, threePlus: 0 } };
    const ageMix = { baby: { two: 0, three: 0, four: 0 }, preschool: { two: 0, three: 0, four: 0 } }; // b134
    const agedOut = [], transitions = [], starters = [], leavers = [];
    const children = detail ? [] : null;
    for (const c of roster) {
      if (c.start_date && c.start_date > last) continue;   // not started yet
      if (c.leave_date && c.leave_date < first) continue;  // already left
      const { age, room, room_source, band, move } = resolveRoom(c, last, roomClassOf, movesByChild);
      if (c.start_date && c.start_date >= first && c.start_date <= last) starters.push({ id: c.id, name: c.name });
      if (c.leave_date && c.leave_date >= first && c.leave_date <= last) leavers.push({ id: c.id, name: c.name });
      if (age >= SCHOOL_AGE_YEARS && !c.leave_date) { agedOut.push({ id: c.id, name: c.name }); continue; }
      rooms[room][band]++;
      bumpAgeMix(ageMix, room, band, age); // b134
      // Transition = baby→pre this month, whether from turning 2 (age rule) or a
      // recorded early room move dated inside this month.
      if (room === 'preschool') {
        const [by, bm] = c.dob.split('-').map(Number);
        const ageMove = age === 2 && by + 2 === y && bm === m;
        const recordedMove = room_source === 'override' && move && move.moved_on >= first && move.moved_on <= last;
        if (ageMove || recordedMove) transitions.push({ id: c.id, name: c.name, source: recordedMove ? 'override' : 'age' });
      }
      if (children) children.push({ id: c.id, name: c.name, age, room, band, room_source });
    }
    const baby = rooms.baby.u2 + rooms.baby.two + rooms.baby.threePlus;
    const preU2 = rooms.preschool.u2, two = rooms.preschool.two, threePlus = rooms.preschool.threePlus;
    const preCount = preU2 + two + threePlus;
    const staffBaby = roomStaff(rooms.baby);
    const staffPre = roomStaff(rooms.preschool);
    const staffTotal = staffBaby + staffPre;
    const babyExact = roomStaffExact(rooms.baby), preExact = roomStaffExact(rooms.preschool); // b134
    series.push({
      month: `${y}-${pad2(m)}`,
      baby, two, three_plus: threePlus,
      preschool_early_u2: preU2,            // b101: under-2s moved to pre-school EARLY (0 unless a room-move override applies)
      preschool_total: preCount, total_children: baby + preCount,
      staff_baby: staffBaby, staff_preschool: staffPre, staff_total: staffTotal,
      over_staff_target: staffTotal > MAX_STAFF_TARGET,
      // b134: 2yo/3yo/4yo+ split (Sept school-leaver cohort visible) + RAW
      // fractional staffing need alongside the ceil above — never replaces it.
      age_mix_baby: ageMix.baby, age_mix_preschool: ageMix.preschool,
      staff_exact_baby: babyExact.total,
      staff_exact_preschool: { two: preExact.two, three_plus: preExact.three_plus, total: preExact.total },
      staff_exact_total: round2(babyExact.total + preExact.total),
      baby_capacity: caps.baby, preschool_capacity: caps.preschool,
      baby_headroom: caps.baby - baby, preschool_headroom: caps.preschool - preCount,
      baby_over: baby > caps.baby, preschool_over: preCount > caps.preschool,
      transitions, starters, leavers, aged_out_no_leave: agedOut,
      ...(children ? { children } : {}),
    });
  }
  return series;
}

async function roomCaps(db) {
  // Real room capacities; fall back to Toby's known numbers if rooms is empty.
  const caps = { baby: 10, preschool: 25 };
  try {
    const { rows } = await db.query(`SELECT name, capacity, min_age_months FROM rooms ORDER BY min_age_months`);
    for (const r of rows) {
      if (Number(r.min_age_months) < 24) caps.baby = Number(r.capacity) || caps.baby;
      else caps.preschool = Number(r.capacity) || caps.preschool;
    }
  } catch (_) { /* keep defaults */ }
  return caps;
}

// b101: room_id → 'baby' | 'preschool' (min_age_months < 24 = the baby room).
async function roomClasses(db) {
  const map = {};
  try {
    const { rows } = await db.query(`SELECT id, min_age_months FROM rooms`);
    for (const r of rows) map[r.id] = Number(r.min_age_months) < 24 ? 'baby' : 'preschool';
  } catch (_) { /* no rooms table → age rule only */ }
  return map;
}

// b101: all recorded room moves, grouped by child, sorted ASC so resolveRoom can
// pick the latest move on/before a date. Table is optional (dev/older schemas).
async function loadRoomMoves(db) {
  const byChild = new Map();
  try {
    const { rows } = await db.query(
      `SELECT child_id, to_room_id, moved_on::text AS moved_on
       FROM child_room_moves ORDER BY child_id, moved_on ASC, id ASC`);
    for (const r of rows) {
      if (!byChild.has(r.child_id)) byChild.set(r.child_id, []);
      byChild.get(r.child_id).push({ to_room_id: r.to_room_id, moved_on: r.moved_on });
    }
  } catch (_) { /* table optional */ }
  return byChild;
}

// Shared handler: GET (?scenario_id=) and POST (inline {adjustments, settings})
// so the drawer can live-preview unsaved edits.
async function runForecast(req, res) {
  const db = getPool();
  try {
    const q = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
    const months = Math.min(Math.max(parseInt(q.months) || 18, 1), 36);
    const now = new Date();
    let fromY = now.getUTCFullYear(), fromM = now.getUTCMonth() + 1;
    if (isYm(q.from)) { const p = q.from.split('-').map(Number); fromY = p[0]; fromM = p[1]; }

    let adjustments = Array.isArray(q.adjustments) ? q.adjustments : [];
    let settings = (q.settings && typeof q.settings === 'object') ? q.settings : {};
    let scenario = null;
    if (q.scenario_id) {
      await ensureTable(db);
      const { rows } = await db.query(`SELECT * FROM occupancy_scenarios WHERE id=$1`, [q.scenario_id]);
      if (!rows.length) return res.status(404).json({ error: 'Scenario not found' });
      scenario = { id: rows[0].id, name: rows[0].name };
      adjustments = rows[0].adjustments || [];
      settings = rows[0].settings || {};
    }

    const baseCaps = await roomCaps(db);
    const fullRoster = await loadRoster(db);
    // b96: children with no start_date AND no attendance ever are NOT started —
    // excluded from the model until someone sets their start date.
    const needsStart = fullRoster.filter(c => c.needs_start_date);
    const baseRoster = fullRoster.filter(c => !c.needs_start_date);
    const likely = await likelyLeft(db).catch(e => {
      console.error('[occupancy-v2/likely-left]', e.message);
      return { child_ids: [], count: 0, window_days: LIKELY_LEFT_WINDOW_DAYS, window_from: null, register_days_available: 0 };
    });
    // b101: room-move overrides (authoritative for room assignment). detail=1 adds
    // per-month child lists (manager/deputy only — child names).
    const roomClassOf = await roomClasses(db);
    const movesByChild = await loadRoomMoves(db);
    const childSessions = await loadChildSessionMode(db);   // b115: 'full_day' at LADN
    const detail = hasRole(req.user, ['manager', 'deputy_manager', 'admin']) && String(q.detail) === '1';
    const { roster, caps: adjCaps } = applyAdjustments(baseRoster, adjustments);
    const caps = {
      baby: Number(settings.baby_capacity) || adjCaps.baby || baseCaps.baby,
      preschool: Number(settings.preschool_capacity) || adjCaps.preschool || baseCaps.preschool,
    };

    const series = forecastSeries(roster, fromY, fromM, months, caps, { movesByChild, roomClassOf, detail });
    const hasAdjustments = adjustments.length > 0 || caps.baby !== baseCaps.baby || caps.preschool !== baseCaps.preschool;
    const baseline = hasAdjustments
      ? forecastSeries(baseRoster, fromY, fromM, months, baseCaps, { movesByChild, roomClassOf }).map(s => ({
          month: s.month, baby: s.baby, two: s.two, three_plus: s.three_plus,
          staff_total: s.staff_total }))
      : null;

    const overMonths = series.filter(s => s.over_staff_target).map(s => s.month);
    const peak = series.reduce((mx, s) => s.staff_total > mx.staff_total ? s : mx, series[0]);
    res.json({
      generated: new Date().toISOString().slice(0, 10),
      from: series[0].month, months,
      ratios: RATIOS, staff_target: MAX_STAFF_TARGET,
      capacities: caps, scenario, child_sessions: childSessions,   // b115
      model_notes: [
        'Age band = whole years at the LAST day of each month, so a child moves baby→pre-school in the month of their 2nd birthday.',
        'A child counts in a month when their start/leave window overlaps it (no start date + register history = already started).',
        `Children aged ${SCHOOL_AGE_YEARS}+ with no leave date are excluded (assumed gone to school) and listed in aged_out_no_leave.`,
        'Staff = ceil(baby/3) for Baby Room, ceil(2yo/5) + ceil(3+/8) for Pre-school (per-band ceil, then sum).',
        ...(movesByChild.size ? [`Room assignment honours ${movesByChild.size} recorded room move${movesByChild.size === 1 ? '' : 's'} (child_room_moves) — an early move puts a child in Pre-school before their 2nd birthday; band/ratio stays age-based.`] : []),
        ...(needsStart.length ? [`${needsStart.length} child${needsStart.length === 1 ? '' : 'ren'} need start dates (no start date and never on the register) — excluded from this forecast until a start date is set.`] : []),
        ...(likely.count ? [`${likely.count} active child${likely.count === 1 ? '' : 'ren'} have zero register attendance in the last ${likely.register_days_available} nursery days — likely unrecorded leavers. Still counted; use a mark_left adjustment to test the effect.`] : []),
      ],
      warnings: {
        needs_start_date: { count: needsStart.length, child_ids: needsStart.map(c => c.id) },
        likely_left: likely,
      },
      series, baseline,
      summary: {
        months_over_staff_target: overMonths,
        peak_staff: { month: peak.month, staff_total: peak.staff_total },
      },
    });
  } catch (e) {
    console.error('[occupancy-v2/forecast]', e);
    res.status(500).json({ error: e.message });
  }
}
router.get('/forecast', runForecast);
router.post('/forecast', runForecast);

// ── children picker for the scenario drawer (name + dates only) ──────────────
router.get('/children', async (req, res) => {
  try { res.json(await loadRoster(getPool())); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── scenario CRUD ────────────────────────────────────────────────────────────
function cleanAdjustments(a) {
  if (!Array.isArray(a)) return null;
  const ok = ['add_child', 'remove_child', 'intake', 'set_capacity', 'mark_left', 'set_pattern', // b98: + set_pattern
    'add_staff', 'remove_staff', 'set_staff_pattern']; // b105: staff-side scenario adjustments (rota only; the child forecast ignores them)
  return a.filter(x => x && typeof x === 'object' && ok.includes(x.type));
}

router.get('/scenarios', async (req, res) => {
  try {
    const db = getPool(); await ensureTable(db);
    const { rows } = await db.query(`
      SELECT id, name, notes, jsonb_array_length(adjustments) AS adjustment_count,
             created_at, updated_at
      FROM occupancy_scenarios ORDER BY updated_at DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/scenarios', async (req, res) => {
  const { name, notes, adjustments, settings } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  const adj = cleanAdjustments(adjustments) || [];
  try {
    const db = getPool(); await ensureTable(db);
    const { rows } = await db.query(
      `INSERT INTO occupancy_scenarios (name, notes, adjustments, settings, created_by)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5) RETURNING *`,
      [String(name).trim(), notes || null, JSON.stringify(adj),
       JSON.stringify(settings && typeof settings === 'object' ? settings : {}), req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/scenarios/:id', async (req, res) => {
  try {
    const db = getPool(); await ensureTable(db);
    const { rows } = await db.query(`SELECT * FROM occupancy_scenarios WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/scenarios/:id', async (req, res) => {
  const { name, notes, adjustments, settings } = req.body || {};
  const adj = cleanAdjustments(adjustments);
  if (adj === null) return res.status(400).json({ error: 'adjustments array required' });
  try {
    const db = getPool(); await ensureTable(db);
    const { rows } = await db.query(
      `UPDATE occupancy_scenarios
         SET name = COALESCE($2, name), notes = COALESCE($3, notes),
             adjustments = $4::jsonb, settings = COALESCE($5::jsonb, settings),
             updated_at = now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, name ? String(name).trim() : null, notes !== undefined ? notes : null,
       JSON.stringify(adj),
       settings && typeof settings === 'object' ? JSON.stringify(settings) : null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/scenarios/:id', async (req, res) => {
  try {
    const db = getPool(); await ensureTable(db);
    const { rows } = await db.query(`DELETE FROM occupancy_scenarios WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted_id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// b98 (2026-07-17) — DAY-LEVEL "week by week" view. APPEND-ONLY below here.
//
// Toby: "if a child does Tues/Thurs and another does Mon/Wed/Fri they don't
// overlap — I want it week by week."
//
// Weekly attendance patterns (set of weekdays Mon–Fri, ISO 1–5):
//   1. Scenario override: {type:'set_pattern', child_id, days:[1..5]} — also
//      add_child accepts days:[..]. Stored in the same adjustments JSONB.
//   2. Derived from register history: last PATTERN_WINDOW_DAYS (~6 wks) of
//      attendance, anchored at max(date). A weekday is "booked" if the child
//      was PRESENT on it in >=50% of the weeks that weekday appears in the
//      register window. Child has presence but no weekday reaches 50% →
//      fall back to "any weekday attended" (sparse ad-hoc attender, better
//      than dropping them to zero days).
//   3. No history at all (confirmed / Sept starters) → default full week
//      Mon–Fri (configurable: settings.default_pattern_days) and counted in
//      warnings.no_pattern ("N starters have no booked pattern — add one").
//
// Age band per day = whole years at the LAST day of that day's month — same
// rule as the monthly model, so baby→pre-school still moves in the month of
// the 2nd birthday and week totals reconcile with the monthly table.
// Bank holidays / closure days are NOT modelled — every Mon–Fri is a nursery day.
// ============================================================================

const PATTERN_WINDOW_DAYS = 42; // ~6 weeks of register history
const ALL_WEEKDAYS = [1, 2, 3, 4, 5];
const DOW_NAMES = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri' };

function addDaysStr(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
function isoDowOf(s) {
  const [y, m, d] = s.split('-').map(Number);
  const g = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return g === 0 ? 7 : g;
}
function monthEndOf(s) {
  const [y, m] = s.split('-').map(Number);
  return ymd(y, m, monthLastDay(y, m));
}
function mondayOf(s) { return addDaysStr(s, 1 - isoDowOf(s)); }
// Normalise a days array → sorted unique ints 1–5, or null if nothing valid.
function cleanDays(days) {
  if (!Array.isArray(days)) return null;
  const d = [...new Set(days.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= 5))].sort();
  return d.length ? d : null;
}

// Derive per-child weekly patterns from the register (see header comment).
async function derivePatterns(db) {
  const { rows: meta } = await db.query(`SELECT max(date)::text AS maxd FROM attendance`);
  const maxd = meta[0] && meta[0].maxd;
  const byChild = new Map();
  if (!maxd) return { byChild, register_to: null, window_days: PATTERN_WINDOW_DAYS };
  const { rows } = await db.query(`
    WITH wk_days AS (
      SELECT DISTINCT EXTRACT(isodow FROM date)::int AS dow,
             date_trunc('week', date)::date AS wk
      FROM attendance
      WHERE date > $1::date - $2::int AND date <= $1::date
        AND EXTRACT(isodow FROM date) BETWEEN 1 AND 5
    ),
    denom AS (SELECT dow, COUNT(*)::int AS wks FROM wk_days GROUP BY dow),
    pres AS (
      SELECT a.child_id, EXTRACT(isodow FROM a.date)::int AS dow,
             COUNT(DISTINCT date_trunc('week', a.date)::date)::int AS wks_present
      FROM attendance a
      WHERE a.date > $1::date - $2::int AND a.date <= $1::date
        AND COALESCE(a.absent, false) = false
        AND EXTRACT(isodow FROM a.date) BETWEEN 1 AND 5
      GROUP BY 1, 2
    )
    SELECT p.child_id, p.dow, (p.wks_present * 2 >= d.wks) AS booked
    FROM pres p JOIN denom d USING (dow)
    ORDER BY p.child_id, p.dow`, [maxd, PATTERN_WINDOW_DAYS]);
  const anyPresence = new Map(); // fallback: weekdays with ANY presence
  for (const r of rows) {
    const id = Number(r.child_id);
    if (!anyPresence.has(id)) anyPresence.set(id, []);
    anyPresence.get(id).push(r.dow);
    if (r.booked) {
      if (!byChild.has(id)) byChild.set(id, []);
      byChild.get(id).push(r.dow);
    }
  }
  // presence but nothing hit 50% → sparse fallback (any weekday attended)
  for (const [id, days] of anyPresence) if (!byChild.has(id)) byChild.set(id, days);
  return { byChild, register_to: maxd, window_days: PATTERN_WINDOW_DAYS };
}

// GET/POST /api/occupancy-v2/week-forecast?weeks=N[&scenario_id=][&from_week=YYYY-MM-DD]
// POST accepts inline {adjustments, settings} for live scenario preview,
// exactly like /forecast.
async function runWeekForecast(req, res) {
  const db = getPool();
  try {
    const q = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
    const weeks = Math.min(Math.max(parseInt(q.weeks) || 26, 1), 52);

    let adjustments = Array.isArray(q.adjustments) ? q.adjustments : [];
    let settings = (q.settings && typeof q.settings === 'object') ? q.settings : {};
    let scenario = null;
    if (q.scenario_id) {
      await ensureTable(db);
      const { rows } = await db.query(`SELECT * FROM occupancy_scenarios WHERE id=$1`, [q.scenario_id]);
      if (!rows.length) return res.status(404).json({ error: 'Scenario not found' });
      scenario = { id: rows[0].id, name: rows[0].name };
      adjustments = rows[0].adjustments || [];
      settings = rows[0].settings || {};
    }

    const baseCaps = await roomCaps(db);
    const fullRoster = await loadRoster(db);
    const needsStart = fullRoster.filter(c => c.needs_start_date); // same b96 cut as /forecast
    const baseRoster = fullRoster.filter(c => !c.needs_start_date);
    const pat = await derivePatterns(db);
    // b101: room-move overrides + optional per-day drilldown (manager/deputy only)
    const roomClassOf = await roomClasses(db);
    const movesByChild = await loadRoomMoves(db);
    const childSessions = await loadChildSessionMode(db);   // b115: 'full_day' at LADN
    const detail = hasRole(req.user, ['manager', 'deputy_manager', 'admin']) && String(q.detail) === '1';
    const { roster, caps: adjCaps } = applyAdjustments(baseRoster, adjustments);
    const caps = {
      baby: Number(settings.baby_capacity) || adjCaps.baby || baseCaps.baby,
      preschool: Number(settings.preschool_capacity) || adjCaps.preschool || baseCaps.preschool,
    };

    const defaultDays = cleanDays(settings.default_pattern_days) || ALL_WEEKDAYS;
    for (const c of roster) {
      if (c.pattern_days) { c.pattern = c.pattern_days; c.pattern_source = 'override'; }
      else if (!c.virtual && pat.byChild.has(c.id)) { c.pattern = pat.byChild.get(c.id); c.pattern_source = 'register'; }
      else { c.pattern = defaultDays; c.pattern_source = 'default'; }
    }

    const startMonday = isYmdStr(q.from_week) ? mondayOf(q.from_week)
      : mondayOf(new Date().toISOString().slice(0, 10)); // current week incl.
    const series = [];
    const defaultAppearing = new Set(); // pattern-unknown children who actually count somewhere
    for (let w = 0; w < weeks; w++) {
      const monday = addDaysStr(startMonday, w * 7);
      const days = [];
      for (let i = 0; i < 5; i++) {
        const date = addDaysStr(monday, i);
        const bandDate = monthEndOf(date); // monthly-model parity: band = age this month
        const rooms = { baby: { u2: 0, two: 0, threePlus: 0 }, preschool: { u2: 0, two: 0, threePlus: 0 } };
        const ageMix = { baby: { two: 0, three: 0, four: 0 }, preschool: { two: 0, three: 0, four: 0 } }; // b134
        const dayChildren = detail ? [] : null;
        for (const c of roster) {
          if (!c.pattern.includes(i + 1)) continue;               // not a booked day
          if (c.start_date && c.start_date > date) continue;      // not started yet
          if (c.leave_date && c.leave_date < date) continue;      // already left
          // band = age at month-end (parity); room override resolved at this day
          const { age, room, room_source, band } = resolveRoom(c, bandDate, roomClassOf, movesByChild, date);
          if (age >= SCHOOL_AGE_YEARS && !c.leave_date) continue; // assumed at school
          rooms[room][band]++;
          bumpAgeMix(ageMix, room, band, age); // b134
          if (c.pattern_source === 'default') defaultAppearing.add(c.id);
          if (dayChildren) dayChildren.push({ id: c.id, name: c.name, age, room, band, room_source, pattern_source: c.pattern_source });
        }
        const baby = rooms.baby.u2 + rooms.baby.two + rooms.baby.threePlus;
        const preU2 = rooms.preschool.u2, two = rooms.preschool.two, threePlus = rooms.preschool.threePlus;
        const preCount = preU2 + two + threePlus;
        const staffBaby = roomStaff(rooms.baby);
        const staffPre = roomStaff(rooms.preschool);
        const staffTotal = staffBaby + staffPre;
        const babyExact = roomStaffExact(rooms.baby), preExact = roomStaffExact(rooms.preschool); // b134
        days.push({
          date, dow: i + 1, dow_name: DOW_NAMES[i + 1],
          baby, two, three_plus: threePlus, preschool_early_u2: preU2,
          preschool_total: preCount, total_children: baby + preCount,
          staff_baby: staffBaby, staff_preschool: staffPre, staff_total: staffTotal,
          over_staff_target: staffTotal > MAX_STAFF_TARGET,
          // b134: same 2yo/3yo/4yo+ split + RAW fractional need as /forecast.
          age_mix_baby: ageMix.baby, age_mix_preschool: ageMix.preschool,
          staff_exact_baby: babyExact.total,
          staff_exact_preschool: { two: preExact.two, three_plus: preExact.three_plus, total: preExact.total },
          staff_exact_total: round2(babyExact.total + preExact.total),
          baby_over: baby > caps.baby, preschool_over: preCount > caps.preschool,
          ...(dayChildren ? { children: dayChildren } : {}),
        });
      }
      const peak = days.reduce((mx, d) =>
        (d.staff_total > mx.staff_total ||
         (d.staff_total === mx.staff_total && d.total_children > mx.total_children)) ? d : mx, days[0]);
      const minD = days.reduce((mn, d) => d.total_children < mn.total_children ? d : mn, days[0]);
      series.push({
        week_start: monday, days,
        peak_day: { date: peak.date, dow_name: peak.dow_name, total_children: peak.total_children, staff_total: peak.staff_total },
        min_day: { date: minD.date, dow_name: minD.dow_name, total_children: minD.total_children },
        staff_at_peak: peak.staff_total,
        over_staff_target: days.some(d => d.over_staff_target),
        cap_breach: days.some(d => d.baby_over || d.preschool_over),
      });
    }

    const noPattern = roster.filter(c => c.pattern_source === 'default' && defaultAppearing.has(c.id));
    const overWeeks = series.filter(s => s.over_staff_target).map(s => s.week_start);
    const peakWeek = series.reduce((mx, s) => s.staff_at_peak > mx.staff_at_peak ? s : mx, series[0]);
    res.json({
      generated: new Date().toISOString().slice(0, 10),
      from_week: startMonday, weeks,
      ratios: RATIOS, staff_target: MAX_STAFF_TARGET, capacities: caps, scenario,
      child_sessions: childSessions,   // b115: full_day at LADN
      pattern_window: { days: pat.window_days, register_to: pat.register_to,
        children_with_derived_pattern: pat.byChild.size,
        default_days: defaultDays },
      // real (non-virtual) children's resolved patterns, for the UI
      patterns: roster.filter(c => !c.virtual).map(c =>
        ({ id: c.id, name: c.name, days: c.pattern, source: c.pattern_source })),
      model_notes: [
        `Booked weekdays come from the last ~${pat.window_days} days of the register (present on a weekday in >=50% of its weeks = booked). Scenario set_pattern overrides win.`,
        `Children with no register history yet (new/Sept starters) are assumed ${defaultDays.length === 5 ? 'FULL WEEK Mon-Fri' : defaultDays.map(d => DOW_NAMES[d]).join('/')} until a pattern override is added.`,
        'Age band per day = age at the last day of that month (matches the monthly table: baby moves to pre-school in the 2nd-birthday month).',
        ...(movesByChild.size ? [`Room = ${movesByChild.size} recorded room move${movesByChild.size === 1 ? '' : 's'} (latest on/before each day) then the age rule — early moves show under Pre-school before the 2nd birthday.`] : []),
        'Bank holidays / closure days are not modelled — every Mon-Fri counts as a nursery day.',
      ],
      warnings: {
        no_pattern: {
          count: noPattern.length,
          child_ids: noPattern.filter(c => !c.virtual).map(c => c.id),
          message: noPattern.length
            ? `${noPattern.length} starter${noPattern.length === 1 ? ' has' : 's have'} no booked pattern — add one (Booked days override) or they count every weekday.`
            : null,
        },
        needs_start_date: { count: needsStart.length, child_ids: needsStart.map(c => c.id) },
      },
      series,
      summary: {
        weeks_over_staff_target: overWeeks,
        peak: { week_start: peakWeek.week_start, day: peakWeek.peak_day.dow_name,
          date: peakWeek.peak_day.date, staff_total: peakWeek.staff_at_peak,
          total_children: peakWeek.peak_day.total_children },
      },
    });
  } catch (e) {
    console.error('[occupancy-v2/week-forecast]', e);
    res.status(500).json({ error: e.message });
  }
}
router.get('/week-forecast', runWeekForecast);
router.post('/week-forecast', runWeekForecast);

// ============================================================================
// b101 (2026-07-17) — ROOM MOVES. child_room_moves is the authoritative source
// for a child's room in the forecast: an early move (e.g. a nearly-2yo shifted
// to Pre-school before their birthday) is recorded here and the forecast counts
// them in Pre-school from moved_on. All routes below inherit the manager gate
// (router.use above → manager / deputy_manager / room_leader).
//
// POST also lives in parent-reports.js (used by the report tracker for
// transition/settling reports) — that one is LEFT UNTOUCHED. This one adds
// current-room sync so recording a move actually moves the child operationally.
// ============================================================================

// GET /rooms — room list for the move picker (id, name, capacity, class)
router.get('/rooms', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, capacity, min_age_months,
              CASE WHEN min_age_months < 24 THEN 'baby' ELSE 'preschool' END AS klass
       FROM rooms ORDER BY min_age_months, id`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /room-moves[?child_id=] — recorded moves (newest first), with room names
router.get('/room-moves', async (req, res) => {
  const childId = req.query.child_id ? Number(req.query.child_id) : null;
  if (req.query.child_id && !Number.isInteger(childId)) return res.status(400).json({ error: 'child_id must be an integer' });
  try {
    const { rows } = await getPool().query(`
      SELECT m.id, m.child_id, m.from_room_id, m.to_room_id, m.moved_on::text AS moved_on,
             m.recorded_by, m.created_at, rf.name AS from_room, rt.name AS to_room
      FROM child_room_moves m
      LEFT JOIN rooms rf ON rf.id = m.from_room_id
      LEFT JOIN rooms rt ON rt.id = m.to_room_id
      WHERE ($1::int IS NULL OR m.child_id = $1)
      ORDER BY m.moved_on DESC, m.id DESC`, [childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /room-move {child_id, to_room_id, moved_on?} — record a move. If it is
// effective today or earlier, also sync children.room_id so registers/diary/
// kitchen reflect the move; a future-dated move only affects the forecast.
router.post('/room-move', async (req, res) => {
  const { child_id, to_room_id, moved_on } = req.body || {};
  if (!Number.isInteger(Number(child_id)) || !Number.isInteger(Number(to_room_id))) {
    return res.status(400).json({ error: 'child_id and to_room_id (integers) required' });
  }
  const today = new Date().toISOString().slice(0, 10);
  const d = (moved_on && isYmdStr(moved_on)) ? moved_on : today;
  try {
    const db = getPool();

    // b314 found THE BUG TOBY FOUND HERE: this endpoint wrote children.room_id
    // and a child_room_moves row and stopped. Occupancy reads neither — it takes
    // room_id from child_bookings. So a child moved here went on being counted in
    // the room she had left, on the board, in the ratios computed from it and in
    // the forecast. The move looked like it worked everywhere a manager checks and
    // was wrong everywhere a decision gets made.
    //
    // b315 stopped it from being possible to write only half. There is now one
    // room writer — src/lib/child-room.js setChildRoom() — which moves the
    // booking, keeps the profile in step and records the history in one call.
    // Six paths used to do this three different ways; this is one of them, and it
    // no longer has its own opinion about any of it.
    const move = await childRoom.setChildRoom(db, {
      childId: Number(child_id),
      toRoomId: Number(to_room_id),
      effectiveDate: d,
      actorId: req.user.id,
      source: 'occupancy-board',
    });
    if (!move.ok) {
      const status = move.reason === 'no_such_child' || move.reason === 'no_such_room' ? 404 : 400;
      return res.status(status).json({ error: move.reason });
    }
    res.status(201).json({
      ok: true,
      id: move.move_log_id,
      from_room_id: move.from_room_id,
      moved_on: move.effective,
      room_synced: move.profile_updated,
      booking_transfer: move.booking,
      bookings_synced: move.booking && move.booking.moved ? 1 : 0,
      // A move the occupancy board will never see, because nothing counts this
      // child at all. Said out loud rather than reported as a clean success.
      ...(move.warning ? { warning: move.warning, warning_detail: move.warning_detail } : {}),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /room-move/:id — undo a recorded move (does NOT revert children.room_id)
router.delete('/room-move/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  try {
    const { rows } = await getPool().query('DELETE FROM child_room_moves WHERE id=$1 RETURNING id', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted_id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// b105 (2026-07-20) — SEARCH-FIRST planner. APPEND-ONLY below here.
//
// Adds, on top of the b94/b96/b98/b101 engine (unchanged):
//   • GET /search?q=            typeahead over children AND staff
//   • GET /person/child/:id     one-card view: booked days/pattern, room,
//                               funded vs paid hours, est. weekly fee, dates,
//                               pending room-move
//   • GET /person/staff/:id     one-card view: work pattern / contracted hours
//                               / hourly cost
//   • GET|POST /rota?week=YYYY-MM-DD   for one week: the ROTA (staff per room
//                               per day, ratio-checked) + the REGISTER (children
//                               per room per day, scenario adjustments applied,
//                               NOT annotated) + a key-results strip (occupancy %,
//                               staff required vs scheduled, ratio breaches,
//                               weekly-fee delta vs baseline).
//
// Reuses loadRoster / applyAdjustments / derivePatterns / resolveRoom /
// roomStaff / roomCaps / roomClasses / loadRoomMoves. Staff-side scenario
// adjustments (add_staff / remove_staff / set_staff_pattern) live in the SAME
// adjustments JSONB and are applied ONLY in the rota builder — the child
// forecast's applyAdjustments() ignores them (its switch default is a no-op),
// so month/week forecasts are byte-identical to pre-b105.
//
// Fee model (honest estimate — the current per-family MEAL/extras rates are not
// in the DB): weekly fee = paid_hours × the band's funding_terms.inv_rate_*,
// where paid_hours = booked_days × session_hours − funded_hours_week (floored at
// 0). session_hours defaults to 10 (8am–6pm full day), settings-overridable.
// ============================================================================

const SESSION_HOURS_DEFAULT = 10;  // 8am–6pm full day
// Roles that do NOT count toward the EYFS floor ratio in the rota.
const NON_RATIO_ROLES = new Set(['cook', 'chef', 'kitchen', 'cleaner', 'admin', 'office']);

function normStaffRoom(text) {
  if (!text) return null;
  const t = String(text).toLowerCase();
  if (t.includes('bab')) return 'baby';
  if (t.includes('pre')) return 'preschool';
  if (t.includes('tod')) return 'preschool';
  return null;
}
function bandOfAge(age) { return age < 2 ? 'u2' : age === 2 ? 'two' : 'threePlus'; }
function bandRate(rates, band) { return band === 'u2' ? rates.under2 : band === 'two' ? rates.two : rates.threePlus; }

// funding_terms invoice rates for the current term (the closest thing to a
// private charge-out rate in the schema).
async function loadFeeRates(db) {
  const rates = { under2: 0, two: 0, threePlus: 0, term: null };
  try {
    const { rows } = await db.query(
      `SELECT id, name, inv_rate_under_2, inv_rate_2yr_working_parents, inv_rate_3yr_universal
       FROM funding_terms WHERE is_current ORDER BY start_date DESC LIMIT 1`);
    if (rows.length) {
      const r = rows[0];
      rates.under2 = Number(r.inv_rate_under_2) || 0;
      rates.two = Number(r.inv_rate_2yr_working_parents) || 0;
      rates.threePlus = Number(r.inv_rate_3yr_universal) || 0;
      rates.term = { id: r.id, name: r.name };
    }
  } catch (_) { /* no funding_terms → zero rates, fee shows 0 */ }
  return rates;
}
// Booked weekdays per child from child_bookings (merged across active rows).
async function loadBookings(db) {
  const byChild = new Map();
  try {
    const { rows } = await db.query(
      `SELECT child_id, mon, tue, wed, thu, fri, room_id, funded FROM child_bookings WHERE is_active = true`);
    for (const r of rows) {
      const days = [];
      if (r.mon) days.push(1); if (r.tue) days.push(2); if (r.wed) days.push(3); if (r.thu) days.push(4); if (r.fri) days.push(5);
      const prev = byChild.get(r.child_id);
      if (prev) { prev.days = [...new Set([...prev.days, ...days])].sort(); prev.funded = prev.funded || !!r.funded; }
      else byChild.set(r.child_id, { days, room_id: r.room_id, funded: !!r.funded });
    }
  } catch (_) { /* table optional */ }
  return byChild;
}
// Current-term funded hours per child.
async function loadFunding(db) {
  const byChild = new Map();
  try {
    const { rows } = await db.query(
      `SELECT cf.child_id, cf.funding_type, cf.total_hours_week, cf.universal_hours_week,
              cf.extended_hours_week, cf.stretched_funding
       FROM child_funding cf JOIN funding_terms t ON t.id = cf.term_id WHERE t.is_current`);
    for (const r of rows) byChild.set(r.child_id, {
      funding_type: r.funding_type, total_hours_week: Number(r.total_hours_week) || 0,
      universal: Number(r.universal_hours_week) || 0, extended: Number(r.extended_hours_week) || 0,
      stretched: !!r.stretched_funding });
  } catch (_) { /* table optional */ }
  return byChild;
}
function computeFee(band, days, fundingRow, rates, sessionHours) {
  const bookedDays = (days || []).length;
  const bookedHours = bookedDays * sessionHours;
  const funded = fundingRow ? fundingRow.total_hours_week : 0;
  const paidHours = Math.max(0, bookedHours - funded);
  const rate = bandRate(rates, band);
  return { booked_days: bookedDays, booked_hours: bookedHours, funded_hours: funded,
    paid_hours: paidHours, rate, weekly_fee: Math.round(paidHours * rate * 100) / 100 };
}

// Assign each roster child a weekly booked-days pattern (b98 rule), in place.
function assignChildPatterns(roster, pat, defaultDays) {
  for (const c of roster) {
    if (c.pattern_days) { c.pattern = c.pattern_days; c.pattern_source = 'override'; }
    else if (!c.virtual && pat.byChild.has(c.id)) { c.pattern = pat.byChild.get(c.id); c.pattern_source = 'register'; }
    else { c.pattern = defaultDays; c.pattern_source = 'default'; }
  }
}

// ── GET /search?q= — typeahead over children AND staff ───────────────────────
router.get('/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ children: [], staff: [], q: '' });
  const db = getPool();
  const like = '%' + q.replace(/[%_\\]/g, '') + '%';
  try {
    const children = (await db.query(`
      SELECT c.id, c.first_name || ' ' || COALESCE(left(c.last_name,1) || '.', '') AS name,
             r.name AS room, c.enrolment_status, c.start_date::text AS start_date, c.leave_date::text AS leave_date,
             EXISTS (SELECT 1 FROM child_funding cf JOIN funding_terms t ON t.id = cf.term_id
                     WHERE t.is_current AND cf.child_id = c.id) AS funded
      FROM children c LEFT JOIN rooms r ON r.id = c.room_id
      WHERE c.is_active = true AND (c.first_name ILIKE $1 OR c.last_name ILIKE $1 OR r.name ILIKE $1)
      ORDER BY c.first_name, c.last_name LIMIT 30`, [like])).rows;
    const staff = (await db.query(`
      SELECT s.id, s.first_name || ' ' || COALESCE(s.last_name, '') AS name, s.role, r.name AS room
      FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.is_active = true AND (s.first_name ILIKE $1 OR s.last_name ILIKE $1 OR s.role ILIKE $1 OR r.name ILIKE $1)
      ORDER BY s.first_name, s.last_name LIMIT 30`, [like])).rows;
    res.json({
      q,
      children: children.map(c => ({ kind: 'child', id: c.id, name: (c.name || '').trim(),
        room: c.room || null, status: c.enrolment_status || 'attending', funded: !!c.funded,
        start_date: c.start_date, leave_date: c.leave_date })),
      staff: staff.map(s => ({ kind: 'staff', id: s.id, name: (s.name || '').trim(),
        role: s.role || null, room: s.room || null })),
    });
  } catch (e) { console.error('[occupancy-v2/search]', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /person/child/:id — the child card ───────────────────────────────────
router.get('/person/child/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.first_name || ' ' || COALESCE(left(c.last_name,1) || '.', '') AS name,
             c.date_of_birth::text AS dob, c.start_date::text AS start_date, c.leave_date::text AS leave_date,
             c.enrolment_status, c.room_id, r.name AS room
      FROM children c LEFT JOIN rooms r ON r.id = c.room_id WHERE c.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Child not found' });
    const c = rows[0];
    const [rates, bookings, funding, pat] = await Promise.all([
      loadFeeRates(db), loadBookings(db), loadFunding(db), derivePatterns(db)]);
    const bk = bookings.get(id);
    const days = (bk && bk.days.length) ? bk.days : (pat.byChild.get(id) || null);
    const daySource = (bk && bk.days.length) ? 'booking' : (pat.byChild.has(id) ? 'register' : 'default');
    const today = new Date().toISOString().slice(0, 10);
    const age = c.dob ? ageYearsAt(c.dob, today) : null;
    const band = age === null ? 'threePlus' : bandOfAge(age);
    const fnd = funding.get(id) || null;
    const fee = computeFee(band, days || [], fnd, rates, SESSION_HOURS_DEFAULT);
    const moves = (await db.query(`
      SELECT m.id, m.to_room_id, rt.name AS to_room, m.moved_on::text AS moved_on
      FROM child_room_moves m LEFT JOIN rooms rt ON rt.id = m.to_room_id
      WHERE m.child_id = $1 ORDER BY m.moved_on DESC, m.id DESC`, [id])).rows;
    const pendingMove = moves.find(m => m.moved_on > today) || null;
    res.json({
      kind: 'child', id, name: (c.name || '').trim(), dob: c.dob, age,
      room: c.room || null, room_id: c.room_id, status: c.enrolment_status || 'attending',
      start_date: c.start_date, leave_date: c.leave_date,
      booked_days: days || [], day_source: daySource, session_hours: SESSION_HOURS_DEFAULT,
      funding: fnd ? { type: fnd.funding_type, total_hours_week: fnd.total_hours_week,
        universal: fnd.universal, extended: fnd.extended, stretched: fnd.stretched } : null,
      fee, fee_rate_term: rates.term, pending_move: pendingMove, room_moves: moves,
    });
  } catch (e) { console.error('[occupancy-v2/person/child]', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /person/staff/:id — the staff card ───────────────────────────────────
router.get('/person/staff/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.first_name || ' ' || COALESCE(s.last_name, '') AS name, s.role, s.room_id,
             s.hourly_rate, s.qualification_level, s.contracted_hours, s.hours_per_week, s.employment_type,
             r.name AS room
      FROM staff s LEFT JOIN rooms r ON r.id = s.room_id WHERE s.id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    const s = rows[0];
    const today = new Date().toISOString().slice(0, 10);
    const patRows = (await db.query(`
      SELECT DISTINCT ON (day_of_week) day_of_week, shift_start::text AS shift_start,
             shift_end::text AS shift_end, is_off, room
      FROM staff_work_patterns
      WHERE staff_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY day_of_week, effective_from DESC`, [id, today])).rows;
    const amCut = STAFF_AM_CUTOFF_DEFAULT, pmCut = STAFF_PM_CUTOFF_DEFAULT; // b115
    const pattern = [1, 2, 3, 4, 5].map(d => {
      const row = patRows.find(p => p.day_of_week === d - 1);   // day_of_week 0=Mon
      if (row && !row.is_off && row.shift_start) {
        const start = row.shift_start.slice(0, 5), end = row.shift_end ? row.shift_end.slice(0, 5) : null;
        const ses = shiftSessions(start, end, amCut, pmCut); // b115: AM/PM units
        return { dow: d, off: false, start, end, room: normStaffRoom(row.room), room_raw: row.room || null,
          am: ses.am, pm: ses.pm, session: sessionLabel(ses.am, ses.pm) };
      }
      return { dow: d, off: true };
    });
    const contracted = Number(s.contracted_hours) || Number(s.hours_per_week) || null;
    res.json({
      kind: 'staff', id: s.id, name: (s.name || '').trim(), role: s.role || null,
      room: s.room || null, room_id: s.room_id,
      hourly_rate: s.hourly_rate != null ? Number(s.hourly_rate) : null,
      qualification_level: s.qualification_level != null ? Number(s.qualification_level) : null,
      contracted_hours: contracted, employment_type: s.employment_type || null,
      counts_to_ratio: !NON_RATIO_ROLES.has(String(s.role || '').toLowerCase()),
      pattern, work_days: pattern.filter(p => !p.off).map(p => p.dow),
    });
  } catch (e) { console.error('[occupancy-v2/person/staff]', e.message); res.status(500).json({ error: e.message }); }
});

// ── staff schedule for a week (latest effective pattern per staff/weekday) ────
async function loadStaffSchedule(db, weekStart) {
  const weekEnd = addDaysStr(weekStart, 4);
  const { rows } = await db.query(`
    SELECT DISTINCT ON (swp.staff_id, swp.day_of_week)
           swp.staff_id, swp.day_of_week, swp.shift_start::text AS shift_start,
           swp.shift_end::text AS shift_end, swp.ratio_start::text AS ratio_start, swp.is_off, swp.room,
           s.first_name || ' ' || COALESCE(s.last_name, '') AS name, s.role
    FROM staff_work_patterns swp
    JOIN staff s ON s.id = swp.staff_id AND s.is_active = true
    WHERE swp.effective_from <= $2::date AND (swp.effective_to IS NULL OR swp.effective_to >= $1::date)
    ORDER BY swp.staff_id, swp.day_of_week, swp.effective_from DESC`, [weekStart, weekEnd]);
  // group by staff → {name, role, days:{0..4:{room,start,end,off,ratio_start}}}
  const byStaff = new Map();
  for (const r of rows) {
    if (!byStaff.has(r.staff_id)) byStaff.set(r.staff_id, { id: r.staff_id, name: (r.name || '').trim(), role: r.role || null, days: {} });
    byStaff.get(r.staff_id).days[r.day_of_week] = {
      room: normStaffRoom(r.room), off: !!r.is_off || !r.shift_start,
      start: r.shift_start ? r.shift_start.slice(0, 5) : null, end: r.shift_end ? r.shift_end.slice(0, 5) : null,
      // b132: staff is on the premises from `start` but not counted toward
      // ratio until `ratio_start` if later (e.g. arrives 10:30, on-ratio from
      // noon while doing handover/admin) — see minConcurrent() below.
      ratio_start: r.ratio_start ? r.ratio_start.slice(0, 5) : null };
  }
  return byStaff;
}

// GET|POST /rota — one-week rota + register + results strip.
async function runRota(req, res) {
  const db = getPool();
  try {
    const q = req.method === 'POST' ? { ...req.query, ...(req.body || {}) } : req.query;
    let adjustments = Array.isArray(q.adjustments) ? q.adjustments : [];
    let settings = (q.settings && typeof q.settings === 'object') ? q.settings : {};
    let scenario = null;
    if (q.scenario_id) {
      await ensureTable(db);
      const { rows } = await db.query(`SELECT * FROM occupancy_scenarios WHERE id=$1`, [q.scenario_id]);
      if (!rows.length) return res.status(404).json({ error: 'Scenario not found' });
      scenario = { id: rows[0].id, name: rows[0].name }; adjustments = rows[0].adjustments || []; settings = rows[0].settings || {};
    }
    const sessionHours = Number(settings.session_hours) > 0 ? Number(settings.session_hours) : SESSION_HOURS_DEFAULT;
    // b115: staff AM/PM cutoffs + child-session mode (LADN = full_day only).
    const amCut = cutoff(settings.staff_am_cutoff, STAFF_AM_CUTOFF_DEFAULT);
    const pmCut = cutoff(settings.staff_pm_cutoff, STAFF_PM_CUTOFF_DEFAULT);
    // b132: nursery open/close bound the AM window [dayOpen,amCut) and PM
    // window [pmCut,dayClose) for the real-coverage sweep below.
    const dayOpen = cutoff(settings.day_opens, DAY_OPEN_DEFAULT);
    const dayClose = cutoff(settings.day_closes, DAY_CLOSE_DEFAULT);
    const amCutMin = toMin(amCut), pmCutMin = toMin(pmCut), dayOpenMin = toMin(dayOpen), dayCloseMin = toMin(dayClose);
    const childSessions = await loadChildSessionMode(db);
    const weekStart = isYmdStr(q.week) ? mondayOf(q.week) : mondayOf(new Date().toISOString().slice(0, 10));
    const weekDates = [0, 1, 2, 3, 4].map(i => addDaysStr(weekStart, i));

    const [baseCaps, fullRoster, pat, roomClassOf, movesByChild, rates, bookings, funding, staffSched] =
      await Promise.all([
        roomCaps(db), loadRoster(db), derivePatterns(db), roomClasses(db), loadRoomMoves(db),
        loadFeeRates(db), loadBookings(db), loadFunding(db), loadStaffSchedule(db, weekStart)]);
    const baseRoster = fullRoster.filter(c => !c.needs_start_date);
    const defaultDays = cleanDays(settings.default_pattern_days) || ALL_WEEKDAYS;

    // scenario roster (child adjustments applied) + baseline roster (none)
    const { roster: scRoster, caps: adjCaps } = applyAdjustments(baseRoster, adjustments);
    const caps = {
      baby: Number(settings.baby_capacity) || adjCaps.baby || baseCaps.baby,
      preschool: Number(settings.preschool_capacity) || adjCaps.preschool || baseCaps.preschool };
    assignChildPatterns(scRoster, pat, defaultDays);
    const blRoster = baseRoster.map(c => ({ ...c }));
    assignChildPatterns(blRoster, pat, defaultDays);

    // Build the REGISTER for the week (per day, per room) — adjustments applied,
    // NOT annotated (clean output). Returns present-children set + per-child fee.
    function buildRegister(roster) {
      const present = new Map();  // child id → {band, days:[]}
      const days = weekDates.map((date, i) => {
        const bandDate = monthEndOf(date);
        const rooms = { baby: [], preschool: [] };
        for (const c of roster) {
          if (!c.pattern.includes(i + 1)) continue;
          if (c.start_date && c.start_date > date) continue;
          if (c.leave_date && c.leave_date < date) continue;
          const { age, room, room_source, band } = resolveRoom(c, bandDate, roomClassOf, movesByChild, date);
          if (age >= SCHOOL_AGE_YEARS && !c.leave_date) continue;
          rooms[room].push({ id: c.id, name: c.name, age, band, room_source });
          if (!present.has(c.id)) present.set(c.id, { band, days: [] });
          present.get(c.id).days.push(i + 1);
        }
        const babyTally = bandTally(rooms.baby), preTally = bandTally(rooms.preschool);
        const staffReq = { baby: roomStaff(babyTally), preschool: roomStaff(preTally) };
        // b134: same 2yo/3yo/4yo+ split + RAW fractional need as /forecast and
        // /week-forecast, here against the REAL rostered week (b115/b122/b132
        // staff model below) — this is where "exact need vs statutory vs
        // rostered" is actually comparable to a real generated rota.
        const babyExact = roomStaffExact(babyTally), preExact = roomStaffExact(preTally);
        return { date, dow: i + 1, dow_name: DOW_NAMES[i + 1],
          baby: { count: rooms.baby.length, children: rooms.baby },
          preschool: { count: rooms.preschool.length, children: rooms.preschool },
          total: rooms.baby.length + rooms.preschool.length,
          staff_required: { baby: staffReq.baby, preschool: staffReq.preschool, total: staffReq.baby + staffReq.preschool },
          age_mix_baby: ageMixTally(rooms.baby), age_mix_preschool: ageMixTally(rooms.preschool),
          staff_exact_baby: babyExact.total,
          staff_exact_preschool: { two: preExact.two, three_plus: preExact.three_plus, total: preExact.total },
          staff_exact_total: round2(babyExact.total + preExact.total),
          baby_over: rooms.baby.length > caps.baby, preschool_over: rooms.preschool.length > caps.preschool };
      });
      return { days, present };
    }
    function bandTally(list) { const t = { u2: 0, two: 0, threePlus: 0 }; for (const c of list) t[c.band]++; return t; }
    // Fee total. Days used, in priority: a scenario set_pattern/add_child override
    // (the "what if they attend these days" case → revenue tracks the change),
    // else the child's real booked contract (child_bookings), else the register-
    // derived / default pattern the register showed them on.
    function feeTotal(roster, present) {
      let total = 0; const lines = [];
      for (const c of roster) {
        if (!present.has(c.id)) continue;
        const p = present.get(c.id);
        const bk = (typeof c.id === 'number') ? bookings.get(c.id) : null;
        const days = (c.pattern_source === 'override') ? c.pattern
          : (bk && bk.days.length) ? bk.days : p.days;
        const fnd = (typeof c.id === 'number') ? (funding.get(c.id) || null) : null;
        const fee = computeFee(p.band, days, fnd, rates, sessionHours);
        total += fee.weekly_fee;
        lines.push({ id: c.id, name: c.name, weekly_fee: fee.weekly_fee });
      }
      return { total: Math.round(total * 100) / 100, lines };
    }

    const scReg = buildRegister(scRoster);
    const blReg = buildRegister(blRoster);
    const scFee = feeTotal(scRoster, scReg.present);
    const blFee = feeTotal(blRoster, blReg.present);

    // ── ROTA: apply staff adjustments, then place staff per room per day ──
    // staff placement map: [day 0..4] → {baby:[], preschool:[], other:[]}
    const staffAdj = { add: [], remove: new Map(), setPattern: new Map() };
    for (const a of adjustments) {
      if (!a || typeof a !== 'object') continue;
      if (a.type === 'add_staff') {
        const days = cleanDays(a.days) || ALL_WEEKDAYS;
        const room = a.room === 'baby' ? 'baby' : 'preschool';
        const session = a.session === 'am' ? 'am' : a.session === 'pm' ? 'pm' : 'full'; // b115
        staffAdj.add.push({ id: 'vs' + staffAdj.add.length, name: a.label || 'New staff', role: a.role || 'practitioner', room, days, session, virtual: true });
      } else if (a.type === 'remove_staff') {
        staffAdj.remove.set(Number(a.staff_id), cleanDays(a.days)); // null days = whole week
      } else if (a.type === 'set_staff_pattern') {
        // b122: optional session override ('am'|'pm'|'full') — lets a scenario
        // change a staff member's AM/PM coverage without touching their real
        // shift times (consistent with the b115 AM/PM half-day model).
        const session = ['am', 'pm', 'full'].includes(a.session) ? a.session : null;
        staffAdj.setPattern.set(Number(a.staff_id), { days: cleanDays(a.days) || [], room: a.room ? (a.room === 'baby' ? 'baby' : 'preschool') : null, session });
      }
    }

    const rotaDays = weekDates.map((date, i) => {
      const dow = i;  // 0=Mon
      const placement = { baby: [], preschool: [], other: [] };
      for (const [sid, st] of staffSched) {
        // removal (absent) for this day?
        if (staffAdj.remove.has(sid)) { const rd = staffAdj.remove.get(sid); if (!rd || rd.includes(dow + 1)) continue; }
        let day = st.days[dow];
        let room = day && !day.off ? day.room : null;
        // set_staff_pattern override
        let sessionOverride = null; // b122: 'am'|'pm'|'full', overrides the AM/PM units below
        if (staffAdj.setPattern.has(sid)) {
          const ov = staffAdj.setPattern.get(sid);
          if (ov.days.length) { room = ov.days.includes(dow + 1) ? (ov.room || room || 'preschool') : null; }
          else if (ov.room && room) room = ov.room;
          if (room && ov.session && (!ov.days.length || ov.days.includes(dow + 1))) sessionOverride = ov.session;
        }
        if (!room) continue;  // off / not scheduled this day
        const ratio = !NON_RATIO_ROLES.has(String(st.role || '').toLowerCase());
        // b115: AM/PM units from the shift times. A forced/off day with no clock
        // times (set_staff_pattern) → treated as full-day cover. b122: an explicit
        // scenario session override wins over the real/derived shift times.
        const hasShift = day && !day.off && day.start;
        const ses = sessionOverride
          ? { am: sessionOverride !== 'pm', pm: sessionOverride !== 'am' }
          : shiftSessions(hasShift ? day.start : null, hasShift ? day.end : null, amCut, pmCut);
        // b132: the entry's REAL on-ratio interval — an explicit session
        // override still wins (it deliberately redefines coverage), otherwise
        // derived from the actual shift start/end + ratio_start delay.
        const ratioIv = sessionOverride
          ? sessionWindowInterval(sessionOverride, amCutMin, pmCutMin, dayOpenMin, dayCloseMin)
          : ratioInterval(hasShift ? day.start : null, hasShift ? day.end : null, hasShift ? day.ratio_start : null, dayOpenMin, dayCloseMin);
        const entry = { id: sid, name: st.name, role: st.role, ratio, start: day ? day.start : null, end: day ? day.end : null, am: ses.am, pm: ses.pm, session: sessionLabel(ses.am, ses.pm), ratio_interval: ratioIv };
        if (!ratio) placement.other.push(entry);
        else placement[room].push(entry);
      }
      // hypothetical added staff (b115: honour add_staff session; default full)
      for (const vs of staffAdj.add) {
        if (!vs.days.includes(dow + 1)) continue;
        const vses = vs.session === 'am' ? { am: true, pm: false } : vs.session === 'pm' ? { am: false, pm: true } : { am: true, pm: true };
        const vIv = sessionWindowInterval(vs.session, amCutMin, pmCutMin, dayOpenMin, dayCloseMin);
        placement[vs.room].push({ id: vs.id, name: vs.name, role: vs.role, ratio: true, virtual: true, am: vses.am, pm: vses.pm, session: vs.session, ratio_interval: vIv });
      }
      const reg = scReg.days[i];
      const scheduled = { baby: placement.baby.length, preschool: placement.preschool.length };
      const required = { baby: reg.staff_required.baby, preschool: reg.staff_required.preschool };
      // b132: per-room AM/PM coverage is the WORST concurrent on-ratio
      // headcount across each window (a sweep over real intervals) — not a
      // simple "did they touch this session" boolean tally. A room is short
      // for the day if EITHER window's worst moment is below required
      // (children are full-day → same required all day).
      const babyIvs = placement.baby.map(e => e.ratio_interval);
      const preIvs = placement.preschool.map(e => e.ratio_interval);
      const babyU = { am: minConcurrent(babyIvs, dayOpenMin, amCutMin), pm: minConcurrent(babyIvs, pmCutMin, dayCloseMin) };
      const preU = { am: minConcurrent(preIvs, dayOpenMin, amCutMin), pm: minConcurrent(preIvs, pmCutMin, dayCloseMin) };
      const roomOut = (list, u, req) => ({
        staff: list, scheduled: list.length,
        scheduled_am: u.am, scheduled_pm: u.pm, worst: Math.min(u.am, u.pm),
        required: req, breach_am: u.am < req, breach_pm: u.pm < req,
        breach: u.am < req || u.pm < req });
      return { date, dow: i + 1, dow_name: DOW_NAMES[i + 1],
        baby: roomOut(placement.baby, babyU, required.baby),
        preschool: roomOut(placement.preschool, preU, required.preschool),
        other: placement.other,
        scheduled_total: scheduled.baby + scheduled.preschool, required_total: required.baby + required.preschool };
    });

    // ── results strip (b115: breaches are per-session AM/PM) ──
    const breaches = [];
    for (const d of rotaDays) {
      for (const [key, label] of [['baby', 'Baby Room'], ['preschool', 'Pre-school']]) {
        const rm = d[key];
        if (rm.breach_am) breaches.push({ date: d.date, dow_name: d.dow_name, room: label, session: 'AM', required: rm.required, scheduled: rm.scheduled_am });
        if (rm.breach_pm) breaches.push({ date: d.date, dow_name: d.dow_name, room: label, session: 'PM', required: rm.required, scheduled: rm.scheduled_pm });
      }
    }
    const peakDay = scReg.days.reduce((mx, d) => d.total > mx.total ? d : mx, scReg.days[0]);
    const babyPeak = scReg.days.reduce((m, d) => Math.max(m, d.baby.count), 0);
    const prePeak = scReg.days.reduce((m, d) => Math.max(m, d.preschool.count), 0);
    const staffReqTotal = scReg.days.reduce((s, d) => s + d.staff_required.total, 0);
    const staffSchedTotal = rotaDays.reduce((s, d) => s + d.scheduled_total, 0);

    res.json({
      generated: new Date().toISOString().slice(0, 10),
      week_start: weekStart, week_dates: weekDates, session_hours: sessionHours,
      capacities: caps, scenario, staff_target: MAX_STAFF_TARGET,
      child_sessions: childSessions,                             // b115: 'full_day' at LADN
      staff_sessions: { am_cutoff: amCut, pm_cutoff: pmCut },    // b115: AM/PM cutoffs used
      register: { days: scReg.days },
      rota: { days: rotaDays },
      results: {
        peak_children: peakDay.total, peak_day: peakDay.dow_name,
        room_peak: { baby: babyPeak, preschool: prePeak },
        occupancy_pct: {
          baby: caps.baby ? Math.round(babyPeak / caps.baby * 100) : null,
          preschool: caps.preschool ? Math.round(prePeak / caps.preschool * 100) : null },
        staff_required_total: staffReqTotal, staff_scheduled_total: staffSchedTotal,
        ratio_breaches: breaches, ratio_breach_count: breaches.length,
        weekly_fee: { scenario: scFee.total, baseline: blFee.total, delta: Math.round((scFee.total - blFee.total) * 100) / 100 },
      },
      fee_lines: scFee.lines,
      notes: [
        `Children attend FULL DAYS ONLY (Mon–Fri) — no AM/PM child sessions at LADN.`,
        `Register applies ${adjustments.length} pending change${adjustments.length === 1 ? '' : 's'} — the output is shown clean (changes not highlighted), as if it were the real week.`,
        `Rota places each active staff member from their work pattern (latest effective per weekday) into their room; ratio need = ceil(under-2/3)+ceil(2yo/5)+ceil(3+/8) per room. Managers/cook/office roles are listed under "Other (off-ratio)".`,
        `Staff coverage is checked AM (${dayOpen}–${amCut}) and PM (${pmCut}–${dayClose}) separately, counting the WORST concurrent on-ratio headcount in each window (ratio_start-adjusted, so a late/off-ratio start or an early finish only credits the time actually covered — split/overlapping shifts at handover no longer inflate or hide coverage). A cell is red if either window's worst moment is below the required number.`,
        `Weekly fee is an ESTIMATE: paid_hours × the band's funding_terms invoice rate (session ${sessionHours}h/day), funded hours deducted. Meals/extras are not in the data model and are excluded.`,
      ],
    });
  } catch (e) { console.error('[occupancy-v2/rota]', e); res.status(500).json({ error: e.message }); }
}
router.get('/rota', runRota);
router.post('/rota', runRota);

// ============================================================================
// b115 (2026-07-21) — Children FULL-DAYS-ONLY + staff AM/PM half-day session
// model. APPEND-ONLY helpers below; the AM/PM staff maths is patched in place
// inside runRota (search "b115" markers there).
//
// CHILDREN: LADN children attend full days only (Mon–Fri booleans, never AM/PM).
//   Governed by the ladn.settings key `occupancy_child_sessions` (default
//   'full_day'). The child forecast/register are already whole-day; b115 makes
//   it explicit and surfaces it in the API + planner so no half-day child UI is
//   shown for the LADN edition. The API's day-granular capability is untouched.
//
// STAFF: a work pattern resolves to AM/PM units per day (Toby's exact spec):
//   • Full-day staff (e.g. 08:00–18:00)            = 1 AM unit + 1 PM unit
//   • Morning staff  (08:00 → end of lunch cover)  = 1 AM unit (covers lunch)
//   • Afternoon staff(lunch cover → 18:00)         = 1 PM unit (covers lunch)
//   A shift has an AM unit if it STARTS before the AM cutoff, and a PM unit if
//   it ENDS after the PM cutoff (both default 13:00 — the lunch handover;
//   overridable via settings.staff_am_cutoff / settings.staff_pm_cutoff). A
//   full-day or straddling shift counts in BOTH — overlap at lunch is expected.
//   Ratio checks evaluate AM and PM SEPARATELY per room (children are full-day,
//   so the required number is the same all day); a room is short for the day if
//   EITHER its AM or its PM unit count is below required. Lunch is treated as
//   covered if either unit is present. A placement with no clock times (a
//   forced set_staff_pattern day, or a virtual add_staff without a session) is
//   treated as full-day unless add_staff specifies session:'am'|'pm'.
// ============================================================================
const STAFF_AM_CUTOFF_DEFAULT = '13:00'; // shift is AM cover if it starts before this
const STAFF_PM_CUTOFF_DEFAULT = '13:00'; // shift is PM cover if it ends after this
function cutoff(v, def) {
  return (typeof v === 'string' && /^\d{2}:\d{2}/.test(v)) ? v.slice(0, 5) : def;
}
// AM/PM units for a shift. start/end are 'HH:MM' strings (lexical compare works
// on zero-padded 24h times). No times (null/null) → treated as full-day.
// Used for the per-person AM/PM/full display tag only (see b132 below for the
// room-level ratio-breach count, which no longer uses this).
function shiftSessions(start, end, amCut, pmCut) {
  if (!start && !end) return { am: true, pm: true };
  return { am: !!start && start < amCut, pm: !!end && end > pmCut };
}
// A short label for a session pair: full | am | pm | none.
function sessionLabel(am, pm) { return (am && pm) ? 'full' : am ? 'am' : pm ? 'pm' : 'none'; }
// ladn.settings → child-session mode. LADN is full-day only; anything else the
// UI would need to add half-day child controls, which it deliberately doesn't.
async function loadChildSessionMode(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'occupancy_child_sessions'`);
    const v = rows.length ? String(rows[0].value || '').trim().toLowerCase() : '';
    return (v === 'am_pm' || v === 'half_day') ? v : 'full_day';
  } catch (_) { return 'full_day'; }
}

// ============================================================================
// b132 (2026-07-22) — AM/PM OVERLAP FIX. APPEND-ONLY.
//
// Toby: staff on split/overlapping AM/PM sessions (e.g. a deputy who clocks
// in at 10:30 but isn't counted toward ratio until noon, overlapping with a
// colleague who leaves at 2pm) broke the rota ratio maths — b115's
// shiftSessions() gave a shift full credit for a session (AM or PM) merely
// for crossing the cutoff ONCE, regardless of how much of that session it
// actually covered, and never looked at ratio_start at all. Confirmed on
// real data: a deputy manager working 10:30-18:00 with ratio_start=12:00 got
// counted as "AM cover" despite being off-ratio until noon (start 10:30 is
// before the 13:00 cutoff), and a colleague working 08:00-14:00 got counted
// as "PM cover" for the WHOLE afternoon despite leaving at 2pm (end 14:00 is
// after the 13:00 cutoff) — with both present, a room could show 0 breaches
// all day while the real worst-case coverage (08:00-12:00 and 14:00-18:00)
// was short by one person the whole time.
//
// Fix: room-level AM/PM coverage is now the MINIMUM CONCURRENT on-ratio
// headcount across each window, computed by sweeping every staff member's
// REAL on-ratio interval (ratio_start-adjusted start → end; no clock times =
// always present). This is correct for staggered/relay shifts (two people
// covering a window back-to-back each count only for their real slice — no
// under-count) and for overlapping/handover shifts (nobody gets credited
// for time they weren't actually on-ratio — no double-count/inflation). The
// per-person am/pm/session display tag (shiftSessions/sessionLabel, above)
// is unchanged — it still shows which session(s) a shift TOUCHES at all,
// which is a different, purely informational question from "how many were
// genuinely on the floor at the worst moment".
// ============================================================================
const DAY_OPEN_DEFAULT = '08:00', DAY_CLOSE_DEFAULT = '18:00';

function toMin(t) { // 'HH:MM' -> minutes since midnight, or null
  if (typeof t !== 'string' || !/^\d{2}:\d{2}/.test(t)) return null;
  const [h, m] = t.slice(0, 5).split(':').map(Number);
  return h * 60 + m;
}

// A staff window's real on-ratio interval, in minutes-since-midnight, or
// null (no clock times -- forced/virtual full-day placement, always present).
function sessionWindowInterval(session, amCutMin, pmCutMin, dayOpenMin, dayCloseMin) {
  if (session === 'am') return { start: dayOpenMin, end: amCutMin };
  if (session === 'pm') return { start: pmCutMin, end: dayCloseMin };
  return { start: dayOpenMin, end: dayCloseMin };
}

// A real shift's on-ratio interval. ratio_start delays the effective start
// when later than the clock-in (present on the floor but not yet counted
// toward ratio, e.g. handover/admin before joining the room).
function ratioInterval(start, end, ratioStart, dayOpenMin, dayCloseMin) {
  if (!start && !end) return null;
  const s = toMin(start), rs = toMin(ratioStart);
  const effStart = (rs != null && (s == null || rs > s)) ? rs : s;
  return { start: effStart != null ? effStart : dayOpenMin, end: toMin(end) != null ? toMin(end) : dayCloseMin };
}

// Minimum concurrent on-ratio staff across [winStart,winEnd) (minutes since
// midnight). Sweeps every interval's boundary points that fall inside the
// window and samples the count just after each -- the true worst moment can
// only occur immediately after someone arrives or leaves.
function minConcurrent(intervals, winStart, winEnd) {
  if (winEnd == null || winStart == null || winEnd <= winStart) return intervals.length;
  const always = intervals.filter(iv => iv === null).length;
  const timed = intervals.filter(iv => iv !== null);
  const pts = new Set([winStart, winEnd]);
  for (const iv of timed) {
    if (iv.start > winStart && iv.start < winEnd) pts.add(iv.start);
    if (iv.end > winStart && iv.end < winEnd) pts.add(iv.end);
  }
  const sorted = [...pts].sort((a, b) => a - b);
  let worst = Infinity;
  for (let i = 0; i < sorted.length - 1; i++) {
    const t = sorted[i];
    const n = always + timed.filter(iv => iv.start <= t && iv.end > t).length;
    worst = Math.min(worst, n);
  }
  return worst === Infinity ? always : worst;
}

// ============================================================================
// b122 (2026-07-21) — STAFF LAYER PER ROOM. APPEND-ONLY.
//
// Toby: "get rid of Employee A and move someone from the other room to
// replace them" — a browsable per-room staff roster (real data, read-only)
// so the planner can be edited without searching each person by name first.
// Editing itself reuses the existing b105 scenario adjustments (add_staff /
// remove_staff / set_staff_pattern, now session-aware — see the b122 patch
// inside runRota above) — this endpoint only SEEDS the room-staff panel.
// Real ladn.staff rows are never written by any scenario adjustment.
// ============================================================================

// GET /staff-roster — real (non-scenario) active staff, grouped by room on
// the client. work_days = this week's latest-effective pattern (b105's
// loadStaffSchedule), independent of any scenario adjustments.
router.get('/staff-roster', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT s.id, s.first_name || ' ' || COALESCE(s.last_name, '') AS name, s.role, s.room_id,
             r.name AS room, CASE WHEN r.min_age_months < 24 THEN 'baby' WHEN r.id IS NOT NULL THEN 'preschool' ELSE NULL END AS klass,
             s.contracted_hours, s.hours_per_week, s.contract_type, s.employment_type, s.qualification_level
      FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.is_active = true AND COALESCE(s.role, '') <> 'parent'
      ORDER BY r.min_age_months NULLS LAST, s.first_name`);
    const weekStart = mondayOf(new Date().toISOString().slice(0, 10));
    const sched = await loadStaffSchedule(db, weekStart);
    res.json(rows.map(r => {
      const sc = sched.get(r.id);
      const work_days = sc ? [0, 1, 2, 3, 4].filter(d => sc.days[d] && !sc.days[d].off).map(d => d + 1) : [];
      return {
        id: r.id, name: (r.name || '').trim(), role: r.role || null, room_id: r.room_id, room: r.room || null,
        klass: r.klass, counts_to_ratio: !NON_RATIO_ROLES.has(String(r.role || '').toLowerCase()),
        contracted_hours: r.contracted_hours != null ? Number(r.contracted_hours) : null,
        hours_per_week: r.hours_per_week != null ? Number(r.hours_per_week) : null,
        contract_type: r.contract_type || null, employment_type: r.employment_type || null,
        qualification_level: r.qualification_level != null ? Number(r.qualification_level) : null,
        work_days,
      };
    }));
  } catch (e) { console.error('[occupancy-v2/staff-roster]', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
