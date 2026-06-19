const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const nodemailer = require('nodemailer');

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

    // Delete and re-insert all shifts for clean state
    await db.query('DELETE FROM rota_shifts WHERE rota_week_id = $1', [weekId]);

    for (const s of shifts) {
      if (!s.staff_id || !s.shift_date) continue;
      await db.query(`
        INSERT INTO rota_shifts
          (rota_week_id, staff_id, shift_date, planned_start, planned_end, room_id, break_mins, notes)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [
        weekId, s.staff_id, s.shift_date,
        s.planned_start || null,
        s.planned_end || null,
        s.room_id || null,
        s.break_mins != null ? s.break_mins : 30,
        s.notes || null
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
      'UPDATE rota_weeks SET published_at = NOW(), published_by = $1 WHERE id = $2',
      [req.user.id, week.id]
    );

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
            from: process.env.SMTP_FROM || 'Your Nursery <admissions@example.com>',
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

    const { rows } = await db.query(`
      SELECT rs.shift_date, rs.planned_start, rs.planned_end,
             rs.break_mins, rs.notes, r.name AS room_name,
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
      <span style="color:#4a9abf">Your Nursery</span>
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
      <a href="https://hr.example.com/my-shifts.html"
         style="display:inline-block;background:#4a9abf;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px">
        View My Shifts Online
      </a>
    </div>
  </td></tr>
  <tr><td style="background:#f8fafc;padding:20px 32px;border-top:1px solid #e5e7eb;text-align:center">
    <div style="font-size:12px;color:#9ca3af;line-height:1.6">
      Your Nursery | 123 Example Lane, Your Town, AB1 2CD<br>
      Office: 01234 567890 | admissions@example.com<br>
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
            from: process.env.SMTP_FROM || 'Your Nursery <admissions@example.com>',
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
      'PRODID:-//Your Nursery//Wren Rota//EN',
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
        `UID:wren-rota-${staffId}-${dtStamp}@example.com`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:.]/g,'').substring(0,15)}Z`,
        `DTSTART;TZID=Europe/London:${dtStamp}T${startHH}00`,
        `DTEND;TZID=Europe/London:${dtStamp}T${endHH}00`,
        `SUMMARY:Shift${roomNote}`,
        `DESCRIPTION:Your Nursery\\nRoom: ${s.room_name || 'Any'}\\nBreak: ${s.break_mins || 30} mins`,
        `LOCATION:123 Example Lane\\, Ealing\\, W13 9LU`,
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
router.get('/week/:date/wage-summary', managerOnly, async (req, res) => {
  try {
    const ws = toWeekStart(req.params.date);
    const db = getPool();

    const { rows: weekRows } = await db.query('SELECT id FROM rota_weeks WHERE week_start=$1', [ws]);
    if (!weekRows.length) return res.json({ total: 0, by_day: {}, by_staff: {} });
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

    for (const s of shifts) {
      if (!s.planned_start || !s.planned_end || !s.hourly_rate) continue;
      const [sh, sm] = String(s.planned_start).split(':').map(Number);
      const [eh, em] = String(s.planned_end).split(':').map(Number);
      const mins = (eh * 60 + em) - (sh * 60 + sm) - (s.break_mins || 0);
      const hours = Math.max(0, mins / 60);
      const cost = hours * parseFloat(s.hourly_rate);

      const d = s.shift_date.toISOString ? s.shift_date.toISOString().split('T')[0] : s.shift_date;
      byDay[d] = (byDay[d] || 0) + cost;

      const key = `${s.staff_id}`;
      if (!byStaff[key]) byStaff[key] = { name: `${s.first_name} ${s.last_name}`, hourly_rate: s.hourly_rate, total: 0 };
      byStaff[key].total += cost;
      total += cost;
    }

    res.json({ total: Math.round(total * 100) / 100, by_day: byDay, by_staff: byStaff });
  } catch (err) {
    console.error('rota /wage-summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
