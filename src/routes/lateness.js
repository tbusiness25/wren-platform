'use strict';
/* ===========================================================================
 * lateness.js (route) — b309 (2026-09-10)
 *
 * "Who has been arriving late, and by how much." Nothing in Wren recorded this
 * before (wren-docs/research/reports/14-brighthr-parity.html, backlog item 9:
 * "No lateness field, flag or report in any route, lib or service").
 *
 * READ THIS BEFORE BELIEVING AN EMPTY REPORT
 * The only source of an arrival time is ladn.staff_clock_events — read through
 * ladn.staff_clock_events_current, so a corrected or voided tap cannot make
 * somebody late. b310 (2026-09-10) made that table real: the gate reader is an
 * 'in' device and every tap lands here. Until the fobs are physically issued it
 * still legitimately returns nothing, so every response carries a `source` block
 * saying how many clock events exist in the window — an empty report can never be
 * mistaken for "nobody was late".
 *
 * The maths lives in src/lib/lateness.js and is pure. This file only gathers:
 *   arrivals  — the FIRST clock_in per person per day, from staff_clock_events
 *   scheduled — rota_shifts.planned_start, falling back to the work pattern
 *   closed    — bank holidays + settings.closure_dates, via src/lib/closures.js,
 *               because nobody is late on a day the nursery was shut
 *
 * Manager-only for anything about another person; /my is the staff-facing view.
 * ===========================================================================*/

const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const LATE = require('../lib/lateness');

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const isManager = req => MANAGER_ROLES.includes(req.user && req.user.role);
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * The pattern tables number days 0=Mon…6=Sun (src/routes/work-patterns.js:48).
 * Postgres EXTRACT(DOW) is 0=Sun…6=Sat. Sunday is the only one that has to wrap.
 */
const PG_DOW_TO_PATTERN = `CASE WHEN EXTRACT(DOW FROM g.d)::int = 0 THEN 6 ELSE EXTRACT(DOW FROM g.d)::int - 1 END`;

/** Default window: the last 28 days, ending today. */
function windowFrom(q) {
  const to = isDate(q.to) ? q.to : new Date().toISOString().slice(0, 10);
  let from = isDate(q.from) ? q.from : null;
  if (!from) {
    const d = new Date(to + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 27);
    from = d.toISOString().slice(0, 10);
  }
  return from <= to ? { from, to } : { from: to, to: from };
}

async function graceMinutes(db) {
  try {
    const { rows } = await db.query("SELECT value FROM settings WHERE key='lateness_grace_minutes'");
    const n = rows.length ? Number(rows[0].value) : NaN;
    return Number.isFinite(n) && n >= 0 ? n : 5;
  } catch (_) { return 5; }
}

/** First clock_in per (staff, day) in the window. */
async function arrivals(db, from, to, staffId) {
  const params = [from, to];
  let staffClause = '';
  if (staffId) { params.push(staffId); staffClause = ` AND e.staff_id = $${params.length}`; }
  const { rows } = await db.query(`
    SELECT DISTINCT ON (e.staff_id, (e.event_time AT TIME ZONE 'Europe/London')::date)
           e.staff_id,
           (e.event_time AT TIME ZONE 'Europe/London')::date::text AS date,
           to_char(e.event_time AT TIME ZONE 'Europe/London', 'HH24:MI') AS time,
           e.method
      -- b310 — the _current view, not the base table. A tap that was corrected or
      -- voided (somebody else's fob, a mistap) must not still count as an arrival
      -- and must not make somebody late. The view drops superseded and voided rows.
      FROM staff_clock_events_current e
     WHERE e.event_type = 'clock_in'
       AND (e.event_time AT TIME ZONE 'Europe/London')::date BETWEEN $1::date AND $2::date
       ${staffClause}
     ORDER BY e.staff_id,
              (e.event_time AT TIME ZONE 'Europe/London')::date,
              e.event_time ASC`, params);
  return rows;
}

