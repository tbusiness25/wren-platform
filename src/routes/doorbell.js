'use strict';
// Doorbell direct-Dahua control (b99, 2026-07-17).
//
// This is the *direct-to-VTO* path — distinct from src/routes/intercom.js, which
// releases the door via Home Assistant. Here we hit the door intercom accessControl
// CGI ourselves (HTTP Digest auth), so it works even without HA wired up.
//
// The VTO at DAHUA_IP is currently UNREACHABLE (wrong switch), so everything is
// config-driven with a graceful DRY-RUN fallback and NO live-device dependency:
//   • Live door-open is OFF unless DOORBELL_DOOR_OPEN_ENABLED=true AND creds set.
//   • When the device can't be reached, we log the press and report a dry-run.
//   • Every press (live or dry-run, success or fail) is audited to
//     ladn.doorbell_open_log.
//
// Routes (mounted at /api/doorbell — staff-auth):
//   POST /open      → open the door (or simulate). Body: { event_id? }
//   GET  /config    → non-secret config for the /ey/door page (never leaks creds)
//   GET  /snapshot  → live camera JPEG proxied from the VTO (503 when offline)
//
// Env (all optional; sensible dev defaults):
//   DAHUA_IP | DAHUA_HOST            VTO address            (default 192.0.2.10)
//   DAHUA_ADMIN_USER | DAHUA_USER    admin user             (default 'admin')
//   DAHUA_ADMIN_PASS | DAHUA_PASS    admin password         (no default → dry-run)
//   DOORBELL_DOOR_OPEN_ENABLED       'true' to allow live opens (default off/dry-run)
//   DAHUA_DOOR_CHANNEL               door channel           (default '0')
//   DAHUA_OPEN_PATH                  CGI override, supports ${channel}
//   DAHUA_SNAPSHOT_PATH              snapshot CGI           (default channel=1)
//   DAHUA_STREAM_URL                 browser-safe stream URL (go2rtc/webrtc), no creds
//   DAHUA_HTTP_TIMEOUT_MS            per-request timeout    (default 4000)

const express = require('express');
const http    = require('http');
const crypto  = require('crypto');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const router = express.Router();

// ── Config helpers ─────────────────────────────────────────────────────────────
const DAHUA_HOST     = () => process.env.DAHUA_IP || process.env.DAHUA_HOST || '192.0.2.10';
const DAHUA_USER     = () => process.env.DAHUA_ADMIN_USER || process.env.DAHUA_USER || 'admin';
const DAHUA_PASS     = () => process.env.DAHUA_ADMIN_PASS || process.env.DAHUA_PASS || '';
const DOOR_CHANNEL   = () => parseInt(process.env.DAHUA_DOOR_CHANNEL || '0', 10) || 0;
const HTTP_TIMEOUT   = () => parseInt(process.env.DAHUA_HTTP_TIMEOUT_MS || '4000', 10) || 4000;
const SNAPSHOT_PATH  = () => process.env.DAHUA_SNAPSHOT_PATH || '/cgi-bin/snapshot.cgi?channel=1';

// Live opens are allowed only when explicitly enabled AND a password is present.
function _liveEnabled() {
  return process.env.DOORBELL_DOOR_OPEN_ENABLED === 'true' && !!DAHUA_PASS();
}

function _openPath() {
  const ch = DOOR_CHANNEL();
  const tpl = process.env.DAHUA_OPEN_PATH;
  if (tpl) return tpl.replace(/\$\{channel\}/g, String(ch));
  // door intercom access-control open-door CGI (firmware-dependent; overridable above).
  return `/cgi-bin/accessControl.cgi?action=openDoor&channel=${ch}&Type=Remote`;
}

function _isStaff(user) { return user && user.role && user.role !== 'parent'; }
function _requireStaff(req, res, next) {
  if (!_isStaff(req.user)) return res.status(403).json({ error: 'Staff only' });
  next();
}

