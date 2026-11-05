// b217 (2026-08-24) — the school term calendar.
//
// Planning at LADN follows the local (Ealing) school rhythm: Autumn 1, half
// term, Autumn 2, Christmas break, and so on. Three things are kept apart on
// purpose, because conflating them is what this build exists to fix:
//
//   ladn.school_terms   TEACHING half-terms. Planning runs on these.
//   ladn.school_breaks  NON-teaching periods — half-term breaks, holidays,
//                       bank holidays, INSET and occasional days.
//   ladn.funding_terms  FUNDING periods (1 Sep–31 Dec, 1 Jan–31 Mar,
//                       1 Apr–31 Aug). A funding period is NOT a school term
//                       and must never be used as one.
//
// Everything here speaks plain 'YYYY-MM-DD' strings — the queries cast dates
// with to_char so nothing depends on how the driver happens to parse a DATE,
// and string comparison on that format is the same as date comparison.

const MAX_PLAN_WEEKS = 12;   // ladn.termly_plan_weeks CHECK (week_no BETWEEN 1 AND 12)

const TERM_ORDER = { Autumn: 1, Spring: 2, Summer: 3 };
const BREAK_KINDS = ['half_term', 'holiday', 'bank_holiday', 'inset', 'occasional', 'closure'];

// ── date helpers (UTC arithmetic, London calendar day) ───────────────────────
function todayYmd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
}
function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function cleanYmd(s, fallback) {
  return isYmd(s) ? s : (fallback === undefined ? null : fallback);
}
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function mondayOf(ymd) {
  const dow = new Date(ymd + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}
// 'Wed 2 Sep 2026' — how a term date reads on a nursery wall planner.
const WD  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function parts(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  return { wd: WD[d.getUTCDay()], day: d.getUTCDate(), mon: MON[d.getUTCMonth()], yr: d.getUTCFullYear() };
}
function fmtLong(ymd) {
  if (!isYmd(ymd)) return '';
  const p = parts(ymd);
  return p.wd + ' ' + p.day + ' ' + p.mon + ' ' + p.yr;
}
function fmtShort(ymd) {
  if (!isYmd(ymd)) return '';
  const p = parts(ymd);
  return p.wd + ' ' + p.day + ' ' + p.mon;
}
// 'Mon 26 – Fri 30 Oct 2026' — the month is only said twice when it changes.
function fmtRange(a, b) {
  if (!isYmd(a) || !isYmd(b)) return '';
  if (a === b) return fmtLong(a);
  const x = parts(a), y = parts(b);
  const left = x.wd + ' ' + x.day + (x.mon === y.mon && x.yr === y.yr ? '' : ' ' + x.mon) +
               (x.yr === y.yr ? '' : ' ' + x.yr);
  return left + ' – ' + fmtLong(b);
}

// The academic year a date belongs to, on the 1 September boundary — the same
// boundary the schools use, and NOT the funding year.
function academicYearOf(ymd) {
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(5, 7), 10);
  const start = m >= 9 ? y : y - 1;
  return start + '-' + (start + 1);
}

// ── loaders ──────────────────────────────────────────────────────────────────
const TERM_COLS = `id, academic_year, term, half, name,
  to_char(start_date,'YYYY-MM-DD') AS start_date,
  to_char(end_date,'YYYY-MM-DD')   AS end_date,
  source, notes`;
const BREAK_COLS = `id, academic_year, name, kind,
  to_char(start_date,'YYYY-MM-DD') AS start_date,
  to_char(end_date,'YYYY-MM-DD')   AS end_date,
  source, notes`;

