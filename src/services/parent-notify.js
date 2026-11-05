'use strict';
/**
 * parent-notify.js — b340 (2026-09-18)
 * ─────────────────────────────────────────────────────────────────────────────
 * The parent half of the notification dispatcher. When Wren raises a notification
 * addressed to a CHILD's parents (notify(category, 'parent', childId, …)), the
 * dispatcher writes the bell row exactly as it always did and then calls
 * fanOutToParents() here, which nudges the parents who have CHOSEN to be nudged.
 *
 * WHO GETS ANYTHING
 * -----------------
 * Only a parent with an explicit row in parent_notification_prefs (source 'parent'),
 * for the preference category this notification belongs to, whose channel is not
 * 'off'. No row → nothing beyond the bell. So the release changes nobody's day, and
 * Toby's 2026-09-08 rule ("Wren must never email a parent on its own") holds: the one
 * exception is a category that parent has switched on for themselves, on the screen
 * built for it.
 *
 * WHAT LEAVES WREN, AND WHAT NEVER DOES
 * -------------------------------------
 * Email and push both carry FIXED TEXT per category (parent-notification-prefs.js
 * push_text / email_phrase). The notification's own title and body are never read here:
 * they name children, and sometimes quote a message. A push lands on a lock screen and an
 * email in a personal inbox that Wren does not control, so both say only "something is
 * waiting" and link to the app. That is enforced by construction (this file never
 * touches title/body) and checked by scripts/b340-verify.js on the bytes.
 *
 * The email path is FAIL-CLOSED on two independent gates, either of which stops it:
 *   1. parentEmailAllowedForCategory() — a named allowlist, like the staff one in the
 *      dispatcher, but SEPARATE from it: the staff allowlist governs text that is sent
 *      as written; adding observation_published there would leak. Anything not on it,
 *      including every category nobody has classified, is not emailed.
 *   2. a template must exist for the preference category (email: 'dispatcher').
 * 'message_received' is on neither path here: the reply-by-email gateway in
 * src/routes/messages.js already sends that email and reads the same choice.
 *
 * DEV IS SAFE BY CONSTRUCTION
 * ---------------------------
 * Email goes through sendViaGmail DIRECTLY and 'disabled' is a terminal outcome — never
 * a fall-through to n8n (see reference_dev_mail_guard_n8n_fallthrough). Tests inject
 * their own senders with __setSenders(); PARENT_NOTIFY_DRY_RUN=1 records what would
 * have gone without touching any transport; PARENT_NOTIFY_EMAIL=off is a kill switch.
 * Every attempt is written to parent_notification_deliveries (address, category,
 * channel, outcome — never text) and counts only go to the console log.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const crypto = require('crypto');
const P = require('./parent-notification-prefs');

// ── The email gate ───────────────────────────────────────────────────────────
// Emailable to a parent as a fixed "something is waiting" note. Everything else fails closed.
const PARENT_EMAIL_ALLOWED_CATEGORIES = new Set([
  'observation_published', 'report_shared', 'event_published',
  'form_needs_signature',      // b343 — fixed wording, names no form and no child (parent-notification-prefs.js 'forms')
]);
// Named so the reason is visible at the call site rather than inferred from absence — the same
// courtesy the staff list gets. These carry, or can carry, a child's name or a concern.
const PARENT_EMAIL_BLOCKED_CATEGORIES = new Set([
  'message_received',            // the reply-by-email gateway owns this one
  'collection', 'funding',       // name the child / the collector / a declaration
  'safeguarding', 'safeguarding_concern', 'incident', 'accident', 'medicine', 'medicine_due', 'allergy',
  'two_year_check', 'sen', 'sen_review', 'automation', 'report_fixed',
  'details_outstanding',         // b502 — reminder campaigns: bell + opt-in push only, never email
]);

function parentEmailAllowedForCategory(category) {
  const c = String(category || '');
  if (PARENT_EMAIL_BLOCKED_CATEGORIES.has(c)) return false;
  return PARENT_EMAIL_ALLOWED_CATEGORIES.has(c);
}

const appBase = () => String(process.env.PARENTS_BASE_URL || 'https://parents.example-nursery.co.uk').replace(/\/+$/, '');

/** The fixed email for a preference category. Pure: no child, no parent, no notification text. */
function buildParentEmail(prefId) {
  const cat = P.BY_ID[prefId];
  if (!cat || cat.email !== 'dispatcher' || !cat.email_phrase) return null;
  const open = appBase() + (cat.open_path || '/welcome/notifications');
  const settings = appBase() + '/welcome/notifications/settings';
  const subject = 'Your Nursery — something is waiting for you in the app';
  const text = 'Hello,\n\n'
    + `There is ${cat.email_phrase} waiting for you in the Your Nursery app.\n\n`
    + `Open the app to see it: ${open}\n\n`
    + `You are getting this email because you chose "email" for ${cat.label.toLowerCase()} under Notifications. `
    + `You can change that at any time: ${settings}\n\n`
    + 'Your Nursery';
  const html = '<p>Hello,</p>'
    + `<p>There is ${cat.email_phrase} waiting for you in the Your Nursery app.</p>`
    + `<p><a href="${open}">Open the app to see it</a></p>`
    + `<p style="font-size:12px;color:#64748b">You are getting this email because you chose “email” for `
    + `${cat.label.toLowerCase()} under Notifications. <a href="${settings}">Change that at any time</a>.</p>`
    + '<p>Your Nursery</p>';
  return { subject, html, text };
}

