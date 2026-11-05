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
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

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
      // b204: the same nightly run also pulls the accounting reports. Both knobs
      // are optional — omitted, the reports sync picks its own window (13 months
      // on a first run, the current + previous month thereafter).
      report_months: req.body?.report_months,
      skip_reports:  req.body?.skip_reports === true,
    });
    res.json(result);
  } catch (e) {
    if (e.code === 'no_xero_tokens') return res.json({ ok: false, skipped: true, reason: e.message });
    console.error('[open-banking/xero] sync-internal error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// The bank redirects back here without a Wren token — see obCallback: the one-time state is the guard.
router.get('/callback', (req, res) => obCallback(req, res));

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
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
async function obCallback(req, res) {
  const db = getPool();
  const { code, state, error: tlError } = req.query;
  if (tlError) return obResult(res, false, String(tlError));
  // The bank's redirect back is a plain browser visit with no Wren token, so this route sits
  // outside the staff guard. What protects it is the one-time `state`: it must match a pending
  // connection a manager started (GET /connect, behind the guard) in the last 30 minutes.
  if (!code || !/^[a-f0-9]{32}$/.test(String(state || ''))) return obResult(res, false, 'missing or malformed state');
  const { rows: [pend] } = await db.query(
    `SELECT id FROM open_banking_connections
      WHERE status = 'pending' AND access_token_enc = $1 AND created_at > NOW() - INTERVAL '30 minutes'`, [state]);
  if (!pend) return obResult(res, false, 'this link has expired or was already used — start again from Roost');

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
    // A business login can list several accounts; the fees land in the current account, so
    // prefer a TRANSACTION (current) account over savings, and log which was chosen.
    const accts = acctData.results || [];
    const account = accts.find(a => /TRANSACTION/.test(String(a.account_type || '').toUpperCase())) || accts[0];
    console.log(`[open-banking] connected: ${accts.length} account(s) listed; chose type=${account?.account_type || '?'}`);

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
    obResult(res, true, `${account?.provider?.display_name || 'Your bank'} — ${account?.display_name || 'account'}`);
  } catch (e) {
    console.error('[open-banking] callback error:', e.message);
    obResult(res, false, 'the bank connection could not be completed');
  }
}
function obResult(res, ok, detail) {
  const esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  res.status(ok ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bank connection</title><body style="font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:48px auto;padding:0 16px;color:#222">
<h1 style="font-size:1.3rem">${ok ? 'Bank connected' : 'Bank not connected'}</h1><p>${esc(detail)}</p>
<p>${ok ? 'Wren will now read this account&#39;s transactions to match payments. Nothing can be paid from it.' : 'Nothing was changed.'}</p>
<p><a href="/">Back to Roost</a></p></body>`);
}

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

    // 2026-10-06 — never before the cutover: EyLog holds every payment to 25 Sep, so a line
    // from before 26 Sep is a payment already recorded. A manual sync with no 'from' used to
    // reach back 90 days and dropped 261 such lines into the reconcile queue.
    const FLOOR = (process.env.OPEN_BANKING_FLOOR || '2026-09-26').slice(0, 10);
    let from = req.body.from || new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    if (from < FLOOR) from = FLOOR;
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
        // Each sync makes a new statement, and the window overlaps the last one — skip a
        // transaction any earlier TrueLayer sync already stored, or it would be matched twice.
        if (tx.transaction_id) {
          const { rows: seen } = await db.query(
            `SELECT 1 FROM bank_statement_lines l JOIN bank_statements s ON s.id = l.statement_id
              WHERE s.source = 'truelayer' AND l.provider_id = $1 LIMIT 1`, [tx.transaction_id]);
          if (seen.length) continue;
        }
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

    // Nothing new since the last sync: drop the empty statement this call just created.
    if (inserted === 0) {
      await db.query(`DELETE FROM bank_statements WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM bank_statement_lines WHERE statement_id = $1)`, [stmt.id]);
      await db.query('UPDATE open_banking_connections SET last_synced_at=NOW() WHERE id=$1', [conn.id]);
      return res.json({ ok: true, statement_id: null, transactions_synced: 0, from, to });
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

    // b171 (2026-07-28): Xero's Contact name + line-item description were being
    // folded into the single `description` string above and lost as separate
    // fields — the reconcile UI had no payer name / particulars to show, only
    // the flattened blob. Capture them additively so the UI can surface real
    // fields instead of parsing description text.
    const payeeName       = contact || null;
    const payeeContactId  = tx.Contact?.ContactID || null;
    const lineItemDesc    = lineDesc || null;
    const xeroUrl         = tx.Url || null;
    const xeroIsReconciled = typeof tx.IsReconciled === 'boolean' ? tx.IsReconciled : null;

    const r = await db.query(`
      INSERT INTO bank_statement_lines
        (statement_id, transaction_date, description, amount_pence, reference, category, provider_id, reconciled,
         payee_name, payee_contact_id, line_item_desc, xero_url, xero_is_reconciled, excluded_reason)
      -- 2026-10-05: Barclays open banking (TrueLayer) is the bank feed from 26 Sep. A Xero
      -- line is a COPY of a Barclays line, so a new one is set aside as it lands — it
      -- used to drop into the reconcile queue beside its twin and could be confirmed twice.
      VALUES ($1,$2,$3,$4,$5,$6,$7,false,$8,$9,$10,$11,$12,
              'Xero copy of a Barclays line: open banking is the source from 26 Sep')
      ON CONFLICT (statement_id, provider_id) DO UPDATE SET
        transaction_date   = EXCLUDED.transaction_date,
        description        = EXCLUDED.description,
        amount_pence       = EXCLUDED.amount_pence,
        reference          = EXCLUDED.reference,
        category           = EXCLUDED.category,
        payee_name         = EXCLUDED.payee_name,
        payee_contact_id   = EXCLUDED.payee_contact_id,
        line_item_desc     = EXCLUDED.line_item_desc,
        xero_url           = EXCLUDED.xero_url,
        xero_is_reconciled = EXCLUDED.xero_is_reconciled,
        -- b524 (2026-10-21): this branch never set excluded_reason, so a Xero
        -- line that landed BEFORE the 2026-10-05 fix above stayed live forever
        -- however often it re-synced — and that is one of the two ways Toby's
        -- duplicate Ealing receipt survived. COALESCE, not assignment: a reason
        -- somebody has already recorded (a refund, "not a fee payment") is a
        -- decision and is never overwritten.
        excluded_reason    = COALESCE(bank_statement_lines.excluded_reason, EXCLUDED.excluded_reason)
      RETURNING (xmax = 0) AS is_insert
    `, [statementId, txDate, description, amountPence, tx.Reference || null, tx.Type || null, tx.BankTransactionID,
        payeeName, payeeContactId, lineItemDesc, xeroUrl, xeroIsReconciled]);
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
        line_count  = $4, total_credits_pence = $5, total_debits_pence = $6, reconciled_count = $7,
        last_synced_at = NOW()
    WHERE id=$1
  `, [statementId, agg.pmin || fromDate, agg.pmax || toDate,
      parseInt(agg.n, 10), Number(agg.cr) || 0, Number(agg.dr) || 0, parseInt(agg.rec, 10)]);

  // b524 — the recurrence guard, keyed on the DATA (date + amount) rather than on
  // which provider wrote the line. The same Barclays account is fed by TrueLayer
  // AND by this Xero sync, and the unique index (statement_id, provider_id)
  // cannot see across statements, so nothing in the schema could notice the twin.
  // Scoped to THIS SYNC'S window: `since: fromDate` means the only lines it can
  // ever set aside are ones inside the range this call just fetched. The
  // historical cleanup is a dry-run report Toby approves, not this.
  let twins = null;
  try {
    twins = await require('../lib/bank-duplicates')
      .markTwins(db, { since: fromDate, exclude: true });
  } catch (e) {
    // A sync that worked must not fail because the guard could not run (the
    // b524 tables may not be on this database yet).
    twins = { error: e.message };
  }

  return {
    account_id: account.account_id, account_name: account.name,
    statement_id: statementId, fetched: txns.length, inserted, updated,
    duplicate_guard: twins,
  };
}

