'use strict';
// Occupancy & ratio forecast (2026-06-16). Month-by-month room occupancy from
// children.start_date (in) / leave_date (out). Uses the child's CURRENT room
// (room_id) for placement and models baby→pre-school transfer at the transfer
// floor (setting transfer_age_min_months, default 22 months — was hard-coded 24)
// (holdback/bring-forward flex is a planning lever, not auto-applied). Read-only.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
router.use(authenticate);
const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'admin', 'room_leader'])) return res.status(403).json({ error: 'Manager access required' });
  next();
};
// Baby→pre-school transfer FLOOR. Spec (2026-06-30): 22 months, not 24 — younger
// won't settle. Setting `transfer_age_min_months` (default 22) overrides per request.
// NB: the 24-month value at the ratio band below (am < 24) is the STATUTORY under-2
// ratio band (1:3) and is intentionally left at 24 — do not confuse with this floor.
const DEFAULT_TRANSFER_AGE = 22, SCHOOL_AGE = 60;
const ymd = d => new Date(d).toISOString().slice(0, 10);
const ageMonths = (dob, at) => (new Date(at) - new Date(ymd(dob) + 'T00:00:00Z')) / (1000 * 60 * 60 * 24 * 30.4375);
function plusMonths(dateStr, n) { const t = new Date(dateStr + 'T00:00:00Z'); t.setUTCMonth(t.getUTCMonth() + n); return ymd(t); }

router.get('/forecast', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const now = new Date();
    const fp = (req.query.from || '').match(/^(\d{4})-(\d{2})$/);
    const fromY = fp ? +fp[1] : now.getUTCFullYear();
    const fromM = fp ? +fp[2] - 1 : now.getUTCMonth();
    const months = Math.min(Math.max(parseInt(req.query.months) || 18, 1), 36);

    // Transfer floor from settings (default 22). Read-only.
    let TRANSFER_AGE = DEFAULT_TRANSFER_AGE;
    try {
      const { rows: sr } = await db.query(`SELECT value FROM settings WHERE key='transfer_age_min_months'`);
      const v = sr.length ? Number(sr[0].value) : NaN;
      if (Number.isFinite(v) && v > 0) TRANSFER_AGE = v;
    } catch (_) { /* settings table absent → keep default */ }

    const { rows: rooms } = await db.query(`
      SELECT id, name, capacity, min_age_months,
             COALESCE(target_capacity, capacity) AS target_capacity,
             COALESCE(legal_capacity,  capacity) AS legal_capacity
      FROM rooms ORDER BY min_age_months`);
    const babyRoom = rooms.find(r => r.min_age_months < TRANSFER_AGE) || { id: 1, capacity: 10, target_capacity: 10, legal_capacity: 10 };
    const preRoom  = rooms.find(r => r.min_age_months >= TRANSFER_AGE) || { id: 2, capacity: 26, target_capacity: 22, legal_capacity: 28 };
    const BABY_CAP = babyRoom.capacity, PRE_CAP = preRoom.capacity;
    // green ≤target · orange target..cap · red cap..legal · over >legal
    const bandOf = (n, room) => n > room.legal_capacity ? 'over' : n > room.capacity ? 'red' : n > room.target_capacity ? 'orange' : 'green';

    const { rows: kids } = await db.query(`
      SELECT id, first_name, left(coalesce(last_name,''),1) AS li, room_id,
             date_of_birth AS dob, start_date, leave_date
      FROM children WHERE is_active=true AND date_of_birth IS NOT NULL AND COALESCE(is_demo, false) = false`);

    const series = [];
    for (let k = 0; k < months; k++) {
      const d    = new Date(Date.UTC(fromY, fromM + k, 1));
      const mid  = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15));
      const mEnd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
      const label = d.toISOString().slice(0, 7), first = ymd(d), last = ymd(mEnd), midS = ymd(mid);
      let babyN = 0, preN = 0, bUnder2 = 0, bAge2 = 0, bAge3 = 0; const leavers = [], starters = [], transfers = [];
      for (const c of kids) {
        const nm = c.first_name + ' ' + c.li + '.';
        const sd = c.start_date ? ymd(c.start_date) : null;
        const ld = c.leave_date ? ymd(c.leave_date) : null;
        if (ld && ld >= first && ld <= last) leavers.push({ id: c.id, name: nm, room: c.room_id === babyRoom.id ? 'baby' : 'pre' });
        if (sd && sd >= first && sd <= last) starters.push({ id: c.id, name: nm });
        const present = (!sd || sd <= last) && (!ld || ld >= first);
        if (!present) continue;
        if (ageMonths(c.dob, mid) >= SCHOOL_AGE && !ld) continue; // aged out, no leave recorded
        const roomNow = c.room_id === babyRoom.id ? 'baby'
                      : c.room_id === preRoom.id ? 'pre'
                      : (ageMonths(c.dob, mid) < TRANSFER_AGE ? 'baby' : 'pre');
        const tdate = plusMonths(ymd(c.dob), TRANSFER_AGE); // 2nd birthday
        let room = roomNow;
        if (roomNow === 'baby' && tdate <= midS) room = 'pre';                 // already transferred up
        if (roomNow === 'baby' && tdate >= first && tdate <= last) transfers.push({ id: c.id, name: nm });
        if (room === 'baby') babyN++; else preN++;
        // Statutory age band at mid-month (drives staff:child ratio).
        const am = ageMonths(c.dob, mid);
        if (am < 24) bUnder2++; else if (am < 36) bAge2++; else bAge3++;
      }
      // EYFS England statutory ratios: under-2 1:3, age-2 1:5, age 3-4 1:8.
      const RATIO = { under2: 3, age2: 5, age3plus: 8 };
      const requiredStaff = Math.ceil(bUnder2 / RATIO.under2) + Math.ceil(bAge2 / RATIO.age2) + Math.ceil(bAge3 / RATIO.age3plus);
      series.push({
        month: label,
        baby:      { count: babyN, capacity: BABY_CAP, target: babyRoom.target_capacity, legal: babyRoom.legal_capacity, band: bandOf(babyN, babyRoom), headroom: Math.max(0, BABY_CAP - babyN), over: Math.max(0, babyN - BABY_CAP) },
        preschool: { count: preN, capacity: PRE_CAP, target: preRoom.target_capacity, legal: preRoom.legal_capacity, band: bandOf(preN, preRoom), headroom: Math.max(0, PRE_CAP - preN), over: Math.max(0, preN - PRE_CAP) },
        ratios: { under2: bUnder2, age2: bAge2, age3plus: bAge3, required_staff: requiredStaff, rule: RATIO },
        leavers, starters, transfers
      });
    }
    const trough = series.reduce((m, s) => s.preschool.count < m.count ? { month: s.month, count: s.preschool.count, headroom: s.preschool.headroom } : m,
      { month: series[0].month, count: series[0].preschool.count, headroom: series[0].preschool.headroom });
    const august = series.filter(s => s.month.endsWith('-08')).map(s => ({ month: s.month, leavers: s.leavers.length }));
    res.json({ generated: ymd(now), from: series[0].month, months,
      transfer_age_months: TRANSFER_AGE,
      baby_capacity: BABY_CAP, preschool_capacity: PRE_CAP,
      preschool_target: preRoom.target_capacity, preschool_legal: preRoom.legal_capacity,
      bands: { green: '≤target', orange: 'target..cap', red: 'cap..legal', over: '>legal (blocked)' },
      series,
      summary: { preschool_trough: trough, august_leavers: august } });
  } catch (e) { console.error('[occupancy]', e.message); res.status(500).json({ error: e.message }); }
});

