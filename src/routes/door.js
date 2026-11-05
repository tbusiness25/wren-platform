'use strict';
/**
 * Door console API (b195, 2026-08-19) — mounted at /api/door.
 *
 * Staff answer the front door from the EY tablet or Roost instead of walking to the
 * entrance: see who is there, check the lock state, release the door, and have every
 * release logged.
 *
 * RELATIONSHIP TO EXISTING ROUTES (read before adding anything here):
 *   • src/routes/doorbell.js (b99)  — direct-Dahua open, mounted at /api/doorbell.
 *     Left untouched and still mounted. Its security model is weaker than b195 needs
 *     (any non-parent role, no on-site gate, audit written AFTER the open), which is
 *     exactly why this router exists rather than being bolted onto it.
 *   • src/routes/intercom.js        — Home Assistant release path + ring WS, /api/intercom.
 *   Consolidating the three is a follow-up for a Claude review pass (see NOTES).
 *
 * SECURITY MODEL for POST /open — a physical door at a nursery:
 *   1. authenticated staff JWT                       (authenticate middleware)
 *   2. role ∈ {manager, room_leader, practitioner}   (deputy/senior/headteacher mapped in)
 *   3. request originates ON-SITE                    (same test as src/routes/clockin.js)
 *   4. an audit row is written to ladn.door_events BEFORE the device is touched
 *   5. live release only when DOOR_OPEN_ENABLED=true — otherwise a logged dry-run
 *
 * GDPR: the doorway camera captures children, parents and passers-by. Snapshots written
 * for a door_events row are CCTV under ladn.retention_policies.door_station_stills
 * (31 days, per the CCTV DPIA's 2026-08-19 entrance-door addendum).
 * ⚠️ b249 moved this OFF the cctv_footage row, which is now SEVEN days — that row
 * is the indoor NVR footage (CCTV Policy v1.1 §4) and always was. The door station
 * is a different camera with its own, separately assessed period: single stills on
 * a door event, no continuous recording, no audio.
 * They are stored on disk OUTSIDE the DB (DOOR_SNAP_DIR) and swept by the existing
 * governance job (scripts/governance-archive.sh door_snapshot_sweep) — no new cron.
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const router  = express.Router();

const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth');
const dahua        = require('../lib/dahua-client');

let _notify = null;
try { _notify = require('../services/notification-dispatcher').notify; } catch { _notify = null; }

// Snapshots live beside the b99 doorbell snapshots but in their own dir so the
// retention sweep can target b195 CCTV stills without touching anything else.
const SNAP_DIR = process.env.DOOR_SNAP_DIR || '/app/data/door-snapshots';

// Roles allowed to release the door. Kept deliberately explicit — everything not
// listed here (parents, chef, kitchen, read-only/office roles) is refused.
//
// b272 (2026-09-04) — this list MOVED to src/lib/door-roles.js. It is unchanged
// in content (practitioner and above; apprentice refused), but door.js was not
// the only router that can open this door: doorbell.js and intercom.js each had
// their own, weaker `role !== 'parent'` gate, so an apprentice refused here was
// let straight through there. All three now import the one list.
// OPEN_ROLES stays as a local alias so the rest of this file is untouched.
const { DOOR_OPEN_ROLES, canOperateDoor } = require('../lib/door-roles');
const OPEN_ROLES = DOOR_OPEN_ROLES;

// ── On-site guard ─────────────────────────────────────────────────────────────
// Same test as src/routes/clockin.js _clockinIsOnSite: nursery WAN IP, loopback,
// RFC1918, or the Tailscale 100.64/10 CGNAT range. A door release must never be
// possible from the open internet, even with a valid staff token.
const _nurseryIp = () => process.env.NURSERY_PUBLIC_IP;
function _clientIp(req) {
  return (req.headers['cf-connecting-ip'] || '').trim()
    || (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || (req.ip || '').replace('::ffff:', '').trim();
}
function _isOnSite(req) {
  const ip = _clientIp(req);
  if (!ip) return false;
  if (ip === _nurseryIp()) return true;
  if (/^127\./.test(ip) || ip === '::1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  const m = ip.match(/^100\.(\d+)\./);
  if (m && +m[1] >= 64 && +m[1] <= 127) return true;
  return false;
}

function _requireStaff(req, res, next) {
  if (!req.user || !req.user.role || req.user.role === 'parent') {
    return res.status(403).json({ error: 'staff_only', message: 'Staff only.' });
  }
  next();
}
function _requireOnSite(req, res, next) {
  if (!_isOnSite(req)) {
    return res.status(403).json({
      error: 'off_site',
      message: 'The door can only be operated from the nursery network.',
    });
  }
  next();
}

// Machine callers (the dahua-bridge container) use the documented internal token.
function _isInternal(req) {
  const t = req.headers['x-wren-internal'] || '';
  return !!t && !!process.env.WREN_INTERNAL_TOKEN && t === process.env.WREN_INTERNAL_TOKEN;
}

// ── door_events helpers ───────────────────────────────────────────────────────
async function logDoorEvent(db, { event_type, staff_id, card_no, reason, snapshot_path }) {
  try {
    const { rows } = await db.query(
      `INSERT INTO door_events (event_type, staff_id, card_no, reason, snapshot_path)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, created_at`,
      [event_type, staff_id || null, card_no || null, reason || null, snapshot_path || null]
    );
    return rows[0];
  } catch (e) {
    console.error('[door] audit insert failed:', e.message);
    return null;
  }
}

/** Grab a still and write it to disk for a door_events row. Never throws. */
async function captureSnapshotFor(eventId) {
  if (!dahua.isConfigured()) return null;
  try {
    const { buffer } = await dahua.getSnapshot();
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const p = path.join(SNAP_DIR, `${eventId}.jpg`);
    fs.writeFileSync(p, buffer);
    return p;
  } catch (e) {
    console.warn(`[door] snapshot capture for event ${eventId} failed:`, e.message);
    return null;
  }
}

// ── GET /config — non-secret config for the Door card (NEVER leaks creds) ──────
router.get('/config', authenticate, _requireStaff, (req, res) => {
  res.json({
    device_configured: dahua.isConfigured(),
    cred_source: dahua.credSource(),          // 'env' | 'secrets-file' | 'none' — no value
    live_open: dahua.liveOpenEnabled(),       // will a press physically open the door?
    dry_run: !dahua.liveOpenEnabled(),
    on_site: _isOnSite(req),
    // b272 — canOperateDoor() also honours the deny list and auth.js's
    // headteacher role rewrite; OPEN_ROLES.has() alone did neither.
    can_open: canOperateDoor(req.user) && _isOnSite(req),
    role: req.user.role,
    channel: dahua.doorChannel(),
    snapshot_url: '/api/door/snapshot',       // server-proxied; creds stay server-side
    // Browser-safe stream only (go2rtc WebRTC/MSE). An RTSP URL with credentials in it
    // is NEVER sent to a browser.
    // Stage 2: the page asks for a ticket, then plays /api/door/stream.mp4?t=…
    // A raw go2rtc URL is NEVER handed to a browser (it would expose the camera
    // credentials via that service's own /api/streams).
    stream_available: !!process.env.DOOR_STREAM_ENABLED,
    stream_ticket_url: process.env.DOOR_STREAM_ENABLED ? '/api/door/stream-ticket' : null,
    host_hint: dahua.host(),
  });
});

// ── GET /snapshot — live JPEG proxied from the VTO ────────────────────────────
// On-site staff only: this is a live camera pointed at a nursery doorway.
router.get('/snapshot', authenticate, _requireStaff, _requireOnSite, async (req, res) => {
  if (!dahua.isConfigured()) {
    return res.status(503).json({
      error: 'camera_not_configured',
      message: 'Door camera credentials not available — snapshot unavailable.',
    });
  }
  try {
    const { buffer, contentType } = await dahua.getSnapshot();
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store, private');
    return res.end(buffer);
  } catch (e) {
    const code = e.httpStatus ? 502 : 503;
    return res.status(code).json({ error: 'camera_unreachable', message: e.message });
  }
});

// ── GET /status — door lock state ─────────────────────────────────────────────
router.get('/status', authenticate, _requireStaff, async (req, res) => {
  if (!dahua.isConfigured()) {
    return res.json({ ok: false, status: 'unknown', reachable: null,
                      message: 'Door device credentials not available.' });
  }
  try {
    const s = await dahua.getDoorStatus();
    return res.json({
      ok: true, status: s.status, raw: s.raw, reachable: true,
      http_status: s.http_status, live_open: dahua.liveOpenEnabled(),
    });
  } catch (e) {
    return res.status(503).json({ ok: false, status: 'unknown', reachable: false, message: e.message });
  }
});

