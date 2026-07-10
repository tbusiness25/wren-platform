'use strict';
// Intercom routes — doorbell events, WebRTC signalling proxy, door release.
// All routes require valid JWT (staff role). Parents are excluded at the dispatcher level.

const express  = require('express');
const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const { WebSocketServer, WebSocket } = require('ws');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { callService, getHaConfig } = require('../services/ha-ladn');
const { handlePress } = require('../services/doorbell-listener');

const router = express.Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const SNAP_DIR    = process.env.DOORBELL_SNAP_DIR || '/app/data/doorbell-snapshots';
// go2rtc URL — set GO2RTC_URL in .env to your go2rtc host
// Requires UFW rule: sudo ufw allow in on br-eddfbc2f26a4 proto tcp to any port 1984
// See wren-docs/integrations/intercom-ha.md for setup instructions
const GO2RTC_URL  = process.env.GO2RTC_URL || 'http://172.31.0.1:1984';
const GO2RTC_WS   = GO2RTC_URL.replace(/^http/, 'ws');
const ACTIVE_WINDOW_MINS = 5;

// ── Helpers ───────────────────────────────────────────────────────────────────

function isStaff(user) {
  return user && user.role && user.role !== 'parent';
}

function _requireStaff(req, res, next) {
  if (!isStaff(req.user)) return res.status(403).json({ error: 'Staff only' });
  next();
}

// ── REST routes ───────────────────────────────────────────────────────────────

// List active (unanswered, last 5 min) doorbell events
router.get('/events/active', authenticate, _requireStaff, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT de.*, s.first_name || ' ' || s.last_name AS answered_by_name
      FROM doorbell_events de
      LEFT JOIN staff s ON s.id = de.answered_by_staff_id
      WHERE de.triggered_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MINS} minutes'
        AND de.resolution IS NULL
      ORDER BY de.triggered_at DESC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Single event detail with signed snapshot URL