// ===========================================================================
// RETROSPECTIVE OCCUPANCY & RATIO HISTORY (Prompt 20, 2026-06-29) — additive.
// Mirror image of /forecast: looks BACK. For any past day / week / month, how
// many CHILDREN were in (attendance, absent=false), how many ratio-counting
// STAFF were in, and whether we met statutory ratio (and by how much).
//
//  • Children present = a attendance row with absent=false on that date.
//  • Required staff   = reuses the shared ratio-engine (requiredStaff + ageBandOn:
//                       under-2 1:3, two 1:5, three+ 1:8) over the present children's
//                       DOB age bands. We do NOT reinvent the ratio maths.
//  • Staff present    = prefers ACTUAL clock data (staff_shifts); falls back to
//                       scheduled-present inferred from the per-weekday rota
//                       (staff_work_patterns) and, for staff with no rota rows,
//                       their contract + a Mon–Fri default — MINUS approved absence.
//                       staff_shifts / staff_clock_events are currently EMPTY,
//                       so every figure here is 'inferred' until clock data lands.
// Read-only.
// ===========================================================================
const ratioEngine = require('../services/ratio-engine');

// Earliest attendance row in attendance (EyLog import begins 2026-03-16).
const ATT_FROM = '2026-03-16';

// NURSERY-CONTEXT Q5: NOT counted in ratio = manager (Toby), cook (the chef/Henrietta),
// the office manager. The shared engine's name regex misses "Henrietta"/role "cook" (she has no
// rota row so it never returns her) — we make the exclusion explicit here so the
// contract-fallback path below can't accidentally count her in the ratio.
// b271 (2026-09-04): 'manager' out, 'admin' in — the ex-deputies (now
// 'manager') are on the floor and DO count; the owners (now 'admin') do not.
const RATIO_EXCLUDED_ROLES = new Set(['admin', 'chef', 'cook', 'owner', 'director']);
const RATIO_EXCLUDED_NAME_RE = /\b(hetty|henrietta|clare)\b/i;
function isRatioCountable(s) {
  const role = (s.role || '').toLowerCase();
  const name = `${s.first_name || ''} ${s.last_name || ''}`;
  return !RATIO_EXCLUDED_ROLES.has(role) && !RATIO_EXCLUDED_NAME_RE.test(name);
}

// staff_work_patterns.day_of_week in THIS dataset is 0=Mon … 4=Fri (no 5/6 rows;
// nursery is Mon–Fri and children attend every Friday). JS getUTCDay() is 0=Sun, so
// map: Mon→0 … Sun→6. (The shared engine queries day_of_week=getDay() directly, which
// is off-by-one for this rota table — we map correctly here for the history view.)
function isoDow0Mon(dateStr) { return (new Date(dateStr + 'T00:00:00Z').getUTCDay() + 6) % 7; }

