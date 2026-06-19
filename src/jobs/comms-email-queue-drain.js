// Comms email queue drain — delivers queued outbound emails in ladn.comms_email_queue.
//
// BACKGROUND: survey-invite / survey-reminder rows (and any outbound comms) are
// INSERTed into ladn.comms_email_queue with status='pending' by src/routes/survey.js.
// Before this worker existed, nothing ever delivered them — they sat 'pending'
// forever (that is why parents never received the survey). This worker drains the
// queue via the shared sendEmail() transport (SMTP if configured, else the n8n
// Gmail relay webhook via N8N_EMAIL_WEBHOOK), marks rows 'sent', and records
// errors + retry attempts.
//
// Runs every 2 minutes via setInterval in server-unified.js. Mirrors the pattern
// of notification-queue-drain.js. Append-only / additive — does not touch any
// existing route or the inbound-triage tables.
'use strict';

const { getPool }   = require('../db/pool');
const { sendEmail } = require('../lib/notifications');

const MAX_ATTEMPTS = 5;       // give up after this many failures
const BATCH_LIMIT  = 25;      // emails per tick — gentle, avoids bursting

// Classifications this worker is allowed to SEND. Inbound-triage style rows
// (where from_email is an external sender and there is no to_email) are NOT sent.
const OUTBOUND_CLASSES = ['survey-invite', 'survey-reminder', 'newsletter', 'outbound', 'comms-outbound'];

async function drainEmailQueue() {
  const db = getPool();
  let rows = [];
  try {
    const result = await db.query(
      `SELECT id, to_email, from_email, from_name, subject, body_html, draft_text, body_text,
              classification, send_attempts
         FROM ladn.comms_email_queue
        WHERE status = 'pending'
          AND send_attempts < $1
          AND ( classification = ANY($2::text[]) OR to_email IS NOT NULL )
        ORDER BY received_at ASC
        LIMIT $3`,
      [MAX_ATTEMPTS, OUTBOUND_CLASSES, BATCH_LIMIT]
    );
    rows = result.rows;
  } catch (e) {
    console.error('[email-queue-drain] query failed:', e.message);
    return;
  }

  if (rows.length === 0) return;
  console.log(`[email-queue-drain] processing ${rows.length} pending outbound email(s)`);

  for (const row of rows) {
    // Recipient: prefer explicit to_email; survey path overloads from_email as the recipient.
    const recipient = (row.to_email || row.from_email || '').trim();
    const subject   = row.subject || 'Your Nursery';
    const html      = row.body_html
      || (row.draft_text ? `<p>${String(row.draft_text).replace(/\n/g, '<br>')}</p>` : null)
      || (row.body_text  ? `<p>${String(row.body_text).replace(/\n/g, '<br>')}</p>`  : null)
      || '';

    // Guard: must look like an email address, must have a body.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(recipient) || !html) {
      await db.query(
        `UPDATE ladn.comms_email_queue
            SET status='error', last_error=$2, send_attempts=send_attempts+1, handled_at=NOW()
          WHERE id=$1`,
        [row.id, !recipient ? 'no valid recipient' : 'empty body']
      ).catch(() => {});
      console.error(`[email-queue-drain] skip id=${row.id} (bad recipient/body)`);
      continue;
    }

    try {
      const ok = await sendEmail(recipient, subject, html, 'comms_outbound');
      if (ok) {
        await db.query(
          `UPDATE ladn.comms_email_queue
              SET status='sent', sent_at=NOW(), handled_at=NOW(),
                  send_attempts=send_attempts+1, last_error=NULL
            WHERE id=$1`,
          [row.id]
        );
        console.log(`[email-queue-drain] sent id=${row.id} -> ${recipient} (${row.classification})`);
      } else {
        // sendEmail returned false: no transport configured or relay failed.
        await db.query(
          `UPDATE ladn.comms_email_queue
              SET send_attempts=send_attempts+1,
                  last_error='sendEmail returned false (no transport configured or relay failed)',
                  status = CASE WHEN send_attempts+1 >= $2 THEN 'error' ELSE status END
            WHERE id=$1`,
          [row.id, MAX_ATTEMPTS]
        );
        console.error(`[email-queue-drain] not delivered id=${row.id} (no transport / relay failed)`);
      }
    } catch (e) {
      await db.query(
        `UPDATE ladn.comms_email_queue
            SET send_attempts=send_attempts+1, last_error=$2,
                status = CASE WHEN send_attempts+1 >= $3 THEN 'error' ELSE status END
          WHERE id=$1`,
        [row.id, e.message, MAX_ATTEMPTS]
      ).catch(() => {});
      console.error(`[email-queue-drain] failed id=${row.id}:`, e.message);
    }
  }
}

function startEmailQueueDrain() {
  drainEmailQueue().catch(e => console.error('[email-queue-drain] initial run:', e.message));
  setInterval(() => {
    drainEmailQueue().catch(e => console.error('[email-queue-drain] interval:', e.message));
  }, 2 * 60 * 1000); // 2 minutes
  console.log('[email-queue-drain] comms email queue drain started (2min interval)');
}

module.exports = { drainEmailQueue, startEmailQueueDrain };
