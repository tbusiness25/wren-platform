'use strict';
/* ===========================================================================
 * clock-devices.js — b310 (2026-09-10)
 *
 * Who is allowed to write a timesheet, and which way their taps count.
 *
 * POST /api/clockin/dahua-webhook is PUBLIC AND UNAUTHENTICATED — the door intercom
 * cannot send a JWT, and CLAUDE.md documents the endpoint as such. That is fine
 * for a doorbell relay and NOT fine for the record that decides what people are
 * paid. So the gate is moved from "who is calling" to "which reader is this":
 *
 *   resolve(body, req)  → a ladn.clock_devices row, or null
 *   null ⇒ 403, nothing written, nothing logged beyond the device id.
 *
 * MATCH ORDER
 *   1. an explicit device id in the payload (Dahua sends SN / DeviceID / MachineName)
 *   2. a door-name alias (the VTO on the gate sends DoorName: "Main Entrance")
 *   3. the source IP (the VTO is 192.0.2.10 on the nursery LAN)
 * First match wins. Inactive rows never match — deactivating a reader in Roost is
 * how a stolen or replaced reader is taken out of service, and it must take effect
 * without a deploy.
 *
 * FOB IDS ARE CREDENTIALS
 * A Mifare Classic 1K UID is all you need to clone the fob. It is stored ONCE, in
 * ladn.staff_fobs, because that table IS the registry of which card belongs to
 * whom. Everywhere else — every clock event, every log line, every audit blob —
 * carries hashFob(uid) instead, and maskFob(uid) is what a human is shown.
 *
 * RATE LIMITING
 * In-memory, per device and global. The webhook is on the public internet path,
 * so an unbounded POST loop from a compromised reader could otherwise write
 * thousands of rows into an employment record. Deliberately NOT in the DB: a rate
 * limiter that needs a round-trip to decide whether to allow a round-trip is not
 * a rate limiter, and wren-ladn is a single process (same reasoning as
 * src/lib/fob-enrol.js).
 * ===========================================================================*/

const crypto = require('crypto');

// ── Credential handling ──────────────────────────────────────────────────────

/**
 * The salt. FOB_HASH_SALT if set; JWT_SECRET otherwise, because it is present in
 * every environment Wren runs in and is never rotated casually. The hash only has
 * to be stable and unguessable — it is never used as a lookup key against an
 * external system.
 */
function _salt() {
  return process.env.FOB_HASH_SALT || process.env.JWT_SECRET || 'wren-fob-unsalted';
}

/** sha256(salt || uid) as 64 lowercase hex. This is what goes in the events table. */
function hashFob(uid) {
  const u = String(uid || '').toUpperCase().trim();
  if (!u) return null;
  return crypto.createHash('sha256').update(_salt() + '|' + u).digest('hex');
}

/**
 * What a human is shown: '••••C3D4'. Enough to tell two fobs on a keyring apart,
 * not enough to clone one. Used in Telegram alerts and on screen.
 */
function maskFob(uid) {
  const u = String(uid || '').toUpperCase().trim();
  if (!u) return '—';
  return u.length <= 4 ? '•'.repeat(u.length) : '••••' + u.slice(-4);
}

/**
 * Strip card numbers out of a payload before it is stored as audit meta.
 * The Dahua body arrives with CardNo in it and used to be written verbatim into
 * staff_clock_events.source_raw — an audit column is exactly where a credential
 * must not be. Keys are matched case-insensitively, at every depth.
 */
const CARD_KEY = /^(cardno|card_no|cardnumber|card_number|rfid|uid|fob_uid|cardid|card_id)$/i;
function scrubRaw(obj, depth = 0) {
  if (obj == null || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map(v => scrubRaw(v, depth + 1));
  if (typeof obj !== 'object') return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (CARD_KEY.test(k)) { out[k] = '[redacted]'; continue; }
    out[k] = (v && typeof v === 'object') ? scrubRaw(v, depth + 1) : v;
  }
  return out;
}

// ── Device resolution ────────────────────────────────────────────────────────

/** Pull a device id out of whatever the reader called the field. */
function deviceIdFrom(body) {
  if (!body || typeof body !== 'object') return null;
  const v = body.device_id || body.deviceId || body.DeviceID || body.DeviceId
         || body.SN || body.sn || body.SerialNumber || body.serial
         || body.MachineName || body.machine_name || body.ReaderID || body.reader_id;
  const s = String(v || '').trim();
  return s ? s.slice(0, 120) : null;
}

/** Pull the door/reader name out of whatever the reader called the field. */
function doorNameFrom(body) {
  if (!body || typeof body !== 'object') return null;
  const v = body.DoorName || body.door_name || body.doorName || body.Door || body.door
         || body.Location || body.location;
  const s = String(v || '').trim();
  return s ? s.slice(0, 120) : null;
}

