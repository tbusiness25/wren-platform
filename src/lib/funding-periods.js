// b298 (2026-09-10) — funding periods are not school terms.
//
// Two calendars have been conflated in this codebase and in the UI, and the
// conflation caused a real loss: on 2026-09-09 the planning half-terms were
// briefly rewritten to match funding period boundaries, which deleted the
// holidays staff use for evaluation and termly updates.
//
//   ladn.school_terms / ladn.school_breaks  TEACHING half-terms and the breaks
//       between them. Planning runs on these. Edited under Settings → Term dates.
//       (see src/lib/school-calendar.js)
//
//   ladn.funding_terms                      FUNDING periods — the free-entitlement
//       claim windows: Autumn 1 Sep–31 Dec, Spring 1 Jan–31 Mar, Summer 1 Apr–31 Aug.
//       Rates per band live on the same row. Edited under Settings → Funding dates.
//
// Funding runs continuously; teaching does not. Neither derives from the other.
//
// ── The historic rows ────────────────────────────────────────────────────────
// ladn.funding_terms also holds 17 rows imported from EyLog in b205 — "EyMan
// term 9" … "EyMan term 26" — with 1970-01-01 dates because EyLog's API gave no
// dates for them. They MUST NOT be deleted: hundreds of ladn.child_funding rows
// point at them and they are the setting's funding history. They must equally
// never be OFFERED as a choice: a period that ran in 1970 cannot be allocated
// to, planned against, or set current. This module is the one place that says
// which rows those are, so every screen and route agrees.

// A row is historic when EyLog gave it to us, or when it has no real dates.
// Any one of the three is enough — the import set all three, but a hand-made
// row with a 1970 date is just as unusable.
const HISTORIC_SQL = `(eylog_term_id IS NOT NULL
   OR source LIKE 'eylog-import%'
   OR start_date <= DATE '1970-12-31')`;

// The same test in JS, for a row already loaded. `start_date` may be a Date or
// a 'YYYY-MM-DD' string depending on the query, so compare on the year only.
function isHistoric(t) {
  if (!t) return false;
  if (t.eylog_term_id != null && String(t.eylog_term_id) !== '') return true;
  if (typeof t.source === 'string' && t.source.startsWith('eylog-import')) return true;
  const y = yearOf(t.start_date);
  return y != null && y <= 1970;
}

// The calendar year of a DATE column, whatever the driver handed back.
// pg returns DATE as a LOCAL-midnight JS Date, so toISOString() can roll the
// year back an hour before midnight on 1 January — read the local getters.
function yearOf(d) {
  if (d == null) return null;
  if (d instanceof Date) return d.getFullYear();
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(String(d));
  return m ? parseInt(m[1], 10) : null;
}

// Split a funding_terms list into the periods that can be used and the ones
// that can only be read. Preserves the order it was given.
function classify(rows) {
  const periods = [], historic = [];
  for (const r of rows || []) (isHistoric(r) ? historic : periods).push(r);
  return { periods, historic };
}

// Tag every row rather than dropping any, for callers that render both groups.
function tag(rows) {
  return (rows || []).map(r => Object.assign({}, r, { is_historic: isHistoric(r) }));
}

// The three periods of a funding year, as the council runs them. Used to offer
// sensible defaults on the Funding dates screen — never written automatically.
const PERIOD_SHAPES = [
  { key: 'autumn', label: 'Autumn', start: '09-01', end: '12-31', months: ['September', 'October', 'November', 'December'] },
  { key: 'spring', label: 'Spring', start: '01-01', end: '03-31', months: ['January', 'February', 'March'] },
  { key: 'summer', label: 'Summer', start: '04-01', end: '08-31', months: ['April', 'May', 'June', 'July', 'August'] },
];

module.exports = { HISTORIC_SQL, isHistoric, yearOf, classify, tag, PERIOD_SHAPES };
