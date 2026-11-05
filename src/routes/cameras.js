'use strict';
/**
 * cameras.js — b234 (2026-08-26) — mounted at /api/cameras.
 *
 * CCTV viewing for the Roost (admin) portal, with the access rule that is the whole
 * point of the build:
 *
 *   • EXTERNAL cameras  — a manager may view at any time.
 *   • INTERNAL cameras  — viewable ONLY outside nursery opening hours
 *                         (Mon–Fri 08:00–18:00 Europe/London), i.e. overnight and at
 *                         weekends. Never while children are present.
 *
 * The rule is enforced HERE, on the request that mints the stream token, and again on
 * the request that actually carries video. A UI that hides a tile is not a control —
 * the tile is hidden as a courtesy, the 403 is the control.
 *
 * WHY THE RULE EXISTS (read before relaxing it): the existing CCTV policy
 * (wren-docs/cctv/LADN-CCTV-Policy-2026.md §1, §5) states that the cameras are not used
 * to monitor staff and that live viewing is not part of normal operation. Gating the
 * indoor cameras to out-of-hours is what makes that statement enforceable rather than
 * merely asserted: outside 08:00–18:00 on a weekday there are no children and no staff
 * on the premises to watch. Widening the window would reopen the exact risk the DPIA
 * balances away, and would require the DPIA to be redone first.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────────
 * Manager role AND the admin (Roost) portal, both checked server-side, in the shape
 * used by src/routes/finance-reports.js and src/routes/finance-intel.js. The role check
 * alone is not enough: a manager signing in on the EY portal holds a token with
 * audience 'learning' and that token passes requireRole('manager') on every shared
 * route. Camera footage belongs on one portal, so the portal is checked too.
 *
 * NOTE ON THE ON-SITE GATE: the door camera (src/routes/door.js) additionally refuses
 * off-site requests. This router deliberately does NOT, because the feature is
 * out-of-hours security — being able to look at the garden at 2am from home is the
 * point. The time gate is what carries the proportionality argument here, and it is
 * strictly stronger for the indoor cameras than the door camera's on-site rule.
 *
 * CREDENTIALS: cameras stores an env-var NAME, never a URL and never a password.
 * The RTSP URL is assembled by go2rtc from the container environment. The browser never
 * talks to go2rtc directly — GET /api/streams on :1984 echoes source URLs verbatim,
 * which for an RTSP camera means the password in plaintext.
 */

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── The opening-hours rule ────────────────────────────────────────────────────
// Mon–Fri 08:00–18:00, Europe/London. Containers run UTC (verified 2026-08-26), so
// every comparison below is done in explicit London wall-clock terms — never on the
// process timezone, and never on a fixed +0/+1 offset. BST is handled by ICU.
const OPEN_HOUR  = 8;    // 08:00 — nursery opens
const CLOSE_HOUR = 18;   // 18:00 — nursery closes
const TZ = 'Europe/London';

const _londonParts = (d) => {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const part of dtf.formatToParts(d)) p[part.type] = part.value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: p.weekday,                       // 'Mon' … 'Sun'
  };
};

// ms to ADD to a London wall-clock reading to get UTC: +1h during BST, 0 during GMT.
function _londonOffsetMs(d) {
  const p = _londonParts(d);
  const asIfUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUTC - (d.getTime() - (d.getTime() % 1000));
}

// The UTC instant of a given London wall-clock time on the London calendar day of `ref`,
// optionally `dayOffset` days later. Two-pass so a DST change between `ref` and the
// target hour cannot shift the answer by an hour.
function _londonInstant(ref, hour, dayOffset = 0) {
  const p = _londonParts(ref);
  const naive = Date.UTC(p.year, p.month - 1, p.day + dayOffset, hour, 0, 0);
  let inst = new Date(naive - _londonOffsetMs(ref));
  inst = new Date(naive - _londonOffsetMs(inst));
  return inst;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

/** True while the nursery is open: Mon–Fri, 08:00 ≤ t < 18:00 London. */
function isNurseryOpen(now) {
  const p = _londonParts(now);
  if (!WEEKDAYS.includes(p.weekday)) return false;
  const mins = p.hour * 60 + p.minute;
  return mins >= OPEN_HOUR * 60 && mins < CLOSE_HOUR * 60;
}

/**
 * The authorisation decision for one camera at one instant. Pure — no DB, no req —
 * so it can be unit-tested against a stubbed clock, which is how the rule is proved.
 * Exported for tests.
 */
function evaluateAccess(camera, now) {
  if (!camera) {
    return { viewable: false, reason: 'No such camera.', code: 'not_found', available_from: null };
  }
  if (camera.enabled === false) {
    return {
      viewable: false, code: 'camera_disabled', available_from: null,
      reason: 'This camera is registered but not switched on. The nursery\'s cameras stay '
            + 'disabled until the CCTV paperwork is signed off.',
    };
  }
  if (camera.location === 'external') {
    return {
      viewable: true, code: 'external_any_time', available_from: null,
      reason: 'External camera — viewable at any time by a manager.',
    };
  }
  // Internal: out-of-hours only.
  if (!isNurseryOpen(now)) {
    return {
      viewable: true, code: 'out_of_hours', available_from: null,
      reason: 'Internal camera, outside opening hours — viewable.',
    };
  }
  const from = _londonInstant(now, CLOSE_HOUR);
  return {
    viewable: false, code: 'within_opening_hours',
    available_from: from.toISOString(),
    reason: 'Internal cameras cannot be viewed while the nursery is open. The nursery is '
          + 'open Monday to Friday, 08:00–18:00. This camera becomes available at 18:00 today.',
  };
}

/**
 * Next moment each internal camera becomes viewable, for the countdown on a tile that
 * is currently blocked. Weekends and after 18:00 are already viewable, so this only
 * ever returns 18:00 on the current weekday.
 */

// ── The guard ─────────────────────────────────────────────────────────────────
// Same shape and same wording as finance-reports.js. req._portal is set by the
// hostname dispatcher in editions/ladn/server-unified.js; a request with no portal is
// refused rather than defaulted, because failing open on a camera route is not a
// trade-off worth making.
function managerAdminOnly(req, res, next) {
  const portal = req._portal || null;
  if (portal !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'Cameras are available on the Roost (admin) portal only.',
    });
  }
  if (!req.user || !hasRole(req.user, ['manager', 'admin'])) {
    return res.status(403).json({
      error: 'forbidden_role',
      message: 'Manager access only — CCTV of a nursery is not a general staff screen.',
    });
  }
  next();
}
const guard = [authenticate, managerAdminOnly];

