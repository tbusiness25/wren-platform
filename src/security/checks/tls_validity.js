'use strict';
const tls = require('tls');

const WARN_DAYS = 30;

function checkCert(hostname, port = 443) {
  return new Promise((resolve) => {
    const opts = { host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: 10000 };
    const sock = tls.connect(opts, () => {
      const cert = sock.getPeerCertificate();
      sock.destroy();
      if (!cert || !cert.valid_to) return resolve({ hostname, status: 'error', msg: 'No certificate returned' });
      const expiry = new Date(cert.valid_to);
      const now = new Date();
      const daysLeft = Math.floor((expiry - now) / 86400000);
      resolve({ hostname, expiry: expiry.toISOString(), daysLeft, subject: cert.subject?.CN });
    });
    sock.on('error', (e) => resolve({ hostname, status: 'error', msg: e.message }));
    sock.on('timeout', () => { sock.destroy(); resolve({ hostname, status: 'error', msg: 'Timeout' }); });
  });
}

function getDomains() {
  const domains = [];
  const vars = ['PARENTS_DOMAIN', 'STAFF_DOMAIN', 'ADMIN_DOMAIN', 'EY_DOMAIN', 'HR_DOMAIN'];
  for (const v of vars) {
    const d = process.env[v];
    if (d) domains.push(d.trim());
  }
  // Fallback: well-known LADN domains if env vars not set
  if (domains.length === 0) {
    const base = process.env.SETTING_DOMAIN;
    if (base) {
      domains.push(`parents.${base}`, `ey.${base}`, `admin.${base}`);
    }
  }
  return [...new Set(domains)];
}

module.exports = {
  key: 'tls_validity',
  category: 'network',
  title: 'TLS certificate validity',
  description: 'Checks SSL/TLS certificates for all configured portal domains. Warns if a cert expires within 30 days; fails if already expired.',
  async run() {
    const domains = getDomains();

    if (domains.length === 0) {
      return {
        status: 'warn',
        finding: 'No domains configured in environment variables (PARENTS_DOMAIN, STAFF_DOMAIN, ADMIN_DOMAIN, SETTING_DOMAIN). Cannot check TLS certificates.',
        remediation: 'Set PARENTS_DOMAIN, STAFF_DOMAIN and ADMIN_DOMAIN in your .env file, or set SETTING_DOMAIN to your base domain.',
        evidence: { domains: [] },
      };
    }

    const results = await Promise.all(domains.map(d => checkCert(d)));
    const expired = results.filter(r => !r.status && r.daysLeft <= 0);
    const expiring = results.filter(r => !r.status && r.daysLeft > 0 && r.daysLeft <= WARN_DAYS);
    const errors = results.filter(r => r.status === 'error');
    const ok = results.filter(r => !r.status && r.daysLeft > WARN_DAYS);

    if (expired.length > 0) {
      return {
        status: 'fail',
        finding: `Expired certificate(s): ${expired.map(r => `${r.hostname} (expired ${r.expiry})`).join(', ')}. Users cannot access these portals securely.`,
        remediation: 'Renew your SSL certificates immediately. If using Cloudflare, check the SSL/TLS → Edge Certificates section. If using Let\'s Encrypt, run: certbot renew.',
        evidence: { domains: results },
      };
    }

    if (expiring.length > 0) {
      return {
        status: 'warn',
        finding: `Certificate(s) expiring within ${WARN_DAYS} days: ${expiring.map(r => `${r.hostname} (${r.daysLeft} days, expires ${r.expiry})`).join(', ')}.`,
        remediation: 'Renew these certificates before expiry. If auto-renewal is configured, check it is running correctly.',
        evidence: { domains: results },
      };
    }

    if (errors.length > 0 && ok.length === 0) {
      return {
        status: 'warn',
        finding: `Could not connect to check certificates for: ${errors.map(r => r.hostname).join(', ')}.`,
        remediation: 'Ensure the domains are reachable from the server. Check DNS and firewall settings.',
        evidence: { domains: results },
      };
    }

    const summary = ok.map(r => `${r.hostname} (${r.daysLeft} days)`).join(', ');
    return {
      status: 'pass',
      finding: `All certificates valid. ${summary}.`,
      remediation: null,
      evidence: { domains: results },
    };
  },
};
