'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b275 — the new-starter welcome email (2026-09-04)
//
// Toby: "Maybe like eylog so i put her email in, it emails her how to login to
// wren and access induction etc."
//
// This module does TWO things and keeps them apart on purpose:
//
//   composeWelcomeEmail(...)  a PURE function → { subject, html, text }.
//                             No database, no network, no env reads beyond the
//                             values passed in. It is the thing b275-verify
//                             asserts against, so the wording can be proved
//                             without sending anything.
//   sendWelcomeEmail(...)     composes, sends via src/lib/gmail-sender, and
//                             writes the email_audit row.
//
// WHY sendViaGmail DIRECTLY AND NOT notifications.sendEmail:
//   sendEmail's Gmail attempt returns { disabled:true } on a *_dev database and
//   then FALLS THROUGH to SMTP and to N8N_EMAIL_WEBHOOK. N8N_EMAIL_WEBHOOK is
//   set on wren-ladn-dev (http://n8n:5678/webhook/wren-email-send), so a dev
//   send could still leave the box through the live n8n instance. For a
//   safeguarding-relevant welcome addressed to a real new starter that is the
//   wrong shape: this path uses the one transport Toby named in the brief, and
//   when that transport says "disabled" the send stops there.
//
// THE PIN IS NEVER IN THIS FILE. A PIN is set by a manager, in person. The email
// says so, and assertNoPin() below is a hard guard, not a comment.
//
// COLOURS ARE LITERAL HEX HERE BY NECESSITY: this is an email body, rendered by
// Gmail/Outlook, which strip <style> and do not support CSS custom properties.
// The var(--c-*) rule applies to Wren's own pages; the same exception the
// standalone onboarding-public.js pages already document.
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

function fmtDate(d) {
  if (!d) return null;
  try {
    // A pg DATE arrives as a local-midnight JS Date; read it with LOCAL getters.
    // toISOString() would shift it a day west of GMT.
    // (memory/reference_pg_date_ymd_trap.md)
    const dt = d instanceof Date ? d : new Date(String(d) + (String(d).length === 10 ? 'T00:00:00' : ''));
    if (isNaN(dt.getTime())) return null;
    return dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  } catch (_) { return null; }
}

// A safety net, not decoration. If any future edit ever interpolates something
// PIN-shaped into this email, the send fails loudly instead of posting it.
const PIN_PATTERNS = [
  /\bpin\b[^.\n]{0,40}?\b\d{4,8}\b/i,   // "PIN is 1234", "your pin: 123456"
  /\b\d{4,8}\b[^.\n]{0,20}?\bis your pin\b/i,
  /\bpin_hash\b/i,
];
function assertNoPin(text) {
  for (const re of PIN_PATTERNS) {
    if (re.test(text)) throw new Error('starter-welcome: refusing to send — the body looks like it contains a PIN');
  }
  return true;
}

/**
 * Compose the welcome email. Pure.
 *
 * @param {object} o
 * @param {string} o.firstName        the starter's first name (or preferred name)
 * @param {string} o.settingName      e.g. "Your Nursery"
 * @param {string} o.portalUrl        where they will log in once they start
 * @param {string} o.inductionUrl     tokened, single-starter induction workbook link
 * @param {string} [o.roleLabel]      "Apprentice" / "Early Years Practitioner"
 * @param {Date|string} [o.startDate] first day
 * @param {Date|string} [o.expiresAt] when the induction link stops working
 * @param {string} [o.managerName]    who to ask
 * @param {string} [o.managerEmail]   who to ask
 * @param {string} [o.roomLeaderName] their day-to-day room leader
 * @param {Array<{title:string,summary?:string,url:string,kind?:string,item_count?:number}>} [o.documents]
 *        b288 — the starter pack: handbook, new staff induction, fire induction.
 *        Read from ladn.starter_pack_documents at send time, so a manager can
 *        change what a starter receives without a deploy. Omitted → the section
 *        is absent and the email is byte-for-byte the b275 one.
 * @returns {{subject:string, html:string, text:string}}
 */
