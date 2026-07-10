'use strict';
// Doorbell event listener — subscribes to MQTT topics that fire on VTO doorbell press.
// Also handles snapshot capture and notification dispatch.
// Started once at server boot via start().

const path = require('path');
const fs   = require('fs');
const { getPool } = require('../db/pool');
const { notify } = require('./notification-dispatcher');

const MQTT_HOST   = process.env.MQTT_HOST  || 'your-server';
const MQTT_PORT   = parseInt(process.env.MQTT_PORT || '1883');
const SNAP_DIR    = process.env.DOORBELL_SNAP_DIR || '/app/data/doorbell-snapshots';
const SITE_BASE   = process.env.SITE_BASE || 'https://admin.example-nursery.co.uk';
const DEDUP_MS    = 5_000; // suppress duplicate events within 5s

let _lastEventAt = 0;
let _started = false;
let _snapBuffer = null; // most-recent snapshot buffer from MQTT
let _snapBufferAt = 0;  // timestamp of snapshot receipt

// Topics to subscribe to (in priority order):
//   1. Frigate person detection on dahua_vto (broad fallback)
//   1b. Frigate snapshot for dahua_vto — save to disk directly from MQTT binary payload
//   2. HA exposes binary_sensor for doorbell
//   3. Direct Dahua MQTT bridge (if configured)
const TOPICS = [
  'frigate/dahua_vto/person',
  'frigate/dahua_vto/person/snapshot',
  'homeassistant/binary_sensor/dahua_vto_doorbell/state',
  'homeassistant/binary_sensor/+/state',
  'dahua/vto/+/doorbell_pressed',
];

function _isDoorbellEvent(topic, message) {
  const msg = message.toString().toLowerCase().trim();
  // Frigate person events — treat as doorbell (best we have without dedicated MQTT bridge)
  if (topic.startsWith('frigate/dahua_vto/')) return true;
  // HA binary_sensor: ON = pressed
  if (topic.startsWith('homeassistant/binary_sensor/')) {
    if (topic.includes('doorbell') || topic.includes('vto')) return msg === 'on';
    return false; // ignore unrelated HA sensors
  }
  // Direct Dahua
  if (topic.startsWith('dahua/vto/')) return true;
  return false;
}

// Save a snapshot from binary payload (received via MQTT frigate/dahua_vto/person/snapshot)
function _saveSnapshot(eventId, jpegBuffer) {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const snapPath = path.join(SNAP_DIR, `${eventId}.jpg`);
    fs.writeFileSync(snapPath, jpegBuffer);
    return snapPath;
  } catch (e) {
    console.warn('[doorbell] snapshot save failed:', e.message);
    return null;
  }
}

async function _handlePress(source) {
  const now = Date.now();
  if (now - _lastEventAt < DEDUP_MS) return; // deduplicate
  _lastEventAt = now;

  const db = getPool();
  let eventId;
  try {
    const { rows } = await db.query(
      `INSERT INTO doorbell_events (source) VALUES ($1) RETURNING id`,
      [source]
    );
    eventId = rows[0].id;
    console.log(`[doorbell] event ${eventId} created (source: ${source})`);
  } catch (e) {
    console.error('[doorbell] failed to insert event:', e.message);
    return;
  }

  // Attach snapshot — may already be buffered (snapshot topic fires before/after person event)
  const _attachSnap = async () => {
    if (_snapBuffer && Date.now() - _snapBufferAt < 10_000) {
      const buf = _snapBuffer; _snapBuffer = null;
      const sp = _saveSnapshot(eventId, buf);
      if (sp) await db.query(`UPDATE doorbell_events SET snapshot_path=$1 WHERE id=$2`, [sp, eventId]).catch(() => {});
    }
  };
  if (_snapBuffer && Date.now() - _snapBufferAt < 10_000) {
    await _attachSnap();
  } else {
    // Snapshot may arrive a second or two after the person event — wait up to 5s
    setTimeout(_attachSnap, 5_000);
  }

  // Fire notification to all clocked-in staff
  const link = `${SITE_BASE}/admin/intercom/answer/${eventId}`;
  notify(
    'doorbell_pressed',
    'all-staff',
    null,
    'Doorbell at front entrance',
    'Open Wren to answer — someone is at the door.',
    { priority: 'urgent', relatedTable: 'doorbell_events', relatedId: eventId, link }
  );
}

function start() {
  if (_started) return;
  _started = true;

  let mqtt;
  try {
    mqtt = require('mqtt');
  } catch {
    console.error('[doorbell] mqtt package not installed — MQTT listener disabled');
    return;
  }

  const brokerUrl = `mqtt://${MQTT_HOST}:${MQTT_PORT}`;
  const mqttUser = process.env.MQTT_USER;
  const mqttPass = process.env.MQTT_PASS;
  console.log(`[doorbell] connecting to MQTT broker ${brokerUrl}${mqttUser ? ' (auth)' : ''}`);

  const client = mqtt.connect(brokerUrl, {
    clientId: `wren-doorbell-${Date.now()}`,
    username: mqttUser || undefined,
    password: mqttPass || undefined,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
  });

  client.on('connect', () => {
    console.log('[doorbell] MQTT connected');
    TOPICS.forEach(t => client.subscribe(t, err => {
      if (err) console.warn(`[doorbell] subscribe ${t} failed:`, err.message);
    }));
  });

  client.on('message', (topic, message) => {
    // Snapshot topic: buffer the JPEG; _handlePress will pick it up
    if (topic === 'frigate/dahua_vto/person/snapshot') {
      _snapBuffer   = Buffer.from(message);
      _snapBufferAt = Date.now();
      return;
    }

    if (_isDoorbellEvent(topic, message)) {
      console.log(`[doorbell] press detected via MQTT topic: ${topic}`);
      _handlePress('mqtt');
    }
  });

  client.on('error',  e => console.error('[doorbell] MQTT error:', e.message));
  client.on('offline', () => console.warn('[doorbell] MQTT offline — will retry'));

  // Purge snapshots older than 30 days (runs once at startup, then daily)
  _purgeOldSnapshots();
  setInterval(_purgeOldSnapshots, 24 * 60 * 60 * 1000);
}

function _purgeOldSnapshots() {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const files = fs.readdirSync(SNAP_DIR);
    let purged = 0;
    for (const f of files) {
      const fp = path.join(SNAP_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.mtimeMs < cutoff) { fs.unlinkSync(fp); purged++; }
      } catch {}
    }
    if (purged > 0) console.log(`[doorbell] purged ${purged} snapshots older than 30 days`);
  } catch (e) {
    console.warn('[doorbell] snapshot purge error:', e.message);
  }
}

// Also export the handler so the HA webhook route can call it directly
module.exports = { start, handlePress: _handlePress };