// ── POST /open — RELEASE THE DOOR ─────────────────────────────────────────────
// The sensitive one. Auth + role + on-site, audited BEFORE the device is touched.
router.post('/open', authenticate, _requireStaff, express.json({ limit: '8kb' }), async (req, res) => {
  const db = getPool();
  const staffId = req.user.id;
  const ip = _clientIp(req);

  // Refusals are audited too — a denied attempt is exactly what an entry log is for.
  if (!canOperateDoor(req.user)) {   // b272 — shared gate, see src/lib/door-roles.js
    await logDoorEvent(db, {
      event_type: 'denied', staff_id: staffId,
      reason: `role '${req.user.role}' not permitted to release the door (ip ${ip})`,
    });
    return res.status(403).json({ error: 'role_not_permitted',
      message: 'Your role cannot release the front door.' });
  }
  if (!_isOnSite(req)) {
    await logDoorEvent(db, {
      event_type: 'denied', staff_id: staffId,
      reason: `off-site door release refused (ip ${ip})`,
    });
    return res.status(403).json({ error: 'off_site',
      message: 'The door can only be released from the nursery network.' });
  }

  const note = (req.body && typeof req.body.reason === 'string')
    ? req.body.reason.slice(0, 300) : null;

  // 1. AUDIT FIRST — the row exists before the lock is touched, so a release can never
  //    happen without a log line even if the device call or this process dies mid-call.
  const evt = await logDoorEvent(db, {
    event_type: 'open', staff_id: staffId,
    reason: `release requested from ${ip}${note ? ` — ${note}` : ''}`,
  });
  const eventId = evt && evt.id;

  // 2. Snapshot the doorway at the moment of release (best-effort, never blocks).
  if (eventId) {
    captureSnapshotFor(eventId).then(p => {
      if (p) db.query(`UPDATE door_events SET snapshot_path=$1 WHERE id=$2`, [p, eventId]).catch(() => {});
    });
  }

  // 3. DRY-RUN unless explicitly enabled. This is the path dev and CI take — the real
  //    door is never fired by a test.
  if (!dahua.liveOpenEnabled()) {
    const why = dahua.isConfigured()
      ? 'live opens disabled (DOOR_OPEN_ENABLED!=true)'
      : 'no door credentials available';
    if (eventId) {
      await db.query(`UPDATE door_events SET reason = reason || $1 WHERE id=$2`,
        [` — DRY-RUN, door NOT opened (${why})`, eventId]).catch(() => {});
    }
    return res.json({
      ok: true, mode: 'dry_run', success: false, event_id: eventId,
      message: 'Dry-run — door not physically opened. The request was logged.',
    });
  }

  // 4. LIVE release.
  try {
    const r = await dahua.openDoor();
    if (eventId) {
      await db.query(`UPDATE door_events SET reason = reason || $1 WHERE id=$2`,
        [r.success ? ' — door released (live)' : ` — device did not confirm (HTTP ${r.http_status})`,
         eventId]).catch(() => {});
    }
    return res.status(r.success ? 200 : 502).json({
      ok: r.success, mode: 'live', success: r.success, event_id: eventId,
      http_status: r.http_status,
      message: r.success ? 'Door opened.'
                         : `Device responded but did not confirm (HTTP ${r.http_status}).`,
    });
  } catch (e) {
    if (eventId) {
      await db.query(`UPDATE door_events SET reason = reason || $1 WHERE id=$2`,
        [` — device unreachable: ${e.message}`, eventId]).catch(() => {});
    }
    return res.status(503).json({
      ok: false, mode: 'live', success: false, event_id: eventId,
      message: `Door device unreachable (${e.message}) — request logged, door not opened.`,
    });
  }
});

// ── POST /ring — a doorbell press, from the dahua-bridge container ────────────
// Machine-authenticated (x-wren-internal) OR on-site, never open to the internet.
// Writes a 'ring' door_events row, grabs a snapshot, and raises the in-app notification.
router.post('/ring', express.json({ limit: '16kb' }), async (req, res) => {
  if (!_isInternal(req) && !_isOnSite(req)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const db = getPool();
  const b = req.body || {};
  const isCard = !!(b.card_no || b.CardNo);
  const cardNo = (b.card_no || b.CardNo || '').toString().toUpperCase().trim().slice(0, 64) || null;

  try {
    const evt = await logDoorEvent(db, {
      event_type: isCard ? 'card' : 'ring',
      card_no: cardNo,
      reason: `${isCard ? 'card presented' : 'doorbell pressed'} at ${b.door_name || 'Main Entrance'}` +
              `${b.source ? ` (${b.source})` : ''}`,
    });
    if (!evt) return res.status(500).json({ error: 'log_failed' });

    // Snapshot the caller. Best-effort — a missing still must never lose the ring.
    const snapPath = await captureSnapshotFor(evt.id);
    if (snapPath) {
      await db.query(`UPDATE door_events SET snapshot_path=$1 WHERE id=$2`, [snapPath, evt.id]).catch(() => {});
    }

    // Raise the in-app notification (inapp + telegram + webpush per staff prefs).
    // Card swipes are staff arriving on their own fob — no need to call the room.
    if (!isCard && _notify) {
      _notify(
        'doorbell_pressed', 'all-staff', null,
        'Someone is at the front door',
        'Tap to see the doorway camera and let them in.',
        { priority: 'urgent', relatedTable: 'door_events', relatedId: evt.id, link: '/ey/door' }
      );
    }
    return res.json({ ok: true, event_id: evt.id, snapshot: !!snapPath, notified: !isCard });
  } catch (e) {
    console.error('[door] ring handler failed:', e.message);
    return res.status(500).json({ error: 'ring_failed', message: e.message });
  }
});

// ── Stage 2: live video, proxied ──────────────────────────────────────────────
// go2rtc's own API (:1984) is deliberately loopback-only: GET /api/streams echoes
// each source URL verbatim, which for an RTSP camera means the VTO admin password in
// plaintext. So the browser never talks to go2rtc — it comes through here instead.
//
// A <video> element cannot send an Authorization header, so we mint a short-lived
// single-purpose TICKET rather than putting the staff JWT in a URL (URLs land in
// history, logs and referrers; a 60s door-camera ticket does far less damage).
// 2026-10-05: editions/ladn/.env still says http://172.31.0.1:1984 (the bridge gateway), which
// times out from inside the container (b362). Ignore that known-dead value; the container name works.
const GO2RTC = (process.env.GO2RTC_URL && !/172\.31\.0\.1/.test(process.env.GO2RTC_URL)) ? process.env.GO2RTC_URL : 'http://wren-go2rtc:1984';
const STREAM_SRC = process.env.GO2RTC_STREAM || 'door_sub';   // sub-stream: kinder to tablet wifi
const TICKET_TTL_MS = 60_000;
const _tickets = new Map();                                   // ticket -> { staffId, expires }

function _mintTicket(staffId) {
  const t = require('crypto').randomBytes(24).toString('hex');
  _tickets.set(t, { staffId, expires: Date.now() + TICKET_TTL_MS });
  return t;
}
function _checkTicket(t) {
  const e = _tickets.get(t);
  if (!e) return null;
  if (e.expires < Date.now()) { _tickets.delete(t); return null; }
  return e;
}
// Sweep expired tickets so the map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _tickets) if (v.expires < now) _tickets.delete(k);
}, 60_000).unref?.();

router.get('/stream-ticket', authenticate, _requireStaff, _requireOnSite, (req, res) => {
  if (!process.env.DOOR_STREAM_ENABLED) {
    return res.status(503).json({ error: 'stream_disabled',
      message: 'Live video is not enabled on this instance.' });
  }
  const ticket = _mintTicket(req.user.id);
  res.json({ ticket, expires_in: TICKET_TTL_MS / 1000, url: `/api/door/stream.mp4?t=${ticket}` });
});

// Live fMP4 (MSE) straight into a <video> tag. Ticket + on-site, never public.
router.get('/stream.mp4', _requireOnSite, (req, res) => {
  if (!process.env.DOOR_STREAM_ENABLED) return res.status(503).end();
  if (!_checkTicket(String(req.query.t || ''))) {
    return res.status(403).json({ error: 'bad_ticket' });
  }
  const url = `${GO2RTC}/api/stream.mp4?src=${encodeURIComponent(STREAM_SRC)}`;
  const up = require('http').get(url, { timeout: 8000 }, (r) => {
    res.writeHead(r.statusCode, {
      'Content-Type': r.headers['content-type'] || 'video/mp4',
      'Cache-Control': 'no-store, private',
    });
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('upstream_timeout')));   // 2026-10-05
  up.on('error', (e) => {
    console.warn('[door] stream proxy failed:', e.message);
    if (!res.headersSent) res.status(503).json({ error: 'stream_unavailable', message: e.message });
  });
  // Tear the upstream pull down as soon as the viewer goes away, so a closed tablet
  // does not leave go2rtc pulling RTSP for a consumer that no longer exists.
  res.on('close', () => up.destroy());
});

