'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b535 (2026-10-29) — ONE answer to "what should this invoice be today?", and
// the check that notices when a stored invoice no longer agrees with it.
//
// WHY THIS FILE EXISTS
// Three November invoices and one October one went out at the wrong day rate.
// the office manager spotted it; nothing in Wren had. The reissue machinery (b490) was fine —
// what was missing is that an invoice can be made wrong by a later edit (a room
// move, a funding allocation, a discount, a price override, an extra session) and
// Wren never said so. EyLog tells you. Now Wren does.
//
// It also settles the two-engine problem. Until today:
//   • POST /generate and the b490 reissue priced with buildDfeLineItems
//     (the "legacy" engine) — this is what every invoice a family has actually
//     been sent was raised by: 26 of the 35 bulk_create audit rows on wren_dev
//     carry meta.dfe_compliant, and POST /generate-itemised has forwarded to
//     /generate since 2026-10-09;
//   • POST /:id/regenerate priced with computeItemisedForChild, a DIFFERENT
//     engine. The b490 G3 note records it pricing one child at £2,101.99 with no
//     funding deduction against the legacy engine's £1,602.92.
// So the legacy engine is the live one, and priceInvoiceToday() routes to it —
// the out-of-date check, Regenerate, the reissue preview and the reissue commit
// now all read the same figure. The engines' own pricing rules are untouched.
//
// Nothing in here sends anything. It computes, compares and reports.
// ─────────────────────────────────────────────────────────────────────────────

// finance-invoices.js owns the engine (buildDfeLineItems + LEGACY_CHILD_SELECT +
// applyFeeBandRule) and exports computeLegacyInvoiceForChild for us. The require is
// LAZY — that route file requires this one, so a top-level require here would be a
// cycle and one of the two would see a half-built module.
function engine() {
  const m = require('../routes/finance-invoices');
  if (typeof m.computeLegacyInvoiceForChild !== 'function') {
    throw new Error('finance-invoices.js does not export computeLegacyInvoiceForChild');
  }
  return m.computeLegacyInvoiceForChild;
}

const OUT = require('./invoice-outstanding');

// ── a per-request read cache ─────────────────────────────────────────────────
// A scan prices N invoices, and the engine asks the same five questions for every one of
// them (the current funding term, every funding term, the invoice settings, and the two
// inside applyFeeBandRule). Memoising identical SELECTs for the life of ONE scan drops
// those five per invoice. Measured on wren_dev, 300 invoices: 2.59 s uncached, 2.19 s
// cached — about 15%, because this pg is on the same host. The reason to keep it is the
// query count, not the clock. It is only ever wrapped around a read-only scan: a
// non-SELECT falls straight through to the real client, uncached.
function cachedDb(db) {
  const cache = new Map();
  return {
    _b535cache: cache,
    query(sql, params) {
      const text = typeof sql === 'string' ? sql : (sql && sql.text);
      if (typeof text !== 'string' || !/^\s*select/i.test(text)) return db.query(sql, params);
      const key = text + '|' + JSON.stringify(params || []);
      if (!cache.has(key)) cache.set(key, db.query(sql, params));
      return cache.get(key);
    },
  };
}

// ── pricing ──────────────────────────────────────────────────────────────────

/**
 * What this child's invoice for this month would be if it were raised right now.
 * Returns null when the child cannot be billed for the period at all (left before
 * it, not started yet, or no longer active) — the same answer /reissue gives.
 */
async function priceChildMonth(db, { childId, year, month, fromInvoiceId = null,
                                     carryCreditsFromInvoiceId = null, pendingStores = true }) {
  const compute = engine();
  const draft = await compute(db, { childId, year, month, fromInvoiceId, carryCreditsFromInvoiceId, pendingStores });
  if (!draft) return null;
  return {
    amount_pence: Number(draft.chargeablePence) || 0,
    line_items: draft.lineItems || [],
    funding_deduction_pence: Number(draft.fundingDeductionPence) || 0,
    discount_lines: draft.discountLines || [],
    applied_credit_ids: draft.appliedCreditIds || [],
    extra_session_ids: draft.extraSessionIds || [],
    issued_on: draft.issued_on,
    due_on: draft.due_on,
    room: draft.room || null,
    month_label: draft.monthLabel,
  };
}

