'use strict';
/**
 * offratio.js — b189 (2026-08-19): per-slot ratio checking and off-ratio accountability.
 *
 * TWO JOBS:
 *   1. ratioCheck(db, date)  — per room, per 30-minute slot across 08:00-18:00:
 *      children booked, staff rostered (excluding anyone who does not count on
 *      ratio), staff required by the CONFIGURED ratios, and under|exact|over.
 *   2. computeSurplus / logSurplusDay — turn (1) into "surplus staffed minutes" per
 *      room-day and, above a threshold, raise an accountability entry for the room
 *      leader to answer in words.
 *
 * WHY OFF-RATIO ACCOUNTABILITY IS NOT A TELLING-OFF: being over ratio is usually
 * deliberate and good — settling a new child, SEND support, planning, supervision,
 * deep-cleaning, a student on top of the count. The problem the setting had was that
 * this time was INVISIBLE: nobody could answer "what did we do with the extra hands
 * on Monday?" and nobody could answer "I had no off-ratio time" with data either.
 * This makes the number visible and asks for a sentence about it. That is all.
 *
 * ARITHMETIC — deliberately conservative, and the reasons matter:
 *   * Surplus is summed PER SLOT as max(0, staff - required) x 30 minutes. It is NOT
 *     netted against under-ratio slots: a room that is one short at 08:00 and two
 *     over at 15:00 has BOTH a ratio problem and surplus time, and netting them to
 *     zero would hide both.
 *   * Breaks are not modelled per slot. rota_shifts records break_mins but never WHEN
 *     the break falls, so pretending to know would be invention. Every response
 *     carries breaks_modelled: false and the room-day's total break minutes, so the
 *     figure can be read with that in mind.
 *   * Children's presence uses actual sign-in/sign-out times WHERE THEY EXIST, and
 *     otherwise assumes a booked child is present for the whole window. The count of
 *     each is returned per slot (from_actual / from_booking) rather than hidden.
 *
 * DATA-QUALITY GUARD (this is the important one): the booked register child_bookings
 * is the authoritative "who is expected in". On prod it currently covers only some of
 * the active children. If the register does not cover a room properly, EVERY room
 * looks overstaffed and this engine would manufacture accountability demands out of a
 * data gap. So logSurplusDay() refuses to write a row when booking coverage for the
 * room is below `offratio_min_booking_coverage` (default 0.8) and says so.
 */

const ratioEngine = require('../services/ratio-engine');
const closures = require('./closures');   // b194 — bank holidays + settings.closure_dates

const SLOT_MINUTES = 30;
const DAY_START_MIN = 8 * 60;    // 08:00
const DAY_END_MIN   = 18 * 60;   // 18:00

const DEFAULT_MIN_SURPLUS_MINUTES  = 60;    // an hour of a whole extra pair of hands
const DEFAULT_MIN_BOOKING_COVERAGE = 0.8;

// One definition of ratio eligibility, shared with the absence gatekeeper.
const { countsOnRatio, ratioLevelOf } = require('./ratio-eligibility');

