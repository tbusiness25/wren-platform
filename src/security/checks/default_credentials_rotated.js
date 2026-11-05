'use strict';
const crypto = require('crypto');

// SHA-256 hashes of known shipped demo/default database passwords
// We never store the plain text in this check. The first two entries are the
// precomputed SHA-256 digests of the Wren and Haven shipped demo DB passwords
// (digests only — the plaintext lives in the gitignored .env, never committed).
const KNOWN_DEFAULT_HASHES = new Set([
  '69e0b454540c66092a8b83b417e9cdd1aca3b5cf83660fe83cfd6e917987b16b', // Wren demo default DB password
  'c3f1fa7e9e9cf97a85256d42793b2b13bc11b527d621ba198072d4b8b95e8bd5', // Haven demo default DB password
  crypto.createHash('sha256').update('postgres').digest('hex'),
  crypto.createHash('sha256').update('password').digest('hex'),
  crypto.createHash('sha256').update('changeme').digest('hex'),
  crypto.createHash('sha256').update('wren').digest('hex'),
  crypto.createHash('sha256').update('admin').digest('hex'),
  'bc382aba73777e3deca53706fffe52b942ef025f11997feeaae9ada256ed0d93', // legacy nursery_data default DB password
]);

module.exports = {
  key: 'default_credentials_rotated',
  category: 'access',
  title: 'Database credentials rotated',
  description: 'Checks whether the database password matches any known shipped demo default. Warns if credentials appear unchanged since initial setup.',
  async run() {
    const pgPass = process.env.PG_PASSWORD || '';

    if (!pgPass) {
      return {
        status: 'warn',
        finding: 'PG_PASSWORD is not set in environment. Unable to verify credential rotation.',
        remediation: 'Ensure PG_PASSWORD is set in your container environment.',
        evidence: {},
      };
    }

    const hash = crypto.createHash('sha256').update(pgPass).digest('hex');

    if (KNOWN_DEFAULT_HASHES.has(hash)) {
      return {
        status: 'warn',
        finding: 'Database password matches a known shipped demo default. If this system holds real data, the password should be changed from the demo value.',
        remediation: 'Change PG_PASSWORD in your .env files and update the PostgreSQL user password: docker exec wren-postgres psql -U wren -c "ALTER USER wren PASSWORD \'your-new-strong-password\';" Then restart all Wren containers.',
        evidence: { is_default: true },
      };
    }

    if (pgPass.length < 12) {
      return {
        status: 'warn',
        finding: `Database password is only ${pgPass.length} characters. A minimum of 12 characters is recommended.`,
        remediation: 'Use a longer password with mixed case, numbers and symbols.',
        evidence: { length: pgPass.length },
      };
    }

    return {
      status: 'pass',
      finding: 'Database password is set and does not match any known demo default.',
      remediation: null,
      evidence: { length: pgPass.length },
    };
  },
};
