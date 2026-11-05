'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * security-hub.js — b505 (2026-10-18) — mounted at /api/security-hub.
 *
 * The server end of Roost → Operations → 🛡 Security hub (/security-hub.html).
 *
 * ⚠️ /api/security IS A DIFFERENT ROUTE AND IS NOT TOUCHED BY THIS FILE.
 * That one is the pen-test / security-self-check router behind /security.html in
 * the System nav (/checks, /run-checks, /summary, /pdf-report). Nothing new is
 * mounted there and it is not renamed.
 *
 * ── WHAT THIS IS ──────────────────────────────────────────────────────────────
 * A THIN AGGREGATOR. Everything about the physical security of the building is
 * already in Wren — it is just in six places. This router does not re-implement
 * any of it. Where a number has an owner, the hub asks the owner:
 *
 *   • tiles and the fob/clock/door/camera panels are fetched from the EXISTING
 *     routes over loopback, with the caller's own Authorization and Host headers
 *     forwarded, so every answer comes through that route's own gate and its own
 *     audit. If the hub and /clockin.html could disagree about a worked day, the
 *     build would be wrong; they cannot, because there is one derivation and the
 *     hub is downstream of it.
 *   • retention is read off the recorder via src/lib/frigate.js, never assumed;
 *   • a worked day comes from src/lib/clock-day.js;
 *   • a real fob tap is told apart from a fob-admin row by
 *     fob-enrol.swipeReason() / SWIPE_SQL_PATTERN — filtering on event_type alone
 *     makes ISSUING a fob look like somebody tapping it at the door;
 *   • in-hours / out-of-hours comes from src/lib/security-hours.js.
 *
 * ── GDPR ──────────────────────────────────────────────────────────────────────
 * No child, parent or family name, address, email or phone appears in any
 * response from this router. Staff are FIRST NAME AND ROLE only. The stripping
 * happens here, server-side, not in a template — a template is a rendering
 * choice and this is a rule.
 *
 * ── WHAT IS NEVER IN A RESPONSE ───────────────────────────────────────────────
 * No RTSP URL (cameras.rtsp_ref is an env-var NAME and that is all a client sees),
 * no camera password, no HA token, no ntfy token, no recorder address, and no
 * base64 JPEG. Frigate puts a thumbnail in every event row; frigate.publicEvent()
 * is the only shape that leaves that module and it drops it.
 *
 * ── GATING ────────────────────────────────────────────────────────────────────
 * authenticate → manager/admin role AND the Roost portal (both server-side, the
 * same shape cameras.js uses) → requireCapability('security.hub-view'). Writes
 * add their own capability on top. A capability can only NARROW access here; it
 * is never a way for a non-manager to reach any of this.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const http    = require('http');
const router  = express.Router();

const { getPool }    = require('../db/pool');
const authenticate   = require('../middleware/auth');
const { requireCapability } = require('../lib/capabilities');
const { recordAudit } = require('../utils/audit');

const frigate  = require('../lib/frigate');
const hours    = require('../lib/security-hours');
const alerts   = require('../lib/cctv-alerts');
const ntfy     = require('../lib/ntfy');
const clockDay = require('../lib/clock-day');
const fobEnrol = require('../lib/fob-enrol');
const haLadn   = require('../services/ha-ladn');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── The guard ────────────────────────────────────────────────────────────────
// Same wording and same shape as cameras.js. A request with no portal is REFUSED
// rather than defaulted: failing open on a page about the building's security is
// not a trade-off worth making.
function managerAdminOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'The Security hub is available on the Roost (admin) portal only.',
    });
  }
  if (!req.user || !hasRole(req.user, ['manager', 'admin'])) {
    return res.status(403).json({
      error: 'forbidden_role',
      message: 'Manager access only — the building\'s security is not a general staff screen.',
    });
  }
  next();
}

const guard  = [authenticate, managerAdminOnly, requireCapability('security.hub-view')];
const buildG = [authenticate, managerAdminOnly, requireCapability('security.hub-view'),
                requireCapability('security.building-control')];

router.use(express.json({ limit: '16kb' }));

// ── Asking the route that owns the number ────────────────────────────────────
// One loopback GET against this same server, carrying the caller's Authorization
// AND Host. The Host matters: req._portal is derived from the hostname prefix in
// editions/ladn/server-unified.js, so without it the sub-request would arrive on
// the 'learning' portal and every camera route would (correctly) refuse it.
//
// Node's fetch() drops a Host header (undici), which is why this is http.request.
// Timeouts on everything: a slow Z420 behind one of these must not hang the page.
function _self(req, path, { timeout = 12_000 } = {}) {
  return new Promise((resolve) => {
    const port = (req.socket && req.socket.localPort) || Number(process.env.PORT) || 3000;
    const r = http.request({
      host: '127.0.0.1', port, path, method: 'GET', timeout,
      headers: {
        Host: req.headers.host || 'admin.example-nursery.co.uk',
        ...(req.headers.authorization ? { Authorization: req.headers.authorization } : {}),
        ...(req.headers['x-wren-token'] ? { 'x-wren-token': req.headers['x-wren-token'] } : {}),
        ...(req.headers['x-wren-device'] ? { 'x-wren-device': req.headers['x-wren-device'] } : {}),
        Accept: 'application/json',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch { body = null; }
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true, data: body });
        resolve({ ok: false, status: res.statusCode,
                  reason: (body && (body.message || body.error)) || `HTTP ${res.statusCode}` });
      });
    });
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, reason: `${path} did not answer within ${timeout / 1000}s` }); });
    r.on('error', e => resolve({ ok: false, reason: e.message }));
    r.end();
  });
}

// ── Staff identity, GDPR-shaped ──────────────────────────────────────────────
// First name and role. Never a surname, never an email. One place, so no caller
// below can accidentally widen it.
const ROLE_LABEL = {
  admin: 'Owner', owner: 'Owner', manager: 'Manager', deputy_manager: 'Deputy manager',
  room_leader: 'Room leader', practitioner: 'Practitioner', apprentice: 'Apprentice',
  bank: 'Bank staff', supply: 'Supply staff', cook: 'Cook', accountant: 'Accountant',
};
const roleLabel = r => ROLE_LABEL[String(r || '').toLowerCase()] || (r ? String(r).replace(/_/g, ' ') : null);

let _staffCache = { at: 0, map: null };
async function staffMap(db) {
  if (_staffCache.map && Date.now() - _staffCache.at < 60_000) return _staffCache.map;
  const map = new Map();
  try {
    const { rows } = await db.query(`SELECT id, first_name, role FROM staff`);
    for (const r of rows) map.set(Number(r.id), { first_name: r.first_name || null, role: roleLabel(r.role) });
  } catch (e) { /* an unreadable staff list shows ids as "a member of staff" */ }
  _staffCache = { at: Date.now(), map };
  return map;
}
const who = (map, id) => {
  if (!id) return null;
  const s = map.get(Number(id));
  if (!s) return { first_name: null, role: null, label: 'a member of staff' };
  return { first_name: s.first_name, role: s.role,
           label: [s.first_name, s.role && `(${s.role})`].filter(Boolean).join(' ') || 'a member of staff' };
};