// ── GET /events — recent door activity for the console ────────────────────────
// b199 added the filters (?type=&days=&q=&unassigned=1). They are all optional and a
// bare GET behaves exactly as it did in b195, so the existing EY/Roost console pages
// are unaffected.
router.get('/events', authenticate, _requireStaff, async (req, res) => {
  const db = getPool();
  const limit = Math.min(parseInt(req.query.limit, 10) || 25, 200);
  const where = [], vals = [];

  // ?type=ring,open — restricted to the values door_events_type_chk permits, so a
  // junk filter narrows to nothing rather than reaching the query as free text.
  const ALLOWED = ['ring', 'open', 'denied', 'card'];
  const types = String(req.query.type || '').split(',').map(t => t.trim()).filter(t => ALLOWED.includes(t));
  if (types.length) { vals.push(types); where.push(`de.event_type = ANY($${vals.length})`); }

  const days = parseInt(req.query.days, 10);
  if (Number.isFinite(days) && days > 0) {
    vals.push(String(Math.min(days, 365)));
    where.push(`de.created_at >= NOW() - ($${vals.length} || ' days')::interval`);
  }

  // Free text over the reason, the card number and the staff name — one box that
  // answers both "who came in" and "what is this card".
  if (req.query.q) {
    vals.push(`%${String(req.query.q).slice(0, 60)}%`);
    const i = vals.length;
    where.push(`(de.reason ILIKE $${i} OR de.card_no ILIKE $${i}
                 OR (s.first_name || ' ' || s.last_name) ILIKE $${i})`);
  }

  // Swipes from a card nobody owns — the ones worth chasing.
  if (req.query.unassigned === '1') {
    where.push(`de.event_type = 'card' AND de.staff_id IS NULL`);
  }

  // 29 Oct: 'door' is on HR_ALLOW, and this list gave every member of staff each colleague's
  // arrival history and full fob number (enough to clock them in via /api/clockin/event).
  // Outside the managers, the only caller is the shell's doorbell icon (?type=ring&limit=1).
  const doorManager = hasRole(req.user, 'manager', 'deputy_manager', 'admin', 'owner', 'headteacher');
  if (!doorManager) where.push(`de.event_type = 'ring'`);

  vals.push(limit);
  try {
    const { rows } = await db.query(
      `SELECT de.id, de.event_type, de.staff_id, de.card_no, de.reason,
              (de.snapshot_path IS NOT NULL) AS has_snapshot, de.created_at,
              s.first_name, s.last_name,
              EXISTS (SELECT 1 FROM staff_fobs sf
                       WHERE UPPER(sf.fob_uid) = UPPER(de.card_no) AND sf.is_active = true) AS card_assigned
         FROM door_events de
         LEFT JOIN staff s ON s.id = de.staff_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY de.created_at DESC
        LIMIT $${vals.length}`, vals);
    res.json(rows.map(r => ({
      id: r.id, event_type: r.event_type, reason: r.reason,
      card_no: doorManager ? r.card_no : null, has_snapshot: r.has_snapshot, created_at: r.created_at,
      staff_name: doorManager && r.first_name ? `${r.first_name} ${r.last_name}` : null,
      // Lets the Roost log put an "Assign this fob" action beside an orphan swipe.
      card_assigned: r.card_no ? r.card_assigned : null,
      snapshot_url: r.has_snapshot ? `/api/door/events/${r.id}/snapshot` : null,
    })));
  } catch (e) {
    res.status(500).json({ error: 'events_failed', message: e.message });
  }
});