/** Scheduled starts: the published rota first, the contracted pattern second. */
async function scheduled(db, from, to, staffId) {
  const out = [];
  const params = [from, to];
  let staffClause = '';
  if (staffId) { params.push(staffId); staffClause = ` AND rs.staff_id = $${params.length}`; }

  // 1. The rota.
  try {
    const { rows } = await db.query(`
      SELECT rs.staff_id, rs.shift_date::text AS date,
             to_char(rs.planned_start, 'HH24:MI') AS start
        FROM rota_shifts rs
       WHERE rs.shift_date BETWEEN $1::date AND $2::date
         AND rs.planned_start IS NOT NULL
         AND COALESCE(rs.is_absent, false) = false
         AND COALESCE(rs.is_open, false)   = false
         AND rs.staff_id IS NOT NULL
         ${staffClause}`, params);
    for (const r of rows) out.push({ ...r, source: 'rota' });
  } catch (_) { /* rota_shifts absent on an older schema */ }

  // 2. The contracted pattern, for days the rota does not cover.
  const p2 = [from, to];
  let sc2 = '';
  if (staffId) { p2.push(staffId); sc2 = ` AND w.staff_id = $${p2.length}`; }
  try {
    const { rows } = await db.query(`
      SELECT w.staff_id, g.d::date::text AS date, to_char(w.shift_start, 'HH24:MI') AS start
        FROM generate_series($1::date, $2::date, interval '1 day') AS g(d)
        JOIN staff_work_patterns w
          ON w.day_of_week = ${PG_DOW_TO_PATTERN}
         AND COALESCE(w.is_off, false) = false
         AND w.shift_start IS NOT NULL
         AND w.effective_to IS NULL
         AND (w.effective_from IS NULL OR w.effective_from <= g.d)
       WHERE true ${sc2}`, p2);
    for (const r of rows) out.push({ ...r, source: 'work_pattern' });
  } catch (_) { /* staff_work_patterns absent — the rota alone will do */ }

  return out;
}

async function closedDates(db, from, to) {
  try {
    const closures = require('../lib/closures');
    const map = await closures.loadClosures(db, from, to);
    return new Set([...map.keys()]);
  } catch (_) { return new Set(); }
}

/** How much raw material exists — so an empty report is never mistaken for good news. */
async function sourceHealth(db, from, to) {
  const out = { clock_events_in_window: 0, clock_events_total: 0, clock_in_is_live: false,
    note: '' };
  try {
    const { rows } = await db.query(`
      SELECT COUNT(*) FILTER (WHERE (event_time AT TIME ZONE 'Europe/London')::date BETWEEN $1::date AND $2::date) AS win,
             COUNT(*) AS total
        FROM staff_clock_events_current WHERE event_type='clock_in'`, [from, to]);
    out.clock_events_in_window = Number(rows[0].win) || 0;
    out.clock_events_total     = Number(rows[0].total) || 0;
  } catch (_) { /* table absent */ }
  out.clock_in_is_live = out.clock_events_in_window > 0;
  out.note = out.clock_in_is_live
    ? `${out.clock_events_in_window} clock-in events in this window.`
    : 'No clock-in events in this window, so nothing can be judged late. Lateness is measured from ladn.staff_clock_events and clock-in is not live yet (b310). An empty report here means "no data", not "nobody was late".';
  return out;
}

/** The shared analysis, for whichever staff scope the caller is allowed. */
async function report(db, { from, to, staffId }) {
  const [grace, arr, sch, closed, health] = await Promise.all([
    graceMinutes(db),
    arrivals(db, from, to, staffId),
    scheduled(db, from, to, staffId),
    closedDates(db, from, to),
    sourceHealth(db, from, to),
  ]);
  const res = LATE.analyse({ arrivals: arr, scheduled: sch, graceMinutes: grace, closedDates: closed });
  return { from, to, grace_minutes: grace, source: health, ...res };
}

