'use strict';
// Haven — safeguarding concerns (adult safeguarding, Care Act 2014 categories)
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
    if (req.query.status) { params.push(req.query.status); where.push(`sc.status = $${params.length}`); }
    if (req.query.resident_id) { params.push(req.query.resident_id); where.push(`sc.resident_id = $${params.length}`); }
    const { rows } = await getPool().query(`
      SELECT sc.*, r.first_name, r.last_name,
             s.first_name AS raised_by_first, s.last_name AS raised_by_last
      FROM safeguarding_concerns sc
      LEFT JOIN residents r ON r.id = sc.resident_id
      LEFT JOIN staff s ON s.id = sc.raised_by
      WHERE ${where.join(' AND ')}
      ORDER BY sc.raised_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// POST /
router.post('/', requirePerm('senior_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.concern_type || !b.description) {
      return res.status(400).json({ error: 'concern_type, description required' });
    }
    const { rows } = await getPool().query(
      `INSERT INTO safeguarding_concerns (resident_id, raised_at, concern_type, description,
         immediate_action, referred_to_la, la_reference, police_informed, cqc_notified, raised_by)
       VALUES ($1, COALESCE($2::timestamptz, now()), $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [b.resident_id || null, b.raised_at || null, b.concern_type, b.description,
       b.immediate_action || null, !!b.referred_to_la, b.la_reference || null,
       !!b.police_informed, !!b.cqc_notified, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'safeguarding_concern', entity_id: rows[0].id,
      meta: { concern_type: b.concern_type } });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /:id
router.patch('/:id', requirePerm('senior_write'), async (req, res) => {
  try {
    const b = req.body || {};
    const cols = ['concern_type','description','immediate_action','referred_to_la','la_reference',
      'police_informed','cqc_notified','outcome','status'].filter(c => b[c] !== undefined);
    if (!cols.length) return res.status(400).json({ error: 'No editable fields supplied' });
    const sets = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const { rows } = await getPool().query(
      `UPDATE safeguarding_concerns SET ${sets}, updated_at = now() WHERE id = $${cols.length + 1} RETURNING *`,
      [...cols.map(c => b[c]), req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Concern not found' });
    recordAudit({ req, action: 'update', entity_type: 'safeguarding_concern', entity_id: rows[0].id, meta: { fields: cols } });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

module.exports = router;