// The same role/portal check, but for the SESSION route, where a refusal is itself a
// view attempt on a named camera and therefore has to be audited. "There is no view
// path that does not audit" has to include the paths that end in 403 — a practitioner
// repeatedly trying the Baby Room camera is exactly what an audit trail is for.
// Ordered after authenticate, so req.user is populated and the row names somebody.
async function auditedManagerAdminOnly(req, res, next) {
  const portal = req._portal || null;
  const bad = portal !== 'admin'
    ? { error: 'forbidden_portal', message: 'Cameras are available on the Roost (admin) portal only.' }
    : (!req.user || !hasRole(req.user, ['manager', 'admin']))
      ? { error: 'forbidden_role', message: 'Manager access only — CCTV of a nursery is not a general staff screen.' }
      : null;
  if (!bad) return next();
  const camId = parseInt(req.params?.id, 10);
  try {
    await audit(req, {
      cameraId: Number.isFinite(camId) ? camId : null,
      action: 'view_stream',
      granted: false,
      reason: `REFUSED (${bad.error}): ${bad.message} [portal=${portal || 'none'}, role=${req.user?.role || 'none'}]`,
    });
  } catch (e) {
    console.error('[cameras] refusal audit failed:', e.message);
  }
  return res.status(403).json(bad);
}

// ── b505 — the capability gate, ON TOP of the gates above ────────────────────
// There was no camera capability before b505: this router gated on the manager
// role AND the Roost portal, and door.js on staff.access-fobs. Those gates STAY.
// This one is COMPOSED with them — `existing gate AND requireCapability(...)` —
// so it can only ever NARROW access. It is never a way for a non-manager, or for
// a manager on the wrong portal, to reach footage, and it does not touch the
// opening-hours rule, which is still evaluated below on every single request.
//
// It audits its own refusals, for the same reason auditedManagerAdminOnly does:
// somebody repeatedly trying to open a camera they are not allowed to open is
// precisely what the access log exists to surface, and a refusal that leaves no
// row makes the log a partial record.
//
// src/lib/capabilities.js lists these three in MATRIX_REQUIRED_CAPS so the floor
// manager's blanket pass does not cover them; without that this gate would be
// decorative and the Permissions screen would be lying about controlling it.
const { hasCapability } = require('../lib/capabilities');

function auditedCapability(capKey, action) {
  return async function (req, res, next) {
    let ok = false;
    try { ok = await hasCapability(req.user, capKey); }
    catch (e) { ok = false; }        // hasCapability already fails closed; so does this
    if (ok) return next();
    const camId = parseInt(req.params?.id, 10);
    try {
      await audit(req, {
        cameraId: Number.isFinite(camId) ? camId : null,
        action, granted: false,
        reason: `REFUSED (capability_forbidden): ${capKey} is not granted to `
              + `${req.user?.first_name || 'this user'} (role=${req.user?.role || 'none'}).`,
      });
    } catch (e) {
      console.error('[cameras] capability refusal audit failed:', e.message);
    }
    return res.status(403).json({
      error: 'capability_forbidden', capability: capKey,
      message: `You do not hold the "${capKey}" permission. A manager can grant it on the Permissions screen.`,
    });
  };
}

