'use strict';
const { getPool } = require('../db/pool');
// b402: the AES-256-GCM logic now lives in field-crypto.js. namespace 'payments'
// reproduces the original key (sha256('payments:' + JWT_SECRET)) byte for byte,
// so every row encrypted before this refactor still decrypts.
const fieldCrypto = require('./field-crypto');
const NS = 'payments';

function encrypt(plain) {
  return fieldCrypto.encrypt(plain, NS);
}

function decrypt(enc_value, iv, tag) {
  return fieldCrypto.decrypt(enc_value, iv, tag, NS);
}

const SETTING_KEYS = [
  'stripe_secret_key',
  'stripe_publishable_key',
  'stripe_webhook_secret',
  'gocardless_access_token',
  'gocardless_webhook_secret',
  'gocardless_env',            // 'sandbox' | 'live'
  'truelayer_client_id',
  'truelayer_client_secret',
  'truelayer_env',             // 'sandbox' | 'live'
  // Opayo Pi (2026-09-28). LADN's own Elavon merchant account — card payments stopped working
  // for parents when EyLog moved everyone to EPAY. Pi is Elavon's current API; the legacy Form
  // integration (a single "Form Encryption Password") is what EyLog used and is being retired.
  // Card details are tokenised in the browser by Opayo's own script and never touch Wren, so
  // this stays PCI SAQ A.
  'opayo_vendor',                // vendor (account) name, for reference and vendorTxCode
  'opayo_integration_key',       // Pi integration key    — the username half of Basic auth
  'opayo_integration_password',  // Pi integration password — the password half
  'opayo_env',                   // 'sandbox' | 'live'
  'tfc_provider_account_number', // nursery's TFC account number from HMRC
  'reconcile_auto_threshold',  // confidence 0-100, default 95
];

async function getDecryptedSetting(key) {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT enc_value, iv, tag FROM payment_settings WHERE key=$1',
      [key]
    );
    if (!rows.length || !rows[0].enc_value) return null;
    return decrypt(rows[0].enc_value, rows[0].iv, rows[0].tag);
  } catch {
    return null;
  }
}

async function setEncryptedSetting(key, value) {
  const db = getPool();
  const { enc_value, iv, tag } = encrypt(value);
  await db.query(`
    INSERT INTO payment_settings (key, enc_value, iv, tag, updated_at)
    VALUES ($1, $2, $3, $4, NOW())
    ON CONFLICT (key) DO UPDATE SET enc_value=$2, iv=$3, tag=$4, updated_at=NOW()
  `, [key, enc_value, iv, tag]);
}

// Returns all settings; plaintext values for Stripe/GC are masked for client responses.
async function getAllSettingsRaw() {
  const db = getPool();
  const { rows } = await db.query(
    'SELECT key, enc_value, iv, tag, updated_at FROM payment_settings WHERE key = ANY($1)',
    [SETTING_KEYS]
  );
  const result = {};
  for (const key of SETTING_KEYS) {
    const row = rows.find(r => r.key === key);
    if (row && row.enc_value) {
      try {
        result[key] = { value: decrypt(row.enc_value, row.iv, row.tag), updated_at: row.updated_at };
      } catch {
        result[key] = { value: null, updated_at: row.updated_at };
      }
    } else {
      result[key] = { value: null, updated_at: null };
    }
  }
  return result;
}

// Mask sensitive keys for client display: show only last 4 chars
function maskKey(value) {
  if (!value) return null;
  if (value.length <= 8) return '••••••••';
  return '••••' + value.slice(-4);
}

module.exports = { getDecryptedSetting, setEncryptedSetting, getAllSettingsRaw, maskKey, SETTING_KEYS };