// A missing table is a state, not a 500 — this runs on dev before prod and the
// tables may not exist on one of them. Same shape as the attention collectors.
const isMissingTable = e => e && e.code === '42P01';

// ═════════════════════════════════════════════════════════════════════════════
// GET /overview — the tiles, plus the one hub_view audit row for this visit.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/overview', ...guard, async (req, res) => {
  const db = getPool();

  // One `hub_view` row per visit, so "who opened the Security page and when" is
  // answerable. Deliberately NOT per tab switch — the tabs load their own data
  // and this endpoint is hit once per page load. A 10-minute window stops a
  // refresh loop turning the access log into noise without ever losing a visit.
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM camera_access_log
        WHERE staff_id = $1 AND action = 'hub_view'
          AND created_at >= now() - interval '10 minutes' LIMIT 1`, [req.user.id]);
    if (!rows.length) {
      await db.query(
        `INSERT INTO camera_access_log (staff_id, camera_id, action, granted, reason, ip, user_agent)
         VALUES ($1, NULL, 'hub_view', true, $2, $3, $4)`,
        [req.user.id, 'Opened the Security hub.',
         String(req.ip || '').slice(0, 64), String(req.headers['user-agent'] || '').slice(0, 1000)]);
    }
  } catch (e) {
    if (!isMissingTable(e)) console.error('[security-hub] hub_view audit:', e.message);
  }

  // Every tile is independent and carries its own { ok } — ONE dead subsystem
  // must not blank the page. That is the difference between a status board and a
  // dashboard that lies by omission.
  const [cams, recStatus, doorStatus, fobRecon, clockToday, clockQueries] = await Promise.all([
    _self(req, '/api/cameras?include_planned=1'),
    _self(req, '/api/cameras/recordings/status', { timeout: 15_000 }),
    _self(req, '/api/door/status', { timeout: 8_000 }),
    _self(req, '/api/door/fobs/reconcile', { timeout: 12_000 }),
    _self(req, '/api/clockin/today'),
    _self(req, '/api/clockin/queries'),
  ]);

  // ── Cameras tile ──
  const camTile = { ok: cams.ok };
  if (cams.ok) {
    const list = (cams.data && cams.data.cameras) || [];
    const inService = list.filter(c => c.in_service);
    const ret = recStatus.ok ? recStatus.data : null;
    const maxDays = ret && ret.retention && Array.isArray(ret.retention.cameras)
      ? ret.retention.cameras.map(c => c.max_days).filter(n => n != null)
      : [];
    camTile.in_service = inService.length;
    camTile.planned    = list.length - inService.length;
    camTile.total      = list.length;
    camTile.recorder_up = !!(ret && ret.reachable);
    camTile.recorder_error = ret ? ret.recorder_error : (recStatus.reason || null);
    // Read, never hard-coded. "unknown" is an honest answer; 7 would be a guess.
    camTile.retention_days = maxDays.length ? Math.max(...maxDays) : null;
    camTile.policy_days    = ret ? ret.policy_days : null;
    camTile.retention_breach = !!(ret && ret.retention_breach);
  } else { camTile.reason = cams.reason; }

  // ── Front door tile ──
  const doorTile = { ok: doorStatus.ok };
  if (doorStatus.ok) {
    doorTile.status    = doorStatus.data && doorStatus.data.status;
    doorTile.reachable = !!(doorStatus.data && doorStatus.data.reachable);
  } else { doorTile.reason = doorStatus.reason; doorTile.reachable = false; }
  try {
    const { rows } = await db.query(
      `SELECT event_type, max(created_at) AS at
         FROM door_events WHERE event_type IN ('ring','open') GROUP BY event_type`);
    for (const r of rows) doorTile[r.event_type === 'ring' ? 'last_ring' : 'last_open'] = r.at;
  } catch (e) { if (!isMissingTable(e)) doorTile.events_error = e.message; }

  // ── Fobs tile ──
  // "reader: not detected" is the honest line. As of 2026-10-17 no fob swipe has
  // EVER reached Wren: door_events holds only ring and open rows, and the VTO
  // panel appears to have no VTO4202F-MR card-reader module fitted. An empty fob
  // table would read as "no activity", which is a different and untrue statement.
  const fobTile = { ok: fobRecon.ok };
  if (fobRecon.ok) {
    const d = fobRecon.data || {};
    fobTile.reachable = !!d.reachable;
    fobTile.wren_rows = d.wren_rows || 0;
    fobTile.pending_removal = (d.live_but_should_be_revoked || []).length;
    fobTile.only_on_device  = (d.only_on_device || []).length;
    fobTile.in_step = d.in_step;
  } else { fobTile.reason = fobRecon.reason; }
  fobTile.reader = await readerHealth(db);
  if (fobTile.ok) {
    try {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM staff_fobs WHERE is_active = true`);
      fobTile.active = rows[0] ? rows[0].n : 0;
    } catch (e) { if (!isMissingTable(e)) fobTile.active = null; }
  }

  // ── Clock-in tile ──
  const clockTile = { ok: clockToday.ok };
  if (clockToday.ok) {
    const list = Array.isArray(clockToday.data) ? clockToday.data : [];
    clockTile.on_site = list.filter(r => r.status === 'in').length;
    clockTile.expected = list.length;
  } else { clockTile.reason = clockToday.reason; }
  clockTile.open_queries = clockQueries.ok
    ? ((clockQueries.data && clockQueries.data.queries) || []).filter(q => q.status === 'open').length
    : null;
  if (!clockQueries.ok) clockTile.queries_reason = clockQueries.reason;

  // ── Out-of-hours tile ──
  const alarmTile = await alarmState(db);

  // ── Building tile ──
  const buildingTile = await haSummary(db);

  res.json({
    tiles: {
      cameras: camTile, door: doorTile, fobs: fobTile,
      clockin: clockTile, out_of_hours: alarmTile, building: buildingTile,
    },
    generated_at: new Date().toISOString(),
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /timeline — the merged "what happened at the building" list.
// ═════════════════════════════════════════════════════════════════════════════
const TIMELINE_SOURCES = ['door', 'fob', 'fob_admin', 'clock', 'detection', 'camera_access', 'alert'];
const MAX_TIMELINE_ROWS = 500;

router.get('/timeline', ...guard, async (req, res) => {
  const db = getPool();
  const now = new Date();
  const to   = parseDate(req.query.to)   || now;
  const from = parseDate(req.query.from) || new Date(to.getTime() - 72 * 3600 * 1000);
  const want = String(req.query.sources || '').split(',').map(s => s.trim()).filter(s => TIMELINE_SOURCES.includes(s));
  const sources = want.length ? want : TIMELINE_SOURCES.slice();

  const map = await staffMap(db);
  const items = [];
  const errors = [];

  // ── Door rings and opens, plus the two kinds of 'card' row ──
  // door_events.event_type cannot tell a real tap from a fob-admin action: both
  // are 'card'. The ONLY discriminator is the reason text, and it is defined in
  // ONE place — fob-enrol.swipeReason() builds it, fob-enrol.SWIPE_SQL_PATTERN
  // matches it. Filtering on event_type alone would make "fob issued to the deputy"
  // appear in this timeline as somebody arriving at the door.
  if (sources.some(s => ['door', 'fob', 'fob_admin'].includes(s))) {
    try {
      const { rows } = await db.query(
        `SELECT id, event_type, staff_id, card_no, reason, created_at,
                (reason ILIKE $3) AS is_real_swipe
           FROM door_events
          WHERE created_at >= $1 AND created_at <= $2
          ORDER BY created_at DESC LIMIT $4`,
        [from, to, fobEnrol.SWIPE_SQL_PATTERN, MAX_TIMELINE_ROWS]);
      for (const r of rows) {
        const p = who(map, r.staff_id);
        if (r.event_type === 'card') {
          const src = r.is_real_swipe ? 'fob' : 'fob_admin';
          if (!sources.includes(src)) continue;
          items.push({
            at: r.created_at, source: src, icon: r.is_real_swipe ? '🔑' : '🗂',
            text: r.is_real_swipe
              ? `${p ? p.label : 'An unassigned fob'} presented a fob at the door`
              : adminFobText(r.reason),
            detail_href: '/door-access.html', ref: `door_event:${r.id}`,
          });
        } else {
          if (!sources.includes('door')) continue;
          const label = { ring: 'Doorbell rang', open: 'Door released', denied: 'Entry refused' }[r.event_type]
                     || r.event_type;
          items.push({
            at: r.created_at, source: 'door', icon: r.event_type === 'ring' ? '🔔' : r.event_type === 'denied' ? '⛔' : '🚪',
            text: p ? `${label} — by ${p.label}` : label,
            detail_href: '/door.html', ref: `door_event:${r.id}`,
          });
        }
      }
    } catch (e) { if (!isMissingTable(e)) errors.push(`door_events: ${e.message}`); }
  }

  // ── Clock in / out ──
  if (sources.includes('clock')) {
    try {
      const { rows } = await db.query(
        `SELECT id, staff_id, event_type, event_time, source, method
           FROM staff_clock_events_current
          WHERE event_time >= $1 AND event_time <= $2
          ORDER BY event_time DESC LIMIT $3`, [from, to, MAX_TIMELINE_ROWS]);
      for (const r of rows) {
        const p = who(map, r.staff_id);
        items.push({
          at: r.event_time, source: 'clock', icon: r.event_type === 'in' ? '🟢' : '⚪',
          text: `${p ? p.label : 'A member of staff'} clocked ${r.event_type === 'in' ? 'in' : 'out'}`
               + (r.source || r.method ? ` (${clockDay.sourceLabel ? clockDay.sourceLabel(r.source || r.method) : (r.source || r.method)})` : ''),
          detail_href: '/clockin.html', ref: `clock_event:${r.id}`,
        });
      }
    } catch (e) { if (!isMissingTable(e)) errors.push(`clock events: ${e.message}`); }
  }

  // ── Camera views and refusals ──
  if (sources.includes('camera_access')) {
    try {
      const { rows } = await db.query(
        `SELECT l.id, l.staff_id, l.action, l.granted, l.created_at, c.name AS camera_name
           FROM camera_access_log l LEFT JOIN cameras c ON c.id = l.camera_id
          WHERE l.created_at >= $1 AND l.created_at <= $2
          ORDER BY l.created_at DESC LIMIT $3`, [from, to, MAX_TIMELINE_ROWS]);
      for (const r of rows) {
        const p = who(map, r.staff_id);
        items.push({
          at: r.created_at, source: 'camera_access', icon: r.granted ? '👁' : '🚫',
          text: `${p ? p.label : 'Someone'} ${r.granted ? '' : 'was REFUSED '}`
               + `${ACTION_WORDS[r.action] || r.action}${r.camera_name ? ` — ${r.camera_name}` : ''}`,
          granted: r.granted, detail_href: '#tab-log', ref: `camera_access_log:${r.id}`,
        });
      }
    } catch (e) { if (!isMissingTable(e)) errors.push(`camera_access_log: ${e.message}`); }
  }

  // ── Out-of-hours alerts ──
  if (sources.includes('alert')) {
    try {
      const { rows } = await db.query(
        `SELECT id, camera_key, object_label, detected_at, delivered, suppressed,
                suppress_reason, is_test, acknowledged_at
           FROM cctv_alerts
          WHERE detected_at >= $1 AND detected_at <= $2
          ORDER BY detected_at DESC LIMIT 200`, [from, to]);
      for (const r of rows) {
        items.push({
          at: r.detected_at, source: 'alert', icon: r.delivered ? '🚨' : '🔇',
          text: `${r.is_test ? 'TEST alert' : `${r.object_label || 'Something'} detected at ${r.camera_key}`}`
               + (r.delivered ? ' — alert sent'
                  : r.suppressed ? ` — not sent (${SUPPRESS_WORDS[r.suppress_reason] || r.suppress_reason})`
                  : ' — not sent'),
          detail_href: '#tab-oh', ref: `cctv_alert:${r.id}`,
        });
      }
    } catch (e) { if (!isMissingTable(e)) errors.push(`cctv_alerts: ${e.message}`); }
  }

  // ── Frigate person/car detections (metadata only) ──
  if (sources.includes('detection')) {
    try {
      const base = await frigate.baseUrl(db);
      if (base) {
        const reach = await frigate.reachable(base);
        if (reach.ok) {
          const keys = await alerts.camerasInService(db);
          const want2 = await alerts.labels(db);
          for (const key of keys) {
            try {
              const evs = await frigate.events(base, key, {
                after: Math.floor(from.getTime() / 1000), before: Math.floor(to.getTime() / 1000), limit: 200 });
              for (const raw of (Array.isArray(evs) ? evs : [])) {
                // publicEvent() strips the base64 JPEG. `raw` is never read again.
                const e = frigate.publicEvent(raw);
                if (!want2.includes(String(e.label || '').toLowerCase())) continue;
                items.push({
                  at: new Date((e.start_time || 0) * 1000).toISOString(), source: 'detection', icon: '📹',
                  text: `${e.label} seen by ${key}${e.duration_s ? ` for ${e.duration_s}s` : ''}`,
                  detail_href: '#tab-cameras', ref: `frigate_event:${e.id}`,
                });
              }
            } catch (e) { errors.push(`frigate ${key}: ${e.message}`); }
          }
        } else { errors.push(`recorder unreachable: ${reach.error}`); }
      }
    } catch (e) { errors.push(`frigate: ${e.message}`); }
  }

  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({
    from: from.toISOString(), to: to.toISOString(),
    sources, all_sources: TIMELINE_SOURCES,
    items: items.slice(0, MAX_TIMELINE_ROWS),
    truncated: items.length > MAX_TIMELINE_ROWS,
    errors,
    privacy: 'Staff appear by first name and role. No child or parent name appears on this page.',
  });
});

const ACTION_WORDS = {
  view_stream: 'opened a live camera', list_recordings: 'listed a day of recordings',
  view_recording: 'played back footage', hub_view: 'opened the Security hub',
};
const SUPPRESS_WORDS = {
  disarmed: 'alerting is switched off', in_hours: 'the nursery was open',
  dedup: 'already alerted for that camera', not_configured: 'no notification channel is set up',
};
// A fob-admin reason is already a plain sentence ("fob registered to … by …").
// Keep it, but never let a surname through: the reason text is written by door.js
// from staff names, so first names only.
function adminFobText(reason) {
  return String(reason || 'Fob administration').replace(/\s+/g, ' ').trim().slice(0, 200);
}
function parseDate(v) {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /anomalies — clock-in patterns worth a second look.
// Every figure is derived from src/lib/clock-day.js. The hub does not re-derive a
// worked day; staff_shifts.total_minutes already means WORKED time (pairs summed,
// lunch excluded) and nothing here re-adds first-to-last span logic.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/anomalies', ...guard, async (req, res) => {
  const db = getPool();
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 28, 1), 120);
  const map = await staffMap(db);
  const out = { days, anomalies: [], hour_histogram: null, errors: [] };

  const since = new Date(Date.now() - days * 86400_000);
  const sinceYmd = hours.londonParts(since).ymd;

  // 1. OUT-OF-HOURS ENTRY — the security-relevant one, so it is first.
  try {
    const st = await hours.state(db);
    const win = st.window;
    const { rows } = await db.query(
      `SELECT e.id, e.staff_id, e.event_type, e.event_time,
              to_char(e.event_time AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS ymd,
              to_char(e.event_time AT TIME ZONE 'Europe/London', 'HH24:MI')    AS hhmm,
              to_char(e.event_time AT TIME ZONE 'Europe/London', 'Dy')         AS dow
         FROM staff_clock_events_current e
        WHERE (e.event_time AT TIME ZONE 'Europe/London')::date >= $1::date
        ORDER BY e.event_time DESC`, [sinceYmd]);
    for (const r of rows) {
      const mins = Number(r.hhmm.slice(0, 2)) * 60 + Number(r.hhmm.slice(3, 5));
      const weekend = ['Sat', 'Sun'].includes(String(r.dow).trim());
      if (!weekend && mins >= win.open_mins && mins < win.close_mins) continue;
      const p = who(map, r.staff_id);
      out.anomalies.push({
        kind: 'out_of_hours_entry', severity: 'high', date: r.ymd,
        staff_first_name: p && p.first_name, staff_role: p && p.role,
        text: `${p ? p.label : 'A member of staff'} clocked ${r.event_type === 'in' ? 'in' : 'out'} at `
            + `${r.hhmm} on ${r.ymd}${weekend ? ' (a weekend)' : ''} — the building should have been empty.`,
        href: `/clockin.html?staff=${r.staff_id}&date=${r.ymd}`,
      });
    }
  } catch (e) { if (!isMissingTable(e)) out.errors.push(`out-of-hours entry: ${e.message}`); }

  // 1b. A door opened when the building should have been empty.
  try {
    const st = await hours.state(db);
    const win = st.window;
    const { rows } = await db.query(
      `SELECT id, event_type, staff_id,
              to_char(created_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS ymd,
              to_char(created_at AT TIME ZONE 'Europe/London', 'HH24:MI')    AS hhmm,
              to_char(created_at AT TIME ZONE 'Europe/London', 'Dy')         AS dow
         FROM door_events
        WHERE created_at >= $1 AND event_type = 'open'
        ORDER BY created_at DESC LIMIT 200`, [since]);
    for (const r of rows) {
      const mins = Number(r.hhmm.slice(0, 2)) * 60 + Number(r.hhmm.slice(3, 5));
      const weekend = ['Sat', 'Sun'].includes(String(r.dow).trim());
      if (!weekend && mins >= win.open_mins && mins < win.close_mins) continue;
      const p = who(map, r.staff_id);
      out.anomalies.push({
        kind: 'out_of_hours_door', severity: 'high', date: r.ymd,
        text: `The front door was released at ${r.hhmm} on ${r.ymd}${weekend ? ' (a weekend)' : ''}`
            + `${p ? ` by ${p.label}` : ''} — the building should have been empty.`,
        href: '/door.html',
      });
    }
  } catch (e) { if (!isMissingTable(e)) out.errors.push(`out-of-hours door: ${e.message}`); }

  // 2. Clocked in but never out — the emergency-exit-button problem.
  //    staff_shifts is written only by clock-day.recomputeDay(), so reading
  //    status = 'open' here is reading that one derivation, not a second one.
  try {
    const { rows } = await db.query(
      `SELECT ss.staff_id, ss.shift_date::text AS ymd,
              to_char(ss.clock_in_time AT TIME ZONE 'Europe/London', 'HH24:MI') AS in_hhmm
         FROM staff_shifts ss
        WHERE ss.shift_date >= $1::date AND ss.status = 'open'
          AND ss.shift_date < (now() AT TIME ZONE 'Europe/London')::date
        ORDER BY ss.shift_date DESC`, [sinceYmd]);
    for (const r of rows) {
      const p = who(map, r.staff_id);
      out.anomalies.push({
        kind: 'never_clocked_out', severity: 'medium', date: r.ymd,
        text: `${p ? p.label : 'A member of staff'} clocked in at ${r.in_hhmm || '—'} on ${r.ymd} and never clocked out.`,
        href: `/clockin.html?staff=${r.staff_id}&date=${r.ymd}`,
      });
    }
  } catch (e) { if (!isMissingTable(e)) out.errors.push(`open shifts: ${e.message}`); }

  // 3. Clocked in more than 30 minutes outside the rota window.
  try {
    const { rows } = await db.query(
      `SELECT ss.staff_id, ss.shift_date::text AS ymd,
              to_char(ss.clock_in_time  AT TIME ZONE 'Europe/London', 'HH24:MI') AS in_hhmm,
              to_char(ss.clock_out_time AT TIME ZONE 'Europe/London', 'HH24:MI') AS out_hhmm,
              to_char(min(rs.planned_start), 'HH24:MI') AS planned_start,
              to_char(max(rs.planned_end),   'HH24:MI') AS planned_end
         FROM staff_shifts ss
         JOIN rota_shifts rs ON rs.staff_id = ss.staff_id AND rs.shift_date = ss.shift_date
                            AND COALESCE(rs.is_absent,false) = false AND COALESCE(rs.is_open,false) = false
        WHERE ss.shift_date >= $1::date AND ss.clock_in_time IS NOT NULL
        GROUP BY ss.staff_id, ss.shift_date, ss.clock_in_time, ss.clock_out_time
        ORDER BY ss.shift_date DESC`, [sinceYmd]);
    for (const r of rows) {
      if (!r.planned_start || !r.in_hhmm) continue;
      const diff = Math.abs(mins(r.in_hhmm) - mins(r.planned_start));
      if (diff <= 30) continue;
      const p = who(map, r.staff_id);
      const early = mins(r.in_hhmm) < mins(r.planned_start);
      out.anomalies.push({
        kind: 'off_rota', severity: 'low', date: r.ymd,
        text: `${p ? p.label : 'A member of staff'} clocked in at ${r.in_hhmm} on ${r.ymd}, `
            + `${diff} minutes ${early ? 'before' : 'after'} the rota's ${r.planned_start}.`,
        href: `/clockin.html?staff=${r.staff_id}&date=${r.ymd}`,
      });
    }
  } catch (e) { if (!isMissingTable(e)) out.errors.push(`off-rota: ${e.message}`); }

  // 4. A rota'd shift with no clock events at all.
  try {
    const { rows } = await db.query(
      `SELECT rs.staff_id, rs.shift_date::text AS ymd
         FROM rota_shifts rs
    LEFT JOIN staff_shifts ss ON ss.staff_id = rs.staff_id AND ss.shift_date = rs.shift_date
        WHERE rs.shift_date >= $1::date
          AND rs.shift_date < (now() AT TIME ZONE 'Europe/London')::date
          AND COALESCE(rs.is_absent,false) = false AND COALESCE(rs.is_open,false) = false
          AND (ss.staff_id IS NULL OR ss.status = 'none')
        GROUP BY rs.staff_id, rs.shift_date
        ORDER BY rs.shift_date DESC LIMIT 60`, [sinceYmd]);
    for (const r of rows) {
      const p = who(map, r.staff_id);
      out.anomalies.push({
        kind: 'rota_no_taps', severity: 'low', date: r.ymd,
        text: `${p ? p.label : 'A member of staff'} was on the rota for ${r.ymd} but there are no clock events for that day.`,
        href: `/clockin.html?staff=${r.staff_id}&date=${r.ymd}`,
      });
    }
  } catch (e) { if (!isMissingTable(e)) out.errors.push(`rota with no taps: ${e.message}`); }

  // 5. Over 10 hours worked, or a worked day with no break at all.
  //    total_minutes is WORKED time already (clock-day.js sums the pairs and
  //    excludes lunch) — this does not recompute it.
  try {
    const { rows } = await db.query(
      `SELECT staff_id, shift_date::text AS ymd, total_minutes, break_minutes
         FROM staff_shifts
        WHERE shift_date >= $1::date AND status = 'complete' AND total_minutes IS NOT NULL
          AND (total_minutes > 600 OR (total_minutes >= 360 AND COALESCE(break_minutes,0) = 0))
        ORDER BY shift_date DESC`, [sinceYmd]);
    for (const r of rows) {
      const p = who(map, r.staff_id);
      const long = r.total_minutes > 600;
      out.anomalies.push({
        kind: long ? 'long_day' : 'no_break', severity: 'low', date: r.ymd,
        text: long
          ? `${p ? p.label : 'A member of staff'} worked ${(r.total_minutes / 60).toFixed(1)} hours on ${r.ymd}.`
          : `${p ? p.label : 'A member of staff'} worked ${(r.total_minutes / 60).toFixed(1)} hours on ${r.ymd} with no break recorded.`,
        href: `/clockin.html?staff=${r.staff_id}&date=${r.ymd}`,
      });
    }
  } catch (e) { if (!isMissingTable(e)) out.errors.push(`long days: ${e.message}`); }

  // 6. Two taps inside 60 seconds — a double-read, not two people.
  try {
    const { rows } = await db.query(
      `SELECT staff_id, event_type, event_time, prev_time,
              to_char(event_time AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS ymd,
              to_char(event_time AT TIME ZONE 'Europe/London', 'HH24:MI:SS') AS hhmmss
         FROM (
           SELECT staff_id, event_type, event_time,
                  lag(event_time) OVER (PARTITION BY staff_id ORDER BY event_time) AS prev_time
             FROM staff_clock_events_current
            WHERE (event_time AT TIME ZONE 'Europe/London')::date >= $1::date
         ) q
        WHERE prev_time IS NOT NULL AND event_time - prev_time < interval '60 seconds'
        ORDER BY event_time DESC LIMIT 60`, [sinceYmd]);
    for (const r of rows) {
      const p = who(map, r.staff_id);
      const gap = Math.round((new Date(r.event_time) - new Date(r.prev_time)) / 1000);
      out.anomalies.push({
        kind: 'double_read', severity: 'low', date: r.ymd,
        text: `Two taps ${gap}s apart for ${p ? p.label : 'a member of staff'} at ${r.hhmmss} on ${r.ymd} — `
            + 'most likely one person read twice, not two arrivals.',
        href: `/clockin.html?staff=${r.staff_id}&date=${r.ymd}`,
      });
    }
  } catch (e) { if (!isMissingTable(e)) out.errors.push(`double reads: ${e.message}`); }

  // Severity first, then most recent. The out-of-hours ones end up at the top,
  // which is the point.
  const rank = { high: 0, medium: 1, low: 2 };
  out.anomalies.sort((a, b) => (rank[a.severity] - rank[b.severity]) || (a.date < b.date ? 1 : -1));
  out.counts = out.anomalies.reduce((m, a) => { m[a.kind] = (m[a.kind] || 0) + 1; return m; }, {});

  // The hour-of-day strip, so a 03:00 outlier is visible at a glance.
  try {
    const { rows } = await db.query(
      `SELECT extract(hour from event_time AT TIME ZONE 'Europe/London')::int AS h,
              count(*)::int AS n
         FROM staff_clock_events_current
        WHERE (event_time AT TIME ZONE 'Europe/London')::date >= $1::date
        GROUP BY 1 ORDER BY 1`, [sinceYmd]);
    const byHour = new Array(24).fill(0);
    for (const r of rows) byHour[r.h] = r.n;
    out.hour_histogram = byHour;
  } catch (e) { if (!isMissingTable(e)) out.errors.push(`histogram: ${e.message}`); }

  res.json(out);
});
const mins = hhmm => Number(String(hhmm).slice(0, 2)) * 60 + Number(String(hhmm).slice(3, 5));