// ── GET /events/:id/snapshot — a stored CCTV still ────────────────────────────
// On-site staff only, and only while the still is inside its 31-day CCTV retention.
router.get('/events/:id/snapshot', authenticate, _requireStaff, _requireOnSite, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  try {
    const { rows } = await db.query(
      `SELECT snapshot_path FROM door_events WHERE id=$1`, [id]);
    const p = rows.length ? rows[0].snapshot_path : null;
    if (!p) return res.status(404).json({ error: 'no_snapshot' });
    // Confine reads to the snapshot dir — never serve an arbitrary path from the row.
    const resolved = path.resolve(p);
    if (!resolved.startsWith(path.resolve(SNAP_DIR) + path.sep)) {
      return res.status(403).json({ error: 'outside_snapshot_root' });
    }
    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'snapshot_expired',
        message: 'Still no longer held (CCTV retention is 31 days).' });
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'no-store, private');
    fs.createReadStream(resolved).pipe(res);
  } catch (e) {
    res.status(500).json({ error: 'snapshot_failed', message: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// b199 — FOB / ACCESS MANAGEMENT (Roost, manager-only)
// ═══════════════════════════════════════════════════════════════════════════════
// b195 gave staff the door. This gives Toby the keyring: which fobs exist, who holds
// them, and — the part that actually matters — a fob that Wren says is revoked is a
// fob the VTO no longer accepts. The two stores drift the moment they are written
// independently, so every write here touches BOTH or reports that it did not.
//
// ATOMICITY, and why it is not symmetric:
//   ADD    — device first, then Wren. A device refusal leaves no Wren row at all
//            (nothing to clean up). A Wren failure after a successful device write
//            rolls the device card back by RecNo, so no orphan card can open the door
//            with nobody's name against it.
//   REVOKE — device first, then Wren. If the device removal fails we stop and change
//            nothing: Wren must not claim a fob is dead while it still opens the door.
//            If the DB update fails AFTER the card is off the device we do NOT put the
//            card back — the card is already dead, which is the safe direction — and
//            we say so plainly so the stale Wren row gets retried.
//
// The device half is a no-op unless DOOR_CARD_WRITE_ENABLED=true, exactly like
// DOOR_OPEN_ENABLED guards the release. Dev and CI take the dry-run path and every
// response carries `device.dry_run` so nobody mistakes a dry-run for a real enrolment.
//
// ─────────────────────────────────────────────────────────────────────────────
// b250 (2026-09-01) — WHAT CHANGED AND WHY
//
// b199 built the two-way write. b250 closes the three gaps that made it possible
// for Wren to show a fob state that was not true of the actual door:
//
//   1. READ-BACK VERIFICATION. b199 trusted `RecNo=<n>` from the insert and marked
//      the Wren row active. b250 re-reads the card table by CardNo and only marks a
//      fob active when the device confirms it is there. A dry-run (card writes off)
//      no longer produces an "active" fob at all — it produces an honest
//      `device_state='not_on_device'` row that nothing claims will open the door.
//
//   2. PENDING REMOVAL. b199 refused a revoke it could not push to the device and
//      changed nothing — safe, but it left no record that a revoke had been ASKED
//      for, so a lost fob could be forgotten after one failed click. b250 records
//      the request (`revoke_requested_at`), leaves `is_active` TRUE because the card
//      genuinely still opens the door, parks the row in `device_state='pending_removal'`
//      where the screen shows it in red, and retries — by hand from the UI and on a
//      timer (`_startRemovalSweeper`). is_active is never flipped on an unconfirmed
//      removal: Wren must not call a live fob dead.
//
//   3. CAPABILITY GATING. b199's gate was a hard-coded role set, so the Permissions
//      screen listed nothing for door access and Toby could not delegate it. It is
//      now `staff.access-fobs` (b237), registered in src/lib/capability-routes.js so
//      the matrix reports it as enforced. Default is still manager-only: with no
//      role_capabilities row, only manager/headteacher/id=1 resolve to 'manage'.
//
// ⚠️ WHAT WE DELIBERATELY DO NOT GATE ON: the device's `IsValid` flag. It reads back
// false for every card and cannot be set on this firmware — proven twice, see the
// probe notes in src/lib/dahua-client.js. Gating on it would refuse every enrolment
// the device is capable of. It is recorded (`device_is_valid`) and shown, never acted
// on. The only real proof a fob opens the door is a swipe arriving at
// /api/clockin/dahua-webhook, which is why the keyring shows "last swipe".
// ─────────────────────────────────────────────────────────────────────────────

const { recordAudit } = require('../utils/audit');
const fobEnrol        = require('../lib/fob-enrol');
const { requireCapability, requireCapabilityLevel } = require('../lib/capabilities');

// b250 — the keyring is gated on the permissions matrix, not on a hard-coded role
// list. Reads take any grant; anything that touches the physical door demands
// 'manage'. requireCapability() intentionally ignores level (b237 semantics), so a
// write MUST use requireCapabilityLevel or a 'view' grant would open it.
const FOB_CAP     = 'staff.access-fobs';
const fobViewGate = requireCapability(FOB_CAP);
const fobMngGate  = requireCapabilityLevel(FOB_CAP, 'manage');

// b199's hard-coded MANAGE_ROLES set and its _requireManager middleware are GONE,
// replaced by the two gates above. Keeping both would have been worse than either:
// the role set silently overrode the matrix, so granting a room leader
// `staff.access-fobs` on the Permissions screen would have changed nothing and the
// screen would have been lying about a door. One gate, and it is the one the
// Permissions screen shows. The default is unchanged in practice — with no
// role_capabilities row seeded, only manager / headteacher / Toby (id=1) resolve to
// 'manage' (see capabilityLevel in src/lib/capabilities.js), so this stays
// manager-only until Toby deliberately widens it.

// Normalising here means the value stored in staff_fobs, the value sent to the VTO and
// the value handleFobEvent matches on are all the same string — a mismatch is the
// classic reason an enrolled fob silently never works.
//
// Alphanumerics are kept rather than hex only: Mifare UIDs are hex, but Dahua readers
// can report a decimal card number, and stripping anything outside [0-9A-F] would
// quietly mangle those. handleFobEvent does an uppercase+trim, so this stays a superset
// of what it will match on.
function _normUid(v) {
  return String(v || '').toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 32);
}

// ── b250 device-state vocabulary ─────────────────────────────────────────────
// Stored on ladn.staff_fobs.device_state. See the migration for the full contract.
//   unverified      nothing has ever been read back for this row
//   on_device       READ BACK from the VTO and present  → the only state that may be active
//   not_on_device   read back and absent                → drift; will not open the door
//   pending_removal revoke asked for, device would not confirm → STILL OPENS THE DOOR
//   removed         read back after a removal and confirmed gone
const DEVICE_STATES = ['unverified', 'on_device', 'not_on_device', 'pending_removal', 'removed'];

/**
 * Write the device half of a fob row. Every device outcome lands here so a row can
 * never end up active with no evidence behind it — `is_active` is only ever set true
 * by passing state 'on_device', which callers only reach after a successful read-back.
 */
async function _setDeviceState(db, id, { state, recno, is_valid, result, active }) {
  if (!DEVICE_STATES.includes(state)) throw new Error(`bad device_state ${state}`);
  const sets = [`device_state = $2`, `device_last_result = $3`, `device_synced_at = NOW()`];
  const vals = [id, state, String(result || '').slice(0, 500)];
  if (recno !== undefined)    { vals.push(recno);    sets.push(`device_recno = $${vals.length}`); }
  if (is_valid !== undefined) { vals.push(is_valid); sets.push(`device_is_valid = $${vals.length}`); }
  if (active !== undefined)   { vals.push(active);   sets.push(`is_active = $${vals.length}`);
                                sets.push(active ? `deactivated_at = NULL` : `deactivated_at = COALESCE(deactivated_at, NOW())`); }
  const { rows } = await db.query(
    `UPDATE staff_fobs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
  return rows[0];
}

/**
 * Is the door station in contact RIGHT NOW? Every management screen leads with this,
 * because a stale card list rendered as if it were live is the quiet failure this
 * whole module exists to avoid. Never throws.
 */
async function _deviceContact() {
  if (!dahua.isConfigured()) {
    return { reachable: false, reason: 'no device credentials', host: dahua.host(), checked_at: new Date().toISOString() };
  }
  try {
    const count = await dahua.cardCount();
    return { reachable: count !== null, count,
             reason: count === null ? 'device did not report a card count' : null,
             host: dahua.host(), checked_at: new Date().toISOString() };
  } catch (e) {
    return { reachable: false, count: null, reason: e.message,
             host: dahua.host(), checked_at: new Date().toISOString() };
  }
}

/** Non-fatal device probe: never let an unreachable VTO 500 a management page. */
async function _deviceCardsSafe() {
  if (!dahua.isConfigured()) {
    return { reachable: false, cards: [], count: null, reason: 'no device credentials' };
  }
  try {
    const cards = await dahua.listCards({ count: 500 });
    return { reachable: true, cards, count: cards.length, reason: null };
  } catch (e) {
    return { reachable: false, cards: [], count: null, reason: e.message };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// b250 — THE REMOVAL ENGINE, and the retry that stops a lost fob being forgotten
// ═══════════════════════════════════════════════════════════════════════════════
// One function does every revoke: the button, the retry button, and the sweeper.
// There is exactly one place that decides "this card is off the door", and it only
// ever decides that after re-reading the card table and not finding it.
//
// Return shape is deliberately not an exception: callers need to tell "the door said
// no" apart from "we could not reach the door", and both from "confirmed gone".
//   { outcome: 'removed' | 'pending', reason, recno }

/**
 * Take a card off the VTO and PROVE it is gone.
 * @returns {Promise<{outcome:'removed'|'pending', reason:string, recno:number|null}>}
 */
async function _removeCardVerified(uid) {
  if (!dahua.isConfigured()) {
    return { outcome: 'pending', recno: null,
             reason: 'no door-device credentials — the card cannot be removed from the door' };
  }
  if (!dahua.cardWriteEnabled()) {
    // Card writes are switched off, so we cannot remove anything. We CAN still find
    // out the truth: if the card is not on the device, access really is revoked and
    // saying so is honest rather than optimistic.
    try {
      const present = await dahua.findCard(uid);
      return present
        ? { outcome: 'pending', recno: present.recno,
            reason: 'DOOR_CARD_WRITE_ENABLED is not true — the card is still enrolled on the door and STILL OPENS IT' }
        : { outcome: 'removed', recno: null,
            reason: 'card writes are disabled, but the card is not on the door device — access is already revoked' };
    } catch (e) {
      return { outcome: 'pending', recno: null,
               reason: `card writes are disabled and the door device could not be reached (${e.message})` };
    }
  }

  // RecNo is the device's own row number and shifts as other cards are removed, so
  // it is re-resolved here rather than trusted from the stored column.
  let card;
  try { card = await dahua.findCard(uid); }
  catch (e) { return { outcome: 'pending', recno: null, reason: `door device unreachable (${e.message})` }; }
  if (!card) return { outcome: 'removed', recno: null, reason: 'card was already not on the door device' };

  let rm;
  try { rm = await dahua.removeCard(card.recno); }
  catch (e) { return { outcome: 'pending', recno: card.recno, reason: `door device unreachable during removal (${e.message})` }; }
  if (!rm.ok) {
    return { outcome: 'pending', recno: card.recno,
             reason: `the door device refused the removal (${rm.raw || 'no detail'})` };
  }

  // "OK" from the device is not proof. Re-read and confirm.
  try {
    const still = await dahua.findCard(uid);
    if (still) {
      return { outcome: 'pending', recno: still.recno,
               reason: 'the device reported OK but the card is STILL in its card table — removal not confirmed' };
    }
  } catch (e) {
    return { outcome: 'pending', recno: card.recno,
             reason: `removal was accepted but could not be confirmed — the device became unreachable (${e.message})` };
  }
  return { outcome: 'removed', recno: null, reason: 'removed from the door device and confirmed gone on re-read' };
}

/** Park a fob in pending_removal. is_active stays TRUE — the card still works. */
async function _markPendingRemoval(db, fob, reason, actorId) {
  const { rows } = await db.query(
    `UPDATE staff_fobs
        SET device_state         = 'pending_removal',
            revoke_requested_at  = COALESCE(revoke_requested_at, NOW()),
            revoke_requested_by  = COALESCE(revoke_requested_by, $2),
            revoke_attempts      = COALESCE(revoke_attempts, 0) + 1,
            revoke_last_error    = $3,
            device_last_result   = $3,
            device_synced_at     = NOW()
      WHERE id = $1
      RETURNING *`,
    [fob.id, actorId || null, String(reason || '').slice(0, 500)]);
  _startRemovalSweeper();
  return rows[0];
}

/** Confirmed off the door: now, and only now, may Wren call the fob dead. */
async function _markRemoved(db, fobId, reason) {
  const { rows } = await db.query(
    `UPDATE staff_fobs
        SET is_active          = false,
            deactivated_at     = COALESCE(deactivated_at, NOW()),
            device_state       = 'removed',
            device_recno       = NULL,
            device_last_result = $2,
            revoke_last_error  = NULL,
            device_synced_at   = NOW()
      WHERE id = $1
      RETURNING *`,
    [fobId, String(reason || '').slice(0, 500)]);
  return rows[0];
}

// ── The sweeper ──────────────────────────────────────────────────────────────
// A revoke that failed once must not sit there until somebody notices. This retries
// pending_removal rows on a timer, ONE AT A TIME (no bulk operation ever touches this
// device), and stops itself the moment the queue is empty — so on a normal day it is
// not running at all. It only ever calls removeCard for a row a manager has already
// asked to revoke; it can neither enrol a card nor open the door.
const SWEEP_MS = Math.max(parseInt(process.env.DOOR_FOB_RETRY_MS || '300000', 10) || 300000, 30000);
let _sweepTimer = null;

async function _sweepPendingRemovals() {
  const db = getPool();
  let pending;
  try {
    const { rows } = await db.query(
      `SELECT id, fob_uid, staff_id FROM staff_fobs
        WHERE device_state = 'pending_removal'
        ORDER BY revoke_requested_at NULLS LAST
        LIMIT 5`);
    pending = rows;
  } catch (e) {
    console.error('[b250] pending-removal sweep query failed:', e.message);
    return;
  }
  if (!pending.length) {                       // queue empty — stand down
    if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
    return;
  }
  for (const fob of pending) {
    try {
      const r = await _removeCardVerified(_normUid(fob.fob_uid));
      if (r.outcome === 'removed') {
        await _markRemoved(db, fob.id, `retry succeeded — ${r.reason}`);
        await logDoorEvent(db, {
          event_type: 'card', staff_id: fob.staff_id, card_no: _normUid(fob.fob_uid),
          reason: `pending fob removal retried automatically and succeeded — ${r.reason}`,
        });
        console.log(`[b250] pending removal cleared for fob #${fob.id}`);
      } else {
        await db.query(
          `UPDATE staff_fobs SET revoke_attempts = COALESCE(revoke_attempts,0) + 1,
                                 revoke_last_error = $2, device_synced_at = NOW()
            WHERE id = $1`, [fob.id, String(r.reason).slice(0, 500)]);
      }
    } catch (e) {
      console.error(`[b250] pending-removal retry for fob #${fob.id} failed:`, e.message);
    }
  }
}

