'use strict';
/**
 * b225 — Invoice discounts.  (2026-08-25)
 *
 * WHAT THIS IS: the one place that decides how much a discount takes off a bill.
 * Both invoice generators call it, so the bulk run and a regenerated draft cannot
 * arrive at different numbers for the same child.
 *
 * THE RULE THAT MATTERS MOST — funded hours are never discounted.
 *
 * A discount's `applies_to` is either:
 *
 *   'fees_only'      the billable childcare fees ONLY. On the itemised engine that
 *                    is the additional_paid_hours lines (funded hours are already
 *                    £0 lines there, so they contribute nothing). On the legacy DfE
 *                    generator the funding is a NEGATIVE money line, so the funded
 *                    money lines are added in — which nets them off the gross
 *                    childcare exactly the way buildDfeLineItems() nets them off
 *                    itself. Either way the base is what the family is actually
 *                    being charged for care, and the government's money is
 *                    untouched. This is the setting a sibling discount uses.
 *
 *   'invoice_total'  everything on the invoice — fees, meals, consumables, extras.
 *
 * Meals and consumables are deliberately OUTSIDE 'fees_only'. They are voluntary
 * statutory-category items charged at cost; discounting them quietly would put
 * Wren on the wrong side of the DfE's "no cross-subsidy" wording.
 *
 * Money is integer pence throughout and every result goes through pence() from
 * the EyMan model — the same rounding helper the statement uses, so a discount
 * can never introduce a half-penny the invoice cannot show.
 *
 * ORDER OF OPERATIONS in the generators: gross fee → funding → extras →
 * DISCOUNTS → account credits. A discount reduces what is owed; a credit is money
 * the family already holds and is spent against whatever is left.
 */

const { pence } = require('./eyman-invoice-model');

// Statutory categories that count as billable childcare fees. Two spellings
// because the two generators disagree: the legacy DfE builder stamps
// 'additional_private_paid_hours', the itemised engine 'additional_paid_hours'.
const FEE_CATEGORIES = new Set(['additional_paid_hours', 'additional_private_paid_hours']);

const KINDS = ['percent', 'fixed_pence'];
const APPLIES_TO = ['invoice_total', 'fees_only'];

// The line category discount lines carry. Deliberately NOT one of the five DfE
// statutory categories — a discount is not a thing being charged for, and
// putting it in one would corrupt that category's statutory subtotal.
const DISCOUNT_CATEGORY = 'discount';

/**
 * "Family" here is the same thing the rest of the invoicing code already means by
 * it: the bill payer. POST /generate scopes parent_account_credits by
 * lower(children.primary_contact_email), and that address is what lands in
 * invoices.bill_payer_email. Siblings are therefore children who share it.
 *
 * Not re-derived from ladn.contacts on purpose — that would be a SECOND
 * definition of family, and the two would disagree the first time a contact row
 * was edited without the child row following.
 */
function familyKey(child) {
  return String(child && (child.primary_contact_email || child.bill_payer_email) || '')
    .toLowerCase().trim() || null;
}

/** SQL for the same key, for grouping/joining in queries. `alias` is the children alias. */
function familyKeySql(alias = 'c') {
  return `NULLIF(lower(btrim(${alias}.primary_contact_email)), '')`;
}

function isDiscountLine(li) {
  return !!(li && (li.is_discount === true
    || li.category === DISCOUNT_CATEGORY
    || li.statutory_category === DISCOUNT_CATEGORY));
}

function lineCategory(li) {
  return (li && (li.statutory_category || li.category)) || '';
}

/**
 * The billable-fees base — what a 'fees_only' discount is a percentage OF.
 *
 * Funded lines are added rather than skipped, and that is the whole point: on the
 * legacy generator they are the negative deduction (and its positive "capped to
 * childcare charged" correction), so including them turns a gross childcare
 * figure into the net one the family is actually charged. On the itemised engine
 * they are £0 and add nothing. Both paths therefore land on "fees after funding".
 */
function feesBasePence(lineItems) {
  let base = 0;
  for (const li of (Array.isArray(lineItems) ? lineItems : [])) {
    if (isDiscountLine(li)) continue;
    if (li.is_credit) continue;              // account credit, not a fee
    const amt = pence(li.amount_pence);
    if (li.is_funded) { base += amt; continue; }
    const cat = lineCategory(li);
    if (FEE_CATEGORIES.has(cat) || /^childcare\b/i.test(li.label || '')) base += amt;
  }
  return Math.max(0, base);
}

