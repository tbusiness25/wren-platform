'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// parent-forms-nudge.js — b343 (2026-09-21)
//
// "Mandatory means we keep asking." This is the asking, for forms a parent has been given to sign.
//
// TWO KINDS OF ASKING, AND WHAT EACH ONE IS
//   THE STANDING PROMPT (in the app, always) — the "Waiting for you" card and the Forms list are computed live from the
//     records, so they cannot go stale and they are there for every parent until the form is signed. This file is not
//     involved; it is the keep-asking that needs no scheduler.
//   THE NUDGE (push / email, only if the parent chose it) — this file. When a form first appears it raises ONE bell row
//     for the child (in-app record; the fan-out inside notify() nudges the guardians who chose push/email for "forms"), and
//     while the form stays unsigned it re-nudges those same parents every PARENT_FORMS_REMIND_DAYS (default 3), up to
//     PARENT_FORMS_REMIND_MAX (default 10) times, and never twice in one sweep for one child.
//
// WHO IS EVER NUDGED
//   Only a parent with an explicit row in parent_notification_prefs for the category 'forms' (source 'parent', not 'off') —
//   src/services/parent-notify.js, unchanged. A parent who never opened Notification settings is never emailed or pushed by
//   this; the release changes nobody's day (Toby's 2026-09-08 no-auto-parent-email rule holds — the one exemption is a
//   category a parent switched on for themselves). What leaves Wren is fixed text that names no form and no child.
//
// KILL SWITCH   PARENT_FORMS_SWEEP=off       stops the timer (the sweep can still be run by hand)
// TUNING        PARENT_FORMS_SWEEP_MIN (default 15)   PARENT_FORMS_REMIND_DAYS   PARENT_FORMS_REMIND_MAX
//
// NOTHING HERE READS OR WRITES A STAFF RECORD. It touches parent_form_requests (its own counters) and raises notifications.
// ─────────────────────────────────────────────────────────────────────────────
const F = require('../lib/parent-forms');

const LOG = '[parent-forms-nudge]';
const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const remindDays = () => Number(process.env.PARENT_FORMS_REMIND_DAYS != null ? process.env.PARENT_FORMS_REMIND_DAYS : 3);
const remindMax = () => Number(process.env.PARENT_FORMS_REMIND_MAX != null ? process.env.PARENT_FORMS_REMIND_MAX : 10);

/**
 * One pass. `db` is a pg Pool; `notifyFn(category, recipientType, recipientId, title, body, options)` raises the bell row and the
 * nudge (defaults to the dispatcher's notify); `fanOutFn(db, {notificationId, category, childId})` is the nudge without a bell row
 * (defaults to parent-notify's). Both are injectable so a test can never reach a real transport or another database.
 * Returns COUNTS ONLY: { children, requests, announced, reminded }.
 */
async function sweep(db, opts = {}) {
  const S = SCHEMA();
  const notifyFn = opts.notifyFn || require('./notification-dispatcher').notify;
  const fanOutFn = opts.fanOutFn || require('./parent-notify').fanOutToParents;
  const out = { children: 0, requests: 0, announced: 0, reminded: 0 };

  // Every child a parent can sign in for. A child nobody can sign in for is the office's business (the What-needs-me card counts them).
  const { rows: kids } = await db.query(
    `SELECT DISTINCT pa.child_id AS id FROM ${S}.parent_portal_access pa
       JOIN ${S}.children c ON c.id = pa.child_id
      WHERE pa.is_active = true AND COALESCE(c.is_active, true) = true`);
  const ids = kids.map(k => k.id);
  out.children = ids.length;
  if (!ids.length) return out;
  const touched = await F.ensureRequests(db, ids);
  out.requests = touched.length;

  const { rows: open } = await db.query(
    `SELECT r.id, r.child_id, r.nudge_count, r.last_nudged_at
       FROM ${S}.parent_form_requests r
      WHERE r.child_id = ANY($1) AND r.superseded_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ${S}.parent_form_signatures s WHERE s.request_id = r.id)
      ORDER BY r.child_id, r.id`, [ids]);
  // only requests that still correspond to a current, eligible record
  const live = new Set(touched.map(t => t.id));
  const byChild = new Map();
  for (const r of open) if (live.has(r.id)) { if (!byChild.has(r.child_id)) byChild.set(r.child_id, []); byChild.get(r.child_id).push(r); }

  const gapMs = remindDays() * 24 * 3600 * 1000, max = remindMax(), now = Date.now();
  for (const [childId, list] of byChild) {
    const fresh = list.filter(r => r.nudge_count === 0);
    if (fresh.length) {
      // First sight: one bell row for the child (the in-app record) — and, through notify(), the nudge for guardians who chose it.
      // Fixed, generic wording: the bell is read on a phone that may be shared, so it does not say which form.
      notifyFn('form_needs_signature', 'parent', childId, 'A form is waiting for you to sign',
        'There is a form to read and sign. Open Forms in the app when you have a minute.',
        { priority: 'normal', link: '/welcome/forms', relatedTable: 'parent_form_requests', relatedId: fresh[0].id });
      await db.query(`UPDATE ${S}.parent_form_requests SET last_nudged_at = now(), nudge_count = nudge_count + 1 WHERE id = ANY($1)`, [fresh.map(r => r.id)]);
      out.announced++;
      continue;                                       // never a reminder in the same sweep as the announcement
    }
    const due = list.filter(r => r.nudge_count > 0 && r.nudge_count < max && r.last_nudged_at && now - new Date(r.last_nudged_at).getTime() >= gapMs);
    if (due.length) {
      // A reminder is the nudge only — no second bell row for a form that already has one.
      await fanOutFn(db, { notificationId: null, category: 'form_needs_signature', childId });
      await db.query(`UPDATE ${S}.parent_form_requests SET last_nudged_at = now(), nudge_count = nudge_count + 1 WHERE id = ANY($1)`, [due.map(r => r.id)]);
      out.reminded++;
    }
  }
  if (out.announced || out.reminded) console.log(`${LOG} children=${out.children} requests=${out.requests} announced=${out.announced} reminded=${out.reminded}`);
  return out;
}

let _timer = null, _started = false;
/** Start the in-process timer. Off with PARENT_FORMS_SWEEP=off. Never throws. */
function startParentFormsNudge(opts = {}) {
  if (String(process.env.PARENT_FORMS_SWEEP || '').toLowerCase() === 'off') { console.log(`${LOG} not started — PARENT_FORMS_SWEEP=off`); return null; }
  if (_started) return true;
  _started = true;
  const { getPool } = require('../db/pool');
  const every = Math.max(1, Number(process.env.PARENT_FORMS_SWEEP_MIN || 15)) * 60 * 1000;
  const tick = () => sweep(getPool(), opts).catch(e => console.error(`${LOG} sweep failed:`, e.message));
  const delay = Number(process.env.PARENT_FORMS_SWEEP_START_DELAY_MS || 90000);
  setTimeout(() => { tick(); _timer = setInterval(tick, every); if (_timer.unref) _timer.unref(); console.log(`${LOG} started (every ${every / 60000} min)`); }, delay).unref();
  return true;
}
function stopParentFormsNudge() { if (_timer) clearInterval(_timer); _timer = null; _started = false; }

module.exports = { sweep, startParentFormsNudge, stopParentFormsNudge };
