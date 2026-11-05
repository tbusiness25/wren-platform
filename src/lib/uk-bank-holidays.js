'use strict';
/**
 * uk-bank-holidays.js — b504. England and Wales bank holidays 2026 to 2028, plus
 * working-day arithmetic on 'YYYY-MM-DD' strings. Pure; no I/O; no timezone
 * dependence (all maths is on UTC midnight of the calendar date).
 *
 * src/lib/school-calendar.js was checked first: it reads bank holidays from the
 * database (term-date rows), so it cannot be used by pure code or by a script
 * with no pool. This static list is the fallback the picker needs.
 * Substitute days are included (Christmas/Boxing Day falling on a weekend).
 */

const BANK_HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28',
  // 2027 (Christmas Day Sat -> Mon 27; Boxing Day Sun -> Tue 28)
  '2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28',
  // 2028 (New Year's Day Sat -> Mon 3 Jan)
  '2028-01-03', '2028-04-14', '2028-04-17', '2028-05-01', '2028-05-29', '2028-08-28', '2028-12-25', '2028-12-26',
]);

function toUtc(s) {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}
function fromUtc(t) {
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** 0=Sun … 6=Sat for a 'YYYY-MM-DD'. */
function dow(s) { return new Date(toUtc(s)).getUTCDay(); }
function addDays(s, n) { return fromUtc(toUtc(s) + n * 86400000); }
function daysBetween(a, b) { return Math.round((toUtc(b) - toUtc(a)) / 86400000); }

function isBankHoliday(s) { return BANK_HOLIDAYS.has(String(s).slice(0, 10)); }
function isWorkingDay(s) { const w = dow(s); return w !== 0 && w !== 6 && !isBankHoliday(s); }

/** First working day strictly after `s`. */
function nextWorkingDay(s) {
  let d = addDays(s, 1);
  while (!isWorkingDay(d)) d = addDays(d, 1);
  return d;
}
/** Last working day strictly before `s`. */
function prevWorkingDay(s) {
  let d = addDays(s, -1);
  while (!isWorkingDay(d)) d = addDays(d, -1);
  return d;
}
/** `s` itself if it is a working day, else the next one. */
function onOrAfterWorkingDay(s) { return isWorkingDay(s) ? s : nextWorkingDay(s); }

/** Move `n` working days (n may be negative); the start day need not be a working day. */
function addWorkingDays(s, n) {
  let d = s, left = Math.abs(n);
  const step = n < 0 ? -1 : 1;
  while (left > 0) {
    d = addDays(d, step);
    if (isWorkingDay(d)) left--;
  }
  return d;
}

module.exports = { BANK_HOLIDAYS, isBankHoliday, isWorkingDay, nextWorkingDay, prevWorkingDay,
  onOrAfterWorkingDay, addWorkingDays, addDays, daysBetween, dow, toUtc, fromUtc };
