'use strict';
const crypto = require('crypto');
const { getDecryptedSetting } = require('./payment-settings');

async function _token() {
  const token = await getDecryptedSetting('gocardless_access_token');
  if (!token) throw new Error('GoCardless not configured — add gocardless_access_token in Payment Settings');
  return token;
}

async function _baseUrl() {
  const env = await getDecryptedSetting('gocardless_env');
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

async function isTestMode() {
  const env = await getDecryptedSetting('gocardless_env');
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
  const secret = await getDecryptedSetting('gocardless_webhook_secret');
  if (!secret) throw new Error('GoCardless webhook secret not configured');
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
  createRedirectFlow,
  completeRedirectFlow,
  getMandate,
  createPayment,
  getPayment,
  listPayments,
  verifyWebhook,
};
