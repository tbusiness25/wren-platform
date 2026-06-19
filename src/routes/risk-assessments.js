/**
 * risk-assessments.js — Risk assessment management to Evolve standard
 *
 * Covers: library templates, per-RA hazard list, sign-off chain
 * (creator → reviewer → headteacher/manager), expiry tracking,
 * RIDDOR-enhanced incident flag, PDF-ready data export.
 */

const express  = require('express');
const router   = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

function isManager(req) {
  return ['manager','deputy_manager','admin'].includes(req.user?.role);
}

// ── Templates ─────────────────────────────────────────────────────────────────

router.get('/templates', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM risk_assessment_templates WHERE is_active=true ORDER BY category, name'
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── List ──────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  const { status, category } = req.query;
  try {
    const db = getPool();
    const conds = [];
    const params = [];
    let pi = 1;
    if (status)   { conds.push(`ra.status=$${pi++}`);   params.push(status); }
    if (category) { conds.push(`ra.category=$${pi++}`); params.push(category); }
    const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT ra.*,
        s_c.first_name||' '||s_c.last_name as created_by_name,
        s_r.first_name||' '||s_r.last_name as reviewed_by_name,
        s_a.first_name||' '||s_a.last_name as approved_by_name,
        (ra.review_date < CURRENT_DATE) as is_expired,
        (ra.review_date BETWEEN CURRENT_DATE AND CURRENT_DATE+30) as review_due_soon,
        (SELECT COUNT(*) FROM risk_assessment_hazards h WHERE h.risk_assessment_id=ra.id) as hazard_count
      FROM risk_assessments ra
      LEFT JOIN staff s_c ON s_c.id=ra.created_by
      LEFT JOIN staff s_r ON s_r.id=ra.reviewed_by
      LEFT JOIN staff s_a ON s_a.id=ra.approved_by
      ${where}
      ORDER BY ra.review_date ASC NULLS LAST, ra.created_at DESC
      LIMIT 200
    `, params);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Single ────────────────────────────────────────────────────────────────────

router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const [ra, hazards] = await Promise.all([
      db.query(`
        SELECT ra.*,
          s_c.first_name||' '||s_c.last_name as created_by_name,
          s_r.first_name||' '||s_r.last_name as reviewed_by_name,
          s_a.first_name||' '||s_a.last_name as approved_by_name,
          t.name as template_name
        FROM risk_assessments ra
        LEFT JOIN staff s_c ON s_c.id=ra.created_by
        LEFT JOIN staff s_r ON s_r.id=ra.reviewed_by
        LEFT JOIN staff s_a ON s_a.id=ra.approved_by
        LEFT JOIN risk_assessment_templates t ON t.id=ra.template_id
        WHERE ra.id=$1
      `, [req.params.id]),
      db.query(
        'SELECT * FROM risk_assessment_hazards WHERE risk_assessment_id=$1 ORDER BY display_order, id',
        [req.params.id]
      ),
    ]);
    if (!ra.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...ra.rows[0], hazards: hazards.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Create ────────────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const {
    template_id, title, category='general', location, activity,
    persons_at_risk=[], assessment_date, review_date, notes, outing_id,
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO risk_assessments
        (template_id, title, category, location, activity, persons_at_risk,
         assessment_date, review_date, notes, outing_id, created_by, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft')
      RETURNING *
    `, [template_id||null, title, category, location||null, activity||null,
        persons_at_risk, assessment_date||null, review_date||null,
        notes||null, outing_id||null, req.user.id]);

    // If from template, copy hazards
    if (template_id) {
      const tmpl = await db.query(
        'SELECT hazards_template FROM risk_assessment_templates WHERE id=$1', [template_id]
      );
      const hazards = tmpl.rows[0]?.hazards_template || [];
      if (Array.isArray(hazards) && hazards.length) {
        for (let i = 0; i < hazards.length; i++) {
          const h = hazards[i];
          const text = typeof h === 'string' ? h : h.hazard || String(h);
          await db.query(`
            INSERT INTO risk_assessment_hazards
              (risk_assessment_id, hazard, display_order)
            VALUES ($1,$2,$3)
          `, [rows[0].id, text, i]);
        }
      }
    }

    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Update ────────────────────────────────────────────────────────────────────

router.put('/:id', async (req, res) => {
  const {
    title, location, activity, persons_at_risk, assessment_date,
    review_date, notes, severity_before, severity_after,
  } = req.body;
  try {
    const db = getPool();
    const updates = ['updated_at=NOW()'];
    const params = [];
    let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); }};
    add('title', title);
    add('location', location);
    add('activity', activity);
    add('persons_at_risk', persons_at_risk);
    add('assessment_date', assessment_date);
    add('review_date', review_date);
    add('notes', notes);
    add('severity_before', severity_before);
    add('severity_after', severity_after);
    params.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE risk_assessments SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Hazards CRUD ──────────────────────────────────────────────────────────────

router.get('/:id/hazards', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM risk_assessment_hazards WHERE risk_assessment_id=$1 ORDER BY display_order, id',
      [req.params.id]
    );
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/:id/hazards', async (req, res) => {
  const { hazard, who_at_risk, existing_controls, residual_risk='medium',
          additional_controls, responsible_person, display_order=0 } = req.body;
  if (!hazard) return res.status(400).json({ error: 'hazard required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO risk_assessment_hazards
        (risk_assessment_id, hazard, who_at_risk, existing_controls,
         residual_risk, additional_controls, responsible_person, display_order)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [req.params.id, hazard, who_at_risk||null, existing_controls||null,
        residual_risk, additional_controls||null, responsible_person||null, display_order]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id/hazards/:hid', async (req, res) => {
  const { hazard, who_at_risk, existing_controls, residual_risk,
          additional_controls, responsible_person } = req.body;
  try {
    const db = getPool();
    const updates = [];
    const params = [];
    let pi = 1;
    const add = (col, val) => { if (val !== undefined) { updates.push(`${col}=$${pi++}`); params.push(val); }};
    add('hazard', hazard);
    add('who_at_risk', who_at_risk);
    add('existing_controls', existing_controls);
    add('residual_risk', residual_risk);
    add('additional_controls', additional_controls);
    add('responsible_person', responsible_person);
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.hid, req.params.id);
    const { rows } = await db.query(
      `UPDATE risk_assessment_hazards SET ${updates.join(',')}
       WHERE id=$${pi} AND risk_assessment_id=$${pi+1} RETURNING *`, params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.delete('/:id/hazards/:hid', async (req, res) => {
  try {
    const db = getPool();
    await db.query(
      'DELETE FROM risk_assessment_hazards WHERE id=$1 AND risk_assessment_id=$2',
      [req.params.hid, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Submit for review ─────────────────────────────────────────────────────────

router.post('/:id/submit', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE risk_assessments SET status='submitted', updated_at=NOW()
      WHERE id=$1 AND created_by=$2 RETURNING *
    `, [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or not your RA' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Manager review ────────────────────────────────────────────────────────────

router.post('/:id/review', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const { notes } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE risk_assessments SET
        status='reviewed', reviewed_by=$1, reviewed_at=NOW(),
        notes=COALESCE(notes||E'\n\n','') || COALESCE($2,''),
        updated_at=NOW()
      WHERE id=$3 RETURNING *
    `, [req.user.id, notes||null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Approve ───────────────────────────────────────────────────────────────────

router.post('/:id/approve', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE risk_assessments SET
        status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
      WHERE id=$2 RETURNING *
    `, [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Expiring ──────────────────────────────────────────────────────────────────

router.get('/expiring/list', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ra.*,
        s.first_name||' '||s.last_name as created_by_name,
        ra.review_date - CURRENT_DATE as days_until_expiry
      FROM risk_assessments ra
      LEFT JOIN staff s ON s.id=ra.created_by
      WHERE ra.review_date IS NOT NULL
        AND ra.review_date <= CURRENT_DATE + $1
        AND ra.status='approved'
      ORDER BY ra.review_date ASC
    `, [days]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RIDDOR: incidents requiring report ───────────────────────────────────────

router.get('/riddor/reportable', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*,
        c.first_name||' '||c.last_name as child_name,
        s.first_name||' '||s.last_name as reporter_name
      FROM incidents i
      LEFT JOIN children c ON c.id=i.child_id
      LEFT JOIN staff s ON s.id=i.reported_by
      WHERE i.riddor_reportable=true
      ORDER BY i.created_at DESC LIMIT 100
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.put('/riddor/:incidentId/confirm', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  const { hse_ref, notes } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE incidents SET
        riddor_notified_at=NOW(),
        riddor_hse_ref=$1,
        follow_up_notes=COALESCE(follow_up_notes||E'\n','') || COALESCE($2,'')
      WHERE id=$3 RETURNING *
    `, [hse_ref||null, notes||null, req.params.incidentId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── RIDDOR export package ─────────────────────────────────────────────────────

router.get('/riddor/:incidentId/export', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*,
        c.first_name||' '||c.last_name as child_name,
        c.date_of_birth as child_dob,
        s.first_name||' '||s.last_name as reporter_name,
        sm.first_name||' '||sm.last_name as manager_name
      FROM incidents i
      LEFT JOIN children c ON c.id=i.child_id
      LEFT JOIN staff s ON s.id=i.reported_by
      LEFT JOIN staff sm ON sm.id=i.manager_signed_by
      WHERE i.id=$1
    `, [req.params.incidentId]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const i = rows[0];

    // RIDDOR F2508 equivalent fields
    res.json({
      riddor_export: {
        report_type: 'F2508 equivalent',
        setting_name: 'Your Nursery',
        setting_address: '123 Example Lane, Your Town, AB1 2CD',
        date_of_incident: i.incident_date,
        time_of_incident: i.incident_time,
        injured_person: i.child_name,
        date_of_birth: i.child_dob,
        nature_of_injury: i.injury_description,
        location_of_incident: i.location,
        cause_description: i.description,
        first_aid_given: i.first_aid_given,
        hospital_transfer: i.hospital_transfer,
        hospital_name: i.hospital_name,
        days_absence_expected: i.days_absence_expected,
        riddor_threshold_reason: i.riddor_threshold_reason,
        specified_injury: i.specified_injury,
        specified_injury_type: i.specified_injury_type,
        dangerous_occurrence: i.dangerous_occurrence,
        reported_by: i.reporter_name,
        manager_signed_by: i.manager_name,
        hse_ref: i.riddor_hse_ref,
        notified_at: i.riddor_notified_at,
        footer: 'This is a controlled health & safety record. Report to HSE at riddor.hse.gov.uk if threshold met.',
      }
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
