'use strict';
// Xero data sync service.
// Called by: POST /api/finance/xero/sync (manual), POST /api/finance/xero/sync-internal (cron).
//
// Sync order:
//   1. Refresh OAuth token if expiring
//   2. Accounts (chart of accounts, ~50 rows)
//   3. P&L monthly balances (Jan 2023 → now)
//   4. Invoices (rolling 7-day overlap from last sync)
//   5. Payments (rolling 7-day overlap from last sync)
//   6. LA funding heuristic on new invoices
//   7. Write sync log

const https  = require('https');
const { getPool } = require('../db/pool');
const { encrypt, decrypt } = require('../utils/token-encrypt');
const { XeroClient } = require('xero-node');
const fs     = require('fs');
const path   = require('path');

// ── Rate limiter: ≤50 calls/min ───────────────────────────────────────────────
const _rl = { count: 0, resetAt: 0 };
async function rateLimit() {
  const now = Date.now();
  if (now > _rl.resetAt) { _rl.count = 0; _rl.resetAt = now + 60_000; }
  if (_rl.count >= 50) {
    const wait = _rl.resetAt - now + 100;
    await new Promise(r => setTimeout(r, wait));
    _rl.count = 0;
    _rl.resetAt = Date.now() + 60_000;
  }
  _rl.count++;
}

