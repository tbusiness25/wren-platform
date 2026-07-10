'use strict';
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

function computeSlipHash(previousHash, rowData) {
  const payload = (previousHash || '') + JSON.stringify(rowData);
  return crypto.createHash('sha256').update(payload).digest('hex');
}

const managerOnly = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager only' });
  next();
};

// ── List slips ─────────────────────────────────────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT ps.*,
        s.first_name || ' ' || s.last_name AS created_by_name,
        (SELECT COUNT(*) FROM permission_slip_responses psr WHERE psr.slip_id=ps.id) AS total_children,
        (SELECT COUNT(*) FROM permission_slip_responses psr WHERE psr.slip_id=ps.id AND psr.response='approved') AS approved_count,
        (SELECT COUNT(*) FROM permission_slip_responses psr WHERE psr.slip_id=ps.id AND psr.response='declined') AS declined_count
      FROM permission_slips ps
      LEFT JOIN staff s ON s.id = ps.created_by
      ORDER BY ps.created_at DESC
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get single slip with responses ────────────────────────────────────────────
router.get('/:id', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows: sl } = await db.query('SELECT * FROM permission_slips WHERE id=$1', [req.params.id]);
    if (!sl.length) return res.status(404).json({ error: 'Not found' });

    const { rows: responses } = await db.query(`
      SELECT psr.*, c.first_name, c.last_name, c.room_id
      FROM permission_slip_responses psr
      JOIN children c ON c.id = psr.child_id
      WHERE psr.slip_id=$1
      ORDER BY c.first_name, c.last_name
    `, [req.params.id]);

    res.json({ ...sl[0], responses });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Create slip ────────────────────────────────────────────────────────────────