// b272 (2026-09-04) — Toby: "allow the door entry to be used by all up to
// practitioner (not apprentices)". _requireStaff above is `role !== 'parent'`,
// which let an apprentice open the door on THIS legacy b99 route while
// POST /api/door/open (b195) correctly refused them — verified on wren-ladn-dev
// before this build: apprentice got 403 there and 200 here, same token.
// The gate is applied to POST /open only. GET /config and GET /snapshot keep the
// staff-only gate they have always had: seeing who is at the door is not opening
// it, and the EY tablet shows that view to everyone on shift.
const { requireDoorRole } = require('../lib/door-roles');

// ── HTTP Digest client (door intercom requires Digest for accessControl) ────────────
function _parseDigest(header) {
  const out = {};
  const re = /(\w+)=(?:"([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(header)) !== null) out[m[1]] = (m[2] !== undefined ? m[2] : m[3]);
  return out;
}

function _md5(s) { return crypto.createHash('md5').update(s).digest('hex'); }

// Single GET that transparently answers a Digest 401 challenge. Resolves with
// { status, headers, body(Buffer) }; rejects on network error / timeout only.
function _dahuaGet(pathAndQuery, { binary = false } = {}) {
  const host = DAHUA_HOST();
  const user = DAHUA_USER();
  const pass = DAHUA_PASS();
  const uri  = pathAndQuery;
  const timeout = HTTP_TIMEOUT();

  const doRequest = (authHeader) => new Promise((resolve, reject) => {
    const req = http.request(
      { host, port: 80, method: 'GET', path: uri, timeout,
        headers: authHeader ? { Authorization: authHeader } : {} },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'),
        }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`timeout after ${timeout}ms`)); });
    req.end();
  });

  // First hit (unauthenticated). If challenged, answer the Digest and retry once.
  return doRequest(null).then((first) => {
    if (first.status !== 401) return first;
    const wwwAuth = first.headers['www-authenticate'] || '';
    if (!/digest/i.test(wwwAuth)) return first; // not digest → nothing more we can do
    const d = _parseDigest(wwwAuth);
    const nc = '00000001';
    const cnonce = crypto.randomBytes(8).toString('hex');
    const qop = (d.qop || '').split(',')[0].trim() || 'auth';
    const ha1 = _md5(`${user}:${d.realm}:${pass}`);
    const ha2 = _md5(`GET:${uri}`);
    const response = _md5(`${ha1}:${d.nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
    let auth = `Digest username="${user}", realm="${d.realm}", nonce="${d.nonce}", ` +
               `uri="${uri}", qop=${qop}, nc=${nc}, cnonce="${cnonce}", ` +
               `response="${response}", algorithm=${d.algorithm || 'MD5'}`;
    if (d.opaque) auth += `, opaque="${d.opaque}"`;
    return doRequest(auth);
  });
}

// ── Audit helper ────────────────────────────────────────────────────────────────
async function _audit(db, row) {
  try {
    const { rows } = await db.query(
      `INSERT INTO doorbell_open_log
         (event_id, staff_id, mode, success, http_status, dahua_action, channel, error, source_ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [row.event_id || null, row.staff_id || null, row.mode, !!row.success,
       row.http_status || null, row.dahua_action || null, row.channel,
       row.error || null, row.source_ip || null]
    );
    return rows[0].id;
  } catch (e) {
    console.error('[doorbell] audit insert failed:', e.message);
    return null;
  }
}

// ── POST /open — open the door (or simulate) ────────────────────────────────────
router.post('/open', authenticate, _requireStaff, requireDoorRole, express.json({ limit: '8kb' }), async (req, res) => {
  const db = getPool();
  const channel = DOOR_CHANNEL();
  const eventId = req.body && req.body.event_id ? parseInt(req.body.event_id, 10) : null;
  const sourceIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().slice(0, 64);

  // Validate optional event_id (soft — a press need not be tied to a live ring).
  let validEvent = null;
  if (eventId) {
    try {
      const { rows } = await db.query(`SELECT id FROM doorbell_events WHERE id=$1`, [eventId]);
      validEvent = rows.length ? eventId : null;
    } catch { validEvent = null; }
  }

  // DRY-RUN: live disabled/creds missing → never touch the network, just audit.
  if (!_liveEnabled()) {
    const logId = await _audit(db, {
      event_id: validEvent, staff_id: req.user.id, mode: 'dry_run', success: false,
      dahua_action: 'accessControl.openDoor', channel, source_ip: sourceIp,
      error: process.env.DOORBELL_DOOR_OPEN_ENABLED === 'true'
        ? 'no Dahua password configured' : 'live opens disabled (DOORBELL_DOOR_OPEN_ENABLED!=true)',
    });
    return res.json({
      ok: true, mode: 'dry_run', success: false, reachable: null, log_id: logId,
      message: 'Dry-run — door not physically opened (device not wired / live opens disabled). Press logged.',
    });
  }

  // LIVE: attempt the Dahua CGI.
  try {
    const result = await _dahuaGet(_openPath(), { binary: false });
    const ok2xx = result.status >= 200 && result.status < 300;
    // Dahua returns "OK" on success; some firmwares 200 with an error body.
    const bodyOk = /ok/i.test(String(result.body || '')) || ok2xx;
    const success = ok2xx && bodyOk;
    const logId = await _audit(db, {
      event_id: validEvent, staff_id: req.user.id, mode: 'live', success,
      http_status: result.status, dahua_action: 'accessControl.openDoor', channel,
      source_ip: sourceIp, error: success ? null : `HTTP ${result.status}: ${String(result.body).slice(0, 200)}`,
    });
    // On a real open tied to a ring, stamp the ring row like intercom release-door.
    if (success && validEvent) {
      await db.query(
        `UPDATE doorbell_events
           SET door_released=true, door_released_at=NOW(), door_released_by_staff_id=$1
         WHERE id=$2 AND door_released IS NOT TRUE`,
        [req.user.id, validEvent]
      ).catch(() => {});
    }
    return res.status(success ? 200 : 502).json({
      ok: success, mode: 'live', success, reachable: true, http_status: result.status, log_id: logId,
      message: success ? 'Door opened.' : `Device responded but did not confirm (HTTP ${result.status}).`,
    });
  } catch (e) {
    // Unreachable/timeout → treat as dry-run per spec (log, don't hard-fail).
    const logId = await _audit(db, {
      event_id: validEvent, staff_id: req.user.id, mode: 'dry_run', success: false,
      dahua_action: 'accessControl.openDoor', channel, source_ip: sourceIp,
      error: `unreachable: ${e.message}`,
    });
    return res.json({
      ok: true, mode: 'dry_run', success: false, reachable: false, log_id: logId,
      message: `Doorbell device unreachable (${e.message}) — press logged, door not opened.`,
    });
  }
});

// ── GET /config — non-secret config for /ey/door (NEVER leaks creds) ────────────
router.get('/config', authenticate, _requireStaff, (req, res) => {
  res.json({
    live: _liveEnabled(),                       // will a press actually open the door?
    dry_run: !_liveEnabled(),
    channel: DOOR_CHANNEL(),
    snapshot_url: '/api/doorbell/snapshot',     // server-proxied; safe to <img src>
    // Browser-safe stream URL only (go2rtc/webrtc). RTSP-with-creds is NEVER sent.
    stream_url: process.env.DAHUA_STREAM_URL || null,
    stream_available: !!process.env.DAHUA_STREAM_URL,
    device_configured: !!DAHUA_PASS(),
    host_hint: DAHUA_HOST(),                     // ip only, no creds
  });
});

// ── GET /snapshot — proxy a live JPEG from the VTO (503 when offline) ────────────
router.get('/snapshot', authenticate, _requireStaff, async (req, res) => {
  if (!DAHUA_PASS()) {
    return res.status(503).json({ error: 'camera_not_configured', message: 'Dahua credentials not set — snapshot unavailable.' });
  }
  try {
    const result = await _dahuaGet(SNAPSHOT_PATH(), { binary: true });
    if (result.status >= 200 && result.status < 300 && result.body && result.body.length) {
      res.setHeader('Content-Type', result.headers['content-type'] || 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      return res.end(result.body);
    }
    return res.status(502).json({ error: 'camera_error', http_status: result.status });
  } catch (e) {
    return res.status(503).json({ error: 'camera_unreachable', message: e.message });
  }
});

module.exports = { router };
