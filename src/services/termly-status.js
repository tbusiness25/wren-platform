'use strict';
/*
 * Termly-update status (Prompt 28).
 *
 * A "termly update" (the EYFS "Termly Update & Tracking" document — formerly
 * called the Learning Journey PDF) is recorded as an observation with
 * observations.termly_update = true. Every key child should get one each cycle
 * (a rolling term of ~6–8 weeks). This module is the single source of truth for
 * "has this child had their termly update this cycle?" — shared by the
 * /api/observations/termly-status endpoint AND the reminder drainer so both
 * agree exactly.
 *
 * Cycle window is configurable in settings:
 *   termly_update_cycle_weeks  (default 8)  — Done if last update within this many weeks
 *   termly_update_grace_weeks  (default 2)  — Due during the grace window, Overdue after
 */

const CYCLE_DEFAULT = 8;
const GRACE_DEFAULT = 2;

async function getCycleConfig(db) {
  let cycleWeeks = CYCLE_DEFAULT;
  let graceWeeks = GRACE_DEFAULT;
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings
       WHERE key IN ('termly_update_cycle_weeks','termly_update_grace_weeks')`);
    for (const r of rows) {
      const n = parseInt(r.value, 10);
      if (r.key === 'termly_update_cycle_weeks' && Number.isFinite(n) && n > 0) cycleWeeks = n;
      if (r.key === 'termly_update_grace_weeks' && Number.isFinite(n) && n >= 0) graceWeeks = n;
    }
  } catch (e) { /* settings table missing → defaults */ }
  return { cycleWeeks, graceWeeks };
}

// Classify a single child given days since last termly update (null = never)
// and days since enrolment (null = unknown).
function classify(daysSince, daysEnrolled, cycleWeeks, graceWeeks) {
  const cycleDays = cycleWeeks * 7;
  const graceDays = (cycleWeeks + graceWeeks) * 7;
  if (daysSince != null) {
    if (daysSince <= cycleDays) return 'done';
    if (daysSince <= graceDays) return 'due';
    return 'overdue';
  }
  // Never had a termly update: give recently-enrolled children the grace window
  // before they count as overdue.
  if (daysEnrolled != null && daysEnrolled <= graceDays) return 'due';
  return 'overdue';
}

/*
 * Returns { cycleWeeks, graceWeeks, children: [...] }.
 * Each child: { child_id, first_name, last_name, name, room_id, room_name,
 *   key_person_id, key_person_name, last_termly_date, last_obs_id, days_since, status }
 *
 * opts.staffId  — restrict to that staff member's key children (null = all)
 * opts.onlyKeyed — only children who have a key person assigned
 */
async function fetchTermlyStatuses(db, opts = {}) {
  const { staffId = null, onlyKeyed = false } = opts;
  const { cycleWeeks, graceWeeks } = await getCycleConfig(db);

  const params = [];
  const conds = ['c.is_active = true'];
  if (staffId) { params.push(staffId); conds.push(`c.key_person_id = $${params.length}`); }
  if (onlyKeyed) conds.push('c.key_person_id IS NOT NULL');

  const { rows } = await db.query(`
    SELECT c.id AS child_id, c.first_name, c.last_name,
           c.first_name || ' ' || c.last_name AS name,
           c.room_id, r.name AS room_name,
           c.key_person_id,
           kp.first_name || ' ' || kp.last_name AS key_person_name,
           COALESCE(c.start_date, c.created_at::date) AS enrolled_date,
           t.last_date, t.last_obs_id
    FROM children c
    LEFT JOIN rooms r ON r.id = c.room_id
    LEFT JOIN staff kp ON kp.id = c.key_person_id
    LEFT JOIN LATERAL (
      SELECT o.created_at::date AS last_date, o.id AS last_obs_id
      FROM observations o
      WHERE o.child_id = c.id AND o.termly_update = true
      ORDER BY o.created_at DESC LIMIT 1
    ) t ON true
    WHERE ${conds.join(' AND ')}
    ORDER BY c.first_name, c.last_name
  `, params);

  const now = Date.now();
  const DAY = 86400000;
  const children = rows.map(row => {
    const lastDate = row.last_date ? new Date(row.last_date) : null;
    const enrolled = row.enrolled_date ? new Date(row.enrolled_date) : null;
    const daysSince    = lastDate ? Math.floor((now - lastDate.getTime()) / DAY) : null;
    const daysEnrolled = enrolled ? Math.floor((now - enrolled.getTime()) / DAY) : null;
    const status = classify(daysSince, daysEnrolled, cycleWeeks, graceWeeks);
    return {
      child_id: row.child_id,
      first_name: row.first_name,
      last_name: row.last_name,
      name: row.name,
      room_id: row.room_id,
      room_name: row.room_name,
      key_person_id: row.key_person_id,
      key_person_name: row.key_person_id ? row.key_person_name : null,
      last_termly_date: row.last_date || null,
      last_obs_id: row.last_obs_id || null,
      days_since: daysSince,
      status,
    };
  });

  return { cycleWeeks, graceWeeks, children };
}

module.exports = { getCycleConfig, classify, fetchTermlyStatuses };
