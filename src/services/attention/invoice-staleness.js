'use strict';
/**
 * invoice-staleness.js — b535 (2026-10-29) collector for the "What needs me" board.
 *
 * ONE card, when invoices no longer match today's figures: "4 invoices no longer match
 * what Wren would bill today". Never one card per invoice — the Invoices chip is where
 * the list belongs, and a board with a card per bill is a board nobody opens.
 *
 * This is the whole point of b535 on the board: on 29 October four invoices went out at
 * the wrong day rate, the office manager spotted it, and nothing in Wren had. Now something does.
 *
 * CONTENT: counts, money and the billing months only. No child name, no invoice number,
 * no line of any bill — opening Finance → Invoices is where that lives, behind its own
 * access checks (the same rule every other collector in this directory follows).
 *
 * Idle rather than failing when it cannot look: a tenant whose invoices table is not
 * there yet, or a pricing error, answers "nothing to report" instead of emptying the
 * board (rule 2 of the refresh — ok:false resolves nothing, but a thrown error would
 * bubble, and the board's job is to be trusted).
 */
const { getPool } = require('../../db/pool');
const { classify } = require('./rag');
const PRICING = require('../../lib/invoice-pricing');

const SOURCE = 'invoice-staleness';

async function collect() {
  const db = getPool();
  let scan;
  try {
    scan = await PRICING.staleScan(db, { limit: 400 });
  } catch (e) {
    if (e.code === '42P01') return { ok: true, items: [], note: 'invoices table not present' };
    // "I could not look" is not "there is nothing there".
    return { ok: false, items: [], note: e.message };
  }
  if (!scan.count) return { ok: true, items: [] };

  const n = scan.count;
  const sent = scan.invoices.filter(r => r.seen_by_family).length;
  const paid = scan.invoices.filter(r => r.paid).length;
  const months = [...new Set(scan.invoices.map(r => r.period))].sort();
  const money = (p) => (p < 0 ? '-£' : '£') + (Math.abs(p) / 100).toFixed(2);

  // Amber, not red: the bills are wrong but the fix is a few clicks and nothing has been
  // emailed by Wren on the strength of them. It is blocked on a person, so it is Toby's.
  const c = classify({ blockedOnToby: true });
  return {
    ok: true,
    items: [{
      source: SOURCE,
      source_key: 'invoices-out-of-date',
      title: n === 1
        ? 'One invoice no longer matches what Wren would bill today'
        : `${n} invoices no longer match what Wren would bill today`,
      detail: `${months.length === 1 ? months[0] : months.join(', ')}. `
            + `${sent ? `${sent} of them have already gone to the family${paid ? `, ${paid} already paid` : ''}. ` : 'None has been sent yet. '}`
            + `Together they are ${money(scan.total_diff_pence)} out. `
            + 'Open Finance → Invoices and press "Out of date" — an unsent one is updated in place, '
            + 'a sent one is reissued (credit note plus a replacement, raised unsent), or the difference '
            + 'goes on the next invoice. Nothing is emailed by any of those buttons.',
      why: c.why,
      rag: c.rag,
      category: 'money',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: Math.min(45, 3 + 3 * n),
      action_url: '/money.html#invoices',
      evidence: {
        out_of_date: n, scanned: scan.scanned, sent, paid,
        total_diff_pence: scan.total_diff_pence, months,
        unpriceable: scan.unpriceable, from: scan.from,
      },
      sort_hint: 3,
    }],
  };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