function toMin(t) {
  if (t == null) return null;
  const s = String(t).substring(0, 5);
  if (!/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
function fmt(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
/** "9h 00m" — how the figure is shown to the room leader. */
function humanMinutes(mins) {
  const m = Math.max(0, Math.round(mins || 0));
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
function ymd(d) {
  if (!d) return null;
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

/** Slot boundaries across the configured day window. 08:00-18:00 / 30m = 20 slots. */
function slots() {
  const out = [];
  for (let m = DAY_START_MIN; m < DAY_END_MIN; m += SLOT_MINUTES) {
    out.push({ start_min: m, end_min: m + SLOT_MINUTES, start: fmt(m), end: fmt(m + SLOT_MINUTES) });
  }
  return out;
}

async function getSetting(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (rows.length && rows[0].value != null && rows[0].value !== '') {
      const n = Number(rows[0].value);
      return Number.isFinite(n) ? n : fallback;
    }
  } catch (e) { /* fall through */ }
  return fallback;
}

/**
 * Children booked into each room on `dateStr`, with dob and (where recorded) the
 * actual times they were signed in and out.
 *
 * room_id is taken from the booking, falling back to the child's own room — 9 of the
 * dev bookings and none of the prod ones have a NULL booking room, but the fallback
 * costs nothing and stops a NULL quietly deleting a child from the count.
 */
async function childrenForDay(db, dateStr) {
  const { rows } = await db.query(`
    SELECT DISTINCT ON (c.id)
           c.id, c.date_of_birth,
           COALESCE(b.room_id, c.room_id) AS room_id,
           to_char(a.sign_in_time  AT TIME ZONE 'Europe/London', 'HH24:MI') AS actual_in,
           to_char(a.sign_out_time AT TIME ZONE 'Europe/London', 'HH24:MI') AS actual_out
      FROM child_bookings b
      JOIN children c ON c.id = b.child_id
      LEFT JOIN attendance a
             ON a.child_id = c.id AND a.date = $1::date AND COALESCE(a.absent, false) = false
     WHERE b.is_active = true
       AND COALESCE(c.is_active, true) = true
       AND COALESCE(c.is_demo, false) = false
       AND c.date_of_birth IS NOT NULL
       AND $1::date BETWEEN b.start_date AND COALESCE(b.end_date, DATE '2100-01-01')
       AND CASE EXTRACT(DOW FROM $1::date)::int
             WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed
             WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
     ORDER BY c.id, a.sign_in_time NULLS LAST
  `, [dateStr]);
  return rows;
}

/**
 * Rostered shifts on `dateStr`. Excludes shifts that are absent, a meeting, still
 * open (nobody claimed them) or unassigned — none of those is a pair of hands in the
 * room. Excluded-role staff are kept in the result but marked counts_on_ratio:false
 * so the caller can SHOW that they were there without counting them.
 */
async function shiftsForDay(db, dateStr) {
  const { rows } = await db.query(`
    SELECT rs.id, rs.staff_id, rs.room_id, rs.break_mins, rs.is_lunch_cover, rs.label,
           rs.planned_start::text AS planned_start, rs.planned_end::text AS planned_end,
           rs.pattern_id,
           s.first_name, s.last_name, s.role,
           s.counts_on_ratio, s.ratio_level
      FROM rota_shifts rs
      LEFT JOIN staff s ON s.id = rs.staff_id
     WHERE rs.shift_date = $1::date
       AND COALESCE(rs.is_absent, false) = false
       AND COALESCE(rs.is_meeting, false) = false
       AND COALESCE(rs.is_open, false) = false
       AND rs.staff_id IS NOT NULL
       AND COALESCE(s.is_demo, false) = false
  `, [dateStr]);
  return rows.map(r => ({ ...r, counts_on_ratio: countsOnRatio(r), ratio_level: ratioLevelOf(r) }));
}

/**
 * THE CORE: per room, per 30-minute slot — children, staff, required, status.
 *
 * Reuses ratioEngine.getRatios() (settings key `ratios`, LADN = under2 1:3, two 1:4,
 * threePlus 1:8) and ratioEngine.requiredStaff()/ageBandOn() rather than restating
 * any of that arithmetic here. This endpoint does NOT change those values; it only
 * surfaces what they imply slot by slot.
 */
async function ratioCheck(db, dateStr) {
  const ratios = await ratioEngine.getRatios(db);
  // b194: a bank holiday / settings.closure_dates day is CLOSED. ladn.bank_holidays already
  // held 2026-08-31 but nothing outside rota.js read it, so the ratio check treated a closed
  // day as a normal one — every rostered minute became "surplus" and the day looked
  // dramatically overstaffed. Closed => no children, nothing required, nothing to log.
  const closedMap = await closures.loadClosures(db, dateStr, dateStr);
  const closureName = closedMap.get(dateStr) || null;
  const { rows: rooms } = await db.query(
    'SELECT id, name, capacity, ratio_children_per_staff FROM rooms ORDER BY id');
  const kids = closureName ? [] : await childrenForDay(db, dateStr);
  const shifts = await shiftsForDay(db, dateStr);
  const theSlots = slots();

  // Active children per room — the denominator for the booking-coverage guard.
  const { rows: rosterRows } = await db.query(`
    SELECT room_id, count(*)::int AS n FROM children
     WHERE COALESCE(is_active, true) = true AND COALESCE(is_demo, false) = false
       AND room_id IS NOT NULL GROUP BY room_id`);
  const rosterByRoom = {};
  for (const r of rosterRows) rosterByRoom[r.room_id] = r.n;

  const dow = new Date(dateStr + 'T00:00:00').getDay();
  const weekend = (dow === 0 || dow === 6);

  const out = [];
  for (const room of rooms) {
    const roomKids   = kids.filter(k => Number(k.room_id) === Number(room.id));
    const roomShifts = shifts.filter(s => Number(s.room_id) === Number(room.id));

    // Precompute each child's presence window and age band once.
    const kidWindows = roomKids.map(k => {
      const inM  = toMin(k.actual_in);
      const outM = toMin(k.actual_out);
      const fromActual = inM != null;
      return {
        band: ratioEngine.ageBandOn(k.date_of_birth, dateStr),
        start: fromActual ? inM : DAY_START_MIN,
        end:   (outM != null) ? outM : DAY_END_MIN,
        from_actual: fromActual,
      };
    });
    const staffWindows = roomShifts.map(s => ({
      staff_id: s.staff_id,
      start: toMin(s.planned_start) ?? DAY_START_MIN,
      end:   toMin(s.planned_end)   ?? DAY_END_MIN,
      counts_on_ratio: s.counts_on_ratio,
      name: [s.first_name, s.last_name].filter(Boolean).join(' ') || null,
      role: s.role,
      break_mins: parseInt(s.break_mins, 10) || 0,
    }));

    const slotRows = [];
    let surplusMinutes = 0, deficitMinutes = 0, requiredMinutes = 0, staffedMinutes = 0;

    for (const sl of theSlots) {
      // A child/shift covers a slot if it overlaps it at all.
      const inSlot = w => w.start < sl.end_min && w.end > sl.start_min;
      const present = kidWindows.filter(inSlot);
      const counts = { under2: 0, two: 0, threePlus: 0 };
      let fromActual = 0;
      for (const k of present) { counts[k.band]++; if (k.from_actual) fromActual++; }

      const required = ratioEngine.requiredStaff(counts, ratios);
      const onShift  = staffWindows.filter(inSlot);
      const staffed  = onShift.filter(w => w.counts_on_ratio);
      const offRatioPresent = onShift.length - staffed.length;

      const delta = staffed.length - required;
      const status = delta < 0 ? 'under' : (delta === 0 ? 'exact' : 'over');

      requiredMinutes += required * SLOT_MINUTES;
      staffedMinutes  += staffed.length * SLOT_MINUTES;
      if (delta > 0) surplusMinutes += delta * SLOT_MINUTES;
      if (delta < 0) deficitMinutes += (-delta) * SLOT_MINUTES;

      slotRows.push({
        slot: `${sl.start}-${sl.end}`, start: sl.start, end: sl.end,
        children: present.length,
        children_by_band: counts,
        children_from_actual_times: fromActual,
        children_from_booking_only: present.length - fromActual,
        staff: staffed.length,
        staff_present_not_on_ratio: offRatioPresent,
        required,
        delta,
        status,
      });
    }

    const rosterN = rosterByRoom[room.id] || 0;
    const coverage = rosterN > 0 ? Math.round((roomKids.length / rosterN) * 100) / 100 : null;

    out.push({
      room_id: room.id,
      room_name: room.name,
      capacity: room.capacity,
      children_booked_today: roomKids.length,
      children_on_roster: rosterN,
      booking_coverage: coverage,
      staff_rostered: staffWindows.filter(w => w.counts_on_ratio).length,
      staff_present_not_on_ratio: staffWindows.filter(w => !w.counts_on_ratio)
        .map(w => ({ staff_id: w.staff_id, name: w.name, role: w.role })),
      total_break_mins: staffWindows.filter(w => w.counts_on_ratio)
        .reduce((a, w) => a + w.break_mins, 0),
      required_minutes: requiredMinutes,
      staffed_minutes: staffedMinutes,
      surplus_minutes: surplusMinutes,
      surplus_human: humanMinutes(surplusMinutes),
      deficit_minutes: deficitMinutes,
      net_minutes: staffedMinutes - requiredMinutes,
      any_under: slotRows.some(s => s.status === 'under'),
      slots: slotRows,
    });
  }

  return {
    date: dateStr,
    weekend,
    closed: !!closureName,
    closure: closureName,
    slot_minutes: SLOT_MINUTES,
    window: `${fmt(DAY_START_MIN)}-${fmt(DAY_END_MIN)}`,
    ratios,
    ratios_note: 'Configured ratios, unchanged by this endpoint. under-2 1:3 is statutory; '
      + 'two-year-olds 1:4 is deliberately MORE generous than the statutory 1:5; '
      + '3+ at 1:8 is the conservative reading (1:13 needs a L6/QTS practitioner working directly with the children).',
    breaks_modelled: false,
    breaks_note: 'rota_shifts records break length but not when the break falls, so breaks are not '
      + 'deducted slot by slot. total_break_mins per room is given so the figure can be read with that in mind.',
    rooms: out,
  };
}

/**
 * Resolve who owns a room's off-ratio account. Preference order: an explicit
 * room_leader, then a senior practitioner, then a deputy attached to that room.
 * Returns null when nobody is attached — the caller then escalates to all-managers
 * rather than silently dropping the entry.
 */
async function resolveRoomLeader(db, roomId) {
  const { rows } = await db.query(`
    SELECT id, first_name, last_name, role FROM staff
     WHERE COALESCE(is_active, true) = true AND room_id = $1
       AND COALESCE(is_demo, false) = false
       AND role IN ('room_leader', 'senior_practitioner', 'deputy_manager', 'manager')
     ORDER BY CASE role WHEN 'room_leader' THEN 1 WHEN 'senior_practitioner' THEN 2 ELSE 3 END, id
     LIMIT 1`, [roomId]);
  return rows[0] || null;
}

/**
 * For one date: work out each room's surplus and, where it exceeds the threshold AND
 * booking coverage is good enough to trust the number, upsert an offratio_log row.
 *
 * Returns a report of what was written, what was under threshold, and what was
 * SKIPPED for poor data — the skips are the honest part and must not be swallowed.
 * Never updates a row whose account has already been written.
 */
async function logSurplusDay(db, dateStr, opts) {
  const options = opts || {};
  const check = await ratioCheck(db, dateStr);
  if (check.weekend) return { date: dateStr, weekend: true, created: [], below_threshold: [], skipped: [] };
  // A closed day has no children by definition, so every rostered minute would read as
  // off-ratio surplus. Nothing to account for.
  if (check.closed) return { date: dateStr, closed: true, closure: check.closure,
                             created: [], below_threshold: [], skipped: [] };

  const threshold = options.thresholdMinutes != null
    ? options.thresholdMinutes
    : await getSetting(db, 'offratio_min_minutes', DEFAULT_MIN_SURPLUS_MINUTES);
  const minCoverage = options.minCoverage != null
    ? options.minCoverage
    : await getSetting(db, 'offratio_min_booking_coverage', DEFAULT_MIN_BOOKING_COVERAGE);

  const created = [], belowThreshold = [], skipped = [];

  for (const room of check.rooms) {
    if (room.children_booked_today === 0 && room.staff_rostered === 0) continue;   // room not in use

    if (room.booking_coverage != null && room.booking_coverage < minCoverage) {
      skipped.push({
        room_id: room.room_id, room_name: room.room_name,
        surplus_minutes: room.surplus_minutes,
        reason: 'low_booking_coverage',
        detail: `Only ${Math.round((room.booking_coverage || 0) * 100)}% of ${room.room_name}'s active children `
          + `have an entry in the booked register (need ${Math.round(minCoverage * 100)}%). The surplus figure `
          + `would be measuring a gap in the register, not real off-ratio time, so no account has been requested.`,
      });
      continue;
    }
    if (room.surplus_minutes < threshold) {
      belowThreshold.push({ room_id: room.room_id, room_name: room.room_name,
                            surplus_minutes: room.surplus_minutes, threshold });
      continue;
    }

    const leader = await resolveRoomLeader(db, room.room_id);
    const detail = {
      threshold_minutes: threshold,
      required_minutes: room.required_minutes,
      staffed_minutes: room.staffed_minutes,
      deficit_minutes: room.deficit_minutes,
      total_break_mins: room.total_break_mins,
      booking_coverage: room.booking_coverage,
      breaks_modelled: false,
      slots: room.slots.filter(s => s.status === 'over')
        .map(s => ({ slot: s.slot, children: s.children, staff: s.staff, required: s.required, delta: s.delta })),
    };

    // Never clobber an account that has already been written.
    const { rows } = await db.query(`
      INSERT INTO offratio_log (date, room_id, room_leader_id, surplus_minutes, detail)
      VALUES ($1::date, $2, $3, $4, $5::jsonb)
      ON CONFLICT (date, room_id) DO UPDATE
         SET surplus_minutes = EXCLUDED.surplus_minutes,
             room_leader_id  = COALESCE(offratio_log.room_leader_id, EXCLUDED.room_leader_id),
             detail          = EXCLUDED.detail
       WHERE offratio_log.account IS NULL
      RETURNING id, room_leader_id, (xmax = 0) AS inserted`, 
      [dateStr, room.room_id, leader ? leader.id : null, room.surplus_minutes, JSON.stringify(detail)]);

    if (!rows.length) {   // an account already exists for that room-day — leave it alone
      belowThreshold.push({ room_id: room.room_id, room_name: room.room_name,
                            surplus_minutes: room.surplus_minutes, note: 'already accounted for' });
      continue;
    }
    created.push({
      id: rows[0].id, room_id: room.room_id, room_name: room.room_name,
      room_leader_id: rows[0].room_leader_id,
      room_leader: leader ? `${leader.first_name} ${leader.last_name}` : null,
      surplus_minutes: room.surplus_minutes,
      surplus_human: humanMinutes(room.surplus_minutes),
      inserted: rows[0].inserted,
    });
  }

  return { date: dateStr, weekend: false, threshold, min_coverage: minCoverage,
           created, below_threshold: belowThreshold, skipped };
}

/** Weekday name used in the prompt shown to the room leader ("Monday - Pre-school - 9h 00m off ratio"). */
function weekdayName(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long' });
}
function promptLine(dateStr, roomName, surplusMinutes) {
  return `${weekdayName(dateStr)} — ${roomName} — ${humanMinutes(surplusMinutes)} off ratio`;
}

/** Off-ratio minutes attributable to one member of staff over a window (b183 page). */
async function staffOffRatioMinutes(db, staffId, fromDate, toDate) {
  const { rows } = await db.query(`
    SELECT rs.shift_date, rs.room_id
      FROM rota_shifts rs
     WHERE rs.staff_id = $1
       AND rs.shift_date BETWEEN $2::date AND $3::date
       AND COALESCE(rs.is_absent, false) = false
       AND COALESCE(rs.is_meeting, false) = false
       AND COALESCE(rs.is_open, false) = false
       AND rs.room_id IS NOT NULL`, [staffId, fromDate, toDate]);
  if (!rows.length) return { staff_id: staffId, days: [], total_minutes: 0, total_human: humanMinutes(0) };

  // Share the room-day's surplus equally between the ratio-counting staff rostered in
  // that room that day. It is a share, not a measurement of that individual — the room
  // was over ratio, not the person — and the payload says so.
  const days = [];
  let total = 0;
  for (const r of rows) {
    const d = ymd(r.shift_date);
    const { rows: logRows } = await db.query(
      'SELECT surplus_minutes, account FROM offratio_log WHERE date = $1::date AND room_id = $2', [d, r.room_id]);
    if (!logRows.length || !logRows[0].surplus_minutes) continue;
    const peers = await shiftsForDay(db, d);
    const n = peers.filter(p => Number(p.room_id) === Number(r.room_id) && p.counts_on_ratio).length || 1;
    const share = Math.round(logRows[0].surplus_minutes / n);
    total += share;
    days.push({ date: d, room_id: r.room_id, room_surplus_minutes: logRows[0].surplus_minutes,
                staff_share_minutes: share, shared_between: n, accounted: !!logRows[0].account });
  }
  return {
    staff_id: staffId, from: fromDate, to: toDate,
    days, total_minutes: total, total_human: humanMinutes(total),
    basis: 'Equal share of the room-day surplus between the ratio-counting staff rostered in that room. '
         + 'It describes the ROOM being over ratio, not an individual choosing to step out.',
  };
}

module.exports = {
  SLOT_MINUTES, DAY_START_MIN, DAY_END_MIN,
  DEFAULT_MIN_SURPLUS_MINUTES, DEFAULT_MIN_BOOKING_COVERAGE,
  countsOnRatio, ratioLevelOf, humanMinutes, weekdayName, promptLine, slots, getSetting,
  childrenForDay, shiftsForDay, ratioCheck,
  resolveRoomLeader, logSurplusDay, staffOffRatioMinutes,
};