function daysBetween(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
function eachDate(from, to) {
  const out = []; let d = new Date(from + 'T00:00:00Z'); const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out.push(ymd(d)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
function weekStart(dateStr) { // Monday of that ISO week
  const d = new Date(dateStr + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow); return ymd(d);
}

async function loadHistoryInputs(db, from, to) {
  const { rows: att } = await db.query(`
    SELECT a.date::text AS d, c.id AS child_id, c.first_name, c.last_name,
           c.date_of_birth::text AS dob, c.room_id, r.name AS room_name,
           a.sign_in_time, a.sign_out_time
    FROM attendance a
    JOIN children c ON c.id = a.child_id
    LEFT JOIN rooms r ON r.id = c.room_id
    WHERE a.date BETWEEN $1::date AND $2::date AND COALESCE(a.absent,false) = false
      AND COALESCE(c.is_demo, false) = false
    ORDER BY a.date`, [from, to]);
  const { rows: staff } = await db.query(`
    SELECT id, first_name, last_name, role, room_id, contracted_hours, hours_per_week
    FROM staff
    WHERE COALESCE(is_active,true)=true AND COALESCE(terminated,false)=false
      AND COALESCE(is_demo, false) = false`);  // b485 port: demo staff never count on ratio
  const { rows: wp } = await db.query(`
    SELECT staff_id, day_of_week, COALESCE(is_off,false) AS is_off,
           shift_start::text AS shift_start, shift_end::text AS shift_end,
           ratio_start::text AS ratio_start, room,
           effective_from::text AS ef, effective_to::text AS et
    FROM staff_work_patterns`);
  const { rows: abs } = await db.query(`
    SELECT staff_id, start_date::text AS sd, end_date::text AS ed, absence_type
    FROM absence_requests WHERE status='approved'`);
  const { rows: shifts } = await db.query(`
    SELECT staff_id, shift_date::text AS d, clock_in_time, clock_out_time, total_minutes, status
    FROM staff_shifts
    WHERE shift_date BETWEEN $1::date AND $2::date AND clock_in_time IS NOT NULL
      AND COALESCE(status,'') <> 'cancelled'`, [from, to]);
  // Scheduled sessions (Prompt 62, 2026-07-02): the child's booked weekday pattern.
  // Used as the FUTURE / no-actuals source in computeDay so forecasts reflect real
  // bookings (child_bookings), not just enrolment. Past days still prefer the
  // actual attendance register below.
  const { rows: bookings } = await db.query(`
    SELECT b.child_id, c.first_name, c.last_name, c.date_of_birth::text AS dob,
           c.room_id, r.name AS room_name,
           b.mon, b.tue, b.wed, b.thu, b.fri,
           b.start_date::text AS start_date, b.end_date::text AS end_date
    FROM child_bookings b
    JOIN children c ON c.id = b.child_id
    LEFT JOIN rooms r ON r.id = c.room_id
    WHERE b.is_active = true AND COALESCE(c.is_active,true) = true
      AND COALESCE(c.is_demo, false) = false`);
  return { att, staff, wp, abs, shifts, bookings };
}

// Children EXPECTED on a date from their booked weekday pattern (child_bookings).
// Mirrors scripts/seed-daily-register.js + /api/bookings/expected: weekday bit set and
// the date within the booking's [start_date, end_date] range. Shapes each child like an
// attendance row (dob/room_name/sign_in_time=null) so computeDay/history/day can reuse it.
function bookedChildrenOnDate(inp, date) {
  const dow = isoDow0Mon(date);            // 0=Mon … 6=Sun
  if (dow > 4) return [];                   // Mon–Fri only
  const bit = ['mon', 'tue', 'wed', 'thu', 'fri'][dow];
  const out = [];
  for (const b of inp.bookings || []) {
    if (!b[bit]) continue;
    if (b.start_date && date < b.start_date) continue;
    if (b.end_date && date > b.end_date) continue;
    out.push({
      child_id: b.child_id, first_name: b.first_name, last_name: b.last_name,
      dob: b.dob, room_id: b.room_id, room_name: b.room_name,
      sign_in_time: null, sign_out_time: null,
    });
  }
  return out;
}

function buildIndexes(inp) {
  inp.attByDate = new Map();
  for (const a of inp.att) { if (!inp.attByDate.has(a.d)) inp.attByDate.set(a.d, []); inp.attByDate.get(a.d).push(a); }
  inp._maxData = inp.att.length ? inp.att[inp.att.length - 1].d : null;
  inp.wpByStaff = new Map();
  for (const p of inp.wp) { if (!inp.wpByStaff.has(p.staff_id)) inp.wpByStaff.set(p.staff_id, []); inp.wpByStaff.get(p.staff_id).push(p); }
  // Determinism: when a staff member has overlapping effective ranges for the same
  // weekday, prefer the LATEST effective_from so we pick exactly ONE pattern per day
  // (guards distinct-person-per-day counting).
  for (const arr of inp.wpByStaff.values()) arr.sort((a, b) => String(b.ef || '').localeCompare(String(a.ef || '')));
  inp.absByStaff = new Map();
  for (const a of inp.abs) { if (!inp.absByStaff.has(a.staff_id)) inp.absByStaff.set(a.staff_id, []); inp.absByStaff.get(a.staff_id).push(a); }
  inp.shiftsByDate = new Map();
  for (const s of inp.shifts) { if (!inp.shiftsByDate.has(s.d)) inp.shiftsByDate.set(s.d, new Map()); inp.shiftsByDate.get(s.d).set(s.staff_id, s); }
}

// Staff present on a date: actual clock first, else rota-inferred, else (no rota
// rows at all) contract + Mon–Fri default. Approved absence removes inferred presence
// (but a real clock-in overrides leave). Returns full list with in_ratio / source flags.
function staffPresentOnDate(inp, date) {
  const dow = isoDow0Mon(date);
  const isWeekday = dow <= 4;
  const out = [];
  for (const s of inp.staff) {
    const onLeave = (inp.absByStaff.get(s.id) || []).find(a => a.sd <= date && a.ed >= date) || null;
    const shift = (inp.shiftsByDate.get(date) || new Map()).get(s.id);
    let source = null, scheduled = null, offRatioUntil = null;
    if (shift) {
      source = 'actual';
      scheduled = { clock_in: shift.clock_in_time, clock_out: shift.clock_out_time, total_minutes: shift.total_minutes };
    } else {
      const pats = inp.wpByStaff.get(s.id) || [];
      const p = pats.find(x => x.day_of_week === dow && (!x.ef || x.ef <= date) && (!x.et || x.et >= date));
      if (p) {
        // Rota covers this date/weekday — trust it (is_off ⇒ genuinely not working).
        if (!p.is_off) {
          source = 'inferred';
          scheduled = { shift_start: p.shift_start, shift_end: p.shift_end, ratio_start: p.ratio_start || null, room: p.room || null };
          // ratio_start: staff is present (payroll) but OFF-ratio until this time on
          // the day (e.g. a practitioner arrives 10:30, on-ratio from 12:30). Surfaced so
          // time-aware consumers / the schedule UI can flag the morning gap; the
          // whole-day bucket still counts a full-day-present person (documented).
          offRatioUntil = p.ratio_start || null;
        }
      } else if (isWeekday && (Number(s.contracted_hours) > 0 || Number(s.hours_per_week) > 0)) {
        // No rota in effect for this date (no pattern rows at all, OR the date predates
        // the rota — staff_work_patterns only begin 2026-05-20) → contract + Mon–Fri
        // default. Coarser: may over-count a part-timer's working days. (Prompt 20 fallback.)
        source = 'inferred'; scheduled = { contract: true, hours_per_week: Number(s.hours_per_week || s.contracted_hours) || null };
      }
    }
    if (!source) continue;                                   // not scheduled / not clocked → absent
    if (onLeave && source === 'inferred') continue;          // approved leave overrides an inferred presence
    out.push({
      id: s.id,
      name: `${s.first_name || ''} ${(s.last_name || '').slice(0, 1)}.`.trim(),
      full_name: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
      role: s.role || '', room_id: s.room_id,
      source, scheduled,
      in_ratio: isRatioCountable(s),
      off_ratio_until: offRatioUntil,   // on-floor but not counting toward ratio until this time
      on_leave: !!onLeave,
      absence: onLeave ? (onLeave.absence_type || 'leave') : null,
    });
  }
  return out;
}

function statusFromDelta(delta) { return delta > 0 ? 'good' : delta === 0 ? 'tight' : 'under'; }

// One day bucket. Weekends and zero-child days are 'closed' (nursery shut / no data).
// Child source (Prompt 62): prefer ACTUAL sign-ins from the attendance register; for
// future dates (or a day whose register has no sign-ins yet) fall back to SCHEDULED
// children from child_bookings so forecasts are booking-accurate, not empty.
function computeDay(inp, date) {
  const dow = isoDow0Mon(date);
  const weekend = dow > 4;
  const att = inp.attByDate.get(date) || [];         // non-absent attendance rows (actuals + seeded shells)
  const signedIn = att.filter(a => a.sign_in_time);  // real sign-ins on the register

  let children, child_source;
  if (signedIn.length > 0) {
    children = att; child_source = 'actual';                 // the day happened — trust the register
  } else {
    const booked = bookedChildrenOnDate(inp, date);          // scheduled from child_bookings
    if (booked.length > 0) { children = booked; child_source = 'booked'; }
    else if (att.length > 0) { children = att; child_source = 'actual'; } // seeded shells, no booking rows
    else { children = []; child_source = null; }
  }
  const children_in = children.length;
  // no_data only when we have neither actuals nor bookings AND we're outside the register window.
  const no_data = children_in === 0 && (date < ATT_FROM || (inp._maxData && date > inp._maxData));
  if (weekend || children_in === 0) {
    return {
      period: date, weekday: dow, children_in,
      children_by_room: {}, children_bands: { under2: 0, two: 0, threePlus: 0 },
      staff_in: 0, staff_required: 0, delta: 0,
      status: 'closed', staff_source: '—', child_source: child_source || '—',
      weekend, no_data: no_data || undefined,
    };
  }
  const bands = { under2: 0, two: 0, threePlus: 0 };
  const byRoom = {};
  for (const c of children) {
    const band = c.dob ? ratioEngine.ageBandOn(c.dob, date) : 'threePlus';
    bands[band] = (bands[band] || 0) + 1;
    const rn = c.room_name || '(unassigned)';
    byRoom[rn] = (byRoom[rn] || 0) + 1;
  }
  const staff_required = ratioEngine.requiredStaff(bands);
  const ratioPresent = staffPresentOnDate(inp, date).filter(p => p.in_ratio);
  const staff_in = ratioPresent.length;
  const srcs = new Set(ratioPresent.map(p => p.source));
  const staff_source = srcs.size === 0 ? 'inferred' : srcs.size === 1 ? [...srcs][0] : 'mixed';
  const delta = staff_in - staff_required;
  return {
    period: date, weekday: dow, children_in,
    children_by_room: byRoom, children_bands: bands,
    staff_in, staff_required, delta,
    status: statusFromDelta(delta), staff_source, child_source, weekend,
  };
}

// Roll day buckets up to week/month. Only operating days (children present) count;
// figures are the average operating-day, plus children_peak for the period.
function aggregate(dayBuckets, granularity) {
  const groups = new Map();
  for (const b of dayBuckets) {
    if (b.status === 'closed') continue;
    const key = granularity === 'week' ? weekStart(b.period) : b.period.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(b);
  }
  const out = [];
  for (const key of [...groups.keys()].sort()) {
    const days = groups.get(key);
    const n = days.length;
    const avg = arr => Math.round(arr.reduce((s, x) => s + x, 0) / n);
    const children_in = avg(days.map(d => d.children_in));
    const staff_in = avg(days.map(d => d.staff_in));
    const staff_required = avg(days.map(d => d.staff_required));
    const delta = staff_in - staff_required;
    const roomKeys = new Set(); days.forEach(d => Object.keys(d.children_by_room).forEach(k => roomKeys.add(k)));
    const children_by_room = {};
    roomKeys.forEach(k => { children_by_room[k] = Math.round(days.reduce((s, d) => s + (d.children_by_room[k] || 0), 0) / n); });
    const srcs = new Set(days.map(d => d.staff_source));
    const staff_source = srcs.size === 1 ? [...srcs][0] : 'mixed';
    const csrcs = new Set(days.map(d => d.child_source).filter(x => x && x !== '—'));
    const child_source = csrcs.size === 0 ? '—' : csrcs.size === 1 ? [...csrcs][0] : 'mixed';
    out.push({
      period: key, operating_days: n,
      children_in, children_peak: Math.max(...days.map(d => d.children_in)),
      children_by_room, staff_in, staff_required, delta,
      status: statusFromDelta(delta), staff_source, child_source,
    });
  }
  return out;
}

// GET /api/occupancy/history?from=YYYY-MM-DD&to=YYYY-MM-DD&granularity=day|week|month
router.get('/history', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const today = ymd(new Date());
    let to = req.query.to || today;
    let from = req.query.from;
    if (!from) { const d = new Date(to + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 29); from = ymd(d); }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      return res.status(400).json({ error: 'from/to must be YYYY-MM-DD' });
    if (from > to) { const t = from; from = to; to = t; }
    if (daysBetween(from, to) > 400) return res.status(400).json({ error: 'range too large (max 400 days)' });
    const granularity = ['day', 'week', 'month'].includes(req.query.granularity) ? req.query.granularity : 'day';

    const inp = await loadHistoryInputs(db, from, to);
    buildIndexes(inp);
    const dayBuckets = eachDate(from, to).map(d => computeDay(inp, d));
    const buckets = granularity === 'day' ? dayBuckets : aggregate(dayBuckets, granularity);

    res.json({
      generated: today, from, to, granularity,
      data_range: { earliest: ATT_FROM, latest: inp._maxData },
      ratios: ratioEngine.RATIOS,
      staffing_note: 'Staff presence prefers actual clock data (staff_shifts — currently EMPTY) and otherwise infers from the rota (staff_work_patterns, effective 2026-05-20) or, where no rota applies, contract + a Mon–Fri default, minus approved absence. So every figure here is inferred; figures before 2026-05-20 are contract-only and may over-count a part-timer\'s working days.',
      buckets,
    });
  } catch (e) { console.error('[occupancy/history]', e); res.status(500).json({ error: e.message }); }
});

// GET /api/occupancy/history/day?date=YYYY-MM-DD — drill-down: who was actually in.
router.get('/history/day', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const date = req.query.date;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const inp = await loadHistoryInputs(db, date, date);
    buildIndexes(inp);
    // Same actual-first / booked-fallback selection as computeDay (Prompt 62).
    const attRows = inp.attByDate.get(date) || [];
    const signedIn = attRows.filter(a => a.sign_in_time);
    let src, child_source;
    if (signedIn.length > 0) { src = attRows; child_source = 'actual'; }
    else { const bk = bookedChildrenOnDate(inp, date); if (bk.length) { src = bk; child_source = 'booked'; } else { src = attRows; child_source = attRows.length ? 'actual' : '—'; } }
    const children = src.map(c => ({
      id: c.child_id,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      room: c.room_name || '(unassigned)',
      age_band: c.dob ? ratioEngine.ageBandOn(c.dob, date) : 'unknown',
      sign_in: c.sign_in_time, sign_out: c.sign_out_time,
    })).sort((a, b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
    const bands = { under2: 0, two: 0, threePlus: 0 };
    for (const c of src) { const b = c.dob ? ratioEngine.ageBandOn(c.dob, date) : 'threePlus'; bands[b]++; }
    const staff_required = ratioEngine.requiredStaff(bands);
    const staff = staffPresentOnDate(inp, date)
      .map(p => ({ id: p.id, name: p.full_name, role: p.role, source: p.source, in_ratio: p.in_ratio, off_ratio_until: p.off_ratio_until, on_leave: p.on_leave, absence: p.absence, scheduled: p.scheduled }))
      .sort((a, b) => (b.in_ratio - a.in_ratio) || a.name.localeCompare(b.name));
    const ratioStaff = staff.filter(p => p.in_ratio);
    const staff_in = ratioStaff.length;
    const srcs = new Set(ratioStaff.map(p => p.source));
    const staff_source = srcs.size === 0 ? 'inferred' : srcs.size === 1 ? [...srcs][0] : 'mixed';
    const delta = staff_in - staff_required;
    const dow = isoDow0Mon(date);
    res.json({
      date, weekday: dow, weekend: dow > 4,
      children_in: children.length, children_by_band: bands, children,
      staff_in, staff_required, delta,
      status: dow > 4 || children.length === 0 ? 'closed' : statusFromDelta(delta),
      staff_source, child_source, staff,
      staffing_note: 'Staff inferred from rota/contract where clock-in data is absent (staff_shifts empty).',
      children_note: child_source === 'booked'
        ? 'Children SCHEDULED from child_bookings (no sign-ins on the register for this date yet).'
        : 'Children ACTUAL from the attendance register (real sign-ins).',
    });
  } catch (e) { console.error('[occupancy/history/day]', e); res.status(500).json({ error: e.message }); }
});

// GET /api/occupancy/forecast/daily?days=10 — day-by-day FORWARD occupancy & ratio for
// the next N weekdays, driven by child_bookings (Prompt 62, 2026-07-02, additive).
// Past/today rows still prefer the actual register; future rows use scheduled bookings.
// Distinct from the monthly /forecast (enrolment-based) — this answers "who is booked in
// next week and do we have ratio for them?".
router.get('/forecast/daily', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const today = ymd(new Date());
    const days = Math.min(Math.max(parseInt(req.query.days) || 10, 1), 60);
    const to = (() => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return ymd(d); })();
    const inp = await loadHistoryInputs(db, today, to);
    buildIndexes(inp);
    const buckets = eachDate(today, to)
      .map(d => computeDay(inp, d))
      .filter(b => !b.weekend && b.status !== 'closed');   // operating weekdays with booked/actual children
    res.json({
      generated: today, from: today, to, days,
      ratios: ratioEngine.RATIOS,
      source_note: 'children_in is ACTUAL where the register has sign-ins, otherwise SCHEDULED from child_bookings (see each bucket child_source). Staff figures are rota/contract-inferred (staff_shifts empty).',
      buckets,
    });
  } catch (e) { console.error('[occupancy/forecast/daily]', e); res.status(500).json({ error: e.message }); }
});

