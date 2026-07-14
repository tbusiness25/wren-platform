'use strict';
// Haven — clinical scoring (MUST / Waterlow / NEWS2 / falls) with server-side auto-calculation.
// The server is the single source of truth for scores: clients submit raw inputs only.
const express = require('express');
const router = express.Router();
const { getPool } = require('../../../src/db/pool');
const authenticate = require('../../../src/middleware/auth');
const { requirePerm, fail } = require('../lib/permissions');
const { recordAudit } = require('../../../src/utils/audit');
const { scoreTool, TOOLS } = require('../lib/scoring');

router.use(authenticate);

// GET /tools — available tools (for UI form building)
router.get('/tools', (req, res) => res.json(Object.keys(TOOLS)));

// POST /preview — calculate without saving (live form feedback)
router.post('/preview', (req, res) => {
  try {
    const { tool, inputs } = req.body || {};
    res.json(scoreTool(tool, inputs));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// GET /?resident_id=&tool=
router.get('/', async (req, res) => {
  try {
    const params = [];
    const where = ['1=1'];
    if (req.query.resident_id) { params.push(req.query.resident_id); where.push(`cs.resident_id = $${params.length}`); }
    if (req.query.tool) { params.push(req.query.tool); where.push(`cs.tool = $${params.length}`); }
    const { rows } = await getPool().query(`
      SELECT cs.*, r.first_name, r.last_name,
             s.first_name AS scored_by_first, s.last_name AS scored_by_last
      FROM clinical_scores cs
      JOIN residents r ON r.id = cs.resident_id
      LEFT JOIN staff s ON s.id = cs.scored_by
      WHERE ${where.join(' AND ')}
      ORDER BY cs.scored_at DESC LIMIT 200`, params);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// GET /latest?resident_id= — latest score per tool for a resident
router.get('/latest', async (req, res) => {
  try {
    if (!req.query.resident_id) return res.status(400).json({ error: 'resident_id required' });
    const { rows } = await getPool().query(`
      SELECT DISTINCT ON (tool) tool, id, score, band, escalation, scored_at, inputs, breakdown
      FROM clinical_scores WHERE resident_id = $1
      ORDER BY tool, scored_at DESC`, [req.query.resident_id]);
    res.json(rows);
  } catch (e) { fail(res, e); }
});

// POST / — score and save. Body: { resident_id, tool, inputs }
router.post('/', requirePerm('clinical_write'), async (req, res) => {
  try {
    const { resident_id, tool, inputs } = req.body || {};
    if (!resident_id) return res.status(400).json({ error: 'resident_id required' });
    let result;
    try {
      result = scoreTool(tool, inputs);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const { rows } = await getPool().query(
      `INSERT INTO clinical_scores (resident_id, tool, inputs, score, band, breakdown, escalation, scored_by, scored_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, COALESCE($9::timestamptz, now())) RETURNING *`,
      [resident_id, String(tool).toLowerCase(), JSON.stringify(inputs),
       result.score, result.band, JSON.stringify(result.breakdown),
       result.escalation, req.user.id, req.body.scored_at || null]);
    recordAudit({ req, action: 'create', entity_type: 'clinical_score', entity_id: rows[0].id,
      meta: { resident_id, tool, score: result.score, band: result.band } });
    res.status(201).json({ ...rows[0], red_flags: result.red_flags });
  } catch (e) { fail(res, e); }
});

module.exports = router;
