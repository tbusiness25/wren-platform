'use strict';
// Open Banking (TrueLayer) — OAuth connect, token management, transaction sync.
// Mounted at /api/open-banking in admin server.
// TrueLayer docs: https://docs.truelayer.com/

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const crypto       = require('crypto');
const {
  getDecryptedSetting, setEncryptedSetting,
} = require('../lib/payment-settings');
const fs = require('fs');
const { encrypt: xeroEnc, decrypt: xeroDec } = require('../utils/token-encrypt');

// ── POST /api/open-banking/xero/sync-internal ────────────────────────────────
// Header-guarded (no JWT) sync endpoint for the nightly cron (scripts/xero-sync.sh).
// Registered BEFORE the auth/manager guards so the cron can authenticate with the
// shared WREN_INTERNAL_TOKEN. Implementation lives in the XERO BANK FEED section
// at the bottom of this file (runXeroSync — a hoisted function declaration).
router.post('/xero/sync-internal', async (req, res) => {
  const tok = req.headers['x-wren-internal'] || '';
  if (!process.env.WREN_INTERNAL_TOKEN || tok !== process.env.WREN_INTERNAL_TOKEN) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  try {
    const result = await runXeroSync({
      account_id: req.body?.account_id,
      from_date:  req.body?.from_date,
      to_date:    req.body?.to_date,
    });
    res.json(result);
  } catch (e) {
    if (e.code === 'no_xero_tokens') return res.json({ ok: false, skipped: true, reason: e.message });
    console.error('[open-banking/xero] sync-internal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

const ALGO = 'aes-256-gcm';

function _encKey() {
  const secret = process.env.JWT_SECRET;
  return crypto.createHash('sha256').update('ob:' + secret).digest();
}

function encryptToken(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, _encKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc: enc.toString('hex'), iv: iv.toString('hex'), tag: tag.toString('hex') };
}

function decryptToken(enc, iv, tag) {
  const decipher = crypto.createDecipheriv(ALGO, _encKey(), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(enc, 'hex')), decipher.final()]).toString('utf8');
}

async function _tlBase() {
  const env = await getDecryptedSetting('truelayer_env').catch(() => null);
  return env === 'live'
    ? 'https://api.truelayer.com'
    : 'https://api.truelayer-sandbox.com';
}

async function _tlAuthBase() {
  const env = await getDecryptedSetting('truelayer_env').catch(() => null);
  return env === 'live'
    ? 'https://auth.truelayer.com'
    : 'https://auth.truelayer-sandbox.com';
}

async function _tlClientId()     { return getDecryptedSetting('truelayer_client_id').catch(() => null); }
async function _tlClientSecret() { return getDecryptedSetting('truelayer_client_secret').catch(() => null); }

async function _getValidToken(db, connectionId) {
  const { rows: [conn] } = await db.query(
    'SELECT * FROM open_banking_connections WHERE id=$1 AND status=$2', [connectionId, 'active']
  );
  if (!conn) throw new Error('No active Open Banking connection');

  // Check if access token is still valid
  if (conn.token_expires_at && new Date(conn.token_expires_at) > new Date(Date.now() + 60000)) {
    return decryptToken(conn.access_token_enc, conn.access_iv, conn.access_tag);
  }

  // Refresh token
  const clientId     = await _tlClientId();
  const clientSecret = await _tlClientSecret();
  const authBase     = await _tlAuthBase();
  const refreshToken = decryptToken(conn.refresh_token_enc, conn.refresh_iv, conn.refresh_tag);

  const resp = await fetch(`${authBase}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`TrueLayer token refresh failed: ${txt}`);
  }

  const data = await resp.json();
  const at = encryptToken(data.access_token);
  const rt = data.refresh_token ? encryptToken(data.refresh_token) : null;

  await db.query(`
    UPDATE open_banking_connections
    SET access_token_enc=$1, access_iv=$2, access_tag=$3,
        ${rt ? 'refresh_token_enc=$4, refresh_iv=$5, refresh_tag=$6,' : ''}
        token_expires_at=$${rt ? 7 : 4}, updated_at=NOW()
    WHERE id=$${rt ? 8 : 5}
  `, rt
    ? [at.enc, at.iv, at.tag, rt.enc, rt.iv, rt.tag,
        new Date(Date.now() + data.expires_in * 1000).toISOString(), connectionId]
    : [at.enc, at.iv, at.tag,
        new Date(Date.now() + data.expires_in * 1000).toISOString(), connectionId]
  );

  return data.access_token;
}

// ── GET /api/open-banking/status ─────────────────────────────────────────────
router.get('/status', async (req, res) => {
  const db = getPool();
  try {
    const [clientId, env, connRow] = await Promise.all([
      getDecryptedSetting('truelayer_client_id').catch(() => null),
      getDecryptedSetting('truelayer_env').catch(() => 'sandbox'),
      db.query('SELECT id, account_name, institution_name, last_synced_at, status, token_expires_at FROM open_banking_connections WHERE status=$1 ORDER BY id DESC LIMIT 1', ['active']),
    ]);

    res.json({
      configured:     !!clientId,
      test_mode:      env !== 'live',
      env:            env || 'sandbox',
      connection:     connRow.rows[0] || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/open-banking/connect ────────────────────────────────────────────
// Initiates OAuth flow — returns the TrueLayer authorization URL.
router.get('/connect', async (req, res) => {
  try {
    const clientId = await _tlClientId();
    if (!clientId) return res.status(503).json({ error: 'TrueLayer client_id not configured' });

    const authBase    = await _tlAuthBase();
    const redirectUri = `${process.env.ADMIN_BASE_URL || 'https://admin.example-nursery.co.uk'}/api/open-banking/callback`;
    const state       = crypto.randomBytes(16).toString('hex');
    const nonce       = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     clientId,
      scope:         'accounts balance transactions offline_access',
      redirect_uri:  redirectUri,
      state,
      nonce,
      providers:     'uk-ob-all uk-oauth-all',
    });

    // Store state temporarily in DB
    await getPool().query(`
      INSERT INTO open_banking_connections (provider, status, access_token_enc, access_iv, access_tag)
      VALUES ('truelayer', 'pending', $1, '', '')
    `, [state]);

    res.json({ auth_url: `${authBase}/?${params}`, state });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/open-banking/callback ───────────────────────────────────────────
// OAuth callback from TrueLayer. Usually admin navigates here directly from browser.
router.get('/callback', async (req, res) => {
  const db = getPool();
  const { code, state, error: tlError } = req.query;

  if (tlError) {
    return res.redirect(`/admin/system/integrations?ob_error=${encodeURIComponent(tlError)}`);
  }

  try {
    const clientId     = await _tlClientId();
    const clientSecret = await _tlClientSecret();
    const authBase     = await _tlAuthBase();
    const apiBase      = await _tlBase();
    const redirectUri  = `${process.env.ADMIN_BASE_URL || 'https://admin.example-nursery.co.uk'}/api/open-banking/callback`;

    const tokenResp = await fetch(`${authBase}/connect/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type:    'authorization_code',
        client_id:     clientId,
        client_secret: clientSecret,
        code,
        redirect_uri:  redirectUri,
      }),
    });

    if (!tokenResp.ok) {
      const txt = await tokenResp.text();
      throw new Error(`TrueLayer token exchange failed: ${txt}`);
    }

    const tokenData = await tokenResp.json();
    const at = encryptToken(tokenData.access_token);
    const rt = tokenData.refresh_token ? encryptToken(tokenData.refresh_token) : { enc: '', iv: '', tag: '' };
    const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000);

    // Fetch accounts
    const acctResp = await fetch(`${apiBase}/data/v1/accounts`, {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const acctData = acctResp.ok ? await acctResp.json() : { results: [] };
    const account  = acctData.results?.[0];

    await db.query(`
      UPDATE open_banking_connections
      SET status='active', account_id=$1, account_name=$2, institution_name=$3,
          access_token_enc=$4, access_iv=$5, access_tag=$6,
          refresh_token_enc=$7, refresh_iv=$8, refresh_tag=$9,
          token_expires_at=$10, updated_at=NOW()
      WHERE access_token_enc=$11
    `, [
      account?.account_id || 'unknown',
      account?.display_name || 'Bank Account',
      account?.provider?.display_name || 'Unknown',
      at.enc, at.iv, at.tag,
      rt.enc, rt.iv, rt.tag,
      expiresAt.toISOString(),
      state, // using stored state as temp key
    ]);

    recordAudit({ req, action: 'connect', entity_type: 'open_banking', actor_type: 'user' });
    res.redirect('/admin/system/integrations?ob_connected=1');
  } catch (e) {
    console.error('[open-banking] callback error:', e.message);
    res.redirect(`/admin/system/integrations?ob_error=${encodeURIComponent(e.message)}`);
  }
});

