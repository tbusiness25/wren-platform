'use strict';
// Haven — body map entries (front/back SVG click-to-mark; x/y stored as % of image)
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');

router.use(authenticate);

// GET /?resident_id=&active=1
router.get('/', async (req, res) => {
  try {
    const params = [];
    const where = ['1=1'];
    if (req.query.resident_id) { params.push(req.query.resident_id); where.push(`b.resident_id = $${params.length}`); }
    if (req.query.active === '1') where.push('b.resolved_at IS NULL');
    const { rows } = await getPool().query(`
      SELECT b.*, r.first_name, r.last_name,
             s.first_name AS recorded_by_first, s.last_name AS recorded_by_last
      FROM body_map_entries b
      JOIN residents r ON r.id = b.resident_id
      LEFT JOIN staff s ON s.id = b.recorded_by
      WHERE ${where.join(' AND ')}
      ORDER BY b.observed_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// POST /
router.post('/', requirePerm('basic_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.resident_id || !['front','back'].includes(b.side)
        || b.x_pct === undefined || b.y_pct === undefined || !b.mark_type) {
      return res.status(400).json({ error: 'resident_id, side (front|back), x_pct, y_pct, mark_type required' });
    }
    const x = Number(b.x_pct), y = Number(b.y_pct);
    if (!(x >= 0 && x <= 100 && y >= 0 && y <= 100)) {
      return res.status(400).json({ error: 'x_pct/y_pct must be 0–100' });
    }
    const { rows } = await getPool().query(
      `INSERT INTO body_map_entries (resident_id, side, x_pct, y_pct, mark_type, note,
         incident_id, observed_at, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8::timestamptz, now()), $9) RETURNING *`,
      [b.resident_id, b.side, x, y, b.mark_type, b.note || null,
       b.incident_id || null, b.observed_at || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'body_map_entry', entity_id: rows[0].id,
      meta: { resident_id: b.resident_id, mark_type: b.mark_type, side: b.side } });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /:id/resolve — mark healed/resolved
router.patch('/:id/resolve', requirePerm('basic_write'), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE body_map_entries SET resolved_at = now() WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Entry not found or already resolved' });
    recordAudit({ req, action: 'update', entity_type: 'body_map_entry', entity_id: rows[0].id, meta: { resolved: true } });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

module.exports = router;
