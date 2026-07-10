'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!['manager', 'room_leader'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// In-memory cache for today + future (5-min TTL)
const memCache = new Map(); // dateStr → { payload, cachedAt }
const MEM_TTL_MS = 5 * 60 * 1000;

function parseDateParam(raw) {
  if (!raw) return new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const d = new Date(raw + 'T12:00:00Z');
  if (isNaN(d)) return null;
  return raw;
}

function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z').getDay(); // 0=Sun, 6=Sat
  return d !== 0 && d !== 6;
}

async function getTermDates(db) {
  try {
    const { rows } = await db.query(
      "SELECT value FROM wren_settings WHERE key='term_dates_2025_2026'"
    );
    return rows[0]?.value || null;
  } catch { return null; }
}

function checkTermTime(dateStr, termDates) {
  if (!termDates) return null; // unknown
  return termDates.some(t => dateStr >= t.start && dateStr <= t.end);
}

// ── Hourly slot helpers ────────────────────────────────────────────────────

// 20 half-hour slots 08:00–17:30 (representing the period 08:00–18:00)
const HOUR_SLOTS = [];
for (let h = 8; h < 18; h++) {
  HOUR_SLOTS.push(`${String(h).padStart(2, '0')}:00`);
  HOUR_SLOTS.push(`${String(h).padStart(2, '0')}:30`);
}

