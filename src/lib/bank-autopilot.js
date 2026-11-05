'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-28 — bank lines sort themselves out (Toby: "the card payments … when I see one in
// from Barclaycard, is there a way for you to set ignore those automatically … if their
// tax-free childcare code matches it should also allocate, or their unique reference ID …
// and it should self learn, so if previously I've matched a reference to a child and the
// same reference comes in again it will go to that child again").
//
// Runs after the 07:15 bank pull and every 15 minutes (server-unified.js), in this order:
//   1. Barclaycard payouts ("BCARD… BGC") are SET ASIDE: the card payments inside them were
//      recorded in Wren the moment the parent paid, so matching the payout would count the
//      money twice. Same set-aside Toby has been doing by hand since 5 Oct.
//   2. b325's matcher (services/payment-matcher.js) runs with auto-apply: a TFC reference →
//      that child, the family's payment reference → that family, and — new — a payer Toby
//      has matched before → that family again. Ambiguous lines (two references, a payer
//      known for two families) still wait for Toby, as before.
//   3. Every family's account is re-allocated (account-allocate.js): payments onto the
//      oldest bills, the rest as credit.
// Learning: every match Toby confirms in Reconcile remembers the payer (payment_payer_links),
// unless that payer is already remembered for a different family — then it stays a question.
// Bank text is tested here and never returned or logged (it carries family names).
// ─────────────────────────────────────────────────────────────────────────────

const CS = require('./card-settlement');
const PR = require('./payment-references');
const { allocateAllAccounts, allocateSoon } = require('./account-allocate');

const CARD_REASON = 'Card payout (Barclaycard): the card payments were recorded in Wren when the parents paid — set aside automatically';
const FAMILY_KEY = (a) => `NULLIF(lower(btrim(${a}.primary_contact_email)), '')`;

async function excludeCardPayouts(db) {
  const { rows } = await db.query(`
    SELECT l.id, l.description, l.reference, l.amount_pence FROM bank_statement_lines l
     WHERE l.amount_pence > 0 AND l.reconciled = false AND l.excluded_reason IS NULL
       AND NOT EXISTS (SELECT 1 FROM bank_auto_matches m WHERE m.bank_line_id = l.id AND m.status IN ('applied','queued'))`);
  const ids = rows.filter((l) => CS.isCardSettlementLine(l)).map((l) => l.id);
  if (!ids.length) return 0;
  const r = await db.query(
    `UPDATE bank_statement_lines SET excluded_reason = $2, excluded_at = NOW(), excluded_by = NULL
      WHERE id = ANY($1::int[]) AND excluded_reason IS NULL AND reconciled = false`, [ids, CARD_REASON]);
  return r.rowCount;
}

/** Remember who sent this line, for this child's family. Never re-points a payer. */
async function learnPayer(db, bankLineId, childId, actorId = null) {
  if (!bankLineId || !childId) return null;
  const { rows: [l] } = await db.query(
    `SELECT payee_name, description, amount_pence FROM bank_statement_lines WHERE id = $1`, [bankLineId]);
  if (!l || Number(l.amount_pence) <= 0) return null;
  if (CS.isCardSettlementLine(l)) return null;
  const key = PR.payerKey(l.payee_name, l.description);
  if (!key) return null;
  const { rows: [c] } = await db.query(`SELECT ${FAMILY_KEY('c')} AS family_key FROM children c WHERE c.id = $1`, [childId]);
  if (!c || !c.family_key) return null;
  const { rows } = await db.query(`
    INSERT INTO payment_payer_links (payer_key, payer_label, family_key, confirmed_by)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (payer_key) WHERE revoked_at IS NULL DO NOTHING RETURNING id`,
    [key, 'Learned from a Reconcile match', c.family_key, actorId]);
  return rows[0] ? rows[0].id : null;
}

/** One-off: learn from every bank line already matched to a child since Wren took over the money. */
async function backfillPayerLinks(db) {
  const { rows } = await db.query(`
    SELECT l.payee_name, l.description, ${FAMILY_KEY('c')} AS family_key
      FROM bank_statement_lines l
      JOIN payments p ON p.bank_statement_line_id = l.id AND p.status = 'succeeded'
      JOIN children c ON c.id = p.child_id
     WHERE l.amount_pence > 0`);
  const byKey = new Map();
  for (const r of rows) {
    if (CS.isCardSettlementLine({ description: r.description, amount_pence: 1 })) continue;
    const k = PR.payerKey(r.payee_name, r.description);
    if (!k || !r.family_key) continue;
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(r.family_key);
  }
  let learned = 0, ambiguous = 0;
  for (const [k, fams] of byKey) {
    if (fams.size !== 1) { ambiguous++; continue; }
    const r = await db.query(`
      INSERT INTO payment_payer_links (payer_key, payer_label, family_key, confirmed_by)
      VALUES ($1, 'Learned from earlier Reconcile matches', $2, NULL)
      ON CONFLICT (payer_key) WHERE revoked_at IS NULL DO NOTHING`, [k, [...fams][0]]);
    learned += r.rowCount;
  }
  return { learned, ambiguous };
}

async function runAutopilot(db, { actorId = null } = {}) {
  const M = require('../services/payment-matcher');
  const out = { card_payouts_set_aside: 0, scan: null, accounts: null };
  out.card_payouts_set_aside = await excludeCardPayouts(db);
  out.scan = await M.scanLines(db, { autoApply: await M.autoApplyEnabled(db), actorId });
  out.accounts = await allocateAllAccounts(db);
  return out;
}

module.exports = { excludeCardPayouts, learnPayer, backfillPayerLinks, runAutopilot, allocateSoon, CARD_REASON };
