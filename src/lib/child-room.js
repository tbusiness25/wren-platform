'use strict';
// ===========================================================================
// b315 — ONE WAY TO CHANGE A CHILD'S ROOM (2026-09-10)
//
// Toby, on finding b314's room bug:
//   "I need to make sure that there's one source of truth for the booking
//    pattern and room and that will be on the child's page on their profile."
//
// WHAT WENT WRONG. A child's room lived in two places:
//   children.room_id        — registers, the daily diary, the kitchen sheets,
//                             the child's own profile
//   child_bookings.room_id  — occupancy, ratios, fees, the forecast
// Six different code paths wrote one, the other, or both, with slightly
// different rules about when. Roost's room-move button wrote the profile and a
// child_room_moves row and stopped; the occupancy board read the booking. The
// move looked right on every screen a manager checks and was wrong on every
// screen a decision gets made from. b314 patched the paths one at a time. That
// fixes the instance; it does not fix the shape. Two homes for one fact is not
// a bug you fix once, it is a bug generator.
//
// WHICH ONE IS CANONICAL. child_bookings is the real store. It is the only one
// that can say WHEN a child is in a room, it carries the days and the dates, and
// it is what occupancy, ratios, fees and the forecast already read.
// children.room_id is a DERIVED CONVENIENCE — the answer to "which room is this
// child in today", denormalised so a register does not have to join. It is kept
// in step by the same write and must never be edited on its own.
//
// SO: every writer calls setChildRoom(). Not "every writer except imports".
// If you are about to write children.room_id or child_bookings.room_id in a
// route, you are adding the seventh path — call this instead.
//
// The check that this held is scripts/b314-room-drift.js and the
// ladn.child_room_drift view it reads. It should always report zero.
// ===========================================================================

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

/** 'YYYY-MM-DD' from anything date-ish, using LOCAL getters (b-series pg trap). */
function ymd(v) {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const m = String(v).slice(0, 10).match(/^\d{4}-\d{2}-\d{2}$/);
  return m ? m[0] : null;
}
const today = () => ymd(new Date());
function addDays(iso, n) {
  const d = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)));
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// ── reading ────────────────────────────────────────────────────────────────

/**
 * The room a child is in on a date, from the canonical store.
 * Falls back to the profile only when there is no booking covering the date —
 * which is itself worth knowing, so it is reported rather than hidden.
 * @returns {{room_id:number|null, room_name:string|null, source:'booking'|'profile'|'none', booking_id:number|null}}
 */
async function canonicalRoom(db, childId, onDate) {
  const d = ymd(onDate) || today();
  const { rows } = await db.query(`
    SELECT b.id AS booking_id, b.room_id AS booking_room_id, br.name AS booking_room,
           c.room_id AS profile_room_id, cr.name AS profile_room
      FROM children c
      LEFT JOIN rooms cr ON cr.id = c.room_id
      LEFT JOIN LATERAL (
        SELECT * FROM child_bookings b0
         WHERE b0.child_id = c.id AND b0.is_active = true
           AND b0.start_date <= $2::date
           AND (b0.end_date IS NULL OR b0.end_date >= $2::date)
         ORDER BY b0.start_date DESC, b0.id DESC LIMIT 1) b ON true
      LEFT JOIN rooms br ON br.id = b.room_id
     WHERE c.id = $1`, [childId, d]);
  if (!rows.length) return { room_id: null, room_name: null, source: 'none', booking_id: null };
  const r = rows[0];
  if (r.booking_room_id != null) {
    return { room_id: r.booking_room_id, room_name: r.booking_room, source: 'booking', booking_id: r.booking_id };
  }
  return {
    room_id: r.profile_room_id, room_name: r.profile_room,
    source: r.profile_room_id == null ? 'none' : 'profile', booking_id: null,
  };
}

/**
 * Every child whose two stores disagree TODAY. Should always be empty.
 * Reads the ladn.child_room_drift view so the nightly check, the API and the
 * standalone script are all asking one question; falls back to the same SQL
 * inline for a database that has the code but not yet the b315 migration.
 * Returns child IDs and room names — never a name (build-logs is unwalled).
 */
