'use strict';

// b202 (2026-08-19) — Xero rejects a DATE it cannot parse, and node-postgres hands DATE
// columns back as JavaScript Date objects, so the old `String(d).slice(0, 10)` produced
// "Sun Sep 24" (the head of Date.prototype.toString) rather than "2023-09-24". Every
// invoice in invoices carries an issued_on, so the nightly cron was failing on it:
// the 2026-08-19 run logged candidates 200 / pushed 0 / failed 200, 167 of them with
// `Could not convert string to DateTime: <Day Mon NN>`. Format explicitly instead.
function toXeroDate(d) {
  if (!d) return undefined;
  if (d instanceof Date) {
    if (isNaN(d)) return undefined;
    // Local getters, not toISOString(): a DATE read back at local midnight in BST would
    // slide to the previous day under UTC.
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const s = String(d).trim();
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const parsed = new Date(s);
  return isNaN(parsed) ? undefined : toXeroDate(parsed);
}

// Xero's 400s carry the real reason inside Elements[].ValidationErrors[].Message, while the
// Error's own message is truncated at 400 chars — which is why the nightly log showed 33
// failures reading only "A validation exception occurred". Surface the actual messages.
function xeroErrorDetail(err) {
  const base = err && err.message ? err.message : String(err);
  if (!err || !err.body) return base;
  try {
    const parsed = JSON.parse(err.body);
    const msgs = [];
    for (const el of parsed.Elements || []) {
      for (const ve of el.ValidationErrors || []) if (ve.Message) msgs.push(ve.Message);
    }
    if (!msgs.length && parsed.Message) msgs.push(parsed.Message);
    if (msgs.length) return `Xero HTTP ${err.statusCode}: ${[...new Set(msgs)].join(' | ')}`;
  } catch { /* not JSON — fall through to the raw message */ }
  return base;
}
// Wren → Xero invoice PUSH service (2026-08-03).
// Mirrors a Wren-generated sales invoice (invoices) into Xero as an ACCREC invoice
// (+ a Payment when paid), so Xero holds an accounting/reconciliation copy. Wren stays the
// SYSTEM OF RECORD + sender; Xero just receives. This module is additive and only writes
// back xero_invoice_id / xero_synced_at (and xero_payment_id on payments) onto Wren rows.
//
// Requires the 'accounting.transactions' (read-write) Xero scope + re-consent (see the
// scopes comment in src/routes/finance-xero.js). WITHOUT it every call returns
//   { ok:false, needsWriteScope:true, error:'Reconnect Xero with invoice-write permission' }
// and NEVER throws — a missing scope must never surface as a 500.

const { getPool } = require('../db/pool');
const { xeroApiRequest, refreshTokenIfNeeded } = require('./finance-xero-sync');

// Granular write scope this app actually has (post-2-March-2026 apps have no broad
// 'accounting.transactions'). Creating an ACCREC invoice needs accounting.invoices.
const WRITE_SCOPE        = 'accounting.invoices';
// Xero account codes / tax type — overridable via env; sensible defaults for a
// UK nursery (200 = Xero's default "Sales" revenue account; childcare is VAT-exempt).
const SALES_ACCOUNT_CODE = process.env.XERO_SALES_ACCOUNT_CODE || '200';
const BANK_ACCOUNT_CODE  = process.env.XERO_BANK_ACCOUNT_CODE  || null; // needed ONLY for payment push
const LINE_TAX_TYPE      = process.env.XERO_LINE_TAX_TYPE      || 'NONE';
const SCOPE_ERR = { ok: false, needsWriteScope: true, error: 'Reconnect Xero with invoice-write permission' };

// ── Scope pre-check — decode the Xero access token (a JWT) and look for the write scope ──
function tokenHasWriteScope(accessToken) {
  try {
    const parts = String(accessToken).split('.');
    if (parts.length < 2) return false;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    const raw = payload.scope;
    const scopes = Array.isArray(raw) ? raw : String(raw || '').split(/\s+/);
    return scopes.includes(WRITE_SCOPE);
  } catch { return false; }
}

// ── Active Xero provider (mirror the ORDER BY id LIMIT 1 used elsewhere) ──────
async function getActiveProvider(db) {
  const { rows } = await db.query(
    "SELECT * FROM finance_providers WHERE provider='xero' AND is_active=true ORDER BY id LIMIT 1"
  );
  return rows[0] || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// b226 (2026-08-25) — BACKFILL GUARD
// ───────────────────────────────────────────────────────────────────────────
// On 2026-08-25 the b222 EyMan/EyLog migration inserted 4,219 historical
// invoices (issued_on back to 2018-03-22) into invoices, every one with
// xero_invoice_id = NULL. The candidate query below used to be nothing but
//     status IN ('sent','paid') AND xero_invoice_id IS NULL
// which has no notion of "this invoice predates the Xero connection", so the
// nightly cron would have pushed all 4,308 of them into Xero at 200/night —
// each creating a Xero invoice and, for the `paid` ones, a Payment against the
// bank account, inflating the Xero bank balance with money the real bank feed
// had already recorded. That is exactly what produced the 543 bogus
// "Payment: <family> family" rows now sitting in Xero (see
// build-logs/xero-push.log and scripts/xero-bogus-payment-report.js).
//
// Two independent gates now stand between an invoice and Xero. Both FAIL
// CLOSED — a missing or unparseable setting pushes NOTHING, never everything:
//
//   1. CUTOFF   — issued_on >= settings['xero_push_from']. Held as a
//                 setting so Toby can move it without a deploy. Absent or
//                 malformed => hard stop with a clear, actionable error.
//   2. ORIGIN   — invoices that came from an EyLog/EyMan archive import are
//                 never pushed, whatever their date: Xero already holds that
//                 history via the real bank feed, so re-pushing double-counts
//                 it. Matched on the ORIGIN MARKERS (invoices.source /
//                 invoices.eylog_ref), never on created_at — created_at is a
//                 fragile proxy that any re-import would invalidate.
//
// Invoices with a NULL issued_on are excluded too: with no date we cannot show
// they sit after the cutoff, and the safe answer to that is "don't push".
// ═══════════════════════════════════════════════════════════════════════════

const PUSH_FROM_SETTING_KEY = 'xero_push_from';

// Origin markers written by the archive importers. `source` is stamped by the
// b205/b222 EyMan money migration ('eylog-import-b205'); `eylog_ref` holds the
// EyLog/EyMan invoice reference and is present on every imported row —
// including the older pre-b222 import that left `source` NULL. A genuinely
// Wren-generated invoice carries neither.
// COALESCE is load-bearing: `NULL ~* '...'` is NULL, so a genuinely
// Wren-generated invoice (source NULL, eylog_ref NULL) would evaluate this to
// `false OR NULL` = NULL, and `NOT NULL` = NULL would drop it from the
// candidate set — the guard would fail closed on EVERY real invoice, forever.
const IMPORTED_ORIGIN_SQL = "(eylog_ref IS NOT NULL OR COALESCE(source ~* '^(eylog|eyman|import|migrat)', false))";

// Shared WHERE fragment, $1 = cutoff date. Deliberately ONE definition: the
// dry-run report and the live push must never be able to disagree about what
// is eligible.
// b484 (2026-10-12): a demo child's invoices never auto-push to Xero — real accounting
// data, same rule as every other automatic money path.
const NOT_DEMO_CHILD = `NOT EXISTS (SELECT 1 FROM children dc484 WHERE dc484.id = invoices.child_id AND COALESCE(dc484.is_demo, false))`;
const PUSHABLE_WHERE = `
        status IN ('sent','paid')
    AND xero_invoice_id IS NULL
    AND issued_on IS NOT NULL
    AND issued_on >= $1::date
    AND NOT ${IMPORTED_ORIGIN_SQL}
    AND ${NOT_DEMO_CHILD}`;

// ── Read the cutoff out of settings — fail closed ───────────────────────
async function getPushCutoff(db) {
  db = db || getPool();
  let raw;
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [PUSH_FROM_SETTING_KEY]);
    raw = (rows[0] && rows[0].value != null) ? String(rows[0].value).trim() : '';
  } catch (err) {
    return { ok: false, cutoffMissing: true, error: `Could not read settings['${PUSH_FROM_SETTING_KEY}']: ${err.message}` };
  }
  if (!raw) {
    return {
      ok: false,
      cutoffMissing: true,
      error: `Xero push cutoff not configured — nothing pushed. Set settings['${PUSH_FROM_SETTING_KEY}'] `
           + `to the earliest issue date that may ever reach Xero (YYYY-MM-DD): `
           + `INSERT INTO settings(key,value) VALUES ('${PUSH_FROM_SETTING_KEY}','2026-09-01') `
           + `ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;`,
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { ok: false, cutoffMissing: true,
      error: `settings['${PUSH_FROM_SETTING_KEY}'] = "${raw}" is not a YYYY-MM-DD date — refusing to push` };
  }
  return { ok: true, cutoff: raw };
}

// ── Candidate list + exclusion accounting ────────────────────────────────────
// Returns what WOULD be pushed and — just as important — what was held back and
// why, so one line in the nightly log tells the whole story without a DB session.
async function describePushCandidates(db, { limit = 50 } = {}) {
  db = db || getPool();
  const cutoffRes = await getPushCutoff(db);
  if (!cutoffRes.ok) return cutoffRes;
  const cutoff = cutoffRes.cutoff;
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);

  const { rows: [counts] } = await db.query(`
    SELECT count(*)::int AS unsynced_total,
           count(*) FILTER (WHERE ${IMPORTED_ORIGIN_SQL})::int AS excluded_imported,
           count(*) FILTER (WHERE NOT ${IMPORTED_ORIGIN_SQL}
                              AND issued_on IS NULL)::int AS excluded_no_issue_date,
           count(*) FILTER (WHERE NOT ${IMPORTED_ORIGIN_SQL}
                              AND issued_on IS NOT NULL
                              AND issued_on < $1::date)::int AS excluded_before_cutoff,
           count(*) FILTER (WHERE NOT ${IMPORTED_ORIGIN_SQL}
                              AND issued_on IS NOT NULL
                              AND issued_on >= $1::date
                              AND ${NOT_DEMO_CHILD})::int AS eligible
      FROM invoices
     WHERE status IN ('sent','paid') AND xero_invoice_id IS NULL`, [cutoff]);

  const { rows: candidates } = await db.query(`
    SELECT id, invoice_number, issued_on, status, amount_pence, source
      FROM invoices
     WHERE ${PUSHABLE_WHERE}
     ORDER BY id
     LIMIT $2`, [cutoff, cap]);

  return {
    ok: true,
    cutoff,
    limit: cap,
    unsyncedTotal:        counts.unsynced_total,
    eligible:             counts.eligible,
    excludedImported:     counts.excluded_imported,
    excludedBeforeCutoff: counts.excluded_before_cutoff,
    excludedNoIssueDate:  counts.excluded_no_issue_date,
    excludedTotal:        counts.unsynced_total - counts.eligible,
    candidates,
  };
}

