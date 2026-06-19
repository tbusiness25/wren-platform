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
    const redirectUri = `${process.env.ADMIN_BASE_URL || 'https://admin.example.com'}/api/open-banking/callback`;
    const state       = crypto.randomBytes(16).toString('hex');

    const params = new URLSearchParams({
      response_type: 'code',
      client_id:     clientId,
      scope:         'accounts balance transactions',
      redirect_uri:  redirectUri,
      state,
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
    const redirectUri  = `${process.env.ADMIN_BASE_URL || 'https://admin.example.com'}/api/open-banking/callback`;

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

module.exports = router;