// ── POST /api/open-banking/sync ──────────────────────────────────────────────
// Pull transactions from TrueLayer and store as bank statement lines.
router.post('/sync', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [conn] } = await db.query(
      'SELECT * FROM open_banking_connections WHERE status=$1 ORDER BY id DESC LIMIT 1', ['active']
    );
    if (!conn) return res.status(503).json({ error: 'No active Open Banking connection. Connect first.' });

    const token   = await _getValidToken(db, conn.id);
    const apiBase = await _tlBase();

    const from = req.body.from || new Date(Date.now() - 90 * 86400000).toISOString().split('T')[0];
    const to   = req.body.to   || new Date().toISOString().split('T')[0];

    const txResp = await fetch(
      `${apiBase}/data/v1/accounts/${conn.account_id}/transactions?from=${from}&to=${to}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!txResp.ok) {
      const txt = await txResp.text();
      throw new Error(`TrueLayer transactions failed: ${txt}`);
    }

    const txData = await txResp.json();
    const transactions = txData.results || [];

    // Create or update bank statement for this sync range
    const { rows: [stmt] } = await db.query(`
      INSERT INTO bank_statements (source, account_name, period_from, period_to, truelayer_account_id, uploaded_by)
      VALUES ('truelayer', $1, $2, $3, $4, $5)
      RETURNING id
    `, [conn.account_name || 'Open Banking', from, to, conn.account_id, req.user.id]);

    let inserted = 0, credits = 0, debits = 0;

    for (const tx of transactions) {
      const amountPence = Math.round((tx.amount || 0) * 100);
      if (amountPence > 0) credits += amountPence;
      else debits += Math.abs(amountPence);

      try {
        await db.query(`
          INSERT INTO bank_statement_lines
            (statement_id, transaction_date, description, amount_pence, balance_pence, provider_id, reference, category)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (statement_id, provider_id) DO NOTHING
        `, [
          stmt.id,
          tx.timestamp?.split('T')[0] || tx.settled_at?.split('T')[0] || from,
          tx.description || tx.transaction_information,
          amountPence,
          tx.running_balance ? Math.round(tx.running_balance.amount * 100) : null,
          tx.transaction_id,
          tx.merchant_name || null,
          tx.transaction_category || null,
        ]);
        inserted++;
      } catch { /* duplicate */ }
    }

    await db.query(`
      UPDATE bank_statements SET total_credits_pence=$1, total_debits_pence=$2, line_count=$3 WHERE id=$4
    `, [credits, debits, inserted, stmt.id]);

    await db.query(
      'UPDATE open_banking_connections SET last_synced_at=NOW() WHERE id=$1', [conn.id]
    );

    // Kick off reconciliation
    const { runReconciliation } = (() => {
      try { return require('./finance-reconcile'); } catch { return {}; }
    })();
    setImmediate(() => {
      const { getPool: gp } = require('../db/pool');
      const dbInner = gp();
      // Run inline reconciliation
      dbInner.query(`
        SELECT l.id, l.amount_pence, l.description, l.reference, l.transaction_date
        FROM bank_statement_lines l WHERE l.statement_id = $1 AND l.reconciled = false AND l.amount_pence > 0
      `, [stmt.id]).then(({ rows: lines }) => {
        // Simple: mark as needing reconciliation — full engine runs on /reconcile/run
      }).catch(() => {});
    });

    recordAudit({ req, action: 'sync', entity_type: 'open_banking',
      meta: { statement_id: stmt.id, transactions: inserted } });

    res.json({ ok: true, statement_id: stmt.id, transactions_synced: inserted, from, to });
  } catch (e) {
    console.error('[open-banking] sync error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/open-banking/connection ──────────────────────────────────────
router.delete('/connection', async (req, res) => {
  const db = getPool();
  try {
    await db.query(
      `UPDATE open_banking_connections SET status='revoked', updated_at=NOW() WHERE status='active'`
    );
    recordAudit({ req, action: 'disconnect', entity_type: 'open_banking' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  XERO BANK FEED  (added 2026-07-02, PROMPT 64)
//  Xero is the new default bank-feed provider, replacing TrueLayer. The TrueLayer
//  routes above are left intact as dead code (Toby will remove them later).
//
//  Token resolution order:
//    1. finance_providers WHERE provider='xero' AND is_active  — the canonical
//       Xero token store already used by src/routes/finance-xero.js (P&L sync).
//       We reuse it so a single Xero OAuth connection powers both P&L and the
//       bank feed, and so refreshed tokens survive container restarts in the DB
//       (superior to sed-ing a baked-image .env).
//    2. env XERO_ACCESS_TOKEN + XERO_REFRESH_TOKEN + XERO_TENANT_ID — bootstrap
//       path: seeded into finance_providers on first use.
//  Refresh: direct POST to https://identity.xero.com/connect/token (Basic auth),
//  persisted to finance_providers AND best-effort to editions/ladn/.env.
// ═══════════════════════════════════════════════════════════════════════════

const XERO_ENV_FILE = process.env.XERO_ENV_FILE || '/app/editions/ladn/.env';

class XeroNotConfigured extends Error {
  constructor(msg) { super(msg || 'Xero not configured'); this.code = 'no_xero_tokens'; }
}

// Seed finance_providers from env tokens (idempotent). Returns the row or null.
async function _seedXeroProviderFromEnv(db) {
  const at = process.env.XERO_ACCESS_TOKEN;
  const rt = process.env.XERO_REFRESH_TOKEN;
  const tenant = process.env.XERO_TENANT_ID;
  if (!at || !rt || !tenant) return null;
  // Assume the env access token is near-expiry so the first sync forces a refresh.
  const expiresAt = new Date(Date.now() + 60 * 1000).toISOString();
  const { rows } = await db.query(`
    INSERT INTO finance_providers
      (provider, oauth_access_token, oauth_refresh_token, oauth_expires_at, tenant_id, display_name, connected_at, is_active)
    VALUES ('xero', $1, $2, $3, $4, 'Xero (env bootstrap)', now(), true)
    ON CONFLICT (provider, tenant_id) DO UPDATE SET
      oauth_access_token  = EXCLUDED.oauth_access_token,
      oauth_refresh_token = EXCLUDED.oauth_refresh_token,
      oauth_expires_at    = EXCLUDED.oauth_expires_at,
      is_active           = true
    RETURNING *
  `, [xeroEnc(at), xeroEnc(rt), expiresAt, tenant]);
  return rows[0] || null;
}

// Resolve a valid Xero access token + tenant. Throws XeroNotConfigured if absent.
async function _xeroAuth(db) {
  let { rows } = await db.query(
    "SELECT * FROM finance_providers WHERE provider='xero' AND is_active=true ORDER BY id LIMIT 1"
  );
  if (!rows[0]) {
    const seeded = await _seedXeroProviderFromEnv(db);
    if (seeded) rows = [seeded];
  }
  if (!rows[0]) {
    throw new XeroNotConfigured(
      'No active Xero connection. Connect via Finance → Integrations, or set XERO_ACCESS_TOKEN / XERO_REFRESH_TOKEN / XERO_TENANT_ID in editions/ladn/.env.'
    );
  }
  const provider = rows[0];
  const accessToken = await _xeroRefresh(db, provider);
  return { accessToken, tenantId: provider.tenant_id, providerId: provider.id };
}

// Refresh the access token if it is expiring; persist to DB + best-effort .env.
async function _xeroRefresh(db, provider) {
  const expiresAt = provider.oauth_expires_at ? new Date(provider.oauth_expires_at) : null;
  if (expiresAt && (expiresAt.getTime() - Date.now() > 5 * 60 * 1000)) {
    return xeroDec(provider.oauth_access_token);
  }
  if (!process.env.XERO_CLIENT_ID || !process.env.XERO_CLIENT_SECRET) {
    throw new XeroNotConfigured('XERO_CLIENT_ID / XERO_CLIENT_SECRET not configured.');
  }
  const basic = Buffer.from(`${process.env.XERO_CLIENT_ID}:${process.env.XERO_CLIENT_SECRET}`).toString('base64');

  // Custom Connection (2026-07-04): no refresh token stored → the app is a Xero
  // "Custom Connection" (client_credentials; scopes pre-authorised in the Xero
  // portal). Re-grant instead of refreshing — grants have no refresh_token.
  const refreshToken = xeroDec(provider.oauth_refresh_token);
  const body = refreshToken
    ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken })
    : new URLSearchParams({ grant_type: 'client_credentials' });

  const resp = await fetch('https://identity.xero.com/connect/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
    body,
  });
  if (!resp.ok) {
    // Never log the response body — it can echo token material.
    throw new Error(`Xero token ${refreshToken ? 'refresh' : 'grant'} failed (HTTP ${resp.status})`);
  }
  const data = await resp.json();
  const newRefresh = data.refresh_token || refreshToken || null;
  const newExpiry  = new Date(Date.now() + (data.expires_in || 1800) * 1000).toISOString();

  await db.query(`
    UPDATE finance_providers
    SET oauth_access_token=$1, oauth_refresh_token=$2, oauth_expires_at=$3
    WHERE id=$4
  `, [xeroEnc(data.access_token), newRefresh ? xeroEnc(newRefresh) : null, newExpiry, provider.id]);

  if (newRefresh) _persistEnvTokens(data.access_token, newRefresh, provider.tenant_id);
  return data.access_token;
}

// Best-effort in-place update of the .env so env-bootstrapped tokens survive a
// dev restart. On prod (baked image) this is a harmless no-op — the DB is the
// source of truth. Never throws.
function _persistEnvTokens(accessToken, refreshToken, tenantId) {
  try {
    if (!fs.existsSync(XERO_ENV_FILE)) return;
    let txt = fs.readFileSync(XERO_ENV_FILE, 'utf8');
    const upsert = (t, key, val) => {
      if (!val) return t;
      const re = new RegExp(`^${key}=.*$`, 'm');
      const line = `${key}=${val}`;
      return re.test(t) ? t.replace(re, line) : `${t.replace(/\s*$/, '')}\n${line}\n`;
    };
    txt = upsert(txt, 'XERO_ACCESS_TOKEN', accessToken);
    txt = upsert(txt, 'XERO_REFRESH_TOKEN', refreshToken);
    txt = upsert(txt, 'XERO_TENANT_ID', tenantId);
    fs.writeFileSync(XERO_ENV_FILE, txt);
  } catch (e) {
    console.warn('[open-banking/xero] could not persist tokens to .env (non-fatal):', e.message);
  }
}

// Low-level Xero API GET (api.xro/2.0).
async function _xeroApiGet(accessToken, tenantId, pathAndQuery) {
  const resp = await fetch(`https://api.xero.com/api.xro/2.0/${pathAndQuery}`, {
    headers: {
      'Authorization':  `Bearer ${accessToken}`,
      'Xero-Tenant-Id': tenantId,
      'Accept':         'application/json',
    },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    const err = new Error(`Xero API HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    err.statusCode = resp.status;
    throw err;
  }
  return resp.json();
}

// Xero date "/Date(ms+0000)/" or ISO → "YYYY-MM-DD".
function _parseXeroDate(v) {
  if (!v) return null;
  const m = String(v).match(/\/Date\((\d+)/);
  if (m) return new Date(parseInt(m[1], 10)).toISOString().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/.test(String(v))) return String(v).slice(0, 10);
  return null;
}

// List Xero bank accounts (Type=BANK).
async function _xeroBankAccounts(accessToken, tenantId) {
  const data = await _xeroApiGet(accessToken, tenantId, `Accounts?where=${encodeURIComponent('Type=="BANK"')}`);
  return (data.Accounts || []).map(a => ({
    account_id:          a.AccountID,
    name:                a.Name,
    code:                a.Code || null,
    bank_account_number: a.BankAccountNumber || null,
    currency:            a.CurrencyCode || null,
    status:              a.Status,
  }));
}

// Sync one bank account's transactions into a persistent bank_statements row.
// One statement per (source='xero', account) — re-syncs upsert lines so daily
// overlapping windows stay idempotent (deviation from the prompt's "one per run",
// forced by the real unique key (statement_id, provider_id) — see decision log).
async function _syncXeroAccount(db, accessToken, tenantId, account, fromDate, toDate, actorId) {
  let { rows: [stmt] } = await db.query(
    "SELECT id FROM bank_statements WHERE source='xero' AND truelayer_account_id=$1 ORDER BY id LIMIT 1",
    [account.account_id]
  );
  if (!stmt) {
    ({ rows: [stmt] } = await db.query(`
      INSERT INTO bank_statements (source, account_name, account_number, period_from, period_to, truelayer_account_id, uploaded_by)
      VALUES ('xero', $1, $2, $3, $4, $5, $6)
      RETURNING id
    `, [account.name || 'Xero bank account', account.bank_account_number || null,
        fromDate, toDate, account.account_id, actorId || 1]));
  }
  const statementId = stmt.id;

  const [fy, fm, fd] = fromDate.split('-').map(n => parseInt(n, 10));
  const where = `Status=="AUTHORISED" AND BankAccount.AccountID==Guid("${account.account_id}") AND Date>=DateTime(${fy},${fm},${fd})`;

  let page = 1;
  const txns = [];
  while (page <= 50) { // safety cap: 5000 transactions
    const data = await _xeroApiGet(accessToken, tenantId,
      `BankTransactions?where=${encodeURIComponent(where)}&page=${page}`);
    const batch = data.BankTransactions || [];
    txns.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  let inserted = 0, updated = 0;
  for (const tx of txns) {
    const txDate = _parseXeroDate(tx.Date);
    if (!txDate) continue;
    if (toDate && txDate > toDate) continue; // Xero where has only a lower bound
    const isSpend    = /^SPEND/i.test(tx.Type || '');   // SPEND = money out (debit)
    const absPence   = Math.round((Number(tx.Total) || 0) * 100);
    const amountPence = isSpend ? -absPence : absPence; // credit +, debit -

    const contact  = tx.Contact?.Name || '';
    const lineDesc = (Array.isArray(tx.LineItems) && tx.LineItems[0]?.Description) || '';
    const description = ([contact, tx.Reference, lineDesc].filter(Boolean).join(' — ') || 'Xero transaction').slice(0, 500);

    const r = await db.query(`
      INSERT INTO bank_statement_lines
        (statement_id, transaction_date, description, amount_pence, reference, category, provider_id, reconciled)
      VALUES ($1,$2,$3,$4,$5,$6,$7,false)
      ON CONFLICT (statement_id, provider_id) DO UPDATE SET
        transaction_date = EXCLUDED.transaction_date,
        description      = EXCLUDED.description,
        amount_pence     = EXCLUDED.amount_pence,
        reference        = EXCLUDED.reference,
        category         = EXCLUDED.category
      RETURNING (xmax = 0) AS is_insert
    `, [statementId, txDate, description, amountPence, tx.Reference || null, tx.Type || null, tx.BankTransactionID]);
    if (r.rows[0]?.is_insert) inserted++; else updated++;
  }

  // Recompute statement totals + widen period from the full line set.
  const { rows: [agg] } = await db.query(`
    SELECT MIN(transaction_date) AS pmin, MAX(transaction_date) AS pmax,
           COUNT(*) AS n,
           COALESCE(SUM(amount_pence) FILTER (WHERE amount_pence > 0), 0)  AS cr,
           COALESCE(SUM(-amount_pence) FILTER (WHERE amount_pence < 0), 0) AS dr,
           COUNT(*) FILTER (WHERE reconciled) AS rec
    FROM bank_statement_lines WHERE statement_id=$1
  `, [statementId]);
  await db.query(`
    UPDATE bank_statements
    SET period_from = LEAST(period_from, $2::date),
        period_to   = GREATEST(period_to, $3::date),
        line_count  = $4, total_credits_pence = $5, total_debits_pence = $6, reconciled_count = $7
    WHERE id=$1
  `, [statementId, agg.pmin || fromDate, agg.pmax || toDate,
      parseInt(agg.n, 10), Number(agg.cr) || 0, Number(agg.dr) || 0, parseInt(agg.rec, 10)]);

  return {
    account_id: account.account_id, account_name: account.name,
    statement_id: statementId, fetched: txns.length, inserted, updated,
  };
}

// Orchestrate a sync across one or all Xero bank accounts.
async function runXeroSync(opts = {}) {
  const db = getPool();
  const { accessToken, tenantId } = await _xeroAuth(db);

  const toDate   = opts.to_date   || new Date().toISOString().slice(0, 10);
  const fromDate = opts.from_date || new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  let accounts = await _xeroBankAccounts(accessToken, tenantId);
  if (opts.account_id) accounts = accounts.filter(a => a.account_id === opts.account_id);

  const results = [];
  for (const acct of accounts) {
    results.push(await _syncXeroAccount(db, accessToken, tenantId, acct, fromDate, toDate, opts.actorId));
  }
  return {
    ok: true, from: fromDate, to: toDate,
    accounts: accounts.length,
    inserted: results.reduce((s, r) => s + r.inserted, 0),
    updated:  results.reduce((s, r) => s + r.updated, 0),
    results,
  };
}

// ── GET /api/open-banking/xero/status ────────────────────────────────────────
router.get('/xero/status', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      "SELECT id, display_name, tenant_id, last_sync_at, last_sync_status FROM finance_providers WHERE provider='xero' AND is_active=true ORDER BY id LIMIT 1"
    );
    const envReady = !!(process.env.XERO_ACCESS_TOKEN && process.env.XERO_REFRESH_TOKEN && process.env.XERO_TENANT_ID);
    const { rows: st } = await db.query(
      "SELECT MAX(created_at) AS last_synced, COUNT(*)::int AS statements FROM bank_statements WHERE source='xero'"
    );
    res.json({
      connected:    !!rows[0] || envReady,
      source:       rows[0] ? 'oauth' : (envReady ? 'env' : null),
      displayName:  rows[0]?.display_name || (envReady ? 'Xero (env)' : null),
      lastSyncedAt: st[0]?.last_synced || null,
      statements:   st[0]?.statements || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/open-banking/xero/accounts ──────────────────────────────────────
router.get('/xero/accounts', async (req, res) => {
  const db = getPool();
  try {
    const { accessToken, tenantId } = await _xeroAuth(db);
    const accounts = await _xeroBankAccounts(accessToken, tenantId);
    console.log(`[open-banking/xero] ${accounts.length} bank account(s) found: ` +
      accounts.map(a => `${a.name} [${a.account_id}]`).join(', '));
    res.json({ accounts });
  } catch (e) {
    if (e.code === 'no_xero_tokens') return res.status(503).json({ error: e.message, code: 'no_xero_tokens' });
    console.error('[open-banking/xero] accounts error:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// ── POST /api/open-banking/xero/sync ─────────────────────────────────────────
router.post('/xero/sync', async (req, res) => {
  try {
    const { account_id, from_date, to_date } = req.body || {};
    const result = await runXeroSync({ account_id, from_date, to_date, actorId: req.user?.id });
    recordAudit({ req, action: 'xero_sync', entity_type: 'open_banking',
      meta: { accounts: result.accounts, inserted: result.inserted, updated: result.updated, from: result.from, to: result.to } });
    res.json(result);
  } catch (e) {
    if (e.code === 'no_xero_tokens') return res.status(503).json({ error: e.message, code: 'no_xero_tokens' });
    console.error('[open-banking/xero] sync error:', e.message);
    // 403 from a client_credentials (custom connection) token = the app has not
    // been AUTHORISED to the Your Nursery organisation yet. Verified 2026-07-06:
    // the token issues fine (full scope list) but carries no tenant binding.
    if (e.statusCode === 403) {
      return res.status(502).json({
        error: 'Xero app is not yet authorised to the Your Nursery organisation. '
          + 'Toby: developer.xero.com → My Apps → the Wren custom connection → Authorise → choose Your Nursery → then retry sync.',
        code: 'xero_not_authorised',
      });
    }
    res.status(502).json({ error: e.message });
  }
});

module.exports = router;