// ═════════════════════════════════════════════════════════════════════════════
// Out-of-hours — state, arming, alerts, and the gate self-test.
// ═════════════════════════════════════════════════════════════════════════════
async function alarmState(db) {
  const out = { available: true };
  try {
    const st = await hours.state(db);
    const armed = await alerts.isArmed(db);
    const cfg = ntfy.config();
    out.armed = armed;
    out.out_of_hours = st.out_of_hours;
    out.certain = st.certain;
    out.reason = st.reason;
    out.window = st.window;
    out.today = { date: st.ymd, weekday: st.weekday, closure: st.closure };
    out.channel = cfg;                     // configured / host / has_token. Never the token or the topic.
    // "Armed" with nowhere to send is not armed, and the tile must not imply it is.
    out.effective = armed && cfg.configured;
    out.state = !cfg.configured ? 'unavailable' : armed ? 'armed' : 'disarmed';
    if (!cfg.configured) {
      out.unavailable_reason = `No notification channel is set up (missing ${cfg.missing.join(', ')}). `
        + 'Out-of-hours alerting is designed and built but cannot deliver until ntfy is configured — '
        + 'see the b505 NOTES for the server and phone setup.';
    }
    try {
      const { rows } = await db.query(
        `SELECT id, camera_key, object_label, detected_at, delivered, suppressed,
                suppress_reason, is_test, acknowledged_at, snoozed_until
           FROM cctv_alerts ORDER BY detected_at DESC LIMIT 1`);
      out.last_alert = rows[0] || null;
    } catch (e) { if (!isMissingTable(e)) out.last_alert_error = e.message; }
  } catch (e) {
    return { available: false, reason: e.message };
  }
  return out;
}

