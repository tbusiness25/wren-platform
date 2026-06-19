'use strict';
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

authenticator.options = { window: 1, step: 30 };

function generateSecret() { return authenticator.generateSecret(); }

function buildOtpauthUrl(secret, accountName, issuer = 'Wren') {
  return authenticator.keyuri(accountName, issuer, secret);
}

async function buildQrDataUrl(otpauthUrl) { return QRCode.toDataURL(otpauthUrl); }

function verify(token, secret) {
  try { return authenticator.verify({ token, secret }); }
  catch { return false; }
}

// Current 30-second window counter (for replay prevention)
function currentWindow() { return Math.floor(Date.now() / 30000); }

function generateRecoveryCodes(n = 10) {
  return Array.from({ length: n }, () =>
    crypto.randomBytes(5).toString('hex').match(/.{1,4}/g).join('-').toUpperCase()
  );
}

async function hashCode(code) { return bcrypt.hash(code, 10); }
async function compareCode(code, hash) { return bcrypt.compare(code, hash); }

module.exports = {
  generateSecret, buildOtpauthUrl, buildQrDataUrl, verify,
  currentWindow, generateRecoveryCodes, hashCode, compareCode,
};