// One-line summary for the cron log.
function summariseGuard(d) {
  return `[xero-push] cutoff=${d.cutoff} unsynced=${d.unsyncedTotal} eligible=${d.eligible} `
       + `excluded=${d.excludedTotal} (imported=${d.excludedImported}, `
       + `before_cutoff=${d.excludedBeforeCutoff}, no_issue_date=${d.excludedNoIssueDate})`;
}

// ── Per-invoice gate, used by the single-invoice push route ──────────────────
// Returns { pushable:true } or { pushable:false, reason }.
async function checkInvoicePushable(db, invoiceId) {
  db = db || getPool();
  const cutoffRes = await getPushCutoff(db);
  if (!cutoffRes.ok) return { pushable: false, cutoffMissing: true, reason: cutoffRes.error };
  const { rows: [row] } = await db.query(`
    SELECT id, invoice_number, issued_on, status, source, eylog_ref,
           ${IMPORTED_ORIGIN_SQL} AS is_imported
      FROM invoices WHERE id=$1`, [invoiceId]);
  if (!row) return { pushable: false, reason: `Invoice ${invoiceId} not found` };
  const label = row.invoice_number || `#${invoiceId}`;
  if (row.is_imported) {
    return { pushable: false, reason:
      `Invoice ${label} came from the EyLog/EyMan archive import (source=${row.source || 'null'}, `
      + `eylog_ref=${row.eylog_ref || 'null'}) — Xero already holds this history via the bank feed, so `
      + `pushing it would double-count. Pass force:true to override.` };
  }
  if (!row.issued_on) {
    return { pushable: false, reason:
      `Invoice ${label} has no issued_on, so it cannot be shown to fall after the `
      + `${cutoffRes.cutoff} cutoff. Pass force:true to override.` };
  }
  const issued = toXeroDate(row.issued_on);
  if (issued < cutoffRes.cutoff) {
    return { pushable: false, reason:
      `Invoice ${label} was issued ${issued}, before the Xero push cutoff ${cutoffRes.cutoff} `
      + `(settings['${PUSH_FROM_SETTING_KEY}']). Pass force:true to override.` };
  }
  return { pushable: true, cutoff: cutoffRes.cutoff };
}

