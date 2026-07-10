// Shared logic: reflect a parent-reported absence into the attendance register.
// Used by the parents-portal POST /welcome/absence/api/report (immediate apply)
// and mirrored by scripts/seed-daily-register.js (seed-time apply).
//
// A reported absence marks absent=true on the register for the child's BOOKED
// weekdays within the range — but never overrides a day the child has already
// been signed in (sign_in_time IS NULL guard). This keeps occupancy + the
// kitchen headcount correct without clobbering real attendance.

/**
 * Apply a reported absence to the register for the child's booked weekdays in
 * [startDate, endDate]. Only touches today-or-future days (past register is
 * historical). Idempotent.
 * @param {{query: Function}} db  pg pool/client
 * @param {number} childId
 * @param {string} startDate 'YYYY-MM-DD'
 * @param {string} endDate   'YYYY-MM-DD'
 * @param {string} reason
 * @returns {Promise<string[]>} the dates that were marked absent
 */
async function applyReportedAbsence(db, childId, startDate, endDate, reason) {
  const { rows } = await db.query(`
    WITH days AS (
      SELECT d::date AS day, EXTRACT(DOW FROM d)::int AS dow
      FROM generate_series($2::date, $3::date, interval '1 day') d
      WHERE d::date >= CURRENT_DATE
    ),
    booked AS (
      SELECT DISTINCT dd.day
      FROM days dd
      JOIN child_bookings b ON b.child_id=$1 AND b.is_active=true
        AND dd.day BETWEEN b.start_date AND COALESCE(b.end_date, DATE '2100-01-01')
        AND CASE dd.dow
              WHEN 1 THEN b.mon WHEN 2 THEN b.tue WHEN 3 THEN b.wed
              WHEN 4 THEN b.thu WHEN 5 THEN b.fri ELSE false END
    )
    INSERT INTO attendance (child_id, date, session, absent, absence_reason)
    SELECT $1, day, 'full_day', true, $4 FROM booked
    ON CONFLICT (child_id, date, session) DO UPDATE
      SET absent=true, absence_reason=EXCLUDED.absence_reason
      WHERE attendance.sign_in_time IS NULL
    RETURNING date
  `, [childId, startDate, endDate, (reason || 'Parent-reported absence').slice(0, 200)]);
  return rows.map(r => (r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date));
}

module.exports = { applyReportedAbsence };