// ── Audit ─────────────────────────────────────────────────────────────────────
// Every decision, granted or refused, lands here. Awaited rather than fired and
// forgotten: if the audit cannot be written, the view is refused. An unlogged view of
// nursery CCTV is worse than no view.
async function audit(req, { cameraId, action, granted, reason,
                            triggerReason, triggerNote, incidentRef,
                            footageFrom, footageTo, requestId }) {
  const db = getPool();
  const { rows } = await db.query(
    `INSERT INTO camera_access_log
       (staff_id, camera_id, action, granted, reason, ip, user_agent,
        trigger_reason, trigger_note, incident_ref, footage_from, footage_to, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      req.user?.id || null,
      cameraId || null,
      String(action).slice(0, 32),
      !!granted,
      reason ? String(reason).slice(0, 2000) : null,
      String(req.ip || req.socket?.remoteAddress || '').slice(0, 64),
      String(req.headers['user-agent'] || '').slice(0, 1000),
      triggerReason ? String(triggerReason).slice(0, 48) : null,
      triggerNote ? String(triggerNote).slice(0, 2000) : null,
      incidentRef ? String(incidentRef).slice(0, 200) : null,
      footageFrom || null,
      footageTo || null,
      Number.isFinite(requestId) ? requestId : null,
    ],
  );
  return rows[0] && rows[0].id;
}

// ═════════════════════════════════════════════════════════════════════════════
// b249 §5 — THE ACCESS LOG THE PAPER FORM AND THE PRIVACY NOTICE DEMAND
//
// b234 logged who / which camera / when / granted / the rule that decided it.
// That is the machine's reason. The paper log ("CCTV Access Log - Your Nursery
// Day Nursery.docx") asks for the HUMAN one, and the privacy notice parents are
// being asked to sign promises them it is recorded:
//
//     "Only Nursery Manager (Owner/Manager), and only when a specific incident
//      requires it. Every single access is logged with the reason."
//
// CCTV Policy §3 enumerates the FIVE triggers and says "No other access is
// permitted". So a view request without one of them is not a view we are
// allowed to grant — and that refusal is itself logged, because an attempt to
// watch a room of children without a stated reason is precisely the thing an
// audit trail exists to surface.
//
// This is a deliberate behaviour change to POST /:id/session: it now requires a
// trigger. The alternative — defaulting the trigger — would put a fabricated
// justification in a legal record, which is worse than no record at all.
// ═════════════════════════════════════════════════════════════════════════════
const VIEW_TRIGGERS = new Set(['safeguarding', 'accident', 'complaint', 'security', 'statutory', 'install_test']);
const TRIGGER_LABEL = {
  safeguarding: 'Safeguarding concern or allegation (policy §3.1)',
  accident:     'Accident or injury with an unclear or disputed cause (policy §3.2)',
  complaint:    'Complaint from a parent, carer or member of staff (policy §3.3)',
  security:     'Security incident — break-in, damage, intruder, missing property (policy §3.4)',
  statutory:    'Lawful request from police, Ofsted, the LADO or another statutory agency (policy §3.5)',
  // §5 permits live viewing during installation and testing. It is a legitimate
  // reason to open a stream and it is not one of the five incident triggers, so
  // it is named rather than smuggled in under "security".
  install_test: 'Installation / camera positioning test (policy §5)',
};

// ── Clock stub, dev only ──────────────────────────────────────────────────────
// The time rule has to be provable, and a rule you can only test twice a day is a rule
// nobody tests. ?_now=<ISO8601> overrides the clock — but ONLY on a dev database, and
// the override is written into the audit row so it can never be used silently.
// PG_DB is 'wren_dev' on wren-ladn-dev and 'wren' in production, so this is fail-closed
// in prod with no compose change required.
const CLOCK_STUB_ALLOWED = /_dev$/.test(String(process.env.PG_DB || ''));
function clockFrom(req) {
  const raw = req.query?._now;
  if (!raw) return { now: new Date(), stubbed: false };
  if (!CLOCK_STUB_ALLOWED) return { now: new Date(), stubbed: false, refused: true };
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) return { now: new Date(), stubbed: false, refused: true };
  return { now: d, stubbed: true };
}
const stubNote = c => (c.stubbed ? ` [CLOCK STUBBED to ${c.now.toISOString()} — dev database only]` : '');

const londonClock = (d) => {
  const p = _londonParts(d);
  return {
    iso: d.toISOString(),
    london: `${p.weekday} ${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')}/${p.year} `
          + `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`,
    nursery_open: isNurseryOpen(d),
  };
};

const RULE = {
  opening_hours: 'Mon–Fri 08:00–18:00',
  timezone: TZ,
  external: 'Viewable at any time by a manager.',
  internal: 'Viewable only outside opening hours — overnight and at weekends.',
  audited: 'Every view request is logged to camera_access_log, including refusals.',
};

// ═════════════════════════════════════════════════════════════════════════════
// b362 (2026-09-29) — WHICH CAMERAS EXIST.
//
// `cameras` holds six rows that were written in b234 as placeholders for hardware
// that was never bought: baby_room, pre_school, hallway, garden, front_entrance,
// rear_yard. A LAN scan on 2026-09-29 found no RTSP device other than the Dahua
// door station, and go2rtc's entries for those six expand ${CAM_*_HOST} variables
// that are deliberately unset. So the screen was offering six cameras that cannot
// be watched because they are not there.
//
// Toby: "Wren's Cameras page shows only cameras that exist."
//
// The rows are NOT deleted — they are the record of the planned install and
// cctv_footage_requests has a foreign key into this table. Instead an allowlist
// says which keys are in service, and everything else is simply absent from the
// UI and refused a session.
//
// In precedence order:
//   1. settings.cameras_in_service    CSV of keys; per-database, so dev-only
//   2. process.env.CAMERAS_IN_SERVICE CSV of keys
//   3. 'door'                         the one camera that physically exists
//
// A tile that is not rendered is a courtesy; the refusal in the session route is
// the control — the same rule this file already applies to the time gate.
// ═════════════════════════════════════════════════════════════════════════════
const DEFAULT_IN_SERVICE = ['door'];
let _inServiceCache = { at: 0, keys: null };
const IN_SERVICE_CACHE_MS = 30_000;

const _parseKeys = s => String(s || '')
  .split(',').map(k => k.trim().toLowerCase()).filter(Boolean);

async function camerasInService(db) {
  if (_inServiceCache.keys && Date.now() - _inServiceCache.at < IN_SERVICE_CACHE_MS) {
    return _inServiceCache.keys;
  }
  let keys = [];
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'cameras_in_service'`);
    keys = _parseKeys(rows[0] && rows[0].value);
  } catch (e) {
    console.warn('[cameras] in-service settings read failed:', e.message);
  }
  if (!keys.length) keys = _parseKeys(process.env.CAMERAS_IN_SERVICE);
  if (!keys.length) keys = DEFAULT_IN_SERVICE.slice();
  _inServiceCache = { at: Date.now(), keys };
  return keys;
}

// ── GET /api/cameras ──────────────────────────────────────────────────────────
// The list, with viewable_now and reason computed on the server. The UI renders what
// this says; it does not decide anything itself.
router.get('/', guard, async (req, res) => {
  try {
    const clock = clockFrom(req);
    const db = getPool();
    const { rows: allRows } = await db.query(
      `SELECT id, key, name, location, enabled, stream_profile, created_at
         FROM cameras ORDER BY location DESC, name ASC`,
    );
    // b362 — only cameras that exist. ?include_planned=1 shows the rest, badged,
    // so the placeholder rows stay inspectable without being offered as cameras.
    const inService = await camerasInService(db);
    const includePlanned = String(req.query.include_planned || '') === '1';
    const rows = includePlanned ? allRows : allRows.filter(c => inService.includes(String(c.key).toLowerCase()));
    const cameras = rows.map((c) => {
      const v = evaluateAccess(c, clock.now);
      // b362 — a camera that is not in service is never viewable, whatever the
      // time rule says about it. Belt and braces: the six placeholder rows are
      // also enabled=false, so evaluateAccess already refuses them — but that is
      // a data fact and this is the rule, and the rule should not depend on it.
      const live = inService.includes(String(c.key).toLowerCase());
      return {
        id: c.id, key: c.key, name: c.name, location: c.location,
        enabled: c.enabled, stream_profile: c.stream_profile,
        in_service: live,
        viewable_now: live && v.viewable,
        reason: live ? v.reason
          : 'Not installed. This row is the planned position from the CCTV install — there is no camera at it.',
        code: live ? v.code : 'not_in_service',
        available_from: live ? v.available_from : null,
      };
    });
    res.json({
      cameras, rule: RULE, clock: londonClock(clock.now), clock_stubbed: !!clock.stubbed,
      in_service: inService,
      planned_count: allRows.length - rows.length,
    });
  } catch (e) {
    console.error('[cameras] list failed:', e.message);
    res.status(500).json({ error: 'list_failed', message: e.message });
  }
});

// ── Stream sessions ───────────────────────────────────────────────────────────
// A <video> element cannot send an Authorization header, so the caller swaps its JWT
// for a short-lived single-purpose token — same approach as the Door card, and for the
// same reason: URLs end up in history, logs and referrers, and a 60s camera token does
// far less damage there than a staff JWT would.
const GO2RTC = process.env.GO2RTC_URL || 'http://wren-go2rtc:1984';

// ── b362 — where go2rtc actually is ──────────────────────────────────────────
// editions/ladn/.env sets GO2RTC_URL=http://172.31.0.1:1984, which TIMES OUT from
// inside the container (measured 2026-09-29 from wren-ladn-dev). go2rtc publishes
// :1984 on 127.0.0.1 only, so the bridge-gateway address has nothing listening —
// the env var is strictly worse than this file's own default, and it overrides it.
// The container name DOES work: wren-go2rtc is on wren-net and answers
// /api/streams (verified). So live view has been broken by that line, and the env
// var cannot be corrected for dev alone because prod loads the same .env file.
// settings.cctv_go2rtc_url is a per-database override; the NOTES file carries the
// one-line prod fix.
async function go2rtcBase(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'cctv_go2rtc_url'`);
    const v = String((rows[0] && rows[0].value) || '').trim().replace(/\/+$/, '');
    if (v) return v;
  } catch (e) {
    console.warn('[cameras] go2rtc settings read failed:', e.message);
  }
  return GO2RTC;
}
const SESSION_TTL_MS = 60_000;
const _sessions = new Map();   // token -> { staffId, cameraId, key, profile, expires }

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _sessions) if (v.expires < now) _sessions.delete(k);
}, 60_000).unref?.();

