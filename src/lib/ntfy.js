'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * ntfy.js — b505 (2026-10-18)
 *
 * Push a short TEXT notification to Toby's phone, loud enough to break through
 * Do Not Disturb. Used for one thing only: an out-of-hours detection at the
 * nursery.
 *
 * ── WHY NTFY AND NOT THE EXISTING CHANNELS ────────────────────────────────────
 * Wren already has web push (EY portal only, and push_subscriptions is empty) and
 * Telegram. Neither can be made to ring through Do Not Disturb on an Android
 * phone: that needs a notification CHANNEL the user has personally ticked
 * "Override Do Not Disturb" on, and an app that maps a server-side priority onto
 * that channel. The ntfy Android client does exactly that for priority 5. So this
 * is not a fourth notification system for Wren — it is the one path that can wake
 * somebody up, used only where waking somebody up is the point.
 *
 * ── PRIVACY: TEXT ONLY, ALWAYS ────────────────────────────────────────────────
 * The message carries a time, a camera name and an instruction. It never carries
 * a snapshot, a clip, an attachment, a click-through to footage, or a child's or
 * parent's name. Footage stays inside Wren behind the §3 trigger, the 30-minute
 * cap and camera_access_log. A notification is a prompt to go and look through
 * the audited path, not a way around it.
 *
 * `publish()` therefore accepts a title and a body and nothing else. There is no
 * attachment parameter to pass by accident.
 *
 * ── CONFIGURATION (env, never the database, never a response body) ────────────
 *   NTFY_URL    e.g. http://your-server:8840   (no trailing slash needed)
 *   NTFY_TOPIC  the topic name
 *   NTFY_TOKEN  an access token for that topic (ntfy auth is deny-all by default)
 * Unset = not configured. That is a normal state and every caller handles it; the
 * server must start and the Security hub must render without any of these.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const TIMEOUT_MS = 8_000;
const MAX_PRIORITY = 5;

/** What is configured, with no secret in the answer. Safe to return to a browser. */
function config() {
  const url   = String(process.env.NTFY_URL   || '').trim().replace(/\/+$/, '');
  const topic = String(process.env.NTFY_TOPIC || '').trim();
  const token = String(process.env.NTFY_TOKEN || '').trim();
  return {
    configured: !!(url && topic),
    // The host is shown so Toby can tell which box is publishing. The topic is a
    // shared secret in ntfy's model when auth is off, so it is NOT returned.
    host: url ? safeHost(url) : null,
    has_token: !!token,
    // Named so a "not configured" card can say which piece is missing.
    missing: [!url && 'NTFY_URL', !topic && 'NTFY_TOPIC'].filter(Boolean),
  };
}

function safeHost(u) {
  try { return new URL(u).host; } catch { return null; }
}

function _post(urlStr, body, headers) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error(`bad NTFY_URL: ${e.message}`)); }
    const lib = u.protocol === 'https:' ? https : http;
    const buf = Buffer.from(body, 'utf8');
    const req = lib.request(u, {
      method: 'POST',
      timeout: TIMEOUT_MS,
      headers: { ...headers, 'Content-Length': buf.length },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks).toString('utf8').slice(0, 500) }));
    });
    req.on('timeout', () => req.destroy(new Error(`ntfy did not answer within ${TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    req.write(buf);
    req.end();
  });
}

/**
 * Send one notification. Never throws — a failed alert is a state to record, not
 * an exception that takes a poller down.
 *
 * @param {object} o
 * @param {string} o.title     short, shown as the notification title
 * @param {string} o.body      one or two plain sentences. No footage, no names.
 * @param {number} [o.priority=5]  1–5. 5 is what the DND-override channel listens for.
 * @param {string[]} [o.tags]  ntfy tag names (emoji shortcodes), cosmetic only
 * @returns {Promise<{ok:boolean, status?:number, error?:string, skipped?:string}>}
 */
async function publish({ title, body, priority = MAX_PRIORITY, tags = [] } = {}) {
  const cfg = config();
  if (!cfg.configured) return { ok: false, skipped: 'not_configured', error: `ntfy is not configured (missing ${cfg.missing.join(', ')})` };

  const url   = String(process.env.NTFY_URL).trim().replace(/\/+$/, '');
  const topic = String(process.env.NTFY_TOPIC).trim();
  const token = String(process.env.NTFY_TOKEN || '').trim();

  const prio = Math.min(Math.max(parseInt(priority, 10) || MAX_PRIORITY, 1), MAX_PRIORITY);
  // Header values must be latin-1 safe and single-line; ntfy reads the title from a
  // header, so strip anything that could split it.
  const hdrSafe = s => String(s || '').replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 120);

  const headers = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Title': hdrSafe(title) || 'Wren',
    'Priority': String(prio),
    ...(tags.length ? { 'Tags': tags.map(hdrSafe).filter(Boolean).join(',') } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  try {
    const res = await _post(`${url}/${encodeURIComponent(topic)}`, String(body || '').slice(0, 1000), headers);
    if (res.statusCode >= 200 && res.statusCode < 300) return { ok: true, status: res.statusCode };
    return { ok: false, status: res.statusCode, error: `ntfy replied HTTP ${res.statusCode}: ${res.body}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** Is the ntfy server there? A state for the hub to show, never an exception. */
async function reachable() {
  const cfg = config();
  if (!cfg.configured) return { ok: false, error: `not configured (missing ${cfg.missing.join(', ')})` };
  const url = String(process.env.NTFY_URL).trim().replace(/\/+$/, '');
  return new Promise((resolve) => {
    let u;
    try { u = new URL(`${url}/v1/health`); } catch (e) { return resolve({ ok: false, error: e.message }); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: 5_000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? { ok: true } : { ok: false, error: `HTTP ${res.statusCode}` });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timed out' }); });
    req.on('error', e => resolve({ ok: false, error: e.message }));
  });
}

module.exports = { config, publish, reachable, MAX_PRIORITY };
