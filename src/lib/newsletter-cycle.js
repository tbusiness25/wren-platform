'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b263 — which newsletter is due, resolved from ladn.school_terms.
//
// Toby asked for "termly, following Ealing term dates". Ealing publishes SIX
// half-terms, and Wren already runs two cycles on exactly that spine: termly
// updates (b246) and the deep-dive CPD themes (b262). Six newsletters a year at
// ~7-week intervals is still low effort, and it lets one newsletter carry the
// half-term theme the children are doing AND the topic the staff are learning
// about — a partnership story three-a-year cannot tell.
//
// So: default half_termly (6), switchable to termly (3) in a setting, and the
// cycle is READ FROM school_terms rather than computed from month numbers. When
// Ealing's calendar runs out (currently 27 July 2027) this says so loudly rather
// than going quiet — the same rule as b246. A cycle that silently stops is worse
// than one that never started, because nobody notices.
// ─────────────────────────────────────────────────────────────────────────────

const FREQUENCY_SETTING = 'newsletter_frequency';
const DEFAULT_FREQUENCY = 'half_termly';   // 6 a year
const FREQUENCIES = new Set(['half_termly', 'termly']);

// pg returns DATE as a local-midnight JS Date. Both String() and toISOString()
// are wrong here (the latter can roll back a day west of UTC) — use local getters.
function ymd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function prettyDate(d) {
  const s = ymd(d);
  if (!s) return '';
  const [y, m, day] = s.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', year: 'numeric' });
}

async function frequency(db) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [FREQUENCY_SETTING]);
    const v = (rows[0]?.value || '').trim();
    return FREQUENCIES.has(v) ? v : DEFAULT_FREQUENCY;
  } catch { return DEFAULT_FREQUENCY; }
}

/**
 * Resolve the newsletter cycle for a date (default today).
 *
 * Returns:
 *   { frequency, today, current, next, calendar, warning }
 * where `current` is the half-term (or term) the date falls in — or the one it
 * most recently fell in, if today is in a holiday — and `next` is the one after.
 *
 * `calendar.exhausted` is true when the date is past the last end_date we hold.
 * Callers MUST surface `warning` when set; that is the whole point of it.
 */
async function resolveCycle(db, opts = {}) {
  const today = opts.date ? ymd(opts.date) : ymd(new Date());
  const freq = opts.frequency && FREQUENCIES.has(opts.frequency)
    ? opts.frequency : await frequency(db);

  const { rows: terms } = await db.query(`
    SELECT id, academic_year, term, half, name, start_date, end_date, source
      FROM school_terms
     ORDER BY start_date
  `);

  if (!terms.length) {
    return {
      frequency: freq, today, current: null, next: null,
      calendar: { loaded: false, count: 0, first: null, last: null, exhausted: true },
      warning: 'No term dates are loaded. Add Ealing term dates before scheduling newsletters.',
    };
  }

  // In termly mode, collapse the two halves of each term into one period that
  // runs from the first half's start to the second half's end. The spine stays
  // school_terms either way — only the grouping changes — so switching the
  // setting cannot desynchronise the cycle from the actual calendar.
  let periods;
  if (freq === 'termly') {
    const byTerm = new Map();
    for (const t of terms) {
      const key = `${t.academic_year}|${t.term}`;
      const g = byTerm.get(key);
      if (!g) {
        byTerm.set(key, {
          ids: [t.id], academic_year: t.academic_year, term: t.term, half: null,
          name: `${t.term} Term`, start_date: t.start_date, end_date: t.end_date, source: t.source,
        });
      } else {
        g.ids.push(t.id);
        if (ymd(t.start_date) < ymd(g.start_date)) g.start_date = t.start_date;
        if (ymd(t.end_date)   > ymd(g.end_date))   g.end_date   = t.end_date;
      }
    }
    periods = [...byTerm.values()].sort((a, b) => ymd(a.start_date) < ymd(b.start_date) ? -1 : 1);
  } else {
    periods = terms.map(t => ({
      ids: [t.id], academic_year: t.academic_year, term: t.term, half: t.half,
      name: t.name || `${t.term} ${t.half}`,
      start_date: t.start_date, end_date: t.end_date, source: t.source,
    }));
  }

  const shape = p => p && {
    school_term_ids: p.ids,
    academic_year: p.academic_year,
    term: p.term,
    half: p.half,
    name: p.name,
    start_date: ymd(p.start_date),
    end_date: ymd(p.end_date),
    start_pretty: prettyDate(p.start_date),
    end_pretty: prettyDate(p.end_date),
    source: p.source || null,
  };

  const first = periods[0];
  const last  = periods[periods.length - 1];
  const exhausted = today > ymd(last.end_date);

  // Inside a period → that one. In a holiday → the period just ended (its
  // newsletter is the one that is due), with `in_holiday` so the UI can say so.
  //
  // And before the calendar has started at all — the case that broke the first
  // run of this, on 1 September with Autumn 1 starting on the 2nd — the period
  // that is DUE is the one about to begin. That is precisely when the welcome-
  // back newsletter gets written, so resolving to null there would switch the
  // feature off on the one day it is most wanted. Flagged `upcoming` so the UI
  // can say "for the half-term starting Wednesday" rather than implying it has
  // already begun.
  let idx = periods.findIndex(p => today >= ymd(p.start_date) && today <= ymd(p.end_date));
  let inHoliday = false;
  let upcoming = false;
  if (idx === -1) {
    inHoliday = true;
    for (let i = periods.length - 1; i >= 0; i--) {
      if (ymd(periods[i].end_date) < today) { idx = i; break; }
    }
    if (idx === -1) { idx = 0; upcoming = true; }   // before the whole calendar
  }

  const current = idx >= 0
    ? { ...shape(periods[idx]), in_holiday: inHoliday, upcoming }
    : null;
  const next = idx >= 0 && idx + 1 < periods.length ? shape(periods[idx + 1]) : null;

  let warning = null;
  if (exhausted) {
    warning = `Term dates run out on ${prettyDate(last.end_date)}. `
            + `Load the next academic year's Ealing dates or the newsletter cycle stops here.`;
  } else if (!next) {
    warning = `${current ? current.name : 'This period'} is the last one we hold — `
            + `term dates end ${prettyDate(last.end_date)}. Load the next academic year soon.`;
  }

  return {
    frequency: freq,
    per_year: freq === 'termly' ? 3 : 6,
    today,
    current,
    next,
    calendar: {
      loaded: true,
      count: periods.length,
      first: ymd(first.start_date),
      last: ymd(last.end_date),
      last_pretty: prettyDate(last.end_date),
      exhausted,
      source: first.source || null,
    },
    warning,
  };
}

module.exports = {
  FREQUENCY_SETTING, DEFAULT_FREQUENCY, FREQUENCIES,
  frequency, resolveCycle, ymd, prettyDate,
};
