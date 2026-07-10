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
router.use(authenticate);
const managerOnly = (req, res, next) => {
  if (!['manager', 'room_leader'].includes(req.user.role)) return res.status(403).json({ error: 'Manager access required' });
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
      FROM children WHERE is_active=true AND date_of_birth IS NOT NULL`);

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

// NURSERY-CONTEXT Q5: NOT counted in ratio = manager (Toby), cook (Hetty/Henrietta),
// Clare. The shared engine's name regex misses "Henrietta"/role "cook" (she has no
// rota row so it never returns her) — we make the exclusion explicit here so the
// contract-fallback path below can't accidentally count her in the ratio.
const RATIO_EXCLUDED_ROLES = new Set(['manager', 'chef', 'cook', 'owner', 'director']);
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
    ORDER BY a.date`, [from, to]);
  const { rows: staff } = await db.query(`
    SELECT id, first_name, last_name, role, room_id, contracted_hours, hours_per_week
    FROM staff
    WHERE COALESCE(is_active,true)=true AND COALESCE(terminated,false)=false`);
  const { rows: wp } = await db.query(`
    SELECT staff_id, day_of_week, COALESCE(is_off,false) AS is_off,
           shift_start::text AS shift_start, shift_end::text AS shift_end,
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
    WHERE b.is_active = true AND COALESCE(c.is_active,true) = true`);
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
    let source = null, scheduled = null;
    if (shift) {
      source = 'actual';
      scheduled = { clock_in: shift.clock_in_time, clock_out: shift.clock_out_time, total_minutes: shift.total_minutes };
    } else {
      const pats = inp.wpByStaff.get(s.id) || [];
      const p = pats.find(x => x.day_of_week === dow && (!x.ef || x.ef <= date) && (!x.et || x.et >= date));
      if (p) {
        // Rota covers this date/weekday — trust it (is_off ⇒ genuinely not working).
        if (!p.is_off) { source = 'inferred'; scheduled = { shift_start: p.shift_start, shift_end: p.shift_end }; }
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
      .map(p => ({ id: p.id, name: p.full_name, role: p.role, source: p.source, in_ratio: p.in_ratio, on_leave: p.on_leave, absence: p.absence, scheduled: p.scheduled }))
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
