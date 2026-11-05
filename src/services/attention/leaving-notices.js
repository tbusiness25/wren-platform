'use strict';
/**
 * leaving-notices.js — b341 collector for the "What needs me" board.
 *
 *   1. A family gave notice (or changed their last day) in the parents app and no manager has
 *      acknowledged it yet. One card per notice.
 *   2. A family asked for their memory book and it came back empty — the media has not synced.
 *      One card per child, gone as soon as the child has a book that holds media.
 *
 * ── CONTENT ─────────────────────────────────────────────────────────────────
 * Ids, counts and dates only, like every collector here. Never a child's name, never a parent's
 * name or address: the card links to the child profile, where the access checks live.
 *
 * A notice is business, not statute, so it is amber ("blocked on Toby": fees, funding, the rota
 * and the waiting list all change). It stays until somebody clicks Acknowledge on the profile.
 */
const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'leaving';

async function collect() {
  const db = getPool();
  const items = [];

  const { rows: notices } = await db.query(`
    SELECT n.id, n.child_id, n.is_revision, n.short_notice,
           to_char(n.given_on, 'YYYY-MM-DD')        AS given_on,
           to_char(n.chosen_last_day, 'YYYY-MM-DD') AS chosen_last_day,
           to_char(n.fees_run_to, 'YYYY-MM-DD')     AS fees_run_to
      FROM child_leaving_notices n
     WHERE NOT EXISTS (SELECT 1 FROM child_leaving_notice_acks a WHERE a.notice_id = n.id)
       AND n.given_at > now() - interval '120 days'
     ORDER BY n.given_at`);
  for (const n of notices) {
    const c = classify({ blockedOnToby: true });
    items.push({
      source: SOURCE,
      source_key: `notice-${n.id}`,
      title: n.is_revision
        ? `A family has changed their child's last day to ${n.chosen_last_day}`
        : `A family gave notice in the app — last day ${n.chosen_last_day}`,
      detail: `Given on ${n.given_on}${n.short_notice ? ', before the end of the notice period (fees still run to ' + n.fees_run_to + ')' : ''}. `
            + 'Open the child profile to see who, then acknowledge it. Fees, funding, the rota and the waiting list all depend on it.',
      why: c.why,
      rag: c.rag,
      category: 'family',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 10,
      action_url: `/child-profile.html?id=${n.child_id}`,
      evidence: { notice_id: n.id, child_id: n.child_id, table: 'child_leaving_notices' },
      sort_hint: 2,
    });
  }

  // A book is "delivered" once the child has an active package that holds media. A no_media request is
  // only still a problem while that is not true.
  const { rows: empty } = await db.query(`
    SELECT r.child_id, count(*)::int AS attempts, to_char(max(r.created_at), 'YYYY-MM-DD') AS last_asked
      FROM keepsake_requests r
     WHERE r.outcome = 'no_media' AND r.created_at > now() - interval '30 days'
       AND NOT EXISTS (SELECT 1 FROM leavers_gift_packages g
                        WHERE g.child_id = r.child_id AND g.status = 'active' AND g.media_count > 0)
     GROUP BY r.child_id`);
  for (const e of empty) {
    const c = classify({ blockedOnToby: true });
    items.push({
      source: SOURCE,
      source_key: `keepsake-empty-${e.child_id}`,
      title: 'A family asked for their memory book and it came back empty',
      detail: `Asked ${e.attempts} time${e.attempts === 1 ? '' : 's'}, most recently on ${e.last_asked}. Nothing was made and the family was told it is being gathered. `
            + 'Check the EyLog media sync for this child, then make the book in Roost.',
      why: c.why,
      rag: c.rag,
      category: 'family',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 15,
      action_url: `/child-profile.html?id=${e.child_id}`,
      evidence: { child_id: e.child_id, attempts: e.attempts, table: 'keepsake_requests' },
      sort_hint: 2,
    });
  }

  return { ok: true, items };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
