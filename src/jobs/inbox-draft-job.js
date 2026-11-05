'use strict';
/**
 * inbox-draft-job.js — b486 (2026-10-12)
 *
 * The "Draft replies" button's background job. One at a time, local model only,
 * never blocks the request that started it — the route POSTs to start it and
 * polls this module's status() for live progress ("Drafting 3 of 12…").
 *
 * In-memory only: a single wren-ladn(-dev) process is the only consumer, same
 * assumption gmail-inbox-poller.js's own setInterval already makes. If the
 * process restarts mid-run the job is simply gone — nothing was left half-written
 * because attemptDraft()'s fill rule is idempotent (it only ever fills an empty
 * column), so pressing the button again just picks up where it left off.
 */
const hermes = require('./../lib/inbox-hermes');

const NOREPLY = /(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?@|bounce)/i;
const CLOSED_STATUS = ['sent', 'ignored'];

let job = {
  running: false, total: 0, done: 0, current: null,
  startedAt: null, finishedAt: null,
  summary: { drafted: 0, kept_existing: 0, failed: 0, skipped_noreply: 0 },
  error: null,
};

function status() { return job; }

/**
 * Candidates: open inbound email in an allowed mailbox with no usable draft yet
 * (exactly the inbox-redraft.js rule — neither suggested_draft nor draft_text set).
 */
async function _candidates(db, mailboxes, limit) {
  const { rows } = await db.query(`
    SELECT id FROM comms_email_queue
     WHERE direction = 'in' AND mailbox = ANY($1)
       AND coalesce(status, '') <> ALL($2)
       AND coalesce(action_state, '') <> 'done'
       AND coalesce(suggested_draft, '') = '' AND coalesce(draft_text, '') = ''
     ORDER BY received_at DESC LIMIT $3`, [mailboxes, CLOSED_STATUS, limit]);
  return rows.map(r => r.id);
}

async function run(db, { mailboxes, staffId, limit = 200, summaryOnly = false } = {}) {
  if (job.running) return job;
  job = {
    running: true, total: 0, done: 0, current: null,
    startedAt: new Date().toISOString(), finishedAt: null,
    summary: { drafted: 0, kept_existing: 0, failed: 0, skipped_noreply: 0 },
    error: null,
  };

  try {
    const ids = await _candidates(db, mailboxes, limit);
    job.total = ids.length;

    for (const id of ids) {
      let row = null;
      try {
        const { rows } = await db.query('SELECT * FROM comms_email_queue WHERE id=$1', [id]);
        row = rows[0] || null;
      } catch (_) {}
      if (!row) { job.done++; continue; }

      job.current = { id: row.id, subject: row.subject || '(no subject)' };

      if (NOREPLY.test(row.from_email || '')) {
        job.summary.skipped_noreply++; job.done++; continue;
      }

      // b486c (2026-10-13, CHECK.md defect 7): this used to always ask for a
      // full draft here, reasoning that "Draft replies" is an explicit,
      // on-demand request independent of the automatic inbox_hermes_summary_only
      // mode. That reasoning was wrong per the brief: "Summaries only" must mean
      // summaries only everywhere, including this button — the route now 409s
      // outright when the mode is "Off" (see POST /inbox/draft-replies), and
      // passes the current mode's summaryOnly through here for everything else.
      // force:true (b486b, D1) so a row still marked claimed by a crashed
      // previous run (see this file's header) is picked up now rather than waited out.
      try {
        const r = await hermes.attemptDraft(db, row, { staffId: staffId || null, summaryOnly, force: true });
        if (r.ok) { if (r.draftFilled) job.summary.drafted++; else job.summary.kept_existing++; }
        else job.summary.failed++;
      } catch (_) {
        job.summary.failed++;
      }
      job.done++;
    }
  } catch (e) {
    job.error = e.message;
  } finally {
    job.running = false;
    job.current = null;
    job.finishedAt = new Date().toISOString();
  }
  return job;
}

module.exports = { run, status };
