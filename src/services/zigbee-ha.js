'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * zigbee-ha.js — b511 (2026-10-19)
 *
 * Everything Wren knows about the nursery's Zigbee devices, read through Home
 * Assistant. There is no MQTT login here and b511 does not create one.
 *
 * ── WHY THROUGH HA AND NOT STRAIGHT TO MQTT ─────────────────────────────────
 * Zigbee2MQTT 2.14.2 runs as a HAOS add-on on ha-ladn and talks to HAOS's own
 * core-mosquitto. Wren already holds HA_LADN_URL + HA_LADN_TOKEN (b505, and the
 * doorbell before it). Adding a second credential to a second broker to reach
 * the same devices would be a new secret to rotate, a new thing to leak and a
 * second source of truth about what is paired. So:
 *
 *   reading   → HA REST  /api/states            (device state, battery, temps)
 *             → HA WS    config/*_registry/list (which devices exist, and where)
 *   writing   → HA REST  /api/services/mqtt/publish
 *                        → zigbee2mqtt/bridge/request/<...>
 *
 * The last one is the whole trick: HA's own mqtt integration will publish an
 * arbitrary topic for us, so a z2m bridge request (permit_join, device/rename,
 * device/remove) is one authenticated HTTP call with the token we already have.
 *
 * ── WHAT WE CANNOT DO, AND WHAT WE DO INSTEAD ───────────────────────────────
 * We cannot SUBSCRIBE, so we never see zigbee2mqtt/bridge/event. "Has anything
 * joined?" is therefore answered by polling HA's DEVICE REGISTRY and diffing it
 * against a baseline taken when joining was opened. That is actually the more
 * honest test: a device that joined z2m but did not reach HA is not finished,
 * and the wizard should not claim it is.
 *
 * ── THE TOKEN ───────────────────────────────────────────────────────────────
 * Read from env at call time, never logged, never returned, never put in an
 * error message. `_haErr()` strips anything that looks like one out of an error
 * before it is allowed to leave this module.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const catalog = require('../lib/zigbee-catalog');

// ── Config ──────────────────────────────────────────────────────────────────
const Z2M_BASE      = 'zigbee2mqtt';             // z2m base_topic; matches the add-on default
const STATES_TTL_MS = 20_000;                    // the page polls; HA should not be hammered
const REG_TTL_MS    = 30_000;
const WS_TIMEOUT_MS = 12_000;

function haUrl() {
  const u = process.env.HA_LADN_URL;
  if (!u) throw new Error('HA_LADN_URL not set');
  return u.replace(/\/$/, '');
}

function haToken() {
  const t = process.env.HA_LADN_TOKEN;
  if (!t || /^REPLACE_WITH/i.test(t)) {
    throw new Error('HA_LADN_TOKEN not configured — see wren-docs/integrations/homeassistant.md');
  }
  return t;
}

/** Is Home Assistant usable at all? Never throws — the page renders without it. */
function configured() {
  try { haUrl(); haToken(); return true; } catch { return false; }
}

/** True when the failure is "HA is not set up", rather than "HA said no". */
function notConfigured(e) {
  const m = String((e && e.message) || '');
  return /HA_LADN_(URL|TOKEN)/.test(m) || /not configured/i.test(m) || /not set/i.test(m);
}

/**
 * Scrub an error before it is shown to anybody. A bad HA response can echo the
 * request back, and the request carries the bearer token.
 */
function _haErr(e, fallback) {
  let m = String((e && e.message) || fallback || 'Home Assistant did not answer');
  const t = process.env.HA_LADN_TOKEN;
  if (t && t.length > 8) m = m.split(t).join('<token>');
  m = m.replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer <token>');
  return m.slice(0, 300);
}

