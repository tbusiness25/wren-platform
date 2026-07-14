'use strict';
// Haven — incidents (falls, injuries, near misses) with RIDDOR flag
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');

router.use(authenticate);

// GET /?resident_id=&status=&riddor=1
router.get('/', async (req, res) => {
  try {
    const params = [];
    const where = ['1=1'];
    if (req.query.resident_id) { params.push(req.query.resident_id); where.push(`i.resident_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`i.status = $${params.length}`); }
    if (req.query.riddor === '1') where.push('i.riddor_reportable = true');
    const { rows } = await getPool().query(`
      SELECT i.*, r.first_name, r.last_name,
             s.first_name AS reporter_first, s.last_name AS reporter_last
      FROM incidents i
      LEFT JOIN residents r ON r.id = i.resident_id
      LEFT JOIN staff s ON s.id = i.reported_by
      WHERE ${where.join(' AND ')}
      ORDER BY i.occurred_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT i.*, r.first_name, r.last_name,
             s.first_name AS reporter_first, s.last_name AS reporter_last
      FROM incidents i
      LEFT JOIN residents r ON r.id = i.resident_id
      LEFT JOIN staff s ON s.id = i.reported_by
      WHERE i.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found' });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

// POST /
router.post('/', requirePerm('basic_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.occurred_at || !b.incident_type || !b.description) {
      return res.status(400).json({ error: 'occurred_at, incident_type, description required' });
    }
    const { rows } = await getPool().query(
      `INSERT INTO incidents (resident_id, occurred_at, location, incident_type, description,
         injury_sustained, injury_details, treatment_given, witnesses,
         riddor_reportable, riddor_reference, cqc_notification_required,
         nok_informed, gp_informed, actions_taken, reported_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [b.resident_id || null, b.occurred_at, b.location || null, b.incident_type, b.description,
       !!b.injury_sustained, b.injury_details || null, b.treatment_given || null, b.witnesses || null,
       !!b.riddor_reportable, b.riddor_reference || null, !!b.cqc_notification_required,
       !!b.nok_informed, !!b.gp_informed, b.actions_taken || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'incident', entity_id: rows[0].id,
      meta: { riddor: !!b.riddor_reportable, type: b.incident_type } });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /:id
router.patch('/:id', requirePerm('admin_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const cols = ['location','incident_type','description','injury_sustained','injury_details',
      'treatment_given','witnesses','riddor_reportable','riddor_reference',
      'cqc_notification_required','nok_informed','gp_informed','actions_taken','status']
      .filter(c => b[c] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No editable fields supplied' });
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const { rows } = await getPool().query(
      `UPDATE incidents SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map(c => b[c]), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Incident not found' });
    recordAudit({ req, action: 'update', entity_type: 'incident', entity_id: rows[0].id, meta: { fields: cols } });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

module.exports = router;
