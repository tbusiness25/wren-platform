'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// two-year-check-draft-queue.js — b528 (2026-10-26)
//
// ONE JOB: start the draft for a two-year check that was requested before the
// child was old enough for it to be written, on the day it becomes writable.
//
// WHY THIS EXISTS AT ALL
//   Toby, 2026-10-26: "once their health visitor has given them an appointment
//   they press the button". That letter arrives weeks before the second
//   birthday, so b528 lets a parent press the button from 18 months
//   (REQUEST_MIN_MONTHS in src/lib/two-year-check.js). The statutory document is
//   still written between 24 and 36 months, so src/routes/two-year-check.js
//   PARKS those early requests: status stays 'requested', nothing is drafted,
//   and the room that writes it is told the check is coming rather than that it
//   "needs you". This sweep is the thing that then keeps the promise.
//
//   Without it, a parked request would wait for somebody to notice — which is
//   the exact failure b528 is fixing (checks happening nearer three than two).
//
// WHY IT IS NOT IN two-year-check-nudge.js
//   That service is a PARENT-facing nudge and it is switched OFF on prod
//   (TWO_YEAR_CHECK_NUDGE_DISABLED=true, verified in the wren-ladn container on
//   2026-10-26 — which is one of the reasons b243 has never been used). Hanging
//   the draft queue off its timer would mean that env var silently disables a
//   family's request as well as a nudge. Separate job, separate switch.
//
// WHAT IT WILL NEVER DO
//   It does not send anything to a parent, it does not create a request, and it
//   does not touch a check at any other status. It calls the ONE drafting
//   function (runDraft in src/routes/two-year-check.js), so the draft a swept
//   check gets is byte-for-byte the one it would have got if the parent had
//   pressed the button that morning — the review gate, the citation checks and
//   the send gate are all unchanged and still require a practitioner.
//
// KILL SWITCH  TWO_YEAR_CHECK_QUEUE_DISABLED=true|1
// TUNING       TWO_YEAR_CHECK_QUEUE_MIN (default 180 minutes),
//              TWO_YEAR_CHECK_QUEUE_START_DELAY_MS (default 120000),
//              TWO_YEAR_CHECK_QUEUE_MAX_PER_SWEEP (default 3 — the heavy local
//              model takes minutes per draft, so a sweep that found twelve
//              parked checks must not start twelve runs at once).
// ─────────────────────────────────────────────────────────────────────────────

const LOG = '[two-year-check-queue]';
const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

/**
 * One pass. Returns COUNTS ONLY: { parked, due, started }.
 *
 * `db` is a pg Pool. `runDraftFn(reportId)` defaults to the real drafter and is
 * injectable so a test never reaches a model or writes a draft.
 */
async function sweep(db, opts = {}) {
  const S = SCHEMA();
  const T = require('../lib/two-year-check');
  const runDraft = opts.runDraft || require('../routes/two-year-check').runDraft;
  const max = Math.max(1, Number(opts.max || process.env.TWO_YEAR_CHECK_QUEUE_MAX_PER_SWEEP || 3) | 0);
  const out = { parked: 0, due: 0, started: 0 };

  // Every parked request: a b528 check still at 'requested'. The age test is
  // done in JS by T.draftDueNow so there is exactly one definition of "can this
  // be written yet" — the one the request path itself used when it parked this
  // row. (The SQL only narrows to rows worth testing.)
  const { rows } = await db.query(`
    SELECT r.id, r.child_id, r.appointment_date, c.date_of_birth
      FROM ${S}.reports r
      JOIN ${S}.children c ON c.id = r.child_id
     WHERE r.report_type = 'two_year_check'
       AND r.status = 'requested'
       AND COALESCE(c.is_active, true) = true
     ORDER BY r.appointment_date NULLS LAST, r.requested_at
     LIMIT 200`);
  out.parked = rows.length;
  if (!rows.length) return out;

  for (const row of rows) {
    if (!T.draftDueNow(row.date_of_birth, row.appointment_date)) continue;
    out.due++;
    if (out.started >= max) continue;          // the rest come back next sweep
    try {
      // runDraft re-reads the row and refuses anything that is not still
      // 'requested', so a parent pressing the button at the same moment cannot
      // produce two drafts. It is also in-process and slow by design; awaiting
      // it here is what keeps `max` meaningful.
      await runDraft(row.id);
      out.started++;
    } catch (e) {
      console.error(`${LOG} draft failed for report #${row.id}:`, e.message);
    }
  }
  if (out.started) console.log(`${LOG} parked=${out.parked} due=${out.due} started=${out.started}`);
  return out;
}

let _timer = null, _started = false;
/** Start the in-process timer. Off with TWO_YEAR_CHECK_QUEUE_DISABLED=true|1. Never throws. */
function startTwoYearCheckQueue(opts = {}) {
  if (['true', '1'].includes(String(process.env.TWO_YEAR_CHECK_QUEUE_DISABLED || '').toLowerCase())) {
    console.log(`${LOG} not started — TWO_YEAR_CHECK_QUEUE_DISABLED`);
    return null;
  }
  if (_started) return true;
  _started = true;
  const { getPool } = require('../db/pool');
  const every = Math.max(5, Number(process.env.TWO_YEAR_CHECK_QUEUE_MIN || 180)) * 60 * 1000;
  const tick = () => sweep(getPool(), opts).catch(e => console.error(`${LOG} sweep failed:`, e.message));
  const delay = Number(process.env.TWO_YEAR_CHECK_QUEUE_START_DELAY_MS || 120000);
  setTimeout(() => {
    tick();
    _timer = setInterval(tick, every);
    if (_timer.unref) _timer.unref();
    console.log(`${LOG} started (every ${every / 60000} min)`);
  }, delay).unref();
  return true;
}
function stopTwoYearCheckQueue() { if (_timer) clearInterval(_timer); _timer = null; _started = false; }

module.exports = { sweep, startTwoYearCheckQueue, stopTwoYearCheckQueue };
