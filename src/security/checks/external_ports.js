'use strict';
const https = require('https');

const EXPECTED_PORTS = new Set([80, 443, 8080, 8443]);

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function getPublicIp() {
  return new Promise((resolve, reject) => {
    https.get('https://ifconfig.me/ip', { timeout: 8000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim()));
    }).on('error', reject);
  });
}

module.exports = {
  key: 'external_ports',
  category: 'network',
  title: 'External port exposure',
  description: 'Queries Shodan internetdb for your public IP\'s open ports. Unexpected ports visible from the internet are a serious risk.',
  async run() {
    const ip = await getPublicIp();
    const data = await httpGet(`https://internetdb.shodan.io/${ip}`);

    if (!data) {
      return {
        status: 'warn',
        finding: `Could not fetch Shodan data for ${ip}. Unable to verify external port exposure.`,
        remediation: 'Check manually at https://internetdb.shodan.io/' + ip,
        evidence: { ip, raw: null },
      };
    }

    const ports = data.ports || [];
    const unexpected = ports.filter(p => !EXPECTED_PORTS.has(p));

    if (unexpected.length === 0) {
      return {
        status: 'pass',
        finding: `No unexpected ports visible from the internet on ${ip}. Open ports: ${ports.join(', ') || 'none listed'}.`,
        remediation: null,
        evidence: { ip, ports, unexpected },
      };
    }

    return {
      status: 'fail',
      finding: `Unexpected ports visible from the internet on ${ip}: ${unexpected.join(', ')}. This may indicate services are unintentionally exposed.`,
      remediation: 'Review your router/firewall rules. Ports like 5432 (PostgreSQL), 22 (SSH), or 3000 (Node) should never be exposed to the internet. Use a firewall to block them.',
      evidence: { ip, ports, unexpected, shodan: data },
    };
  },
};