// ── Find (by email, then name) or create a Xero Contact ──────────────────────
async function findOrCreateContact(accessToken, tenantId, { email, name }) {
  const safeName = (name || email || 'Wren parent').replace(/"/g, '');
  // 1. Search by email
  if (email) {
    try {
      const r = await xeroApiRequest('GET', accessToken, tenantId, 'Contacts',
        { params: { where: `EmailAddress=="${email.replace(/"/g, '')}"` } });
      const c = (r.Contacts || [])[0];
      if (c) return c.ContactID;
    } catch (_) { /* fall through to name search / create */ }
  }
  // 2. Search by exact name
  try {
    const r = await xeroApiRequest('GET', accessToken, tenantId, 'Contacts',
      { params: { where: `Name=="${safeName}"` } });
    const c = (r.Contacts || [])[0];
    if (c) return c.ContactID;
  } catch (_) { /* fall through to create */ }
  // 3. Create
  const body = { Contacts: [{ Name: safeName, ...(email ? { EmailAddress: email } : {}) }] };
  try {
    const r = await xeroApiRequest('POST', accessToken, tenantId, 'Contacts', { body });
    return (r.Contacts || [])[0]?.ContactID;
  } catch (err) {
    // Duplicate-name (Xero enforces unique Name) → re-fetch by name and use it.
    try {
      const r = await xeroApiRequest('GET', accessToken, tenantId, 'Contacts',
        { params: { where: `Name=="${safeName}"` } });
      const c = (r.Contacts || [])[0];
      if (c) return c.ContactID;
    } catch (_) { /* fall through */ }
    throw err;
  }
}

// ── Build Xero LineItems from a Wren invoice ─────────────────────────────────
// Each Wren line_item.amount_pence is the LINE TOTAL (funding/credits are negative
// lines), so we set Quantity=1 / UnitAmount=lineTotal — the Xero total then equals the
// Wren NET amount exactly (funding already deducted). Historical invoices have empty
// line_items → fall back to a single net line from amount_pence.
function buildLineItems(invoice) {
  const items = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  const usable = items.filter(li => li && typeof li.amount_pence === 'number');
  if (usable.length > 0) {
    return usable.map(li => {
      const q = Number(li.quantity);
      const unit = q ? '' : '';
      const desc = li.label
        + (li.quantity && li.unit_label ? ` (${li.quantity} ${li.unit_label})` : '');
      return {
        Description: String(desc).slice(0, 3900),
        Quantity: 1,
        UnitAmount: +(li.amount_pence / 100).toFixed(2),
        AccountCode: SALES_ACCOUNT_CODE,
        TaxType: LINE_TAX_TYPE,
      };
    });
  }
  // Fallback: single net line (amount_pence is already net of funding_deduction).
  const desc = invoice.period_label || `Childcare — invoice ${invoice.invoice_number || invoice.id}`;
  return [{
    Description: String(desc).slice(0, 3900),
    Quantity: 1,
    UnitAmount: +(((invoice.amount_pence || 0)) / 100).toFixed(2),
    AccountCode: SALES_ACCOUNT_CODE,
    TaxType: LINE_TAX_TYPE,
  }];
}

// ── Push ONE invoice ─────────────────────────────────────────────────────────
async function pushInvoiceToXero(db, invoiceId, { force = false } = {}) {
  db = db || getPool();
  try {
    // b226 backfill guard — cutoff + origin exclusion. `force` is the explicit
    // manual override (a manager deliberately pushing one historical invoice);
    // pushUnsyncedInvoices() passes it because its candidate query has already
    // applied exactly the same gates.
    if (!force) {
      const gate = await checkInvoicePushable(db, invoiceId);
      if (!gate.pushable) return { ok: false, blocked: true, invoiceId, error: gate.reason };
    }

    const { rows } = await db.query(`
      SELECT i.*, c.first_name, c.last_name
        FROM invoices i
        LEFT JOIN children c ON c.id = i.child_id
       WHERE i.id = $1`, [invoiceId]);
    const inv = rows[0];
    if (!inv) return { ok: false, error: `Invoice ${invoiceId} not found` };

    const provider = await getActiveProvider(db);
    if (!provider) return { ok: false, error: 'No active Xero connection' };
    if (!provider.tenant_id) {
      return { ok: false, error: 'Xero connection has no tenant/organisation — reconnect Xero' };
    }

    let accessToken;
    try {
      accessToken = await refreshTokenIfNeeded(provider);
    } catch (err) {
      return { ok: false, error: `Xero token refresh failed: ${err.message}` };
    }

    // Graceful pre-flight: bail with a clear message if the token lacks the write scope.
    if (!tokenHasWriteScope(accessToken)) return { ...SCOPE_ERR, invoiceId };

    const tenantId = provider.tenant_id;

    // Contact
    const contactName = (inv.last_name ? `${inv.last_name} family` : null) || inv.bill_payer_email || `Wren invoice ${inv.invoice_number || inv.id}`;
    let contactId;
    try {
      contactId = await findOrCreateContact(accessToken, tenantId, { email: inv.bill_payer_email, name: contactName });
    } catch (err) {
      if (err.statusCode === 401 || err.statusCode === 403) return { ...SCOPE_ERR, invoiceId };
      return { ok: false, error: `Xero contact lookup/create failed: ${xeroErrorDetail(err)}` };
    }
    if (!contactId) return { ok: false, error: 'Could not resolve a Xero contact' };

    // Invoice body
    const element = {
      Type: 'ACCREC',
      Contact: { ContactID: contactId },
      LineItems: buildLineItems(inv),
      Date: toXeroDate(inv.issued_on),
      DueDate: toXeroDate(inv.due_on),
      Reference: inv.invoice_number || `WREN-${inv.id}`,
      Status: 'AUTHORISED',
      LineAmountTypes: 'Exclusive',
    };
    // Idempotent: if already pushed, include InvoiceID so Xero UPDATES rather than
    // creating a duplicate. On first push, set InvoiceNumber for a clean mirror.
    if (inv.xero_invoice_id) {
      element.InvoiceID = inv.xero_invoice_id;
    } else if (inv.invoice_number) {
      element.InvoiceNumber = inv.invoice_number;
    }

    let xeroInvoice;
    try {
      const resp = await xeroApiRequest('POST', accessToken, tenantId, 'Invoices',
        { body: { Invoices: [element] } });
      xeroInvoice = (resp.Invoices || [])[0];
    } catch (err) {
      if (err.statusCode === 401 || err.statusCode === 403) return { ...SCOPE_ERR, invoiceId };
      return { ok: false, error: `Xero invoice push failed: ${xeroErrorDetail(err)}` };
    }
    if (!xeroInvoice || !xeroInvoice.InvoiceID) {
      return { ok: false, error: 'Xero did not return an InvoiceID' };
    }

    const xeroInvoiceId = xeroInvoice.InvoiceID;
    await db.query(
      'UPDATE invoices SET xero_invoice_id=$1, xero_synced_at=now() WHERE id=$2',
      [xeroInvoiceId, inv.id]
    );

    const result = {
      ok: true,
      invoiceId: inv.id,
      invoiceNumber: inv.invoice_number,
      xeroInvoiceId,
      action: inv.xero_invoice_id ? 'updated' : 'created',
      paymentPushed: false,
    };

    // ── Payment push (only when the Wren invoice is PAID) ──────────────────────
    if (inv.status === 'paid') {
      if (!BANK_ACCOUNT_CODE) {
        result.paymentSkipped = 'XERO_BANK_ACCOUNT_CODE not set — invoice pushed, payment not mirrored';
      } else {
        try {
          // Idempotency: skip if the Xero invoice is already (fully) paid.
          const alreadyPaid = Number(xeroInvoice.AmountPaid || 0);
          const total = Number(xeroInvoice.Total || (inv.amount_pence || 0) / 100);
          if (alreadyPaid > 0 && alreadyPaid >= total) {
            result.paymentSkipped = 'Xero invoice already shows a payment';
          } else {
            const payDate = toXeroDate(inv.paid_on) || new Date().toISOString().slice(0, 10);
            const amount = +((inv.amount_pence || 0) / 100).toFixed(2);
            const pResp = await xeroApiRequest('PUT', accessToken, tenantId, 'Payments', {
              body: { Payments: [{
                Invoice: { InvoiceID: xeroInvoiceId },
                // Bank accounts often have no Code in Xero — accept a GUID (AccountID) too.
                Account: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(BANK_ACCOUNT_CODE)
                  ? { AccountID: BANK_ACCOUNT_CODE } : { Code: BANK_ACCOUNT_CODE },
                Date: payDate,
                Amount: amount,
              }] },
            });
            const xeroPayment = (pResp.Payments || [])[0];
            result.paymentPushed = true;
            result.xeroPaymentId = xeroPayment?.PaymentID || null;
            // Stamp the most recent succeeded Wren payment row for this invoice (best-effort).
            if (xeroPayment?.PaymentID) {
              await db.query(`
                UPDATE payments SET xero_payment_id=$1, xero_synced_at=now()
                 WHERE id = (SELECT id FROM payments
                              WHERE invoice_id=$2 AND status='succeeded'
                              ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 1)`,
                [xeroPayment.PaymentID, inv.id]);
            }
          }
        } catch (err) {
          if (err.statusCode === 401 || err.statusCode === 403) {
            result.paymentSkipped = 'Payment needs invoice-write permission (invoice itself pushed OK)';
          } else {
            result.paymentSkipped = `Payment push failed: ${err.message}`;
          }
        }
      }
    }

    return result;
  } catch (err) {
    // Absolute backstop — a push must never throw to the route handler.
    console.error('[xero-push] unexpected error:', err);
    return { ok: false, error: err.message };
  }
}

// ── Push all finalised, not-yet-synced invoices (bounded batch) ──────────────
// b226: every candidate now passes the backfill guard above — a cutoff read
// from settings['xero_push_from'] plus an EyLog/EyMan origin exclusion —
// and the run is bounded by `limit` (default 50, hard ceiling 200).
//
// `dryRun: true` reports exactly what it WOULD push and writes nothing to Xero
// and nothing to the DB. Use it before re-enabling the cron:
//   node -e "require('./src/services/xero-invoice-push')
//     .pushUnsyncedInvoices(null,{dryRun:true}).then(r=>console.log(JSON.stringify(r,null,2)))"
async function pushUnsyncedInvoices(db, { limit = 50, dryRun = false } = {}) {
  db = db || getPool();
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  try {
    // Guard FIRST — a missing cutoff must stop the run even if Xero is healthy.
    const guard = await describePushCandidates(db, { limit: cap });
    if (!guard.ok) {
      console.warn(`[xero-push] BLOCKED — ${guard.error}`);
      return { ...guard, dryRun, pushed: 0, failed: 0, candidates: 0, results: [] };
    }
    // Always log the story: how many were unsynced, how many survived the gates,
    // and what held the rest back.
    console.log(summariseGuard(guard) + (dryRun ? ' DRY-RUN' : ''));

    const provider = await getActiveProvider(db);
    if (!provider && !dryRun) return { ok: false, error: 'No active Xero connection' };

    const guardMeta = {
      cutoff:               guard.cutoff,
      limit:                cap,
      unsyncedTotal:        guard.unsyncedTotal,
      eligible:             guard.eligible,
      excludedTotal:        guard.excludedTotal,
      excludedImported:     guard.excludedImported,
      excludedBeforeCutoff: guard.excludedBeforeCutoff,
      excludedNoIssueDate:  guard.excludedNoIssueDate,
    };

    if (dryRun) {
      return {
        ok: true, dryRun: true, ...guardMeta,
        candidates: guard.candidates.length,
        pushed: 0, failed: 0,
        wouldPush: guard.candidates.map(c => ({
          invoiceId: c.id, invoiceNumber: c.invoice_number,
          issuedOn: toXeroDate(c.issued_on), status: c.status,
          amountPence: c.amount_pence,
          wouldCreatePayment: c.status === 'paid',
        })),
      };
    }

    const results = [];
    let pushed = 0, failed = 0;
    for (const c of guard.candidates) {
      // force:true — describePushCandidates() already applied the identical gates,
      // so re-running them per invoice would only cost a round trip.
      const res = await pushInvoiceToXero(db, c.id, { force: true });
      // Stop the whole batch early if the connection lacks write scope — pointless to continue.
      if (res.needsWriteScope) {
        return { ok: false, ...SCOPE_ERR, ...guardMeta, attempted: results.length, pushed, failed, results };
      }
      results.push({ invoiceId: c.id, ...res });
      if (res.ok) pushed++; else failed++;
    }
    console.log(`[xero-push] pushed=${pushed} failed=${failed} of ${guard.candidates.length} candidate(s)`);
    return { ok: true, dryRun: false, ...guardMeta, candidates: guard.candidates.length, pushed, failed, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  pushInvoiceToXero, pushUnsyncedInvoices, tokenHasWriteScope,
  // b226 backfill guard
  getPushCutoff, describePushCandidates, checkInvoicePushable, summariseGuard,
  PUSH_FROM_SETTING_KEY, IMPORTED_ORIGIN_SQL,
};
