'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const PA_SELECT = `
  SELECT pa.*,
    c.first_name || ' ' || c.last_name AS child_name,
    c.first_name AS child_first_name,
    r.name AS room_name,
    s.first_name || ' ' || s.last_name AS led_by_name,
    ns.description AS next_step_description,
    ns.status AS next_step_status,
    src_obs.observation_text AS source_obs_text,
    src_obs.created_at AS source_obs_date,
    hap_obs.observation_text AS happened_obs_text
  FROM planned_activities pa
  LEFT JOIN children c ON c.id = pa.child_id
  LEFT JOIN rooms r ON r.id = c.room_id OR r.id = pa.room_id
  LEFT JOIN staff s ON s.id = pa.led_by
  LEFT JOIN next_steps ns ON ns.id = pa.next_step_id
  LEFT JOIN observations src_obs ON src_obs.id = pa.source_observation_id
  LEFT JOIN observations hap_obs ON hap_obs.id = pa.happened_observation_id
`;

function parseWeekRange(str) {
  const now = new Date();
  if (str === 'this_week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 6);
    return [mon.toISOString().slice(0, 10), fri.toISOString().slice(0, 10)];
  }
  if (str === 'next_week') {
    const mon = new Date(now);
    mon.setDate(now.getDate() - ((now.getDay() + 6) % 7) + 7);
    const fri = new Date(mon);
    fri.setDate(mon.getDate() + 6);
    return [mon.toISOString().slice(0, 10), fri.toISOString().slice(0, 10)];
  }
  return null;
}

// GET / — filterable list
router.get('/', async (req, res) => {
  const { scope, child_id, room_id, date_range, date_from, date_to, status, limit = 100 } = req.query;
  const db = getPool();
  let sql = PA_SELECT + ' WHERE 1=1';
  const params = [];
  if (scope)    { params.push(scope);    sql += ` AND pa.scope=$${params.length}`; }
  if (child_id) { params.push(child_id); sql += ` AND pa.child_id=$${params.length}`; }
  if (room_id)  { params.push(room_id);  sql += ` AND (pa.room_id=$${params.length} OR c.room_id=$${params.length})`; }
  if (status)   { params.push(status);   sql += ` AND pa.status=$${params.length}`; }
  const wr = date_range ? parseWeekRange(date_range) : null;
  const from = wr ? wr[0] : date_from;
  const to   = wr ? wr[1] : date_to;
  if (from) { params.push(from); sql += ` AND pa.plan_date >= $${params.length}::date`; }
  if (to)   { params.push(to);   sql += ` AND pa.plan_date <= $${params.length}::date`; }
  params.push(Math.min(parseInt(limit) || 100, 500));
  sql += ` ORDER BY pa.plan_date ASC NULLS LAST, pa.id DESC LIMIT $${params.length}`;
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(PA_SELECT + ' WHERE pa.id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — create planned activity
router.post('/', async (req, res) => {
  const {
    scope, child_id, room_id, next_step_id, source_observation_id,
    plan_date, slot, led_by, title, description, activity_id
  } = req.body;

  if (scope === 'individual' && !child_id)
    return res.status(400).json({ error: 'child_id required for individual scope' });

  const db = getPool();
  try {
    const { rows } = await db.query(`
      INSERT INTO planned_activities
        (scope, child_id, room_id, next_step_id, source_observation_id,
         plan_date, slot, led_by, title, description, activity_id, status, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
         (SELECT id FROM curriculum_activities WHERE id=$11),'planned',NOW())
      RETURNING *
    `, [scope || 'group', child_id || null, room_id || null,
        next_step_id || null, source_observation_id || null,
        plan_date || null, slot || null,
        led_by || req.user.id,
        title || null, description || null,
        activity_id || null]);

    const pa = rows[0];

    // If created from a next_step, mark that as planned
    if (next_step_id) {
      await db.query(`
        UPDATE next_steps SET status='planned', planned_activity_id=$1, updated_at=NOW()
        WHERE id=$2
      `, [pa.id, next_step_id]);
    }

    res.status(201).json(pa);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/happened — mark as happened, link to observation
router.post('/:id/happened', async (req, res) => {
  const { observation_id } = req.body;
  const db = getPool();
  try {
    const { rows } = await db.query(`
      UPDATE planned_activities
        SET status='happened', happened_observation_id=$1, updated_at=NOW()
      WHERE id=$2
      RETURNING *
    `, [observation_id || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    // If the activity links a next_step, mark that completed too
    const pa = rows[0];
    if (pa.next_step_id && observation_id) {
      await db.query(`
        UPDATE next_steps
          SET status='completed', completed_observation_id=$1, updated_at=NOW()
        WHERE id=$2 AND status != 'completed'
      `, [observation_id, pa.next_step_id]);
    }

    res.json(pa);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /:id — update status or details
router.patch('/:id', async (req, res) => {
  const { status, plan_date, slot, led_by, title, description } = req.body;
  const VALID = new Set(['planned','happened','cancelled','overdue']);
  if (status && !VALID.has(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const { rows } = await getPool().query(`
      UPDATE planned_activities SET
        status      = COALESCE($1, status),
        plan_date   = COALESCE($2::date, plan_date),
        slot        = COALESCE($3, slot),
        led_by      = COALESCE($4::int, led_by),
        title       = COALESCE($5, title),
        description = COALESCE($6, description),
        updated_at  = NOW()
      WHERE id=$7
      RETURNING *
    `, [status || null, plan_date || null, slot || null,
        led_by || null, title || null, description || null,
        req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