/** Everything on the invoice, before any discount. */
function invoiceTotalBasePence(lineItems) {
  let base = 0;
  for (const li of (Array.isArray(lineItems) ? lineItems : [])) {
    if (isDiscountLine(li)) continue;
    base += pence(li.amount_pence);
  }
  return Math.max(0, base);
}

function basePence(lineItems, appliesTo) {
  return appliesTo === 'invoice_total'
    ? invoiceTotalBasePence(lineItems)
    : feesBasePence(lineItems);
}

/**
 * One discount against one base. Never more than the base — a discount reduces a
 * bill, it never creates a refund, and a fixed £50 off a £30 balance is £30 off.
 */
function discountAmountPence(discount, base) {
  const b = Math.max(0, pence(base));
  if (b <= 0) return 0;
  const value = Number(discount.value);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const raw = discount.kind === 'fixed_pence'
    ? pence(value)
    : pence(b * value / 100);
  return Math.max(0, Math.min(raw, b));
}

function describe(discount) {
  return discount.kind === 'fixed_pence'
    ? `£${(Number(discount.value) / 100).toFixed(2)} off`
    : `${Number(discount.value)}%`;
}

function baseLabel(appliesTo) {
  return appliesTo === 'invoice_total' ? 'the invoice total' : 'billable fees';
}

/**
 * Turn a child's attached discounts into invoice line items.
 *
 * Several discounts apply in `id` order and each is worked out against what is
 * LEFT after the ones before it, so two 10% discounts come to 19% and not 20%.
 * Compounding downwards is the only rule that cannot produce a negative invoice,
 * and each line records the basis_pence it was actually applied to so the
 * arithmetic is still checkable a year later.
 *
 * @param lineItems  the invoice's lines so far (gross fee, funding, extras) — NOT mutated
 * @param discounts  rows from applicableDiscounts()
 * @param periodLabel  e.g. "August 2026", for the parent-facing note
 * @returns { lines, total_pence }  total_pence is POSITIVE (the amount taken off)
 */
function buildDiscountLines({ lineItems = [], discounts = [], periodLabel = '' } = {}) {
  const lines = [];
  let taken = 0;

  // Both bases shrink as discounts are applied, so a second discount can never
  // reach money the first one already took off.
  let feesLeft = feesBasePence(lineItems);
  let totalLeft = invoiceTotalBasePence(lineItems);

  for (const d of discounts) {
    const appliesTo = APPLIES_TO.includes(d.applies_to) ? d.applies_to : 'fees_only';
    const base = appliesTo === 'invoice_total' ? totalLeft : feesLeft;
    const amount = discountAmountPence(d, Math.min(base, totalLeft));
    if (amount <= 0) continue;

    taken     += amount;
    totalLeft -= amount;
    if (appliesTo === 'fees_only') feesLeft = Math.max(0, feesLeft - amount);
    else feesLeft = Math.max(0, Math.min(feesLeft, totalLeft));

    lines.push({
      label: `${d.name} — ${describe(d)}`,
      description: `${describe(d)} of ${baseLabel(appliesTo)}`,
      category: DISCOUNT_CATEGORY,
      statutory_category: DISCOUNT_CATEGORY,
      is_discount: true,
      is_funded: false,
      is_credit: false,
      discount_id: d.discount_id != null ? d.discount_id : d.id,
      child_discount_id: d.child_discount_id != null ? d.child_discount_id : null,
      discount_kind: d.kind,
      applies_to: appliesTo,
      quantity: d.kind === 'percent' ? Number(d.value) : 1,
      unit_label: d.kind === 'percent' ? '%' : 'discount',
      unit_pence: null,
      amount_pence: -amount,
      basis_pence: base,
      note: `${describe(d)} of ${baseLabel(appliesTo)}`
          + ` (£${(base / 100).toFixed(2)})${periodLabel ? ' for ' + periodLabel : ''}.`
          + (appliesTo === 'fees_only'
              ? ' Government-funded hours are not discounted.'
              : ''),
    });
  }

  return { lines, total_pence: taken };
}