// ===========================================================================
// FORWARD OCCUPANCY PROJECTION (2026-07-16, additive) — the accurate source for
// the Admissions → Forecast tab (replaces /api/enquiries/forecast-extended).
//
// WHY the old forecast was WRONG (diagnosed 2026-07-16):
//   /api/enquiries/forecast-extended used TODAY's enrolled headcount as a FLAT
//   `base` for ALL 12 months — it never rolled forward. It only subtracted a
//   leaver in the single month a child turned 5 (ignoring real children.leave_date
//   notice), added enquiry-pipeline starters to that ONE month (starters never
//   persisted into later months), IGNORED the waiting_list entirely, and GROUP BY
//   room_id silently dropped every child with a NULL room_id. Net effect: an
//   almost-flat line ≈ current occupancy ± single-month noise — not a projection.
//
// This projection is booking-accurate and WEEKLY, per room:
//   • confirmed occupancy = ladn.child_bookings (the real §55 register). Naturally
//     includes confirmed FUTURE starts and drops ended bookings. We take the PEAK
//     weekday that week (the fullest day) vs the whole-day capacity.
//   • incoming demand     = ladn.waiting_list expected-starts (status='waiting'),
//     added CUMULATIVELY once their expected_start_date is on/before the week.
//   Three scenarios map straight onto the tab's existing buttons:
//     pessimistic = confirmed only
//     realistic   = confirmed + COMMITTED waitlist (deposit paid OR ready-reserve)
//     optimistic  = confirmed + ALL waiting expected-starts
//   Read-only. Mounts under the already-mounted /api/occupancy.
// ===========================================================================
router.get('/projection', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const weeks = Math.min(Math.max(parseInt(req.query.weeks) || 26, 4), 52);
    const today = ymd(new Date());
    const addDays = (dateStr, n) => { const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
    const startMon = weekStart(today);
    const DOWK = ['mon', 'tue', 'wed', 'thu', 'fri'];

    const { rows: rooms } = await db.query(`
      SELECT id, name, capacity,
             COALESCE(target_capacity, capacity) AS target_capacity,
             COALESCE(legal_capacity,  capacity) AS legal_capacity
      FROM rooms ORDER BY min_age_months, id`);
    const { rows: bookings } = await db.query(`
      SELECT room_id, mon, tue, wed, thu, fri,
             start_date::text AS start_date, end_date::text AS end_date
      FROM child_bookings
      WHERE is_active = true AND room_id IS NOT NULL`);
    const { rows: wl } = await db.query(`
      SELECT id, room_needed, expected_start_date::text AS es,
             COALESCE(deposit_paid,false)  AS deposit_paid,
             COALESCE(ready_reserve,false) AS ready_reserve
      FROM waiting_list_live
      WHERE COALESCE(status,'waiting') = 'waiting' AND expected_start_date IS NOT NULL`);

    // waitlist room_needed text → room id (name match, else baby/pre keyword)
    const roomForNeeded = needed => {
      const n = (needed || '').toLowerCase();
      let m = rooms.find(r => r.name.toLowerCase() === n);
      if (m) return m.id;
      if (/bab/.test(n)) { m = rooms.find(r => /bab/i.test(r.name)); if (m) return m.id; }
      if (/pre|school/.test(n)) { m = rooms.find(r => /pre|school/i.test(r.name)); if (m) return m.id; }
      return null;
    };
    const band = (n, r) => n > r.legal_capacity ? 'over' : n > r.capacity ? 'red' : n > r.target_capacity ? 'orange' : 'green';
    const pct = (n, r) => r.capacity ? Math.round(n / r.capacity * 100) : 0;

    const series = [];
    for (let w = 0; w < weeks; w++) {
      const ws = addDays(startMon, w * 7), we = addDays(ws, 4);
      const roomsOut = rooms.map(room => {
        let peak = 0;
        for (let di = 0; di < 5; di++) {
          const dateStr = addDays(ws, di);
          let occ = 0;
          for (const b of bookings) {
            if (b.room_id !== room.id || !b[DOWK[di]]) continue;
            if (b.start_date && dateStr < b.start_date) continue;
            if (b.end_date && dateStr > b.end_date) continue;
            occ++;
          }
          if (occ > peak) peak = occ;
        }
        let incAll = 0, incCommitted = 0;
        for (const x of wl) {
          if (roomForNeeded(x.room_needed) !== room.id) continue;
          if (x.es > we) continue;                       // hasn't started by this week
          incAll++; if (x.deposit_paid || x.ready_reserve) incCommitted++;
        }
        const pess = peak, real = peak + incCommitted, opt = peak + incAll;
        return {
          room_id: room.id, room_name: room.name,
          capacity: +room.capacity, target: +room.target_capacity, legal: +room.legal_capacity,
          confirmed: peak, waitlist_committed: incCommitted, waitlist_all: incAll,
          pessimistic: pess, realistic: real, optimistic: opt,
          pessimistic_pct: pct(pess, room), realistic_pct: pct(real, room), optimistic_pct: pct(opt, room),
          band: band(real, room),
          headroom_to_cap: Math.max(0, room.capacity - real),
        };
      });
      // starts / leaves happening this week (for the side panel)
      const starts = [], leaves = [];
      for (const b of bookings) {
        const rm = rooms.find(r => r.id === b.room_id);
        if (b.start_date && b.start_date >= ws && b.start_date <= we) starts.push({ kind: 'booked', room: rm ? rm.name : null, date: b.start_date });
        if (b.end_date && b.end_date >= ws && b.end_date <= we) leaves.push({ room: rm ? rm.name : null, date: b.end_date });
      }
      for (const x of wl) {
        if (x.es >= ws && x.es <= we) {
          const rm = rooms.find(r => r.id === roomForNeeded(x.room_needed));
          starts.push({ kind: 'waitlist', room: rm ? rm.name : (x.room_needed || null), date: x.es, committed: x.deposit_paid || x.ready_reserve });
        }
      }
      series.push({
        week_start: ws, week_end: we, month: ws.slice(0, 7),
        label: new Date(ws + 'T00:00:00Z').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
        rooms: roomsOut, starts, leaves,
      });
    }

    res.json({
      generated: today, from: startMon, weeks,
      scenarios: {
        pessimistic: 'confirmed bookings only',
        realistic: 'confirmed + committed waitlist (deposit paid or ready-reserve)',
        optimistic: 'confirmed + all waiting expected-starts',
      },
      bands: { green: '≤target', orange: 'target..cap', red: 'cap..legal', over: '>legal (blocked)' },
      rooms: rooms.map(r => ({ id: r.id, name: r.name, capacity: +r.capacity, target: +r.target_capacity, legal: +r.legal_capacity })),
      note: 'Confirmed occupancy = peak weekday from the child_bookings register (includes confirmed future starts, drops ended bookings). Waitlist incoming = currently-waiting expected-starts added cumulatively once their expected_start_date passes (not yet bookings, so no double-count). Baby→pre transfers surface only where a booking end_date + a new pre booking exist.',
      series,
    });
  } catch (e) { console.error('[occupancy/projection]', e); res.status(500).json({ error: e.message }); }
});

