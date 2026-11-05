'use strict';
/**
 * b365 — which accounting period does a payment belong to?
 *
 * Toby, 2026-09-28: "if a parent pays the Oct invoice today, it's for the Oct
 * period, even though paid in September."
 *
 * The date the bank moved is a fact about the bank. The period is a fact about
 * the INVOICE, and an invoice already carries one. This file is the single
 * place that rule is written down, so the allocation writers, the income
 * report, the P&L and the Xero push cannot each decide it slightly differently
 * and then disagree about what October earned.
 *
 * ── THE ORDER, AND WHY ──────────────────────────────────────────────────────
 *   1. invoices.service_from                   — the month the care was given,
 *                                                stated explicitly by Wren's own
 *                                                invoice generator
 *   2. the EyMan line description               — "Monthly Invoice for 01-10-2026
 *                                                to 31-10-2026" is October
 *   3. invoices.period_year / period_month      — the recorded period
 *   4. invoices.issued_on                       — the month it was billed
 *   5. nothing                                  — the money is ON ACCOUNT
 *
 * The SERVICE month leads, and that ordering is not arbitrary: it is the same
 * rule SERVICE_MONTH_CTE in src/lib/finance-reports.js uses for the default
 * basis of the income report (b227). Two definitions of "which month is this"
 * in one finance module is how two screens end up disagreeing about what
 * October earned, so this file follows that one rather than inventing a second.
 *
 * b227 found the b205 EyMan import had written the ISSUE month into period_*,
 * putting 4,021 of 4,115 invoices a month early. That has since been corrected —
 * measured 2026-09-29 on both wren_dev and prod, 4 of 4,151 invoices that state
 * a service period still disagree with their recorded period. Four is not zero,
 * so the service month still leads.
 *
 * Step 4 is deliberately not "fall back to the paid date". A payment matched to
 * no invoice has no period, and inventing one out of the paid date would put it
 * in a month at random and hide the fact that nobody has matched it. Unallocated
 * money is reported separately, with the date it arrived.
 *
 * `source` travels with the answer. A period that was read off the invoice and
 * a period that was derived from an issue date are different qualities of fact,
 * and a report that cannot tell them apart will eventually be asked to.
 */

const SOURCES = Object.freeze({
  SERVICE_FROM:   'invoice_service_from',
  SERVICE_LINE:   'invoice_service_line',
  INVOICE_PERIOD: 'invoice_period',
  ISSUED_ON:      'invoice_issued_on',
  NONE:           null,
});

/** "Monthly Invoice for 01-10-2026 to 31-10-2026" → October 2026. */
const SERVICE_LINE_RX = /to (\d{2})-(\d{2})-(\d{4})/;
function _serviceLineMonth(lineItems) {
  if (!Array.isArray(lineItems)) return null;
  for (const li of lineItems) {
    const d = li && li.description;
    if (typeof d !== 'string' || !d.startsWith('Monthly Invoice for')) continue;
    const m = d.match(SERVICE_LINE_RX);
    if (m) return { year: Number(m[3]), month: Number(m[2]) };
  }
  return null;
}

const NONE = Object.freeze({ year: null, month: null, source: null });

function _ym(value) {
  if (!value) return null;
  // A pg DATE arrives as a JS Date at LOCAL midnight. getFullYear()/getMonth()
  // read it correctly; toISOString() shifts it back an hour over BST and can
  // report December for a January date. See reference_pg_date_ymd_trap.
  if (value instanceof Date) {
    return { year: value.getFullYear(), month: value.getMonth() + 1 };
  }
  const m = String(value).slice(0, 10).match(/^(\d{4})-(\d{2})/);
  return m ? { year: Number(m[1]), month: Number(m[2]) } : null;
}

/**
 * @param {object|null} invoice a row from ladn.invoices (period_year,
 *        period_month, service_from, issued_on are the only columns read)
 * @returns {{year:number|null, month:number|null, source:string|null}}
 */
function periodOfInvoice(invoice) {
  if (!invoice) return NONE;
  const svc = _ym(invoice.service_from);
  if (svc) return { year: svc.year, month: svc.month, source: SOURCES.SERVICE_FROM };
  const line = _serviceLineMonth(invoice.line_items);
  if (line) return { year: line.year, month: line.month, source: SOURCES.SERVICE_LINE };
  const y = Number(invoice.period_year);
  const m = Number(invoice.period_month);
  if (Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12) {
    return { year: y, month: m, source: SOURCES.INVOICE_PERIOD };
  }
  const iss = _ym(invoice.issued_on);
  if (iss) return { year: iss.year, month: iss.month, source: SOURCES.ISSUED_ON };
  return NONE;
}

/**
 * The same answer, read straight from the database, for the writers that hold
 * an invoice id rather than a row. Returns NONE for an id that does not exist
 * rather than throwing — an allocation against a missing invoice is a matching
 * fault to be reported, not a reason to fail the payment.
 */
async function periodOfInvoiceId(db, invoiceId) {
  if (!invoiceId) return NONE;
  const { rows } = await db.query(
    `SELECT period_year, period_month, service_from, issued_on, line_items
       FROM invoices WHERE id = $1`, [invoiceId]);
  return periodOfInvoice(rows[0] || null);
}

/**
 * The same rule in SQL, for the backfill and the views. Emitted as a LATERAL
 * join so a query can select `ap.period_year, ap.period_month, ap.period_source`
 * for an invoice aliased `i`. Kept beside the JavaScript so the two can be
 * compared by eye when either changes.
 */
const SERVICE_LINE_SQL = `
  LEFT JOIN LATERAL (
    SELECT (regexp_match(li->>'description', 'to (\\d{2})-(\\d{2})-(\\d{4})'))[3]::int AS y,
           (regexp_match(li->>'description', 'to (\\d{2})-(\\d{2})-(\\d{4})'))[2]::int AS m
      FROM jsonb_array_elements(i.line_items) li
     WHERE jsonb_typeof(i.line_items) = 'array'
       AND li->>'description' LIKE 'Monthly Invoice for%'
       AND li->>'description' ~ 'to \\d{2}-\\d{2}-\\d{4}'
     LIMIT 1
  ) sl ON TRUE`;

const PERIOD_SQL = SERVICE_LINE_SQL + `
  LEFT JOIN LATERAL (
    SELECT COALESCE(EXTRACT(year  FROM i.service_from)::int, sl.y, i.period_year,
                    EXTRACT(year  FROM i.issued_on)::int) AS period_year,
           COALESCE(EXTRACT(month FROM i.service_from)::int, sl.m, i.period_month,
                    EXTRACT(month FROM i.issued_on)::int) AS period_month,
           CASE WHEN i.service_from IS NOT NULL THEN 'invoice_service_from'
                WHEN sl.y IS NOT NULL           THEN 'invoice_service_line'
                WHEN i.period_year IS NOT NULL AND i.period_month IS NOT NULL THEN 'invoice_period'
                WHEN i.issued_on IS NOT NULL    THEN 'invoice_issued_on'
                ELSE NULL END                   AS period_source
  ) ap ON TRUE`;

/** 'YYYY-MM', or null. The key every monthly report groups on. */
function periodKey(period) {
  if (!period || !period.year || !period.month) return null;
  return `${period.year}-${String(period.month).padStart(2, '0')}`;
}

module.exports = { periodOfInvoice, periodOfInvoiceId, periodKey, SOURCES, NONE,
                   PERIOD_SQL, SERVICE_LINE_SQL };
