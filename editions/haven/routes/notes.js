'use strict';
// Haven — daily notes + shift handover
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');

router.use(authenticate);

// ── Daily notes ──────────────────────────────────────────────────────────────

// GET /daily?resident_id=&date=
router.get('/daily', async (req, res) => {
  try {
    const params = [];
    const where = ['1=1'];
    if (req.query.resident_id) { params.push(req.query.resident_id); where.push(`dn.resident_id = $${params.length}`); }
    if (req.query.date) { params.push(req.query.date); where.push(`dn.note_date = $${params.length}`); }
    const { rows } = await getPool().query(`
      SELECT dn.*, r.first_name, r.last_name,
             s.first_name AS recorded_by_first, s.last_name AS recorded_by_last
      FROM daily_notes dn
      JOIN residents r ON r.id = dn.resident_id
      LEFT JOIN staff s ON s.id = dn.recorded_by
      WHERE ${where.join(' AND ')}
      ORDER BY dn.recorded_at DESC LIMIT 300`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// POST /daily
router.post('/daily', requirePerm('basic_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.resident_id || !b.note) return res.status(400).json({ error: 'resident_id, note required' });
    const { rows } = await getPool().query(
      `INSERT INTO daily_notes (resident_id, note_date, category, note, recorded_by)
       VALUES ($1, COALESCE($2::date, CURRENT_DATE), COALESCE($3,'general'), $4, $5) RETURNING *`,
      [b.resident_id, b.note_date || null, b.category || null, b.note, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'daily_note', entity_id: rows[0].id,
      meta: { resident_id: b.resident_id } });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// ── Handover ─────────────────────────────────────────────────────────────────

// GET /handover?date=&shift=
router.get('/handover', async (req, res) => {
  try {
    const params = [req.query.date || new Date().toISOString().slice(0, 10)];
    const where = ['h.shift_date = $1'];
    if (req.query.shift) { params.push(req.query.shift); where.push(`h.shift = $${params.length}`); }
    const { rows } = await getPool().query(`
      SELECT h.*, r.first_name, r.last_name,
             s.first_name AS recorded_by_first, s.last_name AS recorded_by_last,
             a.first_name AS ack_first, a.last_name AS ack_last
      FROM handover_notes h
      LEFT JOIN residents r ON r.id = h.resident_id
      LEFT JOIN staff s ON s.id = h.recorded_by
      LEFT JOIN staff a ON a.id = h.acknowledged_by
      WHERE ${where.join(' AND ')}
      ORDER BY CASE h.priority WHEN 'urgent' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, h.created_at`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// POST /handover
router.post('/handover', requirePerm('basic_write'), async (req, res) => {
  try {
    const b = req.body || {};
    if (!['early','late','night'].includes(b.shift) || !b.note) {
      return res.status(400).json({ error: 'shift (early|late|night) and note required' });
    }
    const { rows } = await getPool().query(
      `INSERT INTO handover_notes (shift_date, shift, resident_id, note, priority, recorded_by)
       VALUES (COALESCE($1::date, CURRENT_DATE), $2, $3, $4, COALESCE($5,'normal'), $6) RETURNING *`,
      [b.shift_date || null, b.shift, b.resident_id || null, b.note, b.priority || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'handover_note', entity_id: rows[0].id });
    res.status(201).json(rows[0]);
  } catch (e) { fail(res, e); }
});

// PATCH /handover/:id/ack — acknowledge on incoming shift
router.patch('/handover/:id/ack', requirePerm('basic_write'), async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE handover_notes SET acknowledged_by = $1, acknowledged_at = now()
       WHERE id = $2 AND acknowledged_at IS NULL RETURNING *`,
      [req.user.id, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Note not found or already acknowledged' });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

module.exports = router;