async function loadHalfTerms(db, academicYear) {
  const { rows } = academicYear
    ? await db.query(`SELECT ${TERM_COLS} FROM school_terms WHERE academic_year = $1
                       ORDER BY start_date`, [academicYear])
    : await db.query(`SELECT ${TERM_COLS} FROM school_terms ORDER BY start_date`);
  return rows;
}
async function loadBreaks(db, academicYear) {
  const { rows } = academicYear
    ? await db.query(`SELECT ${BREAK_COLS} FROM school_breaks WHERE academic_year = $1
                       ORDER BY start_date`, [academicYear])
    : await db.query(`SELECT ${BREAK_COLS} FROM school_breaks ORDER BY start_date`);
  return rows;
}
async function loadHalfTermById(db, id) {
  const n = parseInt(id, 10);
  if (!Number.isInteger(n)) return null;
  const { rows } = await db.query(`SELECT ${TERM_COLS} FROM school_terms WHERE id = $1 LIMIT 1`, [n]);
  return rows[0] || null;
}
// Terms + breaks for the whole calendar, so a lookup never misses a break that
// belongs to the neighbouring academic year (Christmas spans both).
async function loadCalendar(db, academicYear) {
  const [terms, breaks] = await Promise.all([
    loadHalfTerms(db, academicYear),
    loadBreaks(db, null),          // breaks are cheap and cross year boundaries
  ]);
  return { terms, breaks };
}

// ── the rules ────────────────────────────────────────────────────────────────
const covers = (row, ymd) => row.start_date <= ymd && row.end_date >= ymd;
const overlaps = (row, a, b) => row.start_date <= b && row.end_date >= a;

function halfTermFor(terms, ymd) { return terms.find(t => covers(t, ymd)) || null; }
function breakFor(breaks, ymd)   { return breaks.find(b => covers(b, ymd)) || null; }
function previousHalfTerm(terms, ymd) {
  const before = terms.filter(t => t.end_date < ymd);
  return before.length ? before[before.length - 1] : null;
}
function nextHalfTerm(terms, ymd) {
  return terms.find(t => t.start_date > ymd) || null;
}

// The planning weeks of one half-term: every Mon–Fri week that overlaps it,
// numbered from 1. A week is DROPPED only when the whole Mon–Fri sits inside a
// break — a single closure day (May Day inside Summer 1) leaves the week
// plannable and is reported as a closure instead.
function halfTermWeeks(halfTerm, breaks) {
  const out = [];
  if (!halfTerm || !isYmd(halfTerm.start_date) || !isYmd(halfTerm.end_date)) return out;
  let wc = mondayOf(halfTerm.start_date);
  let n = 0;
  while (wc <= halfTerm.end_date && out.length < MAX_PLAN_WEEKS) {
    const friday = addDays(wc, 4);
    const first = wc > halfTerm.start_date ? wc : halfTerm.start_date;
    const last  = friday < halfTerm.end_date ? friday : halfTerm.end_date;
    const hits  = breaks.filter(b => overlaps(b, first, last));
    const closed = hits.some(b => b.start_date <= first && b.end_date >= last);
    if (!closed) {
      out.push({
        week_no: ++n,
        week_commencing: wc,
        first_day: first,
        last_day: last,
        partial: first !== wc || last !== friday,
        closures: hits.map(b => ({
          id: b.id, name: b.name, kind: b.kind,
          start_date: b.start_date, end_date: b.end_date,
        })),
      });
    }
    wc = addDays(wc, 7);
  }
  return out;
}

// What is true of one calendar DAY.
//   teaching     inside a half-term, not inside a break
//   break        inside a break (half term, holiday, bank holiday, INSET…)
//   outside      the calendar has this year, but nothing covers the date
//   no_calendar  no half-terms seeded for this academic year at all
function resolveDay(ymd, terms, breaks) {
  const brk = breakFor(breaks, ymd);
  const ht  = halfTermFor(terms, ymd);
  let status;
  if (brk) status = 'break';
  else if (ht) status = 'teaching';
  else status = terms.length ? 'outside' : 'no_calendar';
  return {
    date: ymd,
    status,
    half_term: ht,
    break: brk,
    previous_half_term: previousHalfTerm(terms, ymd),
    next_half_term: nextHalfTerm(terms, ymd),
  };
}

