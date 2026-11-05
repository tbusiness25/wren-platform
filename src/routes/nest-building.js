'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * nest-building.js — 2026-11-02 — mounted at /api/nest-building.
 *
 * The server end of Nest → More → The Setting → Building (/ey/building).
 * Toby: "can you also allow the heating and other bits for leadership staff on Nest?"
 *
 * WHAT IT DOES
 *   GET  /summary            radiators (per room), boiler, kitchen fridge/freezer, devices + pairing status
 *   POST /radiator           { entity_id, temperature }      a room radiator's target (5–24°C)
 *   POST /boiler             { temperature }                 the Hive thermostat's target (5–24°C)
 *   POST /boiler/boost       { minutes, temperature? }       Hive boost on (30/60/120 min, 5–24°C)
 *   POST /boiler/boost/off                                   Hive boost off
 *   POST /join/open          { seconds? }                    open Zigbee pairing ("Add a device")
 *   GET  /join/status        ?baseline=ieee,ieee             is it open, what has joined
 *   POST /join/close         { found? }                      close pairing
 *
 * HOW IT IS GATED
 *   authenticate → EY portal only (req._portal === 'learning') → staff only →
 *   requireCapability('building.view'); every write adds requireCapability('building.manage').
 *   Both capabilities are in MATRIX_REQUIRED_CAPS, granted by
 *   migrations/2026-11-02-nest-building.sql to room-leader + deputy (+ manager) only —
 *   Toby's leadership tier (login-20261023) and up. A practitioner gets 403 on every route.
 *   The Roost page (building-devices.js, building.devices.*) is untouched and separate.
 *
 * WHAT IT TOUCHES
 *   Home Assistant via the SAME client as building-devices.js (src/services/zigbee-ha.js,
 *   HA_LADN_URL / HA_LADN_TOKEN, token scrubbed by _haErr). The radiator allow-list is
 *   DERIVED from HA's registry (controllableClimate) — a client entity id never reaches a
 *   service call unless HA itself says it is a nursery valve. The boiler entity is FIXED here.
 *   Pairing writes the same zigbee_join_sessions table as Roost, so both pages agree on
 *   whether the network is open. Every change is audited (who = req.user, which room,
 *   from → to). No child, parent or family data anywhere in this file.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const express = require('express');
const router  = express.Router();

const { getPool }           = require('../db/pool');
const authenticate          = require('../middleware/auth');
const { requireCapability } = require('../lib/capabilities');
const { recordAudit }       = require('../utils/audit');

const z2m     = require('../services/zigbee-ha');
const catalog = require('../lib/zigbee-catalog');
const bd      = require('./building-devices');   // tile() / trafficLight() / KITCHEN_SENSORS — one definition

// ── The boiler: fixed server-side, never from a request ─────────────────────
const BOILER_ENTITY       = 'climate.thermostat_2';          // Hive thermostat on ha-ladn
const BOILER_BOOST_SENSOR = 'binary_sensor.thermostat_2_boost';
const HEATING_AUTO_FLAG   = 'input_boolean.ladn_heating_auto'; // HA's heating schedule switch
const MIN_C = 5;
const MAX_C = 24;
const BOOST_MINUTES = [30, 60, 120];
const BOOST_DEFAULT_C = 22;
const KITCHEN_FRESH_MS = 12 * 60 * 60 * 1000;

const HA_HELP = 'Home Assistant is not connected to Wren yet, so the heating cannot be shown. Tell Toby.';

// ── The gate ────────────────────────────────────────────────────────────────
function nestOnly(req, res, next) {
  if ((req._portal || null) !== 'learning') {
    return res.status(403).json({ error: 'forbidden_portal',
      message: 'This is the Nest (room tablet) Building page. On Roost, use Building & devices.' });
  }
  if (!req.user || req.user.role === 'parent') {
    return res.status(403).json({ error: 'forbidden', message: 'Staff only.' });
  }
  next();
}
const view   = [authenticate, nestOnly, requireCapability('building.view')];
const manage = [authenticate, nestOnly, requireCapability('building.view'), requireCapability('building.manage')];

router.use(express.json({ limit: '8kb' }));

function haFail(res, e, fallback) {
  if (z2m.notConfigured(e)) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });
  return res.status(502).json({ error: 'ha_unreachable', message: z2m._haErr(e, fallback || 'Home Assistant did not answer.') });
}

