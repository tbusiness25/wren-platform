'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * lookback-terms.js — b523 (2026-10-20)
 *
 * The time spine for the "Look back" inset-day report. Pure functions, no DB.
 *
 * ── WHY THIS IS NOT src/lib/school-calendar.js ───────────────────────────────
 * school-calendar.js is the right answer for PLANNING and it must stay the only
 * answer for it. It reads ladn.school_terms, which holds Ealing's published
 * TEACHING half-terms. Checked read-only against prod on 2026-10-20:
 *
 *     academic_year | rows |    min     |    max
 *     2026-2027     |   6  | 2026-09-07 | 2027-07-27
 *     2027-2028 … 2030-2031                       (all future)
 *
 * There is NOT ONE ROW before September 2026. The data this report looks back
 * over starts in September 2023 (first register row 2023-09-22, first
 * observation 2023). A look-back keyed on school_terms would therefore return
 * nothing at all for every historical year — the exact failure this build is
 * meant to avoid.
 *
 * So the spine here is DERIVED from the statutory early-years term boundaries,
 * which are fixed in law and therefore defined for every year, past or future:
 *
 *     Autumn   1 September – 31 December
 *     Spring   1 January   – 31 March
 *     Summer   1 April     – 31 August
 *
 * Those are the same boundaries as a FUNDING period, and school-calendar.js is
 * emphatic that a funding period is not a school term. It is right. This module
 * therefore never calls what it produces a school term: every label it emits is
 * a statutory term, and lookback.html says so under every chart that uses one.
 * Nothing here reads ladn.funding_terms either — those rows carry rates, some
 * are archived, and a report must not change shape because a rate row was
 * edited.
 *
 * An academic year runs 1 September – 31 August and is written '2025-2026'.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const TERMS = [
  { term: 'Autumn', startMonth: 9,  startDay: 1,  endMonth: 12, endDay: 31, ord: 1 },
  { term: 'Spring', startMonth: 1,  startDay: 1,  endMonth: 3,  endDay: 31, ord: 2 },
  { term: 'Summer', startMonth: 4,  startDay: 1,  endMonth: 8,  endDay: 31, ord: 3 },
];

function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }

/** Today in the London calendar, as 'YYYY-MM-DD'. */
function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}

/** Anything the pg driver or a query string might hand us → 'YYYY-MM-DD' or null.
 *  A DATE column comes back from node-postgres as a JS Date in LOCAL time, so
 *  toISOString() can roll it back a day — see the pg DATE → ymd trap. Use the
 *  local getters, never the ISO string. */
function ymd(v) {
  if (v == null) return null;
  if (typeof v === 'string') return isYmd(v) ? v : (isYmd(v.slice(0, 10)) ? v.slice(0, 10) : null);
  if (v instanceof Date && !isNaN(v)) {
    const p = n => String(n).padStart(2, '0');
    return v.getFullYear() + '-' + p(v.getMonth() + 1) + '-' + p(v.getDate());
  }
  return null;
}

function pad(n) { return String(n).padStart(2, '0'); }

/** '2025-2026' for any date in that academic year (1 Sep – 31 Aug). */
function academicYearOf(dateYmd) {
  const d = ymd(dateYmd); if (!d) return null;
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  const start = m >= 9 ? y : y - 1;
  return start + '-' + (start + 1);
}

/** The short form a projector slide can read at the back of the room: '25/26'. */
function academicYearShort(ay) {
  if (!/^\d{4}-\d{4}$/.test(String(ay || ''))) return String(ay || '');
  return ay.slice(2, 4) + '/' + ay.slice(7, 9);
}

/** The term a date falls in: { key, academic_year, term, ord, label, start, end }. */
function termOf(dateYmd) {
  const d = ymd(dateYmd); if (!d) return null;
  const y = Number(d.slice(0, 4)), m = Number(d.slice(5, 7));
  const t = TERMS.find(x => (x.startMonth <= x.endMonth)
    ? (m >= x.startMonth && m <= x.endMonth)
    : (m >= x.startMonth || m <= x.endMonth));
  const ay = academicYearOf(d);
  const ayStart = Number(ay.slice(0, 4));
  // Autumn sits in the first calendar year of the academic year; Spring and
  // Summer in the second.
  const calYear = t.term === 'Autumn' ? ayStart : ayStart + 1;
  return {
    // The key must distinguish Spring from Summer. An earlier draft used
    // term.charAt(0) for both and silently collided: Spring's rows and
    // Summer's rows landed in one bucket, so every chart printed the pair
    // twice with identical values. Caught in the prod forecast, not by a test
    // — hence the term ordinal, which cannot collide.
    key: ay + '-T' + t.ord,                      // '2025-2026-T1'
    academic_year: ay,
    term: t.term,
    ord: t.ord,
    label: t.term + ' ' + calYear,               // 'Autumn 2025'
    short: t.term.slice(0, 3) + ' ' + String(calYear).slice(2),  // 'Aut 25'
    start: calYear + '-' + pad(t.startMonth) + '-' + pad(t.startDay),
    end:   calYear + '-' + pad(t.endMonth)   + '-' + pad(t.endDay),
  };
}

/** Every term between two dates, oldest first, inclusive of the terms the
 *  endpoints fall in. */
function termSpine(fromYmd, toYmd) {
  const a = ymd(fromYmd), b = ymd(toYmd);
  if (!a || !b || a > b) return [];
  const out = [];
  let cur = termOf(a);
  const last = termOf(b);
  let guard = 0;
  while (cur && guard++ < 200) {
    out.push(cur);
    if (cur.key === last.key) break;
    cur = termOf(nextDay(cur.end));
  }
  return out;
}

function nextDay(d) {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** The academic years covered by a window, oldest first. */
function academicYearSpine(fromYmd, toYmd) {
  const seen = [];
  for (const t of termSpine(fromYmd, toYmd)) {
    if (!seen.includes(t.academic_year)) seen.push(t.academic_year);
  }
  return seen;
}

/** The window for "N academic years back, up to today", clamped at the start of
 *  the oldest academic year so a year is never half-counted against a full one.
 *  years=1 means "this academic year only". */
function windowForYears(years, today) {
  const t = ymd(today) || todayYmd();
  const n = Math.max(1, Math.min(10, Number(years) || 1));
  const thisAy = academicYearOf(t);
  const startAy = Number(thisAy.slice(0, 4)) - (n - 1);
  return { from: startAy + '-09-01', to: t, years: n, academic_years: academicYearSpine(startAy + '-09-01', t) };
}

/** Age in whole months on a date — the EYFS convention (completed months). */
function ageMonthsOn(dobYmd, onYmd) {
  const dob = ymd(dobYmd), on = ymd(onYmd);
  if (!dob || !on || on < dob) return null;
  let months = (Number(on.slice(0, 4)) - Number(dob.slice(0, 4))) * 12
             + (Number(on.slice(5, 7)) - Number(dob.slice(5, 7)));
  if (Number(on.slice(8, 10)) < Number(dob.slice(8, 10))) months -= 1;
  return months < 0 ? null : months;
}

module.exports = {
  TERMS, isYmd, todayYmd, ymd, academicYearOf, academicYearShort,
  termOf, termSpine, academicYearSpine, windowForYears, ageMonthsOn,
};
