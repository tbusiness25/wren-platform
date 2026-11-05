'use strict';
/**
 * inbox-classify-job.js — b486c (2026-10-13, CHECK.md defect 6)
 *
 * Background, bounded-batch sweep that runs the MODEL step of inbox-sections.js's
 * classifier for comms_email_queue rows the fast, in-request pass (comms.js's
 * GET /emails, useModel:false) left at section IS NULL. That in-request pass only
 * ever runs rules/known-sender/routing-topic — free, in-process steps — specifically
 * so a page load never waits on Ascent; whatever those three steps can't resolve
 * needs the model, and the model runs here instead, off the request path.
 *
 * Mirrors b486b's draft_claimed_at pattern (inbox-draft-job.js / inbox-hermes.js's
 * attemptDraft): section_claimed_at stops this sweep and any other caller
 * double-classifying the same row, and a crashed run's claim ages out (15 min)
 * rather than wedging the row forever. Unlike inbox-draft-job.js this has no
 * on-demand API route — it rides gmail-inbox-poller.js's existing 8-minute
 * interval (same reasoning as that file's own retry-sweep: one scheduler, not two).
 */
const sections = require('../lib/inbox-sections');

const BATCH = parseInt(process.env.INBOX_CLASSIFY_BATCH || '20', 10);
const CLAIM_STALE_MINUTES = 15;

let running = false;

/** Clear any claim left by a process that no longer exists — call once at boot. */
async function clearStaleClaims(db) {
  await db.query(`UPDATE comms_email_queue SET section_claimed_at = NULL WHERE section_claimed_at IS NOT NULL`);
}

/**
 * One bounded pass: claim up to BATCH still-NULL-section rows (oldest claim/
 * never-claimed first) and classify each with the model. Best-effort per row —
 * one failure never stops the batch.
 */
async function sweepOnce(db) {
  if (running) return { skipped: 'already_running' };
  running = true;
  try {
    const { rows: claimed } = await db.query(
      `UPDATE comms_email_queue SET section_claimed_at = now()
         WHERE id IN (
           SELECT id FROM comms_email_queue
            WHERE section IS NULL AND direction = 'in'
              AND (section_claimed_at IS NULL OR section_claimed_at < now() - interval '${CLAIM_STALE_MINUTES} minutes')
            ORDER BY received_at DESC
            LIMIT ${BATCH}
            FOR UPDATE SKIP LOCKED
         )
         RETURNING id, from_email, from_name, subject, body_text, snippet, topic`);

    let classified = 0, failed = 0, unavailable = 0, consecutiveUnavailable = 0;
    for (const row of claimed) {
      // review 2026-10-13: two unanswered rows in a row means the model is down or hung — stop
      // here (the rest of the batch is released below) instead of burning 45s x batch on it.
      if (consecutiveUnavailable >= 2) {
        try { await db.query(`UPDATE comms_email_queue SET section_claimed_at = NULL WHERE id = $1`, [row.id]); } catch (_) {}
        continue;
      }
      try {
        // skipFallbackWrite: when the model gives no answer the row stays NULL (retried next
        // sweep) — writing section='other'/'fallback' here made it permanent, since this sweep
        // only ever selects section IS NULL.
        const v = await sections.classifyRow(db, row, { useModel: true, skipFallbackWrite: true });
        if (v && v.source === 'fallback') { unavailable++; consecutiveUnavailable++; }
        else { classified++; consecutiveUnavailable = 0; }
      } catch (e) {
        failed++;
        console.error(`[inbox-classify-job] classify failed id=${row.id}:`, e.message);
      } finally {
        // Release the claim regardless of outcome — classifyRow() writes
        // section on success; on failure the row stays NULL but free to retry
        // next sweep rather than waiting out the full staleness window.
        try { await db.query(`UPDATE comms_email_queue SET section_claimed_at = NULL WHERE id = $1`, [row.id]); } catch (_) {}
      }
    }
    return { claimed: claimed.length, classified, failed, unavailable };
  } catch (e) {
    console.error('[inbox-classify-job] sweep failed:', e.message);
    return { error: e.message };
  } finally {
    running = false;
  }
}

module.exports = { sweepOnce, clearStaleClaims };