// What is true of one WEEK — this is the level planning actually works at.
// plannable === false means "this week carries no planning": every one of its
// Mon–Fri days is a break, or it belongs to no half-term at all.
function resolveWeek(anyDateInWeek, terms, breaks) {
  const wc = mondayOf(anyDateInWeek);
  const friday = addDays(wc, 4);
  const ht = terms.find(t => overlaps(t, wc, friday)) || null;
  const hits = breaks.filter(b => overlaps(b, wc, friday));
  const wholeWeekBreak = hits.find(b => b.start_date <= wc && b.end_date >= friday) || null;

  let status, plannable, message;
  if (!terms.length) {
    status = 'no_calendar'; plannable = true;
    message = 'No school term calendar for ' + academicYearOf(wc) + ' yet — add the term dates so planning can follow them.';
  } else if (wholeWeekBreak) {
    status = 'break'; plannable = false;
    message = wholeWeekBreak.name + ' (' + fmtRange(wholeWeekBreak.start_date, wholeWeekBreak.end_date) +
              ') — no planning this week. Evaluation and preparation only.';
  } else if (!ht) {
    status = 'outside'; plannable = true;
    const nxt = nextHalfTerm(terms, friday);
    message = 'Outside the school term calendar' +
              (nxt ? ' — ' + nxt.name + ' starts ' + fmtLong(nxt.start_date) + '.' : '.');
  } else {
    status = 'teaching'; plannable = true;
    const weeks = halfTermWeeks(ht, breaks);
    const me = weeks.find(w => w.week_commencing === wc);
    message = (me ? 'Week ' + me.week_no + ' of ' + weeks.length + ' · ' : '') +
              ht.name + ' (' + fmtRange(ht.start_date, ht.end_date) + ')' +
              (me && me.partial ? ' · part week' : '') +
              (hits.length ? ' · closed ' + hits.map(b => b.name).join(', ') : '');
    return {
      week_commencing: wc, week_ending: friday, academic_year: academicYearOf(wc),
      status, plannable, message, half_term: ht,
      week_no: me ? me.week_no : null,
      total_weeks: weeks.length,
      partial: me ? me.partial : false,
      closures: hits,
      break: null,
    };
  }
  return {
    week_commencing: wc, week_ending: friday, academic_year: academicYearOf(wc),
    status, plannable, message, half_term: ht,
    week_no: null, total_weeks: ht ? halfTermWeeks(ht, breaks).length : null,
    partial: false, closures: hits, break: wholeWeekBreak,
  };
}


/* ── b299: generate an academic year ─────────────────────────────────────────
 *
 * Lifted out of scripts/generate-school-calendar.js so it stops being a thing
 * only a host script can do. Other editions have to set their own term dates the
 * way EyLog and Nursery in a Box let them, and on a fresh tenant "set your own"
 * meant hand-typing six half-terms and six breaks before the page showed
 * anything at all.
 *
 * The rhythm is the English state-school one: a six-half-term year with the
 * October, February and Whitsun half terms between them, Christmas and Easter
 * holidays, and the summer break. Easter moves, which is why it is computed
 * rather than assumed — and why every year this produces is PROVISIONAL until
 * somebody checks it against what their own local authority published.
 */

const ymdOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
                   + `-${String(d.getUTCDate()).padStart(2, '0')}`;
const mkUtc = (y, m, d) => new Date(Date.UTC(y, m - 1, d));
const addD = (d, n) => new Date(d.getTime() + n * 86400000);
/** Move to weekday wd (1=Mon..7=Sun) on or after d. */
const onOrAfter = (d, wd) => {
  const x = new Date(d);
  while (((x.getUTCDay() + 6) % 7) + 1 !== wd) x.setUTCDate(x.getUTCDate() + 1);
  return x;
};
const onOrBefore = (d, wd) => {
  const x = new Date(d);
  while (((x.getUTCDay() + 6) % 7) + 1 !== wd) x.setUTCDate(x.getUTCDate() - 1);
  return x;
};

/** Anonymous Gregorian computus — Easter Sunday. Easter is why these dates move. */
function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4,
        f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
        i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
        m = Math.floor((a + 11 * h + 22 * l) / 451),
        mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
  return mkUtc(y, mo, da);
}

/**
 * The six half-terms and six breaks of the academic year beginning September `y`.
 * Dates are ISO strings; nothing is written anywhere.
 *
 * @param {number} y  the September year — 2026 gives "2026-2027"
 */