/** The fixed push payload. Same rule: nothing from the notification itself. */
function buildParentPush(prefId) {
  const cat = P.BY_ID[prefId];
  if (!cat || !cat.push || !cat.push_text) return null;
  return { title: 'Your Nursery', body: cat.push_text, url: cat.open_path || '/welcome/notifications', tag: 'lap-' + prefId };
}

// ── Real transports (replaceable for tests) ──────────────────────────────────
let _webpush;
function _getWebpush() {
  if (_webpush !== undefined) return _webpush;
  _webpush = null;
  try {
    const wp = require('web-push');
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      wp.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example-nursery.co.uk',
        process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
      _webpush = wp;
    }
  } catch (_) { /* package absent (demo image): push simply isn't available */ }
  return _webpush;
}
function pushConfigured() { return !!_getWebpush(); }

async function _realPush(sub, payload) {
  const wp = _getWebpush();
  if (!wp) { const e = new Error('web push not configured'); e.notConfigured = true; throw e; }
  return wp.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    JSON.stringify(payload), { TTL: 3600, timeout: 8000 });
}

async function _realEmail(to, parts, db) {
  const gmail = require('../lib/gmail-sender');
  let outcome = { status: 'failed', detail: 'not configured' };
  let source = 'not_configured';
  try {
    if (gmail.isConfigured()) {
      const r = await gmail.sendViaGmail({ to, subject: parts.subject, html: parts.html, text: parts.text,
        fromName: 'Your Nursery' });
      if (r && r.disabled) { outcome = { status: 'disabled', detail: 'mail disabled on this environment' }; source = 'gmail_api_disabled'; }
      else if (r && r.ok) { outcome = { status: 'sent' }; source = 'gmail_api'; }
      else { outcome = { status: 'failed', detail: 'no confirmation' }; source = 'gmail_api_error'; }
    }
  } catch (e) { outcome = { status: 'failed', detail: String(e.message).slice(0, 200) }; source = 'gmail_api_error'; }
  try {   // subject + recipient only, exactly like the starter welcome: the audit is the record it was composed
    await db.query(
      `INSERT INTO email_audit (direction, to_emails, subject, event_type, source, sent_ok, error)
       VALUES ('out', $1, $2, 'parent-notification', $3, $4, $5)`,
      [[to], parts.subject.slice(0, 500), source, outcome.status === 'sent', outcome.status === 'sent' ? null : outcome.detail]);
  } catch (_) { /* never block on an audit failure */ }
  return outcome;
}

