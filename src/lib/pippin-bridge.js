'use strict';
/**
 * pippin-bridge.js — b518 (2026-10-20)
 *
 * The HTTP client for the work→home bridge that reaches Toby's household app,
 * Pippin. Interface, codes and content rules: /app/ladn-ready/logs/pippin-bridge.NOTES.md
 *
 *   POST   /item        send one item   → 201 delivered, 200 duplicate
 *   GET    /item/:id    status          → open | done | dropped | removed | noted
 *   DELETE /item/:id    withdraw
 *
 * Auth is a bearer token that is NOT the /tell digest token. It is read, in order:
 *   1. process.env.PIPPIN_BRIDGE_TOKEN
 *   2. the file at process.env.PIPPIN_TOKEN_FILE
 *   3. /run/secrets/pippin-bridge-token   (a docker secret / bind mount)
 *   4. /app/.config/pippin-bridge/token  (the host path; only readable if mounted)
 * The token is never logged, never returned by any route, and never put in an error
 * message. With no token the whole feature reports "not connected" and sends nothing.
 *
 * The bridge accepts calls on its Tailscale address only, and only from docker-work
 * and Toby's desktop. A 403 here means the source address was not on that list —
 * surfaced to the sender as a configuration problem, not a content one.
 */

const fs = require('fs');

const BASE = process.env.PIPPIN_BRIDGE_URL || 'http://your-server:8920';
const TOKEN_FILES = [
  process.env.PIPPIN_TOKEN_FILE,
  '/run/secrets/pippin-bridge-token',
  '/app/.config/pippin-bridge/token',
].filter(Boolean);

let _tok = { at: 0, value: null };

function token() {
  if (process.env.PIPPIN_BRIDGE_TOKEN) return process.env.PIPPIN_BRIDGE_TOKEN.trim();
  if (_tok.value && Date.now() - _tok.at < 60_000) return _tok.value;
  for (const f of TOKEN_FILES) {
    try {
      const v = fs.readFileSync(f, 'utf8').trim();
      if (v) { _tok = { at: Date.now(), value: v }; return v; }
    } catch (_) { /* not there / not readable — try the next */ }
  }
  _tok = { at: Date.now(), value: null };
  return null;
}

/** isConfigured() — true when a token is in reach. Says nothing about the token itself. */
function isConfigured() { return !!token(); }

/** Where the token would come from, for the "not connected" panel. No value, ever. */
function configHint() {
  return {
    configured: isConfigured(),
    base: BASE,
    looked_in: ['env PIPPIN_BRIDGE_TOKEN'].concat(TOKEN_FILES.map(f => 'file ' + f)),
  };
}

async function call(method, path, body) {
  const t = token();
  if (!t) return { ok: false, status: 0, code: 'not_configured', error: 'The bridge to Pippin is not connected on this server.' };
  let r, text;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: Object.assign({ Authorization: 'Bearer ' + t }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    text = await r.text();
  } catch (e) {
    // Never let a token end up in a thrown message.
    return { ok: false, status: 0, code: 'unreachable', error: 'Could not reach the bridge: ' + String(e && e.message || e).replace(/Bearer\s+\S+/g, 'Bearer …') };
  }
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
  return { ok: r.ok, status: r.status, json, raw: json ? null : (text || '').slice(0, 300) };
}

/**
 * send(id, item) — POST /item.
 * returns { status: 'delivered'|'failed', duplicate, http, delivered_to, error, code }
 */
async function send(id, item) {
  const r = await call('POST', '/item', Object.assign({ id }, item));
  if (r.code) return { status: 'failed', http: 0, code: r.code, error: r.error };
  if (r.status === 201 || r.status === 200) {
    return {
      status: 'delivered',
      duplicate: !!(r.json && r.json.duplicate),
      http: r.status,
      delivered_to: (r.json && r.json.delivered_to) || null,
    };
  }
  const MSG = {
    400: 'The bridge rejected the shape of the item. Do not retry — tell Claude.',
    401: 'The bridge refused the token. Check the configuration.',
    403: 'The bridge refused this server’s address. Check the configuration.',
    409: 'That id was withdrawn at home. Send it again as a new item.',
    413: 'Too much text for the bridge.',
    422: 'The bridge’s own safety filter refused the content. Reword it at source.',
    429: 'The bridge’s hourly limit is reached. Try later.',
    502: 'Pippin could not be reached at home. Nothing was delivered — safe to try again.',
    503: 'Pippin could not be reached at home. Nothing was delivered — safe to try again.',
  };
  return {
    status: 'failed',
    http: r.status,
    code: 'http_' + r.status,
    retryable: r.status >= 500 || r.status === 429,
    error: (r.json && r.json.error) || MSG[r.status] || ('The bridge answered ' + r.status + '.'),
  };
}

/** status(id) — GET /item/:id → { found, home_status } */
async function status(id) {
  const r = await call('GET', '/item/' + encodeURIComponent(id));
  if (r.code) return { found: false, code: r.code, error: r.error };
  if (r.status === 404) return { found: false, code: 'gone' };
  if (!r.ok) return { found: false, code: 'http_' + r.status };
  const s = r.json && (r.json.status || r.json.state);
  return { found: true, home_status: s || null };
}

/** withdraw(id) — DELETE /item/:id */
async function withdraw(id) {
  const r = await call('DELETE', '/item/' + encodeURIComponent(id));
  if (r.code) return { ok: false, code: r.code, error: r.error };
  if (r.status === 404) return { ok: true, code: 'already_gone' };
  if (!r.ok) return { ok: false, code: 'http_' + r.status, error: (r.json && r.json.error) || null };
  return { ok: true };
}

module.exports = { send, status, withdraw, isConfigured, configHint, BASE };