// go2rtc stream name for a camera: 'garden' → 'garden' (main) / 'garden_sub' (sub).
const streamName = (cam) => (cam.stream_profile === 'sub' ? `${cam.key}_sub` : cam.key);

// ── cot cam (2026-11-02) — LAN-only cameras are never proxied ────────────────
// A camera with cameras.lan_only = true (the Baby Room cot cam) is viewed on the
// nursery LAN straight from the Z420 gateway — see src/routes/cot-cam.js. Every view
// path in THIS file carries video through Wren, i.e. through docker-work, which is not
// at the nursery; "no CCTV leaves the building" means such a camera must be refused
// here whatever the time rule or the in-service list say. Fails closed on the key, and
// tolerates a database where the lan_only column has not been added yet.
async function isLanOnly(db, cam) {
  if (!cam) return false;
  if (String(cam.key).toLowerCase() === 'cot_cam') return true;
  try {
    const { rows } = await db.query(`SELECT lan_only FROM cameras WHERE id=$1`, [cam.id]);
    return !!(rows[0] && rows[0].lan_only);
  } catch (e) { return false; }
}

// POST /api/cameras/:id/session — THE authorisation point.
router.post('/:id/session', authenticate, auditedManagerAdminOnly,
            auditedCapability('security.cameras-view', 'view_stream'),
            express.json({ limit: '8kb' }), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const clock = clockFrom(req);
  // b249 §5 — the stated reason, before anything else. Read from the body or the
  // query so the manual test scripts and the UI can both drive it.
  const b = req.body || {};
  const trigger = String(b.trigger_reason || req.query.trigger_reason || '').trim();
  const triggerNote = String(b.trigger_note || req.query.trigger_note || '').trim();
  const incidentRef = String(b.incident_ref || req.query.incident_ref || '').trim();
  const requestId = parseInt(b.request_id || req.query.request_id, 10);
  try {
    const db = getPool();

    // No trigger, no view. Refused BEFORE the camera is looked up, and the
    // refusal is logged with the same weight as any other — see the block above.
    if (!VIEW_TRIGGERS.has(trigger)) {
      await audit(req, {
        cameraId: Number.isFinite(id) ? id : null,
        action: 'view_stream',
        granted: false,
        reason: 'REFUSED (no_trigger): a view of CCTV must state which of the CCTV Policy §3 triggers applies. '
              + `Given: ${trigger ? JSON.stringify(trigger.slice(0, 40)) : '(none)'}.`,
      });
      return res.status(400).json({
        error: 'no_trigger',
        message: 'Say why you are opening this camera. CCTV Policy §3 permits access only for a specific '
               + 'incident, and the reason is recorded in the access log.',
        triggers: TRIGGER_LABEL,
      });
    }
    const { rows } = await db.query(
      `SELECT id, key, name, location, enabled, stream_profile FROM cameras WHERE id=$1`, [id],
    );
    const cam = rows[0] || null;

    // b362 — the control behind the hidden tile. A camera that is not in service
    // cannot be opened even by id, and the attempt is logged like any other.
    if (cam && !(await camerasInService(db)).includes(String(cam.key).toLowerCase())) {
      await audit(req, {
        cameraId: cam.id, action: 'view_stream', granted: false,
        reason: `REFUSED (not_in_service): "${cam.name}" is a planned camera position, not an installed camera. `
              + 'There is no device at it and nothing to stream.',
        triggerReason: trigger, triggerNote, incidentRef, requestId,
      });
      return res.status(409).json({
        error: 'not_in_service',
        message: `"${cam.name}" is a planned camera position from the CCTV install — there is no camera there yet.`,
      });
    }

    if (await isLanOnly(db, cam)) {
      await audit(req, {
        cameraId: cam.id, action: 'view_stream', granted: false,
        reason: `REFUSED (lan_only): "${cam.name}" is viewed on the nursery LAN only (Nest → Cot cam); `
              + 'it is never proxied through Wren.',
        triggerReason: trigger, triggerNote, incidentRef, requestId,
      });
      return res.status(409).json({
        error: 'lan_only',
        message: `"${cam.name}" can only be viewed on the nursery Wi-Fi, from Nest → Cot cam.`,
      });
    }

    const v = evaluateAccess(cam, clock.now);

    if (!v.viewable) {
      // Refusals are audited exactly as loudly as grants.
      await audit(req, {
        cameraId: cam ? cam.id : null,
        action: 'view_stream',
        granted: false,
        reason: `REFUSED (${v.code}): ${v.reason}${stubNote(clock)}`,
        triggerReason: trigger, triggerNote, incidentRef, requestId,
      });
      return res.status(cam ? 403 : 404).json({
        error: v.code, message: v.reason,
        available_from: v.available_from, rule: RULE, clock: londonClock(clock.now),
      });
    }

    // The log row is written and its id kept BEFORE a token is minted. If this
    // insert throws, the catch below returns 500 and no token exists — so there
    // is no path on which a stream opens without a row naming who, which camera
    // and under which trigger. An unlogged view of nursery CCTV is worse than no
    // view: it is the one thing the privacy notice promises cannot happen.
    const logId = await audit(req, {
      cameraId: cam.id,
      action: 'view_stream',
      granted: true,
      reason: `GRANTED (${v.code}): ${v.reason}${stubNote(clock)}`,
      triggerReason: trigger, triggerNote, incidentRef, requestId,
    });
    if (!logId) throw new Error('access log row was not written — refusing to open the stream');

    const token = crypto.randomBytes(24).toString('hex');
    _sessions.set(token, {
      staffId: req.user.id, cameraId: cam.id, key: cam.key,
      profile: cam.stream_profile, expires: Date.now() + SESSION_TTL_MS,
    });
    res.json({
      token, expires_in: SESSION_TTL_MS / 1000,
      url: `/api/cameras/stream.mp4?t=${token}`,
      camera: { id: cam.id, key: cam.key, name: cam.name, location: cam.location },
      reason: v.reason, clock: londonClock(clock.now), clock_stubbed: !!clock.stubbed,
      // b249: the row this view is recorded on. The viewer sends the outcome
      // back to it when the manager closes the stream — the paper log's
      // "Outcome / Action Taken" and "Exported?" columns.
      access_log_id: logId,
      trigger: { key: trigger, label: TRIGGER_LABEL[trigger] },
    });
  } catch (e) {
    console.error('[cameras] session failed:', e.message);
    res.status(500).json({ error: 'session_failed', message: e.message });
  }
});

