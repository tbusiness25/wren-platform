const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// Manager-only middleware
function requireManager(req, res, next) {
  if (!req.user || req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
}

router.use(requireManager);

// Get attendance overview for all children
router.get('/overview', async (req, res) => {
  try {
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const toDate = to || new Date().toISOString().split('T')[0];

    // Calculate expected sessions from child_bookings
    const query = `
      WITH date_series AS (
        SELECT generate_series($1::date, $2::date, '1 day'::interval)::date AS date
      ),
      expected_sessions AS (
        SELECT
          cb.child_id,
          ds.date,
          CASE EXTRACT(DOW FROM ds.date)
            WHEN 1 THEN cb.mon
            WHEN 2 THEN cb.tue
            WHEN 3 THEN cb.wed
            WHEN 4 THEN cb.thu
            WHEN 5 THEN cb.fri
            ELSE false
          END AS expected
        FROM child_bookings cb
        CROSS JOIN date_series ds
        WHERE cb.is_active = true
          AND ds.date >= cb.start_date
          AND (cb.end_date IS NULL OR ds.date <= cb.end_date)
      ),
      attendance_summary AS (
        SELECT
          es.child_id,
          COUNT(*) FILTER (WHERE es.expected = true) AS expected_sessions,
          COUNT(*) FILTER (WHERE es.expected = true AND a.id IS NOT NULL AND a.absent = false) AS attended_sessions,
          COUNT(*) FILTER (WHERE a.absent = true) AS absent_sessions
        FROM expected_sessions es
        LEFT JOIN attendance a ON a.child_id = es.child_id AND a.date = es.date
        WHERE es.expected = true
        GROUP BY es.child_id
      ),
      weekday_absences AS (
        SELECT
          a.child_id,
          EXTRACT(DOW FROM a.date) AS dow,
          COUNT(*) AS count
        FROM attendance a
        WHERE a.absent = true
          AND a.date >= $1::date
          AND a.date <= $2::date
        GROUP BY a.child_id, EXTRACT(DOW FROM a.date)
      ),
      repeated_dow AS (
        SELECT
          child_id,
          MAX(count) AS max_same_day_absences
        FROM weekday_absences
        GROUP BY child_id
      )
      SELECT
        c.id,
        c.first_name,
        c.last_name,
        COALESCE(asummary.expected_sessions, 0) AS expected_sessions,
        COALESCE(asummary.attended_sessions, 0) AS attended_sessions,
        COALESCE(asummary.absent_sessions, 0) AS absent_sessions,
        CASE
          WHEN asummary.expected_sessions > 0
          THEN ROUND((asummary.attended_sessions::numeric / asummary.expected_sessions::numeric) * 100, 1)
          ELSE NULL
        END AS attendance_percentage,
        CASE
          WHEN asummary.expected_sessions > 0
               AND (asummary.attended_sessions::numeric / asummary.expected_sessions::numeric) < 0.90
          THEN true
          WHEN rd.max_same_day_absences >= 3
          THEN true
          ELSE false
        END AS persistent_absence,
        COALESCE(rd.max_same_day_absences, 0) AS max_same_day_absences,
        (
          SELECT COUNT(*)
          FROM attendance_concern_actions aca
          WHERE aca.child_id = c.id
            AND aca.created_at >= $1::date
        ) AS action_count
      FROM children c
      LEFT JOIN attendance_summary asummary ON asummary.child_id = c.id
      LEFT JOIN repeated_dow rd ON rd.child_id = c.id
      WHERE c.status = 'active'
      ORDER BY persistent_absence DESC, attendance_percentage ASC NULLS LAST, c.last_name, c.first_name;
    `;

    const result = await getPool().query(query, [fromDate, toDate]);
    res.json({
      from: fromDate,
      to: toDate,
      children: result.rows
    });
  } catch (err) {
    console.error('Error fetching attendance overview:', err);
    res.status(500).json({ error: 'Failed to fetch attendance overview' });
  }
});

// Get detailed attendance pattern for a specific child
router.get('/child/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { from, to } = req.query;
    const fromDate = from || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const toDate = to || new Date().toISOString().split('T')[0];

    // Get child info
    const childResult = await getPool().query(
      'SELECT id, first_name, last_name FROM children WHERE id = $1',
      [id]
    );

    if (childResult.rows.length === 0) {
      return res.status(404).json({ error: 'Child not found' });
    }

    // Get weekday breakdown
    const weekdayQuery = `
      WITH date_series AS (
        SELECT generate_series($2::date, $3::date, '1 day'::interval)::date AS date
      ),
      expected_by_dow AS (
        SELECT
          EXTRACT(DOW FROM ds.date) AS dow,
          COUNT(*) AS expected_count
        FROM child_bookings cb
        CROSS JOIN date_series ds
        WHERE cb.child_id = $1
          AND cb.is_active = true
          AND ds.date >= cb.start_date
          AND (cb.end_date IS NULL OR ds.date <= cb.end_date)
          AND (
            (EXTRACT(DOW FROM ds.date) = 1 AND cb.mon = true) OR
            (EXTRACT(DOW FROM ds.date) = 2 AND cb.tue = true) OR
            (EXTRACT(DOW FROM ds.date) = 3 AND cb.wed = true) OR
            (EXTRACT(DOW FROM ds.date) = 4 AND cb.thu = true) OR
            (EXTRACT(DOW FROM ds.date) = 5 AND cb.fri = true)
          )
        GROUP BY EXTRACT(DOW FROM ds.date)
      ),
      absence_by_dow AS (
        SELECT
          EXTRACT(DOW FROM a.date) AS dow,
          COUNT(*) AS absent_count
        FROM attendance a
        WHERE a.child_id = $1
          AND a.absent = true
          AND a.date >= $2::date
          AND a.date <= $3::date
        GROUP BY EXTRACT(DOW FROM a.date)
      )
      SELECT
        CASE e.dow
          WHEN 1 THEN 'Monday'
          WHEN 2 THEN 'Tuesday'
          WHEN 3 THEN 'Wednesday'
          WHEN 4 THEN 'Thursday'
          WHEN 5 THEN 'Friday'
        END AS day_name,
        e.dow,
        e.expected_count,
        COALESCE(abd.absent_count, 0) AS absent_count,
        CASE
          WHEN e.expected_count > 0
          THEN ROUND(((e.expected_count - COALESCE(abd.absent_count, 0))::numeric / e.expected_count::numeric) * 100, 1)
          ELSE NULL
        END AS attendance_percentage
      FROM expected_by_dow e
      LEFT JOIN absence_by_dow abd ON abd.dow = e.dow
      ORDER BY e.dow;
    `;

    const weekdayResult = await getPool().query(weekdayQuery, [id, fromDate, toDate]);

    // Get recent absences
    const absencesQuery = `
      SELECT
        date,
        absence_reason,
        notes
      FROM attendance
      WHERE child_id = $1
        AND absent = true
        AND date >= $2::date
        AND date <= $3::date
      ORDER BY date DESC
      LIMIT 20;
    `;

    const absencesResult = await getPool().query(absencesQuery, [id, fromDate, toDate]);

    // Get logged actions
    const actionsQuery = `
      SELECT
        aca.id,
        aca.note,
        aca.logged_by,
        aca.created_at,
        s.first_name || ' ' || s.last_name AS logged_by_name
      FROM attendance_concern_actions aca
      LEFT JOIN staff s ON s.id = aca.logged_by
      WHERE aca.child_id = $1
        AND aca.created_at >= $2::date
      ORDER BY aca.created_at DESC;
    `;

    const actionsResult = await getPool().query(actionsQuery, [id, fromDate]);

    res.json({
      child: childResult.rows[0],
      from: fromDate,
      to: toDate,
      weekday_breakdown: weekdayResult.rows,
      recent_absences: absencesResult.rows,
      actions: actionsResult.rows
    });
  } catch (err) {
    console.error('Error fetching child attendance pattern:', err);
    res.status(500).json({ error: 'Failed to fetch child attendance pattern' });
  }
});

// Log action taken regarding attendance concern
router.post('/child/:id/action', async (req, res) => {
  try {
    const { id } = req.params;
    const { note } = req.body;

    if (!note || !note.trim()) {
      return res.status(400).json({ error: 'Note is required' });
    }

    const result = await getPool().query(
      `INSERT INTO attendance_concern_actions
       (child_id, note, logged_by, created_at)
       VALUES ($1, $2, $3, NOW())
       RETURNING id, note, logged_by, created_at`,
      [id, note.trim(), req.user.id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error logging attendance action:', err);
    res.status(500).json({ error: 'Failed to log action' });
  }
});

module.exports = router;