router.get('/alarm', ...guard, async (req, res) => {
  const db = getPool();
  const state = await alarmState(db);
  const out = { ...state };
  out.next_closures = await hours.nextClosures(db, null, 3);
  try {
    const { rows } = await db.query(
      `SELECT a.id, a.camera_key, a.camera_id, a.object_label, a.detected_at,
              a.out_of_hours, a.hours_reason, a.delivered, a.delivery_error,
              a.suppressed, a.suppress_reason, a.priority, a.is_test,
              a.acknowledged_at, a.acknowledged_by, a.snoozed_until,
              a.access_log_id, a.clip_exported, c.name AS camera_name
         FROM cctv_alerts a LEFT JOIN cameras c ON c.id = a.camera_id
        ORDER BY a.detected_at DESC LIMIT 30`);
    const map = await staffMap(db);
    out.alerts = rows.map(r => ({ ...r, acknowledged_by_name: who(map, r.acknowledged_by)?.label || null }));
  } catch (e) {
    out.alerts = [];
    if (!isMissingTable(e)) out.alerts_error = e.message;
  }
  // The gate self-test. No row yet means "never run" — which is reported as
  // exactly that, never as a pass.
  try {
    const { rows } = await db.query(
      `SELECT id, ran_at, camera_key, probe, expected, actual, passed, detail
         FROM cctv_gate_tests ORDER BY ran_at DESC LIMIT 10`);
    const everLeaked = rows.some(r => r.actual != null && r.actual >= 200 && r.actual < 300);
    out.gate_test = {
      last: rows[0] || null, recent: rows,
      ever_leaked: everLeaked,
      status: !rows.length ? 'never_run' : everLeaked ? 'leaked' : rows[0].passed ? 'pass' : 'fail',
    };
  } catch (e) {
    out.gate_test = { status: 'never_run', last: null, recent: [], ever_leaked: false };
    if (!isMissingTable(e)) out.gate_test.error = e.message;
  }
  res.json(out);
});

