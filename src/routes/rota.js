const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const nodemailer = require('nodemailer');
const { notify } = require('../services/notification-dispatcher');
const ratioEngine = require('../services/ratio-engine');
const { requireSalaryView } = require('../lib/capabilities');
const PDFDoc = require('pdfkit');   // payroll export (reuses the same lib as routes/export.js)

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

async function checkFeature(req, res, next) {
  try {
    const db = getPool();
    const { rows } = await db.query("SELECT is_enabled FROM feature_flags WHERE key='rota_builder'");
    if (rows.length && !rows[0].is_enabled) {
      return res.status(403).json({ error: 'rota_builder feature disabled' });
    }
    next();
  } catch {
    next();
  }
}

// Returns the ISO Monday of the week containing dateStr (YYYY-MM-DD)
function toWeekStart(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const day = d.getUTCDay(); // 0=Sun
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().split('T')[0];
}

// GET /api/rota/weeks — recent rota weeks with status
router.get('/weeks', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT rw.*,
             s.first_name || ' ' || s.last_name AS published_by_name,
             COUNT(rs.id)::int AS shift_count
      FROM rota_weeks rw
      LEFT JOIN staff s ON s.id = rw.published_by
      LEFT JOIN rota_shifts rs ON rs.rota_week_id = rw.id
      GROUP BY rw.id, s.first_name, s.last_name
      ORDER BY rw.week_start DESC
      LIMIT 20
    `);
    res.json(rows);
  } catch (err) {
    console.error('rota /weeks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rota/week/:date — week data (week meta + all staff + shifts)
router.get('/week/:date', async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query(
      'SELECT * FROM rota_weeks WHERE week_start = $1', [ws]
    );
    const week = weekRows[0] || null;

    const { rows: staff } = await db.query(
      `SELECT id, first_name, last_name, role, email,
              contracted_hours, room_id, hourly_rate,
              is_dsl, is_deputy_dsl, is_first_aider
       FROM staff
       WHERE (is_active = true OR is_active IS NULL)
       ORDER BY first_name, last_name`
    );

    const { rows: rooms } = await db.query(
      'SELECT id, name, capacity, ratio_children_per_staff FROM rooms ORDER BY id'
    );

    let shifts = [];
    if (week) {
      const { rows } = await db.query(`
        SELECT rs.*, r.name AS room_name
        FROM rota_shifts rs
        LEFT JOIN rooms r ON r.id = rs.room_id
        WHERE rs.rota_week_id = $1
        ORDER BY rs.shift_date, rs.staff_id
      `, [week.id]);
      shifts = rows;
    }

    res.json({ week, staff, shifts, rooms });
  } catch (err) {
    console.error('rota /week/:date error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rota/week/:date/draft — save draft shifts (manager only)
router.post('/week/:date/draft', checkFeature, managerOnly, async (req, res) => {
  const { shifts } = req.body;
  if (!Array.isArray(shifts)) return res.status(400).json({ error: 'shifts must be array' });

  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query(`
      INSERT INTO rota_weeks (week_start, status) VALUES ($1, 'draft')
      ON CONFLICT (week_start) DO UPDATE SET week_start = EXCLUDED.week_start
      RETURNING id, published_at
    `, [ws]);
    const weekId = weekRows[0].id;

    // Delete and re-insert assigned shifts for clean state.
    // Open shifts (is_open=true, staff_id NULL) are preserved — they are managed
    // via the dedicated open-shift / claim endpoints, not the draft grid.
    await db.query('DELETE FROM rota_shifts WHERE rota_week_id = $1 AND COALESCE(is_open,false) = false', [weekId]);

    for (const s of shifts) {
      if (!s.staff_id || !s.shift_date) continue;
      await db.query(`
        INSERT INTO rota_shifts
          (rota_week_id, staff_id, shift_date, planned_start, planned_end, room_id, break_mins, notes, label, colour)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (rota_week_id, staff_id, shift_date) DO UPDATE SET
          planned_start=EXCLUDED.planned_start, planned_end=EXCLUDED.planned_end,
          room_id=EXCLUDED.room_id, break_mins=EXCLUDED.break_mins, notes=EXCLUDED.notes,
          label=EXCLUDED.label, colour=EXCLUDED.colour
      `, [
        weekId, s.staff_id, s.shift_date,
        s.planned_start || null,
        s.planned_end || null,
        s.room_id || null,
        s.break_mins != null ? s.break_mins : 30,
        s.notes || null,
        s.label || null,
        s.colour || null
      ]);
    }

    res.json({ ok: true, week_id: weekId, saved: shifts.length, week_start: ws });
  } catch (err) {
    console.error('rota /draft error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rota/week/:date/publish — mark published + email all staff
router.post('/week/:date/publish', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query(
      'SELECT * FROM rota_weeks WHERE week_start = $1', [ws]
    );
    if (!weekRows.length) return res.status(404).json({ error: 'No draft rota for this week. Save a draft first.' });
    const week = weekRows[0];

    await db.query(
      'UPDATE rota_weeks SET published_at = NOW(), published_by = $1, status = \'published\' WHERE id = $2',
      [req.user.id, week.id]
    );
    try { await afterPublish(db, week.id, ws); } catch (e) { console.error('rota afterPublish error:', e.message); }

    const { rows: shifts } = await db.query(`
      SELECT rs.*, s.first_name, s.last_name, s.email,
             r.name AS room_name
      FROM rota_shifts rs
      JOIN staff s ON s.id = rs.staff_id
      LEFT JOIN rooms r ON r.id = rs.room_id
      WHERE rs.rota_week_id = $1
      ORDER BY rs.staff_id, rs.shift_date
    `, [week.id]);

    // Group shifts by staff
    const byStaff = {};
    for (const row of shifts) {
      if (!byStaff[row.staff_id]) {
        byStaff[row.staff_id] = {
          name: `${row.first_name} ${row.last_name}`,
          email: row.email,
          shifts: []
        };
      }
      byStaff[row.staff_id].shifts.push(row);
    }

    const smtpOk = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    let transport = null;
    if (smtpOk) {
      transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_PORT === '465',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
    }

    const weekLabel = new Date(ws + 'T00:00:00Z').toLocaleDateString('en-GB', {
      day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC'
    });

    const sent = [], failed = [];
    for (const [staffId, staffData] of Object.entries(byStaff)) {
      if (!staffData.email) continue;
      const html = buildRotaEmail(staffData.name, staffData.shifts, weekLabel);
      if (smtpOk) {
        try {
          await transport.sendMail({
            from: process.env.SMTP_FROM || 'Little Angels Day Nursery <admissions@littleangelsealing.co.uk>',
            to: staffData.email,
            subject: `Your rota — w/c ${weekLabel}`,
            html
          });
          sent.push(staffId);
        } catch (e) {
          console.error('rota email error for', staffData.email, e.message);
          failed.push(staffId);
        }
      } else {
        console.log(`[rota email – no SMTP] To: ${staffData.email} | Subject: Your rota — w/c ${weekLabel}`);
        sent.push(staffId);
      }
    }

    console.log(`[rota] Published ${ws}: ${sent.length} emails sent, ${failed.length} failed, smtp=${smtpOk}`);
    res.json({ ok: true, sent: sent.length, failed: failed.length, smtp: smtpOk, week_start: ws });
  } catch (err) {
    console.error('rota /publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rota/week/:date/unlock — clear published_at (manager only)
router.post('/week/:date/unlock', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE rota_weeks SET published_at = NULL, published_by = NULL WHERE week_start = $1 RETURNING id',
      [ws]
    );
    if (!rows.length) return res.status(404).json({ error: 'No rota for this week' });
    res.json({ ok: true });
  } catch (err) {
    console.error('rota /unlock error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rota/my — current user's published shifts for next 14 days
router.get('/my', async (req, res) => {
  try {
    const db = getPool();
    const today = new Date().toISOString().split('T')[0];
    const future = new Date();
    future.setDate(future.getDate() + 14);
    const end = future.toISOString().split('T')[0];

    const settings = await getRotaSettings(db);
    const hideLabels = !!settings.hide_labels_from_employees;
    const { rows } = await db.query(`
      SELECT rs.id, rs.shift_date, rs.planned_start, rs.planned_end,
             rs.break_mins, rs.notes, rs.acceptance, rs.label, rs.colour,
             rs.is_absent, r.name AS room_name,
             rw.published_at, rw.week_start
      FROM rota_shifts rs
      JOIN rota_weeks rw ON rw.id = rs.rota_week_id
      LEFT JOIN rooms r ON r.id = rs.room_id
      WHERE rs.staff_id = $1
        AND rs.shift_date >= $2
        AND rs.shift_date <= $3
        AND rw.published_at IS NOT NULL
      ORDER BY rs.shift_date
    `, [req.user.id, today, end]);

    if (hideLabels) for (const r of rows) { r.label = null; r.colour = null; }
    res.json(rows);
  } catch (err) {
    console.error('rota /my error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email template ────────────────────────────────────────────────────────────
function buildRotaEmail(name, shifts, weekLabel) {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const rows = shifts.map(s => {
    const d = new Date(s.shift_date + 'T00:00:00Z');
    const day = DAYS[d.getUTCDay()];
    const date = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    const start = s.planned_start ? String(s.planned_start).substring(0, 5) : '—';
    const end = s.planned_end ? String(s.planned_end).substring(0, 5) : '—';
    const room = s.room_name || '—';
    return `<tr>
      <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#1e293b">${day}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#374151">${date}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#374151">${start} – ${end}</td>
      <td style="padding:10px 16px;border-bottom:1px solid #e5e7eb;color:#6b7280">${room}</td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:32px 16px">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08)">
  <tr><td style="background:#0f172a;padding:24px 32px;text-align:center">
    <div style="font-family:'Arial Rounded MT Bold',Arial,sans-serif;font-size:22px">
      <span style="color:#4a9abf">Little Angels</span>
      <span style="color:#e07820"> Day Nursery</span>
    </div>
    <div style="color:#94a3b8;font-size:13px;margin-top:6px">Weekly Rota</div>
  </td></tr>
  <tr><td style="padding:28px 32px">
    <div style="font-size:20px;font-weight:700;color:#1e293b;margin-bottom:4px">Hi ${name.split(' ')[0]},</div>
    <div style="font-size:14px;color:#6b7280;margin-bottom:24px">Here's your rota for <strong>week commencing ${weekLabel}</strong>.</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden">
      <thead>
        <tr style="background:#f8fafc">
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Day</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Date</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Hours</th>
          <th style="padding:10px 16px;text-align:left;font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em">Room</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="4" style="padding:16px;color:#9ca3af;text-align:center">No shifts scheduled this week</td></tr>'}</tbody>
    </table>
    <div style="margin-top:24px;text-align:center">
      <a href="https://hr.littleangelsealing.co.uk/my-shifts.html"
         style="display:inline-block;background:#4a9abf;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px">
        View My Shifts Online
      </a>
    </div>
  </td></tr>
  <tr><td style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e5e7eb;text-align:center">
    <div style="font-size:12px;color:#9ca3af;line-height:1.6">
      Little Angels Day Nursery | 1A Dudley Gardens, Ealing, W13 9LU<br>
      Office: 020 8051 0349 | admissions@littleangelsealing.co.uk<br>
      Mon–Fri 8:00am–6:00pm | Established 1990
    </div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

// ── Room name normaliser (work_patterns uses short names) ─────────────────────
function normaliseRoomId(roomText, rooms) {
  if (!roomText) return null;
  const t = roomText.toLowerCase().replace(/[^a-z]/g, '');
  // Check if room name and pattern name share first 3 chars (handles "Babies"↔"Baby Room", "Preschool"↔"Pre-school")
  const r = rooms.find(r => {
    const rn = r.name.toLowerCase().replace(/[^a-z]/g, '');
    return rn.startsWith(t.substring(0,3)) || t.startsWith(rn.substring(0,3));
  });
  return r ? r.id : null;
}

// ── Compute conflict flags for a day's shifts in a room ───────────────────────
function computeDayConflicts(shifts, room) {
  const flags = [];
  const present = shifts.filter(s => !s.is_absent && !s.is_meeting);
  const required = Math.ceil((room.capacity || 0) / (room.ratio_children_per_staff || 4));
  if (present.length < required) flags.push('ratio_breach');
  const hasDsl = present.some(s => s.is_dsl || s.is_deputy_dsl);
  if (!hasDsl) flags.push('no_dsl');
  const hasFa = present.some(s => s.is_first_aider);
  if (!hasFa) flags.push('no_first_aider');
  return flags;
}

// ── POST /api/rota/auto-generate ─────────────────────────────────────────────
router.post('/auto-generate', checkFeature, managerOnly, async (req, res) => {
  const { week_start_date } = req.body;
  if (!week_start_date || !/^\d{4}-\d{2}-\d{2}$/.test(week_start_date)) {
    return res.status(400).json({ error: 'week_start_date required (YYYY-MM-DD Monday)' });
  }
  const ws = toWeekStart(week_start_date);
  if (ws !== week_start_date) {
    return res.status(400).json({ error: `${week_start_date} is not a Monday — use ${ws}` });
  }

  try {
    const db = getPool();

    // Idempotency guard
    const { rows: existing } = await db.query(
      "SELECT id FROM rota_weeks WHERE week_start = $1 AND status IN ('draft','published')", [ws]
    );
    if (existing.length) {
      return res.status(409).json({ error: 'rota_exists', week_id: existing[0].id, week_start: ws });
    }

    const { rows: rooms } = await db.query('SELECT * FROM rooms ORDER BY id');
    const { rows: staff } = await db.query(
      `SELECT s.*, s.is_dsl, s.is_deputy_dsl, s.is_first_aider, s.hourly_rate
       FROM staff s WHERE (s.is_active = true OR s.is_active IS NULL)`
    );

    // Get active work patterns for this week
    const { rows: patterns } = await db.query(
      `SELECT * FROM staff_work_patterns
       WHERE (effective_to IS NULL OR effective_to >= $1)
         AND effective_from <= $2`,
      [ws, ws]
    );

    // Get approved absences overlapping this week
    const weekEnd = new Date(ws + 'T00:00:00Z');
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 4); // Friday
    const weekEndStr = weekEnd.toISOString().split('T')[0];
    const { rows: absences } = await db.query(
      `SELECT staff_id, start_date, end_date FROM absence_requests
       WHERE status = 'approved'
         AND start_date <= $2 AND end_date >= $1`,
      [ws, weekEndStr]
    );

    // Build absence set: staff_id -> Set of ISO date strings
    const absenceMap = {};
    for (const ab of absences) {
      if (!absenceMap[ab.staff_id]) absenceMap[ab.staff_id] = new Set();
      const cur = new Date(ab.start_date + 'T00:00:00Z');
      const end = new Date(ab.end_date + 'T00:00:00Z');
      while (cur <= end) {
        absenceMap[ab.staff_id].add(cur.toISOString().split('T')[0]);
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }

    // Bank/public holidays in this week + each staff member's pattern handling
    // ('works' = normal shift; 'deducted'/'not_deducted' = off that day).
    const { rows: bankHolRows } = await db.query(
      'SELECT holiday_date, name FROM bank_holidays WHERE holiday_date BETWEEN $1 AND $2', [ws, weekEndStr]
    );
    const bankHols = {};
    for (const h of bankHolRows) bankHols[new Date(h.holiday_date).toISOString().split('T')[0]] = h.name;
    const { rows: phhRows } = await db.query(
      `SELECT s.id AS staff_id, wp.public_holiday_handling
       FROM staff s JOIN work_patterns wp ON wp.id = s.work_pattern_id`
    );
    const phhMap = {};
    for (const r of phhRows) phhMap[r.staff_id] = r.public_holiday_handling;

    // Create the rota week
    const { rows: weekRows } = await db.query(
      `INSERT INTO rota_weeks (week_start, status, generated_from_pattern_at, created_at)
       VALUES ($1, 'draft', NOW(), NOW()) RETURNING id`,
      [ws]
    );
    const weekId = weekRows[0].id;

    const staffById = {};
    for (const s of staff) staffById[s.id] = s;

    let shiftCount = 0;
    const conflictsByDay = {}; // dayISO -> { roomId -> [shifts] }

    // Generate shifts for each staff / day_of_week
    for (const pat of patterns) {
      if (pat.is_off) continue; // off day — no shift row
      // day_of_week in patterns: 0=Mon, 4=Fri
      const shiftDate = new Date(ws + 'T00:00:00Z');
      shiftDate.setUTCDate(shiftDate.getUTCDate() + pat.day_of_week);
      const shiftDateStr = shiftDate.toISOString().split('T')[0];

      const roomId = normaliseRoomId(pat.room, rooms);
      const onLeave = !!(absenceMap[pat.staff_id] && absenceMap[pat.staff_id].has(shiftDateStr));
      // Bank-holiday handling from the staff member's assigned pattern.
      const holName = bankHols[shiftDateStr];
      const holOff  = !!holName && (phhMap[pat.staff_id] || 'not_deducted') !== 'works';
      const isAbsent = onLeave || holOff;
      const note = holOff ? ('Bank holiday: ' + holName) : null;
      const staffRec = staffById[pat.staff_id] || {};

      const { rows } = await db.query(
        `INSERT INTO rota_shifts
           (rota_week_id, staff_id, shift_date, day_of_week, planned_start, planned_end,
            room_id, break_mins, is_absent, notes, source, conflict_flags, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pattern','[]',NOW()) RETURNING id`,
        [weekId, pat.staff_id, shiftDateStr, pat.day_of_week,
         pat.shift_start || null, pat.shift_end || null,
         roomId, pat.lunch_break_minutes || 30, isAbsent, note]
      );
      shiftCount++;

      // Collect for conflict computation
      if (!conflictsByDay[shiftDateStr]) conflictsByDay[shiftDateStr] = {};
      if (roomId) {
        if (!conflictsByDay[shiftDateStr][roomId]) conflictsByDay[shiftDateStr][roomId] = [];
        conflictsByDay[shiftDateStr][roomId].push({ ...staffRec, is_absent: isAbsent });
      }
    }

    // Compute and store conflict_flags per shift
    for (const [dateStr, roomGroups] of Object.entries(conflictsByDay)) {
      for (const [roomId, dayShifts] of Object.entries(roomGroups)) {
        const room = rooms.find(r => r.id === parseInt(roomId));
        if (!room) continue;
        const flags = computeDayConflicts(dayShifts, room);
        if (flags.length) {
          await db.query(
            `UPDATE rota_shifts SET conflict_flags = $1
             WHERE rota_week_id = $2 AND shift_date = $3 AND room_id = $4`,
            [JSON.stringify(flags), weekId, dateStr, roomId]
          );
        }
      }
    }

    res.json({ ok: true, week_id: weekId, week_start: ws, shifts_created: shiftCount });
  } catch (err) {
    console.error('rota /auto-generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/shifts/move — drag-drop shift move ────────────────────────
router.post('/shifts/move', checkFeature, managerOnly, async (req, res) => {
  const { shift_id, new_day, new_staff_id, new_room_id, new_start, new_end } = req.body;
  if (!shift_id || new_day == null) {
    return res.status(400).json({ error: 'shift_id and new_day required' });
  }

  try {
    const db = getPool();
    const { rows: shiftRows } = await db.query(
      `SELECT rs.*, rw.week_start FROM rota_shifts rs
       JOIN rota_weeks rw ON rw.id = rs.rota_week_id
       WHERE rs.id = $1`, [shift_id]
    );
    if (!shiftRows.length) return res.status(404).json({ error: 'Shift not found' });
    const shift = shiftRows[0];

    // Compute new date from week_start + new_day (0=Mon)
    const wsStr = shift.week_start instanceof Date
      ? shift.week_start.toISOString().split('T')[0]
      : String(shift.week_start).substring(0, 10);
    const newDate = new Date(wsStr + 'T00:00:00Z');
    newDate.setUTCDate(newDate.getUTCDate() + new_day);
    const newDateStr = newDate.toISOString().split('T')[0];

    const updates = {
      shift_date: newDateStr,
      day_of_week: new_day,
      staff_id: new_staff_id || shift.staff_id,
      room_id: new_room_id !== undefined ? new_room_id : shift.room_id,
      planned_start: new_start || shift.planned_start,
      planned_end: new_end || shift.planned_end
    };

    // Remove any existing shift at the target slot to avoid unique constraint violation
    await db.query(
      `DELETE FROM rota_shifts WHERE rota_week_id=$1 AND staff_id=$2 AND shift_date=$3 AND id!=$4`,
      [shift.rota_week_id, updates.staff_id, updates.shift_date, shift_id]
    );
    await db.query(
      `UPDATE rota_shifts SET
         shift_date=$1, day_of_week=$2, staff_id=$3, room_id=$4,
         planned_start=$5, planned_end=$6, source='manual'
       WHERE id=$7`,
      [updates.shift_date, updates.day_of_week, updates.staff_id,
       updates.room_id, updates.planned_start, updates.planned_end, shift_id]
    );

    // Recompute conflicts for affected days/rooms
    const { rows: rooms } = await db.query('SELECT * FROM rooms ORDER BY id');
    const { rows: staff } = await db.query('SELECT * FROM staff WHERE is_active=true');
    const staffById = {};
    for (const s of staff) staffById[s.id] = s;

    const oldDateStr = shift.shift_date instanceof Date
      ? shift.shift_date.toISOString().split('T')[0]
      : String(shift.shift_date).substring(0, 10);
    const affectedDays = new Set([oldDateStr, newDateStr]);
    for (const dateStr of affectedDays) {
      const { rows: dayShifts } = await db.query(
        `SELECT rs.*, s.is_dsl, s.is_deputy_dsl, s.is_first_aider
         FROM rota_shifts rs JOIN staff s ON s.id=rs.staff_id
         WHERE rs.rota_week_id=$1 AND rs.shift_date=$2`,
        [shift.rota_week_id, dateStr]
      );
      const byRoom = {};
      for (const ds of dayShifts) {
        if (!byRoom[ds.room_id]) byRoom[ds.room_id] = [];
        byRoom[ds.room_id].push(ds);
      }
      for (const [roomId, dayShiftsForRoom] of Object.entries(byRoom)) {
        const room = rooms.find(r => r.id === parseInt(roomId));
        if (!room) continue;
        const flags = computeDayConflicts(dayShiftsForRoom, room);
        await db.query(
          `UPDATE rota_shifts SET conflict_flags=$1
           WHERE rota_week_id=$2 AND shift_date=$3 AND room_id=$4`,
          [JSON.stringify(flags), shift.rota_week_id, dateStr, parseInt(roomId)]
        );
      }
    }

    // Return updated week data for UI refresh
    const { rows: updatedShifts } = await db.query(
      `SELECT rs.*, r.name AS room_name, s.first_name, s.last_name
       FROM rota_shifts rs
       LEFT JOIN rooms r ON r.id=rs.room_id
       LEFT JOIN staff s ON s.id=rs.staff_id
       WHERE rs.rota_week_id=$1 ORDER BY rs.shift_date, rs.staff_id`,
      [shift.rota_week_id]
    );

    res.json({ ok: true, shifts: updatedShifts });
  } catch (err) {
    console.error('rota /shifts/move error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/rota/weeks/:id/publish ─────────────────────────────────────────
router.put('/weeks/:id/publish', checkFeature, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const weekId = parseInt(req.params.id);
    const { rows: weekRows } = await db.query('SELECT * FROM rota_weeks WHERE id=$1', [weekId]);
    if (!weekRows.length) return res.status(404).json({ error: 'Week not found' });
    const week = weekRows[0];
    const ws = week.week_start.toISOString ? week.week_start.toISOString().split('T')[0] : week.week_start;

    await db.query(
      "UPDATE rota_weeks SET status='published', published_at=NOW(), published_by=$1 WHERE id=$2",
      [req.user.id, weekId]
    );
    try { await afterPublish(db, weekId, ws); } catch (e) { console.error('rota afterPublish error:', e.message); }

    const { rows: shifts } = await db.query(
      `SELECT rs.*, s.first_name, s.last_name, s.email, r.name AS room_name
       FROM rota_shifts rs
       JOIN staff s ON s.id=rs.staff_id
       LEFT JOIN rooms r ON r.id=rs.room_id
       WHERE rs.rota_week_id=$1 ORDER BY rs.staff_id, rs.shift_date`, [weekId]
    );

    const byStaff = {};
    for (const row of shifts) {
      if (!byStaff[row.staff_id]) {
        byStaff[row.staff_id] = { name: `${row.first_name} ${row.last_name}`, email: row.email, shifts: [] };
      }
      byStaff[row.staff_id].shifts.push(row);
    }

    const smtpOk = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    let transport = null;
    if (smtpOk) {
      transport = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_PORT === '465',
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      });
    }

    const weekLabel = new Date(ws + 'T00:00:00Z').toLocaleDateString('en-GB',
      { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const sent = [], failed = [];
    for (const [, staffData] of Object.entries(byStaff)) {
      if (!staffData.email) continue;
      const html = buildRotaEmail(staffData.name, staffData.shifts, weekLabel);
      if (smtpOk) {
        try {
          await transport.sendMail({
            from: process.env.SMTP_FROM || 'Little Angels Day Nursery <admissions@littleangelsealing.co.uk>',
            to: staffData.email,
            subject: `Your rota — w/c ${weekLabel}`,
            html
          });
          sent.push(staffData.email);
        } catch (e) {
          console.error('rota publish email error:', e.message);
          failed.push(staffData.email);
        }
      } else {
        console.log(`[rota publish – no SMTP] To: ${staffData.email}`);
        sent.push(staffData.email);
      }
    }

    res.json({ ok: true, week_id: weekId, week_start: ws, sent: sent.length, failed: failed.length, smtp: smtpOk });
  } catch (err) {
    console.error('rota PUT /weeks/:id/publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rota/calendar.ics — iCal feed (published shifts) ─────────────────
router.get('/calendar.ics', async (req, res) => {
  try {
    const { token, staff_id } = req.query;
    const db = getPool();

    let staffId = null;
    if (token) {
      const { rows } = await db.query(
        "SELECT entity_id FROM calendar_feed_tokens WHERE token=$1 AND scope='rota' AND entity_type='staff'",
        [token]
      );
      if (!rows.length) return res.status(403).send('Invalid token');
      staffId = rows[0].entity_id;
    } else if (staff_id && req.user) {
      staffId = parseInt(staff_id);
    } else {
      return res.status(401).send('token or auth required');
    }

    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - 7);
    const to = new Date(today); to.setDate(to.getDate() + 56);

    const { rows: shifts } = await db.query(
      `SELECT rs.shift_date, rs.planned_start, rs.planned_end, rs.break_mins,
              r.name AS room_name, s.first_name, s.last_name
       FROM rota_shifts rs
       JOIN rota_weeks rw ON rw.id = rs.rota_week_id
       LEFT JOIN rooms r ON r.id = rs.room_id
       JOIN staff s ON s.id = rs.staff_id
       WHERE rs.staff_id = $1
         AND rw.status = 'published'
         AND rs.shift_date >= $2 AND rs.shift_date <= $3
         AND rs.is_absent = false
       ORDER BY rs.shift_date`,
      [staffId, from.toISOString().split('T')[0], to.toISOString().split('T')[0]]
    );

    const icalLines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Little Angels Day Nursery//Wren Rota//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:Wren Rota`,
      `X-WR-TIMEZONE:Europe/London`,
    ];

    for (const s of shifts) {
      const dateStr = s.shift_date.toISOString ? s.shift_date.toISOString().split('T')[0] : s.shift_date;
      const dtStamp = dateStr.replace(/-/g, '');
      const startHH = s.planned_start ? String(s.planned_start).substring(0,5).replace(':','') : '0900';
      const endHH = s.planned_end   ? String(s.planned_end).substring(0,5).replace(':','')   : '1700';
      const roomNote = s.room_name ? ` (${s.room_name})` : '';
      icalLines.push(
        'BEGIN:VEVENT',
        `UID:wren-rota-${staffId}-${dtStamp}@littleangelsealing.co.uk`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g,'').substring(0,15)}Z`,
        `DTSTART;TZID=Europe/London:${dtStamp}T${startHH}00`,
        `DTEND;TZID=Europe/London:${dtStamp}T${endHH}00`,
        `SUMMARY:Shift${roomNote}`,
        `DESCRIPTION:Little Angels Day Nursery\\nRoom: ${s.room_name || 'Any'}\\nBreak: ${s.break_mins || 30} mins`,
        `LOCATION:1A Dudley Gardens\\, Ealing\\, W13 9LU`,
        'END:VEVENT'
      );
    }
    icalLines.push('END:VCALENDAR');

    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="rota-${staffId}.ics"`);
    res.send(icalLines.join('\r\n'));
  } catch (err) {
    console.error('rota /calendar.ics error:', err.message);
    res.status(500).send('Error generating calendar');
  }
});

// ── GET /api/rota/week/:date/conflicts — per-day conflict summary ─────────────
router.get('/week/:date/conflicts', async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query('SELECT id FROM rota_weeks WHERE week_start=$1', [ws]);
    if (!weekRows.length) return res.json({ conflicts: {} });
    const weekId = weekRows[0].id;

    const { rows: rooms } = await db.query('SELECT * FROM rooms ORDER BY id');
    const { rows: shifts } = await db.query(
      `SELECT rs.shift_date, rs.room_id, rs.is_absent, rs.is_meeting,
              s.is_dsl, s.is_deputy_dsl, s.is_first_aider
       FROM rota_shifts rs JOIN staff s ON s.id=rs.staff_id
       WHERE rs.rota_week_id=$1`, [weekId]
    );

    // Build day × room coverage
    const result = {};
    for (const s of shifts) {
      const d = s.shift_date.toISOString ? s.shift_date.toISOString().split('T')[0] : s.shift_date;
      if (!result[d]) result[d] = {};
      if (!result[d][s.room_id]) result[d][s.room_id] = { shifts: [], room: rooms.find(r => r.id === s.room_id) };
      result[d][s.room_id].shifts.push(s);
    }

    const out = {};
    for (const [date, rooms2] of Object.entries(result)) {
      out[date] = {};
      for (const [roomId, { shifts: dayShifts, room }] of Object.entries(rooms2)) {
        if (!room) continue;
        const present = dayShifts.filter(s => !s.is_absent && !s.is_meeting);
        const required = Math.ceil((room.capacity || 0) / (room.ratio_children_per_staff || 4));
        out[date][roomId] = {
          room_name: room.name,
          present: present.length,
          required,
          ratio: room.ratio_children_per_staff,
          flags: computeDayConflicts(dayShifts, room)
        };
      }
    }
    res.json({ conflicts: out });
  } catch (err) {
    console.error('rota /conflicts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rota/week/:date/wage-summary ────────────────────────────────────
// PROMPT 35 (2026-06-30): wage £ totals are pay data → manager-only. managerOnly
// (incl. deputy) still gates rota planning; requireSalaryView excludes deputy here.
router.get('/week/:date/wage-summary', managerOnly, requireSalaryView, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query('SELECT id FROM rota_weeks WHERE week_start=$1', [ws]);
    if (!weekRows.length) return res.json({ total: 0, by_day: {}, by_staff: {}, total_hours: 0, hours_by_day: {} });
    const weekId = weekRows[0].id;

    const { rows: shifts } = await db.query(
      `SELECT rs.shift_date, rs.planned_start, rs.planned_end, rs.break_mins,
              rs.is_absent, s.id AS staff_id, s.first_name, s.last_name, s.hourly_rate
       FROM rota_shifts rs JOIN staff s ON s.id=rs.staff_id
       WHERE rs.rota_week_id=$1 AND rs.is_absent=false ORDER BY rs.shift_date, rs.staff_id`,
      [weekId]
    );

    let total = 0;
    const byDay = {};
    const byStaff = {};
    // EyMan/BrightHR parity: surface scheduled HOURS alongside cost. Hours are computed
    // for ALL non-absent shifts (even where hourly_rate is missing) so the headline
    // staff-hours figure is complete; cost only counts shifts that have a rate.
    let totalHours = 0;
    const hoursByDay = {};

    for (const s of shifts) {
      if (!s.planned_start || !s.planned_end) continue;
      const [sh, sm] = String(s.planned_start).split(':').map(Number);
      const [eh, em] = String(s.planned_end).split(':').map(Number);
      const mins = (eh * 60 + em) - (sh * 60 + sm) - (s.break_mins || 0);
      const hours = Math.max(0, mins / 60);
      const rate = parseFloat(s.hourly_rate);
      const cost = hours * (isFinite(rate) ? rate : 0);

      const d = s.shift_date.toISOString ? s.shift_date.toISOString().split('T')[0] : s.shift_date;
      hoursByDay[d] = (hoursByDay[d] || 0) + hours;
      totalHours += hours;

      const key = `${s.staff_id}`;
      if (!byStaff[key]) byStaff[key] = { name: `${s.first_name} ${s.last_name}`, hourly_rate: s.hourly_rate, total: 0, hours: 0 };
      byStaff[key].hours += hours;
      if (!s.hourly_rate) continue;   // cost requires a rate; hours already counted above
      byDay[d] = (byDay[d] || 0) + cost;
      byStaff[key].total += cost;
      total += cost;
    }
    // round per-staff/per-day hours for clean display
    for (const k in byStaff) byStaff[k].hours = Math.round(byStaff[k].hours * 100) / 100;
    for (const d in hoursByDay) hoursByDay[d] = Math.round(hoursByDay[d] * 100) / 100;

    const totalRounded = Math.round(total * 100) / 100;
    const totalHoursRounded = Math.round(totalHours * 100) / 100;
    const { rows: wk } = await db.query('SELECT budget, name FROM rota_weeks WHERE id=$1', [weekId]);
    const budget = wk.length && wk[0].budget != null ? parseFloat(wk[0].budget) : null;
    const variance = budget != null ? Math.round((budget - totalRounded) * 100) / 100 : null;
    res.json({
      total: totalRounded, by_day: byDay, by_staff: byStaff,
      total_hours: totalHoursRounded, hours_by_day: hoursByDay,
      budget, variance,
      over_budget: budget != null ? totalRounded > budget : null,
      name: wk.length ? wk[0].name : null,
    });
  } catch (err) {
    console.error('rota /wage-summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PROMPT 30 — BrightHR-parity additions (copy rota, budget/cost, settings,
//   accept/decline, open shifts, live ratio check, staff notifications).
//   ADDITIVE — all new endpoints; no existing route modified or duplicated.
// ════════════════════════════════════════════════════════════════════════════

// ── Date helpers (UTC, consistent with toWeekStart above) ────────────────────
function ymd(d) { return d instanceof Date ? d.toISOString().split('T')[0] : String(d).substring(0, 10); }
function addDaysStr(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().split('T')[0];
}
function daysBetweenStr(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}
function fmtT(t) { return t ? String(t).substring(0, 5) : '—'; }

// ── Rota settings (stored as one JSON blob in settings) ─────────────────
const DEFAULT_ROTA_SETTINGS = {
  default_view: 'table',              // table | timeline | dragdrop
  restricted_permissions: false,      // only author/admin may edit (advisory flag surfaced to UI)
  hide_labels_from_employees: false,  // strip shift labels/colours on staff-facing views
  accept_decline_staff: [],           // staff_ids whose new shifts require accept/decline
  open_shifts_enabled: true,          // allow managers to post open (unassigned) shifts
};
async function getRotaSettings(db) {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key='rota_settings'");
    if (rows.length && rows[0].value) return { ...DEFAULT_ROTA_SETTINGS, ...JSON.parse(rows[0].value) };
  } catch (e) { /* fall through to defaults */ }
  return { ...DEFAULT_ROTA_SETTINGS };
}

// GET /api/rota/settings — readable by any authed user (staff UIs need default_view etc.)
router.get('/settings', async (req, res) => {
  try { res.json(await getRotaSettings(getPool())); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/rota/settings — manager only
router.post('/settings', checkFeature, managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const current = await getRotaSettings(db);
    const next = { ...current };
    const b = req.body || {};
    if ('default_view' in b && ['table', 'timeline', 'dragdrop'].includes(b.default_view)) next.default_view = b.default_view;
    if ('restricted_permissions' in b) next.restricted_permissions = !!b.restricted_permissions;
    if ('hide_labels_from_employees' in b) next.hide_labels_from_employees = !!b.hide_labels_from_employees;
    if ('open_shifts_enabled' in b) next.open_shifts_enabled = !!b.open_shifts_enabled;
    if ('accept_decline_staff' in b && Array.isArray(b.accept_decline_staff))
      next.accept_decline_staff = b.accept_decline_staff.map(Number).filter(n => !isNaN(n));
    await db.query(
      `INSERT INTO settings (key, value, updated_by, updated_at)
       VALUES ('rota_settings', $1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [JSON.stringify(next), req.user.id]
    );
    res.json({ ok: true, settings: next });
  } catch (err) {
    console.error('rota /settings POST error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/week/:date/budget — set rota budget / name / duration ──────
router.post('/week/:date/budget', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();
    const { budget, name, duration_days } = req.body || {};
    const { rows } = await db.query(
      `INSERT INTO rota_weeks (week_start, status, budget, name, duration_days, created_at)
       VALUES ($1, 'draft', $2, $3, $4, NOW())
       ON CONFLICT (week_start) DO UPDATE SET
         budget        = COALESCE($2, rota_weeks.budget),
         name          = COALESCE($3, rota_weeks.name),
         duration_days = COALESCE($4, rota_weeks.duration_days)
       RETURNING id, week_start, status, budget, name, duration_days`,
      [ws, (budget != null && budget !== '') ? budget : null, name || null,
       duration_days ? parseInt(duration_days) : null]
    );
    res.json({ ok: true, week: rows[0] });
  } catch (err) {
    console.error('rota /budget error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/week/:date/copy-from/:sourceId — copy shifts to a new week ─
router.post('/week/:date/copy-from/:sourceId', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const sourceId = parseInt(req.params.sourceId);
    const db = getPool();
    const { name, duration_days, budget, team_room_id } = req.body || {};

    const { rows: srcRows } = await db.query('SELECT * FROM rota_weeks WHERE id=$1', [sourceId]);
    if (!srcRows.length) return res.status(404).json({ error: 'source rota not found' });
    const source = srcRows[0];
    const srcStart = ymd(source.week_start);

    const { rows: tw } = await db.query(
      `INSERT INTO rota_weeks (week_start, status, name, duration_days, budget, copied_from, created_at)
       VALUES ($1, 'draft', $2, $3, $4, $5, NOW())
       ON CONFLICT (week_start) DO UPDATE SET
         name          = COALESCE(EXCLUDED.name, rota_weeks.name),
         duration_days = EXCLUDED.duration_days,
         budget        = COALESCE(EXCLUDED.budget, rota_weeks.budget),
         copied_from   = EXCLUDED.copied_from
       RETURNING id`,
      [ws, name || source.name || null,
       duration_days ? parseInt(duration_days) : (source.duration_days || 7),
       (budget != null && budget !== '') ? budget : source.budget,
       sourceId]
    );
    const weekId = tw[0].id;

    // Clean slate on the target week before copying.
    await db.query('DELETE FROM rota_shifts WHERE rota_week_id=$1', [weekId]);

    const { rows: srcShifts } = await db.query('SELECT * FROM rota_shifts WHERE rota_week_id=$1', [sourceId]);
    const dayOffset = daysBetweenStr(srcStart, ws);
    let copied = 0;
    for (const s of srcShifts) {
      if (team_room_id && s.room_id && parseInt(team_room_id) !== s.room_id) continue; // By-team filter
      const sd = addDaysStr(ymd(s.shift_date), dayOffset);
      await db.query(
        `INSERT INTO rota_shifts
           (rota_week_id, staff_id, shift_date, day_of_week, planned_start, planned_end,
            room_id, break_mins, notes, label, colour, is_open, acceptance, source, conflict_flags, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'not_required','copy','[]',NOW())
         ON CONFLICT (rota_week_id, staff_id, shift_date) DO NOTHING`,
        [weekId, s.staff_id, sd, s.day_of_week, s.planned_start, s.planned_end,
         s.room_id, s.break_mins, s.notes, s.label, s.colour, !!s.is_open]
      );
      copied++;
    }
    res.json({ ok: true, week_id: weekId, week_start: ws, shifts_copied: copied, copied_from: sourceId });
  } catch (err) {
    console.error('rota /copy-from error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rota/week/:date/ratio — live childcare ratio check (Wren's edge) ─
// Cross-checks rota staffing against BOOKED children (attendance weekday pattern)
// per room/age-band, flagging under-ratio days. This is what BrightHR cannot do.
router.get('/week/:date/ratio', async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: rooms } = await db.query(
      'SELECT id, name, capacity, ratio_children_per_staff FROM rooms ORDER BY ratio_children_per_staff'
    );
    const babyRoom = rooms.find(r => /bab/i.test(r.name)) ||
                     rooms.find(r => (r.ratio_children_per_staff || 8) <= 3) || rooms[0];
    const psRoom = rooms.find(r => !babyRoom || r.id !== babyRoom.id) || rooms[rooms.length - 1];

    const { rows: weekRows } = await db.query('SELECT id FROM rota_weeks WHERE week_start=$1', [ws]);
    const weekId = weekRows.length ? weekRows[0].id : null;

    // Present staff per (date, room) from the rota — exclude absent / meeting / still-open shifts.
    const presentByDayRoom = {};
    if (weekId) {
      const { rows: shifts } = await db.query(
        `SELECT shift_date, room_id, is_absent, is_meeting, is_open, staff_id
         FROM rota_shifts WHERE rota_week_id=$1`, [weekId]);
      for (const s of shifts) {
        if (s.is_absent || s.is_meeting || s.is_open || !s.staff_id || !s.room_id) continue;
        const d = ymd(s.shift_date);
        presentByDayRoom[d] = presentByDayRoom[d] || {};
        presentByDayRoom[d][s.room_id] = (presentByDayRoom[d][s.room_id] || 0) + 1;
      }
    }

    const days = {};
    let anyUnder = false;
    for (let i = 0; i < 5; i++) {
      const dateStr = addDaysStr(ws, i);
      const booked = await ratioEngine.bookedChildrenByBand(db, dateStr); // {under2,two,threePlus,total}
      const reqBaby = Math.ceil((booked.under2 || 0) / 3);
      const reqPs   = Math.ceil((booked.two || 0) / 5) + Math.ceil((booked.threePlus || 0) / 8);
      const presBaby = (presentByDayRoom[dateStr] && babyRoom ? presentByDayRoom[dateStr][babyRoom.id] : 0) || 0;
      const presPs   = (presentByDayRoom[dateStr] && psRoom ? presentByDayRoom[dateStr][psRoom.id] : 0) || 0;
      const roomsOut = {};
      if (babyRoom) roomsOut[babyRoom.id] = {
        room_name: babyRoom.name, booked: booked.under2 || 0, required: reqBaby,
        present: presBaby, under_ratio: presBaby < reqBaby,
      };
      if (psRoom) roomsOut[psRoom.id] = {
        room_name: psRoom.name, booked: (booked.two || 0) + (booked.threePlus || 0), required: reqPs,
        present: presPs, under_ratio: presPs < reqPs,
      };
      const dayUnder = Object.values(roomsOut).some(r => r.under_ratio);
      if (dayUnder) anyUnder = true;
      days[dateStr] = { weekday: i, booked, rooms: roomsOut, under_ratio: dayUnder };
    }
    res.json({ week_start: ws, any_under_ratio: anyUnder, days });
  } catch (err) {
    console.error('rota /ratio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/week/:date/open-shift — manager posts an unassigned shift ──
router.post('/week/:date/open-shift', checkFeature, managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();
    const settings = await getRotaSettings(db);
    if (!settings.open_shifts_enabled) return res.status(403).json({ error: 'open_shifts_disabled' });

    const { shift_date, planned_start, planned_end, room_id, break_mins, label, colour, notes } = req.body || {};
    if (!shift_date || !/^\d{4}-\d{2}-\d{2}$/.test(shift_date))
      return res.status(400).json({ error: 'shift_date (YYYY-MM-DD) required' });

    const { rows: wk } = await db.query(
      `INSERT INTO rota_weeks (week_start, status, created_at) VALUES ($1, 'draft', NOW())
       ON CONFLICT (week_start) DO UPDATE SET week_start=EXCLUDED.week_start RETURNING id`, [ws]);
    const weekId = wk[0].id;
    const dow = daysBetweenStr(ws, ymd(shift_date));

    const { rows } = await db.query(
      `INSERT INTO rota_shifts
         (rota_week_id, staff_id, shift_date, day_of_week, planned_start, planned_end,
          room_id, break_mins, label, colour, notes, is_open, acceptance, source, conflict_flags, created_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10, true, 'not_required', 'open', '[]', NOW())
       RETURNING *`,
      [weekId, ymd(shift_date), dow, planned_start || null, planned_end || null,
       room_id ? parseInt(room_id) : null, break_mins != null ? parseInt(break_mins) : 30,
       label || null, colour || null, notes || null]
    );
    const shift = rows[0];
    notifyOpenShift(db, shift).catch(e => console.error('notifyOpenShift:', e.message));
    res.json({ ok: true, shift });
  } catch (err) {
    console.error('rota /open-shift error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/rota/open — open shifts the current user is eligible to claim ────
router.get('/open', async (req, res) => {
  try {
    const db = getPool();
    const today = ymd(new Date());
    const { rows: me } = await db.query('SELECT room_id FROM staff WHERE id=$1', [req.user.id]);
    const myRoom = me.length ? me[0].room_id : null;
    const { rows } = await db.query(
      `SELECT rs.*, r.name AS room_name
       FROM rota_shifts rs
       JOIN rota_weeks rw ON rw.id = rs.rota_week_id
       LEFT JOIN rooms r ON r.id = rs.room_id
       WHERE rs.is_open = true AND rs.staff_id IS NULL
         AND rs.shift_date >= $1
         AND rw.status = 'published'
         AND (rs.room_id IS NULL OR $2::int IS NULL OR rs.room_id = $2)
         AND NOT EXISTS (
           SELECT 1 FROM rota_shifts x
           WHERE x.rota_week_id = rs.rota_week_id AND x.staff_id = $3 AND x.shift_date = rs.shift_date)
       ORDER BY rs.shift_date, rs.planned_start`,
      [today, myRoom, req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('rota /open error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/rota/shift/:id/claim — atomic first-come-first-served claim ─────
router.post('/shift/:id/claim', async (req, res) => {
  const shiftId = parseInt(req.params.id);
  const staffId = req.user.id;
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Row-lock the candidate shift so concurrent claims serialise on it.
    const { rows: lock } = await client.query('SELECT * FROM rota_shifts WHERE id=$1 FOR UPDATE', [shiftId]);
    if (!lock.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'shift not found' }); }
    const sh = lock[0];
    if (!sh.is_open || sh.staff_id) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already_claimed' }); }
    const { rows: clash } = await client.query(
      'SELECT 1 FROM rota_shifts WHERE rota_week_id=$1 AND staff_id=$2 AND shift_date=$3',
      [sh.rota_week_id, staffId, ymd(sh.shift_date)]);
    if (clash.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already_scheduled_that_day' }); }
    const { rows: upd } = await client.query(
      `UPDATE rota_shifts
         SET staff_id=$1, is_open=false, acceptance='accepted', claimed_at=NOW(), responded_at=NOW(), source='claim'
       WHERE id=$2 AND is_open=true AND staff_id IS NULL
       RETURNING *`, [staffId, shiftId]);
    if (!upd.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'already_claimed' }); }
    await client.query('COMMIT');
    notifyManagers(db, 'rota_shift_claimed', 'Open shift claimed',
      `${req.user.name || 'A staff member'} claimed the ${ymd(sh.shift_date)} ${fmtT(sh.planned_start)}–${fmtT(sh.planned_end)} shift.`)
      .catch(e => console.error('notifyManagers:', e.message));
    res.json({ ok: true, shift: upd[0] });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('rota /claim error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── POST /api/rota/shift/:id/respond { accept:true|false } — accept/decline ───
router.post('/shift/:id/respond', async (req, res) => {
  try {
    const shiftId = parseInt(req.params.id);
    const accept = !!(req.body && req.body.accept);
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rota_shifts WHERE id=$1', [shiftId]);
    if (!rows.length) return res.status(404).json({ error: 'shift not found' });
    const sh = rows[0];
    const isManager = ['manager', 'deputy_manager', 'admin'].includes(req.user.role);
    if (sh.staff_id !== req.user.id && !isManager) return res.status(403).json({ error: 'not your shift' });
    const newState = accept ? 'accepted' : 'declined';
    const { rows: upd } = await db.query(
      `UPDATE rota_shifts SET acceptance=$1, responded_at=NOW() WHERE id=$2 RETURNING *`,
      [newState, shiftId]);
    if (!accept) {
      notifyManagers(db, 'rota_shift_declined', 'Shift declined',
        `${req.user.name || 'A staff member'} declined the ${ymd(sh.shift_date)} ${fmtT(sh.planned_start)}–${fmtT(sh.planned_end)} shift.`)
        .catch(e => console.error('notifyManagers:', e.message));
    }
    res.json({ ok: true, shift: upd[0] });
  } catch (err) {
    console.error('rota /respond error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Notification helpers ─────────────────────────────────────────────────────
async function notifyManagers(db, category, title, body) {
  const { rows } = await db.query(
    "SELECT id FROM staff WHERE (is_active=true OR is_active IS NULL) AND role IN ('manager','deputy_manager','admin')");
  for (const r of rows) notify(category, 'staff', r.id, title, body, { relatedTable: 'rota_shifts' });
}

async function notifyOpenShift(db, shift) {
  const dateStr = ymd(shift.shift_date);
  const { rows } = await db.query(
    `SELECT id FROM staff
     WHERE (is_active=true OR is_active IS NULL)
       AND role NOT IN ('manager','admin')
       AND ($1::int IS NULL OR room_id = $1 OR room_id IS NULL)
       AND id NOT IN (
         SELECT staff_id FROM rota_shifts
         WHERE rota_week_id=$2 AND staff_id IS NOT NULL AND shift_date=$3)`,
    [shift.room_id || null, shift.rota_week_id, dateStr]);
  const t = `${fmtT(shift.planned_start)}–${fmtT(shift.planned_end)}`;
  for (const r of rows) {
    notify('rota_open_shift', 'staff', r.id,
      `Open shift available — ${dateStr}`,
      `${t}${shift.label ? ' · ' + shift.label : ''}. First to claim gets it.`,
      { relatedTable: 'rota_shifts', relatedId: shift.id, link: '/my-shifts.html' });
  }
}

// Called from both publish handlers: flip accept/decline-enabled staff to 'pending'
// and push each rostered staff member a "your rota is published" notification.
async function afterPublish(db, weekId, ws) {
  const settings = await getRotaSettings(db);
  const adIds = (settings.accept_decline_staff || []).map(Number).filter(n => !isNaN(n));
  if (adIds.length) {
    await db.query(
      `UPDATE rota_shifts SET acceptance='pending'
       WHERE rota_week_id=$1 AND is_open=false AND COALESCE(is_absent,false)=false
         AND acceptance='not_required' AND staff_id = ANY($2::int[])`,
      [weekId, adIds]);
  }
  const { rows: staffShifts } = await db.query(
    `SELECT DISTINCT staff_id FROM rota_shifts
     WHERE rota_week_id=$1 AND staff_id IS NOT NULL AND COALESCE(is_absent,false)=false`, [weekId]);
  const label = new Date(ws + 'T00:00:00Z').toLocaleDateString('en-GB',
    { day: 'numeric', month: 'long', timeZone: 'UTC' });
  for (const r of staffShifts) {
    notify('rota_published', 'staff', r.staff_id,
      `Your rota is published — w/c ${label}`,
      'Tap to view your shifts for the week.',
      { relatedTable: 'rota_weeks', relatedId: weekId, link: '/my-shifts.html' });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PAYROLL EXPORT (2026-07-01) — weekly rota → per-staff hours (+ est. cost) as
// CSV and PDF for payroll. ADDITIVE. Manager-only + salary-view gated (hours are
// benign but cost is pay data; keep the whole export behind the same gate as
// /wage-summary for consistency). Maths mirrors /wage-summary exactly so totals
// reconcile. Non-absent, non-open, assigned shifts only.
// ════════════════════════════════════════════════════════════════════════════
async function computePayroll(db, weekStartDate) {
  const ws = toWeekStart(weekStartDate);
  const { rows: weekRows } = await db.query('SELECT id, name, status FROM rota_weeks WHERE week_start=$1', [ws]);
  const week = weekRows[0] || null;
  const dates = []; for (let i = 0; i < 7; i++) dates.push(addDaysStr(ws, i)); // Mon..Sun
  if (!week) return { week_start: ws, week_name: null, status: null, dates, staff: [], totals: { hours: 0, cost: 0 } };

  const { rows: shifts } = await db.query(
    `SELECT rs.shift_date, rs.planned_start, rs.planned_end, rs.break_mins,
            s.id AS staff_id, s.first_name, s.last_name, s.role, s.hourly_rate
     FROM rota_shifts rs JOIN staff s ON s.id = rs.staff_id
     WHERE rs.rota_week_id=$1 AND rs.is_absent=false AND COALESCE(rs.is_open,false)=false
     ORDER BY s.last_name, s.first_name, rs.shift_date`, [week.id]);

  const byStaff = {};
  let totHours = 0, totCost = 0;
  for (const s of shifts) {
    if (!s.planned_start || !s.planned_end) continue;
    const [sh, sm] = String(s.planned_start).split(':').map(Number);
    const [eh, em] = String(s.planned_end).split(':').map(Number);
    const mins = (eh * 60 + em) - (sh * 60 + sm) - (s.break_mins || 0);
    const hours = Math.max(0, mins / 60);
    const rate = parseFloat(s.hourly_rate);
    const cost = hours * (isFinite(rate) ? rate : 0);
    const d = s.shift_date.toISOString ? s.shift_date.toISOString().split('T')[0] : String(s.shift_date).slice(0, 10);
    const k = `${s.staff_id}`;
    if (!byStaff[k]) byStaff[k] = { staff_id: s.staff_id, name: `${s.first_name} ${s.last_name}`,
      role: s.role, hourly_rate: isFinite(rate) ? rate : null, per_day: {}, total_hours: 0, total_cost: 0 };
    byStaff[k].per_day[d] = (byStaff[k].per_day[d] || 0) + hours;
    byStaff[k].total_hours += hours;
    byStaff[k].total_cost += cost;
    totHours += hours; totCost += cost;
  }
  const r2 = n => Math.round(n * 100) / 100;
  const staff = Object.values(byStaff).map(x => {
    x.total_hours = r2(x.total_hours); x.total_cost = r2(x.total_cost);
    for (const d in x.per_day) x.per_day[d] = r2(x.per_day[d]);
    return x;
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { week_start: ws, week_name: week.name, status: week.status, dates, staff,
    totals: { hours: r2(totHours), cost: r2(totCost) } };
}

function dayLabel(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00Z');
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getUTCDay()] + ' ' + dateStr.slice(8) + '/' + dateStr.slice(5, 7);
}

// GET /api/rota/week/:date/payroll.csv — all 7 day columns so column-sum == total.
router.get('/week/:date/payroll.csv', managerOnly, requireSalaryView, async (req, res) => {
  try {
    const p = await computePayroll(getPool(), req.params.date);
    const esc = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [];
    lines.push(['Staff', 'Role', ...p.dates.map(dayLabel), 'Total hours', 'Hourly rate (£)', 'Est. cost (£)'].map(esc).join(','));
    for (const s of p.staff) {
      const dayCells = p.dates.map(d => (s.per_day[d] != null ? s.per_day[d] : ''));
      lines.push([s.name, s.role || '', ...dayCells, s.total_hours, s.hourly_rate != null ? s.hourly_rate : '', s.total_cost].map(esc).join(','));
    }
    const totalDayCells = p.dates.map(d => { let h = 0; for (const s of p.staff) h += (s.per_day[d] || 0); return h ? Math.round(h * 100) / 100 : ''; });
    lines.push(['TOTAL', '', ...totalDayCells, p.totals.hours, '', p.totals.cost].map(esc).join(','));
    res.set({ 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="payroll-${p.week_start}.csv"` });
    res.send('﻿' + lines.join('\r\n')); // BOM so Excel reads UTF-8
  } catch (e) { console.error('rota payroll.csv:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// GET /api/rota/week/:date/payroll.pdf — printable per-staff hours summary.
router.get('/week/:date/payroll.pdf', managerOnly, requireSalaryView, async (req, res) => {
  try {
    const p = await computePayroll(getPool(), req.params.date);
    const doc = new PDFDoc({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

    doc.fontSize(17).fillColor('#0f172a').text('Little Angels Day Nursery — Payroll');
    doc.moveDown(0.15).fontSize(10).fillColor('#475569')
      .text(`Week commencing ${p.week_start}${p.week_name ? ' · ' + p.week_name : ''}${p.status ? ' · ' + p.status : ''}   (generated ${new Date().toISOString().slice(0, 10)})`);
    doc.moveDown(0.6);

    // Weekday columns only (Mon–Fri) to keep the grid readable; Total column is authoritative.
    const cols = p.dates.slice(0, 5);
    const x0 = 40, wName = 150, wDay = 66, wTot = 62, wCost = 78;
    const header = ['Staff', ...cols.map(dayLabel), 'Total h', 'Est £'];
    const widths = [wName, ...cols.map(() => wDay), wTot, wCost];
    let y = doc.y;
    const drawRow = (cells, opts = {}) => {
      let x = x0;
      doc.fontSize(opts.head ? 8.5 : 9).fillColor(opts.head ? '#334155' : (opts.total ? '#0f172a' : '#1e293b'));
      if (opts.head) doc.font('Helvetica-Bold'); else if (opts.total) doc.font('Helvetica-Bold'); else doc.font('Helvetica');
      cells.forEach((c, i) => {
        const align = i === 0 ? 'left' : 'right';
        doc.text(String(c == null ? '' : c), x + 3, y + 3, { width: widths[i] - 6, align });
        x += widths[i];
      });
      y += 18;
      doc.moveTo(x0, y).lineTo(x0 + widths.reduce((a, b) => a + b, 0), y).strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    };
    drawRow(header, { head: true });
    for (const s of p.staff) {
      if (y > 520) { doc.addPage({ layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } }); y = 40; drawRow(header, { head: true }); }
      const dayCells = cols.map(d => (s.per_day[d] != null ? s.per_day[d].toFixed(2) : '—'));
      drawRow([s.name, ...dayCells, s.total_hours.toFixed(2), s.hourly_rate != null ? '£' + s.total_cost.toFixed(2) : '—']);
    }
    const totalDayCells = cols.map(d => { let h = 0; for (const s of p.staff) h += (s.per_day[d] || 0); return h ? h.toFixed(2) : '—'; });
    drawRow(['TOTAL', ...totalDayCells, p.totals.hours.toFixed(2), '£' + p.totals.cost.toFixed(2)], { total: true });

    doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
      .text('Hours = planned end − start − break, non-absent assigned shifts. Est £ uses each staff hourly rate; blank where no rate is set. Weekday columns shown; Total column includes any weekend shifts.', x0, y + 10, { width: widths.reduce((a, b) => a + b, 0) });

    doc.end();
    const buf = await done;
    res.set({ 'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="payroll-${p.week_start}.pdf"`, 'Content-Length': buf.length });
    res.send(buf);
  } catch (e) { console.error('rota payroll.pdf:', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// GET /api/rota/events?week=YYYY-MM-DD — read events (including planner_events if present)
router.get('/events', async (req, res) => {
  try {
    const weekParam = req.query.week;
    if (!weekParam || !/^\d{4}-\d{2}-\d{2}$/.test(weekParam)) {
      return res.status(400).json({ error: 'week query param required (YYYY-MM-DD)' });
    }
    const ws = toWeekStart(weekParam);
    const db = getPool();
    const { rows: evRows } = await db.query(
      `SELECT id, date, title, kind, starts_at, ends_at, room, notes, source, source_ref, created_by, created_at
       FROM rota_events WHERE date >= $1 AND date <= $2`,
      [ws, new Date(new Date(ws).setDate(new Date(ws).getDate() + 6)).toISOString().split('T')[0]]
    );
    let combined = evRows;
    // Attempt to include planner_events if table exists
    try {
      const { rows: plRows } = await db.query(
        `SELECT id, date, title, kind, starts_at, ends_at, room, notes, 'planner' AS source, source_ref, created_by, created_at
         FROM planner_events WHERE date >= $1 AND date <= $2`,
        [ws, new Date(new Date(ws).setDate(new Date(ws).getDate() + 6)).toISOString().split('T')[0]]
      );
      combined = combined.concat(plRows);
    } catch (e) {
      // ignore if planner_events missing
    }
    res.json(combined);
  } catch (err) {
    console.error('rota /events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/rota/events — create event (manager only)
router.post('/events', managerOnly, async (req, res) => {
  try {
    const { date, title, kind, starts_at, ends_at, room, notes, source_ref } = req.body;
    if (!date || !title) return res.status(400).json({ error: 'date and title required' });
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO rota_events (date, title, kind, starts_at, ends_at, room, notes, source, source_ref, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'manual',$8,$9) RETURNING *`,
      [date, title, kind||'event', starts_at||null, ends_at||null, room||null, notes||null, source_ref||null, req.user.id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('rota POST /events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/rota/events/:id — delete event (manager only)
router.delete('/events/:id', managerOnly, async (req, res) => {
  try {
    const evId = parseInt(req.params.id);
    const db = getPool();
    await db.query('DELETE FROM rota_events WHERE id=$1', [evId]);
    res.json({ ok: true });
  } catch (err) {
    console.error('rota DELETE /events error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/rota/events/suggest-meetings?from=YYYY-MM-DD — staff meeting suggestions (manager only)
router.get('/events/suggest-meetings', managerOnly, async (req, res) => {
  try {
    const from = req.query.from;
    if (!from || !/^\d{4}-\d{2}-\d{2}$/.test(from)) {
      return res.status(400).json({ error: 'from query param required (YYYY-MM-DD)' });
    }
    const startDate = new Date(from + 'T00:00:00Z');
    const weeks = 8; // next ~8 weeks
    const suggestions = [];
    const db = getPool();
    // Helper to count events per day
    const dayCounts = {};
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + weeks * 7);
    const rows = await db.query(
      `SELECT date, COUNT(*) AS cnt FROM rota_events WHERE date >= $1 AND date <= $2 GROUP BY date`,
      [from, endDate.toISOString().split('T')[0]]
    );
    // pg returns date columns as Date objects — normalise to the same YYYY-MM-DD
    // string used for lookups below, or every key misses and existing_events is 0.
    rows.rows.forEach(r => { dayCounts[new Date(r.date).toISOString().split('T')[0]] = parseInt(r.cnt); });
    // Generate candidate dates per room
    const roomsRes = await db.query('SELECT id, name FROM rooms ORDER BY id');
    const rooms = roomsRes.rows;
    for (let i = 0; i < weeks; i++) {
      const weekStart = new Date(startDate);
      weekStart.setDate(startDate.getDate() + i * 7);
      const babyDate = new Date(weekStart);
      babyDate.setDate(weekStart.getDate() + 2); // Wednesday (0=Sun)
      const preDate = new Date(weekStart);
      preDate.setDate(weekStart.getDate() + 3); // Thursday
      const candidates = [
        { room: 'baby', date: babyDate },
        { room: 'preschool', date: preDate }
      ];
      for (const cand of candidates) {
        const roomObj = rooms.find(r => r.name.toLowerCase().includes(cand.room));
        if (!roomObj) continue;
        const dStr = cand.date.toISOString().split('T')[0];
        const existing = dayCounts[dStr] || 0;
        const tobyAttends = (i % 2 === 0); // every other week Toby attends
        suggestions.push({ date: dStr, room: roomObj.name, kind: 'staff_meeting', toby_attends: tobyAttends, existing_events: existing });
      }
    }
    // Sort by fewest existing events, then earliest date
    suggestions.sort((a, b) => a.existing_events - b.existing_events || a.date.localeCompare(b.date));
    res.json(suggestions.slice(0, 10)); // return top 10 suggestions
  } catch (err) {
    console.error('rota /events/suggest-meetings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
