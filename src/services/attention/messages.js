'use strict';
/**
 * messages.js — b232 collector. Parents who wrote and have not been answered.
 *
 * ── A NOTE ON THE TWO TABLES ────────────────────────────────────────────────
 * The brief said "ladn.message_threads / thread_messages". Those two do not join:
 * Wren has grown two separate conversation systems and they are easy to confuse.
 *
 *   message_threads → messages          the PARENTS PORTAL thread. sender_type
 *                                       is 'parent' | 'staff' | 'external'.
 *   threads         → thread_messages   the COMMS HUB thread (enquiries, email
 *                                       triage, Vapi calls). direction 'in'|'out',
 *                                       keyed to contacts, not children.
 *
 * `thread_messages.thread_id` has a foreign key to `threads`, not to
 * `message_threads` — checked, not assumed. Both are read here, as two separate
 * items, because a parent waiting is a parent waiting whichever door they used.
 *
 * ── CONTENT ─────────────────────────────────────────────────────────────────
 * Counts and thread ids. Never a subject line, never a body, never a name. "3
 * parents waiting" is the whole title, and it is enough to make somebody click.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'messages';
const WAIT_HOURS = 48;

async function collect() {
  const db = getPool();
  const items = [];

  // ── parents portal ────────────────────────────────────────────────────────
  const { rows: portal } = await db.query(`
    SELECT COUNT(*)::int AS n,
           MIN(last.created_at) AS oldest,
           ARRAY_AGG(mt.id ORDER BY last.created_at) AS thread_ids
      FROM message_threads mt
      JOIN LATERAL (
        SELECT m.sender_type, m.created_at
          FROM messages m
         WHERE m.thread_id = mt.id
         ORDER BY m.created_at DESC
         LIMIT 1
      ) last ON true
     WHERE last.sender_type = 'parent'
       AND last.created_at < now() - ($1 || ' hours')::interval`, [WAIT_HOURS]);

  if (portal[0] && portal[0].n > 0) {
    const n = portal[0].n;
    const c = classify({ blockedOnToby: true });
    items.push({
      source: SOURCE,
      source_key: 'parents-portal-unanswered',
      title: `${n} parent${n === 1 ? '' : 's'} waiting for a reply in the parents portal`,
      detail: `The longest has been waiting since ${stamp(portal[0].oldest)}. Nothing about what they said is repeated here — open Comms to read them.`,
      why: c.why,
      rag: c.rag,
      category: 'comms',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: Math.min(60, n * 5),
      action_url: '/admin/communications/messaging',
      evidence: { count: n, thread_ids: (portal[0].thread_ids || []).slice(0, 50), waited_since: stamp(portal[0].oldest), table: 'message_threads' },
      sort_hint: 2,
    });
  }

  // ── comms hub (enquiries, email, calls) ───────────────────────────────────
  const { rows: hub } = await db.query(`
    SELECT COUNT(*)::int AS n,
           MIN(last.created_at) AS oldest,
           ARRAY_AGG(t.id ORDER BY last.created_at) AS thread_ids
      FROM threads t
      JOIN LATERAL (
        SELECT tm.direction, tm.created_at
          FROM thread_messages tm
         WHERE tm.thread_id = t.id
         ORDER BY tm.created_at DESC
         LIMIT 1
      ) last ON true
     WHERE t.archived_at IS NULL
       AND last.direction = 'in'
       AND last.created_at < now() - ($1 || ' hours')::interval`, [WAIT_HOURS]);

  if (hub[0] && hub[0].n > 0) {
    const n = hub[0].n;
    const c = classify({ blockedOnToby: true });
    items.push({
      source: SOURCE,
      source_key: 'comms-hub-unanswered',
      title: `${n} inbound conversation${n === 1 ? '' : 's'} in the comms hub with no reply`,
      detail: `Enquiries, emails and calls land here. The oldest unanswered came in on ${stamp(hub[0].oldest)} — an enquiry that waits two days is usually an enquiry that goes elsewhere.`,
      why: c.why,
      rag: c.rag,
      category: 'comms',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: Math.min(60, n * 5),
      action_url: '/admin/communications/inbox',
      evidence: { count: n, thread_ids: (hub[0].thread_ids || []).slice(0, 50), waited_since: stamp(hub[0].oldest), table: 'threads' },
      sort_hint: 2,
    });
  }

  return { ok: true, items };
}

function stamp(d) {
  if (!d) return 'an unknown date';
  return new Date(d).toISOString().slice(0, 10);
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