router.get('/events/:id', authenticate, _requireStaff, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT de.*,
        s1.first_name || ' ' || s1.last_name AS answered_by_name,
        s2.first_name || ' ' || s2.last_name AS released_by_name
      FROM doorbell_events de
      LEFT JOIN staff s1 ON s1.id = de.answered_by_staff_id
      LEFT JOIN staff s2 ON s2.id = de.door_released_by_staff_id
      WHERE de.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const event = rows[0];
    // Add snapshot URL if file exists
    const snapFile = path.join(SNAP_DIR, `${event.id}.jpg`);
    if (event.snapshot_path && fs.existsSync(snapFile)) {
      event.snapshot_url = `/api/intercom/snapshots/${event.id}.jpg`;
    }
    res.json(event);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Serve snapshot images (staff-only, authenticated)
router.get('/snapshots/:filename', authenticate, _requireStaff, (req, res) => {
  const filename = path.basename(req.params.filename);
  if (!/^\d+\.jpg$/.test(filename)) return res.status(400).send('Bad filename');
  const fp = path.join(SNAP_DIR, filename);
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.sendFile(fp);
});

// Staff acknowledges they are answering — atomic claim
router.post('/events/:id/answer', authenticate, _requireStaff, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      UPDATE doorbell_events
      SET answered_by_staff_id=$1, answered_at=NOW()
      WHERE id=$2 AND answered_by_staff_id IS NULL
      RETURNING *
    `, [req.user.id, req.params.id]);
    if (!rows.length) {
      // Someone else already claimed it
      const { rows: existing } = await db.query(`
        SELECT de.*, s.first_name || ' ' || s.last_name AS answered_by_name
        FROM doorbell_events de
        LEFT JOIN staff s ON s.id = de.answered_by_staff_id
        WHERE de.id = $1
      `, [req.params.id]);
      return res.status(409).json({ error: 'already_claimed', event: existing[0] || null });
    }
    res.json({ ok: true, event: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Release door — calls HA service. REQUIRES active event in last 5 min.
router.post('/events/:id/release-door', authenticate, _requireStaff, async (req, res) => {
  const db = getPool();
  try {
    // Safety: event must exist, be recent, and not already resolved
    const { rows } = await db.query(`
      SELECT * FROM doorbell_events
      WHERE id=$1
        AND triggered_at > NOW() - INTERVAL '${ACTIVE_WINDOW_MINS} minutes'
        AND resolution IS NULL
    `, [req.params.id]);
    if (!rows.length) {
      return res.status(403).json({
        error: 'door_release_denied',
        message: 'No active doorbell event — door can only be opened within 5 minutes of a ring.',
      });
    }

    const config = await getHaConfig();
    const entityId = config.door_release_entity;
    if (!entityId) {
      return res.status(503).json({ error: 'door_release_entity not configured — set it in Admin > HA Integration' });
    }

    // Determine domain from entity_id prefix
    const domain = entityId.split('.')[0];
    const service = domain === 'lock' ? 'unlock' : 'turn_on';
    await callService(domain, service, entityId);

    // Log to event row
    await db.query(`
      UPDATE doorbell_events
      SET door_released=true, door_released_at=NOW(), door_released_by_staff_id=$1
      WHERE id=$2
    `, [req.user.id, req.params.id]);

    console.log(`[intercom] Door released by staff ${req.user.id} for event ${req.params.id}`);
    res.json({ ok: true, entity: entityId, service: `${domain}.${service}` });
  } catch (e) {
    console.error('[intercom] release-door error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Resolve event with outcome
router.post('/events/:id/resolve', authenticate, _requireStaff, async (req, res) => {
  const { resolution, notes, call_duration_seconds } = req.body || {};
  const validResolutions = ['admitted','declined','no_answer','missed','wrong_address'];
  if (!resolution || !validResolutions.includes(resolution)) {
    return res.status(400).json({ error: `resolution must be one of: ${validResolutions.join(', ')}` });
  }
  const db = getPool();
  try {
    const { rows } = await db.query(`
      UPDATE doorbell_events
      SET resolution=$1, notes=$2, call_duration_seconds=$3
      WHERE id=$4
      RETURNING *
    `, [resolution, notes || null, call_duration_seconds || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Event not found' });
    res.json({ ok: true, event: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// History: past events with filters
router.get('/history', authenticate, _requireStaff, async (req, res) => {
  const db = getPool();
  const { from, to, resolution, staff_id, limit = 50, offset = 0 } = req.query;
  try {
    const conditions = [];
    const params = [];
    if (from)        { params.push(from);        conditions.push(`de.triggered_at >= $${params.length}`); }
    if (to)          { params.push(to);           conditions.push(`de.triggered_at <= $${params.length}`); }
    if (resolution)  { params.push(resolution);   conditions.push(`de.resolution = $${params.length}`); }
    if (staff_id)    { params.push(staff_id);     conditions.push(`de.answered_by_staff_id = $${params.length}`); }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    params.push(Math.min(parseInt(limit) || 50, 200));
    params.push(parseInt(offset) || 0);
    const { rows } = await db.query(`
      SELECT de.*,
        s1.first_name || ' ' || s1.last_name AS answered_by_name,
        s2.first_name || ' ' || s2.last_name AS released_by_name,
        CASE WHEN de.snapshot_path IS NOT NULL THEN '/api/intercom/snapshots/' || de.id || '.jpg' END AS snapshot_url
      FROM doorbell_events de
      LEFT JOIN staff s1 ON s1.id = de.answered_by_staff_id
      LEFT JOIN staff s2 ON s2.id = de.door_released_by_staff_id
      ${where}
      ORDER BY de.triggered_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Insights metrics
router.get('/metrics', authenticate, _requireStaff, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE triggered_at >= CURRENT_DATE)::int AS doorbells_today,
        COUNT(*) FILTER (WHERE triggered_at >= CURRENT_DATE AND resolution IS NULL)::int AS doorbells_unanswered_today,
        ROUND(
          AVG(EXTRACT(EPOCH FROM (answered_at - triggered_at)))
          FILTER (WHERE answered_at IS NOT NULL AND triggered_at >= NOW() - INTERVAL '7 days')
        )::int AS avg_answer_seconds_last_7d
      FROM doorbell_events
    `);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Manual test trigger (manager only)
router.post('/test-ring', authenticate, async (req, res) => {
  if (!['manager','room_leader','deputy'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager only' });
  }
  try {
    await handlePress('manual_test');
    res.json({ ok: true, message: 'Test doorbell event created' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HA webhook path — no auth, uses shared secret ────────────────────────────
const haWebhookRouter = express.Router();
haWebhookRouter.post('/doorbell-pressed', express.json({ limit: '64kb' }), async (req, res) => {
  const secret = process.env.HA_WEBHOOK_SECRET;
  if (secret && req.headers['x-ha-secret'] !== secret) {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  console.log('[doorbell] press via HA webhook');
  try {
    await handlePress('ha_webhook');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HA config admin endpoints ─────────────────────────────────────────────────
router.get('/ha-config', authenticate, async (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Manager only' });
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT key, entity_id, notes, updated_at FROM ha_config ORDER BY key');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/ha-config/:key', authenticate, async (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Manager only' });
  const { entity_id } = req.body || {};
  const db = getPool();
  try {
    await db.query(
      `INSERT INTO ha_config (key, entity_id, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET entity_id=$2, updated_at=NOW()`,
      [req.params.key, entity_id || null]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── WebSocket proxy: /intercom-ws/answer/:id → go2rtc ────────────────────────

function attachIntercomWS(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const urlStr = `http://localhost${request.url}`;
    let url;
    try { url = new URL(urlStr); } catch { socket.destroy(); return; }

    const match = url.pathname.match(/^\/intercom-ws\/answer\/(\d+)$/);
    if (!match) {
      // Not an intercom path — send 404 and close
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const eventId = match[1];
    const token = url.searchParams.get('token');

    // Validate JWT
    let user;
    try {
      user = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!isStaff(user)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (clientWs) => {
      _proxyToGo2rtc(clientWs, eventId, user.id);
    });
  });
}

function _proxyToGo2rtc(clientWs, eventId, staffId) {
  const streamName = process.env.INTERCOM_STREAM || 'dahua_vto';
  const upstreamUrl = `${GO2RTC_WS}/api/ws?src=${streamName}`;

  let upstream;
  try {
    upstream = new WebSocket(upstreamUrl);
  } catch (e) {
    console.error('[intercom-ws] failed to connect to go2rtc:', e.message);
    clientWs.close(1011, 'Stream unavailable');
    return;
  }

  upstream.on('open', () => {
    console.log(`[intercom-ws] staff ${staffId} proxied to go2rtc for event ${eventId}`);
  });

  upstream.on('message', (data, isBinary) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  clientWs.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  upstream.on('close', (code, reason) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(code, reason);
  });
  clientWs.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });

  upstream.on('error', (e) => {
    console.error('[intercom-ws] upstream error:', e.message);
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1011, 'Stream error');
  });
  clientWs.on('error', (e) => {
    console.error('[intercom-ws] client error:', e.message);
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });
}

module.exports = { router, haWebhookRouter, attachIntercomWS };