// GET /api/cameras/stream.mp4?t=… — the video itself, proxied.
// The time rule is re-checked here against the LIVE clock, never the stubbed one: a
// token minted at 17:59:59 must not keep streaming an indoor camera into the day.
router.get('/stream.mp4', async (req, res) => {
  const s = _sessions.get(String(req.query.t || ''));
  if (!s || s.expires < Date.now()) {
    _sessions.delete(String(req.query.t || ''));
    return res.status(403).json({ error: 'bad_session' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, key, name, location, enabled, stream_profile FROM cameras WHERE id=$1`, [s.cameraId],
    );
    const cam = rows[0] || null;
    if (await isLanOnly(db, cam)) {
      _sessions.delete(String(req.query.t || ''));
      return res.status(409).json({ error: 'lan_only' });
    }
    const v = evaluateAccess(cam, new Date());
    if (!v.viewable) {
      _sessions.delete(String(req.query.t || ''));
      return res.status(403).json({ error: v.code, message: v.reason });
    }
    const url = `${await go2rtcBase(db)}/api/stream.mp4?src=${encodeURIComponent(streamName(cam))}`;
    const up = require('http').get(url, { timeout: 8000 }, (r) => {
      res.writeHead(r.statusCode, {
        'Content-Type': r.headers['content-type'] || 'video/mp4',
        'Cache-Control': 'no-store, private',
      });
      r.pipe(res);
    });
    // 2026-10-05: an unreachable door station / camera used to hang this request for minutes.
    up.on('timeout', () => up.destroy(new Error('upstream_timeout')));
    up.on('error', (e) => {
      console.warn('[cameras] stream proxy failed:', e.message);
      if (!res.headersSent) res.status(503).json({ error: 'stream_unavailable', message: e.message });
    });
    // Drop the upstream pull the moment the viewer goes away, so a closed laptop does
    // not leave go2rtc pulling RTSP for nobody.
    res.on('close', () => up.destroy());
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: 'stream_failed', message: e.message });
  }
});

// ── GET /api/cameras/access-log ───────────────────────────────────────────────
// Who watched what. The point of an audit trail is that somebody reads it.
router.get('/access-log', guard, async (req, res) => {
  try {
    const db = getPool();
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const vals = [];
    const where = [];
    if (req.query.camera_id) { vals.push(parseInt(req.query.camera_id, 10)); where.push(`l.camera_id = $${vals.length}`); }
    if (req.query.granted === '0') where.push('l.granted = false');
    if (req.query.granted === '1') where.push('l.granted = true');
    const days = parseInt(req.query.days, 10);
    if (Number.isFinite(days) && days > 0) {
      vals.push(String(Math.min(days, 365)));
      where.push(`l.created_at >= NOW() - ($${vals.length} || ' days')::interval`);
    }
    vals.push(limit);
    const { rows } = await db.query(
      `SELECT l.id, l.staff_id, l.camera_id, l.action, l.granted, l.reason, l.ip,
              l.user_agent, l.created_at,
              l.trigger_reason, l.trigger_note, l.incident_ref, l.footage_from,
              l.footage_to, l.outcome, l.exported, l.deleted_on, l.request_id,
              r.reference AS request_reference,
              c.name AS camera_name, c.location,
              TRIM(COALESCE(s.first_name,'') || ' ' || COALESCE(s.last_name,'')) AS staff_name,
              TRIM(COALESCE(a.first_name,'') || ' ' || COALESCE(a.last_name,'')) AS authorised_by_name
         FROM camera_access_log l
         LEFT JOIN cameras c ON c.id = l.camera_id
         LEFT JOIN staff   s ON s.id = l.staff_id
         LEFT JOIN staff   a ON a.id = l.authorised_by
         LEFT JOIN cctv_footage_requests r ON r.id = l.request_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY l.created_at DESC
        LIMIT $${vals.length}`,
      vals,
    );
    res.json({ entries: rows, rule: RULE, triggers: TRIGGER_LABEL, retention: ACCESS_LOG_RETENTION });
  } catch (e) {
    console.error('[cameras] access-log failed:', e.message);
    res.status(500).json({ error: 'log_failed', message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// b249 §5 — completing a log row after the fact.
//
// The paper log has three columns that cannot be known when the stream opens:
// "Outcome / Action Taken", "Exported? (Y/N)" and "Deleted On". They are filled
// in when the manager closes the viewer or comes back to the row later.
//
// This route can only ADD to a row. It cannot change who watched, which camera,
// when, whether it was granted, or under which trigger — those are the record
// of what happened and are written once, by the server, at the moment it
// happened. A log you can edit is not a log.
// ═════════════════════════════════════════════════════════════════════════════
const ACCESS_LOG_RETENTION = '3 years (CCTV Access Log: "Retain this log for 3 years")';

router.patch('/access-log/:id', ...guard, express.json({ limit: '8kb' }), async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const sets = [];
    const vals = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.outcome != null)    put('outcome', String(b.outcome).slice(0, 2000) || null);
    if (b.exported != null)   put('exported', !!b.exported);
    if (b.deleted_on != null) put('deleted_on', /^\d{4}-\d{2}-\d{2}$/.test(String(b.deleted_on)) ? b.deleted_on : null);
    if (b.incident_ref != null) put('incident_ref', String(b.incident_ref).slice(0, 200) || null);
    // "Authorised By" defaults to the person filling the row in, because in this
    // setting the manager who authorises and the manager who watches are usually
    // the same person — but it is stored separately so it can differ.
    if (b.authorised_by === 'me') put('authorised_by', req.user.id);
    if (!sets.length) return res.status(400).json({ error: 'nothing_to_change' });
    vals.push(id);
    const { rows } = await db.query(
      `UPDATE camera_access_log SET ${sets.join(', ')} WHERE id = $${vals.length}
       RETURNING id, outcome, exported, deleted_on, incident_ref, authorised_by`, vals);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, entry: rows[0] });
  } catch (e) {
    console.error('[cameras] access-log patch failed:', e.message);
    res.status(500).json({ error: 'log_update_failed', message: e.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// b362 (2026-09-29) — RECORDINGS. APPENDED; everything above is untouched.
//
// Until 2026-09-28 there was no recorder: go2rtc restreams and stores nothing, so
// "have you got footage of Tuesday" had no answer at all. Frigate 0.14.1 now runs
// on the Z420 AT THE NURSERY and records the door camera to /srv/frigate. This is
// the read path onto it.
//
// THE RULES THIS SECTION INHERITS, NOT RELAXES
//   • Manager role AND the Roost portal, server-side, on every route.
//   • Footage reaches a screen only under one of the CCTV Policy §3 triggers, and
//     the trigger is written to camera_access_log BEFORE any video moves — the
//     same order as the live path: no log row, no token.
//   • Wren proxies every byte. The browser is never given the recorder's address,
//     so nothing on the nursery LAN is reachable from a Roost page.
//   • Nothing here is public and nothing here is cached.
//
// FOOTAGE NEVER LEAVES THE BUILDING (locked decision, wren-docs). The recorder is
// on the nursery LAN; Wren reaches it over Tailscale and hands bytes to a manager's
// browser. No frame is sent to any model, any cloud service or any third party.
// ═════════════════════════════════════════════════════════════════════════════
const frigate = require('../lib/frigate');

// CCTV Policy v1.1 §4. The DPIA considered 30 days and rejected it, so 7 is a
// decision on the record, not a default — which is why a recorder configured for
// longer is a finding and not a preference.
const POLICY_RETENTION_FALLBACK_DAYS = 7;

async function policyRetentionDays(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key = 'cctv_retention_days'`);
    const n = parseInt(String((rows[0] && rows[0].value) || ''), 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (e) {
    console.warn('[cameras] retention setting read failed:', e.message);
  }
  return POLICY_RETENTION_FALLBACK_DAYS;
}

/**
 * Midnight-to-midnight London for a YYYY-MM-DD, as UTC instants.
 * Two-pass for the same reason _londonInstant is: a DST change inside the day
 * must not move its boundaries by an hour. Returns null on a malformed date
 * rather than guessing one.
 */
function _londonDayRange(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const resolve = (naive) => {
    let inst = new Date(naive - _londonOffsetMs(new Date(naive)));
    return new Date(naive - _londonOffsetMs(inst));
  };
  const start = resolve(Date.UTC(y, mo - 1, d, 0, 0, 0));
  const end   = resolve(Date.UTC(y, mo - 1, d + 1, 0, 0, 0));
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  return { start, end };
}

/** Load a camera by id and confirm it is one that exists. Never 500s on a bad id. */
async function loadServiceCamera(db, id) {
  if (!Number.isFinite(id)) return { cam: null, code: 'bad_id', message: 'Not a camera id.' };
  const { rows } = await db.query(
    `SELECT id, key, name, location, enabled, stream_profile FROM cameras WHERE id = $1`, [id]);
  const cam = rows[0] || null;
  if (!cam) return { cam: null, code: 'not_found', message: 'No such camera.' };
  const live = (await camerasInService(db)).includes(String(cam.key).toLowerCase());
  if (!live) {
    return { cam, code: 'not_in_service',
      message: `"${cam.name}" is a planned camera position from the CCTV install — there is no camera there, `
             + 'so it has recorded nothing.' };
  }
  return { cam, code: null, message: null };
}

// ── GET /api/cameras/recordings/status ───────────────────────────────────────
// Is there a recorder, where is it, what is it keeping, and does that match the
// policy? One call, so the screen never has to infer any of it.
router.get('/recordings/status', guard, async (req, res) => {
  const db = getPool();
  try {
    const base   = await frigate.baseUrl(db, { fresh: true });
    const source = await frigate.addressSource(db);
    const reach  = await frigate.reachable(base);
    const policyDays = await policyRetentionDays(db);
    const inService  = await camerasInService(db);

    const out = {
      configured: !!base,
      address_source: source,
      // The address itself is deliberately NOT returned. It is the location of a
      // recorder holding footage of children on a private network, and a browser
      // has no use for it — every request goes through this server.
      reachable: reach.ok,
      recorder_error: reach.error,
      recorder_version: reach.version,
      in_service: inService,
      policy_days: policyDays,
      policy_source: 'CCTV Policy v1.1 §4 — the DPIA considered 30 days and rejected it.',
      retention: null,
      retention_breach: false,
      retention_message: null,
      unknown_to_recorder: [],
    };

    if (!base) {
      out.retention_message = 'No recorder address is set, so Wren cannot say what is being kept or for how long.';
      return res.json(out);
    }
    if (!reach.ok) {
      out.retention_message = 'The recorder did not answer, so its retention could not be read. '
        + 'This is not evidence that it is compliant.';
      return res.json(out);
    }

    let ret;
    try {
      ret = await frigate.retention(base, null);
    } catch (e) {
      out.retention_message = `The recorder answered but its configuration could not be read: ${e.message}`;
      return res.json(out);
    }
    out.retention = ret;

    // Which in-service cameras does the recorder not know about? A camera Wren
    // offers that Frigate is not recording is a gap worth naming, not hiding.
    const known = new Set(ret.cameras.map(c => c.camera));
    out.unknown_to_recorder = inService.filter(k => !known.has(k));

    // The breach test runs over the cameras that are actually recording, and over
    // the MAXIMUM of the three independent clocks Frigate keeps.
    const over = ret.cameras
      .filter(c => c.recording_enabled && c.max_days != null && c.max_days > policyDays)
      .map(c => ({
        camera: c.camera, max_days: c.max_days,
        continuous_days: c.continuous_days, event_days: c.event_days, snapshot_days: c.snapshot_days,
      }));
    out.retention_breach = over.length > 0;
    out.retention_over = over;
    if (over.length) {
      const worst = Math.max(...over.map(o => o.max_days));
      out.retention_message =
        `The recorder is configured to keep footage for up to ${worst} days. CCTV Policy v1.1 §4 says `
        + `${policyDays} days, and the DPIA rejected a longer period. Keeping more than the policy states is `
        + 'a GDPR storage-limitation problem in itself, and it makes the privacy notice families have signed '
        + 'inaccurate. Wren cannot change the recorder — the fix is on the Z420 and is written up for Toby.';
    } else {
      out.retention_message = `The recorder's retention is within the ${policyDays}-day policy.`;
    }
    res.json(out);
  } catch (e) {
    console.error('[cameras] recordings status failed:', e.message);
    res.status(500).json({ error: 'status_failed', message: e.message });
  }
});

// ── GET /api/cameras/:id/recordings/summary ──────────────────────────────────
// Which days have footage, and how much in each hour of them. Metadata only —
// not audited as a view, because no frame is served.
router.get('/:id/recordings/summary', ...guard,
           auditedCapability('security.recordings-view', 'list_recordings'), async (req, res) => {
  const db = getPool();
  try {
    const { cam, code, message } = await loadServiceCamera(db, parseInt(req.params.id, 10));
    if (code) return res.status(code === 'not_found' || code === 'bad_id' ? 404 : 409).json({ error: code, message });
    const base = await frigate.baseUrl(db);
    if (!base) return res.status(503).json({ error: 'no_recorder', message: 'No recorder address is configured.' });
    const days = await frigate.recordingsSummary(base, cam.key);
    res.json({ camera: { id: cam.id, key: cam.key, name: cam.name }, days: Array.isArray(days) ? days : [] });
  } catch (e) {
    console.error('[cameras] recordings summary failed:', e.message);
    res.status(502).json({ error: 'recorder_failed', message: e.message });
  }
});

// ── GET /api/cameras/:id/recordings ──────────────────────────────────────────
// One day's events, plus whether continuous recording covers that day.
//
// AUDITED, granted, as 'list_recordings'. No frame is served here — but "who went
// looking through the door footage of the 12th" is exactly the question an access
// log exists to answer, and a list of the times a person was at the door is
// itself information about that person. The log row carries the window.
//
// The event THUMBNAILS Frigate embeds in every row are stripped in
// src/lib/frigate.js publicEvent(). They are footage, and footage moves only
// through the audited, trigger-gated path below.
router.get('/:id/recordings', ...guard,
           auditedCapability('security.recordings-view', 'list_recordings'), async (req, res) => {
  const db = getPool();
  try {
    const { cam, code, message } = await loadServiceCamera(db, parseInt(req.params.id, 10));
    if (code) return res.status(code === 'not_found' || code === 'bad_id' ? 404 : 409).json({ error: code, message });

    const day = String(req.query.day || '');
    const range = _londonDayRange(day);
    if (!range) return res.status(400).json({ error: 'bad_day', message: 'day must be YYYY-MM-DD.' });

    const base = await frigate.baseUrl(db);
    if (!base) return res.status(503).json({ error: 'no_recorder', message: 'No recorder address is configured.' });

    const afterS  = Math.floor(range.start.getTime() / 1000);
    const beforeS = Math.floor(range.end.getTime() / 1000);

    const [rawEvents, segments] = await Promise.all([
      frigate.events(base, cam.key, { after: afterS, before: beforeS, limit: 500 }),
      frigate.recordingSegments(base, cam.key, afterS, beforeS).catch(() => []),
    ]);
    const events = (Array.isArray(rawEvents) ? rawEvents : []).map(frigate.publicEvent);
    const segs   = Array.isArray(segments) ? segments : [];

    // Continuous coverage, summarised rather than listed: 8,640 ten-second
    // segments is not something to send to a browser.
    const coveredSeconds = segs.reduce((n, s) => n + (Number(s.duration) || 0), 0);
    // Clamped to the day asked for. Frigate returns a segment that STRADDLES
    // midnight, so the raw minimum read "footage from 23:59" on a request for
    // today — which reads as the previous night and is not what was asked.
    const clamp = (t) => Math.min(Math.max(t, afterS), beforeS);
    const firstSeg = segs.length ? clamp(Math.min(...segs.map(s => Number(s.start_time)))) : null;
    const lastSeg  = segs.length ? clamp(Math.max(...segs.map(s => Number(s.end_time))))   : null;

    await audit(req, {
      cameraId: cam.id, action: 'list_recordings', granted: true,
      reason: `Listed the recordings index for ${cam.name} on ${day} — `
            + `${events.length} event(s), ${Math.round(coveredSeconds / 60)} minute(s) of continuous recording. `
            + 'Metadata only; no footage was served by this request.',
      footageFrom: range.start, footageTo: range.end,
    });

    const policyDays = await policyRetentionDays(db);
    res.set('Cache-Control', 'no-store, private');
    res.json({
      camera: { id: cam.id, key: cam.key, name: cam.name, location: cam.location },
      day,
      window: { from: range.start.toISOString(), to: range.end.toISOString() },
      events,
      continuous: {
        segments: segs.length,
        minutes: Math.round(coveredSeconds / 60),
        first: firstSeg ? new Date(firstSeg * 1000).toISOString() : null,
        last:  lastSeg  ? new Date(lastSeg  * 1000).toISOString() : null,
      },
      policy_days: policyDays,
      triggers: TRIGGER_LABEL,
    });
  } catch (e) {
    console.error('[cameras] recordings list failed:', e.message);
    res.status(502).json({ error: 'recorder_failed', message: e.message });
  }
});

// ── POST /api/cameras/:id/recordings/session ─────────────────────────────────
// THE AUTHORISATION POINT for recorded footage, built to the same shape as the
// live one: a trigger is required, the log row is written and its id kept BEFORE
// a token exists, and a failed insert means no token and therefore no playback.
//
// Body: { trigger_reason, trigger_note?, incident_ref?, request_id?,
//         event_id? }  — one Frigate event, OR
//       { ..., from, to }  — an arbitrary window, ISO or epoch seconds.
const REC_SESSION_TTL_MS = 120_000;   // longer than live: a clip takes time to load
const _recSessions = new Map();       // token -> { staffId, cameraId, key, path, from, to, expires }
const MAX_WINDOW_MINUTES = 30;        // a whole-day export is not a "view"

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _recSessions) if (v.expires < now) _recSessions.delete(k);
}, 60_000).unref?.();

router.post('/:id/recordings/session', authenticate, auditedManagerAdminOnly,
            auditedCapability('security.recordings-view', 'view_recording'),
            express.json({ limit: '8kb' }), async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const trigger     = String(b.trigger_reason || '').trim();
  const triggerNote = String(b.trigger_note || '').trim();
  const incidentRef = String(b.incident_ref || '').trim();
  const requestId   = parseInt(b.request_id, 10);

  try {
    // No trigger, no footage — refused before the camera is even looked up, and
    // the refusal logged with the same weight as a grant.
    if (!VIEW_TRIGGERS.has(trigger)) {
      await audit(req, {
        cameraId: Number.isFinite(id) ? id : null, action: 'view_recording', granted: false,
        reason: 'REFUSED (no_trigger): viewing a recording must state which CCTV Policy §3 trigger applies. '
              + `Given: ${trigger ? JSON.stringify(trigger.slice(0, 40)) : '(none)'}.`,
      });
      return res.status(400).json({
        error: 'no_trigger',
        message: 'Say why you are opening this recording. CCTV Policy §3 permits access only for a specific '
               + 'incident, and the reason is recorded in the access log.',
        triggers: TRIGGER_LABEL,
      });
    }

    const { cam, code, message } = await loadServiceCamera(db, id);
    if (code) {
      await audit(req, {
        cameraId: cam ? cam.id : null, action: 'view_recording', granted: false,
        reason: `REFUSED (${code}): ${message}`,
        triggerReason: trigger, triggerNote, incidentRef, requestId,
      });
      return res.status(code === 'not_found' || code === 'bad_id' ? 404 : 409).json({ error: code, message });
    }

    const base = await frigate.baseUrl(db);
    if (!base) {
      await audit(req, {
        cameraId: cam.id, action: 'view_recording', granted: false,
        reason: 'REFUSED (no_recorder): no recorder address is configured, so there is nothing to play.',
        triggerReason: trigger, triggerNote, incidentRef, requestId,
      });
      return res.status(503).json({ error: 'no_recorder', message: 'No recorder address is configured.' });
    }

    // Which footage? An event, or a window.
    let path = null, from = null, to = null, what = '';
    const eventId = String(b.event_id || '').trim();
    if (eventId) {
      if (!/^[0-9.]+-[A-Za-z0-9]+$/.test(eventId)) {
        return res.status(400).json({ error: 'bad_event_id', message: 'That is not a Frigate event id.' });
      }
      // Trust the recorder for the event's window rather than the caller: the
      // log has to say what was actually watched.
      let ev = null;
      try { ev = await frigate.getJson(base, `/api/events/${encodeURIComponent(eventId)}`); }
      catch (e) { return res.status(404).json({ error: 'event_not_found', message: e.message }); }
      if (!ev || ev.camera !== cam.key) {
        return res.status(404).json({ error: 'event_not_found', message: 'That event is not on this camera.' });
      }
      if (!ev.has_clip) {
        return res.status(409).json({ error: 'no_clip', message: 'The recorder kept no clip for that event.' });
      }
      from = new Date(Number(ev.start_time) * 1000);
      to   = new Date(Number(ev.end_time || ev.start_time) * 1000);
      path = frigate.eventClipPath(eventId);
      what = `event ${eventId} (${ev.label || 'object'})`;
    } else {
      const parseTs = (v) => {
        if (v == null || v === '') return null;
        const n = Number(v);
        if (Number.isFinite(n) && n > 1_000_000_000) return new Date(n * 1000);
        const d = new Date(String(v));
        return Number.isNaN(d.getTime()) ? null : d;
      };
      from = parseTs(b.from);
      to   = parseTs(b.to);
      if (!from || !to || to <= from) {
        return res.status(400).json({ error: 'bad_window', message: 'Give an event_id, or a from/to window.' });
      }
      const minutes = (to - from) / 60000;
      if (minutes > MAX_WINDOW_MINUTES) {
        return res.status(400).json({
          error: 'window_too_long',
          message: `A view is up to ${MAX_WINDOW_MINUTES} minutes. Longer than that is a disclosure, `
                 + 'which goes through Footage requests so it is recorded as one.',
        });
      }
      path = frigate.windowClipPath(cam.key, from.getTime() / 1000, to.getTime() / 1000);
      what = `${from.toISOString()} → ${to.toISOString()}`;
    }

    // The log row first, and its id kept. No row, no token, no playback.
    const logId = await audit(req, {
      cameraId: cam.id, action: 'view_recording', granted: true,
      reason: `GRANTED: recorded footage from ${cam.name} — ${what}.`,
      triggerReason: trigger, triggerNote, incidentRef, requestId,
      footageFrom: from, footageTo: to,
    });
    if (!logId) throw new Error('access log row was not written — refusing to serve the recording');

    const token = crypto.randomBytes(24).toString('hex');
    _recSessions.set(token, {
      staffId: req.user.id, cameraId: cam.id, key: cam.key, path,
      from, to, expires: Date.now() + REC_SESSION_TTL_MS,
    });
    res.json({
      token, expires_in: REC_SESSION_TTL_MS / 1000,
      url: `/api/cameras/recording.mp4?t=${token}`,
      camera: { id: cam.id, key: cam.key, name: cam.name },
      from: from.toISOString(), to: to.toISOString(),
      access_log_id: logId,
      trigger: { key: trigger, label: TRIGGER_LABEL[trigger] },
    });
  } catch (e) {
    console.error('[cameras] recording session failed:', e.message);
    res.status(500).json({ error: 'session_failed', message: e.message });
  }
});

