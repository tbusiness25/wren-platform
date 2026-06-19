/**
 * fire-safety.js — Fire drill log, equipment inspections, fire RA scaffolding
 */

const express  = require('express');
const router   = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

function isManager(req) {
  return ['manager','deputy_manager','admin'].includes(req.user?.role);
}

// ── Summary dashboard ─────────────────────────────────────────────────────────

router.get('/summary', async (req, res) => {
  try {
    const db = getPool();
    const [lastDrill, equipIssues, overdueEq] = await Promise.all([
      db.query(`
        SELECT fd.*,
          s.first_name||' '||s.last_name as conducted_by_name,
          sm.first_name||' '||sm.last_name as signed_off_by_name
        FROM fire_drills fd
        LEFT JOIN staff s  ON s.id=fd.conducted_by
        LEFT JOIN staff sm ON sm.id=fd.signed_off_by
        ORDER BY fd.drill_date DESC LIMIT 1
      `),
      db.query(`SELECT COUNT(*) as cnt FROM fire_equipment_log WHERE status!='ok'`),
      db.query(`
        SELECT COUNT(*) as cnt FROM fire_equipment_log
        WHERE next_service < CURRENT_DATE OR next_service IS NULL
      `),
    ]);

    const last = lastDrill.rows[0] || null;
    const daysSinceDrill = last
      ? Math.floor((Date.now() - new Date(last.drill_date)) / 86400000)
      : null;

    res.json({
      last_drill: last,
      days_since_drill: daysSinceDrill,
      drill_overdue: daysSinceDrill !== null && daysSinceDrill > 90,
      equipment_issues: parseInt(equipIssues.rows[0].cnt),
      equipment_service_overdue: parseInt(overdueEq.rows[0].cnt),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Drills ────────────────────────────────────────────────────────────────────

router.get('/drills', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT fd.*,
        s.first_name||' '||s.last_name as conducted_by_name,
        sm.first_name||' '||sm.last_name as signed_off_by_name
      FROM fire_drills fd
      LEFT JOIN staff s  ON s.id=fd.conducted_by
      LEFT JOIN staff sm ON sm.id=fd.signed_off_by
      ORDER BY fd.drill_date DESC LIMIT 100
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/drills', async (req, res) => {
  const {
    drill_date, drill_time, evacuation_time_seconds, all_accounted=true,
    issues_raised, action_taken, children_count, staff_count, notes,
  } = req.body;
  if (!drill_date || !drill_time) {
    return res.status(400).json({ error: 'drill_date and drill_time required' });
  }
  try {
    const db = getPool();
    // Next drill due = 3 months (termly frequency)
    const nextDue = new Date(drill_date);
    nextDue.setMonth(nextDue.getMonth() + 3);

    const { rows } = await db.query(`
      INSERT INTO fire_drills
        (drill_date, drill_time, evacuation_time_seconds, all_accounted,
         issues_raised, action_taken, children_count, staff_count, notes,
         conducted_by, next_drill_due)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
    `, [drill_date, drill_time, evacuation_time_seconds||null, all_accounted,
        issues_raised||null, action_taken||null, children_count||null, staff_count||null,
        notes||null, req.user.id, nextDue.toISOString().split('T')[0]]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/drills/:id/signoff', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE fire_drills SET signed_off_by=$1, signed_off_at=NOW()
      WHERE id=$2 RETURNING *
    `, [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Equipment log ─────────────────────────────────────────────────────────────

router.get('/equipment', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT fel.*,
        s.first_name||' '||s.last_name as created_by_name,
        fel.next_service < CURRENT_DATE as service_overdue
      FROM fire_equipment_log fel
      LEFT JOIN staff s ON s.id=fel.created_by
      ORDER BY fel.equipment_type, fel.location
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/equipment', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const {
    equipment_type, location, last_serviced, next_service,
    service_company, status='ok', notes,
  } = req.body;
  if (!equipment_type || !location) {
    return res.status(400).json({ error: 'equipment_type and location required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO fire_equipment_log
        (equipment_type, location, last_serviced, next_service,
         service_company, status, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [equipment_type, location, last_serviced||null, next_service||null,
        service_company||null, status, notes||null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/equipment/:id', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const {
    equipment_type, location, last_serviced, next_service,
    service_company, status, notes,
  } = req.body;
  try {
    const db = getPool();
    const updates = ['updated_at=NOW()'];
    const params = [];
    let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); }};
    add('equipment_type', equipment_type);
    add('location', location);
    add('last_serviced', last_serviced);
    add('next_service', next_service);
    add('service_company', service_company);
    add('status', status);
    add('notes', notes);
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE fire_equipment_log SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