// ── REST ────────────────────────────────────────────────────────────────────
async function _rest(path, { method = 'GET', body = null, timeout = 15_000 } = {}) {
  const ac = new AbortController();
  const t  = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(`${haUrl()}${path}`, {
      method,
      headers: { Authorization: `Bearer ${haToken()}`, 'Content-Type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      const err = new Error(`Home Assistant returned HTTP ${res.status}${txt ? ` — ${txt.slice(0, 160)}` : ''}`);
      err.status = res.status;
      throw err;
    }
    const txt = await res.text();
    return txt ? JSON.parse(txt) : null;
  } finally {
    clearTimeout(t);
  }
}

// ── States, cached ──────────────────────────────────────────────────────────
let _states = { at: 0, rows: null };

async function states({ force = false } = {}) {
  if (!force && _states.rows && Date.now() - _states.at < STATES_TTL_MS) return _states.rows;
  const rows = await _rest('/api/states');
  _states = { at: Date.now(), rows };
  return rows;
}

function clearCaches() {
  _states = { at: 0, rows: null };
  _reg    = { at: 0, data: null };
}

// ── Registries, over the WebSocket API ──────────────────────────────────────
// HA exposes areas, devices and the entity→device mapping ONLY on the WebSocket
// API; there is no REST equivalent. One short-lived connection, three calls,
// close. Cached for 30 s because the page polls and none of this moves often.
let _reg = { at: 0, data: null };
let _regInFlight = null;

function _wsFetch() {
  return new Promise((resolve, reject) => {
    let WebSocket;
    try { WebSocket = require('ws'); }
    catch { return reject(new Error('The ws module is not installed, so the device list cannot be read.')); }

    const url = haUrl().replace(/^http/, 'ws') + '/api/websocket';
    let ws;
    try { ws = new WebSocket(url); } catch (e) { return reject(e); }

    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('Home Assistant did not answer within 12 seconds.')), WS_TIMEOUT_MS);

    let id = 1;
    const pending = new Map();
    const call = (type) => new Promise((res, rej) => {
      const i = id++;
      pending.set(i, { res, rej });
      ws.send(JSON.stringify({ id: i, type }));
    });

    ws.on('error', e => finish(e));
    ws.on('close', () => finish(new Error('Home Assistant closed the connection before answering.')));
    ws.on('message', async (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'auth_required') {
        try { ws.send(JSON.stringify({ type: 'auth', access_token: haToken() })); }
        catch (e) { finish(e); }
        return;
      }
      if (m.type === 'auth_invalid') return finish(new Error('Home Assistant refused the token.'));
      if (m.type === 'auth_ok') {
        try {
          const [areas, devices, entities] = await Promise.all([
            call('config/area_registry/list'),
            call('config/device_registry/list'),
            call('config/entity_registry/list'),
          ]);
          return finish(null, {
            areas: areas.result || [],
            devices: devices.result || [],
            entities: entities.result || [],
          });
        } catch (e) { return finish(e); }
      }
      if (m.type === 'result' && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.success ? p.res(m) : p.rej(new Error((m.error && m.error.message) || 'Home Assistant refused the request.'));
      }
    });
  });
}

async function registries({ force = false } = {}) {
  if (!force && _reg.data && Date.now() - _reg.at < REG_TTL_MS) return _reg.data;
  if (_regInFlight) return _regInFlight;          // the page fires several calls at once
  _regInFlight = _wsFetch()
    .then(data => { _reg = { at: Date.now(), data }; return data; })
    .finally(() => { _regInFlight = null; });
  return _regInFlight;
}

/**
 * One WebSocket command, authenticated, result returned. Used by the two
 * registry WRITES below and nothing else — reads go through registries(), which
 * batches and caches.
 */
function _wsCommand(msg) {
  return new Promise((resolve, reject) => {
    let WebSocket;
    try { WebSocket = require('ws'); }
    catch { return reject(new Error('The ws module is not installed, so the room cannot be changed.')); }

    let ws;
    try { ws = new WebSocket(haUrl().replace(/^http/, 'ws') + '/api/websocket'); }
    catch (e) { return reject(e); }

    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      err ? reject(err) : resolve(val);
    };
    const timer = setTimeout(() => finish(new Error('Home Assistant did not answer within 12 seconds.')), WS_TIMEOUT_MS);

    ws.on('error', e => finish(e));
    ws.on('close', () => finish(new Error('Home Assistant closed the connection before answering.')));
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'auth_required') {
        try { ws.send(JSON.stringify({ type: 'auth', access_token: haToken() })); }
        catch (e) { finish(e); }
        return;
      }
      if (m.type === 'auth_invalid') return finish(new Error('Home Assistant refused the token.'));
      if (m.type === 'auth_ok') {
        try { ws.send(JSON.stringify({ id: 1, ...msg })); } catch (e) { finish(e); }
        return;
      }
      if (m.type === 'result') {
        if (!m.success) return finish(new Error((m.error && m.error.message) || 'Home Assistant refused the request.'));
        return finish(null, m.result);
      }
    });
  });
}

