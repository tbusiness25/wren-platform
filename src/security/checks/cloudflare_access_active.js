'use strict';
const https = require('https');
const http = require('http');

function httpRequest(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'WrenSecurityCheck/1.0' } }, (res) => {
      res.resume();
      resolve({
        statusCode: res.statusCode,
        location: res.headers['location'] || null,
        cfHeaders: Object.fromEntries(
          Object.entries(res.headers).filter(([k]) => k.startsWith('cf-'))
        ),
      });
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

function getProtectedDomains() {
  const envMap = {
    admin: process.env.ADMIN_DOMAIN,
    parents: process.env.PARENTS_DOMAIN,
    staff: process.env.STAFF_DOMAIN || process.env.EY_DOMAIN,
    hr: process.env.HR_DOMAIN,
  };
  return Object.entries(envMap)
    .filter(([, v]) => v)
    .map(([name, domain]) => ({ name, domain: domain.trim() }));
}

function isCfAccessResponse(r) {
  // CF Access returns 302 to <domain>.cloudflareaccess.com or includes cf-access-* headers
  if (r.error) return null;
  const loc = r.location || '';
  const hasCfAccess = loc.includes('cloudflareaccess.com') || !!r.cfHeaders['cf-access-app-public'];
  const blockedOrRedirected = r.statusCode === 302 || r.statusCode === 401 || r.statusCode === 403;
  return hasCfAccess || blockedOrRedirected;
}

module.exports = {
  key: 'cloudflare_access_active',
  category: 'network',
  title: 'Cloudflare Access protection',
  description: 'Sends an unauthenticated request to each protected portal and checks that Cloudflare Access blocks or redirects it rather than serving content directly.',
  async run() {
    const domains = getProtectedDomains();

    if (domains.length === 0) {
      return {
        status: 'warn',
        finding: 'No portal domains configured (ADMIN_DOMAIN, PARENTS_DOMAIN, STAFF_DOMAIN). Cannot verify Cloudflare Access protection.',
        remediation: 'Set domain environment variables to enable this check.',
        evidence: { domains: [] },
      };
    }

    const results = await Promise.all(
      domains.map(async ({ name, domain }) => {
        const r = await httpRequest(`https://${domain}/`);
        const protected_ = isCfAccessResponse(r);
        return { name, domain, protected: protected_, response: r };
      })
    );

    const unprotected = results.filter(r => r.protected === false);
    const errors = results.filter(r => r.response?.error);
    const ok = results.filter(r => r.protected === true);

    if (unprotected.length > 0) {
      return {
        status: 'fail',
        finding: `Portal(s) appear to be loading without Cloudflare Access authentication: ${unprotected.map(r => r.domain).join(', ')}. Content may be accessible to the public internet.`,
        remediation: 'Check your Cloudflare Access application policies at dash.cloudflare.com. Ensure the application is enabled and the policy includes the correct email/service token requirements.',
        evidence: { results },
      };
    }

    if (ok.length === 0 && errors.length > 0) {
      return {
        status: 'warn',
        finding: `Could not reach portal domains to verify protection: ${errors.map(r => r.domain).join(', ')}.`,
        remediation: 'Ensure domains are reachable from the server and Cloudflare tunnel is healthy.',
        evidence: { results },
      };
    }

    return {
      status: 'pass',
      finding: `All checked portals are protected by Cloudflare Access: ${ok.map(r => `${r.name} (${r.domain})`).join(', ')}.`,
      remediation: null,
      evidence: { results },
    };
  },
};
