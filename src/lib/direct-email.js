'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b341 — send ONE email straight through the Gmail transport, and record it.
//
// Why not notifications.sendEmail: on a *_dev database sendViaGmail returns
// { disabled:true } and sendEmail then FALLS THROUGH to SMTP and to N8N_EMAIL_WEBHOOK, which
// is set on wren-ladn-dev — so a "dev can't send email" build can still send through the live
// n8n. This helper treats `disabled` as a terminal outcome instead
// (memory/reference_dev_mail_guard_n8n_fallthrough.md). Same shape as
// src/lib/starter-welcome.js sendWelcomeEmail.
//
// The audit row stores recipient + subject only. The body is not kept: it names a child.
//
// Callers are parent-initiated actions only (the parent pressed the button). Nothing here
// may be wired to a cron or a workflow — see wren-docs/decisions/2026-09-08-no-auto-parent-email.md.
// ─────────────────────────────────────────────────────────────────────────────

async function sendDirectEmail({ to, subject, html, text, eventType }) {
  const result = { sent: false, disabled: false, error: null, messageId: null };
  let source = 'gmail_api';
  try {
    const gmail = require('./gmail-sender');
    if (!gmail.isConfigured()) {
      result.error = 'Gmail service account not configured';
      source = 'not_configured';
    } else {
      const r = await gmail.sendViaGmail({ to, subject, html, text, fromName: 'Your Nursery' });
      if (r && r.disabled) {
        result.disabled = true;               // dev / MAIL_DISABLED: correct behaviour — do not defeat it
        source = 'gmail_api_disabled';
      } else if (r && r.ok) {
        result.sent = true;
        result.messageId = r.messageId || null;
      } else {
        result.error = 'send returned no confirmation';
        source = 'gmail_api_error';
      }
    }
  } catch (e) {
    result.error = e.message;
    source = 'gmail_api_error';
  }
  try {
    const { getPool } = require('../db/pool');
    await getPool().query(
      `INSERT INTO email_audit (direction, to_emails, subject, event_type, source, sent_ok, error)
       VALUES ('out', $1, $2, $3, $4, $5, $6)`,
      [[to], String(subject || '').slice(0, 500), eventType || 'direct', source, result.sent, result.error]);
  } catch (_) { /* never block on an audit failure */ }
  return result;
}

module.exports = { sendDirectEmail };