/**
 * Find (or make) the HA area for one of our rooms, and return its area_id.
 * Rooms are catalogue constants, so a caller cannot invent one.
 */
async function ensureArea(roomKey) {
  const room = catalog.ROOM_BY_KEY[roomKey];
  if (!room || roomKey === 'unassigned') return null;
  const reg = await registries({ force: true });
  const existing = reg.areas.find(a => a.area_id === room.ha_area)
                || reg.areas.find(a => String(a.name || '').toLowerCase() === room.label.toLowerCase());
  if (existing) return existing.area_id;
  const made = await _wsCommand({ type: 'config/area_registry/create', name: room.label });
  clearCaches();
  return made && made.area_id ? made.area_id : null;
}

/** Move a device into a room (an HA area), or out of every room. */
async function setDeviceRoom(ha_device_id, roomKey) {
  if (!ha_device_id) {
    const e = new Error('That device is not in Home Assistant, so it has no room to move.');
    e.code = 'no_device';
    throw e;
  }
  const area_id = roomKey === 'unassigned' ? null : await ensureArea(roomKey);
  await _wsCommand({ type: 'config/device_registry/update', device_id: ha_device_id, area_id });
  clearCaches();
  return { ha_device_id, room: roomKey, area_id };
}

// ── Turning HA's three registries into "devices" ────────────────────────────
// z2m's HA discovery gives every paired device a device-registry entry whose
// identifiers are ["mqtt", "zigbee2mqtt_<ieee>"]. The bridge itself matches the
// same pattern (its "ieee" is the coordinator's address), so it is filtered out
// by name/model rather than by address.
const Z2M_IDENT = /^zigbee2mqtt_(0x[0-9a-f]{16})$/i;

function _z2mIeee(dev) {
  for (const pair of dev.identifiers || []) {
    const v = Array.isArray(pair) ? pair[1] : null;
    const m = v && Z2M_IDENT.exec(String(v));
    if (m) return m[1].toLowerCase();
  }
  return null;
}

const isBridgeDevice = dev =>
  String(dev.model || '') === 'Bridge' || /zigbee2mqtt bridge/i.test(String(dev.name || ''));

/** Pick the one useful number out of an entity whose id ends in a known suffix. */
function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every Zigbee device HA currently knows about, with the bits the page needs.
 * Shape is deliberately flat and free of HA jargon.
 */
