'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b292 — the "set up your Wren ID" email.
//
// Same two-part shape as src/lib/starter-welcome.js (b275), for the same
// reasons:
//   composeInviteEmail(...)  PURE → { subject, html, text }. No database, no
//                            network. scripts/b292-verify.js asserts the wording
//                            against it without anything being sent.
//   sendInviteEmail(...)     composes, sends via src/lib/gmail-sender, writes the
//                            email_audit row, and NEVER throws.
//
// WHY sendViaGmail DIRECTLY AND NOT notifications.sendEmail: sendEmail's Gmail
// attempt returns { disabled:true } on a *_dev database and then falls through
// to SMTP and to N8N_EMAIL_WEBHOOK — which IS set on wren-ladn-dev. A dev test
// could therefore post a real credential link to a real member of staff. This
// path uses the one transport, and "disabled" ends it.
//
// THE LINK IS THE CREDENTIAL. It is single-use and time-limited, and there is
// nothing else in the body: no password, no PIN, no username, no token to type.
// assertNoSecrets() below is a guard, not a comment.
//
// TONE. Toby's brief: "short, plain, from a real person's tone, not a system."
// It says what Wren ID is, that the PIN still works and is not going away, and
// what to do when the link has expired. It does not sell anything.
//
// COLOURS ARE LITERAL HEX BY NECESSITY — this is an email body, rendered by
// Gmail and Outlook, which strip <style> and do not support CSS custom
// properties. Same documented exception as starter-welcome.js.
// ─────────────────────────────────────────────────────────────────────────────

const BRAND = '#e07820';
const BLUE = '#4a9abf';
const INK = '#1f2937';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtWhen(d) {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(d);
  if (isNaN(dt.getTime())) return null;
  return dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
}

// A safety net. If a future edit ever interpolates a PIN or a password into
// this email, the send fails loudly rather than posting it to 18 people.
const SECRET_PATTERNS = [
  /\bpin\b[^.\n]{0,40}?\b\d{4,8}\b/i,
  /\b\d{4,8}\b[^.\n]{0,20}?\bis your pin\b/i,
  /\byour (?:temporary |new )?password is\b/i,
  /\bpassword[:=]\s*\S{6,}/i,
  /\bpin_hash\b/i,
];
function assertNoSecrets(text) {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) {
      throw new Error('wren-id-invite: refusing to send — the body looks like it contains a credential');
    }
  }
  return true;
}

/**
 * Compose the invitation. Pure.
 *
 * @param {object} o
 * @param {string} o.firstName    the staff member's first name
 * @param {string} o.link         the single-use enrolment link (the credential)
 * @param {Date|string} o.expires when the link stops working
 * @param {string} [o.portalUrl]  where they will sign in afterwards
 * @param {string} [o.settingName]
 * @param {string} [o.senderName] who it reads as being from — the manager who
 *                                pressed send, so "reply to this" reaches a
 *                                person who knows what it is about
 * @param {string} [o.askEmail]   an address to offer alongside "reply to this".
 *                                Empty by default ON PURPOSE: replies already
 *                                land in the sending mailbox, and admin@ is a
 *                                Toby alias carrying confidential owner
 *                                correspondence — not an address to print in a
 *                                mail to eighteen people.
 */
