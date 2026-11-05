'use strict';
/**
 * xero-txn-sync.js — b365 (2026-09-29)
 *
 * Mirrors Xero TRANSACTIONS into ladn.xero_transactions so Finance can show
 * "all transactions" without a round trip, and so the supplier-spend signal has
 * something deterministic to count.
 *
 * ── WHAT IT PULLS ───────────────────────────────────────────────────────────
 *   BankTransactions   SPEND / RECEIVE — money that actually moved
 *   Invoices ACCPAY    bills from suppliers (the spend side of the P&L)
 *   Invoices ACCREC    sales invoices Xero holds (kept for completeness; Wren's
 *                      own invoice ledger remains the authority on fees)
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 * It is a READ. There is no POST or PUT in this file. The b226 push guard is
 * untouched and nothing here can create a Xero invoice or payment.
 *
 * ── THE FAILURE THAT MATTERS ────────────────────────────────────────────────
 * b204 spent a long time on a Xero connection that issued a perfectly valid
 * token and then 403'd every api.xro/2.0 endpoint with an EMPTY body — an
 * org-level refusal that looks exactly like a code bug. So every failure here is
 * recorded with its HTTP status in ladn.xero_txn_sync_runs and returned to the
 * caller verbatim. A blocked sync reports `status: 'blocked'` and the exact
 * status code; it never reports zero rows as if that were an answer.
 */

const { getPool } = require('../db/pool');
const { xeroGet, refreshTokenIfNeeded } = require('./finance-xero-sync');

const pounds = v => Math.round(Number(v || 0) * 100);

