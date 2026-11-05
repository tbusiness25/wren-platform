'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// two-year-check-nudge.js — b405 (2026-10-06)
//
// A PARENT-FACING nudge, not the staff EYFS statutory report workflow in
// src/routes/two-year-check.js (same category name, completely different job —
// see that file's own notify() call around line 483 for the staff-side precedent
// this one follows). This file's whole job: notice a child has turned two, and
// tell their parents ONCE — in-app only, never email — to (a) book the health
// visitor's 2-year development check and (b) let the nursery know the date.
//
// WHY "IN-APP ONLY" NEEDS NO EXTRA CODE HERE
//   The category 'two_year_check' is already named, explicitly, on both email
//   blocklists: EMAIL_BLOCKED_CATEGORIES in notification-dispatcher.js (the
//   staff channel) and PARENT_EMAIL_BLOCKED_CATEGORIES in parent-notify.js (the
//   parent channel). It is also simply absent from parent-notification-prefs.js's
//   CATEGORIES list, so PREF_FOR_DISPATCH['two_year_check'] is undefined and
//   fanOutToParents() returns at its very first line — no push either. Using
//   this exact category name is what makes "never email" true by construction;
//   do not rename it.
//
// WHY "JUST PASSED, OR PASSED WHILE THE SERVER WAS DOWN"
//   The dedup check is against the notifications table itself (category=
//   'two_year_check' AND recipient_type='parent' AND recipient_id=<child>), not
//   a "ran today" flag. So a restarted server re-asks the same question — "is
//   there an eligible, not-yet-notified child?" — and never misses one, and
//   never repeats one. No separate counter column needed.
//
// WHO IS NOTIFIED
//   Only children who (a) are active, (b) have turned two (date_of_birth + 24
//   months has passed — the same AGE_MIN_MONTHS boundary as src/lib/two-year-
//   check.js's eligibility(), and still under the max-age guard above), and
//   (c) have at least one active parent portal
//   login to receive it — the same "a child nobody can sign in for is the
//   office's business" scoping parent-forms-nudge.js uses for its own sweep.
//
// LAUNCH GUARDS (added in the release port, 2026-10-17 — NOT in the dev build)
//   Dev's first sweep notified EVERY active child over 24 months, i.e. the parents of
//   every 3- and 4-year-old in Pre-school would have been told "Time for X's 2-year
//   check" the first time the timer ran on prod. Two guards stop that:
//     1. AGE WINDOW   only children aged 24 months up to TWO_YEAR_CHECK_NUDGE_MAX_MONTHS
//        (default 30 — DUE_MONTHS in src/lib/two-year-check.js, the age the check is
//        expected by). Older children are not nudged and never will be.
//     2. ALREADY DONE a child with a sent / completed two-year-check report is skipped.
//     (and test children — children.is_demo — are never nudged.)
//   A child who turns two while the server is down, or who joined between 24 and 30
//   months, is still caught (dedup is against the notifications table, see above).
//
// KILL SWITCH   TWO_YEAR_CHECK_NUDGE_DISABLED=true|1   stops the timer (the
//               sweep can still be run by hand via sweep(getPool())).
// TUNING        TWO_YEAR_CHECK_SWEEP_MIN (default 60), start delay
//               TWO_YEAR_CHECK_SWEEP_START_DELAY_MS (default 90000).
// ─────────────────────────────────────────────────────────────────────────────

const LOG = '[two-year-check-nudge]';
const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

/**
 * One pass. `db` is a pg Pool; `notifyFn(category, recipientType, recipientId, title, body, options)`
 * raises the bell row (and, through the dispatcher, the parent fan-out — which for this category is
 * a no-op by construction, see header). Defaults to the dispatcher's AWAITABLE core (notifyAsync) so
 * the notification row is guaranteed written before this sweep returns — the next sweep's dedup check
 * (and a test calling sweep() twice in a row) must see it, not race it. Injectable for tests so a run
 * never reaches a real transport or another database.
 * Returns COUNTS ONLY: { candidates, notified }.
 */