/**
 * The same thing for an invoice row. The invoice's own id is passed twice, so that
 * what it ALREADY carries is carried again rather than read as a change:
 *   • fromInvoiceId — the one-off extra sessions billed on it;
 *   • carryCreditsFromInvoiceId — the account credits applied to it.
 * Without either, every invoice holding an extra session or a credit would report as
 * out of date for ever, and re-pricing one would silently put the money back on the bill.
 */
// b535 review — opts.pendingStores=false: price only what the invoice already holds
// (see computeLegacyInvoiceForChild). Used by carry-forward, so a waiting extra session
// or account credit is not carried on top of reaching the next bill by itself.
async function priceInvoiceToday(db, inv, opts = {}) {
  if (!inv || !inv.period_year || !inv.period_month) return null;
  return priceChildMonth(db, {
    childId: inv.child_id,
    year: Number(inv.period_year),
    month: Number(inv.period_month),
    fromInvoiceId: inv.id,
    carryCreditsFromInvoiceId: inv.id,
    pendingStores: opts.pendingStores !== false,
  });
}

// ── what changed ─────────────────────────────────────────────────────────────
// The reason is derived by COMPARING THE LINE ITEMS, never by guessing from what
// a manager happened to press: an invoice can be stale for three reasons at once,
// and the one the manager just touched need not be any of them.

// TWO category vocabularies are stored on real invoices, because two engines wrote
// them: the legacy engine's DFE_CATEGORIES ('additional_private_paid_hours',
// 'funded_entitlement_hours') and the older itemised one's ('additional_paid_hours',
// 'funded_entitlement'). Classifying on only one of them put every line of an
// itemised-era invoice in 'other', so a real day-rate change was reported as
// "other charges". Both are recognised, and `statutory_category` is read as well
// as `category` because the itemised engine wrote whichever it had.
const FUNDING_CATEGORIES = new Set(['funded_entitlement_hours', 'funded_entitlement']);
const CONSUMABLE_CATEGORIES = new Set(['food', 'non_food_consumables']);
const CHILDCARE_CATEGORIES = new Set(['additional_private_paid_hours', 'additional_paid_hours']);

/** Which part of the bill a line item belongs to. */
function lineKind(li) {
  if (!li) return 'other';
  const cat = li.category || li.statutory_category || null;
  // Order matters: an extra session and a discount both sit in a charge category.
  if (li.is_extra_session) return 'extra_session';
  if (li.is_discount) return 'discount';
  if (li.is_credit || cat === 'account_credit') return 'credit';
  if (li.is_funded || li.is_deduction || FUNDING_CATEGORIES.has(cat)) return 'funding';
  if (CONSUMABLE_CATEGORIES.has(cat)) return 'consumables';
  if (CHILDCARE_CATEGORIES.has(cat) || /^childcare\b/i.test(String(li.label || ''))) return 'childcare';
  return 'other';
}

function sumByKind(lines) {
  const out = {};
  for (const li of (lines || [])) {
    const k = lineKind(li);
    out[k] = (out[k] || 0) + (Number(li.amount_pence) || 0);
  }
  return out;
}

/** The core childcare line, which is the one that carries the day rate and the days. */
function coreChildcare(lines) {
  return (lines || []).find(li => lineKind(li) === 'childcare') || null;
}