/** Attach names + any manager notes to a set of occurrences. */
async function decorate(db, result) {
  const ids = [...new Set([
    ...result.occurrences.map(o => o.staff_id),
    ...result.byStaff.map(s => s.staff_id),
    ...result.unscheduled.map(u => u.staff_id),
  ])];
  if (!ids.length) return result;
  const { rows: staff } = await db.query(
    'SELECT id, first_name || \' \' || last_name AS name, role FROM staff WHERE id = ANY($1::int[])', [ids]);
  const nameOf = new Map(staff.map(s => [s.id, s.name]));
  const roleOf = new Map(staff.map(s => [s.id, s.role]));

  let notes = [];
  try {
    const { rows } = await db.query(`
      SELECT staff_id, occurred_on::text AS date, reason, outcome, recorded_by
        FROM staff_lateness_notes
       WHERE staff_id = ANY($1::int[]) AND occurred_on BETWEEN $2::date AND $3::date`,
      [ids, result.from, result.to]);
    notes = rows;
  } catch (_) { /* table absent */ }
  const noteOf = new Map(notes.map(n => [`${n.staff_id}|${n.date}`, n]));

  result.occurrences = result.occurrences.map(o => ({
    ...o,
    staff_name: nameOf.get(o.staff_id) || `Staff #${o.staff_id}`,
    note: noteOf.get(`${o.staff_id}|${o.date}`) || null,
  }));
  result.unscheduled = result.unscheduled.map(u => ({
    ...u, staff_name: nameOf.get(u.staff_id) || `Staff #${u.staff_id}`,
  }));
  result.byStaff = result.byStaff.map(s => ({
    ...s,
    staff_name: nameOf.get(s.staff_id) || `Staff #${s.staff_id}`,
    role: roleOf.get(s.staff_id) || null,
    average_minutes: s.occurrences ? Math.round((s.total_minutes / s.occurrences) * 10) / 10 : 0,
  }));
  return result;
}

// GET / — the whole-team report. Manager only.
router.get('/', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const { from, to } = windowFrom(req.query);
  try {
    const db = getPool();
    const r = await report(db, { from, to });
    res.json(await decorate(db, r));
  } catch (e) {
    console.error('[lateness]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /my — your own arrivals.
router.get('/my', async (req, res) => {
  const { from, to } = windowFrom(req.query);
  try {
    const db = getPool();
    const r = await report(db, { from, to, staffId: req.user.id });
    res.json(await decorate(db, r));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /staff/:staffId
router.get('/staff/:staffId', async (req, res) => {
  const staffId = parseInt(req.params.staffId, 10);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staffId must be a number' });
  if (!isManager(req) && staffId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  const { from, to } = windowFrom(req.query);
  try {
    const db = getPool();
    const r = await report(db, { from, to, staffId });
    res.json(await decorate(db, r));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /note — record why somebody was late, and what was done about it.
// Body: { staff_id, date, reason, outcome, minutes_late? }
router.put('/note', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  const staffId = parseInt(b.staff_id, 10);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staff_id required' });
  if (!isDate(b.date))            return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });
  const outcome = ['authorised', 'unauthorised', 'discussed', 'escalated'].includes(b.outcome) ? b.outcome : null;
  try {
    const { rows } = await getPool().query(`
      INSERT INTO staff_lateness_notes (staff_id, occurred_on, minutes_late, reason, outcome, recorded_by, updated_at)
      VALUES ($1,$2::date,$3,$4,$5,$6,now())
      ON CONFLICT (staff_id, occurred_on) DO UPDATE
        SET minutes_late = COALESCE(EXCLUDED.minutes_late, staff_lateness_notes.minutes_late),
            reason  = COALESCE(EXCLUDED.reason,  staff_lateness_notes.reason),
            outcome = COALESCE(EXCLUDED.outcome, staff_lateness_notes.outcome),
            recorded_by = EXCLUDED.recorded_by, updated_at = now()
      RETURNING *`,
      [staffId, b.date,
       Number.isFinite(Number(b.minutes_late)) ? Math.round(Number(b.minutes_late)) : null,
       (b.reason || '').slice(0, 1000) || null, outcome, req.user.id]);
    res.json(rows[0]);
  } catch (e) {
    console.error('[lateness/note]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
