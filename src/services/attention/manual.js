'use strict';
/**
 * manual.js — b232 collector. The things Toby types in himself.
 *
 * Manual items are written straight into attention_items by the UI, so this
 * collector does not discover anything new. It has two real jobs:
 *
 *  1. Keep them alive. The refresh resolves any item a healthy collector stopped
 *     returning. Without a collector that owns source='manual', every hand-typed
 *     item would be marked done the first time the refresh ran.
 *
 *  2. Re-colour them as their due date comes round. A manual item added three
 *     weeks out is green; the same row is amber a fortnight later and red the
 *     week it falls due, without anybody touching it. That is the whole promise
 *     of the board — a list you have to update is a list that rots.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'manual';

async function collect() {
  const db = getPool();
  const { rows } = await db.query(`
    SELECT source_key, title, detail, due_date, category, blocked_on,
           effort_minutes, action_url, evidence, sort_hint
      FROM attention_items
     WHERE source = $1 AND resolved_at IS NULL`, [SOURCE]);

  const items = rows.map(r => {
    // A hand-typed item is never statutory and never about a child's safety —
    // Toby is describing a job, not filing a concern. Its colour comes from the
    // date alone, which is what makes the ageing honest.
    const c = classify({ dueDate: r.due_date, blockedOnToby: true, informational: !r.due_date });
    return {
      source: SOURCE,
      source_key: r.source_key,
      title: r.title,
      detail: r.detail,
      why: c.why,
      rag: c.rag,
      category: r.category || 'manual',
      due_date: isoDate(r.due_date),
      blocked_on: r.blocked_on || 'toby',
      effort_minutes: r.effort_minutes,
      action_url: r.action_url,
      evidence: r.evidence || {},
      manual: true,
      sort_hint: r.sort_hint || 0,
    };
  });

  return { ok: true, items };
}

/** pg returns DATE as a JS Date; String(Date) is "Sat Sep 05", not a date. */
function isoDate(d) {
  if (!d) return null;
  if (d instanceof Date) {
    return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
  }
  return String(d).slice(0, 10);
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