// Convert 'HH:MM' or 'HH:MM:SS' to minutes since midnight
function toMins(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// Returns true if slotHHMM falls within [plannedStart, plannedEnd)
// If either time is null/missing, assumes full-day (returns true)
function slotInShift(slotHHMM, plannedStart, plannedEnd) {
  if (!plannedStart || !plannedEnd) return true;
  const slot = toMins(slotHHMM);
  return slot >= toMins(plannedStart) && slot < toMins(plannedEnd);
}

// Build per-room hourly breakdown and tightest_hour
// Returns { tightest_hour, data_confidence, slots }
function buildRoomHourly(roomStaff, absentStaffIds, expectedChildren, maxPerStaff, showChildren) {
  const presentStaff = roomStaff.filter(rs => !absentStaffIds.has(rs.staff_id));
  const staffWithTimes = presentStaff.filter(rs => rs.planned_start && rs.planned_end);

  // Rota exists for room but has no time precision → can't identify tightest hour
  if (presentStaff.length > 0 && staffWithTimes.length === 0) {
    return { tightest_hour: null, data_confidence: 'low', slots: null };
  }

  const slots = HOUR_SLOTS.map(slotTime => {
    const staffPresent = presentStaff.filter(rs =>
      slotInShift(slotTime, rs.planned_start, rs.planned_end)
    ).length;

    // Children: no session-time data in DB, default to full-day attendance
    const childrenPresent = showChildren ? expectedChildren : 0;

    const requiredStaff = childrenPresent > 0 ? Math.ceil(childrenPresent / maxPerStaff) : 0;
    const compliant = childrenPresent === 0 || staffPresent >= requiredStaff;
    const ratio = staffPresent > 0
      ? `1:${(childrenPresent / staffPresent).toFixed(1)}`
      : childrenPresent > 0 ? 'no staff' : '–';

    return { time: slotTime, staff: staffPresent, children: childrenPresent, ratio, compliant };
  });

  // Find worst slot: non-compliant slots rank above compliant; within each group, highest ratio wins
  let worst = null;
  let worstScore = -Infinity;
  for (const slot of slots) {
    if (slot.children === 0) continue;
    const required = Math.ceil(slot.children / maxPerStaff);
    const ratioVal = slot.staff > 0 ? slot.children / slot.staff : slot.children * 1000;
    // Non-compliant scored far higher than compliant
    const score = !slot.compliant
      ? 1e6 + (required - slot.staff) * 1e3 + ratioVal
      : ratioVal;
    if (score > worstScore) { worstScore = score; worst = slot; }
  }

  const tightest_hour = worst ? {
    slot: worst.time,
    staff_present: worst.staff,
    children_present: worst.children,
    compliant: worst.compliant,
    concern: !worst.compliant
      ? `Below 1:${maxPerStaff} ratio at ${worst.time} (${worst.staff} staff vs ${worst.children} children)`
      : null
  } : null;

  // medium: staff shift times known, children are full-day estimate (no session times in DB)
  // low: no rota for this room (0 staff scheduled — all slots are 0)
  const data_confidence = staffWithTimes.length > 0 ? 'medium' : 'low';

  return { tightest_hour, data_confidence, slots };
}

async function computeForecast(db, dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  const isPast = dateStr < today;
  const weekday = isWeekday(dateStr);

  const termDates = await getTermDates(db);
  const isTermTime = checkTermTime(dateStr, termDates);

  // Rooms
  const { rows: rooms } = await db.query(
    'SELECT id, name, display_name, capacity, min_age_months, max_age_months FROM rooms ORDER BY id'
  );

  // Active children whose enrollment covers this date
  const { rows: allChildren } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.room_id, c.date_of_birth
    FROM children c
    WHERE c.is_active = true
      AND (c.start_date IS NULL OR c.start_date <= $1::date)
      AND (c.leave_date IS NULL OR c.leave_date > $1::date)
    ORDER BY c.room_id, c.first_name
  `, [dateStr]);

  // Staff scheduled in rota for this date
  const { rows: rotaStaff } = await db.query(`
    SELECT rs.staff_id, rs.room_id, rs.planned_start::text, rs.planned_end::text,
           s.first_name, s.last_name, s.role
    FROM rota_shifts rs
    JOIN staff s ON s.id = rs.staff_id
    WHERE rs.shift_date = $1::date
  `, [dateStr]);

  // Approved/confirmed absences covering this date
  const { rows: absences } = await db.query(`
    SELECT ar.staff_id, ar.absence_type, ar.status,
           s.first_name, s.last_name
    FROM absence_requests ar
    JOIN staff s ON s.id = ar.staff_id
    WHERE ar.start_date <= $1::date
      AND ar.end_date >= $1::date
      AND ar.status IN ('approved', 'confirmed', 'pending')
  `, [dateStr]);

  // Past date: check for actual attendance records
  let hasAttendance = false;
  if (isPast) {
    const { rows: ac } = await db.query(
      'SELECT COUNT(*) AS cnt FROM attendance WHERE date = $1::date', [dateStr]
    );
    hasAttendance = parseInt(ac[0].cnt) > 0;
  }

  // Data confidence (overall)
  let dataConfidence;
  if (isPast && hasAttendance) {
    dataConfidence = 'high';
  } else if (rotaStaff.length > 0) {
    dataConfidence = 'medium';
  } else {
    dataConfidence = 'low';
  }

  const absentStaffIds = new Set(absences.map(a => a.staff_id));
  const targetDate = new Date(dateStr + 'T12:00:00Z');

  // Children shown only on weekdays during term time (or if term unknown, show on weekdays)
  const showChildren = weekday && (isTermTime !== false);

  // Build by-room children summary
  const byRoom = rooms.map(room => {
    const roomChildren = allChildren.filter(c => c.room_id === room.id);
    const expectedCount = showChildren ? roomChildren.length : 0;

    return {
      room: room.name,
      capacity: room.capacity,
      expected: expectedCount,
      headroom: Math.max(0, room.capacity - expectedCount),
      expected_children: roomChildren.map(c => ({
        id: c.id,
        name: `${c.first_name} ${c.last_name.charAt(0)}.`,
        session: 'full_day' // no per-child session schedule in DB — defaulting
      }))
    };
  });

  const totalExpected = byRoom.reduce((s, r) => s + r.expected, 0);

  // Staff sections
  const scheduledStaff = rotaStaff
    .filter(rs => !absentStaffIds.has(rs.staff_id))
    .map(rs => ({
      id: rs.staff_id,
      name: `${rs.first_name} ${rs.last_name}`,
      role: rs.role,
      room: rooms.find(r => r.id === rs.room_id)?.name || 'Unassigned'
    }));

  const absentList = absences.map(a => ({
    id: a.staff_id,
    name: `${a.first_name} ${a.last_name}`,
    type: a.absence_type
  }));

  // Ratios + hourly breakdown per room
  const ratiosByRoom = rooms.map(room => {
    const roomData = byRoom.find(r => r.room === room.name);
    const expectedChildren = roomData?.expected || 0;

    let ratio, maxPerStaff;
    if (room.min_age_months < 24) {
      // Baby Room / under-2s: statutory 1:3
      ratio = '1:3';
      maxPerStaff = 3;
    } else {
      // Pre-school: 1:4 if any child is under 3yo (36 months), else 1:8
      const hasTwoYearOlds = allChildren.some(c => {
        if (c.room_id !== room.id) return false;
        const ageMonths = (targetDate - new Date(c.date_of_birth)) / (1000 * 60 * 60 * 24 * 30.44);
        return ageMonths < 36;
      });
      ratio = hasTwoYearOlds ? '1:4' : '1:8';
      maxPerStaff = hasTwoYearOlds ? 4 : 8;
    }

    const requiredMinStaff = expectedChildren > 0 ? Math.ceil(expectedChildren / maxPerStaff) : 0;
    const scheduledForRoom = rotaStaff.filter(rs =>
      !absentStaffIds.has(rs.staff_id) && rs.room_id === room.id
    ).length;

    const roomStaff = rotaStaff.filter(rs => rs.room_id === room.id);
    const hourly = buildRoomHourly(roomStaff, absentStaffIds, expectedChildren, maxPerStaff, showChildren);

    return {
      room: room.name,
      required_ratio: ratio,
      required_min_staff: Math.max(requiredMinStaff, expectedChildren > 0 ? 1 : 0),
      scheduled_staff: scheduledForRoom,
      expected_children: expectedChildren,
      compliant: expectedChildren === 0 ? true : scheduledForRoom >= requiredMinStaff,
      tightest_hour: hourly.tightest_hour,
      data_confidence: hourly.data_confidence,
      slots: hourly.slots // stripped from response if ?hourly not requested
    };
  });

  const siteCompliant = ratiosByRoom.every(r => r.compliant);

  return {
    date: dateStr,
    is_weekday: weekday,
    is_term_time: isTermTime,
    is_closed: !weekday,
    data_confidence: dataConfidence,
    children: {
      expected_count: totalExpected,
      by_room: byRoom
    },
    staff: {
      scheduled_count: scheduledStaff.length,
      scheduled: scheduledStaff,
      absent: absentList
    },
    ratios: {
      by_room: ratiosByRoom,
      site_compliant: siteCompliant
    }
  };
}

// GET /api/state/forecast?date=YYYY-MM-DD[&hourly=true]
router.get('/forecast', managerOnly, async (req, res) => {
  const dateStr = parseDateParam(req.query.date);
  if (!dateStr) return res.status(400).json({ error: 'Invalid date format, use YYYY-MM-DD' });

  const includeSlots = req.query.hourly === 'true';
  const today = new Date().toISOString().slice(0, 10);
  const isPast = dateStr < today;
  const db = getPool();

  try {
    let payload;

    // Past dates: check DB cache first (data is settled)
    if (isPast) {
      const { rows } = await db.query(
        'SELECT payload FROM state_forecast_cache WHERE forecast_date = $1', [dateStr]
      );
      if (rows.length && rows[0].payload.ratios?.by_room?.[0]?.tightest_hour !== undefined) {
        // Cache entry has the new tightest_hour field — use it
        payload = rows[0].payload;
      }
    } else {
      // Today / future: check in-memory 5-min cache
      const cached = memCache.get(dateStr);
      if (cached && (Date.now() - cached.cachedAt) < MEM_TTL_MS) {
        payload = cached.payload;
      }
    }

    if (!payload) {
      payload = await computeForecast(db, dateStr);

      if (isPast) {
        await db.query(
          `INSERT INTO state_forecast_cache (forecast_date, computed_at, payload)
           VALUES ($1, NOW(), $2)
           ON CONFLICT (forecast_date) DO UPDATE SET payload=$2, computed_at=NOW()`,
          [dateStr, payload]
        );
      } else {
        memCache.set(dateStr, { payload, cachedAt: Date.now() });
        if (memCache.size > 50) {
          const cutoff = Date.now() - MEM_TTL_MS;
          for (const [k, v] of memCache) {
            if (v.cachedAt < cutoff) memCache.delete(k);
          }
        }
      }
    }

    // Strip slots unless explicitly requested
    if (!includeSlots) {
      const stripped = {
        ...payload,
        ratios: {
          ...payload.ratios,
          by_room: payload.ratios.by_room.map(({ slots, ...rest }) => rest)
        }
      };
      return res.json(stripped);
    }

    res.json(payload);
  } catch (err) {
    console.error('[state-forecast]', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