/** Idempotent. Started when a row enters pending_removal, and at boot if any exist. */
function _startRemovalSweeper() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => { _sweepPendingRemovals().catch(() => {}); }, SWEEP_MS);
  if (_sweepTimer.unref) _sweepTimer.unref();   // never hold the process open
}

// At boot, pick up anything left pending by a previous run — a lost fob outliving a
// restart is exactly the case this must not miss. Delayed so it cannot slow startup.
setTimeout(() => {
  getPool().query(`SELECT 1 FROM staff_fobs WHERE device_state = 'pending_removal' LIMIT 1`)
    .then(r => { if (r.rows.length) { console.log('[b250] pending fob removals found at boot — sweeper armed'); _startRemovalSweeper(); } })
    .catch(() => {});
}, 20000).unref?.();


// ── GET /fobs — the keyring ───────────────────────────────────────────────────
// Returns Wren's rows AND what the device holds, plus the drift between them, because
// "registered in Wren" and "will open the door" are different facts and Toby needs both.
router.get('/fobs', authenticate, _requireStaff, fobViewGate, async (req, res) => {
  const db = getPool();
  const withDevice = req.query.device !== '0';
  try {
    // last_swipe comes from door_events, not a column on staff_fobs: the swipe hot
    // path in clockin.js already writes that row, and a fob that has opened the door
    // is the ONLY hard evidence the enrolment worked (the device's own IsValid flag
    // is unsettable on this firmware — see the header note). No extra write, and it
    // survives the fob being reassigned because it is keyed on the card number.
    //
    // The reason filter is NOT cosmetic. door_events 'card' rows are both real taps
    // and the management rows written a few lines below when a fob is issued or
    // revoked. Without it, issuing a fob made it show "last swipe: just now" — the
    // screen would have claimed a brand-new fob had already been used at the door.
    const { rows } = await db.query(`
      SELECT sf.id, sf.fob_uid, sf.label, sf.is_active, sf.registered_at, sf.deactivated_at,
             sf.staff_id, sf.device_recno, sf.device_state, sf.device_synced_at,
             sf.device_last_result, sf.device_is_valid, sf.revoke_requested_at,
             sf.revoke_attempts, sf.revoke_last_error, sf.issued_by,
             s.first_name, s.last_name, s.role, s.is_active AS staff_active,
             iss.first_name AS issued_by_first, iss.last_name AS issued_by_last,
             sw.last_swipe, sw.swipes
        FROM staff_fobs sf
        LEFT JOIN staff s   ON s.id = sf.staff_id
        LEFT JOIN staff iss ON iss.id = sf.issued_by
        LEFT JOIN LATERAL (
              SELECT MAX(de.created_at) AS last_swipe, COUNT(*)::int AS swipes
                FROM door_events de
               WHERE de.event_type = 'card'
                 AND UPPER(de.card_no) = UPPER(sf.fob_uid)
                 AND de.reason ILIKE $1
             ) sw ON true
       ORDER BY sf.is_active DESC, s.first_name NULLS LAST, sf.registered_at DESC
    `, [fobEnrol.SWIPE_SQL_PATTERN]);
    const device = withDevice ? await _deviceCardsSafe()
                              : { reachable: null, cards: [], count: null, reason: 'skipped' };
    const onDevice = new Map(device.cards.map(c => [c.card_no, c]));

    const fobs = rows.map(r => {
      const card = onDevice.get(_normUid(r.fob_uid)) || null;
      return {
        id: r.id, fob_uid: r.fob_uid, label: r.label,
        is_active: r.is_active, registered_at: r.registered_at, deactivated_at: r.deactivated_at,
        staff_id: r.staff_id,
        staff_name: r.first_name ? `${r.first_name} ${r.last_name}` : null,
        staff_role: r.role, staff_active: r.staff_active,
        issued_by_name: r.issued_by_first ? `${r.issued_by_first} ${r.issued_by_last}` : null,
        // What Wren last managed to establish about the door station…
        device_state: r.device_state || 'unverified',
        device_synced_at: r.device_synced_at,
        device_last_result: r.device_last_result,
        device_is_valid: r.device_is_valid,
        revoke_requested_at: r.revoke_requested_at,
        revoke_attempts: r.revoke_attempts || 0,
        revoke_last_error: r.revoke_last_error,
        // …and what it says RIGHT NOW. null when we could not ask, never a guess.
        on_device: device.reachable ? !!card : null,
        device_recno: card ? card.recno : r.device_recno,
        device_reports_valid: card ? card.is_valid : null,
        last_swipe: r.last_swipe, swipes: r.swipes || 0,
        // The state that bites: active in Wren but absent from the door, or revoked in
        // Wren but still enrolled on the door (that second one still opens it).
        drift: !device.reachable ? null
             : (r.device_state === 'pending_removal' && card) ? 'pending_removal'
             : (r.is_active && !card) ? 'missing_on_device'
             : (!r.is_active && card) ? 'still_on_device'
             : null,
      };
    });

    // Cards enrolled on the VTO that Wren has never heard of — someone else's fob,
    // or a leftover from before Wren managed the door. Assignable from the UI.
    const known = new Set(rows.map(r => _normUid(r.fob_uid)));
    const orphanCards = device.cards.filter(c => c.card_no && !known.has(c.card_no));

    res.json({
      fobs,
      device: {
        reachable: device.reachable, count: device.count, reason: device.reason,
        write_enabled: dahua.cardWriteEnabled(),
        dry_run: !dahua.cardWriteEnabled(),
        host: dahua.host(),
        checked_at: new Date().toISOString(),
        // Read by the UI to caption the IsValid column honestly rather than as an alarm.
        validity_dates_supported: false,
      },
      orphan_cards: orphanCards,
      pending_removals: fobs.filter(f => f.device_state === 'pending_removal').length,
    });
  } catch (e) {
    res.status(500).json({ error: 'fobs_failed', message: e.message });
  }
});

// ── GET /fobs/reconcile — the two-sided diff, stated plainly ──────────────────
// "Registered in Wren" and "will open the door" are different facts. This is the
// screen that says which rows disagree, in both directions, and refuses to guess
// when the device is out of contact: an unreachable VTO returns reachable:false and
// EMPTY lists, never a stale list dressed up as current.
router.get('/fobs/reconcile', authenticate, _requireStaff, fobViewGate, async (req, res) => {
  const db = getPool();
  try {
    const device = await _deviceCardsSafe();
    const { rows } = await db.query(`
      SELECT sf.id, sf.fob_uid, sf.label, sf.is_active, sf.device_state,
             sf.revoke_requested_at, sf.revoke_attempts, sf.revoke_last_error,
             sf.staff_id, s.first_name, s.last_name
        FROM staff_fobs sf LEFT JOIN staff s ON s.id = sf.staff_id
       ORDER BY sf.is_active DESC, sf.registered_at DESC`);

    if (!device.reachable) {
      return res.json({
        reachable: false, reason: device.reason, host: dahua.host(),
        checked_at: new Date().toISOString(),
        wren_rows: rows.length,
        in_step: null, only_in_wren: [], only_on_device: [], live_but_should_be_revoked: [],
        message: 'Wren is not in contact with the door station, so nothing here can be ' +
                 'reconciled. The list below is deliberately empty rather than showing ' +
                 'you the last thing we saw as if it were current.',
      });
    }

    const onDevice = new Map(device.cards.map(c => [c.card_no, c]));
    const name = r => (r.first_name ? `${r.first_name} ${r.last_name}` : 'unassigned');

    // Wren says this fob is live, the door has never heard of it → it will not work.
    const onlyInWren = rows
      .filter(r => r.is_active && !onDevice.has(_normUid(r.fob_uid)))
      .map(r => ({ id: r.id, fob_uid: r.fob_uid, label: r.label, staff_name: name(r),
                   device_state: r.device_state,
                   consequence: 'This fob will NOT open the door — it is not on the door station.' }));

    // The dangerous direction: Wren says revoked (or is trying to), the door still holds it.
    const liveButRevoked = rows
      .filter(r => (!r.is_active || r.device_state === 'pending_removal') && onDevice.has(_normUid(r.fob_uid)))
      .map(r => ({ id: r.id, fob_uid: r.fob_uid, label: r.label, staff_name: name(r),
                   device_state: r.device_state,
                   revoke_requested_at: r.revoke_requested_at,
                   revoke_attempts: r.revoke_attempts || 0,
                   revoke_last_error: r.revoke_last_error,
                   device_recno: (onDevice.get(_normUid(r.fob_uid)) || {}).recno || null,
                   consequence: 'This fob STILL OPENS THE DOOR. Remove it here or on the Dahua UI.' }));

    // On the door, unknown to Wren — nobody in Wren is accountable for it.
    const known = new Set(rows.map(r => _normUid(r.fob_uid)));
    const onlyOnDevice = device.cards
      .filter(c => c.card_no && !known.has(c.card_no))
      .map(c => ({ card_no: c.card_no, recno: c.recno, card_name: c.card_name,
                   consequence: 'This card opens the door and Wren does not know whose it is.' }));

    res.json({
      reachable: true, host: dahua.host(), checked_at: new Date().toISOString(),
      device_count: device.count, wren_rows: rows.length,
      in_step: onlyInWren.length === 0 && onlyOnDevice.length === 0 && liveButRevoked.length === 0,
      only_in_wren: onlyInWren,
      only_on_device: onlyOnDevice,
      live_but_should_be_revoked: liveButRevoked,
    });
  } catch (e) {
    res.status(500).json({ error: 'reconcile_failed', message: e.message });
  }
});