async function roomDrift(db) {
  try {
    const { rows } = await db.query(
      `SELECT child_id, profile_room_id, profile_room, booking_id, booking_room_id, booking_room,
              start_date::text AS start_date, end_date::text AS end_date
         FROM child_room_drift ORDER BY child_id`);
    return rows;
  } catch (e) {
    if (!/child_room_drift/.test(e.message)) throw e;
    const { rows } = await db.query(`
      SELECT c.id AS child_id, c.room_id AS profile_room_id, cr.name AS profile_room,
             b.id AS booking_id, b.room_id AS booking_room_id, br.name AS booking_room,
             b.start_date::text AS start_date, b.end_date::text AS end_date
        FROM children c
        JOIN child_bookings b ON b.child_id = c.id
        LEFT JOIN rooms cr ON cr.id = c.room_id
        LEFT JOIN rooms br ON br.id = b.room_id
       WHERE COALESCE(c.is_active, true) AND b.is_active = true
         AND (b.end_date IS NULL OR b.end_date >= CURRENT_DATE)
         AND b.start_date <= CURRENT_DATE
         AND c.room_id IS NOT NULL
         AND b.room_id IS DISTINCT FROM c.room_id
       ORDER BY c.id`);
    return rows;
  }
}

// ── writing ────────────────────────────────────────────────────────────────

/**
 * The derived half: children.room_id and the legacy children.room text.
 * Only ever called from setChildRoom, and only when the move is effective now —
 * a move dated next month must not change today's register.
 */
async function _writeProfileRoom(db, childId, roomId) {
  const { rowCount } = await db.query(
    `UPDATE children c
        SET room_id = $1,
            room = COALESCE((SELECT name FROM rooms WHERE id = $1), c.room),
            updated_at = NOW()
      WHERE c.id = $2 AND c.room_id IS DISTINCT FROM $1`, [roomId, childId]);
  return rowCount > 0;
}

/**
 * The canonical half: close each live booking the day before, open its twin in
 * the new room from the effective date, keeping the days, the times, the session
 * type, the funded flag and the original end date.
 *
 * This is b190's _propagateRoomChange, moved here. src/routes/children.js still
 * exports that name — it now delegates to this — because five files import it.
 *
 * TWO CHANGES FROM b190:
 *
 * 1. EVERY live booking moves, not just the newest. b190 took
 *    `ORDER BY id DESC LIMIT 1`, which is right for the ordinary child with one
 *    pattern and wrong for the child who holds two — three funded days and two
 *    private ones, say. Moving one of those and leaving the other stranded in the
 *    old room is the same half-move bug in miniature, and it is what the b315
 *    verification caught in this very function.
 *
 * 2. The old booking is only DEACTIVATED once its period has genuinely ended.
 *    b190 set is_active=false unconditionally, so a FUTURE-dated transfer removed
 *    the child from today's occupancy the moment the transfer was booked, weeks
 *    before they moved. Bounding end_date is enough — every occupancy query
 *    already filters on the date range.
 */
