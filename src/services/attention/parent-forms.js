'use strict';
/**
 * parent-forms.js — b343 collector for the "What needs me" board.
 *
 * Two cards, never one per form and never one per child (Toby: do not spam the board):
 *
 *   1. Forms a parent was asked to sign more than a week ago and has not. One card, whatever the number.
 *      It is only ever a chase-up: nothing is blocked on it (the app never locks a parent out), but a medicine or accident
 *      form nobody has acknowledged for a week is a gap worth a phone call. Amber, "overdue" from the seventh day.
 *   2. Funded children with no parental declaration on file for the current term. One card. This is the number Toby asked
 *      about (17 of 26 for Autumn 2026): the funding claim to the council cannot be made without them, so the app now asks the
 *      families itself and this card is the office's count of what is still outstanding.
 *
 * CONTENT: counts and kinds only, like every collector here. Never a name, never an address — the cards link to the office
 * screens where the access checks live. A card goes away by itself when the count reaches zero.
 */
const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'parent-forms';
const WEEK_MS = 7 * 24 * 3600 * 1000;

async function collect() {
  const db = getPool();
  const items = [];

  // ── 1. unsigned forms, a week or more old ───────────────────────────────────
  let stale = [];
  try {
    const { rows } = await db.query(`
      SELECT r.form_kind, count(*)::int AS n, min(r.first_seen_at) AS oldest
        FROM parent_form_requests r
        JOIN children c ON c.id = r.child_id
       WHERE r.superseded_at IS NULL AND COALESCE(c.is_active, true) = true
         AND r.first_seen_at < now() - interval '7 days'
         AND NOT EXISTS (SELECT 1 FROM parent_form_signatures s WHERE s.request_id = r.id)
       GROUP BY r.form_kind`);
    stale = rows;
  } catch (e) {
    if (e.code !== '42P01') return { ok: false, note: `parent forms: ${e.message}` };   // 42P01 = the migration has not run: there is nothing to look at, which is not an error
  }
  if (stale.length) {
    const total = stale.reduce((a, r) => a + r.n, 0);
    const oldest = stale.reduce((m, r) => (m == null || new Date(r.oldest) < m ? new Date(r.oldest) : m), null);
    const dueDate = new Date(oldest.getTime() + WEEK_MS).toISOString().slice(0, 10);
    const c = classify({ dueDate });
    const kinds = stale.map(r => `${r.n} ${r.form_kind.replace(/_/g, ' ')}`).join(', ');
    items.push({
      source: SOURCE,
      source_key: 'unsigned-over-7-days',
      title: `${total} form${total === 1 ? '' : 's'} waiting more than a week for a parent's signature`,
      detail: `${kinds}. The app keeps asking the families and never locks anyone out; this is the office's list to chase by phone or at the door. `
            + 'Some may be for a family with no login (the "cannot see their child" card).',
      why: c.why,
      rag: c.rag,
      category: 'family',
      due_date: dueDate,
      blocked_on: null,
      effort_minutes: 15,
      action_url: '/parent-forms.html',
      evidence: { total, by_kind: Object.fromEntries(stale.map(r => [r.form_kind, r.n])), table: 'parent_form_requests' },
      sort_hint: 3,
    });
  }

  // ── 2. funded children with no declaration for the current term ─────────────
  try {
    const { rows: [t] } = await db.query(
      `SELECT id, name FROM funding_terms
        ORDER BY (is_current IS TRUE) DESC, (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC LIMIT 1`);
    if (t) {
      const { rows: [n] } = await db.query(`
        SELECT count(*)::int AS outstanding,
               (SELECT count(*)::int FROM child_funding f2 WHERE f2.term_id = $1 AND COALESCE(f2.funding_type,'none') <> 'none') AS funded
          FROM child_funding cf
         WHERE cf.term_id = $1 AND COALESCE(cf.funding_type, 'none') <> 'none'
           AND COALESCE(cf.declaration_signed, false) = false
           AND NOT EXISTS (SELECT 1 FROM funding_declarations d WHERE d.child_id = cf.child_id AND d.term_id = cf.term_id AND d.status = 'signed')`, [t.id]);
      if (n && n.outstanding > 0) {
        const c = classify({ blockedOnToby: true });
        items.push({
          source: SOURCE,
          source_key: `declarations-${t.id}`,
          title: `${n.outstanding} of ${n.funded} funded children have no parental declaration for ${t.name}`,
          detail: 'Families with a funded child are asked for it in the app (a card on their home screen). The council claim cannot be made without it. '
                + 'Open the Declarations tab to see who is outstanding, re-send the request, or record a paper one.',
          why: c.why,
          rag: c.rag,
          category: 'finance',
          due_date: null,
          blocked_on: 'toby',
          effort_minutes: 10,
          action_url: '/funding.html?full=1&tab=declarations',
          evidence: { term_id: t.id, outstanding: n.outstanding, funded: n.funded, table: 'child_funding' },
          sort_hint: 3,
        });
      }
    }
  } catch (e) {
    return { ok: false, note: `funding declarations: ${e.message}` };
  }

  return { ok: true, items };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
