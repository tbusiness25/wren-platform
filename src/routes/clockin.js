const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// ── Telegram helper ──────────────────────────────────────────────────────────
function sendTelegram(text) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat) return;
  fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text })
  }).catch(() => {});
}

function fmtTime(d) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}

function fmtDuration(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Core fob event handler (shared by webhook + direct event route) ───────────
async function handleFobEvent({ fob_uid, door_name, event_time, source_raw }) {
  const db = getPool();
  const uid = (fob_uid || '').toString().toUpperCase().trim();
  const ts = event_time ? new Date(event_time) : new Date();
  const doorLabel = door_name || 'Main Entrance';

  // Look up fob
  const { rows: fobRows } = await db.query(
    `SELECT sf.id, sf.staff_id, sf.label,
            s.first_name, s.last_name, s.role
     FROM staff_fobs sf
     JOIN staff s ON s.id = sf.staff_id
     WHERE sf.fob_uid = $1 AND sf.is_active = true`,
    [uid]
  );

  if (!fobRows.length) {
    sendTelegram(`⚠️ Unknown fob tapped: ${uid} at ${fmtTime(ts)} — register in LADN`);
    return { ok: true, unknown_fob: true };
  }

  const fob = fobRows[0];
  const staffId = fob.staff_id;
  const name = `${fob.first_name} ${fob.last_name}`;

  // Determine clock_in or clock_out
  const { rows: shiftRows } = await db.query(
    `SELECT id, clock_in_time, clock_out_time, status
     FROM staff_shifts
     WHERE staff_id = $1 AND shift_date = CURRENT_DATE
     ORDER BY id DESC LIMIT 1`,
    [staffId]
  );

  const existingShift = shiftRows[0];
  let eventType;
  if (!existingShift || existingShift.status === 'complete') {
    eventType = 'clock_in';
  } else if (existingShift.clock_in_time && !existingShift.clock_out_time) {
    eventType = 'clock_out';
  } else {
    eventType = 'clock_in';
  }

  // Record clock event
  await db.query(
    `INSERT INTO staff_clock_events (staff_id, event_type, method, fob_uid, door_name, event_time, source_raw)
     VALUES ($1, $2, 'fob', $3, $4, $5, $6)`,
    [staffId, eventType, uid, doorLabel, ts, JSON.stringify(source_raw || {})]
  );

  let totalMinutes = null;

  if (eventType === 'clock_in') {
    await db.query(
      `INSERT INTO staff_shifts (staff_id, shift_date, clock_in_time, method, status)
       VALUES ($1, CURRENT_DATE, $2, 'fob', 'open')
       ON CONFLICT (staff_id, shift_date) DO UPDATE
         SET clock_in_time = EXCLUDED.clock_in_time, method = 'fob', status = 'open',
             clock_out_time = NULL, total_minutes = NULL`,
      [staffId, ts]
    );
    sendTelegram(`👤 ${name} clocked IN — ${fmtTime(ts)} (fob)`);
  } else {
    // Calculate total minutes from existing clock_in
    const clockIn = existingShift.clock_in_time;
    if (clockIn) {
      totalMinutes = Math.round((ts.getTime() - new Date(clockIn).getTime()) / 60000);
    }
    await db.query(
      `UPDATE staff_shifts SET clock_out_time = $2, total_minutes = $3, status = 'complete'
       WHERE staff_id = $1 AND shift_date = CURRENT_DATE AND status = 'open'`,
      [staffId, ts, totalMinutes]
    );
    const dur = fmtDuration(totalMinutes);
    sendTelegram(`👋 ${name} clocked OUT — ${fmtTime(ts)}${dur ? ` · shift ${dur}` : ''}`);
  }

  return { ok: true, staff_id: staffId, name, event_type: eventType, total_minutes: totalMinutes };
}

// ── Public: Dahua VTO webhook (no auth — Dahua can't send JWT) ────────────────
// Must be before authenticate middleware
router.use(express.text({ type: 'text/xml' }));
router.use(express.text({ type: 'application/xml' }));

// If DAHUA_WEBHOOK_SECRET is set, validate x-webhook-secret header
const DAHUA_SECRET = process.env.DAHUA_WEBHOOK_SECRET;

router.post('/dahua-webhook', async (req, res) => {
  if (DAHUA_SECRET && req.headers['x-webhook-secret'] !== DAHUA_SECRET) {
    return res.status(403).end();
  }
  try {
    let body = req.body;
    // If body is a string (XML), try to parse card UID from it
    if (typeof body === 'string') {
      const match = body.match(/<CardNo>([^<]+)<\/CardNo>|cardno["\s:=]+([A-Fa-f0-9]+)/i);
      if (!match) return res.status(200).send('OK');
      body = { CardNo: match[1] || match[2] };
    }
    if (!body || typeof body !== 'object') return res.status(200).send('OK');

    const fob_uid = body.CardNo || body.card_no || body.cardNumber ||
                    body.RFID || (body.AccessControlCard && body.AccessControlCard.CardNo);
    if (!fob_uid) return res.status(200).send('OK');

    await handleFobEvent({
      fob_uid: fob_uid.toString().toUpperCase().trim(),
      door_name: body.DoorName || body.door_name || 'Main Entrance',
      event_time: body.Time || body.time || new Date().toISOString(),
      source_raw: body
    });
    res.status(200).send('OK');
  } catch (e) {
    console.error('Dahua webhook error:', e.message);
    res.status(200).send('OK'); // Always 200 to Dahua
  }
});

// ── Public: GET /today — all active staff clock status ────────────────────────
router.get('/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT
        s.id as staff_id,
        s.first_name || ' ' || s.last_name as name,
        s.role,
        r.name as room,
        ss.clock_in_time,
        ss.clock_out_time,
        ss.total_minutes,
        ss.status as shift_status,
        CASE
          WHEN ss.clock_in_time IS NOT NULL AND ss.clock_out_time IS NULL THEN 'in'
          WHEN ss.clock_out_time IS NOT NULL THEN 'out'
          ELSE 'not_arrived'
        END as status,
        CASE
          WHEN ss.clock_in_time IS NOT NULL AND ss.clock_out_time IS NULL
          THEN ROUND(EXTRACT(EPOCH FROM (NOW() - ss.clock_in_time))/3600, 2)
          WHEN ss.total_minutes IS NOT NULL
          THEN ROUND(ss.total_minutes::numeric/60, 2)
          ELSE NULL
        END as hours_today,
        EXISTS(
          SELECT 1 FROM staff_fobs sf
          WHERE sf.staff_id = s.id AND sf.is_active = true
        ) as fob_registered
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      LEFT JOIN staff_shifts ss ON ss.staff_id = s.id AND ss.shift_date = CURRENT_DATE
      WHERE s.is_active = true
      ORDER BY
        CASE WHEN ss.clock_in_time IS NOT NULL AND ss.clock_out_time IS NULL THEN 0
             WHEN ss.clock_out_time IS NOT NULL THEN 1
             ELSE 2
        END,
        s.first_name
    `);
    res.json(rows);
  } catch (e) {
    if (e.code === '42P01') {
      return res.json({ shifts: [], message: 'Clock-in data not available in demo' });
    }
    res.status(500).json({ error: e.message });
  }
});

// ── Auth middleware — all routes below require valid JWT ──────────────────────
router.use(authenticate);

// ── POST /event — internal event (called by polling script or n8n) ────────────
router.post('/event', async (req, res) => {
  const secret = req.headers['x-internal-secret'];
  const { fob_uid, door_name, event_time, raw_payload } = req.body;
  if (!fob_uid) return res.status(400).json({ error: 'fob_uid required' });
  try {
    const result = await handleFobEvent({ fob_uid, door_name, event_time, source_raw: raw_payload });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /manual — manager manual clock in/out ────────────────────────────────
router.post('/manual', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager only' });
  }
  const { staff_id, event_type, notes } = req.body;
  if (!staff_id || !['clock_in','clock_out'].includes(event_type)) {
    return res.status(400).json({ error: 'staff_id and event_type (clock_in|clock_out) required' });
  }
  try {
    const db = getPool();
    const { rows: staffRows } = await db.query(
      'SELECT id, first_name, last_name FROM staff WHERE id=$1 AND is_active=true', [staff_id]
    );
    if (!staffRows.length) return res.status(404).json({ error: 'Staff not found' });
    const s = staffRows[0];
    const ts = new Date();
    let totalMinutes = null;

    await db.query(
      `INSERT INTO staff_clock_events (staff_id, event_type, method, event_time, source_raw)
       VALUES ($1, $2, 'manual', $3, $4)`,
      [staff_id, event_type, ts, JSON.stringify({ notes, manager_id: req.user.id })]
    );

    if (event_type === 'clock_in') {
      await db.query(
        `INSERT INTO staff_shifts (staff_id, shift_date, clock_in_time, method, status, notes)
         VALUES ($1, CURRENT_DATE, $2, 'manual', 'open', $3)
         ON CONFLICT (staff_id, shift_date) DO UPDATE
           SET clock_in_time = EXCLUDED.clock_in_time, method = 'manual', status = 'open',
               clock_out_time = NULL, total_minutes = NULL, notes = EXCLUDED.notes`,
        [staff_id, ts, notes || null]
      );
    } else {
      const { rows: existing } = await db.query(
        'SELECT clock_in_time FROM staff_shifts WHERE staff_id=$1 AND shift_date=CURRENT_DATE', [staff_id]
      );
      if (existing[0]?.clock_in_time) {
        totalMinutes = Math.round((ts.getTime() - new Date(existing[0].clock_in_time).getTime()) / 60000);
      }
      await db.query(
        `UPDATE staff_shifts SET clock_out_time=$2, total_minutes=$3, status='complete', notes=COALESCE($4, notes)
         WHERE staff_id=$1 AND shift_date=CURRENT_DATE`,
        [staff_id, ts, totalMinutes, notes || null]
      );
    }

    const name = `${s.first_name} ${s.last_name}`;
    const msg = event_type === 'clock_in'
      ? `👤 ${name} clocked IN (manual) — ${fmtTime(ts)}`
      : `👋 ${name} clocked OUT (manual) — ${fmtTime(ts)}${totalMinutes ? ` · shift ${fmtDuration(totalMinutes)}` : ''}`;
    sendTelegram(msg);

    res.json({ ok: true, event_type, name, total_minutes: totalMinutes });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /staff/:staffId/history ───────────────────────────────────────────────
router.get('/staff/:staffId/history', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 14, 90);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ss.*,
             s.first_name || ' ' || s.last_name as staff_name
      FROM staff_shifts ss
      JOIN staff s ON s.id = ss.staff_id
      WHERE ss.staff_id = $1
        AND ss.shift_date >= CURRENT_DATE - ($2 || ' days')::INTERVAL
      ORDER BY ss.shift_date DESC
    `, [req.params.staffId, days]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /fobs — register new fob ─────────────────────────────────────────────
router.post('/fobs', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager only' });
  }
  const { staff_id, fob_uid, label } = req.body;
  if (!staff_id || !fob_uid) return res.status(400).json({ error: 'staff_id and fob_uid required' });
  const uid = fob_uid.toString().toUpperCase().trim();
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO staff_fobs (staff_id, fob_uid, label, is_active)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (fob_uid) DO UPDATE SET staff_id=$1, label=$3, is_active=true, deactivated_at=NULL
       RETURNING *`,
      [staff_id, uid, label || null]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /fobs/:id — deactivate fob ────────────────────────────────────────
router.delete('/fobs/:id', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager only' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE staff_fobs SET is_active=false, deactivated_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Fob not found' });
    res.json({ ok: true, fob: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /fobs — list all fobs with staff name ─────────────────────────────────
router.get('/fobs', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sf.id, sf.fob_uid, sf.label, sf.is_active, sf.registered_at, sf.deactivated_at,
             sf.staff_id,
             s.first_name || ' ' || s.last_name as staff_name,
             s.role
      FROM staff_fobs sf
      JOIN staff s ON s.id = sf.staff_id
      ORDER BY sf.is_active DESC, s.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