function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Half-degree steps, inside the clamp — or null if it is not a sensible number.
function cleanTemp(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < MIN_C || n > MAX_C) return null;
  return Math.round(n * 2) / 2;
}

function boilerFrom(states) {
  const by = new Map((states || []).map(s => [s.entity_id, s]));
  const s = by.get(BOILER_ENTITY);
  if (!s) return { found: false, says: 'The boiler thermostat is not showing in Home Assistant.' };
  const a = s.attributes || {};
  const boostSensor = by.get(BOILER_BOOST_SENSOR);
  const boosting = a.preset_mode === 'boost' || (boostSensor && boostSensor.state === 'on');
  const auto = by.get(HEATING_AUTO_FLAG);
  const available = !['unavailable', 'unknown'].includes(s.state);
  const target = num(a.temperature);
  const current = num(a.current_temperature);
  return {
    found: true,
    available,
    mode: s.state,                         // heat | auto | off
    heating_now: a.hvac_action === 'heating',
    current_temperature: current,
    temperature: target,
    boosting: !!boosting,
    schedule_on: auto ? auto.state === 'on' : null,
    min: MIN_C, max: MAX_C,
    boost_minutes: BOOST_MINUTES,
    boost_default_c: BOOST_DEFAULT_C,
    says: !available ? 'The boiler thermostat is not answering.'
      : boosting ? `Boost is on${target !== null ? ` (${target}°C)` : ''}.`
      : s.state === 'off' ? 'The boiler is off.'
      : `Set to ${target}°C${current !== null ? `, the thermostat reads ${current}°C` : ''}${a.hvac_action === 'heating' ? ' — heating now' : ''}.`,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// GET /summary — everything the page draws, in one call.
// ═════════════════════════════════════════════════════════════════════════════
router.get('/summary', ...view, async (req, res) => {
  const db = getPool();
  const force = req.query.refresh === '1';
  const out = { configured: z2m.configured(), reason: null, rooms: [], boiler: null, kitchen: [], devices: null, pairing: null };

  // Kitchen thresholds + last logged reading come from Wren's own tables, so they show
  // even when HA is down. Counts/numbers about appliances only.
  let thresholds = new Map(), lastLog = new Map();
  try {
    const { rows } = await db.query(`SELECT location, label, min_c, max_c FROM kitchen_temp_thresholds`);
    thresholds = new Map(rows.map(r => [r.location, r]));
  } catch { /* table missing on this schema: no range shown */ }
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (location) location, reading_c, source, recorded_at
         FROM kitchen_sensor_readings
        WHERE location = ANY($1::text[])
        ORDER BY location, recorded_at DESC`, [bd.KITCHEN_SENSORS.map(s => s.location)]);
    lastLog = new Map(rows.map(r => [r.location, r]));
  } catch { /* no readings table: nothing logged */ }

  let devices = [], climate = [], states = [], bridge = null, haErr = null;
  if (out.configured) {
    try {
      [devices, climate, states, bridge] = await Promise.all([
        z2m.devices({ force }),
        z2m.controllableClimate({ force }),
        z2m.states({ force }),
        z2m.bridge({ force }).catch(() => null),
      ]);
    } catch (e) {
      haErr = z2m.notConfigured(e) ? HA_HELP : z2m._haErr(e, 'Home Assistant did not answer.');
    }
  } else {
    haErr = HA_HELP;
  }
  out.reason = haErr;

  // ── Radiators, grouped by room ────────────────────────────────────────────
  const rads = climate.map(r => ({
    entity_id: r.entity_id,
    label: r.label,
    room: r.room,
    room_label: catalog.roomLabel(r.room),
    available: r.available,
    current_temperature: r.current_temperature,
    temperature: r.temperature,
    heating_now: r.hvac_action === 'heating',
    min: Math.max(MIN_C, num(r.min_temp) ?? MIN_C),
    max: Math.min(MAX_C, num(r.max_temp) ?? MAX_C),
  }));
  out.rooms = catalog.ROOMS
    .map(room => ({ key: room.key, label: room.label, radiators: rads.filter(r => r.room === room.key) }))
    .filter(room => room.radiators.length);

  // ── Boiler ────────────────────────────────────────────────────────────────
  out.boiler = states.length ? boilerFrom(states) : null;

  // ── Kitchen fridge / freezer ──────────────────────────────────────────────
  const byIeee = new Map(devices.map(d => [d.ieee, d]));
  out.kitchen = bd.KITCHEN_SENSORS.map(s => {
    const d = byIeee.get(s.ieee) || null;
    const th = thresholds.get(s.location) || null;
    const log = lastLog.get(s.location) || null;
    const live = d && Number.isFinite(d.temperature_c) ? d.temperature_c : null;
    // 3 Nov 2026: a logged reading only stands in for a live one while it is recent. With the
    // probes asleep this card showed 14 Sep's 24°C / 27°C as today's and said "Tell the kitchen
    // and a manager". 12 h covers the cook's twice-a-day hand checks.
    const fresh = !!(log && Date.now() - new Date(log.recorded_at).getTime() < KITCHEN_FRESH_MS);
    const shown = live !== null ? live : (fresh ? num(log.reading_c) : null);
    const min = th ? num(th.min_c) : null, max = th ? num(th.max_c) : null;
    const inRange = shown === null || min === null || max === null ? null : (shown >= min && shown <= max);
    return {
      location: s.location,
      label: (th && th.label) || (s.location === 'fridge' ? 'Fridge' : 'Freezer'),
      paired: !!d,
      light: d ? bd.trafficLight(d) : null,
      reading_now_c: live,
      last_logged_c: log ? num(log.reading_c) : null,
      last_logged_at: log ? log.recorded_at : null,
      last_logged_by: log ? (log.source === 'manual' ? 'written in by hand' : 'the probe') : null,
      last_logged_fresh: fresh,
      min_c: min, max_c: max,
      in_range: inRange,
      says: shown === null
        ? (log ? `No recent ${s.location} reading — ${d ? 'its thermometer is not reporting' : 'its thermometer is not paired'}. Check it by hand on the kitchen screen.`
               : `No ${s.location} reading yet — ${d ? 'the probe is paired but has not reported' : 'its thermometer is not paired'}.`)
        : inRange === false ? `${shown}°C — OUTSIDE the safe range (${min} to ${max}°C). Tell the kitchen and a manager.`
        : inRange === true ? `${shown}°C — within the safe range (${min} to ${max}°C).`
        : `${shown}°C.`,
    };
  });

  // ── Devices + pairing ─────────────────────────────────────────────────────
  const tiles = devices.map(bd.tile);
  const counts = { green: 0, amber: 0, red: 0 };
  for (const t of tiles) counts[t.light.level]++;
  // 3 Nov 2026 — the walk round. The old network is back on the hub, so each of the old
  // devices that is not answering gets the ONE thing to do about it (catalog.bringBack),
  // in walking order: plugs first, then a quick press, then the valves that must be
  // paired again. "Back" is what HA shows right now, so the list ticks itself.
  let recovery = null, walkround = null;
  try {
    if (devices.length) await bd.syncFound(db, devices);
    const { rows } = await db.query(
      `SELECT ieee, old_name, model, room, status, needs_repair FROM zigbee_known_devices WHERE status <> 'retired'`);
    const KIND_ORDER = { power: 0, wake: 1, repair: 2 };
    const items = rows.map(r => {
      const d = byIeee.get(r.ieee) || null;
      const info = catalog.modelInfo(r.model);
      const type = catalog.typeInfo(info.type);
      const back = !!(d && !d.offline && !r.needs_repair);
      const named = (d && d.name) || r.old_name;
      return {
        ieee: r.ieee,
        // A device nobody named is called by its address in HA; nobody can find "0xa4c1…" on a wall.
        name: named && !/^0x[0-9a-f]{16}$/i.test(named) ? named : `${info.name} (no name yet)`,
        icon: type.icon, type_label: type.label,
        room_label: catalog.roomLabel((d && d.room) || r.room),
        back,
        action: back ? null : catalog.bringBack(r.model, { needsRepair: r.needs_repair }),
      };
    });
    const todo = items.filter(i => !i.back).sort((a, b) =>
      KIND_ORDER[a.action.kind] - KIND_ORDER[b.action.kind]
      || (a.room_label || '').localeCompare(b.room_label || '') || a.name.localeCompare(b.name));
    const backN = items.length - todo.length;
    recovery = { total: items.length, found: backN, outstanding: todo.length };
    walkround = items.length ? {
      total: items.length, back: backN,
      says: todo.length ? `${backN} of ${items.length} devices are working.` : `All ${items.length} devices are working.`,
      todo,
    } : null;
  } catch (e) { console.error('[nest-building] walk-round not built:', e.message); }
  out.devices = {
    total: tiles.length, ...counts,
    says: !out.configured || haErr ? null
      : tiles.length === 0 ? 'Nothing is paired yet.'
      : `${counts.green} working${counts.amber ? `, ${counts.amber} need${counts.amber === 1 ? 's' : ''} a look` : ''}${counts.red ? `, ${counts.red} not responding` : ''}.`,
    recovery: recovery && recovery.total
      ? { ...recovery, says: `${recovery.found} of ${recovery.total} devices from the old network are working.` } : null,
    walkround,
    list: tiles
      .sort((a, b) => (a.room_label || '').localeCompare(b.room_label || '') || a.name.localeCompare(b.name))
      .map(t => ({ ieee: t.ieee, name: t.name, icon: t.icon, type_label: t.type_label,
                   room_label: t.room_label, light: t.light, battery_pct: t.battery_pct })),
  };
  out.pairing = {
    hub_online: bridge ? !!bridge.online : null,
    open: bridge ? bridge.permit_join === true : null,
  };

  res.json(out);
});

// ═════════════════════════════════════════════════════════════════════════════
// Radiators
// ═════════════════════════════════════════════════════════════════════════════
router.post('/radiator', ...manage, async (req, res) => {
  if (!z2m.configured()) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });
  const entity_id = String((req.body && req.body.entity_id) || '').trim().toLowerCase();
  const temperature = cleanTemp(req.body && req.body.temperature);
  if (temperature === null) {
    return res.status(400).json({ error: 'bad_temperature', message: `Pick something between ${MIN_C}°C and ${MAX_C}°C.` });
  }
  let row;
  try { row = (await z2m.controllableClimate({ force: true })).find(r => r.entity_id === entity_id); }
  catch (e) { return haFail(res, e); }
  if (!row) {
    return res.status(403).json({ error: 'not_a_radiator',
      message: 'That is not one of the nursery\'s radiator valves. Nothing was changed.' });
  }
  if (!row.available) {
    return res.status(409).json({ error: 'unavailable', message: `${row.label} is not answering, so it cannot be changed right now.` });
  }
  try { await z2m.setTemperature(row.entity_id, temperature); }
  catch (e) { return haFail(res, e, 'Home Assistant would not set that temperature.'); }

  await recordAudit({ req, action: 'update', entity_type: 'ha_climate', entity_id: row.entity_id,
    diff: { old: { temperature: row.temperature }, new: { temperature } },
    meta: { label: row.label, room: catalog.roomLabel(row.room), via: 'nest-building' } });

  res.json({ ok: true, entity_id: row.entity_id, from: row.temperature, temperature,
    says: `${row.label} (${catalog.roomLabel(row.room)}) is now set to ${temperature}°C.` });
});

// ═════════════════════════════════════════════════════════════════════════════
// The boiler (Hive)
// ═════════════════════════════════════════════════════════════════════════════
async function readBoiler() {
  return boilerFrom(await z2m.states({ force: true }));
}

router.post('/boiler', ...manage, async (req, res) => {
  if (!z2m.configured()) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });
  const temperature = cleanTemp(req.body && req.body.temperature);
  if (temperature === null) {
    return res.status(400).json({ error: 'bad_temperature', message: `Pick something between ${MIN_C}°C and ${MAX_C}°C.` });
  }
  let before;
  try { before = await readBoiler(); } catch (e) { return haFail(res, e); }
  if (!before.found || !before.available) {
    return res.status(409).json({ error: 'unavailable', message: 'The boiler thermostat is not answering, so it cannot be changed right now.' });
  }
  try { await z2m.callService('climate', 'set_temperature', { entity_id: BOILER_ENTITY, temperature }); }
  catch (e) { return haFail(res, e, 'Home Assistant would not set the boiler.'); }

  await recordAudit({ req, action: 'update', entity_type: 'ha_climate', entity_id: BOILER_ENTITY,
    diff: { old: { temperature: before.temperature }, new: { temperature } },
    meta: { label: 'Boiler (Hive)', room: 'Whole building', via: 'nest-building' } });

  res.json({ ok: true, from: before.temperature, temperature,
    says: `The boiler is now set to ${temperature}°C.`
      + (before.schedule_on ? ' The heating schedule is on, so it will set the boiler again at its next change.' : '') });
});

router.post('/boiler/boost', ...manage, async (req, res) => {
  if (!z2m.configured()) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });
  const minutes = Number(req.body && req.body.minutes);
  if (!BOOST_MINUTES.includes(minutes)) {
    return res.status(400).json({ error: 'bad_minutes', message: 'Boost for 30 minutes, 1 hour or 2 hours.' });
  }
  const temperature = req.body && req.body.temperature !== undefined
    ? cleanTemp(req.body.temperature) : BOOST_DEFAULT_C;
  if (temperature === null) {
    return res.status(400).json({ error: 'bad_temperature', message: `Pick something between ${MIN_C}°C and ${MAX_C}°C.` });
  }
  let before;
  try { before = await readBoiler(); } catch (e) { return haFail(res, e); }
  if (!before.found || !before.available) {
    return res.status(409).json({ error: 'unavailable', message: 'The boiler thermostat is not answering, so it cannot be boosted right now.' });
  }
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(minutes % 60).padStart(2, '0');
  try {
    await z2m.callService('hive', 'boost_heating_on',
      { entity_id: BOILER_ENTITY, time_period: `${hh}:${mm}:00`, temperature });
  } catch (e) { return haFail(res, e, 'Home Assistant would not boost the boiler.'); }

  await recordAudit({ req, action: 'update', entity_type: 'ha_climate', entity_id: BOILER_ENTITY,
    diff: { old: { boost: before.boosting, temperature: before.temperature }, new: { boost: true, temperature, minutes } },
    meta: { label: 'Boiler (Hive) boost', room: 'Whole building', via: 'nest-building' } });

  res.json({ ok: true, minutes, temperature,
    says: `Boost is on: ${temperature}°C for ${minutes === 30 ? '30 minutes' : minutes === 60 ? '1 hour' : '2 hours'}. It switches itself off after that.` });
});

router.post('/boiler/boost/off', ...manage, async (req, res) => {
  if (!z2m.configured()) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });
  let before;
  try { before = await readBoiler(); } catch (e) { return haFail(res, e); }
  try { await z2m.callService('hive', 'boost_heating_off', { entity_id: BOILER_ENTITY }); }
  catch (e) { return haFail(res, e, 'Home Assistant would not stop the boost.'); }

  await recordAudit({ req, action: 'update', entity_type: 'ha_climate', entity_id: BOILER_ENTITY,
    diff: { old: { boost: before.boosting }, new: { boost: false } },
    meta: { label: 'Boiler (Hive) boost', room: 'Whole building', via: 'nest-building' } });

  res.json({ ok: true, says: 'Boost is off. The boiler goes back to its normal setting.' });
});

// ═════════════════════════════════════════════════════════════════════════════
// Pairing ("Add a device") — the same zigbee_join_sessions record as Roost
// ═════════════════════════════════════════════════════════════════════════════
router.post('/join/open', ...manage, async (req, res) => {
  const db = getPool();
  if (!z2m.configured()) return res.status(503).json({ error: 'ha_not_configured', message: HA_HELP });
  const want = Number(req.body && req.body.seconds);
  const secs = Number.isFinite(want) ? Math.max(10, Math.min(254, Math.round(want))) : 120;

  let baseline, baselineOffline;
  try {
    const before = await z2m.devices({ force: true });
    baseline = before.map(d => d.ieee);
    baselineOffline = before.filter(d => d.offline).map(d => d.ieee);
  }
  catch (e) { return haFail(res, e); }

  let opened;
  try { opened = await z2m.permitJoin(secs); }
  catch (e) { return haFail(res, e, 'The hub would not open the network.'); }

  // The network is OPEN now; bookkeeping failures are reported, never allowed to hide that.
  let id = null, logError = null;
  try {
    await db.query(`UPDATE zigbee_join_sessions SET closed_at = now(), close_reason = 'timeout' WHERE closed_at IS NULL`);
    const { rows } = await db.query(
      `INSERT INTO zigbee_join_sessions (opened_by, seconds, expires_at, expecting_type, baseline_count, baseline_offline)
       VALUES ($1, $2::int, now() + make_interval(secs => $2::int), $3, $4, $5::text[]) RETURNING id`,
      [req.user.id, secs, 'nest', baseline.length, baselineOffline]);
    id = rows[0].id;
  } catch (e) {
    logError = e.message;
    console.error('[nest-building] join session not recorded:', e.message);
  }

  await recordAudit({ req, action: 'update', entity_type: 'zigbee_permit_join', entity_id: String(id || 'unlogged'),
    diff: { new: { open: true, seconds: secs } }, meta: { via: 'nest-building', baseline_devices: baseline.length } });

  res.json({ ok: true, session_id: id, seconds: secs, expires_at: opened.until, baseline,
    log_warning: logError ? 'Pairing is open, but Wren could not record who opened it. Tell Toby.' : null,
    says: `Pairing is open for ${secs >= 60 ? `${Math.round(secs / 60)} minute${secs >= 120 ? 's' : ''}` : `${secs} seconds`}. Put the device into pairing mode now.` });
});

router.get('/join/status', ...view, async (req, res) => {
  const db = getPool();
  let session = null, sessionError = null;
  try {
    const { rows } = await db.query(
      `SELECT s.id, s.opened_at, s.expires_at, s.closed_at, s.baseline_count, s.baseline_offline,
              COALESCE(st.preferred_name, st.first_name) AS opened_by_name
         FROM zigbee_join_sessions s LEFT JOIN staff st ON st.id = s.opened_by
        ORDER BY s.opened_at DESC LIMIT 1`);
    session = rows[0] || null;
  } catch (e) { sessionError = e.message; }

  let found = [], hubSaysOpen = null;
  if (z2m.configured()) {
    try {
      const [devices, b] = await Promise.all([z2m.devices({ force: true }), z2m.bridge({ force: true })]);
      hubSaysOpen = b ? b.permit_join : null;
      if (session && !session.closed_at) {
        const back = bd.foundInSession(devices, session, req.query.baseline);
        try { await bd.markRejoined(db, back.map(d => d.ieee)); }
        catch (e) { console.error('[nest-building] rejoined device not ticked:', e.message); }
        found = back.map(d => {
          const t = bd.tile(d);
          const old = catalog.oldDevice(d.ieee);
          return { ieee: t.ieee, name: t.name, icon: t.icon, type_label: t.type_label, room_label: t.room_label,
                   welcome_back: old && old.old_name ? `This is the ${old.old_name} — welcome back.` : null };
        });
      }
    } catch { /* status still answers from Wren's own record */ }
  }
  const until = session && !session.closed_at ? new Date(session.expires_at) : null;
  const left = until ? Math.max(0, Math.round((until - Date.now()) / 1000)) : 0;
  res.json({
    unreliable: sessionError ? 'Wren could not read its own record of this. Close pairing when you are done.' : null,
    open: !!(session && !session.closed_at && left > 0),
    seconds_left: left,
    opened_by: session && session.opened_by_name ? String(session.opened_by_name).split(' ')[0] : null,
    hub_says_open: hubSaysOpen,
    found,
  });
});

router.post('/join/close', ...manage, async (req, res) => {
  const db = getPool();
  const foundIeee = Array.isArray(req.body && req.body.found)
    ? req.body.found.map(x => String(x).toLowerCase()).filter(x => /^0x[0-9a-f]{16}$/.test(x)).slice(0, 20) : [];
  let closeErr = null;
  if (z2m.configured()) {
    try { await z2m.closeJoin(); }
    catch (e) { closeErr = z2m._haErr(e, 'The hub did not confirm pairing was closed.'); }
  }
  try {
    await db.query(
      `UPDATE zigbee_join_sessions SET closed_at = now(), close_reason = 'done',
              found_ieee = CASE WHEN $1::text[] = '{}' THEN found_ieee ELSE $1::text[] END
        WHERE closed_at IS NULL`, [foundIeee]);
  } catch { /* the network is still closed, which is what matters */ }
  await recordAudit({ req, action: 'update', entity_type: 'zigbee_permit_join', entity_id: 'close',
    diff: { new: { open: false, reason: 'done' } }, meta: { via: 'nest-building', found: foundIeee } });
  if (closeErr) return res.status(502).json({ ok: false, error: 'close_failed', message: closeErr });
  res.json({ ok: true, closed: true, says: 'Pairing is closed.' });
});

module.exports = router;
module.exports.boilerFrom = boilerFrom;
module.exports.cleanTemp  = cleanTemp;