async function _transferBooking(db, childId, newRoomId, eff) {
  const { rows: live } = await db.query(
    `SELECT * FROM child_bookings
      WHERE child_id = $1 AND is_active = true
        AND (end_date IS NULL OR end_date >= $2::date)
      ORDER BY start_date, id`, [childId, eff]);
  if (!live.length) return { moved: false, reason: 'no_live_booking' };

  const toMove = live.filter(b => b.room_id !== newRoomId);
  if (!toMove.length) return { moved: false, reason: 'already_in_room' };

  const dayBefore = addDays(eff, -1);
  const { rows: ch } = await db.query(`SELECT leave_date FROM children WHERE id = $1`, [childId]);
  const childLeave = ymd(ch[0] && ch[0].leave_date);

  const opened = [], closed = [], retimed = [];
  for (const b of toMove) {
    // A booking that starts on or after the effective date is not a predecessor
    // to close — it is a pattern the child is moving INTO. Move it where it
    // stands rather than stranding it in the old room.
    if (ymd(b.start_date) >= eff) {
      await db.query(`UPDATE child_bookings SET room_id = $1, updated_at = NOW() WHERE id = $2`,
        [newRoomId, b.id]);
      retimed.push(b.id);
      continue;
    }
    // Read the original end date BEFORE overwriting it — the new booking inherits it.
    const newEnd = ymd(b.end_date) || childLeave || null;
    await db.query(
      `UPDATE child_bookings SET end_date = $1::date, is_active = ($1::date >= CURRENT_DATE), updated_at = NOW()
        WHERE id = $2`, [dayBefore, b.id]);
    closed.push(b.id);
    const { rows: ins } = await db.query(
      `INSERT INTO child_bookings (child_id, room_id, mon, tue, wed, thu, fri, start_date, end_date,
                                   funded, notes, source, is_active, created_by,
                                   session_type, start_time, finish_time, repeat_mode,
                                   extra_session, exclude_from_funding, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'room-transfer',true,$12,
               $13,$14,$15,COALESCE($16,'weekly'),COALESCE($17,false),COALESCE($18,false),NOW())
       RETURNING id`,
      [childId, newRoomId, b.mon, b.tue, b.wed, b.thu, b.fri, eff, newEnd, b.funded,
       `Room transfer from room ${b.room_id} on ${eff}`, b.created_by || null,
       b.session_type ?? null, b.start_time ?? null, b.finish_time ?? null,
       b.repeat_mode ?? null, b.extra_session ?? null, b.exclude_from_funding ?? null]);
    opened.push(ins[0].id);
  }

  return {
    moved: true, from: toMove[0].room_id, to: newRoomId, effective: eff,
    bookings_moved: toMove.length,
    closed_booking_ids: closed, opened_booking_ids: opened, retimed_booking_ids: retimed,
    // Kept for callers that read the b190 shape.
    closed_booking_id: closed[0] || null,
    booking_id: opened[0] || retimed[0] || null,
    retimed: opened.length > 0,
  };
}

