'use strict';
// AES-256-GCM token encryption/decryption.
// Key source: WREN_ENCRYPTION_KEY env var (64-char hex = 32-byte key).
// Stored format: "<ivHex>:<ciphertextHex>:<tagHex>"

const crypto = require('crypto');

function getKey() {
  const k = process.env.WREN_ENCRYPTION_KEY;
  if (!k || k.length !== 64) throw new Error('WREN_ENCRYPTION_KEY must be a 64-char hex string');
  return Buffer.from(k, 'hex');
}

function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${enc.toString('hex')}:${tag.toString('hex')}`;
}

function decrypt(stored) {
  if (!stored) return null;
  const [ivHex, cipherHex, tagHex] = stored.split(':');
  if (!ivHex || !cipherHex || !tagHex) throw new Error('Invalid encrypted token format');
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(cipherHex, 'hex')) + decipher.final('utf8');
}

module.exports = { encrypt, decrypt };
