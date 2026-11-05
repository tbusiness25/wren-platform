// Deterministic staffing-ratio engine for the absence gatekeeper (A3).
// NO LLM — pure arithmetic + DB reads. qwen only writes wording elsewhere.
//
// NURSERY-CONTEXT source of truth:
//   Q2 ratios: under-2 → 1:3, 2yr → 1:5, 3yr+ → 1:8
//   Q5 not counted in ratio: manager (Toby), chef (the chef), the office manager
//   Q6 must keep enough staff on the day +1 (a spare for same-day sickness)
//   Q9 no leave block > 2 weeks (14 days) without written manager permission
//
// BOOKING DATA SOURCE (updated 2026-07-01): bookedChildrenByBand() now reads the
// §55 booked register child_bookings (Wren's authoritative "who is expected
// in on this weekday" table) as its primary source. When no active booking pattern
// covers the date (e.g. the register hasn't been seeded yet), it FALLS BACK to the
// legacy attendance-over-a-trailing-window proxy so the engine never silently
// regresses to "everything passes". The returned counts carry a `source` field
// ('bookings' | 'attendance_proxy' | 'none') for transparency.

// STATUTORY defaults (EYFS): under-2 → 1:3, 2yr → 1:5, 3yr+ → 1:8. These are the
// fallback for any setting WITHOUT a `ratios` row (important for self-host installs).
const RATIOS = { under2: 3, two: 5, threePlus: 8 };
// One definition of ratio eligibility, shared with the rota's per-slot view.
const { countsOnRatio } = require('../lib/ratio-eligibility');
const SPARE_BUFFER = 1;            // Q6: keep one spare staff above the requirement
const MAX_BLOCK_DAYS = 14;         // Q9
const LOOKBACK_WEEKS = 8;          // booking-pattern derivation window
const SEARCH_HORIZON_DAYS = 90;    // how far ahead to look for nearest passing dates

function ageBandOn(dob, dateStr) {
  const d = new Date(dateStr), b = new Date(dob);
  let yrs = d.getFullYear() - b.getFullYear();
  const m = d.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < b.getDate())) yrs--;
  if (yrs < 2) return 'under2';
  if (yrs < 3) return 'two';
  return 'threePlus';
}

// Configurable ratios (2026-08-03). A setting can run stricter than statutory —
// LADN uses 1:4 for 2-year-olds. `ratios` is the {under2,two,threePlus} object from
// getRatios(db); when omitted we fall back to the statutory RATIOS constant so every
// existing synchronous caller keeps its previous behaviour unchanged.
function requiredStaff(counts, ratios) {
  const R = ratios || RATIOS;
  return Math.ceil((counts.under2 || 0) / R.under2)
       + Math.ceil((counts.two || 0) / R.two)
       + Math.ceil((counts.threePlus || 0) / R.threePlus);
}

// Runtime ratio config: reads settings key 'ratios' (JSON {under2,two,threePlus}),
// cached briefly so the absence gatekeeper / rota don't hammer the DB. Any missing
// or non-positive value falls back to the statutory default for that band, so a
// partial/absent row can never produce a divide-by-zero or a laxer-than-statutory
// number by accident.
let _ratiosCache = null, _ratiosCacheAt = 0;
const RATIOS_TTL_MS = 60000;   // 60s — config changes rarely; refresh is cheap
function _sanitiseRatios(parsed) {
  const pick = (v, def) => (Number(v) > 0 ? Number(v) : def);
  return {
    under2:    pick(parsed && parsed.under2,    RATIOS.under2),
    two:       pick(parsed && parsed.two,       RATIOS.two),
    threePlus: pick(parsed && parsed.threePlus, RATIOS.threePlus),
  };
}
async function getRatios(db) {
  const now = Date.now();
  if (_ratiosCache && (now - _ratiosCacheAt) < RATIOS_TTL_MS) return _ratiosCache;
  let r = { ...RATIOS };
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key='ratios'");
    if (rows.length && rows[0].value) {
      const parsed = typeof rows[0].value === 'string' ? JSON.parse(rows[0].value) : rows[0].value;
      r = _sanitiseRatios(parsed);
    }
  } catch (e) { /* schema/parse issue → statutory default (never throws) */ }
  _ratiosCache = r; _ratiosCacheAt = now;
  return r;
}