/**
 * The discounts attached to a child that are live for a billing period.
 *
 * Overlap, not containment: a discount that starts mid-month applies to that
 * month. Deciding otherwise would mean a family granted a discount on the 3rd
 * waits a month for it, which is not what anyone means by "start date".
 */
async function applicableDiscounts(db, childId, periodFromIso, periodToIso) {
  const { rows } = await db.query(
    `SELECT cd.id            AS child_discount_id,
            cd.child_id, cd.start_date, cd.end_date,
            d.id             AS discount_id,
            d.name, d.code, d.kind, d.value, d.applies_to, d.notes
       FROM child_discounts cd
       JOIN discounts d ON d.id = cd.discount_id
      WHERE cd.child_id = $1
        AND d.active = true
        AND cd.start_date <= $3::date
        AND (cd.end_date IS NULL OR cd.end_date >= $2::date)
      ORDER BY cd.id`,
    [childId, periodFromIso, periodToIso]);
  return rows;
}

/**
 * Record what came off an invoice. Append-only: regenerating a draft supersedes
 * the previous rows instead of deleting them, so the question "what discount did
 * this invoice carry before it was regenerated, and when did that change" always
 * has an answer.
 */
async function recordDiscountLines(db, invoiceId, discountLines) {
  await db.query(
    `UPDATE invoice_discount_lines SET superseded_at = NOW()
      WHERE invoice_id = $1 AND superseded_at IS NULL`, [invoiceId]);
  for (const li of discountLines) {
    await db.query(
      `INSERT INTO invoice_discount_lines
         (invoice_id, discount_id, child_discount_id, label, amount_pence, basis_pence, applies_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [invoiceId, li.discount_id || null, li.child_discount_id || null,
       li.label, li.amount_pence, li.basis_pence, li.applies_to]);
  }
}

/** The live discount rows written against an invoice. */
async function invoiceDiscountLines(db, invoiceId) {
  const { rows } = await db.query(
    `SELECT idl.id, idl.discount_id, idl.child_discount_id, idl.label, idl.amount_pence,
            idl.basis_pence, idl.applies_to, idl.created_at, d.code
       FROM invoice_discount_lines idl
       LEFT JOIN discounts d ON d.id = idl.discount_id
      WHERE idl.invoice_id = $1 AND idl.superseded_at IS NULL
      ORDER BY idl.id`, [invoiceId]);
  return rows;
}

/**
 * The child's family, ranked by when each sibling started.
 *
 * Rank 1 is the longest-standing child; rank 2+ are the ones a sibling discount
 * is normally offered to. Returned as information for a manager to act on — the
 * discount itself is never attached automatically, because which family gets one
 * (and from when) is Toby's call and not an inference from a shared email
 * address.
 */
async function familyOf(db, childId) {
  const { rows: [me] } = await db.query(
    `SELECT id, first_name, last_name, ${familyKeySql('c')} AS family_key
       FROM children c WHERE c.id = $1`,
    [childId]);
  if (!me) return null;
  if (!me.family_key) return { family_key: null, rank: null, siblings: [], size: 1 };

  const { rows } = await db.query(
    `SELECT c.id, c.first_name, c.last_name, c.start_date, c.status,
            EXISTS (SELECT 1 FROM child_discounts cd
                      JOIN discounts d ON d.id = cd.discount_id
                     WHERE cd.child_id = c.id AND d.active = true
                       AND (cd.end_date IS NULL OR cd.end_date >= CURRENT_DATE)) AS has_discount
       FROM children c
      WHERE ${familyKeySql('c')} = $1
        AND c.status = 'active'
      ORDER BY c.start_date NULLS LAST, c.id`, [me.family_key]);

  const ranked = rows.map((r, i) => ({ ...r, rank: i + 1 }));
  const mine = ranked.find(r => r.id === me.id);
  return {
    family_key: me.family_key,
    size: ranked.length,
    rank: mine ? mine.rank : null,
    siblings: ranked,
  };
}

module.exports = {
  FEE_CATEGORIES, KINDS, APPLIES_TO, DISCOUNT_CATEGORY,
  familyKey, familyKeySql, isDiscountLine,
  feesBasePence, invoiceTotalBasePence, basePence, discountAmountPence,
  buildDiscountLines, applicableDiscounts, recordDiscountLines, invoiceDiscountLines,
  familyOf,
};
