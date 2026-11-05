'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * building-devices.js — b511 (2026-10-19) — mounted at /api/building-devices.
 *
 * The server end of Roost → Operations → 🏠 Building & devices
 * (/building-devices.html), and of the same page reached from the b505 Security
 * hub's Building tab.
 *
 * ── WHO THIS IS FOR ──────────────────────────────────────────────────────────
 * Toby, 18 Oct: "Make it easy for dummies, as the office manager likes to be spoonfed … if
 * I'm not there it needs to be able to be done." So every string that leaves
 * this file is written for somebody who has never heard the word Zigbee. There
 * is no "linkquality", no "IEEE address", no "coordinator" in a response body:
 * the numbers are here, the words around them are English.
 *
 * ── WHERE THE TRUTH LIVES ────────────────────────────────────────────────────
 * HOME ASSISTANT owns what is paired right now. Wren keeps exactly two things
 * HA has nowhere to put:
 *   • the zigbee_known_devices table — the 19 devices from the network that died
 *     with the lost TI stick. HA cannot know about a device that is not paired.
 *   • the zigbee_join_sessions table — who opened the network, when, for how long.
 * Everything else is read live. Two device lists would disagree the first time
 * somebody paired something from HA's own screen.
 *
 * ── NO NEW SECRETS ───────────────────────────────────────────────────────────
 * HA_LADN_URL + HA_LADN_TOKEN, which Wren has held since the doorbell work. No
 * MQTT login is created and none is needed: z2m bridge requests go out through
 * HA's own mqtt.publish service. See src/services/zigbee-ha.js for the why.
 *
 * ── GATING ───────────────────────────────────────────────────────────────────
 * authenticate → the Roost portal → requireCapability('building.devices.view'),
 * and every write adds requireCapability('building.devices.manage').
 *
 * ⚠️ DELIBERATELY NOT ROLE-GATED, which is where this differs from b505.
 * security-hub.js demands the manager role AND the capability. Here the
 * capability IS the gate, because the two people this page is FOR — the office manager and
 * the admissions lead, the office managers — are not managers in staff.role, and a role check
 * would lock out its own users. Both capabilities are in MATRIX_REQUIRED_CAPS
 * (src/lib/capabilities.js), so the floor manager's blanket pass does not cover
 * them and a grant to the office manager is a real, revocable grant rather than decoration.
 * Separately, Roost itself is a person allowlist on prod
 * (the roost_admin_staff_ids setting) — see the NOTES file.
 *
 * ── GDPR ─────────────────────────────────────────────────────────────────────
 * Nothing here touches a child, a parent or a family. Staff appear only as the
 * first name of whoever opened the network, so the join log reads as a sentence.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const router  = express.Router();

const { getPool }           = require('../db/pool');
const authenticate          = require('../middleware/auth');
const { requireCapability, isOwnerRole } = require('../lib/capabilities');
const { recordAudit }       = require('../utils/audit');

const z2m     = require('../services/zigbee-ha');
const catalog = require('../lib/zigbee-catalog');

// ── The guard ───────────────────────────────────────────────────────────────
function roostOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'Building & devices is on the Roost (admin) portal only.',
    });
  }
  if (!req.user || req.user.role === 'parent') {
    return res.status(403).json({ error: 'forbidden', message: 'Staff only.' });
  }
  next();
}

const view   = [authenticate, roostOnly, requireCapability('building.devices.view')];
const manage = [authenticate, roostOnly, requireCapability('building.devices.view'),
                requireCapability('building.devices.manage')];

router.use(express.json({ limit: '16kb' }));

// ── Talking to HA without ever leaking why it failed ────────────────────────
// Three outcomes, and the page renders all three: HA is not set up (normal, and
// not an error); HA is set up but did not answer (a real problem, worth a red
// card); or it worked. `reason` is always a sentence a person can act on.
const HA_HELP = 'Home Assistant is not connected to Wren yet. Nothing on this page can work until it is — tell Toby.';

function haFailure(e) {
  if (z2m.notConfigured(e)) return { configured: false, reason: HA_HELP };
  return { configured: true, unreachable: true, reason: z2m._haErr(e, 'Home Assistant did not answer.') };
}

// ── The traffic light ───────────────────────────────────────────────────────
// Toby's rule, verbatim: green = working; amber = battery under 20% or not heard
// from for 2 h; red = offline for 6 h or more. Everything that renders a colour
// anywhere in b511 calls THIS, so the room map, the device page, the checklist
// and the health card cannot disagree about one device.
//
// `says` is the plain-words half and is never omitted: colour alone carries no
// meaning (a tile shows the colour, the icon AND the sentence).
const HOUR = 3600 * 1000;

function trafficLight(d) {
  const info  = catalog.modelInfo(d.model);
  const seen  = d.last_seen ? new Date(d.last_seen) : null;
  const ageMs = seen && !isNaN(seen) ? Date.now() - seen.getTime() : null;
  // ⚠️ Number(null) is 0, and 0 is finite — so a naive Number.isFinite() check
  // reported every mains-powered smart plug as "Battery low — 0%" and told the
  // reader to replace a battery it does not have. Check for null FIRST.
  const bat   = (d.battery_pct === null || d.battery_pct === undefined || !Number.isFinite(Number(d.battery_pct)))
                  ? null : Number(d.battery_pct);

  if (d.offline && (ageMs === null || ageMs >= 6 * HOUR)) {
    return { level: 'red', says: 'Not responding',
             detail: seen ? `Nothing heard from it since ${humanAgo(ageMs)}. It needs pairing again, or its battery is flat.`
                          : 'Nothing has been heard from it at all. It needs pairing again.' };
  }
  if (ageMs !== null && ageMs >= 6 * HOUR) {
    return { level: 'red', says: 'Not responding',
             detail: `Nothing heard from it for ${humanAgo(ageMs)}.` };
  }
  if (bat !== null && bat < 20) {
    return { level: 'amber', says: `Battery low — ${Math.round(bat)}%`,
             // battery_phrase, not battery.toLowerCase(): lower-casing turned
             // "One CR2477 coin cell" into "one cr2477 coin cell", which is not
             // a part number anybody can take to a shop.
             detail: `Replace with ${info.battery_phrase}.` };
  }
  if (d.offline || (ageMs !== null && ageMs >= 2 * HOUR)) {
    return { level: 'amber', says: 'Gone quiet',
             detail: ageMs !== null
               ? `Nothing heard from it for ${humanAgo(ageMs)}. Often it comes back on its own — check again after lunch.`
               : 'It has stopped reporting. Often it comes back on its own.' };
  }
  return { level: 'green', says: 'Working',
           detail: ageMs !== null ? `Last heard from ${humanAgo(ageMs)}.` : 'Reporting normally.' };
}

