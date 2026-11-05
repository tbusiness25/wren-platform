'use strict';
/**
 * finance-reports.js — b227 (2026-08-25)
 *
 * The five finance reports a nursery owner actually runs, computed from Wren's own
 * ledger. Everything here is a pure READ: no endpoint in this module, and no function
 * in this file, writes to invoices, payments or allocations.
 *
 *   incomeSummary()          income by month and by room, gross / discount / net,
 *                            billable vs funded, partial months flagged not averaged
 *   agedDebtors()            current / 30 / 60 / 90+ from the invoice ledger
 *   fundingReconciliation()  funded hours claimed vs funded hours billed, per term
 *   paymentsReceived()       by method and by month, including the unallocated total
 *   chaseList()              who to chase, how much, how overdue, last contact
 *
 * ── THINGS THAT COST REAL TIME TO FIND OUT, WRITTEN DOWN SO THEY STAY FOUND ──
 *
 * 1. `invoices.period_year` / `period_month` is the month the invoice was ISSUED,
 *    not the month it bills for. The b205 EyMan import set it from the issue date,
 *    and EyMan invoices a month in advance: 4,021 of the 4,115 monthly invoices bill
 *    the month AFTER their recorded period, and only 92 bill their own. Reporting
 *    "July income" off period_month therefore reports money billed in July for
 *    August. Both bases are offered here — basis='service' (the default, read out
 *    of the line description) and basis='issued' — and every response says which
 *    one it used and how far the two diverge. Neither is silently chosen.
 *
 * 2. Aged debtors come from the ledger, NEVER from the Xero API. Xero serves
 *    AgedReceivablesByContact one contact at a time, which is unusable at this
 *    scale (b204). Nothing in this file makes an outbound call.
 *
 * 3. A partial month is flagged and EXCLUDED from every average. A half-elapsed
 *    month drags a mean down and makes the business look like it is shrinking.
 *
 * 4. Unallocated payments are surfaced, never dropped. Money can sit in `payments`
 *    with no row in `payment_allocations` — it was still received, and a report
 *    that quietly ignores it under-states income and over-states debt.
 *
 * 5. `invoice_discount_lines` (b225) may not exist yet in every schema. Its
 *    presence is probed once; a missing table means zero discount, not a 500.
 */

const DAY_MS = 86400000;