/** The caller's IP, through nginx / Cloudflare. */
function clientIp(req) {
  if (!req) return null;
  const ip = (req.headers?.['cf-connecting-ip'] || '').trim()
    || (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.ip || '').replace('::ffff:', '').trim();
  return ip || null;
}

/**
 * Find the device this tap came from.
 * @returns {{device: object|null, matched_on: string|null, tried: object}}
 */
async function resolve(db, body, req) {
  const wantId   = deviceIdFrom(body);
  const wantDoor = doorNameFrom(body);
  const ip       = clientIp(req);
  const tried    = { device_id: wantId, door_name: wantDoor, ip };

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT id, device_id, label, direction, location, kind, aliases, ip_allow, is_active
         FROM clock_devices WHERE is_active = true`
    ));
  } catch (e) {
    // Table missing (a demo schema, or the migration has not run here). Fail
    // CLOSED — an unauthenticated endpoint must not become open because a table
    // is absent.
    if (e.code === '42P01') return { device: null, matched_on: null, tried, reason: 'clock_devices table missing' };
    throw e;
  }

  if (wantId) {
    const hit = rows.find(r => r.device_id.toLowerCase() === wantId.toLowerCase());
    if (hit) return { device: hit, matched_on: 'device_id', tried };
  }
  if (wantDoor) {
    const want = wantDoor.toLowerCase();
    const hit = rows.find(r => (r.aliases || []).some(a => String(a).trim().toLowerCase() === want)
                            || r.device_id.toLowerCase() === want
                            || String(r.label).trim().toLowerCase() === want);
    if (hit) return { device: hit, matched_on: 'door_name', tried };
  }
  if (ip) {
    const hit = rows.find(r => (r.ip_allow || []).some(a => String(a).trim() === ip));
    if (hit) return { device: hit, matched_on: 'ip', tried };
  }
  return { device: null, matched_on: null, tried, reason: 'no active clock_devices row matches' };
}

/**
 * Which way does a tap on this device count?
 * 'in' / 'out' are fixed by the reader — that is the whole design. 'both' falls
 * back to the pre-b310 toggle, which is what a single-reader setting has to do.
 */
function directionFor(device) {
  const d = String(device?.direction || 'both').toLowerCase();
  return (d === 'in' || d === 'out') ? d : 'both';
}

// ── Rate limiting ────────────────────────────────────────────────────────────
// Fixed windows, cheap and predictable. Numbers are sized for a nursery: 18 staff,
// two readers, a busy minute at 8am is maybe 10 taps.
const LIMITS = {
  perDevicePerMin: 40,     // one reader
  globalPerMin: 120,       // everything
  unknownPerIpPerMin: 10,  // a caller that has not matched a device yet
};
const _buckets = new Map();   // key -> { windowStart, count }

function _take(key, limit) {
  const now = Date.now();
  const win = Math.floor(now / 60000);
  const b = _buckets.get(key);
  if (!b || b.win !== win) { _buckets.set(key, { win, count: 1 }); return true; }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}

/** Housekeeping so the map cannot grow without bound. */
function _sweep() {
  const win = Math.floor(Date.now() / 60000);
  for (const [k, b] of _buckets) if (b.win < win - 2) _buckets.delete(k);
}

/**
 * @returns {{ok:true}|{ok:false, scope:string}}
 */
function rateLimit({ deviceId, ip }) {
  if (_buckets.size > 500) _sweep();
  if (!_take('global', LIMITS.globalPerMin)) return { ok: false, scope: 'global' };
  if (deviceId) {
    if (!_take('dev:' + deviceId.toLowerCase(), LIMITS.perDevicePerMin)) return { ok: false, scope: 'device' };
  } else if (ip) {
    if (!_take('unk:' + ip, LIMITS.unknownPerIpPerMin)) return { ok: false, scope: 'unknown_ip' };
  }
  return { ok: true };
}

// ── Recent refusals, for the setup screen ────────────────────────────────────
// A ring buffer, not a table. A refused tap is a CONFIGURATION problem — the
// reader is calling itself something Wren has not been told about — and the
// person fixing it is stood at the reader watching Roost. It is deliberately not
// persisted: it holds no staff identity, needs no retention policy, and a restart
// clearing it is correct behaviour.
const _refusals = [];
function noteRefusal(entry) {
  _refusals.unshift({ ...entry, at: new Date().toISOString() });
  if (_refusals.length > 40) _refusals.length = 40;
}
function recentRefusals() { return _refusals.slice(); }

module.exports = {
  hashFob, maskFob, scrubRaw,
  deviceIdFrom, doorNameFrom, clientIp,
  resolve, directionFor,
  rateLimit, LIMITS,
  noteRefusal, recentRefusals,
};