async function sweep(db, opts = {}) {
  const S = SCHEMA();
  const notifyFn = opts.notifyFn || require('./notification-dispatcher').notifyAsync;
  const out = { candidates: 0, notified: 0 };
  // Age ceiling in whole months (launch guard 1). Clamped to the check's own 24..36 window.
  const maxMonths = Math.min(36, Math.max(25, Number(opts.maxMonths || process.env.TWO_YEAR_CHECK_NUDGE_MAX_MONTHS || 30) | 0));

  // Active children who have turned two (dob + 24 months has passed — AGE_MIN_MONTHS in
  // src/lib/two-year-check.js), who have somebody who could read a bell notification for
  // them (an active parent portal login), and who do not already have this notification.
  const { rows } = await db.query(
    `SELECT DISTINCT c.id, COALESCE(c.preferred_name, c.first_name) AS first_name
       FROM ${S}.children c
       JOIN ${S}.parent_portal_access pa ON pa.child_id = c.id AND pa.is_active = true
      WHERE COALESCE(c.is_active, true) = true
        AND COALESCE(c.is_demo, false) = false
        AND c.date_of_birth IS NOT NULL
        AND c.date_of_birth + INTERVAL '24 months' <= now()
        AND c.date_of_birth + make_interval(months => $1::int) > now()
        AND NOT EXISTS (
          SELECT 1 FROM ${S}.notifications n
           WHERE n.category = 'two_year_check' AND n.recipient_type = 'parent' AND n.recipient_id = c.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM ${S}.reports r
           WHERE r.report_type = 'two_year_check' AND r.child_id = c.id
             AND (r.status IN ('sent','completed') OR r.sent_at IS NOT NULL)
        )`, [maxMonths]);
  out.candidates = rows.length;
  if (!rows.length) return out;

  for (const child of rows) {
    const first = String(child.first_name || '').trim();
    const title = first ? `Time for ${first}'s 2-year check` : "Time for your child's 2-year check";
    const body = 'Your health visitor can do a 2-year development check now. Book it when you’re ' +
      'ready, and let us know the date so we can note it.';
    try {
      await notifyFn('two_year_check', 'parent', child.id, title, body,
        { priority: 'normal', relatedTable: 'children', relatedId: child.id, link: '/welcome/two-year-check' });
      out.notified++;
    } catch (e) {
      console.error(`${LOG} notify failed for child #${child.id}:`, e.message);
    }
  }
  if (out.notified) console.log(`${LOG} candidates=${out.candidates} notified=${out.notified}`);
  return out;
}

let _timer = null, _started = false;
/** Start the in-process timer. Off with TWO_YEAR_CHECK_NUDGE_DISABLED=true|1. Never throws. */
function startTwoYearCheckNudge(opts = {}) {
  if (['true', '1'].includes(String(process.env.TWO_YEAR_CHECK_NUDGE_DISABLED || '').toLowerCase())) {
    console.log(`${LOG} not started — TWO_YEAR_CHECK_NUDGE_DISABLED`);
    return null;
  }
  if (_started) return true;
  _started = true;
  const { getPool } = require('../db/pool');
  const every = Math.max(1, Number(process.env.TWO_YEAR_CHECK_SWEEP_MIN || 60)) * 60 * 1000;
  const tick = () => sweep(getPool(), opts).catch(e => console.error(`${LOG} sweep failed:`, e.message));
  const delay = Number(process.env.TWO_YEAR_CHECK_SWEEP_START_DELAY_MS || 90000);
  setTimeout(() => { tick(); _timer = setInterval(tick, every); if (_timer.unref) _timer.unref(); console.log(`${LOG} started (every ${every / 60000} min)`); }, delay).unref();
  return true;
}
function stopTwoYearCheckNudge() { if (_timer) clearInterval(_timer); _timer = null; _started = false; }

module.exports = { sweep, startTwoYearCheckNudge, stopTwoYearCheckNudge };
