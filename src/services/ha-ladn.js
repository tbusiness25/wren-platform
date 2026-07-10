'use strict';
// Home Assistant integration for LADN — discovery, state reads, service calls.
// All functions read HA_LADN_URL + HA_LADN_TOKEN from env at call time so
// the server can start in placeholder mode before the token is set.

const { getPool } = require('../db/pool');

function _haUrl() {
  const u = process.env.HA_LADN_URL;
  if (!u) throw new Error('HA_LADN_URL not set');
  return u.replace(/\/$/, '');
}

function _haToken() {
  const t = process.env.HA_LADN_TOKEN;
  if (!t || t.startsWith('REPLACE_WITH')) throw new Error('HA_LADN_TOKEN not configured — see wren-docs/integrations/homeassistant-md');
  return t;
}

function _haHeaders() {
  return {
    Authorization: `Bearer ${_haToken()}`,
    'Content-Type': 'application/json',
  };
}

// Returns all HA states (cached to avoid hammering HA)
let _statesCache = null;
let _statesCacheAt = 0;
const STATES_TTL_MS = 60_000;

async function _getAllStates() {
  if (_statesCache && Date.now() - _statesCacheAt < STATES_TTL_MS) return _statesCache;
  const res = await fetch(`${_haUrl()}/api/states`, { headers: _haHeaders() });
  if (!res.ok) throw new Error(`HA states: HTTP ${res.status}`);
  _statesCache = await res.json();
  _statesCacheAt = Date.now();
  return _statesCache;
}

function _matchesPatterns(entity, ...patterns) {
  const id = (entity.entity_id || '').toLowerCase();
  const name = (entity.attributes?.friendly_name || '').toLowerCase();
  return patterns.some(p => id.includes(p) || name.includes(p));
}

// Discover HA entity that looks like the VTO doorbell sensor
async function discoverDoorbellEntity() {
  const states = await _getAllStates();
  return states.find(e =>
    e.attributes?.device_class === 'doorbell' ||
    _matchesPatterns(e, 'doorbell', 'vto', 'front_door_ring', 'door_ring')
  ) || null;
}

// Discover HA entity that releases the front door
async function discoverDoorReleaseEntity() {
  const states = await _getAllStates();
  return states.find(e =>
    _matchesPatterns(e, 'door_release', 'front_door_release', 'door_unlock', 'entrance_lock') &&
    (e.entity_id.startsWith('switch.') || e.entity_id.startsWith('lock.') || e.entity_id.startsWith('button.'))
  ) || null;
}

// Get current state of a single entity
async function getEntityState(entity_id) {
  const res = await fetch(`${_haUrl()}/api/states/${entity_id}`, { headers: _haHeaders() });
  if (!res.ok) throw new Error(`HA getEntityState ${entity_id}: HTTP ${res.status}`);
  return res.json();
}

// Call an HA service  e.g. callService('switch','turn_on','switch.front_door_release')
async function callService(domain, service, entity_id, data = {}) {
  const body = JSON.stringify({ entity_id, ...data });
  const res = await fetch(`${_haUrl()}/api/services/${domain}/${service}`, {
    method: 'POST',
    headers: _haHeaders(),
    body,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`HA callService ${domain}.${service}: HTTP ${res.status} ${txt}`);
  }
  return res.json();
}

// Load entity IDs from ha_config table
async function getHaConfig() {
  const db = getPool();
  const { rows } = await db.query('SELECT key, entity_id FROM ha_config');
  return Object.fromEntries(rows.map(r => [r.key, r.entity_id]));
}

// Save discovered entity to ha_config
async function saveHaConfig(key, entity_id) {
  const db = getPool();
  await db.query(
    `INSERT INTO ha_config (key, entity_id, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET entity_id=$2, updated_at=NOW()`,
    [key, entity_id]
  );
}

// Run discovery on startup and log results
async function runDiscovery() {
  const token = process.env.HA_LADN_TOKEN;
  if (!token || token.startsWith('REPLACE_WITH')) {
    console.log('[ha-ladn] HA_LADN_TOKEN not set — skipping discovery (placeholder mode)');
    return;
  }

  console.log('[ha-ladn] Running entity discovery…');
  const current = await getHaConfig();

  try {
    if (!current.doorbell_entity) {
      const e = await discoverDoorbellEntity();
      if (e) {
        await saveHaConfig('doorbell_entity', e.entity_id);
        console.log(`[ha-ladn] Discovered doorbell_entity: ${e.entity_id}`);
        await _sendTelegramDiscovery(`Doorbell entity: ${e.entity_id}`);
      } else {
        console.log('[ha-ladn] No doorbell entity discovered — set manually in Admin > HA Integration');
      }
    }

    if (!current.door_release_entity) {
      const e = await discoverDoorReleaseEntity();
      if (e) {
        await saveHaConfig('door_release_entity', e.entity_id);
        console.log(`[ha-ladn] Discovered door_release_entity: ${e.entity_id}`);
        await _sendTelegramDiscovery(`Door release entity: ${e.entity_id}`);
      } else {
        console.log('[ha-ladn] No door release entity discovered — set manually in Admin > HA Integration');
      }
    }
  } catch (e) {
    console.error('[ha-ladn] Discovery error:', e.message);
  }
}

function _sendTelegramDiscovery(msg) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return Promise.resolve();
  const text = `[ha-ladn] Entity discovered:\n${msg}\n\nVerify at Admin > HA Integration and confirm it's the right entity before going live.`;
  const body = JSON.stringify({ chat_id: chatId, text });
  const https = require('https');
  return new Promise(resolve => {
    const req = https.request(
      { hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`,
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { res.resume(); resolve(); }
    );
    req.on('error', () => resolve());
    req.write(body); req.end();
  });
}

module.exports = { discoverDoorbellEntity, discoverDoorReleaseEntity, getEntityState, callService, getHaConfig, saveHaConfig, runDiscovery };