// Orchestrate a sync across one or all Xero bank accounts.
async function runXeroSync(opts = {}) {
  const XI = require('../lib/xero-inbound');
  if (XI.xeroInboundOff()) {
    return { ok: true, skipped: true, reason: XI.OFF_REASON, accounts: 0, inserted: 0, updated: 0, results: [],
             from: opts.from_date || null, to: opts.to_date || null };
  }
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

  // b204 (2026-08-19): the same run now also pulls the ACCOUNTING REPORTS —
  // P&L, Balance Sheet and aged debtors/creditors — into finance_pnl_periods /
  // finance_pnl_lines / finance_aged. Deliberately folded into this job rather
  // than given its own cron: one Xero connection, one nightly window, one place
  // to look when it breaks. Non-fatal — a reports failure must never lose the
  // bank feed that already succeeded above.
  let reports = null;
  if (!opts.skip_reports) {
    try {
      reports = await require('../lib/xero-reports').syncXeroReports({
        months: opts.report_months,
        triggered_by: opts.actorId ? String(opts.actorId) : 'cron',
      });
    } catch (e) {
      console.error('[open-banking/xero] reports sync failed (bank feed unaffected):', e.message);
      reports = { ok: false, error: e.message };
    }
  }

  return {
    ok: true, from: fromDate, to: toDate,
    accounts: accounts.length,
    inserted: results.reduce((s, r) => s + r.inserted, 0),
    updated:  results.reduce((s, r) => s + r.updated, 0),
    results,
    reports,
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
    // b170 (2026-07-28): statements are persistent per-account rows that get
    // UPSERTED nightly — created_at never moves, so it showed "Last synced:
    // 9 Jul" forever. last_synced_at is bumped by every sync run instead.
    const { rows: st } = await db.query(
      "SELECT MAX(COALESCE(last_synced_at, created_at)) AS last_synced, COUNT(*)::int AS statements FROM bank_statements WHERE source='xero'"
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

// b204 (2026-08-19): expose the Xero auth/API primitives so src/lib/xero-reports.js
// can reuse the SAME token store and refresh path (one Xero connection powers the
// bank feed AND the accounting reports). Same idiom as require('./brain')._qdrantSearch.
// These are server-side only — no token ever reaches a browser through them.
router._xeroAuth = _xeroAuth;
router._xeroApiGet = _xeroApiGet;
router._parseXeroDate = _parseXeroDate;
router.XeroNotConfigured = XeroNotConfigured;

module.exports = router;