// Booked children by age band on a given date.
// Primary source: child_bookings (§55 register). Fallback: attendance proxy.
// Respects ratio_include_settling setting to exclude settling children if configured.
async function bookedChildrenByBand(db, dateStr) {
  // Read ratio settings
  const { rows: settingsRows } = await db.query(`
    SELECT key, value FROM settings WHERE key IN ('ratio_include_settling', 'ratio_include_event_children')
  `);
  const settings = {};
  for (const s of settingsRows) settings[s.key] = s.value === 'true';
  const includeSettling = settings.ratio_include_settling !== false; // default true

  // 1) Authoritative §55 booked register: an active pattern covering the date with
  //    the matching weekday bit set (Mon=1..Fri=5). One row per child (DISTINCT).
  // Optionally exclude children with active settling plans where counts_on_ratio=false.
  const { rows: booked } = await db.query(`
    SELECT DISTINCT c.id, c.date_of_birth
    FROM child_bookings b
    JOIN children c ON c.id = b.child_id
    WHERE b.is_active = true
      AND COALESCE(c.is_active, true) = true
      AND COALESCE(c.is_demo, false) = false
      AND c.date_of_birth IS NOT NULL
      AND $1::date BETWEEN b.start_date AND COALESCE(b.end_date, DATE '2100-01-01')
      AND CASE EXTRACT(DOW FROM $1::date)::int
            WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed
            WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
      AND ($2::boolean = true OR NOT EXISTS (
        SELECT 1 FROM settling_in_plans sp
        WHERE sp.child_id = c.id
          AND COALESCE(sp.is_active, true) = true
          AND COALESCE(sp.counts_on_ratio, true) = false
      ))
  `, [dateStr, includeSettling]);
  if (booked.length) {
    const counts = { under2: 0, two: 0, threePlus: 0, total: booked.length, source: 'bookings' };
    for (const r of booked) counts[ageBandOn(r.date_of_birth, dateStr)]++;
    return counts;
  }

  // 2) Fallback proxy: children who attended this weekday at least once in the
  //    lookback window (used until the booked register is populated).
  const dow = new Date(dateStr + 'T00:00:00').getDay(); // 0=Sun..6=Sat
  const { rows } = await db.query(`
    SELECT DISTINCT c.id, c.date_of_birth
    FROM children c
    JOIN attendance a ON a.child_id = c.id
    WHERE c.is_active = true AND COALESCE(c.is_demo, false) = false AND c.date_of_birth IS NOT NULL
      AND EXTRACT(DOW FROM a.date) = $1
      AND a.date > (CURRENT_DATE - ($2 * 7) * INTERVAL '1 day')
      AND COALESCE(a.absent,false) = false
      AND ($3::boolean = true OR NOT EXISTS (
        SELECT 1 FROM settling_in_plans sp
        WHERE sp.child_id = c.id
          AND COALESCE(sp.is_active, true) = true
          AND COALESCE(sp.counts_on_ratio, true) = false
      ))
  `, [dow, LOOKBACK_WEEKS, includeSettling]);
  const counts = { under2: 0, two: 0, threePlus: 0, total: rows.length,
                   source: rows.length ? 'attendance_proxy' : 'none' };
  for (const r of rows) counts[ageBandOn(r.date_of_birth, dateStr)]++;
  return counts;
}