// ── GET /fobs/unassigned — card numbers seen at the reader with no owner ───────
// Fed by the door_events rows b199 writes for every unmatched swipe (clockin.js
// handleFobEvent). This is what turns "a fob was tapped and nothing happened" into
// a row Toby can assign.
router.get('/fobs/unassigned', authenticate, _requireStaff, fobViewGate, async (req, res) => {
  const db = getPool();
  const days = Math.min(parseInt(req.query.days, 10) || 30, 365);
  try {
    const { rows } = await db.query(`
      SELECT de.card_no,
             COUNT(*)::int   AS times_seen,
             MAX(de.created_at) AS last_seen,
             MIN(de.created_at) AS first_seen
        FROM door_events de
       WHERE de.event_type = 'card'
         AND de.card_no IS NOT NULL
         AND de.staff_id IS NULL
         AND de.created_at >= NOW() - ($1 || ' days')::interval
         AND NOT EXISTS (
               SELECT 1 FROM staff_fobs sf
                WHERE UPPER(sf.fob_uid) = UPPER(de.card_no) AND sf.is_active = true)
       GROUP BY de.card_no
       ORDER BY MAX(de.created_at) DESC
       LIMIT 50
    `, [days]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'unassigned_failed', message: e.message });
  }
});

// ── The enrolment half of the two-way write, with the read-back ───────────────
// Never resolves `present: true` on the strength of the insert's own "RecNo=<n>".
// It re-reads the card table and finds the card there, or it does not claim it.
//
// Outcome flags are mutually exclusive and the caller must handle all of them:
//   unreachable  we never got an answer — the fob must NOT be saved as working
//   refused      the device answered no (or accepted then did not hold the card)
//   dry_run      card writes are switched off, so nothing was attempted
//   present      confirmed on the device by a subsequent read
async function _enrolCardVerified(uid, cardName, staffId) {
  if (!dahua.isConfigured()) {
    return { present: false, unreachable: true, reason: 'no door-device credentials are configured' };
  }
  let existing;
  try { existing = await dahua.findCard(uid); }
  catch (e) { return { present: false, unreachable: true, reason: `door device unreachable (${e.message})` }; }
  if (existing) {
    return { present: true, recno: existing.recno, is_valid: existing.is_valid,
             reason: 'the card was already enrolled on the door device (confirmed by read-back)' };
  }
  if (!dahua.cardWriteEnabled()) {
    return { present: false, dry_run: true,
             reason: 'DRY-RUN — DOOR_CARD_WRITE_ENABLED is not true, so nothing was written to the door device' };
  }

  let ins;
  try { ins = await dahua.insertCard({ card_no: uid, card_name: cardName, user_id: staffId }); }
  catch (e) { return { present: false, unreachable: true, reason: `door device unreachable during enrolment (${e.message})` }; }
  if (!ins.ok) {
    return { present: false, refused: true, wrote_recno: ins.recno || null,
             reason: `the door device refused the card (${ins.raw || 'no detail'})` };
  }

  // THE VERIFICATION. Everything above this line is the device's own account of
  // itself; only this re-read is evidence.
  let back;
  try { back = await dahua.findCard(uid); }
  catch (e) {
    return { present: false, unreachable: true, wrote_recno: ins.recno || null,
             reason: `the card was written but could not be confirmed — the device became unreachable (${e.message})` };
  }
  if (!back) {
    return { present: false, refused: true, wrote_recno: ins.recno || null,
             reason: 'the device accepted the card but it is not in the card table on re-read' };
  }
  return { present: true, recno: back.recno, is_valid: back.is_valid,
           reason: 'written to the door device and confirmed present on read-back' };
}

/**
 * Shared by POST /fobs and POST /fobs/:id/replace. Returns { http, body } rather
 * than writing the response, so "replace" can decide what to do with a failure.
 *
 * INVARIANT, and it is the whole point of this function:
 *   is_active = true is only ever written when `device.present` is true, which is
 *   only ever set by a successful read-back from the VTO.
 */
async function _issueFob(db, req, { uid, staffId, label, wantDevice }) {
  const { rows: staffRows } = await db.query(
    `SELECT id, first_name, last_name FROM staff WHERE id=$1`, [staffId]);
  if (!staffRows.length) return { http: 404, body: { error: 'staff_not_found' } };
  const staff = staffRows[0];
  const staffName = `${staff.first_name} ${staff.last_name}`;

  // Already held by someone else? Refuse rather than silently re-point it — an
  // access record that quietly changes owner is exactly what an entry log is for.
  const { rows: clash } = await db.query(
    `SELECT sf.id, sf.staff_id, sf.is_active, s.first_name, s.last_name
       FROM staff_fobs sf LEFT JOIN staff s ON s.id = sf.staff_id
      WHERE UPPER(sf.fob_uid) = $1`, [uid]);
  if (clash.length && clash[0].is_active && clash[0].staff_id !== staffId) {
    return { http: 409, body: {
      error: 'fob_in_use',
      message: `That card is already assigned to ${clash[0].first_name || 'another staff member'} ${clash[0].last_name || ''}`.trim() +
               ' — deactivate it there first.' } };
  }

  // ── 1. DEVICE FIRST, AND VERIFIED ────────────────────────────────────────
  let device;
  if (wantDevice) {
    device = await _enrolCardVerified(uid, staffName, staffId);
  } else {
    // device_write:false — the card was enrolled by hand on the Dahua UI. We do not
    // write, but we still READ: the manual route is not an excuse to skip the proof.
    try {
      const card = await dahua.findCard(uid);
      device = card
        ? { present: true, recno: card.recno, is_valid: card.is_valid, manual: true,
            reason: 'recorded from a manual Dahua-UI enrolment and confirmed on the device' }
        : { present: false, manual: true, not_found: true,
            reason: 'recorded without writing to the device, and the card is NOT on the door station' };
    } catch (e) {
      device = { present: false, manual: true, unreachable: true,
                 reason: `recorded without writing to the device, which could not be reached to confirm (${e.message})` };
    }
  }

  // A device we could not reach, or that said no, saves NOTHING. There is no
  // half-enrolled fob and nothing to clean up later.
  if (wantDevice && (device.unreachable || device.refused)) {
    let rolledBack = null;
    if (device.wrote_recno) {
      try { rolledBack = (await dahua.removeCard(device.wrote_recno)).ok; } catch { rolledBack = false; }
    }
    return { http: 502, body: {
      error: device.unreachable ? 'device_unreachable' : 'device_refused',
      message: `Nothing was saved — ${device.reason}.` +
        (rolledBack === true  ? ' The partially written card was removed from the door again.' :
         rolledBack === false ? ' ⚠️ A card MAY still be on the door station — check the Dahua UI.' : '') +
        (device.unreachable ? ' Fix the connection, or enrol the card on the Dahua UI and record it here with device_write:false.' : ''),
      device } };
  }

  // ── 2. THEN WREN ─────────────────────────────────────────────────────────
  const active      = !!device.present;                          // the invariant
  const deviceState = device.present ? 'on_device'
                    : device.unreachable ? 'unverified'
                    : 'not_on_device';
  let row;
  try {
    const { rows } = await db.query(
      `INSERT INTO staff_fobs (staff_id, fob_uid, label, is_active, issued_by,
                               device_state, device_recno, device_is_valid,
                               device_synced_at, device_last_result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
       ON CONFLICT (fob_uid) DO UPDATE
         SET staff_id=$1, label=$3, is_active=$4, issued_by=$5,
             device_state=$6, device_recno=$7, device_is_valid=$8,
             device_synced_at=NOW(), device_last_result=$9,
             deactivated_at = CASE WHEN $4 THEN NULL ELSE staff_fobs.deactivated_at END,
             revoke_requested_at = NULL, revoke_requested_by = NULL,
             revoke_attempts = 0, revoke_last_error = NULL
       RETURNING *`,
      [staffId, uid, label, active, req.user.id, deviceState,
       device.recno || null, device.is_valid === undefined ? null : device.is_valid,
       String(device.reason || '').slice(0, 500)]);
    row = rows[0];
  } catch (e) {
    // Roll the device back so we never leave a card that opens the door with no
    // Wren record behind it. If the rollback itself fails, say so loudly.
    let rolledBack = null;
    if (device.present && device.recno && !device.manual) {
      try { rolledBack = (await dahua.removeCard(device.recno)).ok; } catch { rolledBack = false; }
    }
    return { http: 500, body: {
      error: 'save_failed',
      message: `The fob could not be saved in Wren (${e.message}).` +
        (rolledBack === true  ? ' The card was removed from the door again — nothing is half-done.' :
         rolledBack === false ? ' ⚠️ The card is STILL ON THE DOOR and could not be removed — remove it on the Dahua UI.' : ''),
      device_rolled_back: rolledBack } };
  }

  await recordAudit({
    req, action: 'create', entity_type: 'staff_fob', entity_id: row.id,
    meta: { fob_uid: uid, staff_id: staffId, staff_name: staffName, label,
            device_write: wantDevice, device_state: deviceState,
            device_verified: active, device_recno: device.recno || null,
            device_reason: device.reason },
  });
  await logDoorEvent(db, {
    event_type: 'card', staff_id: staffId, card_no: uid,
    reason: `fob registered to ${staffName} by ${req.user.name || ('staff #' + req.user.id)} — ${device.reason}`,
  });

  return { http: 200, body: {
    ok: true, fob: row, device, verified: active,
    message: active
      ? 'Fob issued — written to the door station and confirmed there.'
      // Deliberately blunt. The one thing a manager must not walk away believing is
      // that a fob they just added will let someone in when it will not.
      : `Saved in Wren but NOT ACTIVE: ${device.reason}. It will not open the door, and Wren ` +
        'does not pretend otherwise. Once the door station can be written to, add the same ' +
        'card again here — it updates this record rather than creating a second one.',
  } };
}