function composeWelcomeEmail(o = {}) {
  const first = String(o.firstName || '').trim() || 'there';
  const setting = String(o.settingName || 'Your Nursery').trim();
  const portalUrl = String(o.portalUrl || '').trim();
  const inductionUrl = String(o.inductionUrl || '').trim();
  if (!portalUrl) throw new Error('composeWelcomeEmail: portalUrl is required');
  if (!inductionUrl) throw new Error('composeWelcomeEmail: inductionUrl is required');

  const roleLabel = String(o.roleLabel || '').trim();
  const startNice = fmtDate(o.startDate);
  const expiresNice = fmtDate(o.expiresAt);
  const manager = String(o.managerName || '').trim();
  const managerEmail = String(o.managerEmail || '').trim();
  const roomLeader = String(o.roomLeaderName || '').trim();

  // b288 — the document pack. Links, not attachments: a tokened page renders on
  // a phone, survives a mailbox that strips .docx, and stops working when the
  // invite expires. Nothing is included that a manager has switched off.
  const documents = (Array.isArray(o.documents) ? o.documents : [])
    .filter(d => d && d.title && d.url)
    .map(d => ({
      title: String(d.title).trim(),
      summary: String(d.summary || '').trim(),
      url: String(d.url).trim(),
      kind: String(d.kind || '').trim(),
      itemCount: Number(d.item_count) || 0,
    }));

  const subject = `Welcome to ${setting} — your Wren login and induction`;

  const askLine = manager
    ? `If anything here doesn't look right, or you can't open the link, just ask ${manager}${managerEmail ? ` (${managerEmail})` : ''} — no need to sort it out on your own.`
    : `If anything here doesn't look right, or you can't open the link, just ask your manager — no need to sort it out on your own.`;

  // ── plain text (the part that is always readable) ───────────────────────────
  const textLines = [
    `Hello ${first},`,
    '',
    `Welcome to ${setting}. We're really glad you're joining us${startNice ? `, and we're looking forward to seeing you on ${startNice}` : ''}${roleLabel ? ` as our ${roleLabel.toLowerCase()}` : ''}.`,
    '',
    'WHAT WREN IS',
    `Wren is the system we run the nursery on. It's where we write up observations of the children, plan activities, record the daily diary that parents read, log accidents and medicine, and keep our policies, training and induction paperwork. Everything you do in your day will pass through it at some point, so we'd rather you met it before day one than on it.`,
    '',
    'YOUR INDUCTION — HAVE A LOOK BEFORE YOU START',
    'Your 4-week induction workbook is already set up for you. You can read it now, from this link, without logging in:',
    inductionUrl,
    expiresNice ? `This link is just for you. Please don't forward it — it stops working on ${expiresNice}.` : 'This link is just for you — please don\'t forward it.',
    'Week 1 is the important one to skim: the building and fire exits, safeguarding, safe sleeping, and the policies you\'ll be asked to sign.',
    '',
    ...(documents.length ? [
      'WHAT WE\'RE SENDING YOU',
      'These open from the same link — no login, and you can read them on your phone:',
      ...documents.flatMap(d => [
        `* ${d.title}${d.itemCount ? ` (${d.itemCount} points)` : ''}`,
        d.summary ? `  ${d.summary}` : null,
        `  ${d.url}`,
      ].filter(Boolean)),
      'The handbook has a "I have read this" button at the bottom — please tick it once you have. The two inductions are the ones we walk through together in person; they are there so you know what is coming.',
      '',
    ] : []),
    'HOW YOU\'LL LOG IN',
    `Once you start, you'll use Wren here: ${portalUrl}`,
    'You log in with your name and a numeric PIN. We do NOT email PINs. A manager will set yours with you in person on your first day, and you can change it yourself afterwards. If anyone ever emails or messages you a Wren PIN, that did not come from us — tell a manager.',
    roomLeader ? `${roomLeader} is your room leader and will be signing off your induction as you go.` : null,
    '',
    'ONE IMPORTANT THING BEFORE YOU GET AN ACCOUNT',
    'Wren holds children\'s personal data — names, dates of birth, photographs, medical and dietary needs, safeguarding records and family contact details. Your Wren account is a safeguarding-relevant account. Every action you take in it is logged against your name, including the records you open and read. That is normal and it protects everyone, children and staff alike; we mention it now so that nothing about it is a surprise. Please only look at what you need for your work, never share your login, and never take nursery data off site.',
    '',
    'WHAT HAPPENS NEXT',
    '1. Open the induction link above and read through week 1.',
    '2. Use the "Fill in my details" button on that page to send us the bits we need for your file (address, emergency contact, DBS, qualification).',
    '3. On your first day a manager will activate your account and set your PIN with you.',
    '',
    askLine,
    '',
    'See you soon,',
    setting,
    '123 Example Lane, Your Town, AB1 2CD',
  ];
  // Drop only the conditional lines that resolved to null — the '' entries are
  // the paragraph breaks, and a plain-text email without them is a wall.
  const text = textLines.filter(l => l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n');

  // ── html ────────────────────────────────────────────────────────────────────
  const btn = (href, label, bg) =>
    `<a href="${esc(href)}" style="display:inline-block;padding:13px 22px;border-radius:10px;` +
    `background:${bg};color:#ffffff;font-weight:700;text-decoration:none;font-size:15px">${esc(label)}</a>`;

  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#fbf7f0">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fbf7f0;padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${INK}">
<tr><td style="padding:26px 28px 0">
  <div style="font-weight:800;color:${BRAND};font-size:15px;letter-spacing:.01em">${esc(setting)}</div>
  <h1 style="font-size:22px;margin:14px 0 6px;color:${INK}">Welcome, ${esc(first)} 🕊️</h1>
  <p style="font-size:15px;line-height:1.6;color:${INK};margin:0 0 4px">
    We're really glad you're joining us${startNice ? `, and we're looking forward to seeing you on <b>${esc(startNice)}</b>` : ''}${roleLabel ? ` as our ${esc(roleLabel.toLowerCase())}` : ''}.
  </p>
</td></tr>

<tr><td style="padding:18px 28px 0">
  <h2 style="font-size:15px;margin:0 0 6px;color:${INK}">What Wren is</h2>
  <p style="font-size:14px;line-height:1.65;color:${MUTED};margin:0">
    Wren is the system we run the nursery on. It's where we write up observations of the children,
    plan activities, record the daily diary that parents read, log accidents and medicine, and keep
    our policies, training and induction paperwork. Everything you do in your day passes through it
    at some point — so we'd rather you met it before day one than on it.
  </p>
</td></tr>

<tr><td style="padding:22px 28px 0">
  <h2 style="font-size:15px;margin:0 0 6px;color:${INK}">Your induction — have a look before you start</h2>
  <p style="font-size:14px;line-height:1.65;color:${MUTED};margin:0 0 14px">
    Your 4-week induction workbook is already set up for you, and you can read it now without
    logging in. Week 1 is the one to skim: the building and fire exits, safeguarding, safe sleeping,
    and the policies you'll be asked to sign.
  </p>
  ${btn(inductionUrl, 'Open my induction workbook', BRAND)}
  <p style="font-size:12.5px;line-height:1.6;color:${MUTED};margin:14px 0 0">
    This link is just for you — please don't forward it${expiresNice ? `. It stops working on <b>${esc(expiresNice)}</b>` : ''}.
    If the button doesn't work, paste this into your browser:<br>
    <span style="word-break:break-all;color:${BLUE}">${esc(inductionUrl)}</span>
  </p>
</td></tr>

${documents.length ? `<tr><td style="padding:22px 28px 0">
  <h2 style="font-size:15px;margin:0 0 6px;color:${INK}">What we're sending you</h2>
  <p style="font-size:14px;line-height:1.65;color:${MUTED};margin:0 0 12px">
    No login needed, and they read fine on a phone.
  </p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
  ${documents.map(d => `<tr><td style="padding:0 0 9px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;border:1px solid ${LINE};border-radius:9px">
      <tr><td style="padding:12px 14px">
        <a href="${esc(d.url)}" style="color:${BLUE};font-weight:700;font-size:14px;text-decoration:none">${esc(d.title)}</a>${d.itemCount ? `<span style="font-size:12px;color:${MUTED}"> &middot; ${d.itemCount} points</span>` : ''}
        ${d.summary ? `<div style="font-size:13px;line-height:1.55;color:${MUTED};margin-top:4px">${esc(d.summary)}</div>` : ''}
      </td></tr>
    </table>
  </td></tr>`).join('')}
  </table>
  <p style="font-size:12.5px;line-height:1.6;color:${MUTED};margin:4px 0 0">
    The handbook has an <b>I have read this</b> button at the bottom — please tick it once you have.
    The two inductions are the ones we walk through together in person; they're here so you know
    what's coming.
  </p>
</td></tr>` : ''}

<tr><td style="padding:22px 28px 0">
  <h2 style="font-size:15px;margin:0 0 6px;color:${INK}">How you'll log in</h2>
  <p style="font-size:14px;line-height:1.65;color:${MUTED};margin:0 0 10px">
    Once you start, you'll use Wren here:<br>
    <a href="${esc(portalUrl)}" style="color:${BLUE};font-weight:700;word-break:break-all">${esc(portalUrl)}</a>
  </p>
  <div style="background:#fffaf3;border:1px solid #f3d9b8;border-left:3px solid ${BRAND};border-radius:9px;padding:12px 14px;font-size:13.5px;line-height:1.6;color:#4b5563">
    You log in with your name and a numeric PIN. <b>We do not email PINs.</b> A manager will set
    yours with you in person on your first day, and you can change it yourself afterwards.
    If anyone ever emails or messages you a Wren PIN, that did not come from us — tell a manager.
  </div>
  ${roomLeader ? `<p style="font-size:14px;line-height:1.65;color:${MUTED};margin:12px 0 0"><b style="color:${INK}">${esc(roomLeader)}</b> is your room leader, and will be signing off your induction as you go.</p>` : ''}
</td></tr>

<tr><td style="padding:22px 28px 0">
  <h2 style="font-size:15px;margin:0 0 6px;color:${INK}">One important thing before you get an account</h2>
  <div style="background:#f8fafc;border:1px solid ${LINE};border-radius:9px;padding:13px 15px;font-size:13.5px;line-height:1.65;color:#4b5563">
    Wren holds <b>children's personal data</b> — names, dates of birth, photographs, medical and
    dietary needs, safeguarding records and family contact details. Your Wren account is a
    <b>safeguarding-relevant account</b>, and <b>every action you take in it is logged against your
    name</b>, including the records you open and read. That is normal, and it protects everyone —
    children and staff alike. We're telling you now so none of it is a surprise. Please only look at
    what you need for your work, never share your login, and never take nursery data off site.
  </div>
</td></tr>

<tr><td style="padding:22px 28px 0">
  <h2 style="font-size:15px;margin:0 0 6px;color:${INK}">What happens next</h2>
  <ol style="font-size:14px;line-height:1.7;color:${MUTED};margin:0;padding-left:20px">
    <li>Open the induction link above and read through week 1.</li>
    <li>Use the <b>Fill in my details</b> button on that page to send us the bits we need for your
        file — address, emergency contact, DBS and qualification.</li>
    <li>On your first day a manager will activate your account and set your PIN with you.</li>
  </ol>
</td></tr>

<tr><td style="padding:20px 28px 26px">
  <p style="font-size:14px;line-height:1.65;color:${MUTED};margin:0 0 16px">${esc(askLine)}</p>
  <p style="font-size:14px;color:${INK};margin:0">See you soon,<br><b>${esc(setting)}</b></p>
  <p style="font-size:12px;color:${MUTED};margin:14px 0 0;border-top:1px solid ${LINE};padding-top:12px">
    ${esc(setting)} · 123 Example Lane, Your Town, AB1 2CD
  </p>
</td></tr>
</table>
</td></tr></table>
</body></html>`;

  assertNoPin(text);
  assertNoPin(html);
  return { subject, html, text };
}

/**
 * Compose + send + audit. Returns { sent, disabled, error, subject, messageId }.
 * NEVER throws — a failed welcome email must not undo the staff record, the
 * invite or the induction assignment that were created alongside it. The manager
 * gets the link back either way and the screen shows a Resend button.
 */
async function sendWelcomeEmail(to, parts, eventType = 'starter-welcome') {
  const { subject, html, text } = parts;
  let result = { sent: false, disabled: false, error: null, subject, messageId: null };
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
        // back to another transport. The audit row is the record that the email
        // was composed and would have gone.
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

  // Audit every attempt, including the dev no-send. Subject + recipient only —
  // the body is not stored (it names a real person).
  try {
    const { getPool } = require('../db/pool');
    await getPool().query(
      `INSERT INTO email_audit (direction, to_emails, subject, event_type, source, sent_ok, error)
       VALUES ('out', $1, $2, $3, $4, $5, $6)`,
      [[to], subject.slice(0, 500), eventType, source, result.sent, result.error]);
  } catch (_) { /* never block on an audit failure */ }

  return result;
}

module.exports = { composeWelcomeEmail, sendWelcomeEmail, assertNoPin, PIN_PATTERNS };