async function devices({ force = false } = {}) {
  const [reg, st] = await Promise.all([registries({ force }), states({ force })]);
  const stateById = new Map(st.map(e => [e.entity_id, e]));
  const entsByDevice = new Map();
  for (const e of reg.entities) {
    if (!e.device_id) continue;
    if (!entsByDevice.has(e.device_id)) entsByDevice.set(e.device_id, []);
    entsByDevice.get(e.device_id).push(e);
  }
  const areaName = Object.fromEntries(reg.areas.map(a => [a.area_id, a.name]));

  const out = [];
  for (const dev of reg.devices) {
    const ieee = _z2mIeee(dev);
    if (!ieee || isBridgeDevice(dev)) continue;

    const ents = entsByDevice.get(dev.id) || [];
    const rows = ents
      .map(e => ({ reg: e, st: stateById.get(e.entity_id) || null }))
      .filter(r => r.st);

    const pick = (suffix) => rows.find(r => r.reg.entity_id.endsWith(suffix));
    const battery  = pick('_battery');
    const temp     = pick('_temperature');
    const humidity = pick('_humidity');
    const lq       = pick('_linkquality');
    const lastSeen = pick('_last_seen');

    // "When did we last hear from it?" — z2m publishes a last_seen sensor only
    // when advanced.last_seen is configured, which it is not here. So: that
    // sensor if it exists, else the newest last_changed across the device's own
    // entities, which moves every time any value is reported.
    let heardAt = null;
    if (lastSeen && lastSeen.st && !['unknown', 'unavailable'].includes(lastSeen.st.state)) {
      const d = new Date(lastSeen.st.state);
      if (!isNaN(d)) heardAt = d.toISOString();
    }
    if (!heardAt) {
      for (const r of rows) {
        const d = new Date(r.st.last_changed || r.st.last_updated || 0);
        if (!isNaN(d) && (!heardAt || d > new Date(heardAt))) heardAt = d.toISOString();
      }
    }

    // Unavailable on EVERY entity is how z2m says "offline" (availability is
    // enabled in configuration.yaml). One unavailable entity among several is
    // usually a disabled-by-default diagnostic, not an offline device.
    const live = rows.filter(r => !['unavailable', 'unknown'].includes(r.st.state));
    const offline = rows.length > 0 && live.length === 0;

    const model = dev.model || null;
    const info  = catalog.modelInfo(model);
    const old   = catalog.oldDevice(ieee);

    out.push({
      ieee,
      ha_device_id: dev.id,
      name: dev.name_by_user || dev.name || ieee,
      model,
      vendor: dev.manufacturer || null,
      type: info.type,
      router: !!info.router,
      ha_area: dev.area_id || null,
      ha_area_name: dev.area_id ? (areaName[dev.area_id] || null) : null,
      room: (catalog.ROOM_BY_AREA[dev.area_id] && catalog.ROOM_BY_AREA[dev.area_id].key)
            || (old && old.room) || catalog.roomFromName(dev.name_by_user || dev.name),
      battery_pct: battery ? _num(battery.st.state) : null,
      temperature_c: temp ? _num(temp.st.state) : null,
      humidity_pct: humidity ? _num(humidity.st.state) : null,
      linkquality: lq ? _num(lq.st.state) : null,
      last_seen: heardAt,
      offline,
      entity_count: rows.length,
      entities: rows.map(r => ({ entity_id: r.reg.entity_id, state: r.st.state,
                                 name: r.st.attributes && r.st.attributes.friendly_name })),
      was_on_old_network: !!old,
      old_name: old ? old.old_name : null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// ── The coordinator / bridge ────────────────────────────────────────────────
// There are TWO bridge devices in HA's registry: the old TI stick's
// (0x00124b0030cc4621, dead since it was lost) and the Sonoff Dongle-M that
// formed the new network on 18 Oct. Asking "is the bridge online?" by name
// would get the wrong answer half the time, so the live one is the one whose
// connection-state entity is actually `on`, and the version sensor comes from
// whichever bridge reports one.
async function bridge({ force = false } = {}) {
  const st = await states({ force });
  const by = id => st.find(e => e.entity_id === id) || null;
  const all = pred => st.filter(pred);

  const conn = all(e => /^binary_sensor\.zigbee2mqtt_bridge_connection_state/.test(e.entity_id));
  const online = conn.some(e => e.state === 'on');
  const version = (by('sensor.zigbee2mqtt_bridge_version') || {}).state || null;
  const permitEnt = all(e => /^switch\.zigbee2mqtt_bridge_permit_join/.test(e.entity_id));
  const permit = permitEnt.find(e => e.state === 'on') || permitEnt[0] || null;

  // How long has it been down? HA's last_changed on the connection sensor is
  // exactly "when it went off", which is what the 10-minute warning needs.
  let offline_since = null;
  if (!online && conn.length) {
    for (const e of conn) {
      const d = new Date(e.last_changed || e.last_updated || 0);
      if (!isNaN(d) && (!offline_since || d > new Date(offline_since))) offline_since = d.toISOString();
    }
  }

  return {
    online,
    version,
    offline_since,
    offline_minutes: offline_since ? Math.floor((Date.now() - new Date(offline_since)) / 60000) : 0,
    permit_join: permit ? permit.state === 'on' : null,
    permit_entity: permit ? permit.entity_id : null,
    bridges_seen: conn.length,
  };
}

// ── HA backups ──────────────────────────────────────────────────────────────
// "Is there a copy of the network?" in Toby's words. The Zigbee network key and
// the device list live inside z2m's add-on data, so a HAOS backup IS the backup.
// The supervisor API needs a supervisor token we do not have, so this reads the
// backup integration's own entities, which the long-lived token can see.
async function backups({ force = false } = {}) {
  const st = await states({ force });
  const by = id => st.find(e => e.entity_id === id) || null;
  const val = (e) => (e && !['unknown', 'unavailable', ''].includes(e.state)) ? e.state : null;

  const last = val(by('sensor.backup_last_successful_automatic_backup'))
            || val(by('event.backup_automatic_backup'));
  const next  = val(by('sensor.backup_next_scheduled_automatic_backup'));
  const state = val(by('sensor.backup_backup_manager_state'));

  let age_days = null;
  if (last) {
    const d = new Date(last);
    if (!isNaN(d)) age_days = Math.floor((Date.now() - d) / 86400000);
  }
  return {
    known: !!(last || next || state),
    last_backup_at: last, next_backup_at: next, manager_state: state, age_days,
  };
}

// ── Writing: z2m bridge requests, via HA's mqtt.publish ─────────────────────
// The ONLY way anything in b511 changes the Zigbee network. Each wrapper below
// builds its own topic from a fixed string plus a validated argument; a caller
// never supplies a topic.
async function _publish(topic, payload) {
  await _rest('/api/services/mqtt/publish', {
    method: 'POST',
    body: { topic, payload: typeof payload === 'string' ? payload : JSON.stringify(payload), qos: 0, retain: false },
  });
  return true;
}

const IEEE_RE = /^0x[0-9a-f]{16}$/;
function assertIeee(ieee) {
  const v = String(ieee || '').toLowerCase();
  if (!IEEE_RE.test(v)) {
    const e = new Error('That is not a device address.');
    e.code = 'bad_ieee';
    throw e;
  }
  return v;
}

/** Open joining for `seconds` (clamped 10–254 — z2m's own ceiling is 254). */
async function permitJoin(seconds) {
  const t = Math.max(10, Math.min(254, Math.round(Number(seconds) || 120)));
  await _publish(`${Z2M_BASE}/bridge/request/permit_join`, { time: t });
  clearCaches();
  return { seconds: t, until: new Date(Date.now() + t * 1000).toISOString() };
}

/** Close joining. Sending time:0 is z2m's documented "stop now". */
async function closeJoin() {
  await _publish(`${Z2M_BASE}/bridge/request/permit_join`, { time: 0 });
  clearCaches();
  return { seconds: 0 };
}

async function renameDevice(ieee, to) {
  const from = assertIeee(ieee);
  const name = String(to || '').trim();
  // z2m uses the friendly name as an MQTT topic segment, so / and # and + are
  // genuinely dangerous there, not merely ugly.
  if (!name || name.length > 60 || /[\/#+$]/.test(name)) {
    const e = new Error('A name of 1–60 characters, without / # + or $.');
    e.code = 'bad_name';
    throw e;
  }
  await _publish(`${Z2M_BASE}/bridge/request/device/rename`, { from, to: name, homeassistant_rename: true });
  clearCaches();
  return { ieee: from, name };
}

/** Take a device off the network. force only after a plain remove has failed. */
async function removeDevice(ieee, { force = false } = {}) {
  const id = assertIeee(ieee);
  await _publish(`${Z2M_BASE}/bridge/request/device/remove`, { id, force: !!force, block: false });
  clearCaches();
  return { ieee: id, force: !!force };
}

/** Set a z2m device option — used for nothing yet; kept so callers need not publish. */
async function setOptions(ieee, options) {
  const id = assertIeee(ieee);
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    const e = new Error('Options must be an object.');
    e.code = 'bad_options';
    throw e;
  }
  await _publish(`${Z2M_BASE}/bridge/request/device/options`, { id, options });
  clearCaches();
  return { ieee: id };
}

// ── Climate (the radiators) ─────────────────────────────────────────────────
// The TRVs are driven through their Better Thermostat wrappers, which is what
// b505's Building tab already does and what HA's own dashboard does. The
// allow-list is DERIVED, not typed: an entity is controllable only if HA's own
// registry says it belongs to a Better Thermostat device or to a z2m device. A
// client-supplied entity id therefore cannot reach callService, which is the
// property b505's ha_entities table exists to guarantee.
async function controllableClimate({ force = false } = {}) {
  const [reg, st] = await Promise.all([registries({ force }), states({ force })]);
  const devById = new Map(reg.devices.map(d => [d.id, d]));
  const areaName = Object.fromEntries(reg.areas.map(a => [a.area_id, a.name]));
  const stateById = new Map(st.map(e => [e.entity_id, e]));

  const out = [];
  for (const e of reg.entities) {
    if (!e.entity_id.startsWith('climate.')) continue;
    const dev = e.device_id ? devById.get(e.device_id) : null;
    const viaBetter = dev && /better[_ ]?thermostat/i.test(String(dev.manufacturer || ''));
    const viaZ2m    = dev && _z2mIeee(dev);
    if (!viaBetter && !viaZ2m) continue;

    const s = stateById.get(e.entity_id);
    const area = (dev && dev.area_id) || e.area_id || null;
    out.push({
      entity_id: e.entity_id,
      _label_key: String((dev && (dev.name_by_user || dev.name))
                      || (s && s.attributes && s.attributes.friendly_name) || e.entity_id)
                  .toLowerCase().replace(/[^a-z0-9]+/g, ''),
      label: (dev && (dev.name_by_user || dev.name)) || (s && s.attributes && s.attributes.friendly_name) || e.entity_id,
      room: (catalog.ROOM_BY_AREA[area] && catalog.ROOM_BY_AREA[area].key) || 'unassigned',
      ha_area_name: area ? (areaName[area] || null) : null,
      source: viaBetter ? 'better_thermostat' : 'zigbee2mqtt',
      ieee: viaZ2m || null,
      state: s ? s.state : 'unavailable',
      available: !!s && !['unavailable', 'unknown'].includes(s.state),
      current_temperature: s && s.attributes ? _num(s.attributes.current_temperature) : null,
      temperature: s && s.attributes ? _num(s.attributes.temperature) : null,
      hvac_action: s && s.attributes ? (s.attributes.hvac_action || null) : null,
      min_temp: s && s.attributes ? (_num(s.attributes.min_temp) ?? 5) : 5,
      max_temp: s && s.attributes ? (_num(s.attributes.max_temp) ?? 28) : 28,
    });
  }
  // ⚠️ DE-DUPLICATE. A TRV that has a Better Thermostat wrapper appears TWICE:
  // once as the wrapper (climate.ps1_front_rad_2) and once as z2m's own entity
  // for the same valve (climate.ps1_front_rad). Both are real and both work —
  // but showing a person two rows called "PS1 front rad", one of which fights
  // the other, is exactly the kind of thing this page exists to stop. The
  // wrapper wins: it is what the nursery's heating actually runs on, and it is
  // what b505's Building tab and HA's own dashboard drive.
  const byLabel = new Map();
  for (const r of out) {
    const prev = byLabel.get(r._label_key);
    if (!prev || (r.source === 'better_thermostat' && prev.source !== 'better_thermostat')) {
      byLabel.set(r._label_key, r);
    }
  }
  return [...byLabel.values()]
    .map(({ _label_key, ...r }) => r)
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Set a radiator target. Caller MUST have checked controllableClimate() first. */
async function setTemperature(entity_id, temperature) {
  await _rest('/api/services/climate/set_temperature', {
    method: 'POST',
    body: { entity_id, temperature },
  });
  clearCaches();
  return { entity_id, temperature };
}

// ── nest-building (2026-11-02): one HA service call, for the boiler ─────────
// The Hive thermostat is not a z2m or Better Thermostat device, so
// controllableClimate() rightly does not list it. src/routes/nest-building.js
// drives it through this, with the ENTITY ID FIXED SERVER-SIDE (never taken from a
// request) and the domain/service pair checked against its own short allow-list
// there. Same token handling as everything else in this file: _rest() sends it,
// _haErr() scrubs it from anything that might be shown.
async function callService(domain, service, data) {
  if (!/^[a-z_]+$/.test(String(domain)) || !/^[a-z_]+$/.test(String(service))) {
    throw new Error('bad service name');
  }
  const out = await _rest(`/api/services/${domain}/${service}`, { method: 'POST', body: data || {} });
  clearCaches();
  return out;
}

module.exports = {
  Z2M_BASE,
  callService,
  configured, notConfigured, _haErr,
  states, registries, clearCaches,
  devices, bridge, backups,
  ensureArea, setDeviceRoom,
  permitJoin, closeJoin, renameDevice, removeDevice, setOptions,
  controllableClimate, setTemperature,
  assertIeee,
};
