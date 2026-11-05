'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b341 — notice to leave: the date rules, and the words the screen shows.
//
// PURE. No database, no network, no clock except londonToday() and only when it is
// called without an argument. That is what lets scripts/b341-verify.js prove the date
// table without a server.
//
// THE RULE (LADN Terms & Conditions, TERMINATION OF CONTRACT — quoted, not paraphrased):
//   "If you no longer wish to maintain your child's place at the nursery you will be
//    required to give six full weeks' notice in writing or by email to the nursery
//    manager (notice given Monday to Friday will start on the Monday of the following
//    week)."
//
// WORKED FROM THAT SENTENCE
//   Mon–Fri     notice starts on the Monday of the FOLLOWING week.
//   Sat / Sun   the sentence says nothing. The nursery is closed, so the notice is
//               treated as received on the next working day (Monday) and is then a
//               Mon–Fri notice: it starts the Monday AFTER that. A Saturday notice
//               therefore starts the Monday after next. This is an interpretation, not
//               a quotation — it is stated on the screen and in the notice record so
//               nobody has to guess which was meant.
//   Six full weeks run from the notice start. The last nursery day of the sixth week is
//   a Friday; the Sunday after it closes the period.
//
// All date arithmetic here is on calendar dates held as 'YYYY-MM-DD' strings, done in UTC
// milliseconds. No local-time getter, no toISOString on a local date, so the pg DATE
// trap (memory/reference_pg_date_ymd_trap.md) and DST cannot move a day.
// ─────────────────────────────────────────────────────────────────────────────

const NOTICE_WEEKS = 6;
const DAY = 86400000;
const DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];

// Used only when the live terms row cannot be read or does not contain the clause.
const TERMS_CLAUSE_FALLBACK =
  "If you no longer wish to maintain your child's place at the nursery you will be required to give six full "
  + "weeks' notice in writing or by email to the nursery manager (notice given Monday to Friday will start on "
  + 'the Monday of the following week).';

const REASONS = [
  { code: 'moving_away',      label: 'Moving away' },
  { code: 'starting_school',  label: 'Starting school' },
  { code: 'changing_setting', label: 'Changing setting' },
  { code: 'cost',             label: 'Cost' },
  { code: 'could_do_better',  label: 'Something we could have done better' },
  { code: 'prefer_not_to_say', label: 'Prefer not to say' },
];
const REASON_CODES = new Set(REASONS.map(r => r.code));

function isYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const ms = Date.parse(s + 'T00:00:00Z');
  return !isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === s;   // rejects 2026-02-31
}
function toMs(ymd) { return Date.parse(ymd + 'T00:00:00Z'); }
function fromMs(ms) { return new Date(ms).toISOString().slice(0, 10); }   // ms is a UTC-midnight, so this is exact
function addDays(ymd, n) { return fromMs(toMs(ymd) + n * DAY); }
function weekday(ymd) { return new Date(toMs(ymd)).getUTCDay(); }           // 0 = Sunday … 6 = Saturday

