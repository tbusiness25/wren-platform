'use strict';
const crypto = require('crypto');

// SHA-256 of the known shipped demo JWT secret
// If a deployment hasn't changed the default, this hash will match
const SHIPPED_DEFAULT_HASH = '1cfb13444e7e6eb53d47a912a78ddb190496f7a7b265b0d4451fe5ea7b4480ba';

// Additional well-known weak defaults
const WEAK_SECRETS = [
  'changeme', 'secret', 'jwt_secret', 'your-secret-key', 'supersecret',
  'wren-secret', 'wren_secret', 'mysecret', 'password', '12345678',
];

module.exports = {
  key: 'jwt_secret_unique',
  category: 'access',
  title: 'JWT secret not default',
  description: 'Checks that the JWT_SECRET has been changed from the shipped demo value. Using the default secret allows attackers to forge authentication tokens.',
  async run() {
    const secret = process.env.JWT_SECRET || '';

    if (!secret) {
      return {
        status: 'fail',
        finding: 'JWT_SECRET is not set. Authentication tokens cannot be validated securely.',
        remediation: 'Set JWT_SECRET to a cryptographically random string of at least 64 characters in your .env file. Generate one with: openssl rand -hex 64',
        evidence: { secret_set: false },
      };
    }

    if (secret.length < 32) {
      return {
        status: 'fail',
        finding: `JWT_SECRET is too short (${secret.length} characters). A minimum of 32 characters is required; 64+ is recommended.`,
        remediation: 'Generate a strong secret: openssl rand -hex 64',
        evidence: { length: secret.length },
      };
    }

    const hash = crypto.createHash('sha256').update(secret).digest('hex');

    if (hash === SHIPPED_DEFAULT_HASH) {
      return {
        status: 'fail',
        finding: 'JWT_SECRET matches the shipped demo default. Anyone who has downloaded Wren can forge authentication tokens for your system.',
        remediation: 'Change JWT_SECRET immediately in editions/ladn/.env and editions/ladn-admin/.env. Use: openssl rand -hex 64. Then restart all Wren containers.',
        evidence: { hash, is_default: true },
      };
    }

    if (WEAK_SECRETS.includes(secret.toLowerCase())) {
      return {
        status: 'fail',
        finding: `JWT_SECRET is a known weak value ("${secret}"). This provides no real security.`,
        remediation: 'Replace with a cryptographically random secret: openssl rand -hex 64',
        evidence: { weak: true },
      };
    }

    return {
      status: 'pass',
      finding: `JWT_SECRET is set, unique, and ${secret.length} characters long.`,
      remediation: null,
      evidence: { length: secret.length, hash: hash.slice(0, 8) + '...' },
    };
  },
};
