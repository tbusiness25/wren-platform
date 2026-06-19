const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const https = require('https');
const http = require('http');

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// GET /api/vapi-health/stats — last 14 days of health rows
router.get('/stats', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id, checked_at, vapi_calls_24h, db_calls_24h, drift,
             synthetic_event_passed, synthetic_event_error, alerted
      FROM ladn.vapi_pipeline_health
      WHERE checked_at > NOW() - INTERVAL '14 days'
      ORDER BY checked_at DESC
      LIMIT 100
    `);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/vapi-health/run — trigger smoke test workflow via its webhook
router.post('/run', managerOnly, async (req, res) => {
  const n8nBaseUrl = process.env.N8N_BASE_URL || 'http://<server-ip>:5678';
  const webhookPath = 'vapi-smoke-test-run';

  try {
    const result = await postWebhook(n8nBaseUrl, webhookPath);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function postWebhook(baseUrl, webhookPath) {
  return new Promise((resolve, reject) => {
    const url = new URL(`/webhook/${webhookPath}`, baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify({ source: 'admin-manual-run' });
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 15000
    };
    const req = lib.request(options, (resp) => {
      let data = '';
      resp.on('data', chunk => { data += chunk; });
      resp.on('end', () => {
        try { resolve({ status: resp.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: resp.statusCode, raw: data }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('n8n webhook timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = router;
