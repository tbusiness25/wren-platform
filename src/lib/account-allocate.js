'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-28 — the account works like EyLog's (Toby: "if the child had £20 in credit and
// they made a payment of £60 it automatically just puts a credit of £80, or if they were
// at minus £500 and paid £700 they'd be plus £200 … the balance is always the tally").
//
// The ledger (family-ledger.js) has always been the tally. What lagged behind it was the
// per-invoice view: money only reached a bill when the bill was emailed, a payment was
// only ever put on a bill whole (a £60 payment never paid £50 of one bill and left £10 as
// credit), and an overpaid bill kept its extra. So invoices said "owed" while the family
// was in credit, and the other way round.
//
// allocateAccount(): every penny of the family's money on account goes onto their open
// bills, OLDEST BILL FIRST, split across bills as needed (payment_allocations rows), and
// whatever is left stays as credit for the next bill. A settled bill is marked paid; a
// bill that is "paid" but no longer covered goes back to sent. Same rules as the ledger:
//   • only bills the ledger counts (EyLog history before the opening balance never gets
//     money put on it);
//   • never EyLog's own imported payments (their effect is inside the opening balance);
//   • a payment already tied to one bill (Reconcile, card) stays on that bill; only what
//     it paid OVER that bill becomes credit.
// Idempotent: running it twice changes nothing the second time.
// ─────────────────────────────────────────────────────────────────────────────

const { outstandingSql, familyChildIds } = require('./invoice-outstanding');
const { familyLedger } = require('./family-ledger');

const sch = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s || '')) throw new Error('bad schema'); return s; };

async function allocateAccount(db, childId, { schema = 'ladn', dryRun = false } = {}) {
  const S = sch(schema);
  const ids = await familyChildIds(db, childId, S);
  const L = await familyLedger(db, ids, { schema: S });
  // The bills the tally counts (not history, not credit notes, not written off).
  const countedIds = (L.transactions || [])
    .filter((t) => t.kind === 'invoice' && Number(t.amount_pence) > 0 && t.type !== 'Credit note')
    .map((t) => t.id);
  const out = { family: ids, allocations: 0, pence: 0, paid: 0, reopened: 0, overpaid_split: 0 };
  if (!countedIds.length) return out;

  const client = dryRun ? db : await db.connect();
  try {
    if (!dryRun) await client.query('BEGIN');

    // 1. A payment tied whole to one bill that it OVERPAYS: keep the bill's share on the
    //    bill (as an allocation) so the extra is free to become credit.
    const { rows: over } = await client.query(`
      SELECT p.id AS payment_id, p.child_id, p.amount_pence, i.id AS invoice_id, ${outstandingSql('i', S)}::int AS owed
        FROM ${S}.payments p JOIN ${S}.invoices i ON i.id = p.invoice_id
       WHERE i.id = ANY($1::int[]) AND p.status = 'succeeded' AND p.amount_pence > 0
         AND NOT EXISTS (SELECT 1 FROM ${S}.payment_allocations a WHERE a.payment_id = p.id)
         AND ${outstandingSql('i', S)} < 0`, [countedIds]);
    for (const o of over) {
      const keep = Number(o.amount_pence) + Number(o.owed); // what the bill needed from this payment
      if (keep <= 0 || keep >= Number(o.amount_pence)) continue;
      if (!dryRun) await client.query(
        `INSERT INTO ${S}.payment_allocations (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference)
         VALUES ($1, $2, $3, $4, CURRENT_DATE, 'auto-allocate', 'Paid more than this bill — the rest is credit on account')`,
        [o.payment_id, o.invoice_id, o.child_id, keep]);
      out.overpaid_split++;
    }

    // 2. The family's free money, oldest first: payments not tied to a bill, plus what is
    //    left of any payment after its allocations.
    const { rows: money } = await client.query(`
      SELECT p.id, p.child_id, p.amount_pence,
             p.amount_pence - COALESCE((SELECT SUM(a.amount_pence) FROM ${S}.payment_allocations a WHERE a.payment_id = p.id), 0) AS remaining
        FROM ${S}.payments p
       WHERE p.child_id = ANY($1::int[]) AND p.status = 'succeeded' AND p.amount_pence > 0
         AND COALESCE(p.source, '') <> 'eylog-import-b205' AND p.eylog_payment_no IS NULL
         AND (p.invoice_id IS NULL OR EXISTS (SELECT 1 FROM ${S}.payment_allocations a WHERE a.payment_id = p.id))
       ORDER BY COALESCE(p.paid_on, p.created_at::date), p.id`, [ids]);
    const pool = money.map((m) => ({ id: m.id, child_id: m.child_id, left: Number(m.remaining) || 0 })).filter((m) => m.left > 0);

    // 3. The open bills, oldest first.
    const { rows: bills } = await client.query(`
      SELECT i.id, i.child_id, i.status, ${outstandingSql('i', S)}::int AS owed
        FROM ${S}.invoices i
       WHERE i.id = ANY($1::int[]) AND i.status IN ('sent', 'overdue', 'brought_forward', 'paid')
       ORDER BY COALESCE(i.issued_on, i.created_at::date), i.id`, [countedIds]);
    for (const b of bills) {
      let owed = Number(b.owed) || 0;
      for (const m of pool) {
        if (owed <= 0) break;
        if (m.left <= 0) continue;
        const part = Math.min(m.left, owed);
        if (!dryRun) await client.query(
          `INSERT INTO ${S}.payment_allocations (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference)
           VALUES ($1, $2, $3, $4, CURRENT_DATE, 'auto-allocate', 'Put on the account automatically (oldest bill first)')`,
          [m.id, b.id, b.child_id, part]);
        m.left -= part; owed -= part; out.allocations++; out.pence += part;
      }
      b.owed_after = owed;
    }

    // 4. Statuses follow the money.
    for (const b of bills) {
      const settled = b.owed_after <= 0;
      if (settled && ['sent', 'overdue', 'brought_forward'].includes(b.status)) {
        if (!dryRun) await client.query(
          `UPDATE ${S}.invoices SET status = 'paid', paid_on = COALESCE(paid_on, CURRENT_DATE), updated_at = NOW() WHERE id = $1`, [b.id]);
        out.paid++;
      } else if (!settled && b.status === 'paid') {
        if (!dryRun) await client.query(
          `UPDATE ${S}.invoices SET status = 'sent', paid_on = NULL, updated_at = NOW() WHERE id = $1`, [b.id]);
        out.reopened++;
      }
    }
    if (!dryRun) await client.query('COMMIT');
  } catch (e) {
    if (!dryRun) await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    if (!dryRun) client.release();
  }
  return out;
}