// GET /booking-grid?from=&to= — EyLog "Occupancy Tracker"-style grid, built from CONTRACTED
// BOOKINGS (child_bookings mon–fri) so it works for FUTURE weeks (attendance only exists for
// past days). Per week × weekday × room: booked children, minus those on a reported
// holiday/sick absence that day = places occupied. Capacity = target_capacity (matches the
// EyLog room caps: Baby 10, Pre-school 22). Bookings are full-day, so AM == PM (as in EyLog).
router.get('/booking-grid', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const from = req.query.from || ymd(new Date());
    const to   = req.query.to   || ymd(new Date(Date.now() + 84 * 86400000));
    const rooms = (await db.query(
      `SELECT id, name, COALESCE(target_capacity, capacity) AS capacity
       FROM rooms ORDER BY min_age_months`)).rows.map(r => ({ id: r.id, name: r.name, capacity: parseInt(r.capacity) || 0 }));
    const { rows } = await db.query(`
      WITH days AS (
        SELECT d::date AS day, EXTRACT(ISODOW FROM d)::int AS dow
        FROM generate_series($1::date, $2::date, interval '1 day') d
        WHERE EXTRACT(ISODOW FROM d) BETWEEN 1 AND 5
      ),
      booked AS (
        SELECT DISTINCT days.day, COALESCE(b.room_id, c.room_id) AS room_id, b.child_id
        FROM days
        JOIN child_bookings b ON b.is_active = true
          AND days.day >= b.start_date
          AND (b.end_date IS NULL OR days.day <= b.end_date)
          AND ((days.dow=1 AND b.mon) OR (days.dow=2 AND b.tue) OR (days.dow=3 AND b.wed)
            OR (days.dow=4 AND b.thu) OR (days.dow=5 AND b.fri))
        JOIN children c ON c.id = b.child_id AND c.is_active = true AND COALESCE(c.is_demo, false) = false
      ),
      absent AS (
        SELECT bk.day, bk.child_id
        FROM booked bk
        JOIN parent_reported_absences p ON p.child_id = bk.child_id
          AND bk.day >= p.start_date AND bk.day <= COALESCE(p.end_date, p.start_date)
          AND lower(COALESCE(p.status,'')) NOT IN ('rejected','cancelled','declined')
      )
      SELECT date_trunc('week', bk.day)::date AS week_start, bk.day, bk.room_id,
        count(DISTINCT bk.child_id) AS booked,
        count(DISTINCT bk.child_id) FILTER (WHERE ab.child_id IS NULL) AS present,
        count(DISTINCT bk.child_id) FILTER (WHERE ab.child_id IS NOT NULL) AS absent
      FROM booked bk
      LEFT JOIN absent ab ON ab.day = bk.day AND ab.child_id = bk.child_id
      GROUP BY 1, bk.day, bk.room_id
      ORDER BY 2, 3`, [from, to]);
    const capById = Object.fromEntries(rooms.map(r => [r.id, r.capacity]));
    const weeks = {};
    for (const row of rows) {
      const wk = ymd(row.week_start), day = ymd(row.day);
      weeks[wk] = weeks[wk] || { week_start: wk, days: {} };
      weeks[wk].days[day] = weeks[wk].days[day] || {};
      const present = parseInt(row.present) || 0;
      weeks[wk].days[day][row.room_id] = {
        booked: parseInt(row.booked) || 0, present, absent: parseInt(row.absent) || 0,
        capacity: capById[row.room_id] || 0,
        available: Math.max(0, (capById[row.room_id] || 0) - present),
      };
    }
    res.json({ rooms, weeks: Object.values(weeks).sort((a, b) => a.week_start < b.week_start ? -1 : 1) });
  } catch (e) { console.error('[occupancy/booking-grid]', e); res.status(500).json({ error: e.message }); }
});

