const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// Public endpoint — PIN-validated kiosk (no JWT)
router.post('/staff/kiosk-action', async (req, res) => {
  const { staff_id, pin, action } = req.body;
  if (!staff_id || !pin || !action) return res.status(400).json({ error: 'staff_id, pin, action required' });
  try {
    const db = getPool();
    const bcrypt = require('bcrypt');
    const { rows: staffRows } = await db.query(
      'SELECT id, first_name, pin_hash FROM staff WHERE id=$1 AND is_active=true', [staff_id]
    );
    if (!staffRows.length) return res.status(404).json({ error: 'Staff not found' });
    const staff = staffRows[0];
    const pinMatch = staff.pin_hash ? await bcrypt.compare(String(pin), staff.pin_hash) : String(pin) === '1234';
    if (!pinMatch) return res.status(401).json({ error: 'Invalid PIN' });

    let result;
    if (action === 'clock_in') {
      const dow = new Date().getDay();
      const { rows: sched } = await db.query(
        'SELECT start_time, end_time FROM timetable WHERE staff_id=$1 AND day_of_week=$2 LIMIT 1', [staff_id, dow]
      );
      const { rows } = await db.query(`
        INSERT INTO staff_attendance (staff_id, date, clock_in, source, scheduled_start, scheduled_end)
        VALUES ($1, CURRENT_DATE, NOW(), 'kiosk', $2, $3)
        ON CONFLICT (staff_id, date) DO UPDATE SET clock_in=NOW(), source='kiosk'
        RETURNING *
      `, [staff_id, sched[0]?.start_time || null, sched[0]?.end_time || null]);
      result = rows[0];
    } else if (action === 'clock_out') {
      const { rows: ex } = await db.query('SELECT clock_in FROM staff_attendance WHERE staff_id=$1 AND date=CURRENT_DATE', [staff_id]);
      let hw = null;
      if (ex[0]?.clock_in) hw = Math.round((Date.now() - new Date(ex[0].clock_in).getTime()) / 36000) / 100;
      const { rows } = await db.query(
        'UPDATE staff_attendance SET clock_out=NOW(), hours_worked=$2 WHERE staff_id=$1 AND date=CURRENT_DATE RETURNING *',
        [staff_id, hw]
      );
      result = rows[0];
    } else if (action === 'break_start') {
      const { rows } = await db.query('UPDATE staff_attendance SET break_start=NOW() WHERE staff_id=$1 AND date=CURRENT_DATE RETURNING *', [staff_id]);
      result = rows[0];
    } else if (action === 'break_end') {
      const { rows } = await db.query('UPDATE staff_attendance SET break_end=NOW() WHERE staff_id=$1 AND date=CURRENT_DATE RETURNING *', [staff_id]);
      result = rows[0];
    }
    res.json({ ok: true, staff_name: staff.first_name, result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Public endpoint — all staff clock status (for kiosk display)
router.get('/staff/today', async (req, res) => {
  // Allow without JWT for kiosk
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.role, s.room_id, r.name as room_name,
        sa.clock_in, sa.clock_out, sa.break_start, sa.break_end,
        sa.scheduled_start, sa.scheduled_end, sa.hours_worked
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      LEFT JOIN staff_attendance sa ON sa.staff_id = s.id AND sa.date = CURRENT_DATE
      WHERE s.is_active = true
      ORDER BY r.name, s.first_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.use(authenticate);

// GET /today — all children with today's attendance
router.get('/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.room_id, c.allergies,
             r.name as room_name,
             a.id as attendance_id, a.sign_in_time, a.sign_out_time,
             a.absent, a.absence_reason, a.session
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN attendance a ON a.child_id=c.id AND a.date=CURRENT_DATE
      WHERE c.is_active=true
      ORDER BY r.name, c.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /sign-in
router.post('/sign-in', async (req, res) => {
  const { child_id, session } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO attendance (child_id, date, session, sign_in_time, signed_in_by)
      VALUES ($1, CURRENT_DATE, $2, NOW(), $3)
      ON CONFLICT (child_id, date, session)
      DO UPDATE SET sign_in_time=NOW(), signed_in_by=$3, absent=false
      RETURNING *
    `, [child_id, session || 'full_day', req.user.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /sign-out
router.post('/sign-out', async (req, res) => {
  const { child_id, session } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO attendance (child_id, date, session, sign_out_time, signed_out_by)
      VALUES ($1, CURRENT_DATE, $2, NOW(), $3)
      ON CONFLICT (child_id, date, session)
      DO UPDATE SET sign_out_time=NOW(), signed_out_by=$3
      RETURNING *
    `, [child_id, session || 'full_day', req.user.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /mark-absent
router.post('/mark-absent', async (req, res) => {
  const { child_id, absence_reason, session } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO attendance (child_id, date, session, absent, absence_reason)
      VALUES ($1, CURRENT_DATE, $2, true, $3)
      ON CONFLICT (child_id, date, session)
      DO UPDATE SET absent=true, absence_reason=$3
      RETURNING *
    `, [child_id, session || 'full_day', absence_reason || null]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId — history
router.get('/child/:childId', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT * FROM attendance
      WHERE child_id=$1 AND date >= CURRENT_DATE - INTERVAL '${days} days'
      ORDER BY date DESC
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /staff/clock-in — auto clock-in on login
router.post('/staff/clock-in', async (req, res) => {
  const staffId = req.body.staff_id || req.user.id;
  const source = req.body.source || 'portal_login';
  try {
    const db = getPool();
    // Look up scheduled start from timetable
    const dow = new Date().getDay(); // 0=Sun
    const { rows: sched } = await db.query(
      'SELECT start_time, end_time FROM timetable WHERE staff_id=$1 AND day_of_week=$2 LIMIT 1',
      [staffId, dow]
    );
    const schedStart = sched[0]?.start_time || null;
    const schedEnd = sched[0]?.end_time || null;

    const { rows } = await db.query(`
      INSERT INTO staff_attendance (staff_id, date, clock_in, source, scheduled_start, scheduled_end)
      VALUES ($1, CURRENT_DATE, NOW(), $2, $3, $4)
      ON CONFLICT (staff_id, date) DO NOTHING
      RETURNING *
    `, [staffId, source, schedStart, schedEnd]);
    res.json(rows[0] || { skipped: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /staff/clock-out
router.post('/staff/clock-out', async (req, res) => {
  const staffId = req.body.staff_id || req.user.id;
  try {
    const db = getPool();
    const { rows: existing } = await db.query(
      'SELECT clock_in FROM staff_attendance WHERE staff_id=$1 AND date=CURRENT_DATE', [staffId]
    );
    const clockIn = existing[0]?.clock_in;
    let hoursWorked = null;
    if (clockIn) {
      const diffMs = Date.now() - new Date(clockIn).getTime();
      hoursWorked = Math.round((diffMs / 3600000) * 100) / 100;
    }
    const { rows } = await db.query(`
      UPDATE staff_attendance SET clock_out=NOW(), hours_worked=$2
      WHERE staff_id=$1 AND date=CURRENT_DATE
      RETURNING *
    `, [staffId, hoursWorked]);
    res.json(rows[0] || { skipped: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /staff/break-start
router.post('/staff/break-start', async (req, res) => {
  const staffId = req.body.staff_id || req.user.id;
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE staff_attendance SET break_start=NOW() WHERE staff_id=$1 AND date=CURRENT_DATE RETURNING *',
      [staffId]
    );
    res.json(rows[0] || { skipped: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /staff/break-end
router.post('/staff/break-end', async (req, res) => {
  const staffId = req.body.staff_id || req.user.id;
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE staff_attendance SET break_end=NOW() WHERE staff_id=$1 AND date=CURRENT_DATE RETURNING *',
      [staffId]
    );
    res.json(rows[0] || { skipped: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /staff/:id — history for a staff member
// GET /summary — attendance summary for admin dashboard
// Uses attendance_pct column on children (primary) or attendance table (EYFS)
router.get('/summary', authenticate, async (req, res) => {
  try {
    const db = getPool();
    // Primary: use attendance_pct on children
    const { rows: childRows } = await db.query(
      `SELECT id, first_name, last_name, year_group, attendance_pct, is_active FROM children WHERE is_active=true`
    ).catch(() => ({ rows: [] }));

    if (childRows.length) {
      const withPct = childRows.filter(c => c.attendance_pct != null);
      const avg = withPct.length ? (withPct.reduce((s,c) => s + parseFloat(c.attendance_pct||0), 0) / withPct.length).toFixed(1) : null;
      const paCount = withPct.filter(c => parseFloat(c.attendance_pct) < 90).length;
      const paPct = withPct.length ? ((paCount / childRows.length) * 100).toFixed(1) : '0.0';

      // Breakdown by year group
      const byYear = {};
      for (const c of withPct) {
        const yr = c.year_group || 'Unknown';
        if (!byYear[yr]) byYear[yr] = { sum: 0, count: 0 };
        byYear[yr].sum += parseFloat(c.attendance_pct);
        byYear[yr].count++;
      }
      const byYearArr = Object.entries(byYear).map(([yr, v]) => ({
        year_group: yr, avg_pct: (v.sum / v.count).toFixed(1), count: v.count
      })).sort((a,b) => a.year_group > b.year_group ? 1 : -1);

      const paList = childRows
        .filter(c => c.attendance_pct != null && parseFloat(c.attendance_pct) < 90)
        .map(c => ({ id: c.id, name: c.first_name+' '+c.last_name, attendance_pct: c.attendance_pct, year_group: c.year_group }));

      return res.json({
        overall_pct: avg, weekly_pct: avg,
        pa_pct: paPct, pa_count: paCount,
        by_year: byYearArr, pa_pupils: paList
      });
    }

    // EYFS fallback: count today's sign-ins
    const today = new Date().toISOString().slice(0,10);
    const { rows } = await db.query(
      `SELECT COUNT(*) as present, COUNT(DISTINCT child_id) as total
       FROM attendance WHERE date=$1 AND absent=false`, [today]
    ).catch(() => ({ rows: [{ present: 0, total: 0 }] }));
    res.json({ overall_pct: null, weekly_pct: null, pa_pct: '0', ...rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/staff/:id', async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT * FROM staff_attendance
      WHERE staff_id=$1
      ORDER BY date DESC LIMIT $2
    `, [req.params.id, days]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