let _senders = null;                 // tests only: { push(sub,payload), email(to,parts) }
function __setSenders(s) { _senders = s || null; }

// ── One nudge is enough ──────────────────────────────────────────────────────
// An event published to the whole nursery raises one notification PER CHILD (events.js loops the roll),
// so a two-child family would be told "something is waiting" twice for one event. Every item is still in
// the bell; the nudge only says "look". So the same parent gets at most one nudge per category per channel
// in PARENT_NOTIFY_DEDUP_SECONDS (default 120; 0 turns it off). The claim is taken SYNCHRONOUSLY, before any
// await, because those notifications are fired concurrently — a database check would let both through.
// Process-local by design (one wren-ladn container); a restart forgets, which errs towards telling.
const _claims = new Map();
function _claim(key) {
  const win = Number(process.env.PARENT_NOTIFY_DEDUP_SECONDS != null ? process.env.PARENT_NOTIFY_DEDUP_SECONDS : 120) * 1000;
  if (!(win > 0)) return true;
  const now = Date.now();
  for (const [k, t] of _claims) if (now - t > win) _claims.delete(k);
  if (_claims.has(key)) return false;
  _claims.set(key, now);
  return true;
}
const _release = key => { _claims.delete(key); };

const dryRun = () => process.env.PARENT_NOTIFY_DRY_RUN === '1';

// ── Who is this notification for? ────────────────────────────────────────────
// Every guardian of the child who chose something for this category. The union covers the two
// ways Wren knows a parent: a portal-access row, and the addresses on the child record.
const RECIPIENTS_SQL = `
  WITH kin AS (
    SELECT lower(email) AS e FROM parent_portal_access WHERE child_id=$1 AND is_active=true AND email IS NOT NULL
    UNION SELECT lower(nullif(parent_1_email,''))        FROM children WHERE id=$1
    UNION SELECT lower(nullif(parent_2_email,''))        FROM children WHERE id=$1
    UNION SELECT lower(nullif(primary_contact_email,'')) FROM children WHERE id=$1
  )
  SELECT p.parent_email, p.channel
    FROM parent_notification_prefs p JOIN kin ON kin.e = p.parent_email
   WHERE p.category=$2 AND p.channel <> 'off' AND p.source='parent'`;

const ref = e => crypto.createHash('sha256').update(String(e).toLowerCase()).digest('hex').slice(0, 10);

async function _record(db, notificationId, email, category, channel, status, detail) {
  try {
    await db.query(
      `INSERT INTO parent_notification_deliveries (notification_id, parent_email, category, channel, status, detail)
       VALUES ($1,$2,$3,$4,$5,$6)`, [notificationId || null, email, category, channel, status, detail || null]);
  } catch (_) { /* a bookkeeping failure must never stop a delivery */ }
}

/**
 * Nudge the parents of `childId` who chose to be nudged about `category`.
 * NEVER throws. Returns counts only: { pref, considered, push:{sent,skipped,failed}, email:{…} }.
 */