/** '/Date(1600000000000+0000)/' or '2026-09-28T00:00:00' → 'YYYY-MM-DD'. */
function xeroDate(v) {
  if (!v) return null;
  const ms = String(v).match(/\/Date\((-?\d+)/);
  if (ms) {
    const d = new Date(Number(ms[1]));
    const p = n => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

/** The account a transaction is ABOUT — the first line item that names one. */
function firstAccount(lineItems) {
  for (const li of (lineItems || [])) {
    if (li && (li.AccountCode || li.AccountID)) {
      return { code: li.AccountCode || null, description: li.Description || null };
    }
  }
  const li = (lineItems || [])[0] || {};
  return { code: null, description: li.Description || null };
}

async function upsert(db, row) {
  await db.query(`
    INSERT INTO xero_transactions
      (provider_id, external_id, kind, xero_type, direction, txn_date, contact_name, reference,
       description, account_code, account_name, total_pence, tax_pence, currency, status,
       is_reconciled, xero_updated, synced_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
    ON CONFLICT (provider_id, external_id) DO UPDATE SET
      kind=$3, xero_type=$4, direction=$5, txn_date=$6, contact_name=$7, reference=$8,
      description=$9, account_code=$10, account_name=$11, total_pence=$12, tax_pence=$13,
      currency=$14, status=$15, is_reconciled=$16, xero_updated=$17, synced_at=now()`,
    [row.provider_id, row.external_id, row.kind, row.xero_type, row.direction, row.txn_date,
     row.contact_name, row.reference, row.description, row.account_code, row.account_name,
     row.total_pence, row.tax_pence, row.currency, row.status, row.is_reconciled, row.xero_updated]);
}

/** Account code → name, so a transaction can be grouped by the category a human reads. */
async function accountNames(db, providerId) {
  const { rows } = await db.query(
    `SELECT code, name FROM finance_accounts WHERE provider_id = $1 AND code IS NOT NULL`, [providerId]);
  const m = new Map();
  for (const r of rows) m.set(String(r.code), r.name);
  return m;
}

/**
 * @param {object} opts { months = 24, triggeredBy = 'manual', providerId }
 * @returns {{ok:boolean, status:string, transactions:number, bills:number, sales:number, reason?:string}}
 */
async function syncTransactions({ months = 24, triggeredBy = 'manual', providerId = null } = {}) {
  const XI = require('../lib/xero-inbound');
  if (XI.xeroInboundOff()) return { ok: true, skipped: true, reason: XI.OFF_REASON };
  const db = getPool();
  const since = new Date();
  since.setMonth(since.getMonth() - Math.max(1, Math.min(120, months)));
  const fromDate = since.toISOString().slice(0, 10);

  const { rows: [run] } = await db.query(
    `INSERT INTO xero_txn_sync_runs (from_date, triggered_by) VALUES ($1,$2) RETURNING id`,
    [fromDate, triggeredBy]);

  const fail = async (status, message, httpStatus) => {
    await db.query(
      `UPDATE xero_txn_sync_runs SET finished_at=now(), status=$2, error_message=$3, http_status=$4 WHERE id=$1`,
      [run.id, status, String(message).slice(0, 2000), httpStatus || null]);
    return { ok: false, status, reason: message, http_status: httpStatus || null,
             transactions: 0, bills: 0, sales: 0, from: fromDate, run_id: run.id };
  };

  const { rows: provs } = await db.query(
    `SELECT * FROM finance_providers
      WHERE provider='xero' AND is_active=true AND tenant_id IS NOT NULL
        AND ($1::int IS NULL OR id = $1::int)
      ORDER BY id DESC LIMIT 1`, [providerId]);
  if (!provs[0]) {
    return fail('blocked', 'No active Xero connection with a tenant id. Connect Xero in System → Integrations first.');
  }
  const provider = provs[0];

  let token;
  try {
    token = await refreshTokenIfNeeded(provider);
  } catch (e) {
    return fail('blocked', `Xero would not issue a token: ${e.message}`, e.statusCode);
  }

  const names = await accountNames(db, provider.id);
  let transactions = 0, bills = 0, sales = 0;

  // ── bank transactions ─────────────────────────────────────────────────────
  try {
    for (let page = 1; page <= 20; page++) {
      const data = await xeroGet(token, provider.tenant_id, 'BankTransactions',
        { where: `Date >= DateTime(${fromDate.replace(/-/g, ', ')})`, page });
      const list = data.BankTransactions || [];
      for (const t of list) {
        const acct = firstAccount(t.LineItems);
        await upsert(db, {
          provider_id: provider.id, external_id: t.BankTransactionID,
          kind: 'bank_transaction', xero_type: t.Type,
          direction: t.Type === 'SPEND' ? 'out' : 'in',
          txn_date: xeroDate(t.DateString || t.Date),
          contact_name: (t.Contact && t.Contact.Name) || null,
          reference: t.Reference || null, description: acct.description,
          account_code: acct.code, account_name: acct.code ? (names.get(String(acct.code)) || null) : null,
          total_pence: pounds(t.Total), tax_pence: pounds(t.TotalTax),
          currency: t.CurrencyCode || 'GBP', status: t.Status,
          is_reconciled: t.IsReconciled === true,
          xero_updated: xeroDate(t.UpdatedDateUTC),
        });
        transactions++;
      }
      if (list.length < 100) break;
    }
  } catch (e) {
    return fail(e.statusCode === 403 ? 'blocked' : 'failed',
      `BankTransactions: ${e.message}`, e.statusCode);
  }

  // ── bills and sales invoices ──────────────────────────────────────────────
  for (const [type, kind, direction] of [['ACCPAY', 'bill', 'out'], ['ACCREC', 'sales_invoice', 'in']]) {
    try {
      for (let page = 1; page <= 20; page++) {
        const data = await xeroGet(token, provider.tenant_id, 'Invoices',
          { Statuses: 'AUTHORISED,PAID', where: `Type == "${type}"`, DateFrom: fromDate, page });
        const list = data.Invoices || [];
        for (const inv of list) {
          const acct = firstAccount(inv.LineItems);
          await upsert(db, {
            provider_id: provider.id, external_id: inv.InvoiceID,
            kind, xero_type: inv.Type, direction,
            txn_date: xeroDate(inv.DateString || inv.Date),
            contact_name: (inv.Contact && inv.Contact.Name) || null,
            reference: inv.InvoiceNumber || inv.Reference || null,
            description: acct.description,
            account_code: acct.code, account_name: acct.code ? (names.get(String(acct.code)) || null) : null,
            total_pence: pounds(inv.Total), tax_pence: pounds(inv.TotalTax),
            currency: inv.CurrencyCode || 'GBP', status: inv.Status,
            is_reconciled: null, xero_updated: xeroDate(inv.UpdatedDateUTC),
          });
          if (kind === 'bill') bills++; else sales++;
        }
        if (list.length < 100) break;
      }
    } catch (e) {
      // A partial answer is still an answer — record what DID land, and say
      // exactly which half failed rather than throwing the bank rows away.
      await db.query(
        `UPDATE xero_txn_sync_runs SET finished_at=now(), status='partial',
                transactions=$2, bills=$3, sales=$4, error_message=$5, http_status=$6 WHERE id=$1`,
        [run.id, transactions, bills, sales, `${type}: ${e.message}`.slice(0, 2000), e.statusCode || null]);
      return { ok: false, status: 'partial', transactions, bills, sales,
               reason: `Bank transactions synced; ${type} failed: ${e.message}`,
               http_status: e.statusCode || null, from: fromDate, run_id: run.id };
    }
  }

  await db.query(
    `UPDATE xero_txn_sync_runs SET finished_at=now(), status='ok',
            transactions=$2, bills=$3, sales=$4 WHERE id=$1`,
    [run.id, transactions, bills, sales]);
  return { ok: true, status: 'ok', transactions, bills, sales, from: fromDate, run_id: run.id };
}

module.exports = { syncTransactions, xeroDate, firstAccount };