// ── GET /api/cameras/recording.mp4?t=… ───────────────────────────────────────
// The bytes, proxied. A <video> element cannot send an Authorization header, so
// the token minted above is the credential — short-lived, single-purpose, and
// already accounted for in the access log.
//
// Range is passed through so scrubbing a clip does not re-download it.
router.get('/recording.mp4', async (req, res) => {
  const t = String(req.query.t || '');
  const s = _recSessions.get(t);
  if (!s || s.expires < Date.now()) {
    _recSessions.delete(t);
    return res.status(403).json({ error: 'bad_session' });
  }
  try {
    const db = getPool();
    // Re-checked on the request that carries video, not only on the one that
    // minted the token — the same belt-and-braces the live path uses.
    const live = (await camerasInService(db)).includes(String(s.key).toLowerCase());
    if (!live) { _recSessions.delete(t); return res.status(409).json({ error: 'not_in_service' }); }
    const base = await frigate.baseUrl(db);
    if (!base) { _recSessions.delete(t); return res.status(503).json({ error: 'no_recorder' }); }

    const headers = {};
    if (req.headers.range) headers.range = req.headers.range;
    const { res: up, req: upReq } = await frigate.openStream(base, s.path, { headers });
    if (up.statusCode >= 400) {
      up.resume();
      return res.status(502).json({
        error: 'recorder_failed',
        message: `The recorder replied HTTP ${up.statusCode} for that footage. It may have been overwritten.`,
      });
    }
    const out = {
      'Content-Type': up.headers['content-type'] || 'video/mp4',
      'Cache-Control': 'no-store, private',
      'Accept-Ranges': up.headers['accept-ranges'] || 'bytes',
      'Content-Disposition': 'inline',
    };
    if (up.headers['content-length']) out['Content-Length'] = up.headers['content-length'];
    if (up.headers['content-range'])  out['Content-Range']  = up.headers['content-range'];
    res.writeHead(up.statusCode, out);
    up.pipe(res);
    up.on('error', () => { if (!res.headersSent) res.status(502).end(); else res.destroy(); });
    // Stop pulling from the recorder the moment the viewer goes away.
    res.on('close', () => { try { upReq.destroy(); } catch { /* already gone */ } });
  } catch (e) {
    console.error('[cameras] recording proxy failed:', e.message);
    if (!res.headersSent) res.status(502).json({ error: 'recorder_failed', message: e.message });
  }
});

module.exports = router;
// Exported for the b234 rule tests (scripts/b234-camera-rule-test.js).
module.exports.evaluateAccess = evaluateAccess;
module.exports.isNurseryOpen  = isNurseryOpen;
module.exports.TRIGGER_LABEL  = TRIGGER_LABEL;
module.exports.VIEW_TRIGGERS  = VIEW_TRIGGERS;
