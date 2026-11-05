'use strict';
/**
 * field-crypto.js — b402 (2026-10-06).
 *
 * The AES-256-GCM helper, factored out of src/lib/payment-settings.js so the
 * b402 encryption pilot (and anything after it) can encrypt a column at rest
 * without a second key-derivation scheme in the codebase. payment-settings.js
 * now calls this with namespace 'payments', reproducing its original key byte
 * for byte (sha256('payments:' + JWT_SECRET)) — existing encrypted settings
 * decrypt exactly as before.
 *
 * `namespace` scopes the derived key per call site (e.g. 'pii:staff.ni_number')
 * so two unrelated secrets never share a key, and a leaked namespace string
 * alone reveals nothing about the key.
 */

const crypto = require('crypto');

const ALGO = 'aes-256-gcm';

function _key(namespace) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('field-crypto: JWT_SECRET is not set');
  if (!namespace) throw new Error('field-crypto: namespace is required');
  return crypto.createHash('sha256').update(`${namespace}:${secret}`).digest();
}

function encrypt(plain, namespace) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, _key(namespace), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { enc_value: enc.toString('hex'), iv: iv.toString('hex'), tag: tag.toString('hex') };
}

function decrypt(enc_value, iv, tag, namespace) {
  const decipher = crypto.createDecipheriv(ALGO, _key(namespace), Buffer.from(iv, 'hex'));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(enc_value, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

module.exports = { encrypt, decrypt, ALGO };