function humanAgo(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'a while ago';
  const mins = Math.floor(ms / 60000);
  if (mins < 2)   return 'just now';
  if (mins < 60)  return `${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)   return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

// ── One device, in the shape the page draws ─────────────────────────────────
function tile(d) {
  const info = catalog.modelInfo(d.model);
  const t    = catalog.typeInfo(info.type);
  const light = trafficLight(d);
  const readings = [];
  // Number.isFinite (not the global isFinite) and a real value, so a null never
  // becomes a 0 on the tile — see the note in trafficLight().
  if (Number.isFinite(d.temperature_c)) readings.push({ label: 'Temperature', value: `${d.temperature_c}°C` });
  if (Number.isFinite(d.humidity_pct))  readings.push({ label: 'Humidity', value: `${Math.round(d.humidity_pct)}%` });
  if (Number.isFinite(d.battery_pct))   readings.push({ label: 'Battery', value: `${Math.round(d.battery_pct)}%` });
  return {
    ieee: d.ieee,
    name: d.name,
    type: info.type,
    type_label: t.label,
    icon: t.icon,
    model: d.model,
    what_it_is: t.blurb,
    mains_powered: !!info.router,
    room: d.room,
    room_label: catalog.roomLabel(d.room),
    light,
    readings,
    battery_pct: Number.isFinite(d.battery_pct) ? Math.round(d.battery_pct) : null,
    battery_takes: info.battery,
    signal: Number.isFinite(d.linkquality)
      ? { value: d.linkquality, says: d.linkquality >= 80 ? 'Strong' : d.linkquality >= 40 ? 'OK' : 'Weak' }
      : null,
    last_seen: d.last_seen,
    last_seen_says: d.last_seen ? humanAgo(Date.now() - new Date(d.last_seen).getTime()) : null,
    was_on_old_network: d.was_on_old_network,
    old_name: d.old_name,
    ha_device_id: d.ha_device_id,
  };
}

// ── Keeping the re-pair checklist honest ────────────────────────────────────
// A device is marked 'found' by WHAT HOME ASSISTANT SHOWS, never by a person
// ticking a box. Called on every read of the overview and the checklist, so the
// Monday walk-round updates itself as the office manager goes.
// 3 Nov 2026: ONLINE devices only. Being in HA's registry is not being back — the hub
// restore re-listed all 19 at once while most were still asleep, and this would have
// ticked the whole checklist. A valve flagged needs_repair is ticked by the pairing
// check that sees it rejoin (markRejoined), never here: until z2m times it out it can
// still look online from the network it was wrongly paired to.
async function syncFound(db, devices) {
  const ieees = (devices || []).filter(d => !d.offline).map(d => d.ieee);
  if (!ieees.length) return 0;
  const { rowCount } = await db.query(
    `UPDATE zigbee_known_devices
        SET status = 'found', found_at = COALESCE(found_at, now()), updated_at = now()
      WHERE ieee = ANY($1::text[]) AND status = 'not_yet' AND NOT needs_repair`, [ieees]);
  return rowCount;
}

// ── Pairing: what counts as "found" (shared with nest-building.js) ──────────
// A NEW address is found. Since 3 Nov so is a KNOWN device that was offline when the
// window opened and is online now: re-pairing the Office rad keeps its address, so the
// new-address diff alone never saw it and the wizard would have waited forever.
function foundInSession(devices, session, baselineQuery) {
  // 2026-10-30: an EMPTY baseline is a real one — the hub had no devices when the
  // window opened (the first re-pair after the 18 Oct network rebuild). It used to
  // mean "no baseline", so the very first device ever paired was never reported as
  // found (the office rad, 30 Oct). No baseline at all: fall back to the session's
  // own count, and only an empty hub at open-time counts as "everything is new".
  const hasBaseline = baselineQuery !== undefined || Number(session.baseline_count) === 0;
  const baselineSet = new Set(String(baselineQuery || '').toLowerCase().split(',').filter(Boolean));
  const wasOffline  = new Set(session.baseline_offline || []);
  return devices.filter(d => (hasBaseline && !baselineSet.has(d.ieee)) || (wasOffline.has(d.ieee) && !d.offline));
}

async function markRejoined(db, ieees) {
  if (!ieees || !ieees.length) return 0;
  const { rowCount } = await db.query(
    `UPDATE zigbee_known_devices
        SET needs_repair = false, status = 'found', found_at = COALESCE(found_at, now()), updated_at = now()
      WHERE ieee = ANY($1::text[]) AND (needs_repair OR status = 'not_yet')`, [ieees]);
  return rowCount;
}

// ═════════════════════════════════════════════════════════════════════════════
// The home screen: the building as a set of rooms.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/overview', ...view, async (req, res) => {
  const db = getPool();
  if (!z2m.configured()) {
    return res.json({ configured: false, reason: HA_HELP, rooms: [], summary: null, health: null });
  }

  let devices, bridge, backups;
  try {
    [devices, bridge, backups] = await Promise.all([
      z2m.devices({ force: req.query.refresh === '1' }),
      z2m.bridge({ force: req.query.refresh === '1' }),
      z2m.backups({}).catch(() => ({ known: false })),
    ]);
  } catch (e) {
    return res.status(z2m.notConfigured(e) ? 200 : 502)
              .json({ ...haFailure(e), rooms: [], summary: null, health: null });
  }

  try { await syncFound(db, devices); } catch { /* the checklist catching up is not worth a 500 */ }

  const tiles = devices.map(tile);
  const rooms = catalog.ROOMS.map(r => ({
    key: r.key,
    label: r.label,
    devices: tiles.filter(t => t.room === r.key),
  })).filter(r => r.devices.length || r.key !== 'unassigned');

  const counts = { green: 0, amber: 0, red: 0 };
  for (const t of tiles) counts[t.light.level]++;

  // The checklist's progress, so the home screen can say "6 of 19 back".
  let recovery = { total: 0, found: 0, retired: 0, outstanding: 0 };
  try {
    const { rows } = await db.query(
      `SELECT status, count(*)::int AS n FROM zigbee_known_devices GROUP BY status`);
    for (const r of rows) {
      recovery.total += r.n;
      if (r.status === 'found')   recovery.found = r.n;
      if (r.status === 'retired') recovery.retired = r.n;
      if (r.status === 'not_yet') recovery.outstanding = r.n;
    }
  } catch { /* the table is created by the b511 migration; without it, no card */ }

  res.json({
    configured: true,
    rooms,
    summary: {
      total: tiles.length,
      ...counts,
      text: tiles.length === 0
        ? 'Nothing is paired yet.'
        : `${counts.green} working${counts.amber ? `, ${counts.amber} need${counts.amber === 1 ? 's' : ''} a look` : ''}${counts.red ? `, ${counts.red} not responding` : ''}.`,
    },
    recovery,
    health: health(bridge, backups),
  });
});

// ── The managers' health card ───────────────────────────────────────────────
// Three questions, in the order they matter: is the hub alive, is anything
// backed up, and how old is that backup.
function health(bridge, backups) {
  const b = backups || { known: false };
  const out = {
    coordinator: {
      online: !!bridge.online,
      version: bridge.version,
      says: bridge.online
        ? 'The hub is on and listening.'
        : 'The hub is not answering. While it is down, nothing on this page will update and the radiators fall back to whatever they were last set to.',
      offline_minutes: bridge.offline_minutes || 0,
    },
    // The one thing on this page worth interrupting somebody for.
    big_warning: null,
    backup: {
      known: !!b.known,
      last_backup_at: b.last_backup_at || null,
      age_days: Number.isFinite(b.age_days) ? b.age_days : null,
      says: b.last_backup_at
        ? `The last full copy of the hub was taken ${humanAgo(Date.now() - new Date(b.last_backup_at).getTime())}.`
        : 'Home Assistant has not reported a backup. Ask Toby to check that automatic backups are switched on — '
          + 'the list of devices and the key that lets them talk to us live inside that backup.',
      stale: Number.isFinite(b.age_days) ? b.age_days > 14 : null,
    },
    joining_open: bridge.permit_join === true,
  };
  if (!bridge.online && (bridge.offline_minutes || 0) >= 10) {
    out.big_warning = `The hub has been off for ${humanAgo((bridge.offline_minutes || 0) * 60000)}. `
      + 'Check the little USB-style box in the office is powered and its network cable is in, then tell Toby.';
  }
  return out;
}

// ── Flat device list + one device ───────────────────────────────────────────
router.get('/devices', ...view, async (req, res) => {
  if (!z2m.configured()) return res.json({ configured: false, reason: HA_HELP, devices: [] });
  try {
    const devices = await z2m.devices({ force: req.query.refresh === '1' });
    res.json({ configured: true, devices: devices.map(tile) });
  } catch (e) {
    res.status(z2m.notConfigured(e) ? 200 : 502).json({ ...haFailure(e), devices: [] });
  }
});

router.get('/device/:ieee', ...view, async (req, res) => {
  let ieee;
  try { ieee = z2m.assertIeee(req.params.ieee); }
  catch { return res.status(400).json({ error: 'bad_ieee', message: 'That is not a device address.' }); }
  if (!z2m.configured()) return res.json({ configured: false, reason: HA_HELP, device: null });

  try {
    const devices = await z2m.devices({ force: req.query.refresh === '1' });
    const raw = devices.find(d => d.ieee === ieee);
    if (!raw) {
      const old = catalog.oldDevice(ieee);
      return res.status(404).json({ error: 'not_paired', configured: true,
        message: old ? `${old.display} is not paired at the moment. Use "Add a device" to bring it back.`
                     : 'We cannot find that device. It may have been removed.',
        old: old || null });
    }
    const info = catalog.modelInfo(raw.model);
    res.json({
      configured: true,
      device: tile(raw),
      detail: {
        address: raw.ieee,
        model: raw.model,
        made_by: raw.vendor,
        battery_takes: info.battery,
        battery_note: info.battery_note,
        mains_powered: !!info.router,
        entities: raw.entities,
      },
      pairing: info.pairing,
      troubleshooting: catalog.troubleshoot(raw),
      rooms: catalog.ROOMS.map(r => ({ key: r.key, label: r.label })),
    });
  } catch (e) {
    res.status(z2m.notConfigured(e) ? 200 : 502).json({ ...haFailure(e), device: null });
  }
});

// ── The catalogue, for the wizard's first step ──────────────────────────────
// Static, so it works even when HA is down — which matters, because "HA is down"
// is one of the moments somebody opens this page.
router.get('/catalog', ...view, (req, res) => {
  const types = Object.values(catalog.TYPES)
    .filter(t => t.key !== 'other')
    .map(t => ({
      ...t,
      models: Object.values(catalog.MODELS)
        .filter(m => m.type === t.key)
        .map(m => ({ model: m.model, name: m.name, battery: m.battery,
                     battery_phrase: m.battery_phrase, battery_note: m.battery_note,
                     mains_powered: !!m.router, pairing: m.pairing })),
    }));
  res.json({ types, rooms: catalog.ROOMS.map(r => ({ key: r.key, label: r.label })) });
});

// ═════════════════════════════════════════════════════════════════════════════
// The re-pair checklist — Monday's walk-round.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/recovery', ...view, async (req, res) => {
  const db = getPool();
  let live = [];
  let haState = { configured: z2m.configured() };
  if (haState.configured) {
    try { live = await z2m.devices({ force: req.query.refresh === '1' }); }
    catch (e) { haState = haFailure(e); }
  } else {
    haState.reason = HA_HELP;
  }

  try { await syncFound(db, live); } catch { /* see syncFound */ }

  const liveBy = new Map(live.map(d => [d.ieee, d]));
  let rows = [];
  try {
    const r = await db.query(
      `SELECT ieee, old_name, model, vendor, device_type, room, status, found_at, note, needs_repair
         FROM zigbee_known_devices ORDER BY room, old_name NULLS LAST, ieee`);
    rows = r.rows;
  } catch (e) {
    return res.status(503).json({ error: 'no_table',
      message: 'The checklist table does not exist yet — the b511 migration has not been run.' });
  }

  const items = rows.map(r => {
    const info = catalog.modelInfo(r.model);
    const t    = catalog.typeInfo(info.type);
    const d    = liveBy.get(r.ieee);
    const old  = catalog.oldDevice(r.ieee);
    const action = catalog.bringBack(r.model, { needsRepair: r.needs_repair });
    return {
      ieee: r.ieee,
      name: r.old_name || (old && old.display) || `${info.name} (never named)`,
      model: r.model,
      type: info.type,
      type_label: t.label,
      icon: t.icon,
      room: r.room,
      room_label: catalog.roomLabel(r.room),
      mains_powered: !!info.router,
      battery_takes: info.battery,
      status: r.status,
      found_at: r.found_at,
      note: r.note,
      light: d ? trafficLight(d) : null,
      // No .toLowerCase() here either: "Battery low — 11%" and "Not responding"
      // are the same words the room map uses, and lower-casing them produced
      // "Back on the network. working."
      says: r.status === 'found'
        ? (d ? `Back on the network — ${trafficLight(d).says}.` : 'Was seen back on the network.')
        : r.status === 'retired'
          ? (r.note ? `Not coming back — ${r.note}` : 'Marked as not coming back.')
          : `${action.title}${action.why ? ' — ' + action.why : '.'}`,
      action,
      pairing: info.pairing,
    };
  });

  const done = items.filter(i => i.status === 'found').length;
  const retired = items.filter(i => i.status === 'retired').length;
  res.json({
    ...haState,
    progress: { total: items.length, found: done, retired, outstanding: items.length - done - retired,
      text: `${done} of ${items.length} back` + (retired ? `, ${retired} written off` : '') },
    // Order: the room you are standing in, biggest jobs first. Plugs come first
    // inside a room on purpose — they relay for everything else, so pairing them
    // first makes the rest of the walk easier.
    items: items.sort((a, b) => (a.room || '').localeCompare(b.room || '')
                             || (b.mains_powered - a.mains_powered)
                             || a.name.localeCompare(b.name)),
  });
});

router.post('/recovery/:ieee/retire', ...manage, async (req, res) => {
  let ieee;
  try { ieee = z2m.assertIeee(req.params.ieee); }
  catch { return res.status(400).json({ error: 'bad_ieee', message: 'That is not a device address.' }); }
  const note = String((req.body && req.body.note) || '').slice(0, 200) || null;
  const undo = req.body && (req.body.undo === true || req.body.undo === 'true');
  try {
    const { rows } = await getPool().query(
      undo
        ? `UPDATE zigbee_known_devices SET status = 'not_yet', retired_by = NULL, retired_at = NULL,
                  note = NULL, updated_at = now()
            WHERE ieee = $1 AND status = 'retired' RETURNING ieee, status`
        : `UPDATE zigbee_known_devices SET status = 'retired', retired_by = $2, retired_at = now(),
                  note = $3, updated_at = now()
            WHERE ieee = $1 AND status <> 'found' RETURNING ieee, status`,
      undo ? [ieee] : [ieee, req.user.id, note]);
    if (!rows.length) {
      return res.status(409).json({ error: 'not_applicable',
        message: undo ? 'That one is not written off.'
                      : 'That device is already back on the network, so it cannot be written off.' });
    }
    await recordAudit({ req, action: 'update', entity_type: 'zigbee_known_device', entity_id: ieee,
      diff: { new: { status: rows[0].status, note } } });
    res.json({ ok: true, ieee, status: rows[0].status });
  } catch (e) { res.status(500).json({ error: 'save_failed', message: e.message }); }
});

// ═════════════════════════════════════════════════════════════════════════════
// Adding a device.
//
// Opening a Zigbee network means anything in range that asks to join, joins. It
// is the one genuinely consequential thing on this page, so: it needs
// building.devices.manage, it is time-boxed by z2m itself, it writes an
// audit_log row AND a zigbee_join_sessions row, and the page closes it the
// moment the wizard finishes.
// ═════════════════════════════════════════════════════════════════════════════
async function joinSeconds(db) {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'building_devices_join_seconds'");
    const n = rows.length ? Number(rows[0].value) : NaN;
    if (Number.isFinite(n)) return Math.max(10, Math.min(254, Math.round(n)));
  } catch { /* fall through to the default */ }
  return 120;
}

router.post('/join/open', ...manage, async (req, res) => {
  const db = getPool();
  if (!z2m.configured()) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });

  const expecting = String((req.body && req.body.expecting_type) || '').slice(0, 40) || null;
  // Ten seconds is the smallest the service allows, and is what the b511 live
  // verification used so it could open and close the real network safely.
  const want = Number(req.body && req.body.seconds);
  const secs = Number.isFinite(want) ? Math.max(10, Math.min(254, Math.round(want))) : await joinSeconds(db);

  let baseline = null, baselineOffline = [];
  try {
    const before = await z2m.devices({ force: true });
    baseline = before.map(d => d.ieee);
    baselineOffline = before.filter(d => d.offline).map(d => d.ieee);
  }
  catch (e) { return res.status(502).json({ error: 'ha_unreachable', ...haFailure(e) }); }

  let opened;
  try { opened = await z2m.permitJoin(secs); }
  catch (e) {
    return res.status(z2m.notConfigured(e) ? 503 : 502)
              .json({ error: 'join_failed', message: z2m._haErr(e, 'The hub would not open the network.') });
  }

  // The network is NOW OPEN. Everything below is bookkeeping, and a bookkeeping
  // failure must never stop the caller being told that — otherwise the page shows
  // an error, nobody closes the window, and the network stays open. So this is
  // caught; but it is also REPORTED, in the log and in the response, because a
  // silent catch is how the first two versions of this hid a broken INSERT.
  let id = null, logError = null;
  try {
    // Any session still showing as open is stale — the network closes itself.
    await db.query(
      `UPDATE zigbee_join_sessions SET closed_at = now(), close_reason = 'timeout'
        WHERE closed_at IS NULL`);
    const { rows } = await db.query(
      // ⚠️ BOTH uses of $2 are cast to int. Without the casts Postgres deduces
      // integer from the `seconds` column and double precision from
      // make_interval's `secs`, and refuses the statement with "inconsistent
      // types deduced for parameter $2". (And make_interval rather than
      // ($2 || ' seconds')::interval, which cannot infer a type at all.)
      `INSERT INTO zigbee_join_sessions (opened_by, seconds, expires_at, expecting_type, baseline_count, baseline_offline)
       VALUES ($1, $2::int, now() + make_interval(secs => $2::int), $3, $4, $5::text[]) RETURNING id`,
      [req.user.id, secs, expecting, baseline.length, baselineOffline]);
    id = rows[0].id;
  } catch (e) {
    logError = e.message;
    console.error('[b511] join session not recorded:', e.message);
  }

  await recordAudit({ req, action: 'update', entity_type: 'zigbee_permit_join', entity_id: String(id || 'unlogged'),
    diff: { new: { open: true, seconds: secs, expecting: expecting } },
    meta: { baseline_devices: baseline.length } });

  res.json({
    ok: true, session_id: id, seconds: secs, expires_at: opened.until,
    baseline: baseline,
    // Told, not hidden: the network is open either way, and somebody should know
    // that the record of who opened it did not get written.
    log_warning: logError ? 'The network is open, but Wren could not record who opened it. Tell Toby.' : null,
    says: `The network is open for ${secs >= 60 ? `${Math.round(secs / 60)} minute${secs >= 120 ? 's' : ''}` : `${secs} seconds`}. `
        + 'Put the device into pairing mode now.',
  });
});

router.get('/join/status', ...view, async (req, res) => {
  const db = getPool();
  let session = null, sessionError = null;
  try {
    // GDPR: a FIRST NAME only, so the page can say "the office manager opened this" without
    // this router ever holding a surname. COALESCE(preferred_name, first_name)
    // because preferred_name is what people are called.
    const { rows } = await db.query(
      `SELECT s.id, s.opened_at, s.seconds, s.expires_at, s.closed_at, s.expecting_type,
              s.baseline_count, s.baseline_offline, s.found_ieee,
              COALESCE(st.preferred_name, st.first_name) AS opened_by_name
         FROM zigbee_join_sessions s
         LEFT JOIN staff st ON st.id = s.opened_by
        ORDER BY s.opened_at DESC LIMIT 1`);
    session = rows[0] || null;
  } catch (e) {
    // A swallowed error here is how an earlier version reported "nothing is
    // joining" while the network was in fact open — the worst possible lie this
    // page can tell. It is still caught (the wizard must keep working), but it
    // is logged and the caller is told the status is unreliable.
    sessionError = e.message;
    console.error('[b511] join status could not be read:', e.message);
  }

  let bridge = null, found = [];
  if (z2m.configured()) {
    try {
      // force: the whole point of this call is to notice something NEW.
      const [devices, b] = await Promise.all([z2m.devices({ force: true }), z2m.bridge({ force: true })]);
      bridge = b;
      if (session && !session.closed_at) {
        const back = foundInSession(devices, session, req.query.baseline);
        try { await markRejoined(db, back.map(d => d.ieee)); }
        catch (e) { console.error('[b511] rejoined device not ticked:', e.message); }
        found = back
          .map(d => {
            const old = catalog.oldDevice(d.ieee);
            return {
              ...tile(d),
              welcome_back: old && old.old_name
                ? `This is the ${old.old_name} — welcome back.`
                : (old ? `We have seen this one before: it was the ${old.display.toLowerCase()}.` : null),
              suggested_name: (old && old.old_name) || d.name,
              suggested_room: (old && old.room) || d.room,
            };
          });
      }
    } catch (e) { bridge = { online: false, error: z2m._haErr(e) }; }
  }

  const openUntil = session && !session.closed_at ? new Date(session.expires_at) : null;
  const secondsLeft = openUntil ? Math.max(0, Math.round((openUntil - Date.now()) / 1000)) : 0;
  res.json({
    configured: z2m.configured(),
    unreliable: sessionError ? 'Wren could not read its own record of this. Close the window when you are done.' : null,
    open: !!(session && !session.closed_at && secondsLeft > 0),
    seconds_left: secondsLeft,
    session: session ? {
      id: session.id, opened_at: session.opened_at, expecting_type: session.expecting_type,
      opened_by: session.opened_by_name ? String(session.opened_by_name).split(' ')[0] : null,
      baseline_count: session.baseline_count, closed_at: session.closed_at,
    } : null,
    hub_says_open: bridge ? bridge.permit_join : null,
    found,
  });
});

router.post('/join/close', ...manage, async (req, res) => {
  const db = getPool();
  const reason = ['done', 'timeout', 'cancelled'].includes(String(req.body && req.body.reason))
    ? String(req.body.reason) : 'done';
  const foundIeee = Array.isArray(req.body && req.body.found)
    ? req.body.found.map(x => String(x).toLowerCase()).filter(x => /^0x[0-9a-f]{16}$/.test(x)).slice(0, 20)
    : [];

  let closeErr = null;
  if (z2m.configured()) {
    try { await z2m.closeJoin(); }
    catch (e) { closeErr = z2m._haErr(e, 'The hub did not confirm the network was closed.'); }
  }
  try {
    await db.query(
      `UPDATE zigbee_join_sessions
          SET closed_at = now(), close_reason = $1,
              found_ieee = CASE WHEN $2::text[] = '{}' THEN found_ieee ELSE $2::text[] END
        WHERE closed_at IS NULL`, [reason, foundIeee]);
  } catch { /* no table; the network is still closed, which is what matters */ }

  await recordAudit({ req, action: 'update', entity_type: 'zigbee_permit_join', entity_id: 'close',
    diff: { new: { open: false, reason } }, meta: { found: foundIeee } });

  // A failure to close is the one thing here worth a non-200: the network would
  // still be open and the page must say so loudly rather than tick a box.
  if (closeErr) return res.status(502).json({ ok: false, error: 'close_failed', message: closeErr });
  res.json({ ok: true, closed: true });
});

// ═════════════════════════════════════════════════════════════════════════════
// One device: rename, move room, remove.
// ═════════════════════════════════════════════════════════════════════════════
router.post('/device/:ieee/rename', ...manage, async (req, res) => {
  let ieee;
  try { ieee = z2m.assertIeee(req.params.ieee); }
  catch { return res.status(400).json({ error: 'bad_ieee', message: 'That is not a device address.' }); }
  if (!z2m.configured()) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });

  const name = req.body && req.body.name !== undefined ? String(req.body.name).trim() : null;
  const room = req.body && req.body.room !== undefined ? String(req.body.room) : null;
  if (room !== null && !catalog.ROOM_BY_KEY[room]) {
    return res.status(400).json({ error: 'bad_room', message: 'Pick one of the rooms in the list.' });
  }
  if (name === null && room === null) {
    return res.status(400).json({ error: 'nothing_to_do', message: 'Give a new name, a new room, or both.' });
  }

  let before;
  try {
    const devices = await z2m.devices({ force: true });
    before = devices.find(d => d.ieee === ieee);
  } catch (e) { return res.status(502).json({ error: 'ha_unreachable', ...haFailure(e) }); }
  if (!before) {
    return res.status(404).json({ error: 'not_paired',
      message: 'That device is not paired at the moment, so it cannot be renamed.' });
  }

  const done = {};
  try {
    if (name !== null && name !== before.name) { await z2m.renameDevice(ieee, name); done.name = name; }
    // ⚠️ Compare against the device's REAL Home Assistant area, not the derived
    // `room`. `room` falls back to the old network's list when HA has no area,
    // so comparing against it meant "it is already in the Kitchen (because we
    // guessed Kitchen)" and the HA area was never written — the guess would
    // have survived only until the next person looked at it in HA.
    const haRoom = (catalog.ROOM_BY_AREA[before.ha_area] && catalog.ROOM_BY_AREA[before.ha_area].key) || 'unassigned';
    if (room !== null && room !== haRoom) {
      await z2m.setDeviceRoom(before.ha_device_id, room);
      done.room = room;
    }
  } catch (e) {
    if (e.code === 'bad_name') return res.status(400).json({ error: 'bad_name', message: e.message });
    return res.status(502).json({ error: 'ha_call_failed',
      message: z2m._haErr(e, 'Home Assistant would not make that change.'), partial: done });
  }

  // Keep the checklist's room in step, so the Monday walk-round orders itself by
  // where things actually are. Only ever for a device we already knew about.
  if (done.room) {
    try { await getPool().query(
      `UPDATE zigbee_known_devices SET room = $2, updated_at = now() WHERE ieee = $1`, [ieee, done.room]);
    } catch { /* not every device is on the old list */ }
  }

  await recordAudit({ req, action: 'update', entity_type: 'zigbee_device', entity_id: ieee,
    diff: { old: { name: before.name, room: before.room }, new: done } });

  res.json({ ok: true, ieee, changed: done,
    says: done.name && done.room ? `Renamed to ${done.name} and moved to ${catalog.roomLabel(done.room)}.`
        : done.name ? `Renamed to ${done.name}.`
        : done.room ? `Moved to ${catalog.roomLabel(done.room)}.`
        : 'Nothing needed changing.' });
});

router.post('/device/:ieee/remove', ...manage, async (req, res) => {
  let ieee;
  try { ieee = z2m.assertIeee(req.params.ieee); }
  catch { return res.status(400).json({ error: 'bad_ieee', message: 'That is not a device address.' }); }
  if (!z2m.configured()) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });

  // Removing is the only destructive thing here, so — unlike the rest of the
  // router — it takes a MANAGER on top of building.devices.manage, and then an
  // explicit confirm. The confirm is the device's own name typed back, which a
  // stray double-tap on a phone cannot satisfy.
  //
  // ⚠️ READ THIS BEFORE RELYING ON THE GATE BELOW (corrected in review, chain E2,
  // 19 Oct). An earlier version of this comment claimed removal was Toby's and
  // the deputy's alone, and that the office managers stopped here. THAT IS NOT WHAT
  // THIS CODE DOES. the office manager (13) and the admissions lead (43) both have staff.role = 'manager'
  // on prod — verified — so they pass the check below and CAN remove a device.
  // The confirm-by-name is what actually stands between them and a mistake.
  //
  // Toby's decision, not a reviewer's: if removal should really be the owner's
  // and the floor manager's alone, narrow `managerish` to isOwnerRole(req.user)
  // (plus 'deputy_manager' for the deputy). Left as built, because tightening who can
  // do what is a product call. b511 NOTES open question 3.
  const managerish = isOwnerRole(req.user)
    || ['manager', 'admin', 'owner', 'deputy_manager'].includes(String(req.user.role || ''));
  if (!managerish) {
    return res.status(403).json({ error: 'manager_only',
      message: 'Removing a device is a manager\'s job. Ask Toby or the deputy.' });
  }
  const confirm = String((req.body && req.body.confirm) || '');

  let before;
  try { before = (await z2m.devices({ force: true })).find(d => d.ieee === ieee); }
  catch (e) { return res.status(502).json({ error: 'ha_unreachable', ...haFailure(e) }); }
  if (!before) return res.status(404).json({ error: 'not_paired', message: 'That device is not paired.' });

  if (confirm.trim().toLowerCase() !== String(before.name).trim().toLowerCase()) {
    return res.status(400).json({ error: 'confirm_required',
      message: `To remove this, type its name exactly: ${before.name}`,
      expected_label: before.name });
  }

  try { await z2m.removeDevice(ieee, { force: req.body && req.body.force === true }); }
  catch (e) {
    return res.status(502).json({ error: 'ha_call_failed',
      message: z2m._haErr(e, 'The hub would not remove it. If it is already unplugged or its battery is out, '
                           + 'tick "it is not here any more" and try again.') });
  }

  // It is off the network, so the checklist should ask for it again rather than
  // keep claiming it is back.
  try { await getPool().query(
    `UPDATE zigbee_known_devices SET status = 'not_yet', found_at = NULL, updated_at = now()
      WHERE ieee = $1 AND status = 'found'`, [ieee]); } catch { /* not on the old list */ }

  await recordAudit({ req, action: 'delete', entity_type: 'zigbee_device', entity_id: ieee,
    diff: { old: { name: before.name, model: before.model, room: before.room } } });

  res.json({ ok: true, ieee, says: `${before.name} has been removed. To use it again, pair it as a new device.` });
});

// ═════════════════════════════════════════════════════════════════════════════
// Radiators.
//
// Driven through the Better Thermostat wrappers, which is what b505's Building
// tab and HA's own dashboard do. THE ALLOW-LIST IS DERIVED, NOT TYPED: an entity
// is controllable only if HA's own registry says it belongs to a Better
// Thermostat or to a z2m device, so a client-supplied entity id can never reach
// a service call. That is the same property b505's ha_entities table exists to
// guarantee, obtained without asking somebody to type six entity ids in by hand.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/radiators', ...view, async (req, res) => {
  if (!z2m.configured()) return res.json({ configured: false, reason: HA_HELP, radiators: [] });
  try {
    const list = await z2m.controllableClimate({ force: req.query.refresh === '1' });
    res.json({
      configured: true,
      radiators: list.map(r => ({
        ...r,
        room_label: catalog.roomLabel(r.room),
        says: !r.available
          ? 'Not paired yet — this radiator valve is waiting to be added back.'
          : r.temperature === null
            ? 'On, but no target has been set.'
            : `Set to ${r.temperature}°C${Number.isFinite(r.current_temperature) ? `, room is ${r.current_temperature}°C` : ''}.`,
      })),
    });
  } catch (e) {
    res.status(z2m.notConfigured(e) ? 200 : 502).json({ ...haFailure(e), radiators: [] });
  }
});

router.post('/radiators/temperature', ...manage, async (req, res) => {
  if (!z2m.configured()) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });
  const entity_id = String((req.body && req.body.entity_id) || '').trim().toLowerCase();
  const temperature = Number(req.body && req.body.temperature);
  // The same clamp b505 uses, for the same reason: a nursery radiator has no
  // business outside it, whichever page is asking.
  if (!Number.isFinite(temperature) || temperature < 5 || temperature > 28) {
    return res.status(400).json({ error: 'bad_temperature',
      message: 'Pick something between 5°C and 28°C.' });
  }

  let row;
  try { row = (await z2m.controllableClimate({ force: true })).find(r => r.entity_id === entity_id); }
  catch (e) { return res.status(502).json({ error: 'ha_unreachable', ...haFailure(e) }); }
  if (!row) {
    return res.status(403).json({ error: 'not_a_radiator',
      message: 'That is not one of the nursery\'s radiator valves. Nothing was sent to Home Assistant.' });
  }
  if (!row.available) {
    return res.status(409).json({ error: 'unavailable',
      message: `${row.label} is not paired at the moment, so its target cannot be changed. Add it back first.` });
  }

  try { await z2m.setTemperature(row.entity_id, temperature); }
  catch (e) { return res.status(502).json({ error: 'ha_call_failed',
    message: z2m._haErr(e, 'Home Assistant would not set that temperature.') }); }

  await recordAudit({ req, action: 'update', entity_type: 'ha_climate', entity_id: row.entity_id,
    diff: { old: { temperature: row.temperature }, new: { temperature } },
    meta: { label: row.label, via: 'building-devices' } });

  res.json({ ok: true, entity_id: row.entity_id, temperature,
    says: `${row.label} is now set to ${temperature}°C.` });
});

// ═════════════════════════════════════════════════════════════════════════════
// The kitchen probes.
//
// The fridge and freezer thermometers feed the chef's kitchen log through
// POST /api/kitchen/sensor-log, which has needed an x-kitchen-token header since
// b331 (15 Sep). The HA end never got that header, so the feed has been dead
// since 14 Sep. b511 does not invent a token and does not put one in a response:
// it checks whether the two halves line up and, where they do not, prints the
// exact automation for Toby to paste, with the token referenced as a secret he
// fills in himself.
// ═════════════════════════════════════════════════════════════════════════════
const KITCHEN_SENSORS = [
  { location: 'fridge',  old_name: 'FRIDGE THERM',  ieee: '0xf84477fffe0b5a56' },
  { location: 'freezer', old_name: 'FREEZER Therm', ieee: '0xf84477fffe0b3c6c' },
];

router.get('/kitchen-check', ...view, async (req, res) => {
  const db = getPool();

  // 1. Is the token set at all? Only ever yes/no and WHERE — never the value.
  const envToken = !!(process.env.KITCHEN_SENSOR_TOKEN || '').trim();
  let settingToken = false;
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key = 'kitchen_sensor_token'");
    settingToken = !!(rows.length && String(rows[0].value || '').trim());
  } catch { /* leave it false */ }

  // 2. Are the two probes paired?
  let paired = new Map();
  let haState = { configured: z2m.configured() };
  if (haState.configured) {
    try {
      const devices = await z2m.devices({ force: req.query.refresh === '1' });
      paired = new Map(devices.map(d => [d.ieee, d]));
    } catch (e) { haState = haFailure(e); }
  } else { haState.reason = HA_HELP; }

  // 3. Is anything actually arriving? Counts and timestamps only — a reading is
  //    a number about an appliance, but the rule here is counts anyway.
  let feed = [];
  try {
    const { rows } = await db.query(
      `SELECT location,
              max(recorded_at) FILTER (WHERE source <> 'manual') AS last_probe_at,
              count(*) FILTER (WHERE source <> 'manual' AND recorded_at > now() - interval '24 hours')::int AS probe_24h,
              max(recorded_at) FILTER (WHERE source = 'manual')  AS last_manual_at
         FROM kitchen_sensor_readings
        WHERE location = ANY($1::text[])
        GROUP BY location`, [KITCHEN_SENSORS.map(s => s.location)]);
    feed = rows;
  } catch { /* the kitchen tables exist on every LADN schema; a miss is not fatal */ }
  const feedBy = new Map(feed.map(f => [f.location, f]));

  const probes = KITCHEN_SENSORS.map(s => {
    const d = paired.get(s.ieee) || null;
    const f = feedBy.get(s.location) || {};
    const lastProbe = f.last_probe_at ? new Date(f.last_probe_at) : null;
    const liveFeed = lastProbe ? (Date.now() - lastProbe.getTime()) < 3 * HOUR : false;
    return {
      location: s.location,
      label: s.location === 'fridge' ? 'Fridge' : 'Freezer',
      expected_device: s.old_name,
      paired: !!d,
      device: d ? tile(d) : null,
      reading_now_c: d && Number.isFinite(d.temperature_c) ? d.temperature_c : null,
      last_reading_at: f.last_probe_at || null,
      readings_24h: f.probe_24h || 0,
      last_hand_written_at: f.last_manual_at || null,
      feed_live: liveFeed,
      says: !d
        ? `${s.old_name} is not paired yet. Until it is, the kitchen log stays hand-written.`
        : liveFeed
          ? `Paired, and readings are reaching the kitchen log (${f.probe_24h || 0} in the last day).`
          : 'Paired, but its readings are NOT reaching the kitchen log. The automation below is what sends them.',
    };
  });

  const allPaired = probes.every(p => p.paired);
  const allFlowing = probes.every(p => p.feed_live);

  res.json({
    ...haState,
    token: {
      set: envToken || settingToken,
      where: envToken ? 'app environment (KITCHEN_SENSOR_TOKEN)'
            : settingToken ? 'settings row kitchen_sensor_token' : null,
      says: envToken || settingToken
        ? 'Wren is ready to accept probe readings.'
        : 'Wren is refusing every probe reading, because no sensor token is set. '
          + 'Until one is, readings have to be written in by hand on the kitchen screen.',
    },
    probes,
    verdict: !allPaired ? 'not_paired' : allFlowing ? 'working' : 'paired_not_flowing',
    verdict_says: !allPaired
      ? 'Pair the two kitchen thermometers first — everything else is waiting on that.'
      : allFlowing
        ? 'Both probes are paired and their readings are reaching the kitchen log. Nothing to do.'
        : 'Both probes are paired, but nothing is arriving. Home Assistant needs the automation below.',
    // Printed, not applied. Wren cannot write to ha-ladn's configuration.yaml, and
    // the token is Toby's to put in HA's own secrets file — this build adds no
    // secret of its own and puts no secret in an HTTP response.
    fix: {
      summary: 'Paste this into Home Assistant (Settings → Automations → edit in YAML), once.',
      needs: 'HA secrets.yaml must hold  wren_kitchen_token: "<the same token as Wren\'s KITCHEN_SENSOR_TOKEN>"',
      doc: 'wren-docs/kitchen/kitchen-sensor-token.md',
      rest_command: [
        'rest_command:',
        '  wren_kitchen_temp:',
        '    url: "http://your-server:8092/api/kitchen/sensor-log"',
        '    method: POST',
        '    content_type: "application/json"',
        '    headers:',
        '      x-kitchen-token: !secret wren_kitchen_token',
        '    payload: \'{"location":"{{ location }}","reading_c":{{ reading }},"sensor_id":"{{ sensor }}","source":"ha-ladn"}\'',
      ].join('\n'),
      automation: [
        'automation:',
        '  - alias: "Wren — kitchen probe readings"',
        '    trigger:',
        '      - platform: time_pattern',
        '        minutes: "/15"',
        '    action:',
        '      - service: rest_command.wren_kitchen_temp',
        '        data:',
        '          location: fridge',
        '          sensor: sensor.fridge_therm_temperature',
        '          reading: "{{ states(\'sensor.fridge_therm_temperature\') }}"',
        '      - service: rest_command.wren_kitchen_temp',
        '        data:',
        '          location: freezer',
        '          sensor: sensor.freezer_therm_temperature',
        '          reading: "{{ states(\'sensor.freezer_therm_temperature\') }}"',
      ].join('\n'),
      note: 'The old host-side feed (/app/ha-kitchen-temp-sync.sh, every 30 min) sends no token and is '
          + 'what stopped working on 14 Sep. Use one feed or the other, not both, or every reading lands twice.',
    },
  });
});

module.exports = router;
// Exported for scripts/b511-probe.js so the probe tests the real rules rather
// than a second copy of them.
module.exports.trafficLight = trafficLight;
module.exports.humanAgo     = humanAgo;
module.exports.tile         = tile;
module.exports.health       = health;
// nest-building (2026-11-02): the Nest Building page reads the same two kitchen
// probes, so it imports this list rather than keeping a second copy of the IEEEs.
module.exports.KITCHEN_SENSORS = KITCHEN_SENSORS;
// 3 Nov 2026: the Nest page ticks the walk-round and finds re-paired devices by the same rules.
module.exports.syncFound       = syncFound;
module.exports.foundInSession  = foundInSession;
module.exports.markRejoined    = markRejoined;
