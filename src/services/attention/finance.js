'use strict';
/**
 * finance.js — b232 collector. Money that is not arriving, and the guards that
 * stop money leaving by accident.
 *
 * Five checks, each of them a read:
 *
 *  1. Invoices unpaid more than 30 days past their due date.
 *  2. The b226 Xero push guard — `settings.xero_push_from`. With it unset, a
 *     backfill pushes the whole historical ledger into Xero; b226 measured that
 *     as 4,308 invoices and £767,828.17 of invented bank balance. An absent
 *     guard is a control that is off, which the rules make RED.
 *  3. Unresolved payment-reconciliation flags — a payment came in that Wren
 *     could not match to an invoice, or matched to two.
 *  4. Funded children billed with £0.00 of funding deducted. This is the b202
 *     failure in its most visible form: the generator re-spreads a figure that
 *     was already stretched, and when the arithmetic collapses the deduction
 *     line comes out at zero and the family is billed the gross fee.
 *  5. (b303) Staff on a live contract with no tax code, or no HMRC employee
 *     statement and no P45 — payroll that cannot be run from a complete record.
 *
 * No family, child, bill-payer OR member of staff is named anywhere — counts,
 * totals and invoice ids only. Chasing anybody is a job for the chase list,
 * which is a different screen with a different guard on it; finding out WHICH
 * member of staff is missing a tax code is a job for the staff record.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');
// b303 — payroll readiness, counts only. See src/lib/payroll-costs.js.
const payrollCosts = require('../../lib/payroll-costs');

const SOURCE = 'finance';
const UNPAID = ['sent', 'overdue', 'partial', 'unpaid'];

async function collect() {
  const db = getPool();
  const items = [];

  // ── 1. long-unpaid invoices ───────────────────────────────────────────────
  const { rows: aged } = await db.query(`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(amount_pence),0)::bigint AS pence,
           MIN(due_on)::date AS oldest
      FROM invoices
     WHERE status = ANY($1)
       AND due_on IS NOT NULL
       AND due_on < CURRENT_DATE - 30`, [UNPAID]);

  if (aged[0] && aged[0].n > 0) {
    const c = classify({ money: true });
    items.push({
      source: SOURCE,
      source_key: 'invoices-unpaid-30d',
      title: `${aged[0].n} invoices unpaid more than 30 days — ${money(aged[0].pence)} outstanding`,
      detail: `The oldest fell due on ${iso(aged[0].oldest)}. The chase list ranks them by how much and how overdue, and prints.`,
      why: c.why,
      rag: c.rag,
      category: 'finance',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 30,
      action_url: '/admin/finance-reports/chase-list',
      evidence: { count: aged[0].n, outstanding_pence: Number(aged[0].pence), oldest_due: iso(aged[0].oldest) },
      sort_hint: 1,
    });
  }

  // ── 2. the Xero push guard ────────────────────────────────────────────────
  const { rows: guard } = await db.query(
    `SELECT value FROM settings WHERE key = 'xero_push_from' LIMIT 1`);
  const from = guard[0] && guard[0].value ? String(guard[0].value).slice(0, 10) : null;
  if (!from) {
    const c = classify({ securityOff: true, money: true });
    items.push({
      source: SOURCE,
      source_key: 'xero-push-guard-off',
      title: 'The Xero push guard is not set — a backfill would push the whole historical ledger',
      detail: 'b226 measured this: without `xero_push_from`, a bulk push sends every historical invoice to Xero. 543 had already gone, worth £767,828.17 of bank balance that never existed. Set the date before running any invoice backfill.',
      why: c.why,
      rag: c.rag,
      category: 'finance',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 5,
      action_url: '/admin/finance/reconcile',
      evidence: { setting: 'xero_push_from', value: null },
      sort_hint: 0,
    });
  } else {
    const c = classify({ informational: true, why: `Set to ${from} — only invoices from that date push to Xero.` });
    items.push({
      source: SOURCE,
      source_key: 'xero-push-guard-on',
      title: `Xero push guard is on — nothing before ${from} can be pushed`,
      detail: 'The b226 guard is in place. Historical EyLog and EyMan invoices are excluded by origin as well as by date, and both checks fail closed.',
      why: c.why,
      rag: c.rag,
      category: 'finance',
      due_date: null,
      blocked_on: null,
      effort_minutes: null,
      action_url: '/admin/finance/reconcile',
      evidence: { setting: 'xero_push_from', value: from },
      sort_hint: 8,
    });
  }

  // ── 3. reconciliation flags nobody has cleared ────────────────────────────
  const { rows: flags } = await db.query(`
    SELECT COUNT(*)::int AS n, ARRAY_AGG(DISTINCT flag_type) AS kinds
      FROM payment_reconciliation_flags
     WHERE resolved_at IS NULL`);
  if (flags[0] && flags[0].n > 0) {
    const c = classify({ money: true });
    items.push({
      source: SOURCE,
      source_key: 'reconciliation-flags-open',
      title: `${flags[0].n} payment${flags[0].n === 1 ? '' : 's'} could not be reconciled`,
      detail: `Flag types: ${(flags[0].kinds || []).join(', ') || 'unknown'}. Money arrived that Wren cannot tie to an invoice, so somebody's balance is wrong in one direction or the other.`,
      why: c.why,
      rag: c.rag,
      category: 'finance',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 20,
      action_url: '/admin/finance/reconcile',
      evidence: { count: flags[0].n, flag_types: flags[0].kinds || [] },
      sort_hint: 1,
    });
  }

  // ── 4. funded children billed with no funding deducted ────────────────────
  // The b202 under-deduction, measured at its unambiguous edge: the child has
  // funded hours on record and the invoice deducted nothing at all.
  const { rows: zero } = await db.query(`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(i.amount_pence),0)::bigint AS pence,
           ARRAY_AGG(i.id ORDER BY i.issued_on DESC) AS ids
      FROM invoices i
     WHERE i.status <> 'draft'
       AND COALESCE(i.funding_deduction_pence, 0) = 0
       AND i.issued_on >= CURRENT_DATE - interval '3 months'
       AND EXISTS (SELECT 1 FROM child_funding cf
                    WHERE cf.child_id = i.child_id
                      AND COALESCE(cf.total_hours_week, 0) > 0)`);
  if (zero[0] && zero[0].n > 0) {
    const c = classify({ money: true });
    items.push({
      source: SOURCE,
      source_key: 'funding-under-deduction',
      title: `${zero[0].n} invoices in the last 3 months bill a funded child with £0.00 of funding deducted`,
      detail: `Together they invoice ${money(zero[0].pence)} gross. Every one of these families holds funded hours on record, and none of those hours came off the bill. `
            + 'b202 traced this to the stretched weekly figure being re-spread over 38 weeks by the generator; the visible symptom is a funding line of zero.',
      why: c.why,
      rag: c.rag,
      category: 'finance',
      due_date: null,
      blocked_on: 'claude',
      effort_minutes: 45,
      action_url: '/admin/finance-reports/funding',
      evidence: { count: zero[0].n, gross_pence: Number(zero[0].pence), invoice_ids: (zero[0].ids || []).slice(0, 40) },
      sort_hint: 1,
    });
  }

  // ── 5. b303 — payroll cannot be run properly for somebody on the books ────
  // A tax code or an HMRC employee statement missing for a person with a LIVE
  // contract. Without a code the run falls back to a basic-rate estimate;
  // without a statement (and with no P45 to supersede it) there is nothing on
  // file saying which code was right.
  //
  // Counts and a link. NOT a name — the same rule as every other item in this
  // file, and doubly so here: this is payroll data about a named employee, and
  // an attention item's title is rendered on a shared screen and can be pushed
  // to a notification. Whoever needs to know WHO opens the staff record.
  const readiness = await payrollCosts.payrollReadiness(db);
  if (readiness.available && readiness.people_affected > 0) {
    const n = readiness.people_affected;
    const bits = [];
    if (readiness.missing_tax_code) bits.push(`${readiness.missing_tax_code} with no tax code`);
    if (readiness.missing_declaration) bits.push(`${readiness.missing_declaration} with no HMRC employee statement and no P45`);
    // blockedOnToby rather than money: nothing is leaving or failing to arrive,
    // and calling this red would put it above unpaid invoices on the board.
    const c = classify({ blockedOnToby: true });
    items.push({
      source: SOURCE,
      source_key: 'payroll-starter-details-missing',
      title: `${n} member${n === 1 ? '' : 's'} of staff on a live contract cannot be paid from a complete record`,
      detail: `${bits.join('; ')}. b303 puts these questions on the details form a new starter fills in, `
            + 'so anyone onboarded from now on answers them once. These are people who predate it, or who '
            + 'left them blank. Wren does not file with HMRC — this is what the nursery needs on file to '
            + 'operate PAYE, and payroll runs without it are basic-rate estimates.',
      why: c.why,
      rag: c.rag,
      category: 'finance',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 15,
      action_url: readiness.action_url,
      evidence: {
        live_contracts: readiness.live_contracts,
        missing_tax_code: readiness.missing_tax_code,
        missing_declaration: readiness.missing_declaration,
        missing_ni_number: readiness.missing_ni_number,
      },
      sort_hint: 3,
    });
  }

  return { ok: true, items };
}

function money(p) {
  return '£' + (Number(p || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function iso(d) { return d ? (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)) : null; }

module.exports = { name: SOURCE, owns: [SOURCE], collect };