// Arm / disarm. The setting is the control; the toggle is the UI.
router.post('/alarm/arm', ...guard, async (req, res) => {
  const db = getPool();
  const on = req.body && (req.body.on === true || req.body.on === 'on' || req.body.on === 1);
  try {
    const { rows: before } = await db.query(`SELECT value FROM settings WHERE key = 'security_alerts_armed'`);
    await db.query(
      `INSERT INTO settings (key, value) VALUES ('security_alerts_armed', $1)
       ON CONFLICT (key) DO UPDATE SET value = $1`, [on ? 'on' : 'off']);
    await recordAudit({ req, action: 'update', entity_type: 'security_hub:alerts_armed',
      entity_id: 'security_alerts_armed',
      diff: { old: { value: before[0] ? before[0].value : null }, new: { value: on ? 'on' : 'off' } } });
    res.json(await alarmState(db));
  } catch (e) {
    res.status(500).json({ error: 'arm_failed', message: e.message });
  }
});

router.post('/alarm/test', ...guard, async (req, res) => {
  const db = getPool();
  const map = await staffMap(db);
  const p = who(map, req.user.id);
  const r = await alerts.sendTest(db, { staffName: p && p.first_name });
  await recordAudit({ req, action: 'create', entity_type: 'security_hub:test_alert',
    meta: { ok: !!r.ok, error: r.error || null } });
  res.status(r.ok ? 200 : 503).json(r);
});