// ── POST /fobs — enrol a fob (device + Wren, or neither) ──────────────────────
// body: { staff_id, fob_uid, label?, device_write? }
//   device_write:false  → record a card that was enrolled on the Dahua UI by hand.
//                         This is the documented fallback if the firmware's card CRUD
//                         ever stops behaving — see the probe notes in dahua-client.js.
router.post('/fobs', authenticate, _requireStaff, fobMngGate,
  express.json({ limit: '8kb' }), async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const uid = _normUid(b.fob_uid);
  const staffId = parseInt(b.staff_id, 10);
  const label = b.label ? String(b.label).slice(0, 100) : null;
  const wantDevice = b.device_write !== false;

  if (!uid)                     return res.status(400).json({ error: 'bad_fob_uid', message: 'A card number is required (letters and digits only).' });
  if (!Number.isFinite(staffId))return res.status(400).json({ error: 'bad_staff_id', message: 'Choose a staff member to assign this fob to.' });

  try {
    const r = await _issueFob(db, req, { uid, staffId, label, wantDevice });
    res.status(r.http).json(r.body);
  } catch (e) {
    res.status(500).json({ error: 'fob_add_failed', message: e.message });
  }
});

// ── PATCH /fobs/:id — rename / reassign ───────────────────────────────────────
// The card number never changes here, so the card keeps working throughout. The VTO
// only stores a display name, so a failed re-label is reported, not rolled back —
// refusing a legitimate reassignment because a cosmetic field did not update would be
// the wrong trade.
router.patch('/fobs/:id', authenticate, _requireStaff, fobMngGate,
  express.json({ limit: '8kb' }), async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  const b = req.body || {};
  const sets = [], vals = [];
  if (b.label !== undefined)    { sets.push(`label=$${sets.length + 1}`);    vals.push(b.label ? String(b.label).slice(0, 100) : null); }
  if (b.staff_id !== undefined) { sets.push(`staff_id=$${sets.length + 1}`); vals.push(parseInt(b.staff_id, 10)); }
  if (!sets.length) return res.status(400).json({ error: 'nothing_to_update' });

  try {
    const { rows: before } = await db.query(`SELECT * FROM staff_fobs WHERE id=$1`, [id]);
    if (!before.length) return res.status(404).json({ error: 'fob_not_found' });

    if (b.staff_id !== undefined) {
      const { rows: st } = await db.query(`SELECT id FROM staff WHERE id=$1`, [parseInt(b.staff_id, 10)]);
      if (!st.length) return res.status(404).json({ error: 'staff_not_found' });
    }

    vals.push(id);
    const { rows } = await db.query(
      `UPDATE staff_fobs SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    const row = rows[0];

    // Best-effort: keep the name the VTO shows in step with the new owner.
    let deviceRelabel = null;
    if (b.staff_id !== undefined && b.staff_id !== before[0].staff_id && dahua.cardWriteEnabled()) {
      try {
        const { rows: st } = await db.query(
          `SELECT first_name, last_name FROM staff WHERE id=$1`, [row.staff_id]);
        const nm = st.length ? `${st[0].first_name} ${st[0].last_name}` : 'WREN';
        const recno = await dahua.findCardRecNo(row.fob_uid);
        if (recno) {
          const rm = await dahua.removeCard(recno);
          if (rm.ok) {
            const ins = await dahua.insertCard({ card_no: row.fob_uid, card_name: nm, user_id: row.staff_id });
            deviceRelabel = !!ins.ok;
          } else { deviceRelabel = false; }
        } else { deviceRelabel = false; }
      } catch { deviceRelabel = false; }
    }

    await recordAudit({
      req, action: 'update', entity_type: 'staff_fob', entity_id: id,
      diff: { old: { staff_id: before[0].staff_id, label: before[0].label },
              new: { staff_id: row.staff_id, label: row.label } },
      meta: { fob_uid: row.fob_uid, device_relabel: deviceRelabel },
    });

    res.json({ ok: true, fob: row, device_relabel: deviceRelabel,
      message: deviceRelabel === false
        ? 'Saved. The card still works — only the name shown on the door device could not be updated.'
        : 'Saved.' });
  } catch (e) {
    res.status(500).json({ error: 'fob_update_failed', message: e.message });
  }
});

// ── POST /fobs/:id/deactivate — revoke a fob ──────────────────────────────────
// THE MOST IMPORTANT ROUTE IN THIS FILE. A lost fob marked "inactive" in Wren while
// it still opens the front door of a nursery is the worst outcome in this build, so:
//
//   • the card comes off the DEVICE first, and the removal is CONFIRMED by re-reading
//     the card table — the device's own "OK" is not accepted as proof;
//   • if any part of that fails, `is_active` STAYS TRUE. Wren does not get to call a
//     working fob dead. The row goes to `pending_removal`, which the screen shows in
//     red as "still opens the door", and the response is a 502 that says so;
//   • the request is recorded either way, so a failed revoke cannot be forgotten. The
//     sweeper retries it, and Retry is on the row.
router.post('/fobs/:id/deactivate', authenticate, _requireStaff, fobMngGate,
  express.json({ limit: '8kb' }), async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });

  try {
    const { rows: fobRows } = await db.query(
      `SELECT sf.*, s.first_name, s.last_name
         FROM staff_fobs sf LEFT JOIN staff s ON s.id = sf.staff_id
        WHERE sf.id=$1`, [id]);
    if (!fobRows.length) return res.status(404).json({ error: 'fob_not_found' });
    const fob = fobRows[0];
    const uid = _normUid(fob.fob_uid);
    const staffName = fob.first_name ? `${fob.first_name} ${fob.last_name}` : 'unassigned';
    const actor = req.user.name || ('staff #' + req.user.id);

    const result = await _removeCardVerified(uid);

    if (result.outcome !== 'removed') {
      const row = await _markPendingRemoval(db, fob, result.reason, req.user.id);
      await recordAudit({
        req, action: 'update', entity_type: 'staff_fob', entity_id: id,
        meta: { fob_uid: uid, staff_id: fob.staff_id, staff_name: staffName,
                revoke_outcome: 'pending_removal', reason: result.reason,
                attempts: row ? row.revoke_attempts : null },
      });
      await logDoorEvent(db, {
        event_type: 'card', staff_id: fob.staff_id, card_no: uid,
        reason: `fob revoke REQUESTED for ${staffName} by ${actor} but NOT completed — ` +
                `${result.reason}. The fob still opens the door.`,
      });
      return res.status(502).json({
        error: 'removal_not_confirmed',
        fob: row, device: result,
        message: `⚠️ This fob STILL OPENS THE DOOR — ${result.reason}. ` +
                 'Wren has recorded the revoke request and will keep retrying, and the fob is ' +
                 'flagged on the keyring until the door station confirms it is gone. ' +
                 'If it is urgent, remove the card on the Dahua UI and press Retry here.',
      });
    }

    // Confirmed off the door. Only now does the Wren row change.
    let row;
    try { row = await _markRemoved(db, id, result.reason); }
    catch (e) {
      return res.status(500).json({
        error: 'save_failed',
        message: `The card was removed from the door and no longer opens it, but the Wren record ` +
                 `could not be updated (${e.message}). Retry to tidy the record — access is already revoked.`,
        device: result,
      });
    }

    await recordAudit({
      req, action: 'delete', entity_type: 'staff_fob', entity_id: id,
      meta: { fob_uid: uid, staff_id: fob.staff_id, staff_name: staffName,
              revoke_outcome: 'removed', device_reason: result.reason },
    });
    await logDoorEvent(db, {
      event_type: 'card', staff_id: fob.staff_id, card_no: uid,
      reason: `fob revoked for ${staffName} by ${actor} — ${result.reason}`,
    });

    res.json({ ok: true, fob: row, device: result,
      message: 'Fob revoked — removed from the door station, confirmed gone, and deactivated in Wren.' });
  } catch (e) {
    res.status(500).json({ error: 'fob_deactivate_failed', message: e.message });
  }
});

// ── POST /fobs/:id/retry-removal — finish a revoke that did not complete ──────
// The manual companion to the sweeper, for when Toby has just fixed the connection
// (or pulled the card off the Dahua UI himself) and wants the flag cleared now.
router.post('/fobs/:id/retry-removal', authenticate, _requireStaff, fobMngGate,
  express.json({ limit: '4kb' }), async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  try {
    const { rows } = await db.query(
      `SELECT sf.*, s.first_name, s.last_name
         FROM staff_fobs sf LEFT JOIN staff s ON s.id = sf.staff_id WHERE sf.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'fob_not_found' });
    const fob = rows[0];
    if (fob.device_state !== 'pending_removal') {
      return res.status(409).json({ error: 'not_pending',
        message: 'This fob is not waiting to be removed from the door station.' });
    }
    const uid = _normUid(fob.fob_uid);
    const staffName = fob.first_name ? `${fob.first_name} ${fob.last_name}` : 'unassigned';
    const result = await _removeCardVerified(uid);

    if (result.outcome !== 'removed') {
      const row = await _markPendingRemoval(db, fob, result.reason, req.user.id);
      return res.status(502).json({ error: 'removal_not_confirmed', fob: row, device: result,
        message: `Still not removed — ${result.reason}. The fob continues to open the door.` });
    }
    const row = await _markRemoved(db, id, result.reason);
    await recordAudit({ req, action: 'delete', entity_type: 'staff_fob', entity_id: id,
      meta: { fob_uid: uid, staff_id: fob.staff_id, staff_name: staffName,
              revoke_outcome: 'removed_on_retry', device_reason: result.reason } });
    await logDoorEvent(db, { event_type: 'card', staff_id: fob.staff_id, card_no: uid,
      reason: `pending fob removal completed for ${staffName} by ${req.user.name || ('staff #' + req.user.id)} — ${result.reason}` });
    res.json({ ok: true, fob: row, device: result,
      message: 'Removal confirmed — the fob no longer opens the door.' });
  } catch (e) {
    res.status(500).json({ error: 'retry_failed', message: e.message });
  }
});