/** The history row. One per child per day per destination — a repeat updates it. */
async function _logMove(db, { childId, fromRoomId, toRoomId, movedOn, actorId, source, note, bookingId }) {
  try {
    const { rows } = await db.query(
      `INSERT INTO child_room_moves (child_id, from_room_id, to_room_id, moved_on, recorded_by, source, booking_id, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (child_id, moved_on, to_room_id) DO UPDATE
         SET from_room_id = COALESCE(child_room_moves.from_room_id, EXCLUDED.from_room_id),
             recorded_by  = COALESCE(EXCLUDED.recorded_by, child_room_moves.recorded_by),
             source       = COALESCE(EXCLUDED.source, child_room_moves.source),
             booking_id   = COALESCE(EXCLUDED.booking_id, child_room_moves.booking_id),
             note         = COALESCE(EXCLUDED.note, child_room_moves.note)
       RETURNING id`,
      [childId, fromRoomId, toRoomId, movedOn, actorId || null, source || null, bookingId || null, note || null]);
    return rows[0] ? rows[0].id : null;
  } catch (e) {
    // A database with the code but not the b315 migration has neither the unique
    // index nor the extra columns. Record what it CAN take rather than failing
    // the move: the move itself matters more than its provenance.
    if (!/(constraint|column|conflict)/i.test(e.message)) throw e;
    const { rows } = await db.query(
      `INSERT INTO child_room_moves (child_id, from_room_id, to_room_id, moved_on, recorded_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [childId, fromRoomId, toRoomId, movedOn, actorId || null]);
    return rows[0] ? rows[0].id : null;
  }
}

/**
 * CHANGE A CHILD'S ROOM. The only function that may.
 *
 * @param {object} db      pool or client (a caller inside a transaction passes its client)
 * @param {object} opts
 * @param {number} opts.childId
 * @param {number} opts.toRoomId
 * @param {string} [opts.effectiveDate]  'YYYY-MM-DD', default today. A future date
 *                                       moves the BOOKING from then and leaves the
 *                                       profile (registers, diary, kitchen) alone
 *                                       until the day arrives.
 * @param {number} [opts.actorId]
 * @param {string} [opts.source]         who asked: 'profile' | 'occupancy-board' |
 *                                       'booking-editor' | 'import' | 'bulk-edit' |
 *                                       'room-move-engine' | 'transition-report'
 * @param {number} [opts.fromRoomId]     when the caller has already overwritten the
 *                                       profile and knows the old value
 * @param {boolean} [opts.moveBooking=true]  false when the BOOKING is the edit and
 *                                       the profile is what needs to follow
 * @param {number} [opts.bookingId]      the booking that carried the change
 * @param {boolean} [opts.log=true]
 * @returns {Promise<object>} what actually happened — never throws for "already there"
 */
async function setChildRoom(db, opts = {}) {
  const childId = Number(opts.childId);
  const toRoomId = opts.toRoomId == null ? null : Number(opts.toRoomId);
  if (!Number.isInteger(childId)) return { ok: false, reason: 'bad_child_id' };
  if (!Number.isInteger(toRoomId)) return { ok: false, reason: 'bad_room_id' };

  const eff = ymd(opts.effectiveDate) || today();
  const now = today();
  const immediate = eff <= now;

  const { rows: cur } = await db.query(
    `SELECT c.room_id, r.id AS room_exists FROM children c
       LEFT JOIN rooms r ON r.id = $2 WHERE c.id = $1`, [childId, toRoomId]);
  if (!cur.length) return { ok: false, reason: 'no_such_child' };
  if (cur[0].room_exists == null) return { ok: false, reason: 'no_such_room' };
  const fromRoomId = opts.fromRoomId !== undefined && opts.fromRoomId !== null
    ? Number(opts.fromRoomId) : cur[0].room_id;

  const result = {
    ok: true, child_id: childId, from_room_id: fromRoomId, to_room_id: toRoomId,
    effective: eff, immediate,
    profile_updated: false, booking: { moved: false, reason: 'not_attempted' },
    move_log_id: null, source: opts.source || null,
  };

  // The canonical half first: if the booking transfer is going to fail, the
  // profile should not be left claiming a move that occupancy never saw.
  if (opts.moveBooking === false) {
    result.booking = { moved: false, reason: 'caller_owns_booking', booking_id: opts.bookingId || null };
  } else {
    result.booking = await _transferBooking(db, childId, toRoomId, eff);
  }

  // The derived half. Only when the move is effective now.
  if (immediate) result.profile_updated = await _writeProfileRoom(db, childId, toRoomId);

  // Nothing at all changed and the child was already there — say so plainly
  // rather than writing a history row for a move that did not happen.
  const nothingHappened = !result.profile_updated && !result.booking.moved
    && fromRoomId === toRoomId;
  if (nothingHappened) {
    result.no_change = true;
    return result;
  }

  if (opts.log !== false) {
    result.move_log_id = await _logMove(db, {
      childId, fromRoomId, toRoomId, movedOn: eff, actorId: opts.actorId,
      source: opts.source, note: opts.note,
      bookingId: opts.bookingId || result.booking.booking_id || null,
    });
  }

  // The one thing worth shouting about: the room changed but occupancy did not
  // hear, because there is no booking to move. That child is invisible to the
  // board, the ratios and the forecast — which is exactly the warning icon the
  // profile strip now carries.
  if (!result.booking.moved && result.booking.reason === 'no_live_booking') {
    result.warning = 'no_booking_pattern';
    result.warning_detail =
      'the profile moved but occupancy did not: this child has no live booking pattern, so no room counts them';
  }
  return result;
}

/**
 * The same move, when the BOOKING is the edit.
 *
 * A manager editing the booking pattern has just said which room the child is
 * in — the canonical store is already right and re-transferring it would open a
 * second booking on top of the one they saved. This brings the derived profile
 * into step and records the move, and does nothing else.
 *
 * Only a booking that is LIVE TODAY may move the profile. A pattern that starts
 * next term is a decision about next term; it must not move a child now.
 */
async function noteRoomFromBooking(db, { childId, booking, actorId, source }) {
  if (!booking || booking.room_id == null) return { ok: false, reason: 'no_room_on_booking' };
  const now = today();
  const start = ymd(booking.start_date);
  const end = ymd(booking.end_date);
  const live = booking.is_active !== false && (!start || start <= now) && (!end || end >= now);
  if (!live) return { ok: true, no_change: true, reason: 'booking_not_live_today', profile_updated: false };
  return setChildRoom(db, {
    childId: childId != null ? childId : booking.child_id,
    toRoomId: booking.room_id,
    effectiveDate: now,
    actorId,
    source: source || 'booking-editor',
    moveBooking: false,
    bookingId: booking.id,
  });
}

module.exports = {
  setChildRoom, noteRoomFromBooking, canonicalRoom, roomDrift,
  _transferBooking, ymd, DAYS,
};
