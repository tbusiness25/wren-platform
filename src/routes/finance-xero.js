'use strict';
// Xero OAuth + connection management.
// Mounted at /api/finance/xero (and /api/finance/status) in server-unified.js.
// Manager-role only — all routes require authentication + manager role.

const express    = require('express');
const router     = express.Router();
const { XeroClient } = require('xero-node');
const { getPool }    = require('../db/pool');
const authenticate   = require('../middleware/auth');
const { encrypt, decrypt } = require('../utils/token-encrypt');
const { syncXero }   = require('../services/finance-xero-sync');

// ── Internal sync trigger (from n8n cron) — no JWT needed ────────────────────
// Requires X-Wren-Internal header matching env WREN_INTERNAL_TOKEN
router.post('/xero/sync-internal', async (req, res) => {
  const tok = req.headers['x-wren-internal'] || '';
  if (!process.env.WREN_INTERNAL_TOKEN || tok !== process.env.WREN_INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      "SELECT id FROM finance_providers WHERE provider='xero' AND is_active=true ORDER BY id LIMIT 1"
    );
    if (!rows[0]) return res.json({ ok: true, skipped: true, reason: 'No active Xero provider' });
    const result = await syncXero(rows[0].id, 'cron');
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[finance-xero] sync-internal error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Browser-facing OAuth routes — BEFORE the JWT guard ───────────────────────
// Both are plain browser navigations (no Authorization header possible):
// /xero/connect is gated by a JWT passed as ?t= from the Integrations UI;
// /xero/callback is Xero's redirect (protected by CF Access on the admin
// domain + the code exchange needing our client secret server-side).
router.get('/xero/connect', async (req, res) => {
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(String(req.query.t || ''), process.env.JWT_SECRET);
    // 2026-07-08: deputy_manager REMOVED — finances are manager/owner only (Toby, Clare).
    if (!['manager', 'admin'].includes(decoded.role)) throw new Error('role');
  } catch {
    return res.status(401).send('<h2>Not authorised</h2><p>Open this from System → Integrations while logged in as a manager.</p>');
  }
  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    return res.status(503).send('<h2>Xero credentials not configured</h2><p>See wren-docs/integrations/xero-setup.md</p>');
  }
  try {
    // 2026-07-04: LADN's Xero app is a "Custom Connection" (client_credentials,
    // scopes pre-authorised in the Xero portal). Those apps REJECT the auth-code
    // consent flow with invalid_scope — so try client_credentials FIRST and only
    // fall back to browser consent for standard web apps.
    const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64');
    const ccResp = await fetch('https://identity.xero.com/connect/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basic}` },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
    });
    if (ccResp.ok) {
      const tok = await ccResp.json();
      // Probe the Organisation endpoint: custom-connection tokens only gain API
      // access once an org admin has AUTHORISED the app to an organisation in
      // the Xero portal. 403 here = that step hasn't been done yet.
      let orgOk = false, tenantName = 'Xero (custom connection)';
      try {
        const oResp = await fetch('https://api.xero.com/api.xro/2.0/Organisation', {
          headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
        if (oResp.ok) {
          orgOk = true;
          const org = await oResp.json();
          tenantName = org?.Organisations?.[0]?.Name || tenantName;
        }
      } catch (_) { /* treated as not-yet-authorised below */ }

      // 2026-07-09: only persist a custom-connection row when the org probe
      // SUCCEEDS. Writing an "awaiting org authorisation" NULL-tenant row for
      // what is actually a standard web app meant every sync/status query
      // (ORDER BY id LIMIT 1) picked the junk row over the real auth-code
      // connection and 403'd.
      if (orgOk) {
        const db = getPool();
        const expiresAt = new Date(Date.now() + (tok.expires_in || 1800) * 1000).toISOString();
        // NULL tenant_id never matches ON CONFLICT (NULLs are distinct) — update the
        // existing custom-connection row in place, insert only when none exists.
        const { rowCount } = await db.query(`
          UPDATE finance_providers
          SET oauth_access_token=$1, oauth_refresh_token=NULL, oauth_expires_at=$2,
              display_name=$3, connected_at=now(), is_active=true
          WHERE provider='xero' AND tenant_id IS NULL
        `, [encrypt(tok.access_token), expiresAt, tenantName]);
        if (!rowCount) {
          await db.query(`
            INSERT INTO finance_providers
              (provider, oauth_access_token, oauth_refresh_token, oauth_expires_at, tenant_id, display_name, connected_at, is_active)
            VALUES ('xero', $1, NULL, $2, NULL, $3, now(), true)
          `, [encrypt(tok.access_token), expiresAt, tenantName]);
        }
        return res.send('<h2>✅ Xero connected</h2><p>Organisation: ' + tenantName +
          ' (custom connection — tokens auto-renew, no consent screen).</p>' +
          '<p><a href="/app.html#system/integrations">Back to Integrations</a> · <a href="/launch-prep.html">Launch Prep</a></p>');
      }
      // 2026-07-06: token issued but no org access → this is a STANDARD web app
      // (the dev portal shows Redirect URIs + "0 of 5 connections", and there is no
      // portal "authorise" step for this app type). The correct authorisation is the
      // browser consent screen — fall through to it instead of dead-ending.
      const xeroCc = await getXeroClient();
      const consentUrlCc = await xeroCc.buildConsentUrl();
      return res.redirect(consentUrlCc);
    }

    // Standard web app → browser consent flow
    const xero = await getXeroClient();
    const consentUrl = await xero.buildConsentUrl();
    res.redirect(consentUrl);
  } catch (err) {
    console.error('[finance-xero] connect error:', err);
    res.status(500).send(`<h2>Xero connect failed</h2><p>${err.message}</p>`);
  }
});

router.get('/xero/callback', async (req, res) => {
  try {
    const xero = await getXeroClient();
    const fullUrl = `${process.env.XERO_REDIRECT_URI || 'https://admin.littleangelsealing.co.uk/api/finance/xero/callback'}?${new URLSearchParams(req.query)}`;
    const tokenSet = await xero.apiCallback(fullUrl);

    xero.setTokenSet(tokenSet);
    const tenants = await xero.updateTenants();
    if (!tenants || tenants.length === 0) {
      return res.status(400).send('<h2>No Xero organisations found. Ensure you selected an organisation during login.</h2>');
    }
    const tenant = tenants[0];

    const db = getPool();
    const encAccess  = encrypt(tokenSet.access_token);
    const encRefresh = encrypt(tokenSet.refresh_token);
    const expiresAt  = tokenSet.expires_at
      ? new Date(tokenSet.expires_at * 1000).toISOString()
      : new Date(Date.now() + (tokenSet.expires_in || 1800) * 1000).toISOString();

    await db.query(`
      INSERT INTO finance_providers
        (provider, oauth_access_token, oauth_refresh_token, oauth_expires_at, tenant_id, display_name, connected_at, is_active)
      VALUES ('xero', $1, $2, $3, $4, $5, now(), true)
      ON CONFLICT (provider, tenant_id) DO UPDATE SET
        oauth_access_token  = EXCLUDED.oauth_access_token,
        oauth_refresh_token = EXCLUDED.oauth_refresh_token,
        oauth_expires_at    = EXCLUDED.oauth_expires_at,
        display_name        = EXCLUDED.display_name,
        connected_at        = now(),
        is_active           = true
    `, [encAccess, encRefresh, expiresAt, tenant.tenantId, tenant.tenantName]);

    res.send('<h2>✅ Xero connected</h2><p>Organisation: ' + tenant.tenantName +
      '</p><p><a href="/app.html#system/integrations">Back to Integrations</a> · <a href="/launch-prep.html">Launch Prep</a></p>');
  } catch (err) {
    console.error('[finance-xero] callback error:', err);
    res.status(500).send(`<h2>Xero connection failed</h2><p>${err.message}</p><a href="/app.html#system/integrations">Back to Integrations</a>`);
  }
});

// ── Auth guard for remaining routes ──────────────────────────────────────────
router.use(authenticate);

const managerOnly = (req, res, next) => {
  // 2026-07-08: deputy_manager REMOVED — finances are manager/owner only.
  if (!['manager', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerOnly);

// ── Lazy XeroClient factory ───────────────────────────────────────────────────
let _xeroClient = null;
let _initialized = false;

async function getXeroClient() {
  if (!_xeroClient) {
    _xeroClient = new XeroClient({
      clientId:     process.env.XERO_CLIENT_ID,
      clientSecret: process.env.XERO_CLIENT_SECRET,
      redirectUris: [process.env.XERO_REDIRECT_URI || 'https://admin.littleangelsealing.co.uk/api/finance/xero/callback'],
      // 2026-07-06: the Wren app was created after Xero's 2 March 2026 cutover, so it
      // only has the NEW GRANULAR scopes — the old broad scopes
      // (accounting.transactions.read / accounting.reports.read) do not exist for it
      // and were the real cause of invalid_scope on the consent flow. This list must
      // stay a subset of the app's Configuration → Scopes in developer.xero.com.
      scopes: ['openid', 'profile', 'email', 'offline_access',
        'accounting.settings.read', 'accounting.contacts.read',
        'accounting.invoices.read', 'accounting.payments.read',
        'accounting.banktransactions.read',
        'accounting.reports.profitandloss.read', 'accounting.reports.balancesheet.read',
        'accounting.reports.aged.read'],
      httpTimeout: 10000,
    });
  }
  if (!_initialized) {
    await _xeroClient.initialize();
    _initialized = true;
  }
  return _xeroClient;
}

// ── GET /api/finance/status ───────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      "SELECT id, provider, display_name, connected_at, last_sync_at, last_sync_status, last_sync_error, is_active FROM finance_providers WHERE provider='xero' AND is_active=true ORDER BY id LIMIT 1"
    );
    if (!rows[0]) return res.json({ provider: null, connected: false });
    const p = rows[0];
    res.json({
      connected:       true,
      provider:        p.provider,
      displayName:     p.display_name,
      connectedAt:     p.connected_at,
      lastSyncAt:      p.last_sync_at,
      lastSyncStatus:  p.last_sync_status,
      lastSyncError:   p.last_sync_error,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// (xero/connect + xero/callback moved ABOVE the auth guard 2026-07-04 — they are
// browser navigations that can't carry a Bearer header; the old definitions here
// were unreachable behind authenticate and the callback 401'd, so tokens never stored.)

// ── POST /api/finance/xero/disconnect ────────────────────────────────────────
router.post('/xero/disconnect', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      "SELECT id, oauth_access_token FROM finance_providers WHERE provider='xero' AND is_active=true LIMIT 1"
    );
    if (!rows[0]) return res.json({ ok: true, skipped: true });

    // Attempt token revocation (non-fatal if it fails)
    try {
      const xero = await getXeroClient();
      const accessToken = decrypt(rows[0].oauth_access_token);
      if (accessToken) await xero.revokeToken(accessToken);
    } catch (_) { /* revocation is best-effort */ }

    await db.query("UPDATE finance_providers SET is_active=false WHERE id=$1", [rows[0].id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── POST /api/finance/xero/sync ──────────────────────────────────────────────
router.post('/xero/sync', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      "SELECT id FROM finance_providers WHERE provider='xero' AND is_active=true ORDER BY id LIMIT 1"
    );
    if (!rows[0]) return res.status(404).json({ error: 'No active Xero connection' });
    const result = await syncXero(rows[0].id, 'manual');
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[finance-xero] manual sync error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/finance/xero/accounts ───────────────────────────────────────────
router.get('/xero/accounts', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      "SELECT fa.*, fp.display_name as provider_name FROM finance_accounts fa JOIN finance_providers fp ON fp.id=fa.provider_id WHERE fp.provider='xero' AND fp.is_active=true ORDER BY fa.code, fa.name"
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/finance/xero/monthly-pl?year=2026 ───────────────────────────────
router.get('/xero/monthly-pl', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const db = getPool();
    const { rows } = await db.query(`
      SELECT fa.code, fa.name, fa.type, fa.class,
             mb.year, mb.month, mb.amount
      FROM finance_monthly_balances mb
      JOIN finance_accounts fa ON fa.id = mb.account_id
      JOIN finance_providers fp ON fp.id = mb.provider_id
      WHERE fp.provider='xero' AND fp.is_active=true AND mb.year=$1
      ORDER BY fa.class, fa.code, mb.month
    `, [year]);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/finance/salary-per-room?year=2026 ───────────────────────────────
router.get('/salary-per-room', async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const db = getPool();

    // Salary accounts: type='EXPENSE' and name or code pattern matching wages/salary
    const { rows: salaryRows } = await db.query(`
      SELECT mb.month, SUM(mb.amount) as total_salary
      FROM finance_monthly_balances mb
      JOIN finance_accounts fa ON fa.id = mb.account_id
      JOIN finance_providers fp ON fp.id = mb.provider_id
      WHERE fp.is_active=true AND mb.year=$1
        AND (fa.type='EXPENSE' OR fa.class='EXPENSE')
        AND (
          fa.name ILIKE '%wage%' OR fa.name ILIKE '%salary%' OR fa.name ILIKE '%salari%'
          OR fa.name ILIKE '%staff cost%' OR fa.name ILIKE '%payroll%'
          OR fa.code LIKE '477%' OR fa.code LIKE '200%' OR fa.code LIKE '201%'
        )
      GROUP BY mb.month ORDER BY mb.month
    `, [year]);

    const salaryByMonth = {};
    for (const r of salaryRows) salaryByMonth[r.month] = parseFloat(r.total_salary) || 0;

    // Room FTE hours per month: use staff.contracted_hours × room allocation percentage
    const { rows: rteRows } = await db.query(`
      SELECT r.id as room_id, r.display_name as room_name,
             COALESCE(SUM(s.contracted_hours * sra.percentage / 100.0), 0) as fte_hours_week
      FROM rooms r
      LEFT JOIN staff_room_allocations sra ON sra.room_id = r.id
        AND (sra.effective_to IS NULL OR sra.effective_to >= CURRENT_DATE)
        AND sra.effective_from <= CURRENT_DATE
      LEFT JOIN staff s ON s.id = sra.staff_id AND s.is_active = true
      GROUP BY r.id, r.display_name
      ORDER BY r.id
    `);

    const totalFte = rteRows.reduce((s, r) => s + parseFloat(r.fte_hours_week), 0);

    // Build result: for each month, for each room, compute estimated salary
    const months = [1,2,3,4,5,6,7,8,9,10,11,12];
    const result = rteRows.map(room => {
      const share = totalFte > 0 ? parseFloat(room.fte_hours_week) / totalFte : 0;
      return {
        room_id:   room.room_id,
        room_name: room.room_name,
        fte_hours_week: parseFloat(room.fte_hours_week),
        monthly:   months.map(m => ({
          month:  m,
          salary: Math.round((salaryByMonth[m] || 0) * share * 100) / 100,
        })),
      };
    });

    res.json({
      year,
      total_fte_hours_week: totalFte,
      note: 'Estimated — modelled from staff contracted hours and room allocations. Not directly from Xero.',
      rooms: result,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/finance/funded-hours-recon ──────────────────────────────────────
router.get('/funded-hours-recon', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const db = getPool();

    // Invoiced per month (LA funding invoices)
    const { rows: invoicedRows } = await db.query(`
      SELECT EXTRACT(YEAR FROM invoice_date)::int  as year,
             EXTRACT(MONTH FROM invoice_date)::int as month,
             COUNT(*)                              as invoice_count,
             SUM(total)                            as invoiced
      FROM finance_invoices
      WHERE is_la_funding = true
        AND invoice_date >= (CURRENT_DATE - ($1 || ' months')::interval)::date
      GROUP BY 1,2 ORDER BY 1,2
    `, [months]);

    // Received per month (payments on LA invoices)
    const { rows: receivedRows } = await db.query(`
      SELECT EXTRACT(YEAR FROM fp.payment_date)::int  as year,
             EXTRACT(MONTH FROM fp.payment_date)::int as month,
             SUM(fp.amount)                           as received
      FROM finance_payments fp
      JOIN finance_invoices fi ON fi.id = fp.invoice_id
      WHERE fi.is_la_funding = true
        AND fp.payment_date >= (CURRENT_DATE - ($1 || ' months')::interval)::date
      GROUP BY 1,2 ORDER BY 1,2
    `, [months]);

    // Outstanding by age bucket (unpaid LA invoices)
    const { rows: ageRows } = await db.query(`
      SELECT
        SUM(CASE WHEN age <= 30  THEN amount_due ELSE 0 END) as bucket_0_30,
        SUM(CASE WHEN age BETWEEN 31 AND 60 THEN amount_due ELSE 0 END) as bucket_31_60,
        SUM(CASE WHEN age BETWEEN 61 AND 90 THEN amount_due ELSE 0 END) as bucket_61_90,
        SUM(CASE WHEN age > 90  THEN amount_due ELSE 0 END) as bucket_90plus,
        SUM(amount_due)            as total_outstanding,
        AVG(age)                   as avg_age_days
      FROM (
        SELECT amount_due, (CURRENT_DATE - invoice_date) as age
        FROM finance_invoices
        WHERE is_la_funding=true AND amount_due > 0 AND status NOT IN ('PAID','VOIDED','DELETED')
      ) sub
    `);

    // Funding submissions from Wren (if available)
    const { rows: submRows } = await db.query(`
      SELECT
        EXTRACT(YEAR  FROM ft.start_date)::int  as year,
        EXTRACT(MONTH FROM ft.start_date)::int  as month,
        ft.name                                 as term_name,
        COUNT(cf.id)                            as children_count,
        SUM(cf.total_hours_term *
          CASE cf.funding_type
            WHEN 'universal'          THEN ft.rate_3yr_universal
            WHEN 'extended'           THEN ft.rate_3yr_extended
            WHEN '2yr_disadvantaged'  THEN ft.rate_2yr_disadvantaged
            WHEN '2yr_working'        THEN ft.rate_2yr_working_parents
            ELSE 0 END
        )                                       as submitted_value
      FROM funding_terms ft
      JOIN child_funding cf ON cf.term_id = ft.id
      WHERE ft.start_date >= (CURRENT_DATE - ($1 || ' months')::interval)::date
      GROUP BY 1,2,3 ORDER BY 1,2
    `, [months]);

    res.json({
      months,
      invoiced:     invoicedRows,
      received:     receivedRows,
      outstanding:  ageRows[0] || {},
      wren_submissions: submRows,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /api/finance/dashboard-summary ───────────────────────────────────────
router.get('/dashboard-summary', async (req, res) => {
  try {
    const db = getPool();
    const year = new Date().getFullYear();

    // YTD revenue and expenses from monthly balances
    const { rows: plRows } = await db.query(`
      SELECT fa.type, fa.class, SUM(mb.amount) as total
      FROM finance_monthly_balances mb
      JOIN finance_accounts fa ON fa.id = mb.account_id
      JOIN finance_providers fp ON fp.id = mb.provider_id
      WHERE fp.is_active=true AND mb.year=$1 AND mb.month <= EXTRACT(MONTH FROM CURRENT_DATE)
      GROUP BY fa.type, fa.class
    `, [year]);

    let ytdRevenue = 0, ytdExpenses = 0;
    for (const r of plRows) {
      const amt = parseFloat(r.total) || 0;
      if (r.class === 'REVENUE' || r.type === 'REVENUE') ytdRevenue += amt;
      if (r.class === 'EXPENSE' || r.type === 'EXPENSE') ytdExpenses += amt;
    }

    // Outstanding LA funding
    const { rows: laRows } = await db.query(`
      SELECT COALESCE(SUM(amount_due),0) as outstanding
      FROM finance_invoices
      WHERE is_la_funding=true AND amount_due > 0 AND status NOT IN ('PAID','VOIDED','DELETED')
    `);

    // Connection status
    const { rows: connRows } = await db.query(
      "SELECT display_name, last_sync_at, last_sync_status FROM finance_providers WHERE provider='xero' AND is_active=true LIMIT 1"
    );

    res.json({
      year,
      connected:           !!connRows[0],
      providerName:        connRows[0]?.display_name,
      lastSyncAt:          connRows[0]?.last_sync_at,
      lastSyncStatus:      connRows[0]?.last_sync_status,
      ytdRevenue,
      ytdExpenses,
      ytdProfit:           ytdRevenue - ytdExpenses,
      salaryCostRatio:     ytdRevenue > 0 ? Math.round((ytdExpenses / ytdRevenue) * 100) : null,
      outstandingLaFunding: parseFloat(laRows[0]?.outstanding) || 0,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET/POST /api/finance/preferences ────────────────────────────────────────
router.get('/preferences', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT preference_key, preference_value FROM user_preferences WHERE staff_id=$1',
      [req.user.id]
    );
    const prefs = {};
    for (const r of rows) prefs[r.preference_key] = r.preference_value;
    res.json(prefs);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/preferences', async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    const db = getPool();
    await db.query(`
      INSERT INTO user_preferences (staff_id, preference_key, preference_value, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (staff_id, preference_key) DO UPDATE SET preference_value=$3, updated_at=now()
    `, [req.user.id, key, String(value)]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
