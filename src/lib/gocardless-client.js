'use strict';
const crypto = require('crypto');
const { getDecryptedSetting } = require('./payment-settings');

// 2026-09-23 — the credential was here all along and the two halves never met.
// LADN's live GoCardless key has been sitting in editions/ladn/.env as GOCARDLESS_TOKEN,
// loaded into the container, while this client only ever looked for 'gocardless_access_token'
// in the encrypted payment_settings table — which holds TrueLayer's keys and nothing else.
// So GoCardless "was not configured" despite 619 direct debits running on that very account
// through EyLog. Settings still win when set; the environment is the fallback.
async function _token() {
  const token = (await getDecryptedSetting('gocardless_access_token'))
             || process.env.GOCARDLESS_TOKEN
             || process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GoCardless not configured — add gocardless_access_token in Payment Settings, or set GOCARDLESS_TOKEN');
  return token;
}

/** live vs sandbox. GoCardless tokens are self-describing: they begin live_ or sandbox_. */
async function _baseUrl() {
  const env = (await getDecryptedSetting('gocardless_env'))
           || process.env.GOCARDLESS_ENV
           || ((await _token()).startsWith('live_') ? 'live' : 'sandbox');
  return env === 'live'
    ? 'https://api.gocardless.com'
    : 'https://api-sandbox.gocardless.com';
}

async function _gcRequest(method, path, body = null) {
  const [token, base] = await Promise.all([_token(), _baseUrl()]);
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'GoCardless-Version': '2015-07-06',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) {
    const msg = data.error?.message || data.message || res.status;
    throw new Error(`GoCardless ${method} ${path}: ${msg}`);
  }
  return data;
}

// 2026-09-23 — this read only the settings row, so with the credential coming from the
// environment it answered "test mode" while the client was talking to the LIVE account and
// returning real paid-out direct debits. A screen that says test while taking real money is
// worse than no indicator at all. It now agrees with whatever _baseUrl() actually uses.
// List every mandate on the account, following GoCardless's cursor pagination.
// Read-only. Used to bring the mandates into Wren so it knows who is on Direct Debit —
// they have always lived in the GoCardless account and Wren had no copy at all.
async function listMandates({ limit = 500 } = {}) {
  const out = [];
  let after = null;
  while (out.length < limit) {
    const path = '/mandates?limit=100' + (after ? '&after=' + encodeURIComponent(after) : '');
    const data = await _gcRequest('GET', path);
    const batch = (data && data.mandates) || [];
    out.push(...batch);
    after = data && data.meta && data.meta.cursors && data.meta.cursors.after;
    if (!after || !batch.length) break;
  }
  return out;
}

// The customer behind a mandate — name and email, so a mandate can be matched to a family.
async function getCustomer(customerId) {
  const data = await _gcRequest('GET', `/customers/${encodeURIComponent(customerId)}`);
  return data && data.customers;
}

// Cancel a mandate. Irreversible in GoCardless — the customer must authorise a new one —
// so it is only ever called deliberately, never by a job.
async function cancelMandate(mandateId) {
  const data = await _gcRequest('POST', `/mandates/${encodeURIComponent(mandateId)}/actions/cancel`, {});
  return data && data.mandates;
}

async function isTestMode() {
  const env = (await getDecryptedSetting('gocardless_env'))
           || process.env.GOCARDLESS_ENV
           || ((await _token()).startsWith('live_') ? 'live' : 'sandbox');
  return env !== 'live';
}

// Create a redirect flow — parent is sent to the returned redirect_url to enter bank details
async function createRedirectFlow({ description, sessionToken, successRedirectUrl, email }) {
  const data = await _gcRequest('POST', '/redirect_flows', {
    redirect_flows: {
      description,
      session_token: sessionToken,
      success_redirect_url: successRedirectUrl,
      prefilled_customer: email ? { email } : undefined,
    },
  });
  return data.redirect_flows;
}

// Complete the redirect flow after parent confirms — returns mandate_id
async function completeRedirectFlow(redirectFlowId, sessionToken) {
  const data = await _gcRequest(
    'POST',
    `/redirect_flows/${encodeURIComponent(redirectFlowId)}/actions/complete`,
    { data: { session_token: sessionToken } }
  );
  return data.redirect_flows;
}

// Retrieve a mandate
async function getMandate(mandateId) {
  const data = await _gcRequest('GET', `/mandates/${encodeURIComponent(mandateId)}`);
  return data.mandates;
}

// Retrieve a customer bank account — has the display fields (bank name, holder, ending)
// that mandates themselves don't carry.
async function getCustomerBankAccount(bankAccountId) {
  const data = await _gcRequest('GET', `/customer_bank_accounts/${encodeURIComponent(bankAccountId)}`);
  return data.customer_bank_accounts;
}

// Create a payment against a mandate
async function createPayment({ mandateId, amountPence, description, reference }) {
  const data = await _gcRequest('POST', '/payments', {
    payments: {
      amount: amountPence,
      currency: 'GBP',
      description,
      reference: reference || undefined,
      links: { mandate: mandateId },
    },
  });
  return data.payments;
}

// Retrieve a payment
async function getPayment(paymentId) {
  const data = await _gcRequest('GET', `/payments/${encodeURIComponent(paymentId)}`);
  return data.payments;
}

// List payments (for reconciliation)
async function listPayments({ limit = 500, createdAfter } = {}) {
  let path = `/payments?limit=${limit}`;
  if (createdAfter) path += `&created_at[gte]=${createdAfter.toISOString()}`;
  const data = await _gcRequest('GET', path);
  return data.payments || [];
}

// Verify GoCardless webhook — rawBody is Buffer, header is Webhook-Signature value
async function verifyWebhook(rawBody, signatureHeader) {
  // 2026-09-23 — same two-halves problem as the access token: accept the secret from the
  // environment as well, so pointing GoCardless at Wren does not also require a settings edit.
  const secret = (await getDecryptedSetting('gocardless_webhook_secret'))
              || process.env.GOCARDLESS_WEBHOOK_SECRET;
  if (!secret) throw new Error('GoCardless webhook secret not configured — set gocardless_webhook_secret in Payment Settings, or GOCARDLESS_WEBHOOK_SECRET');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  try {
    const sigBuf = Buffer.from(signatureHeader, 'hex');
    if (sigBuf.length !== expectedBuf.length) throw new Error('GoCardless webhook signature mismatch');
    if (!crypto.timingSafeEqual(sigBuf, expectedBuf)) throw new Error('GoCardless webhook signature mismatch');
  } catch (e) {
    if (e.message.includes('mismatch')) throw e;
    throw new Error('GoCardless webhook signature mismatch');
  }
  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = {
  isTestMode,
  listMandates,
  cancelMandate,
  getCustomer,
  createRedirectFlow,
  completeRedirectFlow,
  getMandate,
  getCustomerBankAccount,
  createPayment,
  getPayment,
  listPayments,
  verifyWebhook,
};