// ── small helpers ────────────────────────────────────────────────────────────
const num = v => (v == null ? 0 : Number(v) || 0);
const pence = v => Math.round(num(v));
const gbp = p => Number((num(p) / 100).toFixed(2));
// node-pg parses a Postgres `date` into a JS Date at LOCAL midnight. Calling
// toISOString() on that converts to UTC and, anywhere east of Greenwich or in
// BST, hands back YESTERDAY. Every due date, term date and bucket boundary in
// this file would be a day early. Format from the local components instead.
const iso = d => {
  if (d == null) return null;
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (y, m) => (y && m ? `${MONTH_NAMES[m - 1]} ${y}` : 'Unassigned');
const monthKey = (y, m) => (y && m ? `${y}-${String(m).padStart(2, '0')}` : null);

/** Invoice statuses that mean "this is not money anyone still owes". */
const SETTLED = ['paid', 'cancelled', 'void', 'credited', 'written_off', 'writeoff'];

// ── schema probes ────────────────────────────────────────────────────────────
// Cached per process. A cross-build dependency (b225's invoice_discount_lines)
// must not turn into a hard failure if the builds land in the other order.
const _tableCache = new Map();
async function hasTable(db, name) {
  if (_tableCache.has(name)) return _tableCache.get(name);
  const { rows } = await db.query('SELECT to_regclass($1) AS t', [name]);
  const present = !!(rows[0] && rows[0].t);
  _tableCache.set(name, present);
  return present;
}

/**
 * The service-month CTE.
 *
 * EyMan writes the period it bills for into the line description — "Monthly Invoice
 * for 01-08-2026 to 31-08-2026" — and that end date is the only trustworthy record
 * of the month an invoice actually covers. Invoices with no such line (manual
 * invoices, credit notes, Wren-generated ones) fall back to period_* and then to
 * issued_on, so every invoice lands in exactly one month.
 */
const SERVICE_MONTH_CTE = `
  inv AS (
    SELECT i.*,
           sm.svc_year, sm.svc_month,
           COALESCE(sm.svc_year,  i.period_year,  EXTRACT(year  FROM i.issued_on)::int) AS s_year,
           COALESCE(sm.svc_month, i.period_month, EXTRACT(month FROM i.issued_on)::int) AS s_month,
           COALESCE(i.period_year,  EXTRACT(year  FROM i.issued_on)::int)               AS i_year,
           COALESCE(i.period_month, EXTRACT(month FROM i.issued_on)::int)               AS i_month
      FROM invoices i
      -- b484 (2026-10-12): a demo child (children.is_demo) never counts as money. Filtered
      -- here, once, so every report built on this inv CTE (income summary, basis drift, room
      -- split, the termly report's child count) inherits the exclusion rather than each re-deriving it.
      LEFT JOIN children dc484 ON dc484.id = i.child_id
      LEFT JOIN LATERAL (
        SELECT (m)[3]::int AS svc_year, (m)[2]::int AS svc_month
          FROM (
            SELECT regexp_match(li->>'description', 'to (\\d{2})-(\\d{2})-(\\d{4})') AS m
              FROM jsonb_array_elements(i.line_items) li
             WHERE li->>'description' LIKE 'Monthly Invoice for%'
             LIMIT 1
          ) t
         WHERE t.m IS NOT NULL
      ) sm ON TRUE
     WHERE COALESCE(dc484.is_demo, false) = false
  )`;

const basisCols = basis => (basis === 'issued'
  ? { y: 'i_year', m: 'i_month' }
  : { y: 's_year', m: 's_month' });

const BASIS_NOTE = {
  service: 'Month = the month the care was DELIVERED, read from the invoice line ("Monthly Invoice for '
         + '01-08-2026 to 31-08-2026" is August). This is what "August income" normally means. Invoices with '
         + 'no such line fall back to their recorded period, then to their issue date.',
  issued: 'Month = the month recorded on the invoice (invoices.period_year / period_month), which the b205 '
        + 'EyMan import set from the ISSUE date. EyMan invoices a month ahead, so this attributes August\'s '
        + 'care to July. Use it to reconcile against EyMan, not to read the trading year.',
};

/** How far the two bases diverge, measured rather than asserted. */
async function basisDrift(db) {
  const { rows } = await db.query(`
    WITH ${SERVICE_MONTH_CTE}
    SELECT count(*) FILTER (WHERE svc_year IS NOT NULL)                                          AS with_service_period,
           count(*) FILTER (WHERE svc_year IS NOT NULL AND svc_year = i_year AND svc_month = i_month) AS same_month,
           count(*) FILTER (WHERE svc_year IS NOT NULL
                              AND (svc_year * 12 + svc_month) - (i_year * 12 + i_month) = 1)     AS service_one_month_later,
           count(*) FILTER (WHERE svc_year IS NULL)                                              AS no_service_period,
           count(*)                                                                              AS invoices
      FROM inv`);
  const r = rows[0] || {};
  return {
    invoices: num(r.invoices),
    with_service_period: num(r.with_service_period),
    no_service_period: num(r.no_service_period),
    same_month: num(r.same_month),
    service_one_month_later: num(r.service_one_month_later),
    finding: `${num(r.service_one_month_later)} of ${num(r.with_service_period)} invoices that state a service period `
           + `bill the month AFTER the period recorded on the invoice; only ${num(r.same_month)} bill their own month. `
           + 'invoices.period_month is an issue date, not a service month.',
  };
}

/**
 * A month is partial when it has not finished yet. Nothing else is guessed: an
 * unusually thin month in the past is reported as it is, because a quiet month
 * and an incomplete month are different facts and only one of them is knowable.
 */
function partialFlag(y, m, today = new Date()) {
  if (!y || !m) return { partial: true, reason: 'No period on these invoices — they cannot be placed in a month.' };
  const ty = today.getFullYear();
  const tm = today.getMonth() + 1;
  if (y > ty || (y === ty && m > tm)) {
    return { partial: true, reason: 'Future month — invoiced ahead, the month has not been traded.' };
  }
  if (y === ty && m === tm) {
    const lastDay = new Date(y, m, 0).getDate();
    return {
      partial: true,
      reason: `Current month — ${today.getDate()} of ${lastDay} days elapsed. Excluded from averages.`,
    };
  }
  return { partial: false, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. INCOME SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Income by month and by room, split gross / discount / net and billable / funded.
 *
 * @param {object} db     pg pool
 * @param {object} opts   { months, basis, includeDrafts }
 */
async function incomeSummary(db, { months = 13, basis = 'service', includeDrafts = false } = {}) {
  const b = basisCols(basis);
  const discounts = await hasTable(db, 'invoice_discount_lines');

  // b225 lands invoice_discount_lines; if it has not landed here yet, discount is
  // zero rather than an error, and the response says so.
  const discountJoin = discounts
    ? `LEFT JOIN (SELECT invoice_id, SUM(-amount_pence) AS disc_pence
                    FROM invoice_discount_lines WHERE superseded_at IS NULL
                   GROUP BY invoice_id) d ON d.invoice_id = inv.id`
    : '';
  const discountCol = discounts ? 'COALESCE(d.disc_pence, 0)' : '0';

  const statusFilter = includeDrafts ? '' : "AND inv.status <> 'draft'";

  const { rows } = await db.query(`
    WITH ${SERVICE_MONTH_CTE}
    SELECT inv.${b.y} AS y, inv.${b.m} AS m,
           count(*)                                   AS invoices,
           SUM(inv.amount_pence)                      AS net_pence,
           SUM(${discountCol})                        AS discount_pence,
           SUM(inv.funding_deduction_pence)           AS funding_deduction_pence,
           SUM(inv.amount_pence) FILTER (WHERE inv.amount_pence < 0) AS credit_pence,
           count(*) FILTER (WHERE inv.amount_pence < 0)              AS credit_notes
      FROM inv ${discountJoin}
     WHERE inv.status NOT IN ('cancelled','void') ${statusFilter}
     GROUP BY 1, 2
     ORDER BY 1 DESC NULLS LAST, 2 DESC NULLS LAST`);

  // Funded vs billable has to come from the line items, and for the imported
  // history it mostly is not there — so it is measured, not assumed.
  const { rows: fundedRows } = await db.query(`
    WITH ${SERVICE_MONTH_CTE}
    SELECT inv.${b.y} AS y, inv.${b.m} AS m,
           SUM(CASE WHEN (li->>'is_funded')::boolean IS TRUE
                    THEN COALESCE((li->>'funding_value_pence')::numeric, ABS((li->>'amount_pence')::numeric))
                    ELSE 0 END)                                     AS funded_pence,
           count(DISTINCT inv.id) FILTER (WHERE (li->>'is_funded')::boolean IS TRUE) AS invoices_with_funded_line
      FROM inv, LATERAL jsonb_array_elements(inv.line_items) li
     WHERE inv.status NOT IN ('cancelled','void') ${statusFilter}
     GROUP BY 1, 2`);
  const fundedBy = new Map(fundedRows.map(r => [`${r.y}-${r.m}`, r]));

  const today = new Date();
  let all = rows.map(r => {
    const y = r.y == null ? null : Number(r.y);
    const m = r.m == null ? null : Number(r.m);
    const f = fundedBy.get(`${r.y}-${r.m}`) || {};
    const net = pence(r.net_pence);
    const disc = pence(r.discount_pence);
    const funded = pence(f.funded_pence);
    const p = partialFlag(y, m, today);
    return {
      month: monthKey(y, m),
      label: monthLabel(y, m),
      year: y, month_number: m,
      invoices: num(r.invoices),
      gross_pence: net + disc,
      discount_pence: disc,
      net_pence: net,
      funded_pence: funded + pence(r.funding_deduction_pence),
      billable_pence: net - (funded + pence(r.funding_deduction_pence)),
      credit_notes: num(r.credit_notes),
      credit_pence: pence(r.credit_pence),
      invoices_with_funded_line: num(f.invoices_with_funded_line),
      partial: p.partial,
      partial_reason: p.reason,
    };
  });
  const unplaced = all.filter(r => !r.month);
  // The window is anchored on today, not on the newest row in the table. Invoices
  // raised months ahead are real, but they are not this year's trading — they are
  // listed separately so a 13-month window is 13 traded months.
  const nowKey = today.getFullYear() * 12 + today.getMonth() + 1;
  const placed = all.filter(r => r.month);
  const future = placed.filter(r => (r.year * 12 + r.month_number) > nowKey);
  all = placed.filter(r => (r.year * 12 + r.month_number) <= nowKey)
    .slice(0, Math.max(1, Math.min(120, months)));

  // Averages over COMPLETE months only. This is the whole reason partial months
  // are flagged: one half-month in the window moves the mean by thousands.
  const complete = all.filter(r => !r.partial);
  const excluded = all.filter(r => r.partial);
  const avg = key => (complete.length
    ? Math.round(complete.reduce((s, r) => s + r[key], 0) / complete.length) : null);
  const naiveAvg = all.length
    ? Math.round(all.reduce((s, r) => s + r.net_pence, 0) / all.length) : null;

  // Room split. invoices.room_id is almost never set on imported invoices, so the
  // child's room is the fallback — and how many children actually have one is
  // reported, because a split off 9% of the roll is not a split.
  const { rows: roomRows } = await db.query(`
    WITH ${SERVICE_MONTH_CTE}
    SELECT COALESCE(r1.name, r2.name, 'Unassigned') AS room,
           count(*)              AS invoices,
           SUM(inv.amount_pence) AS net_pence
      FROM inv
      LEFT JOIN rooms    r1 ON r1.id = inv.room_id
      LEFT JOIN children c  ON c.id  = inv.child_id
      LEFT JOIN rooms    r2 ON r2.id = c.room_id
     WHERE inv.status NOT IN ('cancelled','void') ${statusFilter}
       AND (inv.${b.y} * 12 + inv.${b.m}) >= $1
     GROUP BY 1 ORDER BY 3 DESC NULLS LAST`,
  [all.length ? (all[all.length - 1].year * 12 + all[all.length - 1].month_number) : 0]);

  const { rows: cov } = await db.query(`
    SELECT count(*) AS total,
           count(*) FILTER (WHERE room_id IS NOT NULL) AS with_room
      FROM children WHERE COALESCE(is_demo, false) = false`);

  return {
    basis,
    basis_note: BASIS_NOTE[basis] || BASIS_NOTE.service,
    basis_drift: await basisDrift(db),
    months: all,
    future_months: future.length ? future : null,
    future_months_note: future.length
      ? 'Invoices already raised for months that have not started. Real money, but not traded income — kept out '
        + 'of the window and out of every average.'
      : null,
    unplaced_invoices: unplaced.length
      ? { invoices: unplaced.reduce((s, r) => s + r.invoices, 0),
          net_pence: unplaced.reduce((s, r) => s + r.net_pence, 0),
          note: 'These invoices carry no period and no issue date, so they cannot be placed in a month. '
              + 'They are excluded from the month rows above and from every average.' }
      : null,
    rooms: roomRows.map(r => ({ room: r.room, invoices: num(r.invoices), net_pence: pence(r.net_pence) })),
    room_coverage: {
      children_total: num(cov[0] && cov[0].total),
      children_with_room: num(cov[0] && cov[0].with_room),
      note: 'Room comes from invoices.room_id where set, otherwise the child\'s current room. Children with no '
          + 'room fall into "Unassigned" — and a child\'s room is where they are NOW, not where they were when '
          + 'the invoice was raised, so historic room splits drift.',
    },
    discounts_available: discounts,
    discount_note: discounts
      ? 'Gross = net + discount. Discounts are read from invoice_discount_lines (live lines only; superseded '
        + 'lines are ignored), and net is what the invoice actually charges.'
      : 'invoice_discount_lines is not present in this schema yet (b225), so discount is reported as zero and '
        + 'gross equals net. No figure here is wrong, but no discount can be shown either.',
    funded_coverage: {
      invoices_with_a_funded_line: all.reduce((s, r) => s + r.invoices_with_funded_line, 0),
      note: 'Billable-vs-funded is split from the invoice\'s own line items. The b205 EyMan import brought each '
          + 'historic invoice across as ONE summary line with no funding breakdown, so for those invoices the '
          + 'funded column is £0.00 — that is missing detail, not a nursery with no funded children. Only '
          + 'invoices Wren itemised itself carry a real split.',
    },
    averages: {
      months_used: complete.map(r => r.month),
      months_excluded_as_partial: excluded.map(r => ({ month: r.month, reason: r.partial_reason })),
      net_pence: avg('net_pence'),
      gross_pence: avg('gross_pence'),
      discount_pence: avg('discount_pence'),
      invoices: complete.length
        ? Math.round(complete.reduce((s, r) => s + r.invoices, 0) / complete.length) : null,
      naive_average_including_partial_pence: naiveAvg,
      // Signed as "what including the partial months DOES to the average":
      // positive = it inflates the mean, negative = it drags it down. Written this
      // way round because a partial month is not always the low one — an advance
      // biller can have a nearly-full current month sitting above the average, and
      // a label that assumes "drags down" would then be plainly wrong on screen.
      partial_month_effect_pence: (avg('net_pence') != null && naiveAvg != null)
        ? naiveAvg - avg('net_pence') : null,
      partial_month_effect_direction: (avg('net_pence') != null && naiveAvg != null)
        ? (naiveAvg > avg('net_pence') ? 'inflates' : naiveAvg < avg('net_pence') ? 'deflates' : 'none')
        : null,
    },
    totals: {
      invoices: all.reduce((s, r) => s + r.invoices, 0),
      gross_pence: all.reduce((s, r) => s + r.gross_pence, 0),
      discount_pence: all.reduce((s, r) => s + r.discount_pence, 0),
      net_pence: all.reduce((s, r) => s + r.net_pence, 0),
      funded_pence: all.reduce((s, r) => s + r.funded_pence, 0),
      billable_pence: all.reduce((s, r) => s + r.billable_pence, 0),
    },
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. AGED DEBTORS
// ─────────────────────────────────────────────────────────────────────────────
const BUCKETS = [
  { key: 'current',  label: 'Not yet due' },
  { key: 'd1_30',    label: '1–30 days' },
  { key: 'd31_60',   label: '31–60 days' },
  { key: 'd61_90',   label: '61–90 days' },
  { key: 'd90_plus', label: '90+ days' },
];
function bucketOf(dueOn, asAt) {
  if (!dueOn) return 'current';
  const days = Math.floor((asAt - new Date(dueOn)) / DAY_MS);
  if (days <= 0) return 'current';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}

/**
 * Aged debtors from Wren's own invoice ledger. Never Xero.
 *
 * Outstanding is the invoice amount less everything allocated against it, so a
 * part-paid invoice ages only the part still owed.
 */
async function agedDebtors(db, { asAt = null, includeDrafts = false, limit = 500 } = {}) {
  const at = asAt ? new Date(asAt) : new Date();
  const draftClause = includeDrafts ? '' : "AND i.status <> 'draft'";

  const { rows } = await db.query(`
    SELECT i.id, i.invoice_number, i.reference, i.status, i.due_on, i.issued_on,
           i.amount_pence,
           COALESCE(a.allocated, 0) AS allocated_pence,
           i.amount_pence - COALESCE(a.allocated, 0) AS outstanding_pence,
           i.bill_payer_email,
           -- Family = the bill payer's address. Same definition as
           -- src/lib/invoice-discounts.js familyKey(), deliberately not a second
           -- one: siblings must collapse into ONE line to chase, or the office
           -- emails the same household three times about the same debt.
           COALESCE(NULLIF(lower(btrim(c.primary_contact_email)), ''),
                    NULLIF(lower(btrim(i.bill_payer_email)), '')) AS family_key,
           COALESCE(NULLIF(TRIM(c.first_name || ' ' || c.last_name), ''), '—') AS child_name,
           c.id AS child_id
      FROM invoices i
      LEFT JOIN (SELECT invoice_id, SUM(amount_pence) AS allocated
                   FROM payment_allocations GROUP BY invoice_id) a ON a.invoice_id = i.id
      LEFT JOIN children c ON c.id = i.child_id
     WHERE i.status NOT IN (${SETTLED.map((_, n) => `$${n + 1}`).join(',')})
       AND COALESCE(c.is_demo, false) = false
       ${draftClause}
       AND i.amount_pence - COALESCE(a.allocated, 0) > 0
     ORDER BY i.due_on NULLS LAST`, SETTLED);

  const buckets = Object.fromEntries(BUCKETS.map(b => [b.key, 0]));
  const families = new Map();
  for (const r of rows) {
    const out = pence(r.outstanding_pence);
    const bk = bucketOf(r.due_on, at);
    buckets[bk] += out;
    // No address on file at all: the child is their own family, because guessing
    // that two children with no email are one household would merge strangers.
    const key = r.family_key || `child:${r.child_id}`;
    if (!families.has(key)) {
      families.set(key, {
        payer: r.family_key || null,
        children: new Set(),
        invoices: [],
        total_pence: 0,
        overdue_pence: 0,
        oldest_due: null,
        worst_bucket: 'current',
      });
    }
    const f = families.get(key);
    if (r.child_name && r.child_name !== '—') f.children.add(r.child_name);
    const dueStr = iso(r.due_on);
    const daysOverdue = r.due_on ? Math.max(0, Math.floor((at - new Date(r.due_on)) / DAY_MS)) : null;
    f.invoices.push({
      id: r.id,
      invoice_number: r.invoice_number || r.reference || `#${r.id}`,
      status: r.status,
      issued_on: iso(r.issued_on),
      due_on: dueStr,
      days_overdue: daysOverdue,
      bucket: bk,
      amount_pence: pence(r.amount_pence),
      allocated_pence: pence(r.allocated_pence),
      outstanding_pence: out,
    });
    f.total_pence += out;
    if (bk !== 'current') f.overdue_pence += out;
    if (dueStr && (!f.oldest_due || dueStr < f.oldest_due)) f.oldest_due = dueStr;
    const order = BUCKETS.map(x => x.key);
    if (order.indexOf(bk) > order.indexOf(f.worst_bucket)) f.worst_bucket = bk;
  }

  const bucketTotal = Object.values(buckets).reduce((s, v) => s + v, 0);
  const ledgerTotal = rows.reduce((s, r) => s + pence(r.outstanding_pence), 0);

  // What is deliberately NOT in the buckets, stated rather than left implicit.
  const { rows: exc } = await db.query(`
    SELECT
      count(*) FILTER (WHERE i.status = 'draft')                                   AS draft_n,
      COALESCE(SUM(i.amount_pence) FILTER (WHERE i.status = 'draft'), 0)           AS draft_pence,
      count(*) FILTER (WHERE i.status = 'paid'
                         AND i.amount_pence - COALESCE(a.allocated,0) > 0)         AS paid_short_n,
      COALESCE(SUM(i.amount_pence - COALESCE(a.allocated,0))
               FILTER (WHERE i.status = 'paid'
                         AND i.amount_pence - COALESCE(a.allocated,0) > 0), 0)     AS paid_short_pence,
      count(*) FILTER (WHERE i.amount_pence < 0)                                   AS credit_n,
      COALESCE(SUM(i.amount_pence) FILTER (WHERE i.amount_pence < 0), 0)           AS credit_pence
      FROM invoices i
      LEFT JOIN (SELECT invoice_id, SUM(amount_pence) AS allocated
                   FROM payment_allocations GROUP BY invoice_id) a ON a.invoice_id = i.id`);
  const e = exc[0] || {};

  const list = [...families.values()]
    .map(f => ({ ...f, children: [...f.children] }))
    .sort((a, b2) => b2.total_pence - a.total_pence)
    .slice(0, limit);

  return {
    as_at: at.toISOString().slice(0, 10),
    source: 'Wren invoice ledger (invoices less payment_allocations). NOT the Xero API — Xero serves '
          + 'aged receivables one contact at a time, which is unusable at this scale.',
    include_drafts: !!includeDrafts,
    buckets: BUCKETS.map(b => ({ key: b.key, label: b.label, pence: buckets[b.key] })),
    total_outstanding_pence: bucketTotal,
    overdue_pence: bucketTotal - buckets.current,
    families: list,
    family_count: families.size,
    invoice_count: rows.length,
    // Acceptance: the buckets must add up to the ledger they were built from.
    reconciliation: {
      unpaid_invoice_count: rows.length,
      sum_of_unpaid_invoice_outstanding_pence: ledgerTotal,
      sum_of_bucket_totals_pence: bucketTotal,
      difference_pence: bucketTotal - ledgerTotal,
      ties: bucketTotal === ledgerTotal,
      method: 'Every unpaid invoice lands in exactly one bucket, so the two figures are the same sum taken two '
            + 'ways. If they ever differ, an invoice has been double-counted or dropped.',
    },
    excluded: {
      drafts: { invoices: num(e.draft_n), pence: pence(e.draft_pence),
        note: 'Drafts have not been issued, so nobody owes them yet. Pass include_drafts=1 to see them.' },
      paid_but_not_fully_allocated: { invoices: num(e.paid_short_n), pence: pence(e.paid_short_pence),
        note: 'Marked paid but the allocations do not cover the full amount — a reconciliation gap, not a debt. '
            + 'Chasing these would chase families who have already paid.' },
      credit_notes: { invoices: num(e.credit_n), pence: pence(e.credit_pence),
        note: 'Negative invoices (credit notes). They reduce what is owed and are not debts to chase.' },
    },
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. FUNDING RECONCILIATION
// ─────────────────────────────────────────────────────────────────────────────
const FUNDED_WEEKS_PER_YEAR = 38;   // the term-time basis the generator uses
const ALL_YEAR_WEEKS = 52;

/** Age band → the hourly rate row that governs it. Stated, not guessed silently. */
const BAND_FOR_TYPE = { two_year: '2yo', universal: '3yo', extended: '3yo', none: null };

/**
 * Funded hours CLAIMED (what the setting recorded for the child) against funded
 * hours BILLED (what came off the family's invoice), per term, per child.
 *
 * b202 found the generator under-deducts funding, and this reports that gap — it
 * does not correct it. The cause: for a stretched child, child_funding stores
 * EyMan's already-stretched weekly figure, and the generator then re-spreads that
 * figure over 38 term weeks (weekly × 38 / 12). A stretched weekly figure is
 * already an all-year average, so it should spread over ~52 (weekly × 52 / 12).
 * Deducting on 38 when the figure means 52 removes about 27% too little funding,
 * and the family is billed the difference.
 */
async function fundingReconciliation(db, { termId = null, limit = 500 } = {}) {
  const params = [];
  const termClause = termId ? `WHERE t.id = $${params.push(Number(termId))}` : '';

  const { rows: terms } = await db.query(`
    SELECT t.id, t.name, t.year, t.start_date, t.end_date,
           t.rate_under_2, t.rate_2yr_working_parents, t.rate_2yr_disadvantaged,
           t.rate_3yr_universal, t.rate_3yr_extended,
           (t.start_date <= DATE '1970-01-02') AS dates_missing,
           count(cf.id) FILTER (WHERE COALESCE(dc.is_demo, false) = false) AS children
      FROM funding_terms t
      LEFT JOIN child_funding cf ON cf.term_id = t.id
      LEFT JOIN children dc ON dc.id = cf.child_id
      ${termClause}
     GROUP BY t.id
     ORDER BY t.start_date DESC, t.id DESC`, params);

  const { rows: rateRows } = await db.query(
    'SELECT age_band, pence_per_hour, funding_year, provisional FROM funding_rates ORDER BY funding_year DESC');
  const fallbackRate = new Map();
  for (const r of rateRows) if (!fallbackRate.has(r.age_band)) fallbackRate.set(r.age_band, r);

  const { rows: cf } = await db.query(`
    SELECT cf.id, cf.child_id, cf.term_id, cf.funding_type, cf.stretched_funding,
           cf.eylog_hours_basis, cf.stretch_weeks,
           cf.universal_hours_week, cf.extended_hours_week, cf.total_hours_week,
           cf.weeks_in_term, cf.hours_used,
           COALESCE(NULLIF(TRIM(c.first_name || ' ' || c.last_name), ''), '—') AS child_name,
           c.is_active
      FROM child_funding cf
      LEFT JOIN children c ON c.id = cf.child_id
      WHERE COALESCE(c.is_demo, false) = false ${termId ? 'AND cf.term_id = $1' : ''}
     ORDER BY cf.term_id DESC, child_name
     LIMIT ${Math.max(1, Math.min(2000, limit))}`, termId ? [Number(termId)] : []);

  // What the invoices actually deducted, per child. Two sources, both counted:
  // the dedicated column and any funded line item.
  const { rows: billed } = await db.query(`
    SELECT i.child_id,
           SUM(i.funding_deduction_pence) AS column_pence,
           COALESCE(SUM(li.funded), 0)    AS line_pence
      FROM invoices i
      LEFT JOIN LATERAL (
        SELECT SUM(CASE WHEN (x->>'is_funded')::boolean IS TRUE
                        THEN COALESCE((x->>'funding_value_pence')::numeric, ABS((x->>'amount_pence')::numeric))
                        ELSE 0 END) AS funded
          FROM jsonb_array_elements(i.line_items) x
      ) li ON TRUE
     WHERE i.status NOT IN ('cancelled','void')
     GROUP BY i.child_id`);
  const billedBy = new Map(billed.map(r => [r.child_id, pence(r.column_pence) + pence(r.line_pence)]));

  const termById = new Map(terms.map(t => [t.id, t]));
  // The b205 import writes 1970-01-01 when EyMan gives it no term dates, rather
  // than inventing them. That placeholder is what "unknown" looks like here.
  const epoch = t => t.dates_missing === true;

  const children = cf.map(r => {
    const t = termById.get(r.term_id) || {};
    const weekly = num(r.universal_hours_week) + num(r.extended_hours_week);
    const stretched = r.eylog_hours_basis === 'stretched' || r.stretched_funding === true;
    const stretchWeeks = num(r.stretch_weeks) || ALL_YEAR_WEEKS;

    // Two readings of the same stored number.
    const monthlyAsGenerated = weekly * FUNDED_WEEKS_PER_YEAR / 12;
    const monthlyIfStretched = weekly * stretchWeeks / 12;
    const monthlyGapHours = stretched ? monthlyIfStretched - monthlyAsGenerated : 0;

    const band = BAND_FOR_TYPE[r.funding_type] || null;
    const termRate = r.funding_type === 'two_year' ? num(t.rate_2yr_working_parents)
      : r.funding_type === 'extended' ? num(t.rate_3yr_extended)
        : num(t.rate_3yr_universal);
    const fb = band ? fallbackRate.get(band) : null;
    const ratePence = termRate > 0 ? Math.round(termRate * 100) : (fb ? num(fb.pence_per_hour) : null);
    const rateSource = termRate > 0 ? `funding_terms.${r.funding_type} rate`
      : fb ? `funding_rates ${fb.funding_year}${fb.provisional ? ' (PROVISIONAL)' : ''}` : null;

    return {
      child_id: r.child_id,
      child_name: r.child_name,
      is_active: r.is_active === true,
      term_id: r.term_id,
      term_name: t.name || null,
      term_dates_known: !!(t.start_date && !epoch(t)),
      funding_type: r.funding_type,
      hours_basis: r.eylog_hours_basis || (stretched ? 'stretched' : 'term_time'),
      stretched,
      stretch_weeks: stretched ? stretchWeeks : null,
      weekly_hours_stored: Number(weekly.toFixed(2)),
      weeks_in_term_recorded: num(r.weeks_in_term),
      claimed_monthly_hours_as_generated: Number(monthlyAsGenerated.toFixed(2)),
      claimed_monthly_hours_if_stretched: stretched ? Number(monthlyIfStretched.toFixed(2)) : null,
      monthly_gap_hours: Number(monthlyGapHours.toFixed(2)),
      hourly_rate_pence: ratePence,
      rate_source: rateSource,
      monthly_gap_pence: ratePence != null ? Math.round(monthlyGapHours * ratePence) : null,
      billed_funded_pence_all_time: billedBy.get(r.child_id) || 0,
    };
  });
  // Largest gap first. A reconciliation nobody scrolls to the bottom of only
  // works if the rows that need a decision are the ones on screen.
  children.sort((a, b2) => (b2.monthly_gap_pence || 0) - (a.monthly_gap_pence || 0)
                        || b2.monthly_gap_hours - a.monthly_gap_hours);

  // A child has one funding row per term, and the same child appears in several.
  // Summing every row would count one child's monthly gap once per term they have
  // ever been funded in — a number several times too big. The headline is taken
  // from each child's MOST RECENT term only; the per-term rows stay below for
  // anyone who needs to see the history.
  const latestByChild = new Map();
  for (const c of children) {
    const seen = latestByChild.get(c.child_id);
    if (!seen || c.term_id > seen.term_id) latestByChild.set(c.child_id, c);
  }
  for (const c of children) c.is_childs_latest_term = latestByChild.get(c.child_id) === c;

  const latest = [...latestByChild.values()];
  const gapChildren = latest.filter(c => c.monthly_gap_hours > 0);
  const gapActive = gapChildren.filter(c => c.is_active);
  const sumPence = list => list.reduce((s, c) => s + (c.monthly_gap_pence || 0), 0);
  const sumHours = list => Number(list.reduce((s, c) => s + c.monthly_gap_hours, 0).toFixed(2));
  const gapPence = sumPence(gapActive);
  const noRate = gapChildren.filter(c => c.hourly_rate_pence == null).length;
  const billedTotal = children.reduce((s, c) => s + c.billed_funded_pence_all_time, 0);

  return {
    terms: terms.map(t => ({
      id: t.id, name: t.name, year: t.year,
      start_date: iso(t.start_date), end_date: iso(t.end_date),
      dates_known: !!(t.start_date && !epoch(t)),
      children: num(t.children),
    })),
    terms_without_dates: terms.filter(epoch).map(t => t.name),
    children,
    discrepancy: {
      scope: 'Each child\'s most recent funding term only, children still on roll.',
      children_on_a_stretched_basis: gapActive.length,
      monthly_under_deduction_hours: sumHours(gapActive),
      monthly_under_deduction_pence: gapPence,
      annual_under_deduction_pence: gapPence * 12,
      including_children_who_have_left: {
        children: gapChildren.length,
        monthly_under_deduction_hours: sumHours(gapChildren),
        monthly_under_deduction_pence: sumPence(gapChildren),
        note: 'The same figure with leavers included. Historic exposure, not a live monthly cost.',
      },
      children_with_no_usable_rate: noRate,
      counting_note: 'Counted once per child, from their latest term. The per-child rows below list every term a '
                   + 'child has been funded in, so summing that list instead would count one child several times.',
      explanation:
        'For a child on a stretched basis, child_funding.universal_hours_week holds EyMan\'s already-stretched '
      + `weekly figure — an all-year average. The invoice generator spreads it over ${FUNDED_WEEKS_PER_YEAR} term `
      + 'weeks (weekly × 38 ÷ 12), which is the arithmetic for a TERM-TIME weekly figure. Applied to a stretched '
      + `figure it deducts roughly ${Math.round((1 - FUNDED_WEEKS_PER_YEAR / ALL_YEAR_WEEKS) * 100)}% too little `
      + 'funding, and the family is billed the difference. This report measures the gap. It does not change a '
      + 'single stored hour, rate or invoice — the fix is a decision about which figure the column is supposed '
      + 'to hold, and that is not a report\'s call.',
    },
    billed_funded_pence_all_time: billedTotal,
    data_quality: [
      terms.some(epoch)
        ? { issue: 'Terms with no dates',
          detail: `${terms.filter(epoch).length} funding terms carry the placeholder date `
                + '1970-01-01. EyMan report 61 does not publish term dates, and the b205 import refused to invent '
                + 'them. Until a term has real dates, invoices cannot be attributed to it and "claimed vs billed '
                + 'per term" cannot be closed — only per child, as above.' }
        : null,
      billedTotal === 0
        ? { issue: 'Nothing recorded as billed funding',
          detail: 'No invoice in this ledger carries a funding deduction, in the column or as a funded line item. '
                + 'The imported EyMan invoices came across as a single summary line, so the funding they netted off '
                + 'is inside the total and cannot be separated. "Billed" here means what Wren can PROVE was '
                + 'deducted, which is not the same as what was deducted.' }
        : null,
    ].filter(Boolean),
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. PAYMENTS RECEIVED
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Payments by month and by method, with the unallocated total.
 *
 * Unallocated money is the point of this report. A payment with no allocation was
 * still received; leaving it out under-states income and makes the bank impossible
 * to reconcile.
 */
async function paymentsReceived(db, { months = 13 } = {}) {
  const { rows } = await db.query(`
    SELECT EXTRACT(year  FROM COALESCE(p.paid_on, p.created_at::date))::int AS y,
           EXTRACT(month FROM COALESCE(p.paid_on, p.created_at::date))::int AS m,
           p.payment_method,
           count(*)                AS payments,
           SUM(p.amount_pence)     AS received_pence,
           COALESCE(SUM(a.alloc), 0) AS allocated_pence
      FROM payments p
      LEFT JOIN (SELECT payment_id, SUM(amount_pence) AS alloc
                   FROM payment_allocations GROUP BY payment_id) a ON a.payment_id = p.id
      LEFT JOIN children c ON c.id = p.child_id
     WHERE p.status NOT IN ('failed','cancelled','refunded')
       AND COALESCE(c.is_demo, false) = false
     GROUP BY 1, 2, 3
     ORDER BY 1 DESC NULLS LAST, 2 DESC NULLS LAST`);

  const today = new Date();
  const byMonth = new Map();
  const byMethod = new Map();
  for (const r of rows) {
    const key = monthKey(r.y, r.m);
    if (!byMonth.has(key)) {
      const p = partialFlag(r.y, r.m, today);
      byMonth.set(key, {
        month: key, label: monthLabel(r.y, r.m), year: r.y, month_number: r.m,
        payments: 0, received_pence: 0, allocated_pence: 0, unallocated_pence: 0,
        methods: {}, partial: p.partial, partial_reason: p.reason,
      });
    }
    const mo = byMonth.get(key);
    mo.payments += num(r.payments);
    mo.received_pence += pence(r.received_pence);
    mo.allocated_pence += pence(r.allocated_pence);
    mo.unallocated_pence = mo.received_pence - mo.allocated_pence;
    const meth = r.payment_method || 'Unrecorded';
    mo.methods[meth] = (mo.methods[meth] || 0) + pence(r.received_pence);
    if (!byMethod.has(meth)) byMethod.set(meth, { method: meth, payments: 0, received_pence: 0, allocated_pence: 0 });
    const mm = byMethod.get(meth);
    mm.payments += num(r.payments);
    mm.received_pence += pence(r.received_pence);
    mm.allocated_pence += pence(r.allocated_pence);
  }

  const allMonths = [...byMonth.values()].filter(m => m.month);
  const monthList = allMonths.slice(0, Math.max(1, Math.min(120, months)));

  // The headline unallocated figure, taken over the whole ledger rather than the
  // window — money that fell out of the window is still money nobody has matched.
  const { rows: un } = await db.query(`
    SELECT count(*)                                    AS payments,
           COALESCE(SUM(p.amount_pence), 0)            AS received_pence,
           COALESCE(SUM(COALESCE(a.alloc, 0)), 0)      AS allocated_pence,
           count(*) FILTER (WHERE a.alloc IS NULL)     AS payments_with_no_allocation,
           COALESCE(SUM(p.amount_pence) FILTER (WHERE a.alloc IS NULL), 0) AS no_allocation_pence,
           count(*) FILTER (WHERE p.invoice_id IS NULL) AS payments_with_no_invoice,
           count(*) FILTER (WHERE a.alloc > p.amount_pence) AS over_allocated_payments,
           COALESCE(SUM(a.alloc - p.amount_pence) FILTER (WHERE a.alloc > p.amount_pence), 0) AS over_allocated_pence
      FROM payments p
      LEFT JOIN (SELECT payment_id, SUM(amount_pence) AS alloc
                   FROM payment_allocations GROUP BY payment_id) a ON a.payment_id = p.id
      LEFT JOIN children c ON c.id = p.child_id
     WHERE p.status NOT IN ('failed','cancelled','refunded')
       AND COALESCE(c.is_demo, false) = false`);
  const u = un[0] || {};

  const { rows: orph } = await db.query(`
    SELECT count(*) AS n, COALESCE(SUM(a.amount_pence), 0) AS pence
      FROM payment_allocations a
     WHERE a.invoice_id IS NULL
        OR NOT EXISTS (SELECT 1 FROM invoices i WHERE i.id = a.invoice_id)`);

  const complete = monthList.filter(m => !m.partial);
  return {
    months: monthList,
    months_excluded_as_partial: monthList.filter(m => m.partial).map(m => ({ month: m.month, reason: m.partial_reason })),
    average_monthly_received_pence: complete.length
      ? Math.round(complete.reduce((s, m) => s + m.received_pence, 0) / complete.length) : null,
    methods: [...byMethod.values()].sort((a, b) => b.received_pence - a.received_pence),
    unallocated: {
      total_received_pence: pence(u.received_pence),
      total_allocated_pence: pence(u.allocated_pence),
      unallocated_pence: pence(u.received_pence) - pence(u.allocated_pence),
      payments_with_no_allocation: num(u.payments_with_no_allocation),
      no_allocation_pence: pence(u.no_allocation_pence),
      payments_with_no_invoice_id: num(u.payments_with_no_invoice),
      orphaned_allocations: num(orph[0] && orph[0].n),
      orphaned_allocation_pence: pence(orph[0] && orph[0].pence),
      over_allocated_payments: num(u.over_allocated_payments),
      over_allocated_pence: pence(u.over_allocated_pence),
      over_allocated_note: num(u.over_allocated_payments)
        ? `${num(u.over_allocated_payments)} payments have MORE allocated against them than was received. That is `
          + 'why a month here can show a negative unallocated figure: the same money has been matched to two '
          + 'invoices, or an allocation was recorded twice. It is a matching fault, not extra income.'
        : null,
      note: 'Unallocated money was received but is not matched to an invoice. It is real income and it is shown '
          + 'here rather than dropped. An allocation whose invoice no longer exists is counted separately — that '
          + 'is a broken link, not unmatched money.',
    },
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. DEBTOR CHASE LIST
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Who to chase, how much, how overdue, and when they were last contacted.
 *
 * Sorted by how long the oldest debt has been outstanding rather than by size:
 * a small debt nobody has mentioned for four months is a worse sign than a large
 * one that went out last week.
 */
async function chaseList(db, { minPence = 1, limit = 200, asAt = null } = {}) {
  const aged = await agedDebtors(db, { asAt, includeDrafts: false, limit: 5000 });
  const at = new Date(aged.as_at);

  const emails = aged.families.map(f => f.payer).filter(Boolean);
  const contacts = new Map();
  if (emails.length) {
    const { rows } = await db.query(`
      SELECT lower(e) AS email, MAX(ea.occurred_at) AS last_contact
        FROM email_audit ea, LATERAL unnest(ea.to_emails) AS e
       WHERE ea.direction = 'outbound' AND lower(e) = ANY($1::text[])
       GROUP BY 1`, [emails.map(e => e.toLowerCase())]).catch(() => ({ rows: [] }));
    for (const r of rows) contacts.set(r.email, r.last_contact);
  }

  // An invoice that has been sent is itself a contact, and for most families it is
  // the only one on record.
  const { rows: sent } = await db.query(`
    SELECT lower(i.bill_payer_email) AS email, MAX(i.sent_at) AS last_sent
      FROM invoices i
     WHERE i.bill_payer_email IS NOT NULL AND i.sent_at IS NOT NULL
     GROUP BY 1`).catch(() => ({ rows: [] }));
  const sentBy = new Map(sent.map(r => [r.email, r.last_sent]));

  const rows = aged.families
    .filter(f => f.overdue_pence >= Math.max(1, minPence))
    .map(f => {
      const email = (f.payer || '').toLowerCase();
      const lastEmail = contacts.get(email) || null;
      const lastSent = sentBy.get(email) || null;
      const last = [lastEmail, lastSent].filter(Boolean).sort().pop() || null;
      const daysOverdue = f.oldest_due
        ? Math.max(0, Math.floor((at - new Date(f.oldest_due)) / DAY_MS)) : null;
      return {
        payer: f.payer,
        children: f.children,
        overdue_pence: f.overdue_pence,
        total_outstanding_pence: f.total_pence,
        invoice_count: f.invoices.length,
        invoice_numbers: f.invoices.filter(i => i.bucket !== 'current').map(i => i.invoice_number),
        oldest_due: f.oldest_due,
        days_overdue: daysOverdue,
        worst_bucket: (BUCKETS.find(b => b.key === f.worst_bucket) || {}).label || f.worst_bucket,
        last_contact: last ? iso(new Date(last)) : null,
        last_contact_source: last ? (last === lastSent ? 'invoice sent' : 'outbound email') : null,
        days_since_contact: last ? Math.floor((at - new Date(last)) / DAY_MS) : null,
        no_email_on_file: !f.payer,
      };
    })
    .sort((a, b) => (b.days_overdue || 0) - (a.days_overdue || 0) || b.overdue_pence - a.overdue_pence)
    .slice(0, Math.max(1, Math.min(2000, limit)));

  return {
    as_at: aged.as_at,
    families: rows,
    family_count: rows.length,
    total_overdue_pence: rows.reduce((s, r) => s + r.overdue_pence, 0),
    never_contacted: rows.filter(r => !r.last_contact).length,
    no_email_on_file: rows.filter(r => r.no_email_on_file).length,
    contact_note: 'Last contact is the later of the last outbound email logged in email_audit and the last time '
                + 'an invoice was marked sent. Wren only knows what went through Wren — a phone call at the door '
                + 'or a message from a personal mailbox leaves no trace here, so "never contacted" means "no '
                + 'record", not "nobody spoke to them".',
    advisory: 'This is a list to work through. Wren does not chase, email or charge anybody from this report.',
    generated_at: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV
// ─────────────────────────────────────────────────────────────────────────────
const csvCell = v => {
  if (v == null) return '';
  const s = Array.isArray(v) ? v.join('; ') : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csvRows = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const money = p => (p == null ? '' : (num(p) / 100).toFixed(2));

/** Every report renders to a flat sheet. Notes ride along as trailing rows so the
 *  caveat cannot be separated from the numbers by saving the file. */
function toCsv(report, data) {
  switch (report) {
    case 'income': {
      const head = ['Month', 'Invoices', 'Gross (£)', 'Discount (£)', 'Net (£)', 'Funded (£)', 'Billable (£)',
        'Credit notes', 'Partial month', 'Why partial'];
      const body = data.months.map(m => [m.label, m.invoices, money(m.gross_pence), money(m.discount_pence),
        money(m.net_pence), money(m.funded_pence), money(m.billable_pence), m.credit_notes,
        m.partial ? 'YES' : '', m.partial_reason || '']);
      const foot = [
        [],
        ['Totals', data.totals.invoices, money(data.totals.gross_pence), money(data.totals.discount_pence),
          money(data.totals.net_pence), money(data.totals.funded_pence), money(data.totals.billable_pence)],
        ['Average per COMPLETE month', data.averages.invoices, money(data.averages.gross_pence),
          money(data.averages.discount_pence), money(data.averages.net_pence)],
        ['Average if partial months were included', '', '', '', money(data.averages.naive_average_including_partial_pence)],
        [],
        ['Month basis', data.basis],
        ['Basis note', data.basis_note],
        ['Basis drift', data.basis_drift.finding],
        ['Funded split', data.funded_coverage.note],
        ['Rooms', data.room_coverage.note],
        ['Discounts', data.discount_note],
        ['Generated', data.generated_at],
      ];
      return csvRows([head, ...body, ...foot]);
    }
    // b365 — money received, attributed to the month of the invoice it pays.
    case 'income-by-period': {
      const head = ['Month', 'Received (£)', 'Paid in the month (£)', 'Paid early (£)', 'Paid late (£)',
        'Allocations', 'Payments', 'Invoices', 'Partial month', 'Why partial'];
      const body = data.months.map(m => [m.label, money(m.received_pence), money(m.paid_in_month_pence),
        money(m.paid_early_pence), money(m.paid_late_pence), m.allocations, m.payments, m.invoices,
        m.partial ? 'YES' : '', m.partial_reason || '']);
      const foot = [
        [],
        ['Average per COMPLETE month', money(data.average_monthly_received_pence)],
        [],
        ['Basis', data.basis],
        ['Basis note', data.basis_note],
        ['Reattributed', data.reattributed.note],
        ['On account (no period)', money(data.on_account.pence), `${data.on_account.payments} payments`],
        ['On account note', data.on_account.note],
        ...data.period_sources.map(r => ['Period source', r.source, r.allocations]),
        ['Generated', data.generated_at],
      ];
      return csvRows([head, ...body, ...foot]);
    }
    case 'aged-debtors': {
      const head = ['Family (bill payer)', 'Children', 'Invoice number', 'Issued', 'Due', 'Days overdue',
        'Bucket', 'Invoice (£)', 'Allocated (£)', 'Outstanding (£)'];
      const body = [];
      for (const f of data.families) {
        for (const i of f.invoices) {
          body.push([f.payer || '(no email on file)', f.children, i.invoice_number, i.issued_on, i.due_on,
            i.days_overdue, (BUCKETS.find(b => b.key === i.bucket) || {}).label || i.bucket,
            money(i.amount_pence), money(i.allocated_pence), money(i.outstanding_pence)]);
        }
        body.push([`${f.payer || '(no email on file)'} — TOTAL`, '', '', '', f.oldest_due, '', '', '', '',
          money(f.total_pence)]);
      }
      const foot = [
        [],
        ...data.buckets.map(b => [b.label, '', '', '', '', '', '', '', '', money(b.pence)]),
        ['TOTAL OUTSTANDING', '', '', '', '', '', '', '', '', money(data.total_outstanding_pence)],
        ['Sum of unpaid invoices', '', '', '', '', '', '', '', '', money(data.reconciliation.sum_of_unpaid_invoice_outstanding_pence)],
        ['Ties?', data.reconciliation.ties ? 'YES' : 'NO — investigate'],
        [],
        ['As at', data.as_at],
        ['Source', data.source],
        ['Excluded — drafts', `${data.excluded.drafts.invoices} invoices, £${money(data.excluded.drafts.pence)}`],
        ['Excluded — paid but not fully allocated',
          `${data.excluded.paid_but_not_fully_allocated.invoices} invoices, £${money(data.excluded.paid_but_not_fully_allocated.pence)}`],
        ['Generated', data.generated_at],
      ];
      return csvRows([head, ...body, ...foot]);
    }
    case 'funding': {
      const head = ['Child', 'Term', 'Term dates known', 'Funding type', 'Hours basis', 'Weekly hours stored',
        'Monthly hours as generated (×38÷12)', 'Monthly hours if stretched (×weeks÷12)', 'Gap (hours/month)',
        'Rate (£/hr)', 'Rate source', 'Gap (£/month)', 'Billed funded to date (£)'];
      const body = data.children.map(c => [c.child_name, c.term_name, c.term_dates_known ? 'yes' : 'NO',
        c.funding_type, c.hours_basis, c.weekly_hours_stored, c.claimed_monthly_hours_as_generated,
        c.claimed_monthly_hours_if_stretched, c.monthly_gap_hours,
        c.hourly_rate_pence == null ? '' : money(c.hourly_rate_pence), c.rate_source || '',
        money(c.monthly_gap_pence), money(c.billed_funded_pence_all_time)]);
      const foot = [
        [],
        ['Children on a stretched basis', data.discrepancy.children_on_a_stretched_basis],
        ['Under-deduction per month (hours)', data.discrepancy.monthly_under_deduction_hours],
        ['Under-deduction per month (£)', money(data.discrepancy.monthly_under_deduction_pence)],
        ['Under-deduction per year (£)', money(data.discrepancy.annual_under_deduction_pence)],
        ['Explanation', data.discrepancy.explanation],
        ...data.data_quality.map(q => [q.issue, q.detail]),
        ['Generated', data.generated_at],
      ];
      return csvRows([head, ...body, ...foot]);
    }
    case 'payments': {
      const methods = data.methods.map(m => m.method);
      const head = ['Month', 'Payments', 'Received (£)', 'Allocated (£)', 'Unallocated (£)', 'Partial month',
        ...methods.map(m => `${m} (£)`)];
      const body = data.months.map(mo => [mo.label, mo.payments, money(mo.received_pence),
        money(mo.allocated_pence), money(mo.unallocated_pence), mo.partial ? 'YES' : '',
        ...methods.map(m => money(mo.methods[m] || 0))]);
      const foot = [
        [],
        ['Average per COMPLETE month (£)', '', money(data.average_monthly_received_pence)],
        [],
        ['UNALLOCATED — whole ledger'],
        ['Total received (£)', money(data.unallocated.total_received_pence)],
        ['Total allocated (£)', money(data.unallocated.total_allocated_pence)],
        ['Unallocated (£)', money(data.unallocated.unallocated_pence)],
        ['Payments with no allocation at all', data.unallocated.payments_with_no_allocation],
        ['…worth (£)', money(data.unallocated.no_allocation_pence)],
        ['Payments with no invoice_id', data.unallocated.payments_with_no_invoice_id],
        ['Orphaned allocations', data.unallocated.orphaned_allocations],
        ['Note', data.unallocated.note],
        ['Generated', data.generated_at],
      ];
      return csvRows([head, ...body, ...foot]);
    }
    case 'chase-list': {
      const head = ['Family (bill payer)', 'Children', 'Overdue (£)', 'Total outstanding (£)', 'Invoices',
        'Invoice numbers', 'Oldest due', 'Days overdue', 'Worst bucket', 'Last contact', 'Last contact via',
        'Days since contact'];
      const body = data.families.map(f => [f.payer || '(no email on file)', f.children, money(f.overdue_pence),
        money(f.total_outstanding_pence), f.invoice_count, f.invoice_numbers, f.oldest_due, f.days_overdue,
        f.worst_bucket, f.last_contact || 'no record', f.last_contact_source || '', f.days_since_contact]);
      const foot = [
        [],
        ['Families to chase', data.family_count],
        ['Total overdue (£)', money(data.total_overdue_pence)],
        ['No contact on record', data.never_contacted],
        ['Contact note', data.contact_note],
        ['Advisory', data.advisory],
        ['Generated', data.generated_at],
      ];
      return csvRows([head, ...body, ...foot]);
    }
    default:
      return '';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. MONEY RECEIVED, BY THE PERIOD OF THE INVOICE IT PAYS  (b365, 2026-09-29)
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Toby: "if a parent pays the Oct invoice today, it's for the Oct period, even
 * though paid in September."
 *
 * paymentsReceived() above answers "what did the bank do in September". This
 * answers "what did September EARN", and they are different questions with
 * different right answers. Both are kept, side by side, because a nursery needs
 * the first one to reconcile a bank statement and the second one to read a
 * trading year.
 *
 * The period comes off `payment_allocations.period_*`, written at match time by
 * src/lib/allocation-period.js and backfilled by the b365 migration. Where an
 * old row has none, the view re-derives it with the same rule, so a row written
 * before this build still lands in the right month rather than vanishing.
 *
 * MONEY ON ACCOUNT IS NOT GIVEN A PERIOD. A payment matched to no invoice has no
 * month it belongs to; putting it in the month it arrived would be a guess
 * dressed as a fact. It is returned separately, with the date it arrived, and
 * the caller is told the two figures do not add up to the same thing.
 */
async function incomeByInvoicePeriod(db, { months = 13 } = {}) {
  const { rows } = await db.query(`
    SELECT v.period_year AS y, v.period_month AS m,
           count(*)                                        AS allocations,
           count(DISTINCT v.payment_id)                    AS payments,
           count(DISTINCT v.invoice_id)                    AS invoices,
           SUM(v.amount_pence)                             AS received_pence,
           SUM(v.amount_pence) FILTER (
             WHERE date_trunc('month', v.paid_on)
                 < make_date(v.period_year, v.period_month, 1))       AS paid_early_pence,
           SUM(v.amount_pence) FILTER (
             WHERE date_trunc('month', v.paid_on)
                 > make_date(v.period_year, v.period_month, 1))       AS paid_late_pence
      FROM v_allocation_periods v
     WHERE v.payment_status IS NULL OR v.payment_status NOT IN ('failed','cancelled','refunded')
     GROUP BY 1, 2
     ORDER BY 1 DESC NULLS LAST, 2 DESC NULLS LAST`);

  const today = new Date();
  const list = rows.map(r => {
    const p = partialFlag(r.y, r.m, today);
    return {
      month: monthKey(r.y, r.m), label: monthLabel(r.y, r.m),
      year: r.y, month_number: r.m,
      allocations: num(r.allocations), payments: num(r.payments), invoices: num(r.invoices),
      received_pence: pence(r.received_pence),
      paid_early_pence: pence(r.paid_early_pence),
      paid_late_pence: pence(r.paid_late_pence),
      paid_in_month_pence: pence(r.received_pence) - pence(r.paid_early_pence) - pence(r.paid_late_pence),
      partial: p.partial, partial_reason: p.reason,
    };
  }).filter(r => r.month);

  const window = list.slice(0, Math.max(1, Math.min(120, months)));
  const complete = window.filter(m => !m.partial);

  // How much money this reframing actually moves. Without this the change is a
  // claim; with it, it is a measurement.
  const { rows: [drift] } = await db.query(`
    SELECT count(*) FILTER (
             WHERE v.paid_on IS NOT NULL
               AND date_trunc('month', v.paid_on) <> make_date(v.period_year, v.period_month, 1)
           )                                                            AS allocations_in_a_different_month,
           COALESCE(SUM(v.amount_pence) FILTER (
             WHERE v.paid_on IS NOT NULL
               AND date_trunc('month', v.paid_on) <> make_date(v.period_year, v.period_month, 1)
           ), 0)                                                        AS pence_in_a_different_month,
           count(*)                                                     AS allocations
      FROM v_allocation_periods v
     WHERE v.period_year IS NOT NULL AND v.period_month IS NOT NULL`);

  const { rows: [acct] } = await db.query(`
    SELECT count(*) AS payments, COALESCE(SUM(on_account_pence), 0) AS pence
      FROM v_money_on_account WHERE on_account_pence > 0`);

  const { rows: srcRows } = await db.query(`
    SELECT COALESCE(period_source, 'derived_at_read') AS source, count(*) AS n
      FROM payment_allocations GROUP BY 1 ORDER BY 2 DESC`);

  return {
    basis: 'invoice_period',
    basis_note: 'Each payment counts in the month of the INVOICE it pays, not the day the bank moved. '
              + 'An October invoice settled on 28 September is October income. The period is the month the '
              + 'care was delivered: invoices.service_from, then the EyMan service line, then the recorded '
              + 'period, then the issue date — the same rule the income summary uses for basis=service.',
    months: window,
    months_excluded_as_partial: window.filter(m => m.partial).map(m => ({ month: m.month, reason: m.partial_reason })),
    average_monthly_received_pence: complete.length
      ? Math.round(complete.reduce((s, m) => s + m.received_pence, 0) / complete.length) : null,
    reattributed: {
      allocations: num(drift.allocations),
      allocations_in_a_different_month: num(drift.allocations_in_a_different_month),
      pence_in_a_different_month: pence(drift.pence_in_a_different_month),
      note: `${num(drift.allocations_in_a_different_month)} of ${num(drift.allocations)} allocations were paid in a `
          + 'different calendar month from the one they are now counted in. That figure is the whole difference '
          + 'between this report and "payments received".',
    },
    on_account: {
      payments: num(acct.payments),
      pence: pence(acct.pence),
      note: 'Money received that is matched to no invoice. It has NO period — it is not counted in any month '
          + 'above, because the month it arrived in is not evidence of the month it is for. It keeps the date '
          + 'it arrived and is listed here so it cannot be lost.',
    },
    period_sources: srcRows.map(r => ({ source: r.source, allocations: num(r.n) })),
    generated_at: new Date().toISOString(),
  };
}

module.exports = {
  incomeSummary,
  incomeByInvoicePeriod,   // b365
  agedDebtors,
  fundingReconciliation,
  paymentsReceived,
  chaseList,
  basisDrift,
  toCsv,
  BUCKETS,
  // b346 — the termly money report counts children billed per SERVICE month and must
  // agree with this report about what a service month is, so it imports the CTE
  // rather than carrying a second copy of the invoice-line regex.
  SERVICE_MONTH_CTE,
};