/** Every real family on roll (and leavers who still owe or are owed). */
async function allocateAllAccounts(db, { schema = 'ladn', dryRun = false, log = null } = {}) {
  const S = sch(schema);
  const { rows } = await db.query(`
    SELECT DISTINCT c.id FROM ${S}.children c
     WHERE COALESCE(c.is_demo, false) = false
       AND (c.status = 'active' OR EXISTS (SELECT 1 FROM ${S}.invoices i WHERE i.child_id = c.id AND i.status IN ('sent','overdue')))
     ORDER BY c.id`);
  const seen = new Set(); const tot = { families: 0, allocations: 0, pence: 0, paid: 0, reopened: 0, overpaid_split: 0, errors: 0 };
  for (const r of rows) {
    const fam = (await familyChildIds(db, r.id, S)).sort((a, b) => a - b).join(',');
    if (seen.has(fam)) continue; seen.add(fam);
    try {
      const o = await allocateAccount(db, r.id, { schema: S, dryRun });
      tot.families++; for (const k of ['allocations', 'pence', 'paid', 'reopened', 'overpaid_split']) tot[k] += o[k];
      if (log && (o.allocations || o.paid || o.reopened || o.overpaid_split)) log(fam, o);
    } catch (e) { tot.errors++; if (log) log(fam, { error: e.message }); }
  }
  return tot;
}

/** Fire-and-forget for routes: after a payment or a bill lands. Never throws. */
function allocateSoon(db, childId, schema = 'ladn') {
  if (!childId) return;
  setImmediate(() => {
    allocateAccount(db, childId, { schema }).catch((e) => console.error('[account-allocate]', childId, e.message));
  });
}

module.exports = { allocateAccount, allocateAllAccounts, allocateSoon };