function composeInviteEmail({
  firstName,
  link,
  expires,
  portalUrl = 'https://admin.example-nursery.co.uk/',
  settingName = 'Your Nursery',
  senderName = 'Toby',
  askEmail = '',
} = {}) {
  if (!link) throw new Error('wren-id-invite: no link');
  const name = String(firstName || '').trim().split(/\s+/)[0] || 'there';
  const when = fmtWhen(expires);
  const subject = 'Set up your Wren ID';

  const text = `Hi ${name},

We've turned on a proper login for Wren, called Wren ID. It means you sign in
with your own email address and a password you choose yourself, instead of
depending on anything outside the nursery.

Set your password here — the link is just for you:

  ${link}

${when ? `The link stops working on ${when}, and it only works once, so open it when
you have a couple of minutes rather than half-opening it now.` : 'The link only works once, so open it when you have a couple of minutes.'}

Your PIN still works. It is not going away — it stays the way you sign in on the
room tablets, and nothing about it changes today. Wren ID is for signing in on a
computer or your phone, at ${portalUrl}

If the link has expired by the time you get to it, or it says it is not valid,
just reply to this and I'll send you a fresh one. It takes ten seconds.${askEmail ? `
You can also email ${askEmail}.` : ''}

We will never email or message you a PIN or a password. If anything ever does,
it did not come from us — tell me.

${senderName}
${settingName}
`;

  const html = `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f5f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">

<tr><td style="padding:26px 28px 0">
  <p style="font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:${BRAND};margin:0 0 10px;font-weight:700">${esc(settingName)}</p>
  <h1 style="font-size:20px;line-height:1.35;margin:0 0 14px;color:${INK}">Set up your Wren ID</h1>
  <p style="font-size:14px;line-height:1.65;color:${MUTED};margin:0">
    Hi ${esc(name)}, we&rsquo;ve turned on a proper login for Wren, called <b style="color:${INK}">Wren ID</b>.
    It means you sign in with your own email address and a password you choose yourself,
    instead of depending on anything outside the nursery.
  </p>
</td></tr>

<tr><td style="padding:20px 28px 0">
  <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:${BRAND};border-radius:9px">
    <a href="${esc(link)}" style="display:inline-block;padding:13px 24px;color:#ffffff;font-size:15px;font-weight:700;text-decoration:none">Choose my password</a>
  </td></tr></table>
  <p style="font-size:12.5px;line-height:1.6;color:${MUTED};margin:14px 0 0">
    This link is just for you &mdash; please don&rsquo;t forward it.
    ${when ? `It stops working on <b>${esc(when)}</b>, and it only works once, so open it when you have a couple of minutes rather than half-opening it now.` : 'It only works once, so open it when you have a couple of minutes.'}<br>
    If the button doesn&rsquo;t work, paste this into your browser:<br>
    <span style="word-break:break-all;color:${BLUE}">${esc(link)}</span>
  </p>
</td></tr>

<tr><td style="padding:22px 28px 0">
  <div style="background:#fffaf3;border:1px solid #f3d9b8;border-left:3px solid ${BRAND};border-radius:9px;padding:13px 15px;font-size:13.5px;line-height:1.65;color:#4b5563">
    <b style="color:${INK}">Your PIN still works.</b> It is not going away. It stays the way you sign in
    on the room tablets, and nothing about it changes today. Wren ID is for signing in on a computer
    or your phone, at <a href="${esc(portalUrl)}" style="color:${BLUE};word-break:break-all">${esc(portalUrl)}</a>.
  </div>
</td></tr>

<tr><td style="padding:20px 28px 0">
  <h2 style="font-size:15px;margin:0 0 6px;color:${INK}">If the link has expired</h2>
  <p style="font-size:14px;line-height:1.65;color:${MUTED};margin:0">
    If it says the link is not valid, or you get to it too late, just reply to this
    ${askEmail ? `or email <a href="mailto:${esc(askEmail)}" style="color:${BLUE}">${esc(askEmail)}</a>` : ''}
    and I&rsquo;ll send a fresh one. It takes ten seconds &mdash; there is nothing to sort out at your end.
  </p>
</td></tr>

<tr><td style="padding:18px 28px 26px">
  <p style="font-size:13px;line-height:1.6;color:${MUTED};margin:0 0 16px">
    We will never email or message you a PIN or a password. If anything ever does, it did not
    come from us &mdash; tell me.
  </p>
  <p style="font-size:14px;color:${INK};margin:0">${esc(senderName)}<br><span style="color:${MUTED}">${esc(settingName)}</span></p>
  <p style="font-size:12px;color:${MUTED};margin:14px 0 0;border-top:1px solid ${LINE};padding-top:12px">
    ${esc(settingName)} &middot; 123 Example Lane, Your Town, AB1 2CD
  </p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  assertNoSecrets(text);
  assertNoSecrets(html);
  return { subject, html, text };
}

/**
 * Compose + send + audit. Returns { sent, disabled, error, subject, messageId }.
 * NEVER throws: a failed email must not lose the invitation that was already
 * minted — the caller records the row either way and the screen offers a re-send.
 */
async function sendInviteEmail(to, parts, eventType = 'wren-id-invite') {
  const { subject, html, text } = parts;
  const result = { sent: false, disabled: false, error: null, subject, messageId: null };
  let source = 'gmail_api';
  try {
    const gmail = require('./gmail-sender');
    if (!gmail.isConfigured()) {
      result.error = 'Gmail service account not configured';
      source = 'not_configured';
    } else {
      const r = await gmail.sendViaGmail({ to, subject, html, text });
      if (r && r.disabled) {
        // dev / MAIL_DISABLED. Correct behaviour — do not defeat it, do not fall
        // back to another transport. The audit row records that it would have gone.
        result.disabled = true;
        source = 'gmail_api_disabled';
      } else if (r && r.ok) {
        result.sent = true;
        result.messageId = r.messageId;
      } else {
        result.error = 'send returned no confirmation';
        source = 'gmail_api_error';
      }
    }
  } catch (e) {
    result.error = e.message;
    source = 'gmail_api_error';
  }

  // Audit every attempt, including the dev no-send. Recipient and subject only —
  // the body carries a live credential and is never stored.
  try {
    const { getPool } = require('../db/pool');
    await getPool().query(
      `INSERT INTO email_audit (direction, to_emails, subject, event_type, source, sent_ok, error)
       VALUES ('out', $1, $2, $3, $4, $5, $6)`,
      [[to], String(subject).slice(0, 500), eventType, source, result.sent, result.error]);
  } catch (_) { /* never block on an audit failure */ }

  return result;
}

module.exports = { composeInviteEmail, sendInviteEmail, assertNoSecrets };