/** "Childcare — Pre-school (November 2026)" to "Pre-school" */
function roomFromLabel(label) {
  const m = String(label || '').match(/^childcare\s*[—–-]\s*(.+?)\s*\(/i);
  return m ? m[1].trim() : null;
}

const num = v => (v == null ? null : Number(v));

const CODE_LABEL = {
  price_override:  'price override',
  day_rate:        'day rate',
  booking_pattern: 'booking pattern',
  room:            'room',
  childcare:       'childcare charge',
  funding:         'funded hours',
  discount:        'discount',
  extra_session:   'extra session',
  consumables:     'consumables',
  credit:          'account credit',
  other:           'other charges',
  basis:           'a different billing basis',
  no_old_lines:    'the old invoice has no breakdown',
  recalculated:    'recalculated',
};

/**
 * Why this invoice's figures and today's figures differ.
 * @returns {{reason: string, codes: string[], by_kind: object}}
 */
function changeReason(oldLines, newLines) {
  const codes = [];
  const oldK = sumByKind(oldLines);
  const newK = sumByKind(newLines);
  const kinds = new Set([...Object.keys(oldK), ...Object.keys(newK)]);

  // The childcare line first, and in detail: a day rate, a booking pattern, a room
  // and a price override all move the same line, and they are different problems.
  // An invoice with no breakdown at all (an early import, a seeded row) cannot be
  // compared line by line, and saying "booking pattern" about it would be an invention.
  if (!(oldLines || []).length) {
    codes.push('no_old_lines');
  } else {
    const a = coreChildcare(oldLines);
    const b = coreChildcare(newLines);
    if (a || b) {
      const aUnit = num(a && a.unit_pence), bUnit = num(b && b.unit_pence);
      const aQty = num(a && a.quantity), bQty = num(b && b.quantity);
      const aRoom = roomFromLabel(a && a.label), bRoom = roomFromLabel(b && b.label);
      const aOv = !!(a && a.price_overridden), bOv = !!(b && b.price_overridden);
      // 'days/week' against 'hours' is not a booking change — it is two different
      // billing bases, which is what an invoice raised by the old itemised engine
      // looks like next to today's. Compare the quantities only when they count the
      // same thing, and say plainly when they do not.
      const aUL = a && a.unit_label, bUL = b && b.unit_label;
      const comparable = !(aUL && bUL && aUL !== bUL);
      if (aOv !== bOv) codes.push('price_override');
      if (!comparable) codes.push('basis');
      if (comparable && aUnit != null && bUnit != null && aUnit !== bUnit) codes.push('day_rate');
      if (comparable && aQty != null && bQty != null && aQty !== bQty) codes.push('booking_pattern');
      if (aRoom && bRoom && aRoom !== bRoom) codes.push('room');
      if (!codes.length && (oldK.childcare || 0) !== (newK.childcare || 0)) codes.push('childcare');
    }
  }

  for (const k of ['funding', 'discount', 'extra_session', 'consumables', 'credit', 'other']) {
    if (!kinds.has(k)) continue;
    if ((oldK[k] || 0) !== (newK[k] || 0)) codes.push(k);
  }

  const uniq = [...new Set(codes)];
  return {
    reason: uniq.map(c => CODE_LABEL[c] || c).join(', '),
    codes: uniq,
    by_kind: { old: oldK, new: newK },
  };
}

// ── the out-of-date check ────────────────────────────────────────────────────

// An invoice Wren raised, in a billing month that is still live, that has not already
// been superseded. EyLog imports are excluded here and refused by the routes: their
// figures are the historic record (the same rule /regenerate and /reissue enforce).
// A carried difference (invoice_change_carries) also drops out — the money has been
// dealt with on the next bill, so the old invoice is deliberately left as it is.
const ELIGIBLE_SQL = `
    i.period_year IS NOT NULL AND i.period_month IS NOT NULL
    AND i.status NOT IN ('credit_note','written_off','brought_forward')
    AND i.amount_pence >= 0
    AND NOT EXISTS (SELECT 1 FROM invoices r
                     WHERE r.reissued_from_id = i.id AND r.status <> 'written_off')`;

function monthKey(y, m) { return `${y}-${String(m).padStart(2, '0')}`; }

/** 'YYYY-MM' for today — the default floor for a scan. */
function currentBillingMonth(now = new Date()) {
  return monthKey(now.getFullYear(), now.getMonth() + 1);
}

/** Does this deployment have the b535 carry table? Answered once per process. */
let _carryTable = null;
async function hasCarryTable(db) {
  if (_carryTable != null) return _carryTable;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'invoice_change_carries'`);
    _carryTable = rows.length > 0;
  } catch (_) { _carryTable = false; }
  return _carryTable;
}

/**
 * Compare one invoice with what it would be today.
 * @returns {Promise<object|null>} a stale row, or null when it still agrees (or cannot be priced)
 */
async function staleCheck(db, inv) {
  const now = await priceInvoiceToday(db, inv);
  if (!now) return null;                        // cannot be billed for this period today
  return compareInvoice(inv, now);
}

/**
 * The comparison on its own, for a caller that has already priced the invoice
 * (staleScan does, so it never prices the same invoice twice).
 * @returns {object|null} a stale row, or null when the figures still agree
 */
function compareInvoice(inv, now) {
  const oldPence = Number(inv.amount_pence) || 0;
  const newPence = Number(now.amount_pence) || 0;
  // The TOTAL is the test. Lines that merely read differently (a note reworded, a
  // category renamed between builds) are not a billing change, and reporting them
  // would fill the board with invoices nobody needs to touch.
  if (oldPence === newPence) return null;
  const oldLines = Array.isArray(inv.line_items) ? inv.line_items : [];
  const r = changeReason(oldLines, now.line_items);
  return {
    invoice_id: inv.id,
    invoice_number: inv.invoice_number || null,
    child_id: inv.child_id,
    child_name: inv.child_name || null,
    period: monthKey(inv.period_year, inv.period_month),
    period_label: inv.period_label || now.month_label || null,
    status: inv.status,
    // An import can only be corrected by carrying the difference forward.
    eylog: !!inv.eylog_ref,
    old_pence: oldPence,
    new_pence: newPence,
    diff_pence: newPence - oldPence,
    seen_by_family: !!inv.sent_at,
    paid: inv.outstanding_pence != null && Number(inv.outstanding_pence) <= 0 && oldPence > 0,
    outstanding_pence: inv.outstanding_pence == null ? null : Number(inv.outstanding_pence),
    reason: r.reason || 'recalculated',
    reason_codes: r.codes.length ? r.codes : ['recalculated'],
    // A bill that would become £0 today almost always means the child has no booking
    // pattern any more, not that they owe nothing — on wren_dev four seeded invoices look
    // exactly like this. Flagged so the screen can warn, and so "select all" can leave
    // them out: pressing Update on one would wipe a real bill to nothing.
    would_zero: newPence === 0 && oldPence > 0,
    new_line_items: now.line_items,
    old_line_items: oldLines,
    // Not yet seen by the family: update it in place. Seen: it has to be reissued
    // (credit + replacement) or the difference carried to the next bill. An EyLog
    // import is neither — the only thing on offer is carrying the difference.
    action: inv.eylog_ref ? 'carry' : (inv.sent_at ? 'reissue' : 'regenerate'),
  };
}

/**
 * Every Wren-generated invoice from `from` (a 'YYYY-MM') onwards whose figures no
 * longer match today's. Read-only; writes nothing, sends nothing.
 *
 * @param {object} db      a pg pool or client
 * @param {object} [opts]
 * @param {string} [opts.from]      'YYYY-MM' floor, default this calendar month
 * @param {string} [opts.to]        'YYYY-MM' ceiling, default none
 * @param {number[]} [opts.childIds] restrict to these children
 * @param {number} [opts.limit]     most invoices to price (default 400)
 */
async function staleScan(db, opts = {}) {
  const t0 = Date.now();
  const from = /^\d{4}-\d{2}$/.test(String(opts.from || '')) ? String(opts.from) : currentBillingMonth();
  const to = /^\d{4}-\d{2}$/.test(String(opts.to || '')) ? String(opts.to) : null;
  const limit = Math.min(1000, Math.max(1, parseInt(opts.limit, 10) || 400));
  const carry = await hasCarryTable(db);

  const params = [from];
  let where = `${ELIGIBLE_SQL} AND to_char(make_date(i.period_year, i.period_month, 1), 'YYYY-MM') >= $1`;
  // The BOARD is Wren's own invoices (§2): an EyLog import is the historic record and has
  // no "update" or "reissue". The per-CHILD check asks for them too, because a change to a
  // child's record still affects what they were billed, and the one thing that CAN be done
  // about an import is to put the difference on the next invoice.
  if (!opts.includeImported) where += ' AND i.eylog_ref IS NULL';
  if (to) { params.push(to); where += ` AND to_char(make_date(i.period_year, i.period_month, 1), 'YYYY-MM') <= $${params.length}`; }
  if (Array.isArray(opts.childIds) && opts.childIds.length) {
    params.push(opts.childIds.map(Number).filter(Number.isInteger));
    where += ` AND i.child_id = ANY($${params.length}::int[])`;
  }
  if (carry) where += ` AND NOT EXISTS (SELECT 1 FROM invoice_change_carries cc WHERE cc.invoice_id = i.id)`;
  params.push(limit);

  const { rows } = await db.query(`
    SELECT i.id, i.child_id, i.invoice_number, i.amount_pence, i.line_items, i.status,
           i.sent_at, i.locked_at, i.period_year, i.period_month, i.period_label,
           i.eylog_ref, i.bill_payer_email,
           (c.first_name || ' ' || c.last_name) AS child_name,
           ${OUT.outstandingSql('i')} AS outstanding_pence
      FROM invoices i
      LEFT JOIN children c ON c.id = i.child_id
     WHERE ${where}
     ORDER BY i.period_year, i.period_month, i.child_id
     LIMIT $${params.length}`, params);

  const cdb = cachedDb(db);
  const stale = [];
  let priced = 0, unpriceable = 0, failed = 0;
  for (const inv of rows) {
    try {
      // A child who has left, or whose record is no longer active, cannot be priced for
      // the period. That is not "up to date" and it is not an error — it is counted on its
      // own so an empty stale list is never mistaken for a clean bill of health.
      const today = await priceInvoiceToday(cdb, inv);
      if (!today) { unpriceable++; continue; }
      priced++;
      const row = compareInvoice(inv, today);
      if (row) stale.push(row);
    } catch (e) {
      failed++;
      console.error('[b535] stale check failed for invoice', inv.id, '-', e.message);
    }
  }

  return {
    from, to, scanned: rows.length, priced, failed, unpriceable,
    count: stale.length,
    total_diff_pence: stale.reduce((s, r) => s + r.diff_pence, 0),
    invoices: stale,
    ms: Date.now() - t0,
    cache_size: cdb._b535cache.size,
  };
}

/**
 * The invoices a change to ONE child has just made out of date. Used by every write
 * route that moves the bill (a booking, a funding allocation, a discount, a price
 * override, an extra session) so the save itself can say what it has just changed.
 * Never throws: a save must not fail because the follow-up check did.
 */
async function staleForChild(db, childId, opts = {}) {
  try {
    const id = parseInt(childId, 10);
    if (!Number.isInteger(id)) return [];
    const r = await staleScan(db, Object.assign({ includeImported: true }, opts,
      { childIds: [id], limit: 36 }));
    return r.invoices;
  } catch (e) {
    console.error('[b535] staleForChild:', e.message);
    return [];
  }
}

/** The billing month a carried difference lands on: the one after `period`. */
function nextBillingMonth(year, month) {
  const y = Number(year), m = Number(month);
  return m >= 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 };
}

module.exports = {
  cachedDb,
  priceChildMonth,
  priceInvoiceToday,
  lineKind,
  changeReason,
  coreChildcare,
  roomFromLabel,
  staleCheck,
  compareInvoice,
  staleScan,
  staleForChild,
  currentBillingMonth,
  nextBillingMonth,
  monthKey,
  hasCarryTable,
  ELIGIBLE_SQL,
  CODE_LABEL,
};