// Today's calendar date in London, whatever timezone the server runs in.
function londonToday(now) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now || new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// "Friday 6 November 2026"
function longDate(ymd) {
  if (!isYmd(ymd)) return String(ymd || '');
  const ms = toMs(ymd), d = new Date(ms);
  return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The notice arithmetic for a notice given on `givenOn` (a London calendar date).
 * @returns {{given_on, given_weekday, weekend, received_on, notice_start, notice_end, earliest_last_day}}
 */
function computeNotice(givenOn) {
  if (!isYmd(givenOn)) throw new Error('computeNotice: givenOn must be YYYY-MM-DD');
  const dow = weekday(givenOn);
  const weekend = dow === 0 || dow === 6;
  // Weekend → deemed received on the next working day (Monday).
  const receivedOn = weekend ? addDays(givenOn, dow === 6 ? 2 : 1) : givenOn;
  const rdow = weekday(receivedOn);                    // 1..5
  // The terms say notice given Monday to Friday starts on the Monday of the
  // following week. A weekend notice is received on the Monday we are back, and
  // 2026-09-21 Toby settled what that means: "week one would be the first Monday
  // back after the weekend — it's a bit unfair to push it an extra week". So a
  // weekend notice starts THAT Monday; a weekday notice still starts the next one.
  const noticeStart = weekend ? receivedOn : addDays(receivedOn, 8 - rdow);
  const noticeEnd = addDays(noticeStart, NOTICE_WEEKS * 7 - 1);     // the Sunday closing week six
  const earliestLastDay = addDays(noticeEnd, -2);                   // the Friday — the last nursery day
  return {
    given_on: givenOn, given_weekday: DOW[dow], weekend,
    received_on: receivedOn, notice_start: noticeStart,
    notice_end: noticeEnd, earliest_last_day: earliestLastDay,
  };
}

/**
 * Everything the screen shows and the record stores, for one (given date, chosen last day).
 * `chosen` may be earlier than, equal to, or later than the earliest last day: an earlier date
 * is allowed (fees still run to the end of the notice), and a later date is simply theirs.
 */
function buildPreview(givenOn, chosenLastDay, childFirstName, prior) {
  // `prior` = a notice already standing for this child ({notice_start, earliest_last_day, given_on}).
  // Moving the last day later or earlier is a CHANGE to that notice, not a new one: the six weeks keep
  // running from the original start, so the notice dates are inherited rather than recomputed.
  const n = prior
    ? { given_on: givenOn, given_weekday: DOW[weekday(givenOn)], weekend: false, received_on: givenOn,
        notice_start: prior.notice_start, notice_end: addDays(prior.earliest_last_day, 2), earliest_last_day: prior.earliest_last_day }
    : computeNotice(givenOn);
  const chosen = isYmd(chosenLastDay) ? chosenLastDay : n.earliest_last_day;
  const short = chosen < n.earliest_last_day;
  const feesRunTo = short ? n.earliest_last_day : chosen;
  const who = childFirstName ? String(childFirstName) : 'your child';

  const startLine = prior
    ? `You gave notice on ${longDate(prior.given_on)} and it started on ${longDate(n.notice_start)}. Changing the last day does not restart it.`
    : n.weekend
      ? `You are giving notice on a ${n.given_weekday}. The nursery is closed at the weekend, so it counts as received on `
        + `${longDate(n.received_on)}, and your notice starts on ${longDate(n.notice_start)}.`
      : `Your notice starts on ${longDate(n.notice_start)} — the Monday of the following week.`;
  const endLine = `Six full weeks from ${prior ? 'the start' : 'then'} takes it to the end of ${longDate(n.earliest_last_day)}, which is the earliest last day.`;

  let feeLine;
  if (short) {
    feeLine = `You have chosen ${longDate(chosen)} as ${who}'s last day, which is before the end of your notice. `
      + `Fees still run to the end of the notice period — ${longDate(feesRunTo)} — even if ${who} does not attend after ${longDate(chosen)}.`;
  } else if (chosen === n.earliest_last_day) {
    feeLine = `Fees run to the end of the notice period — ${longDate(feesRunTo)}.`;
  } else {
    feeLine = `${longDate(chosen)} is later than the end of the notice period, so it is ${who}'s last day and fees run to ${longDate(feesRunTo)}.`;
  }

  return Object.assign({}, n, {
    chosen_last_day: chosen, fees_run_to: feesRunTo, short_notice: short, is_revision: !!prior,
    start_text: startLine, end_text: endLine, fee_text: feeLine,
    screen_text: `${startLine} ${endLine} ${feeLine}`,
  });
}

// Pull the notice sentence out of the live terms text so the screen quotes what parents were
// actually given, not a copy that has drifted. Whitespace-normalised; null when not found.
function extractClause(content) {
  const m = /If you no longer wish to maintain[\s\S]*?following\s+week\)\./.exec(String(content || ''));
  return m ? m[0].replace(/\s+/g, ' ').trim() : null;
}

module.exports = {
  NOTICE_WEEKS, REASONS, REASON_CODES, TERMS_CLAUSE_FALLBACK,
  isYmd, addDays, weekday, londonToday, longDate,
  computeNotice, buildPreview, extractClause,
};