// One sweep, on demand. Idempotent — cctv_alerts_event_uq makes a re-read a no-op.
router.post('/alarm/sweep', ...guard, async (req, res) => {
  res.json(await alerts.sweep(getPool()));
});

router.post('/alerts/:id/ack', ...guard, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  try {
    const { rowCount } = await db.query(
      `UPDATE cctv_alerts SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1`,
      [id, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    await recordAudit({ req, action: 'update', entity_type: 'cctv_alert', entity_id: String(id),
      diff: { new: { acknowledged: true } } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'ack_failed', message: e.message }); }
});

router.post('/alerts/:id/snooze', ...guard, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const mins_ = Math.min(Math.max(parseInt(req.body && req.body.minutes, 10) || 60, 5), 720);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  try {
    const { rowCount } = await db.query(
      `UPDATE cctv_alerts SET snoozed_until = now() + ($2 || ' minutes')::interval WHERE id = $1`,
      [id, String(mins_)]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    await recordAudit({ req, action: 'update', entity_type: 'cctv_alert', entity_id: String(id),
      diff: { new: { snoozed_minutes: mins_ } } });
    res.json({ ok: true, minutes: mins_ });
  } catch (e) { res.status(500).json({ error: 'snooze_failed', message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// GET /reader-health — is the door panel's card reader actually there?
//
// Silence is not evidence of no activity. As of 2026-10-17 no fob swipe has ever
// reached Wren, and the likely reason is that the VTO4202F-MR card-reader module
// is not fitted to the panel (the bottom plate is blank). An empty fob table that
// looks like "no activity" would be the wrong thing for this page to say.
// ═════════════════════════════════════════════════════════════════════════════
async function readerHealth(db) {
  const out = { swipes_90d: null, ever_seen: null, verdict: 'unknown', message: null };
  try {
    const { rows } = await db.query(
      `SELECT count(*) FILTER (WHERE created_at >= now() - interval '90 days') ::int AS d90,
              count(*)::int AS ever
         FROM door_events
        WHERE event_type = 'card' AND reason ILIKE $1`, [fobEnrol.SWIPE_SQL_PATTERN]);
    out.swipes_90d = rows[0] ? rows[0].d90 : 0;
    out.ever_seen  = rows[0] ? rows[0].ever : 0;
  } catch (e) {
    if (!isMissingTable(e)) out.message = e.message;
    return out;
  }
  if (out.ever_seen > 0) {
    out.verdict = out.swipes_90d > 0 ? 'working' : 'quiet';
    out.message = out.swipes_90d > 0
      ? `${out.swipes_90d} fob ${out.swipes_90d === 1 ? 'tap' : 'taps'} recorded in the last 90 days.`
      : 'Fob taps have reached Wren before, but none in the last 90 days.';
    return out;
  }
  out.verdict = 'not_detected';
  out.message = 'The door panel accepts fob writes but no swipe has ever been recorded. '
    + 'The card-reader module (VTO4202F-MR) may not be fitted — see '
    + 'wren-docs/research/2026-10-17-ha-security-hardware.md §6.';
  return out;
}

router.get('/reader-health', ...guard, async (req, res) => {
  const db = getPool();
  const health = await readerHealth(db);
  // Cards present on the device with no swipe ever seen is exactly the signature
  // of a missing reader, so the banner says so only when both are true.
  const cards = await _self(req, '/api/door/device/cards', { timeout: 10_000 });
  health.device_cards = cards.ok ? ((cards.data && (cards.data.count ?? (cards.data.cards || []).length)) || 0) : null;
  health.device_reason = cards.ok ? null : cards.reason;
  health.banner = (health.verdict === 'not_detected' && (health.device_cards || 0) > 0);
  res.json(health);
});

// ═════════════════════════════════════════════════════════════════════════════
// Building (Home Assistant). The only tab that writes to the outside world, and
// deliberately the smallest.
//
// ⚠️ THIS IS THE NURSERY'S OWN HOME ASSISTANT (HA_LADN_URL), not Toby's house.
// Nothing in b505 sends anything to docker-home or to the home HA. The CCTV
// out-of-hours path goes Wren → ntfy → Toby's phone, as text, and nowhere else.
//
// ALLOW-LIST, NOT DISCOVERY-BY-DEFAULT. runDiscovery() can propose entities;
// nothing is controllable until a person has added it to ladn.ha_entities AND
// ticked enabled. An HA token that can turn on a light can also unlock a door.
//
// Locks, alarms and sirens are OUT OF SCOPE: `kind` only permits climate, light,
// switch and sensor, and the two write endpoints each accept one domain. The
// front door keeps its own gated route with its own role check; it does not move
// here.
// ═════════════════════════════════════════════════════════════════════════════
const WRITEABLE_KINDS = { climate: 'climate', light: 'light', switch: 'switch' };

function haNotConfigured(e) {
  const m = String((e && e.message) || '');
  return /HA_LADN_(URL|TOKEN)/.test(m) || /not configured/i.test(m) || /not set/i.test(m);
}
const HA_HELP = 'Home Assistant is not connected — see wren-docs/integrations/homeassistant.md';

async function haSummary(db) {
  // `configured: false` is the NORMAL state, and the page must render fully
  // without HA. No spinner that never resolves.
  let rows = [];
  try {
    const r = await db.query(
      `SELECT id, entity_id, label, kind, room, enabled FROM ha_entities ORDER BY kind, label`);
    rows = r.rows;
  } catch (e) {
    if (isMissingTable(e)) return { configured: false, reason: 'The ha_entities table does not exist yet — run the b505 migration.', entities: [] };
    return { configured: false, reason: e.message, entities: [] };
  }

  const enabled = rows.filter(r => r.enabled);
  if (!enabled.length) {
    return { configured: false, allow_list_empty: true, entities: rows,
             reason: 'No Home Assistant entity has been added to the allow-list yet. '
                   + 'Discovery can propose entities; a person enables them.' };
  }

  const out = { configured: true, entities: [], summary: {} };
  for (const r of enabled) {
    try {
      const st = await haLadn.getEntityState(r.entity_id);
      out.entities.push({
        id: r.id, entity_id: r.entity_id, label: r.label, kind: r.kind, room: r.room,
        state: st && st.state,
        // Only the three attributes the tab renders. The whole attribute blob can
        // carry anything the HA install happens to hold, so it is not passed on.
        current_temperature: st && st.attributes && st.attributes.current_temperature,
        temperature: st && st.attributes && st.attributes.temperature,
        friendly_name: st && st.attributes && st.attributes.friendly_name,
      });
    } catch (e) {
      if (haNotConfigured(e)) {
        return { configured: false, entities: rows, reason: HA_HELP };
      }
      out.entities.push({ id: r.id, entity_id: r.entity_id, label: r.label, kind: r.kind,
                          room: r.room, state: null, error: e.message });
    }
  }
  const temps = out.entities.filter(e => e.kind === 'climate' && Number.isFinite(Number(e.current_temperature)));
  const lightsOn = out.entities.filter(e => ['light', 'switch'].includes(e.kind) && e.state === 'on');
  out.summary = {
    heating: temps.length ? `${Math.round(temps.reduce((s, t) => s + Number(t.current_temperature), 0) / temps.length)}°C` : null,
    lights_on: lightsOn.length,
    text: [
      temps.length ? `Heating ${Math.round(temps.reduce((s, t) => s + Number(t.current_temperature), 0) / temps.length)}°C` : null,
      `${lightsOn.length} ${lightsOn.length === 1 ? 'light' : 'lights'} on`,
    ].filter(Boolean).join(' · '),
  };
  return out;
}

router.get('/ha/summary', ...guard, async (req, res) => {
  res.json(await haSummary(getPool()));
});

// A manual refresh that busts ha-ladn's own 60s cache. There is no second cache
// here on purpose.
router.get('/ha/discover', ...buildG, async (req, res) => {
  try {
    const [bell, release] = await Promise.all([
      haLadn.discoverDoorbellEntity().catch(e => { throw e; }),
      haLadn.discoverDoorReleaseEntity().catch(() => null),
    ]);
    res.json({ configured: true,
      proposed: [bell, release].filter(Boolean).map(e => ({ entity_id: e.entity_id,
        friendly_name: e.attributes && e.attributes.friendly_name })),
      note: 'Proposals only. Nothing is controllable until it is added to the allow-list and enabled.' });
  } catch (e) {
    if (haNotConfigured(e)) return res.json({ configured: false, reason: HA_HELP, proposed: [] });
    res.status(502).json({ configured: true, error: 'discovery_failed', message: e.message, proposed: [] });
  }
});

// ── The allow-list ───────────────────────────────────────────────────────────
router.get('/ha/entities', ...guard, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, entity_id, label, kind, room, enabled, added_by, created_at
         FROM ha_entities ORDER BY kind, label`);
    res.json({ entities: rows });
  } catch (e) {
    if (isMissingTable(e)) return res.json({ entities: [], reason: 'ha_entities does not exist yet — run the b505 migration.' });
    res.status(500).json({ error: 'list_failed', message: e.message });
  }
});

const ENTITY_ID_RE = /^(climate|light|switch|sensor)\.[a-z0-9_]{1,120}$/;

router.post('/ha/entities', ...buildG, async (req, res) => {
  const b = req.body || {};
  const entity_id = String(b.entity_id || '').trim().toLowerCase();
  const kind = String(b.kind || entity_id.split('.')[0] || '').trim();
  if (!ENTITY_ID_RE.test(entity_id)) {
    return res.status(400).json({ error: 'bad_entity_id',
      message: 'An entity id must look like climate.hallway, light.office, switch.x or sensor.y.' });
  }
  if (!['climate', 'light', 'switch', 'sensor'].includes(kind) || entity_id.split('.')[0] !== kind) {
    return res.status(400).json({ error: 'bad_kind', message: 'kind must match the entity id\'s domain.' });
  }
  try {
    const { rows } = await getPool().query(
      `INSERT INTO ha_entities (entity_id, label, kind, room, enabled, added_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (entity_id) DO UPDATE
         SET label = EXCLUDED.label, room = EXCLUDED.room, enabled = EXCLUDED.enabled
       RETURNING id, entity_id, label, kind, room, enabled`,
      [entity_id, String(b.label || entity_id).slice(0, 120), kind,
       b.room ? String(b.room).slice(0, 80) : null, b.enabled === true || b.enabled === 'true',
       req.user.id]);
    await recordAudit({ req, action: 'update', entity_type: 'ha_entity', entity_id,
      diff: { new: rows[0] } });
    res.json(rows[0]);
  } catch (e) {
    if (isMissingTable(e)) return res.status(503).json({ error: 'no_table', message: 'Run the b505 migration first.' });
    res.status(500).json({ error: 'save_failed', message: e.message });
  }
});

router.delete('/ha/entities/:id', ...buildG, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
  // Taking an entity OFF the allow-list is the safe direction, so it is a real
  // delete of a b505-owned row — not a production record. The audit row keeps
  // what it was.
  try {
    const { rows } = await getPool().query(
      `DELETE FROM ha_entities WHERE id = $1 RETURNING entity_id, label, kind, room, enabled`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    await recordAudit({ req, action: 'delete', entity_type: 'ha_entity',
      entity_id: rows[0].entity_id, diff: { old: rows[0] } });
    res.json({ ok: true, removed: rows[0] });
  } catch (e) { res.status(500).json({ error: 'delete_failed', message: e.message }); }
});

/**
 * The allow-list check that every write path goes through.
 * A client-supplied entity id NEVER reaches callService without passing here.
 */
async function allowed(db, entity_id, kind) {
  const { rows } = await db.query(
    `SELECT id, entity_id, label, kind FROM ha_entities
      WHERE entity_id = $1 AND enabled = true`, [String(entity_id || '').toLowerCase()]);
  if (!rows.length) return null;
  if (kind && rows[0].kind !== kind) return null;
  return rows[0];
}

router.post('/ha/climate', ...buildG, async (req, res) => {
  const db = getPool();
  const entity_id = String((req.body && req.body.entity_id) || '').trim().toLowerCase();
  const temperature = Number(req.body && req.body.temperature);
  if (!Number.isFinite(temperature) || temperature < 5 || temperature > 28) {
    return res.status(400).json({ error: 'bad_temperature',
      message: 'A target between 5°C and 28°C, please. A nursery radiator has no business outside that.' });
  }
  let row;
  try { row = await allowed(db, entity_id, 'climate'); }
  catch (e) { return res.status(isMissingTable(e) ? 503 : 500).json({ error: 'allow_list_unreadable', message: e.message }); }
  if (!row) {
    return res.status(403).json({ error: 'not_allow_listed',
      message: 'That entity is not on the Security hub\'s allow-list, or it is not enabled. '
             + 'Nothing was sent to Home Assistant.' });
  }
  // Read the old value first, so the audit row can say what it changed FROM.
  let oldTarget = null;
  try { const st = await haLadn.getEntityState(row.entity_id); oldTarget = st && st.attributes && st.attributes.temperature; }
  catch (e) { if (haNotConfigured(e)) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP }); }
  try {
    await haLadn.callService('climate', 'set_temperature', row.entity_id, { temperature });
  } catch (e) {
    if (haNotConfigured(e)) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });
    return res.status(502).json({ error: 'ha_call_failed', message: e.message });
  }
  // A radiator turned to 28°C overnight should be traceable.
  await recordAudit({ req, action: 'update', entity_type: 'ha_climate', entity_id: row.entity_id,
    diff: { old: { temperature: oldTarget }, new: { temperature } }, meta: { label: row.label } });
  res.json({ ok: true, entity_id: row.entity_id, temperature });
});

router.post('/ha/switch', ...buildG, async (req, res) => {
  const db = getPool();
  const entity_id = String((req.body && req.body.entity_id) || '').trim().toLowerCase();
  const on = (req.body && (req.body.on === true || req.body.on === 'true' || req.body.on === 1));
  const domain = entity_id.split('.')[0];
  if (!['light', 'switch'].includes(domain)) {
    return res.status(400).json({ error: 'bad_domain', message: 'Only light.* and switch.* entities can be toggled here.' });
  }
  let row;
  try { row = await allowed(db, entity_id, domain); }
  catch (e) { return res.status(isMissingTable(e) ? 503 : 500).json({ error: 'allow_list_unreadable', message: e.message }); }
  if (!row) {
    return res.status(403).json({ error: 'not_allow_listed',
      message: 'That entity is not on the Security hub\'s allow-list, or it is not enabled. '
             + 'Nothing was sent to Home Assistant.' });
  }
  let oldState = null;
  try { const st = await haLadn.getEntityState(row.entity_id); oldState = st && st.state; }
  catch (e) { if (haNotConfigured(e)) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP }); }
  try {
    await haLadn.callService(WRITEABLE_KINDS[domain], on ? 'turn_on' : 'turn_off', row.entity_id);
  } catch (e) {
    if (haNotConfigured(e)) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });
    return res.status(502).json({ error: 'ha_call_failed', message: e.message });
  }
  await recordAudit({ req, action: 'update', entity_type: 'ha_switch', entity_id: row.entity_id,
    diff: { old: { state: oldState }, new: { state: on ? 'on' : 'off' } }, meta: { label: row.label } });
  res.json({ ok: true, entity_id: row.entity_id, state: on ? 'on' : 'off' });
});

module.exports = router;
// Exported for scripts/b505-verify.js and for the sweep script, so neither has to
// re-implement a rule that lives here.
module.exports.readerHealth = readerHealth;
module.exports.alarmState   = alarmState;
module.exports.haSummary    = haSummary;
module.exports.allowed      = allowed;
module.exports.TIMELINE_SOURCES = TIMELINE_SOURCES;
