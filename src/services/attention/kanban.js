'use strict';
/**
 * kanban.js — b504 collector. Toby's open Kanban cards, so each job exists once.
 *
 * The Kanban board (src/routes/cockpit.js, table cockpit_cards) stays exactly as
 * it is. This collector mirrors every card that is not in the `done` column into
 * the My-list store (attention_items) as source 'kanban', key 'card-<id>'.
 *   - tick the card in the Kanban  -> it leaves this collector's output and the
 *     refresh auto-resolves the item (rule 2/3 in index.js);
 *   - tick the item in My list      -> PATCH writes through to the card
 *     (cockpit_cards.col = 'done'); see src/routes/attention.js.
 *
 * Cards given to the agents (Hermes / Claude) are Claude's jobs, not Toby's:
 * blocked_on 'claude', no owner. A card with no date that nobody has touched for
 * 30 days is parked on first insert (lane 'later' + parked_at); never deleted.
 * `priority` is never copied into rag. Card detail is not copied at all.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'kanban';
const TOBY = 1;
const STALE_DAYS = 30;

async function collect() {
  const db = getPool();
  let rows;
  try {
    ({ rows } = await db.query(`
      SELECT id, title, col, priority, source, assignee, tags,
             estimated_minutes, needs_onsite, hard_deadline, due_date, updated_at,
             (updated_at < now() - interval '${STALE_DAYS} days') AS stale
        FROM cockpit_cards
       WHERE col <> 'done'`));
  } catch (e) {
    return { ok: false, items: [], note: `cockpit_cards unreadable: ${e.message}` };
  }

  const items = rows.map(r => {
    const real = isoDate(r.hard_deadline || r.due_date);
    const agent = /^(hermes|claude)/i.test(String(r.assignee || '')) || r.source === 'hermes';
    const c = classify({ dueDate: real, blockedOnToby: !agent, informational: !real });
    const tags = Array.isArray(r.tags) ? r.tags.slice() : [];
    if (r.needs_onsite) tags.push('onsite');
    const parkOnInsert = !real && r.stale && !agent;
    return {
      source: SOURCE,
      source_key: `card-${r.id}`,
      title: r.title,
      detail: null,
      why: c.why,
      rag: c.rag,
      category: 'kanban',
      due_date: real,
      blocked_on: agent ? 'claude' : 'toby',
      effort_minutes: r.estimated_minutes,
      action_url: '/admin/cockpit/kanban',
      evidence: { card_id: r.id, col: r.col, priority: r.priority },
      manual: false,
      extra_on_insert: Object.assign(
        { kind: 'job', owner_staff_id: agent ? null : TOBY, tags },
        parkOnInsert ? { lane: 'later', parked_at: new Date() } : {}),
    };
  });
  return { ok: true, items };
}

function isoDate(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  return String(d).slice(0, 10);
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
