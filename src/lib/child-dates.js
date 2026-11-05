'use strict';
// ===========================================================================
// b315 — THE TWO DATES A CHILD'S RECORD CALCULATES FOR ITSELF (2026-09-10)
//
// Toby: "it should also calculate their leave date based on the 31st of August
//        after they turn 4 and then do their [room] move date if they're a baby
//        the Monday after their Second birthday."
//
//   expectedLeaveDate(dob)     — the 31 August ON OR AFTER the 4th birthday.
//                                That is the summer they leave for Reception.
//   expectedRoomMoveDate(dob)  — the MONDAY ON OR AFTER the 2nd birthday.
//                                If the birthday IS a Monday, that Monday.
//
// BOTH ARE SUGGESTIONS, NOT FACTS. Nothing in here writes anything. The caller
// shows the answer as "expected", and a manager's own date is stored separately
// (children.leave_date + leave_date_manual, children.transfer_planned_date +
// transfer_date_manual) so correcting a date of birth recomputes the suggestion
// without silently overwriting a decision somebody made.
//
// ONE DEFINITION, TESTED ONCE. These rules are also needed in SQL — the autumn
// exodus signal (b311), the availability heat-map and the occupancy forecast all
// ask them of a whole table at once. The SQL twins are
// ladn.expected_leave_date(date) and ladn.expected_room_move_date(date), created
// by migrations/2026-09-10-b315-child-source-of-truth.sql, and
// scripts/b315-date-rules.test.js cross-checks the two implementations over
// thousands of dates rather than trusting that they were written to agree.
//
// ALL STRING MATHS. node-pg hands back a DATE column as a JS Date at LOCAL
// midnight, so toISOString() on a BST date returns yesterday. Every function
// here normalises to 'YYYY-MM-DD' with local getters first and then works on the
// string, which is the only arithmetic that has never been wrong here.
// ===========================================================================

/** Anything date-ish → 'YYYY-MM-DD', or null. Local getters, never toISOString. */
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const m = String(v).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? m[0] : null;
}

const _isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const _DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
function daysInMonth(year, month /* 1-12 */) {
  return month === 2 && _isLeap(year) ? 29 : _DAYS[month - 1];
}

/**
 * Add whole years, clamping the day to the end of the month.
 * 29 February + 2 years = 28 February — the same answer Postgres gives for
 * `dob + interval '2 years'`, which is what makes the SQL twin exact rather
 * than approximately right.
 */
function addYearsClamped(dob, n) {
  const d = ymd(dob);
  if (!d) return null;
  const y = parseInt(d.slice(0, 4), 10) + n;
  const mo = parseInt(d.slice(5, 7), 10);
  const day = Math.min(parseInt(d.slice(8, 10), 10), daysInMonth(y, mo));
  return `${y}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** ISO weekday: 1 = Monday … 7 = Sunday. UTC construction, so no BST drift. */
function isoDow(iso) {
  const d = ymd(iso);
  if (!d) return null;
  const dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  return ((dt.getUTCDay() + 6) % 7) + 1;
}

function addDays(iso, n) {
  const d = ymd(iso);
  if (!d) return null;
  const dt = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)));
  dt.setUTCDate(dt.getUTCDate() + n);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

/** The Monday of that week if the date IS a Monday, otherwise the next one. */
function mondayOnOrAfter(iso) {
  const d = ymd(iso);
  if (!d) return null;
  return addDays(d, (8 - isoDow(d)) % 7);
}

// ── the two rules ──────────────────────────────────────────────────────────

/**
 * Baby Room → Pre-school: the Monday on or after the child's 2nd birthday.
 * @param {string|Date} dob
 * @returns {string|null} 'YYYY-MM-DD'
 */
function expectedRoomMoveDate(dob) {
  const second = addYearsClamped(dob, 2);
  return second ? mondayOnOrAfter(second) : null;
}

/**
 * The 31 August on or after the child's 4th birthday — the summer before the
 * September they start Reception.
 *
 * A birthday on 1 Sept or later has already passed that year's 31 August, so it
 * waits for the next one: born September 2021 → 4 in September 2025 → leaves
 * 31 August 2026. Born May 2021 → 4 in May 2025 → leaves 31 August 2025. A child
 * born ON 31 August turns 4 that very day and starts Reception the next week, so
 * that 31 August is their last day: the "on or after" is doing real work.
 *
 * Identical to the 31 August immediately BEFORE the 5th birthday, which is how
 * computeEndDate() in src/routes/bookings.js has always phrased it; that
 * function now delegates here so there is one of them.
 * @param {string|Date} dob
 * @returns {string|null} 'YYYY-MM-DD'
 */
function expectedLeaveDate(dob) {
  const d = ymd(dob);
  if (!d) return null;
  const year = parseInt(d.slice(0, 4), 10);
  const month = parseInt(d.slice(5, 7), 10);
  return `${year + (month >= 9 ? 5 : 4)}-08-31`;
}

// ── age, the way a person reads it ─────────────────────────────────────────
/**
 * Whole years and months between a date of birth and a date (default today).
 * "2 years 4 months", because that is what anyone looking at a date of birth on
 * a child's record is actually working out.
 */
function ageYearsMonths(dob, asOf) {
  const b = ymd(dob);
  if (!b) return null;
  const t = ymd(asOf) || ymd(new Date());
  if (t < b) return null;
  const by = +b.slice(0, 4), bm = +b.slice(5, 7), bd = +b.slice(8, 10);
  const ty = +t.slice(0, 4), tm = +t.slice(5, 7), td = +t.slice(8, 10);
  let months = (ty - by) * 12 + (tm - bm);
  if (td < bd) months -= 1;
  if (months < 0) months = 0;
  const years = Math.floor(months / 12);
  const rem = months % 12;
  const parts = [];
  if (years) parts.push(`${years} year${years === 1 ? '' : 's'}`);
  parts.push(`${rem} month${rem === 1 ? '' : 's'}`);
  return { years, months: rem, total_months: months, label: parts.join(' ') };
}

/** Months old on a date — the number the room age-bands are expressed in. */
function ageMonths(dob, asOf) {
  const a = ageYearsMonths(dob, asOf);
  return a ? a.total_months : null;
}

module.exports = {
  ymd, addDays, addYearsClamped, isoDow, mondayOnOrAfter, daysInMonth,
  expectedRoomMoveDate, expectedLeaveDate, ageYearsMonths, ageMonths,
};
