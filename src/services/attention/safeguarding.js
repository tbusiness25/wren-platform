'use strict';
/**
 * safeguarding.js — b232 collector. Always RED, and never a word of content.
 *
 * ── THE RULE THIS FILE EXISTS TO KEEP ───────────────────────────────────────
 * Counts and ids only. No child name, no category, no subcategory, no
 * description, no DSL note — not in a title, not in a detail line, not in the
 * evidence blob. The board is a manager's landing screen; a safeguarding concern
 * is not something that should be readable over a shoulder, and the item's whole
 * job is to say "go and look", not to say what there is to look at.
 *
 * Every query below selects COUNT() or id. If you add one, keep it that way.
 *
 * classify() is called with childSafety:true throughout, so these are red by the
 * rules rather than by a hard-coded colour.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'safeguarding';
const URL = '/admin/safeguarding/concerns';

// Statuses that mean "still live". Anything else is finished with.
const OPEN_STATUSES = ['new', 'under_review', 'open', 'escalated', 'monitoring'];

async function collect() {
  const db = getPool();
  const items = [];

  // ── open concerns ─────────────────────────────────────────────────────────
  const { rows: open } = await db.query(`
    SELECT COUNT(*)::int AS n,
           MIN(concern_date)::date AS oldest,
           ARRAY_AGG(id ORDER BY concern_date) AS ids
      FROM safeguarding_concerns
     WHERE COALESCE(status,'new') = ANY($1) AND closed_at IS NULL`, [OPEN_STATUSES]);

  if (open[0] && open[0].n > 0) {
    const n = open[0].n;
    const c = classify({ childSafety: true });
    items.push({
      source: SOURCE,
      source_key: 'open-concerns',
      title: `${n} safeguarding concern${n === 1 ? '' : 's'} still open`,
      detail: `The oldest was raised on ${iso(open[0].oldest)}. Open the safeguarding log to see them — nothing about them is repeated here on purpose.`,
      why: c.why,
      rag: c.rag,
      category: 'safeguarding',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 20,
      action_url: URL,
      evidence: { concern_ids: (open[0].ids || []).slice(0, 50), oldest: iso(open[0].oldest) },
      sort_hint: 0,
    });
  }

  // ── escalations whose clock has run out ───────────────────────────────────
  const { rows: esc } = await db.query(`
    SELECT COUNT(*)::int AS n, ARRAY_AGG(id) AS ids
      FROM safeguarding_concerns
     WHERE escalation_due_at IS NOT NULL
       AND escalation_due_at < now()
       AND escalated_at IS NULL
       AND closed_at IS NULL`);
  if (esc[0] && esc[0].n > 0) {
    const c = classify({ childSafety: true, statutory: true, dueDate: new Date(Date.now() - 86400000) });
    items.push({
      source: SOURCE,
      source_key: 'escalations-overdue',
      title: `${esc[0].n} safeguarding escalation${esc[0].n === 1 ? '' : 's'} past the deadline and not escalated`,
      detail: 'The escalation window on these has closed and no onward referral is recorded. This is the one on the board that cannot wait for tomorrow.',
      why: c.why,
      rag: c.rag,
      category: 'safeguarding',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 30,
      action_url: URL,
      evidence: { concern_ids: (esc[0].ids || []).slice(0, 50) },
      sort_hint: -1,   // ahead of everything else in its colour
    });
  }

  // ── raised but never seen by the DSL ──────────────────────────────────────
  const { rows: unsigned } = await db.query(`
    SELECT COUNT(*)::int AS n, ARRAY_AGG(id) AS ids
      FROM safeguarding_concerns
     WHERE dsl_signoff_at IS NULL
       AND closed_at IS NULL
       AND concern_date < now() - interval '7 days'`);
  if (unsigned[0] && unsigned[0].n > 0) {
    const c = classify({ childSafety: true });
    items.push({
      source: SOURCE,
      source_key: 'awaiting-dsl-signoff',
      title: `${unsigned[0].n} concern${unsigned[0].n === 1 ? '' : 's'} raised over a week ago with no DSL sign-off`,
      detail: 'A concern with no sign-off has no recorded decision. The record, not the memory, is what an inspector reads.',
      why: c.why,
      rag: c.rag,
      category: 'safeguarding',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 15,
      action_url: '/admin/safeguarding/sign-off-queue',
      evidence: { concern_ids: (unsigned[0].ids || []).slice(0, 50) },
      sort_hint: 0,
    });
  }

  return { ok: true, items };
}

function iso(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }

module.exports = { name: SOURCE, owns: [SOURCE], collect };