// ── Low-level Xero GET ────────────────────────────────────────────────────────
function xeroGet(accessToken, tenantId, path_, params = {}, retried = false) {
  return new Promise(async (resolve, reject) => {
    await rateLimit();
    const url = new URL(`https://api.xero.com/api.xro/2.0/${path_}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

    const options = {
      hostname: 'api.xero.com',
      path:     url.pathname + url.search,
      method:   'GET',
      headers: {
        'Authorization':   `Bearer ${accessToken}`,
        'Xero-Tenant-Id':  tenantId,
        'Accept':          'application/json',
      },
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 429 && !retried) {
          console.warn('[xero-sync] 429 rate-limited, waiting 60s');
          setTimeout(() => {
            xeroGet(accessToken, tenantId, path_, params, true).then(resolve).catch(reject);
          }, 61_000);
          return;
        }
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error(`JSON parse error: ${data.slice(0, 200)}`)); }
        } else {
          const err = new Error(`Xero HTTP ${res.statusCode}: ${data.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(new Error('Xero request timeout')); });
    req.end();
  });
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function refreshTokenIfNeeded(provider) {
  const db = getPool();
  const expiresAt = provider.oauth_expires_at ? new Date(provider.oauth_expires_at) : null;
  const needsRefresh = !expiresAt || expiresAt - Date.now() < 5 * 60 * 1000; // refresh if <5min remaining

  if (!needsRefresh) {
    return decrypt(provider.oauth_access_token);
  }

  // Custom Connection (2026-07-04): rows with no refresh token belong to a Xero
  // "Custom Connection" app (client_credentials, pre-authorised scopes) — re-grant
  // rather than refresh. Standard auth-code rows keep the refresh flow.
  const refreshToken = provider.oauth_refresh_token ? decrypt(provider.oauth_refresh_token) : null;
  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64');
  const body = refreshToken
    ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
    : new URLSearchParams({ grant_type: 'client_credentials' });

  console.log(`[xero-sync] ${refreshToken ? 'refreshing OAuth token' : 'client_credentials re-grant (custom connection)'}`);
  const resp = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}` },
    body,
  });
  if (!resp.ok) throw new Error(`Xero token ${refreshToken ? 'refresh' : 'grant'} failed (HTTP ${resp.status})`);
  const tokenSet = await resp.json();

  const newExpiresAt = new Date(Date.now() + (tokenSet.expires_in || 1800) * 1000).toISOString();
  const newRefresh = tokenSet.refresh_token || refreshToken || null;

  await db.query(`
    UPDATE finance_providers
    SET oauth_access_token=$1, oauth_refresh_token=$2, oauth_expires_at=$3
    WHERE id=$4
  `, [encrypt(tokenSet.access_token), newRefresh ? encrypt(newRefresh) : null, newExpiresAt, provider.id]);

  return tokenSet.access_token;
}

// ── Sync accounts ────────────────────────────────────────────────────────────
async function syncAccounts(db, providerId, accessToken, tenantId) {
  const data = await xeroGet(accessToken, tenantId, 'Accounts');
  const accounts = data.Accounts || [];
  let count = 0;

  for (const acct of accounts) {
    await db.query(`
      INSERT INTO finance_accounts (provider_id, external_id, code, name, type, class, is_active)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (provider_id, external_id) DO UPDATE SET
        code=$3, name=$4, type=$5, class=$6, is_active=$7
    `, [
      providerId,
      acct.AccountID,
      acct.Code || null,
      acct.Name,
      acct.Type,
      acct.Class,
      acct.Status === 'ACTIVE',
    ]);
    count++;
  }
  return count;
}

// ── Sync monthly P&L balances ────────────────────────────────────────────────
async function syncMonthlyBalances(db, providerId, accessToken, tenantId) {
  // Build month list: Jan 2023 → current month
  const startYear = 2023, startMonth = 1;
  const now = new Date();
  const endYear = now.getFullYear();
  const endMonth = now.getMonth() + 1;

  // Fetch account_id map (external_id → id)
  const { rows: acctRows } = await db.query(
    'SELECT id, external_id FROM finance_accounts WHERE provider_id=$1', [providerId]
  );
  const acctMap = {};
  for (const r of acctRows) acctMap[r.external_id] = r.id;

  let count = 0;

  // Process in 3-month chunks to stay under rate limits
  for (let y = startYear, m = startMonth; y < endYear || (y === endYear && m <= endMonth); ) {
    // Request single month P&L
    const fromDate = `${y}-${String(m).padStart(2,'0')}-01`;
    const lastDay  = new Date(y, m, 0).getDate();
    const toDate   = `${y}-${String(m).padStart(2,'0')}-${lastDay}`;

    let reportData;
    try {
      reportData = await xeroGet(accessToken, tenantId, 'Reports/ProfitAndLoss', {
        fromDate,
        toDate,
        standardLayout: true,
        paymentsOnly:   false, // accrual basis
      });
    } catch (err) {
      console.warn(`[xero-sync] P&L fetch failed for ${fromDate}: ${err.message}`);
      // Advance month and continue
      m++; if (m > 12) { m = 1; y++; }
      continue;
    }

    const report = (reportData.Reports || [])[0];
    if (report) {
      // Parse flat row structure: each Row in the report sections
      const parsed = parsePLReport(report);
      for (const { accountName, amount } of parsed) {
        // Match account by name (P&L report uses names not IDs)
        const { rows: matchRows } = await db.query(
          'SELECT id FROM finance_accounts WHERE provider_id=$1 AND name ILIKE $2 LIMIT 1',
          [providerId, accountName]
        );
        if (!matchRows[0]) continue;
        await db.query(`
          INSERT INTO finance_monthly_balances (provider_id, account_id, year, month, amount, updated_at)
          VALUES ($1,$2,$3,$4,$5,now())
          ON CONFLICT (account_id, year, month) DO UPDATE SET amount=$5, updated_at=now()
        `, [providerId, matchRows[0].id, y, m, amount]);
        count++;
      }
    }

    m++; if (m > 12) { m = 1; y++; }
  }
  return count;
}

function parsePLReport(report) {
  const results = [];
  for (const section of (report.Rows || [])) {
    if (!section.Rows) continue;
    for (const row of section.Rows) {
      if (row.RowType !== 'Row' || !row.Cells) continue;
      const cells = row.Cells;
      if (cells.length < 2) continue;
      const accountName = (cells[0].Value || '').trim();
      if (!accountName) continue;
      // Single-month report: cells[1] is the value
      const raw = (cells[1].Value || '').replace(/,/g, '');
      const amount = parseFloat(raw) || 0;
      if (amount !== 0) results.push({ accountName, amount });
    }
  }
  return results;
}

// ── Sync invoices ────────────────────────────────────────────────────────────
async function syncInvoices(db, providerId, accessToken, tenantId, since) {
  const sinceDate = since
    ? new Date(since - 7 * 86400000).toISOString().slice(0, 10)
    : '2023-01-01';

  const data = await xeroGet(accessToken, tenantId, 'Invoices', {
    Statuses: 'AUTHORISED,PAID',
    DateFrom: sinceDate,
    includeArchived: false,
    page: 1,
  });

  const invoices = data.Invoices || [];
  let count = 0;

  for (const inv of invoices) {
    const { flag, confidence } = detectLaFunding(inv);
    await db.query(`
      INSERT INTO finance_invoices
        (provider_id, external_id, invoice_number, contact_name, invoice_date, due_date,
         amount_due, amount_paid, total, status, reference, is_la_funding, la_funding_confidence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT (provider_id, external_id) DO UPDATE SET
        invoice_number=$3, contact_name=$4, invoice_date=$5, due_date=$6,
        amount_due=$7, amount_paid=$8, total=$9, status=$10, reference=$11,
        is_la_funding=CASE WHEN finance_invoices.la_funding_confidence='high' THEN finance_invoices.is_la_funding ELSE $12 END,
        la_funding_confidence=COALESCE(finance_invoices.la_funding_confidence, $13)
    `, [
      providerId, inv.InvoiceID, inv.InvoiceNumber,
      inv.Contact?.Name,
      inv.Date    ? parseXeroDate(inv.Date)    : null,
      inv.DueDate ? parseXeroDate(inv.DueDate) : null,
      inv.AmountDue, inv.AmountPaid, inv.Total,
      inv.Status, inv.Reference || null,
      flag, confidence,
    ]);
    count++;

    // Log uncertain low-confidence flags
    if (confidence === 'low') {
      logUncertain(inv);
    }
  }
  return count;
}

// ── Sync payments ────────────────────────────────────────────────────────────
async function syncPayments(db, providerId, accessToken, tenantId, since) {
  const sinceDate = since
    ? new Date(since - 7 * 86400000).toISOString().slice(0, 10)
    : '2023-01-01';

  const data = await xeroGet(accessToken, tenantId, 'Payments', {
    Statuses: 'AUTHORISED',
    where: `Date >= DateTime(${sinceDate.replace(/-/g,',')})`,
  });

  const payments = data.Payments || [];
  let count = 0;

  for (const pmt of payments) {
    // Resolve linked invoice
    const invoiceExtId = pmt.Invoice?.InvoiceID;
    let invoiceId = null;
    if (invoiceExtId) {
      const { rows } = await db.query(
        'SELECT id FROM finance_invoices WHERE provider_id=$1 AND external_id=$2 LIMIT 1',
        [providerId, invoiceExtId]
      );
      invoiceId = rows[0]?.id || null;
    }

    await db.query(`
      INSERT INTO finance_payments
        (provider_id, external_id, payment_date, amount, invoice_id, reference)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (provider_id, external_id) DO UPDATE SET
        payment_date=$3, amount=$4, invoice_id=$5, reference=$6
    `, [
      providerId, pmt.PaymentID,
      pmt.Date ? parseXeroDate(pmt.Date) : null,
      pmt.Amount, invoiceId, pmt.Reference || null,
    ]);
    count++;
  }
  return count;
}

// ── Xero date format → ISO ────────────────────────────────────────────────────
function parseXeroDate(xeroDate) {
  // Xero returns "/Date(1617235200000+0000)/"
  const m = String(xeroDate).match(/\/Date\((\d+)/);
  if (m) return new Date(parseInt(m[1])).toISOString().slice(0, 10);
  // Or ISO string directly
  if (/^\d{4}-\d{2}-\d{2}/.test(xeroDate)) return xeroDate.slice(0, 10);
  return null;
}

// ── LA funding heuristic ──────────────────────────────────────────────────────
function detectLaFunding(invoice) {
  const contact = (invoice.Contact?.Name || '').toLowerCase();
  const ref     = (invoice.Reference   || '').toLowerCase();

  // High confidence: contact name matches LA
  if (/ealing council|lbe|local authority|london borough|ealing borough/i.test(contact)) {
    return { flag: true, confidence: 'high' };
  }

  // Medium confidence: reference matches funding keywords
  if (/funded hours|feee|30 hour|15 hour|free entitle|early education/i.test(ref) ||
      /funded hours|feee|30 hour|15 hour|free entitle|early education/i.test(contact)) {
    return { flag: true, confidence: 'medium' };
  }

  // Low confidence: amount pattern (multiple of common hourly rates × typical hours)
  const amt = parseFloat(invoice.Total) || 0;
  const commonRates = [5.48, 5.59, 5.65, 6.00, 6.10]; // common LA hourly rates
  const isPatternMatch = commonRates.some(rate => {
    const hours = amt / rate;
    return hours > 0 && Math.abs(hours - Math.round(hours)) < 0.01 && hours % 15 === 0;
  });
  if (isPatternMatch) return { flag: false, confidence: 'low' };

  return { flag: false, confidence: null };
}

function logUncertain(invoice) {
  try {
    const logDir = path.join('/app/logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, 'funding-heuristic-uncertain.log');
    const entry = `${new Date().toISOString()} | InvoiceID=${invoice.InvoiceID} | Contact=${invoice.Contact?.Name} | Ref=${invoice.Reference} | Amount=${invoice.Total}\n`;
    fs.appendFileSync(logFile, entry);
  } catch (_) { /* non-fatal */ }
}

// ── Main sync function ────────────────────────────────────────────────────────
async function syncXero(providerId, triggeredBy = 'manual') {
  const db = getPool();
  const logRow = await db.query(`
    INSERT INTO finance_sync_log (provider_id, started_at, status, triggered_by)
    VALUES ($1, now(), 'running', $2) RETURNING id
  `, [providerId, triggeredBy]);
  const logId = logRow.rows[0].id;

  let totalRows = 0;

  try {
    // Load provider
    const { rows } = await db.query(
      'SELECT * FROM finance_providers WHERE id=$1', [providerId]
    );
    if (!rows[0]) throw new Error(`Provider ${providerId} not found`);
    const provider = rows[0];

    // Refresh token if needed
    const accessToken = await refreshTokenIfNeeded(provider);

    const since = provider.last_sync_at ? new Date(provider.last_sync_at) : null;

    // 1. Accounts
    const accountCount = await syncAccounts(db, providerId, accessToken, provider.tenant_id);
    totalRows += accountCount;
    console.log(`[xero-sync] accounts synced: ${accountCount}`);

    // 2. Monthly P&L balances
    const balanceCount = await syncMonthlyBalances(db, providerId, accessToken, provider.tenant_id);
    totalRows += balanceCount;
    console.log(`[xero-sync] monthly balances synced: ${balanceCount}`);

    // 3. Invoices
    const invoiceCount = await syncInvoices(db, providerId, accessToken, provider.tenant_id, since);
    totalRows += invoiceCount;
    console.log(`[xero-sync] invoices synced: ${invoiceCount}`);

    // 4. Payments
    const paymentCount = await syncPayments(db, providerId, accessToken, provider.tenant_id, since);
    totalRows += paymentCount;
    console.log(`[xero-sync] payments synced: ${paymentCount}`);

    // Update provider last_sync
    await db.query(`
      UPDATE finance_providers
      SET last_sync_at=now(), last_sync_status='success', last_sync_error=NULL
      WHERE id=$1
    `, [providerId]);

    // Update sync log
    await db.query(`
      UPDATE finance_sync_log
      SET ended_at=now(), status='success', rows_synced=$1
      WHERE id=$2
    `, [totalRows, logId]);

    return { rowsSynced: totalRows, accountCount, balanceCount, invoiceCount, paymentCount };

  } catch (err) {
    console.error('[xero-sync] sync failed:', err);

    await db.query(`
      UPDATE finance_providers SET last_sync_status='failed', last_sync_error=$1 WHERE id=$2
    `, [err.message, providerId]);

    await db.query(`
      UPDATE finance_sync_log SET ended_at=now(), status='failed', error_message=$1 WHERE id=$2
    `, [err.message, logId]);

    // Telegram alert on failure
    sendTelegramAlert(`⚠️ Xero sync failed (providerId=${providerId})\n${err.message}`);

    throw err;
  }
}

function sendTelegramAlert(message) {
  try {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId   = process.env.TELEGRAM_CHAT_ID || '7565744160';
    if (!botToken) return;
    const body = JSON.stringify({ chat_id: chatId, text: message });
    const req = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${botToken}/sendMessage`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, () => {});
    req.on('error', () => {});
    req.end(body);
  } catch (_) { /* non-fatal */ }
}

module.exports = { syncXero };