// ── b314 (2026-09-10) — booked children by ROOM, banded by age within the room.
//
// bookedChildrenByBand() above answers "how many under-2s are booked in the
// setting", which is the right question for the setting-wide staffing total.
// It is the WRONG question for a per-room board, and the rota ratio page was
// using it as one: it showed the Baby Room's booked count as "every under-2 in
// the nursery" and Pre-school's as "everyone else", so which room a child was
// actually in made no difference to either number. Move a child between rooms
// and the ratio board did not move — the exact failure Toby found on the
// occupancy board, in the one place where being wrong is a legal question.
//
// This reads the same §55 register, with the same settling exclusion, and
// groups by the booking's room_id. Statutory ratios are by AGE, so the
// requirement for a room is still summed band by band — a three-year-old in the
// Baby Room is 1:8 for that child, and the room needs staff for the children it
// actually holds. Rooms with nobody booked appear with zeroes rather than being
// dropped, so a room never silently vanishes off the board.
async function bookedChildrenByRoom(db, dateStr) {
  const { rows: settingsRows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN ('ratio_include_settling')`);
  const settings = {};
  for (const s of settingsRows) settings[s.key] = s.value === 'true';
  const includeSettling = settings.ratio_include_settling !== false;

  const { rows: rooms } = await db.query('SELECT id, name FROM rooms ORDER BY id');
  const out = {};
  for (const r of rooms) {
    out[r.id] = { room_id: r.id, room_name: r.name, under2: 0, two: 0, threePlus: 0, total: 0 };
  }
  out._unassigned = { room_id: null, room_name: 'No room on the booking',
                      under2: 0, two: 0, threePlus: 0, total: 0 };

  const { rows: booked } = await db.query(`
    SELECT DISTINCT c.id, c.date_of_birth, b.room_id
    FROM child_bookings b
    JOIN children c ON c.id = b.child_id
    WHERE b.is_active = true
      AND COALESCE(c.is_active, true) = true
      AND COALESCE(c.is_demo, false) = false
      AND c.date_of_birth IS NOT NULL
      AND $1::date BETWEEN b.start_date AND COALESCE(b.end_date, DATE '2100-01-01')
      AND CASE EXTRACT(DOW FROM $1::date)::int
            WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed
            WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
      AND ($2::boolean = true OR NOT EXISTS (
        SELECT 1 FROM settling_in_plans sp
        WHERE sp.child_id = c.id
          AND COALESCE(sp.is_active, true) = true
          AND COALESCE(sp.counts_on_ratio, true) = false
      ))
  `, [dateStr, includeSettling]);

  for (const r of booked) {
    const bucket = (r.room_id != null && out[r.room_id]) ? out[r.room_id] : out._unassigned;
    bucket[ageBandOn(r.date_of_birth, dateStr)]++;
    bucket.total++;
  }

  // Children who are active but have NO live booking are invisible to the
  // register and therefore to this count. Under-counting is the dangerous
  // direction for a ratio, so it is reported rather than papered over — the
  // caller decides what to say, but it can no longer fail to know.
  const { rows: nb } = await db.query(`
    SELECT c.room_id, count(*)::int AS n
      FROM children c
     WHERE COALESCE(c.is_active, true) = true
       AND COALESCE(c.is_demo, false) = false
       AND (c.leave_date IS NULL OR c.leave_date >= $1::date)
       AND NOT EXISTS (
         SELECT 1 FROM child_bookings b
          WHERE b.child_id = c.id AND b.is_active = true
            AND (b.end_date IS NULL OR b.end_date >= $1::date))
     GROUP BY c.room_id`, [dateStr]);
  const not_booked = { total: 0, by_room: {} };
  for (const r of nb) { not_booked.total += r.n; not_booked.by_room[r.room_id ?? 'none'] = r.n; }

  const rooms_out = Object.values(out).filter(r => r.room_id !== null || r.total > 0);
  return { source: 'bookings', rooms: rooms_out, not_booked };
}

// Staff available to count in ratio on a given date (excludes excluded roles/names,
// excludes anyone with approved leave covering the date, and optionally one candidate).
// ── b322 (2026-09-11) — THE WEEKDAY FIX. Read this before changing it. ───────
// staff_work_patterns.day_of_week is 0=Mon…6=Sun. That is stated at
// src/routes/work-patterns.js:48 ("day_of_week 0=Mon..4=Fri"), and the live
// data agrees: wren_dev holds rows for 0,1,2,3,4 and none for 5 or 6.
//
// This function looked the pattern up with JS getDay(), which is 0=Sun…6=Sat.
// Every weekday was therefore wrong, not just one:
//     Monday    getDay 1 → read TUESDAY's pattern
//     Tuesday   getDay 2 → read WEDNESDAY's
//     Wednesday getDay 3 → read THURSDAY's
//     Thursday  getDay 4 → read FRIDAY's
//     Friday    getDay 5 → matched NOTHING → "0 staff available"
//
// So the absence gatekeeper has been answering a question about the wrong day,
// and refusing every Friday outright. It was already known: occupancy.js:149
// and occupancy-sandbox.js:26 both document the mismatch and map correctly for
// themselves rather than fixing it here, and lateness.js carries its own
// PG_DOW_TO_PATTERN for the same reason.
//
// ⚠ BLAST RADIUS — this is a shared engine. Correcting it changes which leave
// requests the absence gatekeeper passes and blocks. That change is in the
// right direction (it was comparing against the wrong day), but it IS a
// behaviour change outside b322 and Toby should know it happened.
function patternDow(dateStr) {
  return (new Date(dateStr + 'T00:00:00').getDay() + 6) % 7;   // Mon→0 … Sun→6
}

async function availableRatioStaff(db, dateStr, excludeStaffId) {
  const dow = patternDow(dateStr);
  const { rows } = await db.query(`
    SELECT DISTINCT s.id, s.first_name, s.last_name, s.role,
           s.counts_on_ratio, s.ratio_level
    FROM staff s
    JOIN staff_work_patterns wp ON wp.staff_id = s.id
    WHERE s.is_active = true
      AND COALESCE(s.is_demo, false) = false
      AND wp.day_of_week = $1
      AND COALESCE(wp.is_off,false) = false
      AND (wp.effective_from IS NULL OR wp.effective_from <= $2::date)
      AND (wp.effective_to   IS NULL OR wp.effective_to   >= $2::date)
      AND s.id <> COALESCE($3,-1)
      AND NOT EXISTS (
        SELECT 1 FROM absence_requests ar
        WHERE ar.staff_id = s.id AND ar.status='approved'
          AND ar.start_date <= $2::date AND ar.end_date >= $2::date)
  `, [dow, dateStr, excludeStaffId || null]);
  // 2026-09-04: one definition of "counts on ratio", in src/lib/offratio.js, so the
  // absence gatekeeper and the rota's slot view cannot drift apart. It honours the
  // per-staff staff.counts_on_ratio override and falls back to the role, replacing
  // the first-name regex that used to exclude two people by matching their name.
  return rows.filter(r => countsOnRatio(r));
}

async function checkDate(db, dateStr, excludeStaffId) {
  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const weekend = (dow === 0 || dow === 6);
  const booked = await bookedChildrenByBand(db, dateStr);
  const ratios = await getRatios(db);           // configured (LADN 2yr 1:4), else statutory
  const required = requiredStaff(booked, ratios);
  const available = (await availableRatioStaff(db, dateStr, excludeStaffId)).length;
  const need = required + SPARE_BUFFER;          // Q6 +1 spare
  const pass = weekend || booked.total === 0 || available >= need;
  return {
    date: dateStr, weekday: dow, weekend,
    booked, required, spare_buffer: SPARE_BUFFER, need, available, pass,
    reason: pass
      ? (weekend ? 'Weekend — nursery closed.' : (booked.total === 0 ? 'No children booked.' : `OK: ${available} staff available, ${need} needed (incl. +1 spare).`))
      : `Ratios fail: only ${available} ratio staff available but ${required} required +${SPARE_BUFFER} spare = ${need} needed (booked: ${booked.under2}×<2, ${booked.two}×2yr, ${booked.threePlus}×3yr+).`
  };
}

function addDays(dateStr, n) {
  // Build from LOCAL components — toISOString() would shift the date on BST/non-UTC hosts.
  const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

// Check a whole requested range. Returns { pass, days[], failing_days[], blackout, nearest }.
async function checkRange(db, startDate, endDate, excludeStaffId) {
  const len = daysBetween(startDate, endDate) + 1;
  const blackout = len > MAX_BLOCK_DAYS;
  const days = [];
  for (let i = 0; i < len; i++) days.push(await checkDate(db, addDays(startDate, i), excludeStaffId));
  const failing = days.filter(d => !d.pass);
  let nearest = null;
  if (failing.length) nearest = await nearestPassingWindow(db, startDate, len, excludeStaffId);
  return {
    pass: failing.length === 0,
    request_days: len,
    blackout,
    blackout_note: blackout ? `Request is ${len} days — over the ${MAX_BLOCK_DAYS}-day limit; written manager permission required.` : null,
    days,
    failing_days: failing.map(d => ({ date: d.date, reason: d.reason })),
    nearest_passing_dates: nearest
  };
}

// Find up to 3 future start dates of length `len` where every working day passes.
async function nearestPassingWindow(db, fromDate, len, excludeStaffId) {
  const found = [];
  for (let offset = 1; offset <= SEARCH_HORIZON_DAYS && found.length < 3; offset++) {
    const start = addDays(fromDate, offset);
    // Only propose weekday start dates — nursery is closed at weekends, so a
    // weekend "pass" is meaningless for a leave request.
    const sdow = new Date(start + 'T00:00:00').getDay();
    if (sdow === 0 || sdow === 6) continue;
    let ok = true;
    for (let i = 0; i < len; i++) {
      const c = await checkDate(db, addDays(start, i), excludeStaffId);
      if (!c.pass) { ok = false; break; }
    }
    if (ok) { found.push(start); offset += len - 1; }
  }
  return found;
}

module.exports = {
  RATIOS, getRatios, ageBandOn, requiredStaff,
  bookedChildrenByBand, bookedChildrenByRoom, availableRatioStaff,
  checkDate, checkRange, nearestPassingWindow,
};
