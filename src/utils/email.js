// login-20261023 — a thin adapter. Wren has ONE email sender: sendEmailDetailed in
// src/lib/notifications.js (Gmail service account first, then SMTP / n8n; the dev/MAIL_DISABLED
// hard stop; a row in email_audit for every attempt). This file used to be a second, parallel
// sender (its own SMTP transport, no audit); it now keeps its old call shape for the jobs and
// routes that use it — sendEmail({ to, subject, html, text }) — and hands the send over.
//
// Contract kept: resolves { skipped: true, reason } when nothing could or should be sent (dev,
// no transport, that email type switched off), resolves { via, ok: true } when it went, and
// THROWS on a real send failure, as nodemailer's sendMail did.

function textToHtml(text) {
  const esc = String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<pre style="font-family:inherit;white-space:pre-wrap;margin:0">${esc}</pre>`;
}

async function sendEmail({ to, subject, html, text, eventType = 'email', attachments } = {}) {
  const { sendEmailDetailed } = require('../lib/notifications');
  const r = await sendEmailDetailed(to, subject, html || textToHtml(text), eventType, attachments);
  if (r.ok) return { ok: true, via: 'shared_sender' };
  if (/test environment|no mail transport|turned off/.test(r.reason || '')) {
    return { skipped: true, disabled: /test environment/.test(r.reason || ''), reason: r.reason };
  }
  throw new Error(r.reason || 'email send failed');
}

module.exports = { sendEmail };
