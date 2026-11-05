#!/usr/bin/env node
/**
 * Wren Framework Update Checker
 * Runs weekly (cron: 0 2 * * 0) to detect changes to UK education frameworks.
 *
 * Add to crontab:
 *   0 2 * * 0 node /app/scripts/framework-checker.js >> /var/log/wren-framework-checker.log 2>&1
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const http = require('https'); // all gov.uk URLs are HTTPS

// ── Config ─────────────────────────────────────────────────────────────────

const DATA_FILE   = path.join(__dirname, '../data/framework-versions.json');
const TASK_RUNNER = 'http://localhost:3847';
const TASK_SECRET = process.env.TASK_SECRET || ''; // <TASK_SECRET redacted — set in .env, not committed>

// Load env from closest .env if running standalone (not in container)
try {
  const envPath = path.join(__dirname, '../editions/eyfs/.env');
  if (fs.existsSync(envPath)) {
    fs.readFileSync(envPath, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
  }
} catch {}

const TELEGRAM_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function readData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    log(`WARN: could not read ${DATA_FILE}: ${e.message}`);
    return {};
  }
}

function writeData(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/** Fetch URL and return a hash string from response headers. */
function fetchHeaders(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 15000 }, res => {
      const etag        = res.headers['etag']          || '';
      const lastMod     = res.headers['last-modified'] || '';
      const contentLen  = res.headers['content-length']|| '';
      const hash = `${etag}::${lastMod}::${contentLen}`;
      res.resume(); // drain body
      resolve({ hash, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/** Send a Telegram message via the task runner or directly. */
async function notify(message) {
  // Try task runner first
  try {
    const taskResp = await post(
      `${TASK_RUNNER}/api/notify`,
      { message },
      { 'x-task-secret': TASK_SECRET }
    );
    if (taskResp.ok) { log('Notification sent via task runner'); return; }
  } catch {}

  // Fall back to direct Telegram
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID) {
    try {
      await post(
        `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
        { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' },
        {}
      );
      log('Notification sent via Telegram directly');
    } catch (e) {
      log(`WARN: Telegram notification failed: ${e.message}`);
    }
  } else {
    log('WARN: No notification method available (no task runner, no Telegram tokens)');
  }
}

/** Generic POST helper (JSON body). */
function post(url, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const parsed  = new URL(url);
    const mod     = parsed.protocol === 'https:' ? require('https') : require('http');
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ''),
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr), ...headers },
      timeout:  10000,
    };
    const req = mod.request(opts, res => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ ok: res.statusCode < 400, body: JSON.parse(raw) }); }
        catch { resolve({ ok: res.statusCode < 400, body: raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function run() {
  log('Framework checker starting');
  const data = readData();
  const updates = [];

  for (const [key, entry] of Object.entries(data)) {
    log(`Checking: ${entry.name}`);
    try {
      const { hash, status } = await fetchHeaders(entry.url);

      if (status >= 400) {
        log(`  HTTP ${status} — skipping`);
        continue;
      }

      const today = new Date().toISOString().split('T')[0];
      entry.last_checked = today;

      if (!entry.last_seen_hash) {
        // First run — record current hash, no alert
        entry.last_seen_hash = hash;
        entry.status = 'current';
        log(`  First check — hash recorded`);
      } else if (hash !== entry.last_seen_hash) {
        entry.last_seen_hash = hash;
        entry.status = 'update_available';
        updates.push(entry.name);
        log(`  CHANGED — marking update_available`);
      } else {
        entry.status = 'current';
        log(`  No change`);
      }
    } catch (e) {
      log(`  ERROR: ${e.message}`);
    }
  }

  writeData(data);
  log(`Check complete. Updates detected: ${updates.length}`);

  if (updates.length > 0) {
    const lines = updates.map(n => `  • ${n}`).join('\n');
    await notify(
      `📋 <b>Wren Framework Update Alert</b>\n\n` +
      `The following UK frameworks may have been updated:\n${lines}\n\n` +
      `Check the IT Settings → Framework Versions tab for details.`
    );
  }

  log('Done');
}

run().catch(e => {
  console.error(`[${new Date().toISOString()}] FATAL:`, e);
  process.exit(1);
});