function generateAcademicYear(y) {
  const autumnStart  = onOrAfter(mkUtc(y, 9, 1), 3);
  const octBreak     = onOrAfter(mkUtc(y, 10, 25), 1);
  const autumn1End   = onOrBefore(addD(octBreak, -1), 5);
  const autumn2Start = addD(octBreak, 7);
  const autumn2End   = onOrBefore(mkUtc(y, 12, 20), 5);
  const xmasStart    = addD(autumn2End, 1);
  const spring1Start = onOrAfter(mkUtc(y + 1, 1, 3), 1);
  const xmasEnd      = addD(spring1Start, -1);
  const febBreak     = onOrAfter(mkUtc(y + 1, 2, 14), 1);
  const spring1End   = onOrBefore(addD(febBreak, -1), 5);
  const spring2Start = addD(febBreak, 7);
  const E            = easterSunday(y + 1);
  const easterStart  = onOrBefore(addD(E, -14), 1);
  const spring2End   = onOrBefore(addD(easterStart, -1), 5);
  const summer1Start = onOrAfter(addD(E, 1), 1);
  const easterEnd    = addD(summer1Start, -1);
  const whitBreak    = onOrAfter(mkUtc(y + 1, 5, 25), 1);
  const summer1End   = onOrBefore(addD(whitBreak, -1), 5);
  const summer2Start = addD(whitBreak, 7);
  const summer2End   = onOrBefore(mkUtc(y + 1, 7, 24), 5);
  const summerStart  = addD(summer2End, 1);
  const yy = n => String(n % 100).padStart(2, '0');
  const tag = `${yy(y)}/${yy(y + 1)}`;

  return {
    academic_year: `${y}-${y + 1}`,
    terms: [
      { term: 'Autumn', half: 1, name: `Autumn 1 ${tag}`, start_date: ymdOf(autumnStart),  end_date: ymdOf(autumn1End) },
      { term: 'Autumn', half: 2, name: `Autumn 2 ${tag}`, start_date: ymdOf(autumn2Start), end_date: ymdOf(autumn2End) },
      { term: 'Spring', half: 1, name: `Spring 1 ${tag}`, start_date: ymdOf(spring1Start), end_date: ymdOf(spring1End) },
      { term: 'Spring', half: 2, name: `Spring 2 ${tag}`, start_date: ymdOf(spring2Start), end_date: ymdOf(spring2End) },
      { term: 'Summer', half: 1, name: `Summer 1 ${tag}`, start_date: ymdOf(summer1Start), end_date: ymdOf(summer1End) },
      { term: 'Summer', half: 2, name: `Summer 2 ${tag}`, start_date: ymdOf(summer2Start), end_date: ymdOf(summer2End) },
    ],
    breaks: [
      { name: 'October half term',  kind: 'half_term', start_date: ymdOf(octBreak),    end_date: ymdOf(addD(octBreak, 4)) },
      { name: 'Christmas holiday',  kind: 'holiday',   start_date: ymdOf(xmasStart),   end_date: ymdOf(xmasEnd) },
      { name: 'February half term', kind: 'half_term', start_date: ymdOf(febBreak),    end_date: ymdOf(addD(febBreak, 4)) },
      { name: 'Easter holiday',     kind: 'holiday',   start_date: ymdOf(easterStart), end_date: ymdOf(easterEnd) },
      { name: 'Whitsun half term',  kind: 'half_term', start_date: ymdOf(whitBreak),   end_date: ymdOf(addD(whitBreak, 4)) },
      // Children leave, new starters arrive, nothing is planned against it.
      { name: 'Summer holiday',     kind: 'holiday',   start_date: ymdOf(summerStart), end_date: ymdOf(mkUtc(y + 1, 8, 31)) },
    ],
  };
}

module.exports = {
  MAX_PLAN_WEEKS, TERM_ORDER, BREAK_KINDS,
  generateAcademicYear, easterSunday,
  todayYmd, isYmd, cleanYmd, addDays, mondayOf, fmtLong, fmtShort, fmtRange, academicYearOf,
  loadHalfTerms, loadBreaks, loadHalfTermById, loadCalendar,
  halfTermFor, breakFor, previousHalfTerm, nextHalfTerm, halfTermWeeks,
  resolveDay, resolveWeek,
};
