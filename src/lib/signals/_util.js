'use strict';
/**
 * b311 — date and wording helpers shared by every signal.
 *
 * Dates are the whole substance of this build ("the run is in three days"), so
 * they get their own file rather than being re-derived nine times.
 *
 * The one trap worth naming: node-postgres hands a DATE column back as a JS
 * Date at LOCAL midnight. String() and toISOString() both give the wrong day on
 * a BST host — toISOString() shifts back an hour into the previous date, and
 * String() gives an RFC form nobody can compare. ymd() reads the local getters,
 * which is the only correct answer for a column that has no time in it at all.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];

/** 'YYYY-MM-DD' from a JS Date using LOCAL components. Never toISOString(). */
function ymd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today in Europe/London as 'YYYY-MM-DD', regardless of the host's timezone. */
function londonToday(now) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now || new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** 'HH:MM' in Europe/London. */
function londonHM(now) {
  return new Date(now || Date.now()).toLocaleTimeString('en-GB', {
    timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** 0=Sun … 6=Sat, in Europe/London, for a 'YYYY-MM-DD'. */
function dow(dateStr) {
  return new Date(dateStr + 'T00:00:00').getDay();
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return ymd(d);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}

function parts(dateStr) {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

/** Last day of month m (1-12) in year y. */
function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

/** 'YYYY-MM-DD' for day `day` of month m/y, clamped to the month's length. */
function dayOfMonth(y, m, day) {
  const clamped = Math.min(Math.max(1, day), daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(clamped).padStart(2, '0')}`;
}

function monthLabel(y, m) { return `${MONTHS[m - 1]} ${y}`; }

function nextMonth(y, m) { return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 }; }

/** 1 → '1st', 22 → '22nd'. Used for "the run is on the 25th". */
function ordinal(n) {
  const v = Number(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const k = v % 100;
  return v + (s[(k - 20) % 10] || s[k] || s[0]);
}

function plural(n, one, many) {
  return Number(n) === 1 ? one : (many || one + 's');
}

/** "in 3 days" / "today" / "3 days ago" — the phrase every signal needs. */
function inDays(n) {
  const v = Number(n);
  if (v === 0) return 'today';
  if (v === 1) return 'tomorrow';
  if (v === -1) return 'yesterday';
  if (v > 0) return `in ${v} days`;
  return `${Math.abs(v)} days ago`;
}

/** '12 September 2026' from 'YYYY-MM-DD'. */
function longDate(dateStr) {
  const p = parts(dateStr);
  if (!p.y) return String(dateStr || '');
  return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`;
}

/**
 * A stable fingerprint over the material facts. Object key order is normalised
 * so two evaluations that saw the same thing always agree, whatever order the
 * signal happened to build its object in.
 */
function fingerprint(obj) {
  const norm = (v) => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.keys(v).sort().reduce((a, k) => (a[k] = norm(v[k]), a), {});
    }
    return v;
  };
  return JSON.stringify(norm(obj));
}

module.exports = {
  MONTHS, ymd, londonToday, londonHM, dow, addDays, daysBetween, parts,
  daysInMonth, dayOfMonth, monthLabel, nextMonth, ordinal, plural, inDays,
  longDate, fingerprint,
};