// ── POST /fobs/:id/replace — swap a fob for a new card, same staff member ─────
// body: { fob_uid, label? }
//
// ORDER MATTERS AND IS NOT NEGOTIABLE: the old card comes off the door FIRST and is
// confirmed gone. Only then is the new one issued. If the old removal cannot be
// confirmed the replacement is REFUSED — issuing a working replacement while the lost
// card still opens the door would turn one problem into two, and it is not a real
// cost: if the device is out of contact, the new card could not be enrolled anyway.
router.post('/fobs/:id/replace', authenticate, _requireStaff, fobMngGate,
  express.json({ limit: '8kb' }), async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const newUid = _normUid(b.fob_uid);
  if (!Number.isFinite(id))  return res.status(400).json({ error: 'bad_id' });
  if (!newUid)               return res.status(400).json({ error: 'bad_fob_uid', message: 'The new card number is required.' });

  try {
    const { rows } = await db.query(
      `SELECT sf.*, s.first_name, s.last_name
         FROM staff_fobs sf LEFT JOIN staff s ON s.id = sf.staff_id WHERE sf.id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'fob_not_found' });
    const old = rows[0];
    const oldUid = _normUid(old.fob_uid);
    if (newUid === oldUid) {
      return res.status(400).json({ error: 'same_card',
        message: 'The replacement is the same card number as the fob being replaced.' });
    }
    if (!old.staff_id) {
      return res.status(400).json({ error: 'no_owner',
        message: 'This fob is not assigned to anyone — issue a new fob instead of replacing it.' });
    }
    const staffName = old.first_name ? `${old.first_name} ${old.last_name}` : 'unassigned';
    const actor = req.user.name || ('staff #' + req.user.id);

    // 1. Old card off the door, confirmed.
    const removal = await _removeCardVerified(oldUid);
    if (removal.outcome !== 'removed') {
      const row = await _markPendingRemoval(db, old, removal.reason, req.user.id);
      await logDoorEvent(db, { event_type: 'card', staff_id: old.staff_id, card_no: oldUid,
        reason: `fob replacement for ${staffName} by ${actor} ABANDONED — the old card could not be ` +
                `removed (${removal.reason}). No new fob was issued.` });
      return res.status(502).json({
        error: 'old_card_not_removed', fob: row, device: removal,
        message: `No replacement was issued. The old fob STILL OPENS THE DOOR — ${removal.reason}. ` +
                 'Clear that first (Retry, or remove it on the Dahua UI), then replace it.',
      });
    }
    await _markRemoved(db, id, `replaced by ${newUid} — ${removal.reason}`);

    // 2. New card on, verified. Same path as a normal issue.
    const issued = await _issueFob(db, req, {
      uid: newUid, staffId: old.staff_id,
      label: b.label !== undefined ? (b.label ? String(b.label).slice(0, 100) : null) : old.label,
      wantDevice: b.device_write !== false,
    });

    if (issued.http === 200 && issued.body.fob) {
      await db.query(`UPDATE staff_fobs SET replaced_by_fob_id=$2 WHERE id=$1`, [id, issued.body.fob.id]);
    }
    await recordAudit({
      req, action: 'update', entity_type: 'staff_fob', entity_id: id,
      meta: { action: 'replace', old_fob_uid: oldUid, new_fob_uid: newUid,
              staff_id: old.staff_id, staff_name: staffName,
              old_removed: true, new_issued: issued.http === 200 && !!issued.body.verified },
    });
    await logDoorEvent(db, { event_type: 'card', staff_id: old.staff_id, card_no: newUid,
      reason: `fob replaced for ${staffName} by ${actor} — old card ${oldUid} removed and confirmed gone` });

    if (issued.http !== 200) {
      // The old card IS off the door — that half is done and safe. Say exactly that.
      return res.status(issued.http).json({
        ...issued.body,
        old_fob_removed: true,
        message: `The old fob has been removed from the door and no longer works. The replacement ` +
                 `was NOT issued: ${issued.body.message || issued.body.error}`,
      });
    }
    res.json({ ...issued.body, old_fob_removed: true, old_fob_id: id,
      message: `Replaced. The old fob no longer opens the door, and the new one is on the door station.` });
  } catch (e) {
    res.status(500).json({ error: 'fob_replace_failed', message: e.message });
  }
});

// ── Enrolment helper: listen for the next swipe ───────────────────────────────
// Arm → walk to the reader → tap → the number appears here. Nobody types an 8-character
// hex string off a screen, which is the step that actually goes wrong.
router.post('/enrol/arm', authenticate, _requireStaff, fobMngGate,
  express.json({ limit: '4kb' }), (req, res) => {
  const ttl = parseInt((req.body || {}).ttl_ms, 10) || undefined;
  const st = fobEnrol.arm({ staffId: req.user.id, staffName: req.user.name || null, ttlMs: ttl });
  res.json({ ok: true, ...st });
});

router.get('/enrol/state', authenticate, _requireStaff, fobViewGate, (req, res) => {
  res.json(fobEnrol.getState());
});

router.post('/enrol/disarm', authenticate, _requireStaff, fobMngGate, (req, res) => {
  res.json({ ok: true, ...fobEnrol.disarm() });
});

// ── GET /device/cards — what the VTO actually holds ───────────────────────────
router.get('/device/cards', authenticate, _requireStaff, fobViewGate, async (req, res) => {
  const d = await _deviceCardsSafe();
  res.json({
    reachable: d.reachable, count: d.count, reason: d.reason,
    write_enabled: dahua.cardWriteEnabled(), dry_run: !dahua.cardWriteEnabled(),
    host: dahua.host(), cards: d.cards,
  });
});

module.exports = router;
module.exports.logDoorEvent = logDoorEvent;
// b250 — exposed so scripts/b250-fob-verify.js can drive ONE sweep tick instead of
// sleeping through SWEEP_MS. Not used by any route; the timer is the production path.
module.exports._sweepPendingRemovals = _sweepPendingRemovals;
