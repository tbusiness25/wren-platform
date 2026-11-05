'use strict';
/**
 * cot-cam.js — 2026-11-02 — mounted at /api/cot-cam.
 *
 * The Baby Room "cot cam": a Reolink E1 Pro over the cots, so the Baby Room can
 * check sleeping babies from Nest (the EY tablets) at any time.
 *
 * ── THE ONE RULE THIS FILE EXISTS TO KEEP ──────────────────────────────────────
 * No CCTV leaves the nursery building (Toby, 2026-10-17). Wren runs on docker-work,
 * which is at Toby's HOUSE. So this router NEVER carries a video byte. The path is:
 *
 *     camera (192.168.1.x) ──RTSP──▶ Z420 go2rtc (inside Frigate, at the nursery)
 *                                     │
 *                     Caddy gateway on the Z420, LAN-only, HTTPS
 *                                     │  MSE over a websocket
 *                                     ▼
 *                               the EY tablet (nursery Wi-Fi)
 *
 * Wren serves the page, decides who may look, writes the access-log row, and mints a
 * 30-second single-use token. The gateway asks Wren "is this token good?" once, when
 * the websocket opens (forward_auth → GET /api/cot-cam/verify), and from then on the
 * bytes go Z420 → tablet without touching Wren. Two walls keep it in the building:
 * the token is only minted for a request from the nursery's public IP (_atNursery
 * below), and the gateway refuses clients outside 192.168.1.0/24. The second wall
 * alone is NOT enough — a Tailscale subnet route arrives SNATed to a LAN address.
 *
 * That is also why this is NOT a route in cameras.js: everything there proxies video
 * through Wren (GET /api/cameras/stream.mp4), and is gated to managers on Roost,
 * internal cameras out-of-hours only, with a §3 incident trigger. A sleep check is a
 * different purpose with a different audience. cameras.js refuses this camera
 * outright (cameras.lan_only) so it can never be pulled through the proxy path.
 *
 * ── WHAT IS SHARED WITH b234/b362 ───────────────────────────────────────────────
 *   • the camera is a row in ladn.cameras (key 'cot_cam', lan_only = true);
 *   • it must be in settings.cameras_in_service, or every session is refused (409)
 *     server-side and the refusal logged — the hidden tile is a courtesy;
 *   • every attempt, granted or refused, is a row in camera_access_log
 *     (action 'view_cot_cam', trigger_reason 'sleep_check'). Ids and reasons only.
 *
 * ── WHO MAY LOOK ────────────────────────────────────────────────────────────────
 * Manager tier (hasRole 'manager' — manager, deputy, admin, owner), or a member of
 * staff whose staff.room_id is the Baby Room, or a staff id listed in
 * settings.cotcam_extra_staff_ids (CSV — for floaters with no room). Everyone else
 * gets 403, logged.
 *
 * ── SETTINGS (per database) ─────────────────────────────────────────────────────
 *   cameras_in_service       CSV; must include 'cot_cam'
 *   cotcam_gateway_url       e.g. https://cotcam.example-nursery.co.uk:8443
 *                            (unset → the page says "not set up yet")
 *   cotcam_room_ids          CSV of rooms.id whose staff may look (default: the room
 *                            named 'Baby Room')
 *   cotcam_extra_staff_ids   CSV of staff ids
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth');

const CAMERA_KEY = 'cot_cam';
const TOKEN_TTL_MS = 30_000;
const PROFILES = new Set(['main', 'sub']);
const PORTALS = new Set(['learning', 'admin']);

// ── On-site, strictly ──────────────────────────────────────────────────────────
// Wren's general _isOnSite() (server-unified.js) also counts Tailscale and any
// 192.168.x address as "on site" — and docker-work itself now sits on Toby's home
// LAN. That is too loose here. Measured 2026-11-02: a request from docker-work reached
// the Z420 gateway over a Tailscale SUBNET ROUTE and arrived SNATed to a nursery LAN
// address (192.168.1.50), so the gateway's own LAN-only check cannot tell a tablet in
// the Baby Room from a phone at home. The token is therefore only minted for a request
// that reached Wren through Cloudflare FROM THE NURSERY'S PUBLIC IP. On a _dev database
// the check is skipped (and the bypass written into the log row) so dev can be tested.
const NURSERY_IP = process.env.NURSERY_PUBLIC_IP || '203.0.113.10';   // same default as server-unified.js
const DEV_DB = /_dev$/.test(String(process.env.PG_DB || ''));
function _atNursery(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim().replace('::ffff:', '');
  if (cf && cf === NURSERY_IP) return { ok: true, why: 'nursery public IP' };
  if (DEV_DB) return { ok: true, why: `DEV BYPASS of the nursery-IP check (client ${cf || 'no CF header'})` };
  return { ok: false, why: `client ${cf || 'not via Cloudflare'} is not the nursery's public IP` };
}

const _csv = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

async function _settings(db, keys) {
  const { rows } = await db.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [keys]);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Same precedence as cameras.js camerasInService(): settings → env → 'door'.
// Re-read every time (no cache) so switching the camera off takes effect at once.
async function _inService(db) {
  const s = await _settings(db, ['cameras_in_service']);
  let keys = _csv(s.cameras_in_service).map((k) => k.toLowerCase());
  if (!keys.length) keys = _csv(process.env.CAMERAS_IN_SERVICE).map((k) => k.toLowerCase());
  if (!keys.length) keys = ['door'];
  return keys.includes(CAMERA_KEY);
}

async function _camera(db) {
  const { rows } = await db.query(
    `SELECT id, key, name, enabled, COALESCE(lan_only, false) AS lan_only
       FROM cameras WHERE key = $1`, [CAMERA_KEY]);
  return rows[0] || null;
}

function _gatewayOrigin(url) {
  try {
    const u = new URL(String(url || '').trim());
    if (u.protocol !== 'https:') return null;   // tablets load Nest over https: ws:// is mixed content
    return u;
  } catch { return null; }
}

// Exported for the page route in server-unified.js (CSP connect-src).
async function gatewayWsOrigin(db) {
  const s = await _settings(db || getPool(), ['cotcam_gateway_url']);
  const u = _gatewayOrigin(s.cotcam_gateway_url);
  return u ? `wss://${u.host}` : null;
}

async function _mayView(db, user) {
  if (!user || user.id == null) return { ok: false, why: 'not signed in' };
  if (hasRole(user, 'manager')) return { ok: true, why: `manager tier (role=${user.role})` };
  const s = await _settings(db, ['cotcam_room_ids', 'cotcam_extra_staff_ids']);
  if (_csv(s.cotcam_extra_staff_ids).map(Number).includes(Number(user.id))) {
    return { ok: true, why: 'listed in cotcam_extra_staff_ids' };
  }
  let roomIds = _csv(s.cotcam_room_ids).map(Number).filter(Number.isFinite);
  if (!roomIds.length) {
    const { rows } = await db.query(`SELECT id FROM rooms WHERE lower(name) = 'baby room'`);
    roomIds = rows.map((r) => Number(r.id));
  }
  const { rows } = await db.query(`SELECT room_id FROM staff WHERE id = $1`, [user.id]);
  const roomId = rows[0] ? Number(rows[0].room_id) : null;
  if (roomId != null && roomIds.includes(roomId)) return { ok: true, why: `Baby Room staff (room_id=${roomId})` };
  return { ok: false, why: `not Baby Room staff (role=${user.role || 'none'}, room_id=${roomId == null ? 'none' : roomId})` };
}

async function _audit(req, { cameraId, granted, reason }) {
  const { rows } = await getPool().query(
    `INSERT INTO camera_access_log (staff_id, camera_id, action, granted, reason, ip, user_agent, trigger_reason)
     VALUES ($1, $2, 'view_cot_cam', $3, $4, $5, $6, 'sleep_check') RETURNING id`,
    [
      req.user?.id || null, cameraId || null, !!granted,
      String(reason || '').slice(0, 2000),
      String(req.ip || req.socket?.remoteAddress || '').slice(0, 64),
      String(req.headers['user-agent'] || '').slice(0, 1000),
    ]);
  return rows[0] && rows[0].id;
}

// token -> { staffId, cameraId, profile, logId, expires }
const _tokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _tokens) if (v.expires < now) _tokens.delete(k);
}, 60_000).unref?.();

// ── GET /api/cot-cam — what the page should show ──────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const cam = await _camera(db);
    const live = !!cam && cam.enabled && (await _inService(db));
    const may = await _mayView(db, req.user);
    const s = await _settings(db, ['cotcam_gateway_url']);
    const gw = _gatewayOrigin(s.cotcam_gateway_url);
    res.json({
      camera: cam ? { id: cam.id, name: cam.name } : null,
      in_service: live,
      may_view: may.ok,
      gateway_configured: !!gw,
      reason: !cam ? 'The cot cam is not registered.'
        : !live ? 'The cot cam is switched off in Wren.'
        : !may.ok ? 'The cot cam is for Baby Room staff and managers.'
        : !gw ? 'The cot cam is not set up yet (no LAN gateway address).'
        : null,
    });
  } catch (e) {
    console.error('[cot-cam] status failed:', e.message);
    res.status(500).json({ error: 'status_failed' });
  }
});

// ── POST /api/cot-cam/session — the authorisation point ──────────────────────
router.post('/session', authenticate, express.json({ limit: '2kb' }), async (req, res) => {
  const profile = PROFILES.has(String(req.body?.profile)) ? String(req.body.profile) : 'main';
  try {
    const db = getPool();
    const cam = await _camera(db);
    const refuse = async (status, error, message, logReason) => {
      try { await _audit(req, { cameraId: cam && cam.id, granted: false, reason: `REFUSED (${error}): ${logReason || message}` }); }
      catch (e) { console.error('[cot-cam] refusal audit failed:', e.message); }
      return res.status(status).json({ error, message });
    };
    if (req._portal && !PORTALS.has(req._portal)) {
      return refuse(403, 'forbidden_portal', 'The cot cam is on Nest (and Roost) only.', `portal=${req._portal}`);
    }
    if (!cam) return refuse(404, 'not_registered', 'The cot cam is not registered.');
    if (!(await _inService(db))) {
      return refuse(409, 'not_in_service', 'The cot cam is switched off in Wren.',
        `"${cam.name}" is not in settings.cameras_in_service`);
    }
    if (!cam.enabled) return refuse(409, 'camera_disabled', 'The cot cam is switched off in Wren.');
    const may = await _mayView(db, req.user);
    if (!may.ok) return refuse(403, 'forbidden_staff', 'The cot cam is for Baby Room staff and managers.', may.why);
    const here = _atNursery(req);
    if (!here.ok) return refuse(403, 'offsite', 'The cot cam only works on the nursery Wi-Fi.', here.why);
    const s = await _settings(db, ['cotcam_gateway_url']);
    const gw = _gatewayOrigin(s.cotcam_gateway_url);
    if (!gw) return refuse(503, 'no_gateway', 'The cot cam is not set up yet (no LAN gateway address).');

    // Log row first, token second: no token exists for a view that was not logged.
    const logId = await _audit(req, { cameraId: cam.id, granted: true, reason: `GRANTED: ${may.why}; ${here.why}; profile=${profile}` });
    if (!logId) throw new Error('access log row was not written');
    const token = crypto.randomBytes(24).toString('hex');
    _tokens.set(token, { staffId: req.user.id, cameraId: cam.id, profile, logId, expires: Date.now() + TOKEN_TTL_MS });
    res.json({
      ws_url: `wss://${gw.host}/ws/${profile}?t=${token}`,
      expires_in: TOKEN_TTL_MS / 1000,
      access_log_id: logId,
      profile,
    });
  } catch (e) {
    console.error('[cot-cam] session failed:', e.message);
    res.status(500).json({ error: 'session_failed' });
  }
});

// ── GET /api/cot-cam/verify — called by the Z420 gateway (Caddy forward_auth) ─
// No staff JWT: the token IS the credential (192 random bits, 30 s, single use).
// Exempt from the EY device gate in server-unified.js for that reason. Returns no
// body worth reading; 204 = open the websocket, anything else = refuse it.
// The gateway passes ?t=<token>&p=<profile path>. The profile must match the one the
// token was minted for, so a 'sub' token cannot open the main stream or vice versa.
router.get('/verify', async (req, res) => {
  const t = String(req.query.t || '');
  const p = String(req.query.p || '').replace(/^.*\//, '');   // '/ws/main' → 'main'
  const s = _tokens.get(t);
  _tokens.delete(t);                                          // single use, whatever happens
  if (!s || s.expires < Date.now()) return res.status(401).end();
  if (p && p !== s.profile) return res.status(401).end();
  try {
    // Re-check the switch at the moment of opening: a token minted a second before the
    // camera was taken out of service does not open it.
    const db = getPool();
    const cam = await _camera(db);
    if (!cam || !cam.enabled || cam.id !== s.cameraId || !(await _inService(db))) return res.status(409).end();
    res.setHeader('X-Cotcam-Log', String(s.logId));
    return res.status(204).end();
  } catch (e) {
    console.error('[cot-cam] verify failed:', e.message);
    return res.status(500).end();
  }
});

module.exports = router;
module.exports.gatewayWsOrigin = gatewayWsOrigin;
module.exports._test = { _mayView, _gatewayOrigin, _tokens, _atNursery };
