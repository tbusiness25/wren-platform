'use strict';
/**
 * opayo-pi.js — Opayo (Elavon) Pi API client.
 * 2026-09-28.
 *
 * Replaces the Form integration EyLog used. Pi is Elavon's current API; Form is legacy and
 * being retired, which is reason enough not to build on it now.
 *
 * WHERE THE CARD GOES — and why this stays PCI SAQ A:
 *   1. Server asks Opayo for a MERCHANT SESSION KEY (Basic auth, integration key + password).
 *      Short-lived, ~20 minutes, single merchant, safe to hand to the browser.
 *   2. Browser loads Opayo's own sagepay.js, which takes the card details and exchanges them
 *      with Opayo directly for a CARD IDENTIFIER. The card number never reaches Wren, is never
 *      in our logs, and is never in our database.
 *   3. Server creates the TRANSACTION with the session key + card identifier + amount.
 *   4. If 3-D Secure is required — and for a UK consumer card it essentially always is — Opayo
 *      replies `3DAuth`, the browser completes the challenge with the issuer, and the server
 *      submits the result back to finish the transaction.
 *
 * That third step is why this is not a one-call integration. Anyone who tells you card
 * payments are a single API call has not done 3DS2.
 *
 * 2026-10-01: exercised against the Opayo SANDBOX (frictionless + challenge) before going live.
 * (was: ⚠️ NOT YET EXERCISED against Opayo.) Shapes follow the Pi spec; nothing here has spoken to a
 * live or sandbox account. Test with a SANDBOX key pair and Opayo's test cards first.
 */
const BASES = {
  live:    'https://live.opayo.eu.elavon.com/api/v1',
  sandbox: 'https://sandbox.opayo.eu.elavon.com/api/v1',
};

function baseFor(env) { return BASES[env === 'live' ? 'live' : 'sandbox']; }

function authHeader({ integrationKey, integrationPassword }) {
  if (!integrationKey || !integrationPassword) {
    throw new Error('Opayo is not configured — set the integration key and password in '
                  + 'Roost → Payments → Settings.');
  }
  return 'Basic ' + Buffer.from(`${integrationKey}:${integrationPassword}`).toString('base64');
}

