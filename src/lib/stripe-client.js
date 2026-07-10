'use strict';
const crypto = require('crypto');
const { getDecryptedSetting } = require('./payment-settings');

async function _secretKey() {
  const key = await getDecryptedSetting('stripe_secret_key');
  if (!key) throw new Error('Stripe not configured — add stripe_secret_key in Payment Settings');
  return key;
}

// Encode nested object to Stripe's www-form-urlencoded format
function _buildParams(obj, prefix = '') {
  const params = new URLSearchParams();
  function append(k, v) {
    if (v === null || v === undefined) return;
    if (typeof v === 'object' && !Array.isArray(v)) {
      Object.entries(v).forEach(([sk, sv]) => append(`${k}[${sk}]`, sv));
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => append(`${k}[${i}]`, item));
    } else {
      params.append(k, String(v));
    }
  }
  Object.entries(obj).forEach(([k, v]) => append(k, v));
  return params;
}

async function _stripeGet(path) {
  const key = await _secretKey();
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe GET ${path}: ${data.error?.message || res.status}`);
  return data;
}

async function _stripePost(path, body) {
  const key = await _secretKey();
  const res = await fetch(`https://api.stripe.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: _buildParams(body).toString(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe POST ${path}: ${data.error?.message || res.status}`);
  return data;
}

async function isTestMode() {
  const key = await getDecryptedSetting('stripe_secret_key');
  return !key || key.startsWith('sk_test_');
}

async function createCheckoutSession({
  invoiceId, amountPence, description, customerEmail, successUrl, cancelUrl,
}) {
  return _stripePost('/checkout/sessions', {
    mode: 'payment',
    customer_email: customerEmail,
    'line_items[0][price_data][currency]': 'gbp',
    'line_items[0][price_data][unit_amount]': amountPence,
    'line_items[0][price_data][product_data][name]': description,
    'line_items[0][quantity]': 1,
    'metadata[invoice_id]': String(invoiceId),
    'payment_method_types[0]': 'card',
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

async function retrieveCheckoutSession(sessionId) {
  return _stripeGet(`/checkout/sessions/${encodeURIComponent(sessionId)}`);
}

async function retrievePaymentIntent(paymentIntentId) {
  return _stripeGet(`/payment_intents/${encodeURIComponent(paymentIntentId)}`);
}

// List recent payments from Stripe (for reconciliation)
async function listPaymentIntents({ limit = 100, createdAfter } = {}) {
  let path = `/payment_intents?limit=${limit}`;
  if (createdAfter) path += `&created[gte]=${Math.floor(createdAfter.getTime() / 1000)}`;
  return _stripeGet(path);
}

// Verify Stripe webhook signature — rawBody must be a Buffer
async function verifyWebhook(rawBody, sigHeader) {
  const secret = await getDecryptedSetting('stripe_webhook_secret');
  if (!secret) throw new Error('Stripe webhook secret not configured');

  const parts = {};
  sigHeader.split(',').forEach(part => {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (!parts[k]) parts[k] = [];
      parts[k].push(v);
    }
  });

  const timestamp = parts.t?.[0];
  const signatures = parts.v1 || [];
  if (!timestamp || !signatures.length) throw new Error('Invalid Stripe-Signature header');

  // 5-minute replay protection
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) {
    throw new Error('Stripe webhook timestamp too old');
  }

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');

  const valid = signatures.some(sig => {
    try {
      const sigBuf = Buffer.from(sig, 'hex');
      if (sigBuf.length !== expectedBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch { return false; }
  });

  if (!valid) throw new Error('Stripe webhook signature mismatch');

  return JSON.parse(rawBody.toString('utf8'));
}

module.exports = {
  isTestMode,
  createCheckoutSession,
  retrieveCheckoutSession,
  retrievePaymentIntent,
  listPaymentIntents,
  verifyWebhook,
};
