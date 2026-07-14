'use strict';
// Haven — CQC statutory notifications log (Registration Regulations 2009, Regs 16–18)
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');

router.use(authenticate);

// GET /?status=
router.get('/', async (req, res) => {
  try {
    const params = [];
    const where = ['1=1'];
    if (req.query.status) { params.push(req.query.status); where.push(`n.status = $${params.length}`); }
    const { rows } = await getPool().query(`
      SELECT n.*, r.first_name, r.last_name,
             s.first_name AS created_by_first, s.last_name AS created_by_last
      FROM cqc_notifications n
      LEFT JOIN residents r ON r.id = n.resident_id
      LEFT JOIN staff s ON s.id = n.created_by
      WHERE ${where.join(' AND ')}
      ORDER BY n.event_date DESC, n.id DESC LIMIT 200`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// POST /
router.post('/', requirePerm('senior_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.notification_type || !b.event_date || !b.summary) {
      return res.status(400).json({ error: 'notification_type, event_date, summary required' });
    }
    const { rows } = await getPool().query(
      `INSERT INTO cqc_notifications (resident_id, notification_type, regulation, incident_id,
         safeguarding_id, event_date, summary, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8,'draft'), $9) RETURNING *`,
      [b.resident_id || null, b.notification_type, b.regulation || null, b.incident_id || null,
       b.safeguarding_id || null, b.event_date, b.summary, b.status || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'cqc_notification', entity_id: rows[0].id,
      meta: { type: b.notification_type } });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /:id — update / mark submitted
router.patch('/:id', requirePerm('senior_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const cols = ['notification_type','regulation','event_date','summary','status',
      'submitted_via','cqc_reference','incident_id','safeguarding_id'].filter(c => b[c] !== undefined);
    if (!cols.length && !b.mark_submitted) return res.status(400).json({ error: 'No editable fields supplied' });
    const sets = cols.map((c, i) => `${c} = $${i + 1}`);
    const params = cols.map(c => b[c]);
    if (b.mark_submitted) {
      sets.push(`submitted_at = now()`, `status = 'submitted'`);
    }
    params.push(req.params.id);
    const { rows } = await getPool().query(
      `UPDATE cqc_notifications SET ${sets.join(', ')}, updated_at = now()
       WHERE id = $${params.length} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: 'Notification not found' });
    recordAudit({ req, action: 'update', entity_type: 'cqc_notification', entity_id: rows[0].id,
      meta: { fields: cols, mark_submitted: !!b.mark_submitted } });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

module.exports = router;
