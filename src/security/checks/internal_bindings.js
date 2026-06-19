'use strict';
const net = require('net');
const https = require('https');

function getPublicIp() {
  return new Promise((resolve, reject) => {
    https.get('https://ifconfig.me/ip', { timeout: 8000 }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(d.trim()));
    }).on('error', reject);
  });
}

function tcpConnect(host, port, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(result);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish('open'));
    sock.on('timeout', () => finish('closed'));
    sock.on('error', () => finish('closed'));
    sock.connect(port, host);
  });
}

const SENSITIVE_PORTS = [5432, 5433, 5434, 5438, 3306, 6379, 27017];

module.exports = {
  key: 'internal_bindings',
  category: 'network',
  title: 'Database network binding',
  description: 'Checks that databases (PostgreSQL etc.) are not accessible on your public IP by attempting TCP connections from within the server.',
  async run() {
    const ip = await getPublicIp();
    const results = {};

    await Promise.all(SENSITIVE_PORTS.map(async (port) => {
      results[port] = await tcpConnect(ip, port, 4000);
    }));

    const exposed = Object.entries(results).filter(([, v]) => v === 'open').map(([p]) => parseInt(p));

    if (exposed.length === 0) {
      return {
        status: 'pass',
        finding: `No database ports (${SENSITIVE_PORTS.join(', ')}) are accessible on your public IP (${ip}).`,
        remediation: null,
        evidence: { ip, port_results: results },
      };
    }

    const portNames = { 5432: 'PostgreSQL', 5433: 'PostgreSQL (ladn)', 5434: 'PostgreSQL (wren)', 5438: 'PostgreSQL (haven)', 3306: 'MySQL', 6379: 'Redis', 27017: 'MongoDB' };
    const names = exposed.map(p => `${p} (${portNames[p] || 'unknown'})`).join(', ');

    return {
      status: 'fail',
      finding: `Database port(s) accessible from your public IP (${ip}): ${names}. These services should NEVER be internet-facing.`,
      remediation: 'Block these ports in your router/firewall immediately. On Linux: iptables -A INPUT -p tcp --dport 5432 -j DROP. Or use ufw: ufw deny 5432. Ensure Docker published ports only bind to 127.0.0.1 or your Tailscale IP.',
      evidence: { ip, exposed, port_results: results },
    };
  },
};