async function call(cfg, method, path, body, extraHeaders = {}) {
  const resp = await fetch(baseFor(cfg.env) + path, {
    method,
    headers: {
      Authorization: authHeader(cfg),
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await resp.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* Opayo returned non-JSON */ }
  if (!resp.ok) {
    // Opayo returns { errors: [ { code, description, property } ] }. Surface the description,
    // not a bare status code — "3224: The CardIdentifier has expired" is a fixable message and
    // "HTTP 422" is not.
    const detail = json?.errors?.map(e => `${e.code}: ${e.description}`).join('; ')
      || json?.description || text.slice(0, 300) || `HTTP ${resp.status}`;
    const err = new Error(`Opayo ${method} ${path} failed — ${detail}`);
    err.status = resp.status;
    err.opayoErrors = json?.errors || null;
    throw err;
  }
  return json;
}

/**
 * Step 1. A short-lived key the BROWSER uses to tokenise the card with Opayo directly.
 * Safe to send to the client — that is its whole purpose.
 */
async function merchantSessionKey(cfg) {
  const j = await call(cfg, 'POST', '/merchant-session-keys', { vendorName: cfg.vendor });
  return { key: j.merchantSessionKey, expiresAt: j.expiry };
}

/**
 * Step 3. Create the payment. `cardIdentifier` came from the browser, never from a card number.
 *
 * Returns the raw Opayo transaction. The caller must check `status`:
 *   Ok            — taken.
 *   3DAuth        — the parent has to complete a 3-D Secure challenge; use `complete3DSecure`.
 *   NotAuthed / Rejected / Error — not taken; `statusDetail` says why.
 */
async function createTransaction(cfg, {
  vendorTxCode, amountPence, currency = 'GBP', description,
  cardIdentifier, merchantSessionKey: msk, reusable = false, save = false,
  customerFirstName, customerLastName, customerEmail,
  billingAddress1, billingCity, billingPostalCode, billingCountry = 'GB',
  browser,             // 3DS2 needs the browser's own properties (see strongCustomerAuthentication below)
  notificationURL,     // where the issuer's challenge page POSTs the parent back (cres + threeDSSessionData)
  apply3DSecure = 'UseMSPSetting',
}) {
  if (!Number.isInteger(amountPence) || amountPence <= 0) {
    throw new Error('amountPence must be a positive whole number of pence');
  }
  const missing = Object.entries({
    vendorTxCode, cardIdentifier, msk, customerFirstName, customerLastName,
    billingAddress1, billingCity, billingPostalCode,
  }).filter(([, v]) => !String(v || '').trim()).map(([k]) => k);
  if (missing.length) throw new Error('Opayo transaction is missing: ' + missing.join(', '));

  return call(cfg, 'POST', '/transactions', {
    transactionType: 'Payment',
    paymentMethod: { card: { merchantSessionKey: msk, cardIdentifier, reusable, save } },
    vendorTxCode,
    amount: amountPence,
    currency,
    description: String(description || 'Childcare fees').slice(0, 100),
    apply3DSecure,
    customerFirstName, customerLastName,
    ...(customerEmail ? { customerEmail } : {}),
    billingAddress: {
      address1: billingAddress1, city: billingCity,
      postalCode: billingPostalCode, country: billingCountry,
    },
    entryMethod: 'Ecommerce',
    // 2026-10-01 — the Pi field is `strongCustomerAuthentication` with `notificationURL`
    // inside it (checked against a maintained Pi client's request builder). The previous
    // `strongCustomerAuth` / `strongCustomerAuthRedirectUrl` names are not Pi fields.
    ...(browser ? { strongCustomerAuthentication: {
      notificationURL,
      browserIP:                browser.browserIP,
      browserAcceptHeader:      browser.browserAcceptHeader || 'text/html, application/json',
      browserJavascriptEnabled: true,
      browserJavaEnabled:       false,
      browserLanguage:          String(browser.browserLanguage || 'en-GB').slice(0, 8),
      browserColorDepth:        String(browser.browserColorDepth || '24'),
      browserScreenHeight:      String(browser.browserScreenHeight || '800'),
      browserScreenWidth:       String(browser.browserScreenWidth || '400'),
      browserTZ:                String(browser.browserTZ ?? '0'),
      browserUserAgent:         String(browser.browserUserAgent || '').slice(0, 2048),
      challengeWindowSize:      browser.challengeWindowSize || 'FullScreen',
      transType:                'GoodsAndServicePurchase',
    } } : {}),
  });
}

/** Step 4. Hand back the issuer's 3-D Secure result to finish the transaction. */
async function complete3DSecure(cfg, transactionId, { cres, threeDSSessionData, paRes }) {
  // 3DS2 (every UK card now): POST /3d-secure-challenge with cRes. 3DS1 (legacy): /3d-secure with paRes.
  if (cres) {
    return call(cfg, 'POST', `/transactions/${encodeURIComponent(transactionId)}/3d-secure-challenge`,
      { cRes: cres, ...(threeDSSessionData ? { threeDSSessionData } : {}) });
  }
  return call(cfg, 'POST', `/transactions/${encodeURIComponent(transactionId)}/3d-secure`, { paRes });
}

/** Read a transaction back. Never trust the browser's word that a payment succeeded. */
async function getTransaction(cfg, transactionId) {
  return call(cfg, 'GET', `/transactions/${encodeURIComponent(transactionId)}`);
}

/** Cheap credential check for the settings screen — asks for a session key and throws if the
 *  key pair is wrong. Costs nothing and tells you immediately whether a paste was correct. */
async function verifyCredentials(cfg) {
  const r = await merchantSessionKey(cfg);
  return { ok: true, expiresAt: r.expiresAt, env: cfg.env === 'live' ? 'live' : 'sandbox' };
}

module.exports = {
  BASES, baseFor, merchantSessionKey, createTransaction,
  complete3DSecure, getTransaction, verifyCredentials,
};