router.post('/', authenticate, managerOnly, async (req, res) => {
  const {
    outing_id, title, description, trip_date, departure_time, return_time,
    destination, transport, cost, recipients, deadline,
    requires_medical_confirmation, requires_photo_consent
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const { rows } = await getPool().query(`
      INSERT INTO permission_slips (
        outing_id, title, description, trip_date, departure_time, return_time,
        destination, transport, cost, recipients, created_by, deadline,
        requires_medical_confirmation, requires_photo_consent
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *
    `, [
      outing_id || null, title, description || null, trip_date || null,
      departure_time || null, return_time || null, destination || null,
      transport || null, cost || null,
      JSON.stringify(recipients || { type: 'all_active' }),
      req.user.id, deadline || null,
      requires_medical_confirmation !== false, requires_photo_consent || false
    ]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Update slip ────────────────────────────────────────────────────────────────
router.put('/:id', authenticate, managerOnly, async (req, res) => {
  const fields = [
    'title', 'description', 'trip_date', 'departure_time', 'return_time',
    'destination', 'transport', 'cost', 'deadline', 'status',
    'requires_medical_confirmation', 'requires_photo_consent'
  ];
  const updates = [], vals = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { vals.push(req.body[f]); updates.push(`${f}=$${vals.length}`); }
  });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(req.params.id);
  try {
    const { rows } = await getPool().query(
      `UPDATE permission_slips SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Send slip to parents ───────────────────────────────────────────────────────
router.post('/:id/send', authenticate, managerOnly, async (req, res) => {
  const slipId = parseInt(req.params.id);
  try {
    const db = getPool();
    const { rows: sl } = await db.query('SELECT * FROM permission_slips WHERE id=$1', [slipId]);
    if (!sl.length) return res.status(404).json({ error: 'Not found' });
    const slip = sl[0];
    if (slip.status === 'closed') return res.status(400).json({ error: 'Slip is closed' });

    // Resolve recipient children
    const recipients = slip.recipients || { type: 'all_active' };
    let childQuery = `SELECT c.id, c.first_name, c.last_name, c.room_id,
      c.parent_1_name, c.parent_1_email, c.parent_2_name, c.parent_2_email
      FROM children c WHERE c.is_active=true`;
    const childParams = [];

    if (recipients.type === 'room' && recipients.room_id) {
      childParams.push(recipients.room_id);
      childQuery += ` AND c.room_id=$${childParams.length}`;
    } else if (recipients.type === 'specific' && recipients.child_ids?.length) {
      childParams.push(recipients.child_ids);
      childQuery += ` AND c.id=ANY($${childParams.length})`;
    }

    const { rows: children } = await db.query(childQuery, childParams);
    if (!children.length) return res.status(400).json({ error: 'No children found for recipients' });

    let created = 0, skipped = 0;
    for (const child of children) {
      const email = child.parent_1_email || child.parent_2_email;
      const parentName = child.parent_1_name || child.parent_2_name || 'Parent';
      try {
        await db.query(`
          INSERT INTO permission_slip_responses (slip_id, child_id, parent_name, parent_email, response)
          VALUES ($1,$2,$3,$4,'pending')
          ON CONFLICT (slip_id, child_id) DO NOTHING
        `, [slipId, child.id, parentName, email]);
        created++;
      } catch (_) { skipped++; }
    }

    await db.query(
      `UPDATE permission_slips SET status='sent', sent_at=NOW() WHERE id=$1`,
      [slipId]
    );

    // Mark all responses as notified (in real SMTP setup this would send emails)
    await db.query(
      `UPDATE permission_slip_responses SET notified_at=NOW() WHERE slip_id=$1 AND notified_at IS NULL`,
      [slipId]
    );

    res.json({ ok: true, total_children: children.length, responses_created: created, skipped });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Parent sign endpoint (public, uses token) ─────────────────────────────────
router.post('/sign/:token', async (req, res) => {
  const { response, signature_data, medical_notes, photo_consent, parent_name } = req.body;
  if (!response || !['approved', 'declined'].includes(response)) {
    return res.status(400).json({ error: 'response must be approved or declined' });
  }
  if (!signature_data) {
    return res.status(400).json({ error: 'signature_data required' });
  }
  try {
    const db = getPool();

    // Load the pending response
    const { rows: existing } = await db.query(
      `SELECT psr.*, ps.status as slip_status
       FROM permission_slip_responses psr
       JOIN permission_slips ps ON ps.id = psr.slip_id
       WHERE psr.token=$1`,
      [req.params.token]
    );
    if (!existing.length) return res.status(404).json({ error: 'Invalid or expired link' });
    const rec = existing[0];
    if (rec.signed_at) return res.status(409).json({ error: 'Already signed' });
    if (rec.revoked_at) return res.status(410).json({ error: 'Consent was revoked' });
    if (rec.slip_status === 'closed') return res.status(410).json({ error: 'This permission slip is closed' });

    // Capture identity metadata
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim() || null;
    const ua = req.headers['user-agent'] || null;
    const signedAt = new Date();

    // Hash chain — find the last signed row for this slip
    const { rows: lastRows } = await db.query(
      `SELECT hash_self FROM permission_slip_responses
       WHERE slip_id=$1 AND hash_self IS NOT NULL
       ORDER BY signed_at DESC LIMIT 1`,
      [rec.slip_id]
    );
    const previousHash = lastRows.length ? lastRows[0].hash_self : null;

    // Compute this row's hash
    const rowData = {
      id: rec.id, slip_id: rec.slip_id, child_id: rec.child_id,
      response, signed_at: signedAt.toISOString(), ip
    };
    const hashSelf = computeSlipHash(previousHash, rowData);

    const { rows } = await db.query(
      `UPDATE permission_slip_responses
       SET response=$1, signature_data=$2, signed_at=$3,
           medical_notes=$4, photo_consent=$5,
           parent_name=COALESCE($6, parent_name),
           ip_address=$7, user_agent=$8,
           hash_previous=$9, hash_self=$10
       WHERE token=$11
       RETURNING id, slip_id, child_id, response, signed_at`,
      [
        response, signature_data, signedAt,
        medical_notes || null, photo_consent || false,
        parent_name || null,
        ip, ua,
        previousHash, hashSelf,
        req.params.token
      ]
    );
    if (!rows.length) return res.status(404).json({ error: 'Invalid or expired link' });
    res.json({ ok: true, response: rows[0].response, signed_at: rows[0].signed_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /sign/:token — parent response page data ──────────────────────────────
router.get('/sign/:token', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT psr.id, psr.slip_id, psr.response, psr.signed_at, psr.parent_name,
        psr.revoked_at,
        c.first_name as child_first_name, c.last_name as child_last_name,
        ps.title, ps.description, ps.trip_date, ps.departure_time, ps.return_time,
        ps.destination, ps.transport, ps.cost, ps.deadline,
        ps.requires_medical_confirmation, ps.requires_photo_consent,
        ps.status as slip_status
      FROM permission_slip_responses psr
      JOIN children c ON c.id = psr.child_id
      JOIN permission_slips ps ON ps.id = psr.slip_id
      WHERE psr.token=$1
    `, [req.params.token]);
    if (!rows.length) return res.status(404).json({ error: 'Invalid link' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Remind unsigned parents ────────────────────────────────────────────────────
router.post('/:id/remind', authenticate, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE permission_slip_responses SET reminded_at=NOW()
       WHERE slip_id=$1 AND response='pending' RETURNING id`,
      [req.params.id]
    );
    res.json({ ok: true, reminded: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Get signing status summary ────────────────────────────────────────────────
router.get('/:id/status', authenticate, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE response='approved') AS approved,
        COUNT(*) FILTER (WHERE response='declined') AS declined,
        COUNT(*) FILTER (WHERE response='pending') AS pending,
        COUNT(*) FILTER (WHERE response='pending' AND reminded_at IS NOT NULL) AS reminded
      FROM permission_slip_responses WHERE slip_id=$1
    `, [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Close slip ─────────────────────────────────────────────────────────────────
router.post('/:id/close', authenticate, managerOnly, async (req, res) => {
  try {
    await getPool().query(`UPDATE permission_slips SET status='closed' WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Delete slip (draft only) ──────────────────────────────────────────────────
router.delete('/:id', authenticate, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT status FROM permission_slips WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].status === 'sent') return res.status(403).json({ error: 'Cannot delete a sent slip — close it instead' });
    await db.query('DELETE FROM permission_slips WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Parent revoke consent ──────────────────────────────────────────────────────
router.post('/sign/:token/revoke', async (req, res) => {
  const { reason } = req.body;
  try {
    const db = getPool();
    const { rows: existing } = await db.query(
      `SELECT psr.*, ps.trip_date, ps.status as slip_status
       FROM permission_slip_responses psr
       JOIN permission_slips ps ON ps.id = psr.slip_id
       WHERE psr.token=$1`,
      [req.params.token]
    );
    if (!existing.length) return res.status(404).json({ error: 'Invalid link' });
    const rec = existing[0];
    if (rec.revoked_at) return res.status(409).json({ error: 'Already revoked' });
    if (!rec.signed_at) return res.status(400).json({ error: 'Not yet signed — nothing to revoke' });
    if (rec.slip_status === 'closed') return res.status(410).json({ error: 'Slip is closed — contact the nursery to change consent' });

    // Check trip is in the future
    if (rec.trip_date && new Date(rec.trip_date) < new Date()) {
      return res.status(410).json({ error: 'Trip date has passed — contact the nursery to discuss' });
    }

    await db.query(
      `UPDATE permission_slip_responses
       SET revoked_at=NOW(), revoke_reason=$1, response='revoked'
       WHERE token=$2`,
      [reason || null, req.params.token]
    );
    res.json({ ok: true, message: 'Consent revoked. The nursery has been notified.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Hash chain tamper verification ────────────────────────────────────────────
router.get('/:id/verify-chain', authenticate, managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, child_id, response, signed_at, ip_address,
              hash_self, hash_previous
       FROM permission_slip_responses
       WHERE slip_id=$1 AND signed_at IS NOT NULL AND revoked_at IS NULL
       ORDER BY signed_at ASC`,
      [req.params.id]
    );

    const results = [];
    let lastHash = null;
    let chainIntact = true;

    for (const row of rows) {
      const rowData = {
        id: row.id, slip_id: parseInt(req.params.id), child_id: row.child_id,
        response: row.response, signed_at: new Date(row.signed_at).toISOString(),
        ip: row.ip_address
      };
      const expectedHash = computeSlipHash(lastHash, rowData);
      const hashMatch = row.hash_self === expectedHash;
      const prevMatch = row.hash_previous === lastHash;
      if (!hashMatch || !prevMatch) chainIntact = false;
      results.push({
        id: row.id, child_id: row.child_id, signed_at: row.signed_at,
        hash_self: row.hash_self, computed_hash: expectedHash,
        hash_match: hashMatch, prev_match: prevMatch
      });
      lastHash = row.hash_self;
    }

    res.json({ chain_intact: chainIntact, rows: results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ICS calendar download ─────────────────────────────────────────────────────
router.get('/:id/calendar.ics', authenticate, async (req, res) => {
  try {
    const { rows: sl } = await getPool().query(
      'SELECT * FROM permission_slips WHERE id=$1',
      [req.params.id]
    );
    if (!sl.length) return res.status(404).json({ error: 'Not found' });
    const slip = sl[0];

    const uid = `wren-trip-${slip.id}@example-nursery.co.uk`;
    const now = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

    // Build date strings — full day event if no departure time
    let dtStart, dtEnd;
    if (slip.trip_date) {
      const d = slip.trip_date.toISOString ? slip.trip_date.toISOString().split('T')[0] : String(slip.trip_date).split('T')[0];
      if (slip.departure_time) {
        const depClean = slip.departure_time.replace(':', '') + '00';
        const retClean = slip.return_time ? slip.return_time.replace(':', '') + '00' : null;
        const dateStr = d.replace(/-/g, '');
        dtStart = `DTSTART:${dateStr}T${depClean}`;
        dtEnd = retClean ? `DTEND:${dateStr}T${retClean}` : `DTEND:${dateStr}T${depClean}`;
      } else {
        const dateStr = d.replace(/-/g, '');
        dtStart = `DTSTART;VALUE=DATE:${dateStr}`;
        const nextDay = new Date(d);
        nextDay.setDate(nextDay.getDate() + 1);
        dtEnd = `DTEND;VALUE=DATE:${nextDay.toISOString().split('T')[0].replace(/-/g, '')}`;
      }
    } else {
      return res.status(400).json({ error: 'Trip has no date set' });
    }

    const summary = slip.title || 'School Trip';
    const location = slip.destination || '';
    const description = [
      slip.description || '',
      slip.transport ? `Transport: ${slip.transport}` : '',
      slip.cost ? `Cost: £${parseFloat(slip.cost).toFixed(2)}` : '',
    ].filter(Boolean).join('\\n');

    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Wren//Your Nursery//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      `UID:${uid}`,
      `DTSTAMP:${now}`,
      dtStart,
      dtEnd,
      `SUMMARY:${summary.replace(/,/g, '\\,')}`,
      location ? `LOCATION:${location.replace(/,/g, '\\,')}` : '',
      description ? `DESCRIPTION:${description}` : '',
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR'
    ].filter(Boolean).join('\r\n');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="trip-${slip.id}.ics"`);
    res.send(ics);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
