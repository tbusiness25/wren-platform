'use strict';
/**
 * staffing-weeks.js — deterministic WEEKLY staffing-requirement engine (2026-08-03).
 *
 * Pure arithmetic + DB reads (no LLM). For every ISO week in a date range and every
 * room it computes, from the §55 booked register (child_bookings):
 *   - booked children by age band, WITH each child's band re-derived at that week's
 *     date, so a child who turns 3 mid-year moves from the 2yr band to the 3yr+ band
 *     in the correct week (and the "needed" number drops when the ratio widens);
 *   - required staff = Σ ceil(band_count / ratio[band]) using the CONFIGURED ratios
 *     (ratio-engine.getRatios — LADN runs 2yr 1:4, stricter than statutory 1:5);
 *   - on_rota   = distinct non-absent, non-open staff assigned to that room that week
 *                 (rota_shifts joined rota_weeks on the week's Monday);
 *   - variance  = on_rota - required   (negative = under-ratio, positive = over-staffed).
 *
 * Reuses src/services/ratio-engine (ageBandOn / requiredStaff / getRatios) — no ratio
 * maths is re-implemented here.
 */

const ratioEngine = require('./ratio-engine');

// ── ISO-week (Monday-start) helpers, all in local components to avoid TZ drift ──
function _mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = d.getDay();                 // 0=Sun..6=Sat
  const diff = dow === 0 ? -6 : 1 - dow;  // back up to Monday
  d.setDate(d.getDate() + diff);
  return _fmt(d);
}
function _addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00'); d.setDate(d.getDate() + n);
  return _fmt(d);
}
function _fmt(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// List of Monday ISO-week starts covering [fromISO, toISO] inclusive.
function isoWeeksBetween(fromISO, toISO) {
  const weeks = [];
  let cur = _mondayOf(fromISO);
  const lastMonday = _mondayOf(toISO);
  // guard: cap at ~120 weeks so a bad range can never spin forever
  for (let i = 0; i < 130 && cur <= lastMonday; i++) { weeks.push(cur); cur = _addDays(cur, 7); }
  return weeks;
}

/**
 * weeklyStaffing(db, fromISO, toISO) → tidy array, one row per (week, room):
 *   { week_start, week_end, room_id, room_name, booked,
 *     under2, two, threePlus, required, on_rota, variance, ratios }
 */
async function weeklyStaffing(db, fromISO, toISO) {
  const ratios = await ratioEngine.getRatios(db);          // {under2, two, threePlus}
  const { rows: rooms } = await db.query('SELECT id, name FROM rooms ORDER BY id');
  const weeks = isoWeeksBetween(fromISO, toISO);
  const out = [];

  for (const weekStart of weeks) {
    const weekEnd = _addDays(weekStart, 4);   // Friday (nursery is Mon–Fri)
    // Reference date for age banding = the week's Monday. A child crossing a band
    // boundary during the year is therefore counted in whichever band they are in
    // AT THE START OF THAT WEEK — the band is recomputed per week, never fixed.
    const bandRefDate = weekStart;

    // Children booked ANY weekday this week, from the §55 register. A booking counts
    // if its active date-range overlaps this week AND at least one Mon–Fri flag is set.
    // Children: non-demo, and not-yet-left as of this week (leave_date NULL or >= week).
    const { rows: booked } = await db.query(`
      SELECT DISTINCT c.id,
             c.date_of_birth,
             COALESCE(b.room_id, c.room_id) AS room_id
        FROM child_bookings b
        JOIN children c ON c.id = b.child_id
       WHERE b.is_active = true
         AND (b.mon OR b.tue OR b.wed OR b.thu OR b.fri)
         AND b.start_date <= $2::date
         AND COALESCE(b.end_date, DATE '2100-01-01') >= $1::date
         AND COALESCE(c.is_demo, false) = false
         AND c.date_of_birth IS NOT NULL
         AND (c.leave_date IS NULL OR c.leave_date >= $1::date)
    `, [weekStart, weekEnd]);

    // Distinct non-absent, non-open, assigned staff per room on the matching rota week.
    // (on_rota is only meaningful where a rota_week row exists for this Monday.)
    const { rows: rotaRows } = await db.query(`
      SELECT rs.room_id, COUNT(DISTINCT rs.staff_id)::int AS on_rota
        FROM rota_shifts rs
        JOIN rota_weeks rw ON rw.id = rs.rota_week_id
       WHERE rw.week_start = $1::date
         AND rs.is_absent = false
         AND COALESCE(rs.is_open, false) = false
         AND rs.staff_id IS NOT NULL
       GROUP BY rs.room_id
    `, [weekStart]);
    const onRotaByRoom = {};
    for (const r of rotaRows) onRotaByRoom[r.room_id] = r.on_rota;

    // Bucket booked children by room + age-band-at-this-week.
    const byRoom = {};
    for (const room of rooms) byRoom[room.id] = { under2: 0, two: 0, threePlus: 0, booked: 0 };
    for (const child of booked) {
      const rid = child.room_id;
      if (rid == null || !byRoom[rid]) continue;             // unassigned/other room → skip
      const band = ratioEngine.ageBandOn(child.date_of_birth, bandRefDate);
      byRoom[rid][band]++;
      byRoom[rid].booked++;
    }

    for (const room of rooms) {
      const b = byRoom[room.id];
      const required = ratioEngine.requiredStaff(b, ratios);
      const onRota = onRotaByRoom[room.id] || 0;
      out.push({
        week_start: weekStart,
        week_end: weekEnd,
        room_id: room.id,
        room_name: room.name,
        booked: b.booked,
        under2: b.under2,
        two: b.two,
        threePlus: b.threePlus,
        required,
        on_rota: onRota,
        variance: onRota - required,
        ratios,
      });
    }
  }
  return out;
}

// Default reporting range: the last COMPLETED academic year (1 Sep → 31 Aug).
// If today is on/after 1 Sep, the just-started year isn't complete, so we report the
// prior Sep→Aug; before 1 Sep we're still inside a year, so report the one before it.
function defaultAcademicRange(today = new Date()) {
  const y = today.getFullYear();
  const septThisYear = new Date(y, 8, 1);  // month 8 = September
  const startYear = today >= septThisYear ? y - 1 : y - 2;
  return { from: `${startYear}-09-01`, to: `${startYear + 1}-09-01` };
}

module.exports = { weeklyStaffing, isoWeeksBetween, defaultAcademicRange };