// GET /booking-day?date=&room_id= — the children CONTRACTED in a room that day (EyLog cell
// expand), each with their weekday pattern, funded flag, and any holiday/sick absence.
router.get('/booking-day', managerOnly, async (req, res) => {
  const db = getPool();
  const { date, room_id } = req.query;
  if (!date) return res.status(400).json({ error: 'date required' });
  try {
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, left(coalesce(c.last_name,''),1) AS li,
        (CASE WHEN b.mon THEN 'Mon ' ELSE '' END || CASE WHEN b.tue THEN 'Tue ' ELSE '' END ||
         CASE WHEN b.wed THEN 'Wed ' ELSE '' END || CASE WHEN b.thu THEN 'Thu ' ELSE '' END ||
         CASE WHEN b.fri THEN 'Fri' ELSE '' END) AS days_pattern,
        (CASE WHEN b.mon THEN 1 ELSE 0 END + CASE WHEN b.tue THEN 1 ELSE 0 END +
         CASE WHEN b.wed THEN 1 ELSE 0 END + CASE WHEN b.thu THEN 1 ELSE 0 END +
         CASE WHEN b.fri THEN 1 ELSE 0 END) AS days_count,
        COALESCE(b.funded,false) AS funded,
        p.absence_type,
        (p.id IS NOT NULL) AS absent
      FROM child_bookings b
      JOIN children c ON c.id = b.child_id AND c.is_active = true AND COALESCE(c.is_demo, false) = false
      LEFT JOIN LATERAL (
        SELECT id, absence_type FROM parent_reported_absences pr
        WHERE pr.child_id = c.id AND $1::date >= pr.start_date AND $1::date <= COALESCE(pr.end_date, pr.start_date)
          AND lower(COALESCE(pr.status,'')) NOT IN ('rejected','cancelled','declined') LIMIT 1
      ) p ON true
      WHERE b.is_active = true AND $1::date >= b.start_date AND (b.end_date IS NULL OR $1::date <= b.end_date)
        AND ($2::int IS NULL OR COALESCE(b.room_id, c.room_id) = $2::int)
        AND CASE EXTRACT(ISODOW FROM $1::date)::int
              WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
      ORDER BY absent, c.first_name`, [date, room_id || null]);
    res.json(rows);
  } catch (e) { console.error('[occupancy/booking-day]', e); res.status(500).json({ error: e.message }); }
});

// GET /staffing-forecast?months=N — MAX staff needed per month, from the booking-based DAILY
// occupancy with each child's age band computed AT THAT DATE. This captures the pre-school
// mixed-age ratio problem: 2yo (1:5) children age into 3-4 (1:8), babies transfer up at 24m,
// and Sept intake starts — so the ratio-driven staffing need shifts month to month. Returns,
// per month, the PEAK weekday (worst-case staffing) with its under-2 / 2yo / 3-4 mix.
router.get('/staffing-forecast', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const months = Math.min(Math.max(parseInt(req.query.months, 10) || 12, 1), 18);
    const from = req.query.from || ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
    const to   = ymd(new Date(new Date(from).getFullYear(), new Date(from).getMonth() + months, 0));
    const { rows } = await db.query(`
      WITH days AS (
        SELECT d::date AS day, EXTRACT(ISODOW FROM d)::int AS dow, to_char(d,'YYYY-MM') AS ym
        FROM generate_series($1::date, $2::date, interval '1 day') d
        WHERE EXTRACT(ISODOW FROM d) BETWEEN 1 AND 5
      ),
      present AS (
        SELECT days.day, days.ym, b.child_id,
          (EXTRACT(YEAR FROM age(days.day, c.date_of_birth))*12
           + EXTRACT(MONTH FROM age(days.day, c.date_of_birth)))::int AS am
        FROM days
        JOIN child_bookings b ON b.is_active = true
          AND days.day >= b.start_date AND (b.end_date IS NULL OR days.day <= b.end_date)
          AND ((days.dow=1 AND b.mon) OR (days.dow=2 AND b.tue) OR (days.dow=3 AND b.wed)
            OR (days.dow=4 AND b.thu) OR (days.dow=5 AND b.fri))
        JOIN children c ON c.id = b.child_id AND c.is_active = true AND c.date_of_birth IS NOT NULL
          AND COALESCE(c.is_demo, false) = false
        WHERE NOT EXISTS (
          SELECT 1 FROM parent_reported_absences p WHERE p.child_id = b.child_id
            AND days.day >= p.start_date AND days.day <= COALESCE(p.end_date, p.start_date)
            AND lower(COALESCE(p.status,'')) NOT IN ('rejected','cancelled','declined'))
      ),
      per_day AS (
        SELECT day, ym,
          count(DISTINCT child_id) FILTER (WHERE am < 24) AS u2,
          count(DISTINCT child_id) FILTER (WHERE am >= 24 AND am < 36) AS a2,
          count(DISTINCT child_id) FILTER (WHERE am >= 36 AND am < 60) AS a3,
          (ceil(count(DISTINCT child_id) FILTER (WHERE am < 24)/3.0)
           + ceil(count(DISTINCT child_id) FILTER (WHERE am >= 24 AND am < 36)/5.0)
           + ceil(count(DISTINCT child_id) FILTER (WHERE am >= 36 AND am < 60)/8.0))::int AS staff,
          count(DISTINCT child_id) FILTER (WHERE am < 60) AS present
        FROM present GROUP BY day, ym
      )
      SELECT DISTINCT ON (ym) ym, day AS peak_day, u2, a2, a3, present, staff
      FROM per_day ORDER BY ym, staff DESC, present DESC, day`, [from, to]);
    const series = rows.map(r => ({
      month: r.ym, peak_day: ymd(r.peak_day),
      max_staff: parseInt(r.staff) || 0, present: parseInt(r.present) || 0,
      under2: parseInt(r.u2) || 0, age2: parseInt(r.a2) || 0, age3plus: parseInt(r.a3) || 0,
    }));
    res.json({ from, to, ratios: { under2: 3, age2: 5, age3plus: 8 }, series });
  } catch (e) { console.error('[occupancy/staffing-forecast]', e); res.status(500).json({ error: e.message }); }
});

module.exports = router;

// ── Exported internals (Prompt 21, additive) ───────────────────────────────────
// The staffing-effectiveness service (src/services/staffing-history.js) reuses the
// EXACT same per-day occupancy/ratio computation rather than duplicating it. These
// are read-only helpers — attaching them changes no existing route behaviour.
module.exports.internals = {
  ATT_FROM, ymd, daysBetween, eachDate, isoDow0Mon, weekStart,
  loadHistoryInputs, buildIndexes, computeDay, staffPresentOnDate, statusFromDelta,
  isRatioCountable,
};