async function fanOutToParents(db, { notificationId, category, childId }) {
  const out = { pref: null, considered: 0, push: { sent: 0, skipped: 0, failed: 0 }, email: { sent: 0, skipped: 0, failed: 0 } };
  try {
    const prefId = P.PREF_FOR_DISPATCH[category];
    if (!prefId || !childId) return out;                  // unclassified category: the bell only — fail closed
    out.pref = prefId;
    const cat = P.BY_ID[prefId];
    const { rows } = await db.query(RECIPIENTS_SQL, [childId, prefId]);
    out.considered = rows.length;
    const senders = _senders || {};
    for (const r of rows) {
      const email = r.parent_email;
      const wantPush = (r.channel === 'push' || r.channel === 'both') && cat.push;
      // 'legacy' email is sent by the existing gateway; only a 'dispatcher' category emails from here
      const wantEmail = (r.channel === 'email' || r.channel === 'both') && cat.email === 'dispatcher'
        && parentEmailAllowedForCategory(category) && process.env.PARENT_NOTIFY_EMAIL !== 'off';

      if (wantPush) {
        const payload = buildParentPush(prefId);
        const { rows: subs } = await db.query(
          'SELECT id, endpoint, p256dh, auth FROM parent_push_subscriptions WHERE parent_email=$1', [email]);
        if (!subs.length) {
          out.push.skipped++; await _record(db, notificationId, email, prefId, 'push', 'skipped', 'no device set up');
        } else if (dryRun()) {
          out.push.skipped++; await _record(db, notificationId, email, prefId, 'push', 'dry_run', `${subs.length} device(s)`);
        } else if (!_claim(`push|${email}|${prefId}`)) {
          out.push.skipped++; await _record(db, notificationId, email, prefId, 'push', 'skipped', 'already nudged a moment ago');
        } else {
          let ok = 0, bad = 0;
          for (const sub of subs) {
            try {
              await (senders.push || _realPush)(sub, payload);
              ok++; db.query('UPDATE parent_push_subscriptions SET last_used_at=now() WHERE id=$1', [sub.id]).catch(() => {});
            } catch (err) {
              bad++;
              // 404/410: the browser has revoked this subscription — forget it rather than retry for ever
              if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                await db.query('DELETE FROM parent_push_subscriptions WHERE id=$1', [sub.id]).catch(() => {});
              }
              if (err && err.notConfigured) { bad = subs.length; ok = 0; break; }
            }
          }
          if (ok) { out.push.sent++; await _record(db, notificationId, email, prefId, 'push', 'sent', `${ok}/${subs.length} device(s)`); }
          else { _release(`push|${email}|${prefId}`); out.push.failed++; await _record(db, notificationId, email, prefId, 'push', 'failed', `${bad} device(s) failed`); }
        }
      }

      if (wantEmail) {
        const parts = buildParentEmail(prefId);
        if (!parts) { out.email.skipped++; await _record(db, notificationId, email, prefId, 'email', 'skipped', 'no template'); }
        else if (dryRun()) { out.email.skipped++; await _record(db, notificationId, email, prefId, 'email', 'dry_run', null); }
        else if (!_claim(`email|${email}|${prefId}`)) { out.email.skipped++; await _record(db, notificationId, email, prefId, 'email', 'skipped', 'already nudged a moment ago'); }
        else {
          const res = await (senders.email ? senders.email(email, parts) : _realEmail(email, parts, db));
          const st = (res && res.status) || 'failed';
          if (st !== 'sent') _release(`email|${email}|${prefId}`);
          if (st === 'sent') out.email.sent++; else if (st === 'disabled') out.email.skipped++; else out.email.failed++;
          await _record(db, notificationId, email, prefId, 'email', st, res && res.detail);
        }
      }
    }
    if (out.considered) {
      // counts and a pseudonymous ref only — never an address, never a name (build-logs is an unwalled sink)
      console.log(`[parent-notify] ${category}→${prefId} child#${childId} recipients=${out.considered} `
        + `push(sent=${out.push.sent} skipped=${out.push.skipped} failed=${out.push.failed}) `
        + `email(sent=${out.email.sent} skipped=${out.email.skipped} failed=${out.email.failed})`);
    }
  } catch (e) {
    console.error('[parent-notify] fan-out failed:', e.message);
  }
  return out;
}

module.exports = {
  fanOutToParents, buildParentEmail, buildParentPush,
  parentEmailAllowedForCategory, PARENT_EMAIL_ALLOWED_CATEGORIES, PARENT_EMAIL_BLOCKED_CATEGORIES,
  pushConfigured, __setSenders, ref,
};
