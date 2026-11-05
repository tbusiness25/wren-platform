'use strict';
// b335 (2026-09-15) — The concern pathway API.
//
// Roost /pathways.html is the full screen (search a child, start a pathway,
// tick off stages, attach evidence, close it). EY /ey/pathways.html is a
// READ-ONLY room view for the key person (GET routes only, per the brief).
//
// Depends on b334's duty tracker existing first (src/lib/duties) — this file
// does not touch it, but the manager digest (scripts/b335-manager-digest.js)
// reads both.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = authenticate;
const P = require('../lib/pathways');

router.use(authenticate);

// GET /api/pathways/templates
router.get('/templates', async (req, res) => {
  const db = getPool();
  try {
    const { rows: templates } = await db.query(
      `SELECT * FROM pathway_templates WHERE is_active=true ORDER BY label`);
    for (const t of templates) t.stages = await P.templateStages(db, t.id);
    res.json(templates);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pathways/child/:childId — this child's pathways (open by default).
router.get('/child/:childId', async (req, res) => {
  const db = getPool();
  try {
    const includeClosed = req.query.include_closed === '1';
    const pathways = await P.childPathways(db, Number(req.params.childId), { includeClosedStatus: includeClosed });
    res.json({ child_id: Number(req.params.childId), pathways });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/pathways/room/:roomId — every open pathway for children in a room
// (the EY read-only view groups by child itself; this is the one query it needs).
router.get('/room/:roomId', async (req, res) => {
  const db = getPool();
  try {
    const { rows: children } = await db.query(
      `SELECT DISTINCT c.id, c.first_name, c.first_name || ' ' || c.last_name AS name
         FROM children c
         JOIN child_pathways cp ON cp.child_id = c.id AND cp.status='open'
        WHERE c.room_id=$1 AND c.is_active=true
        ORDER BY c.first_name`, [Number(req.params.roomId)]);
    const out = [];
    for (const c of children) {
      const pathways = await P.childPathways(db, c.id);
      out.push({ child_id: c.id, child_name: c.name, pathways });
    }
    res.json({ room_id: Number(req.params.roomId), children: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/pathways/start — from a safeguarding concern, a SEN register entry, or by hand.
router.post('/start', async (req, res) => {
  const db = getPool();
  const { child_id, template_key, started_reason, source_table, source_id } = req.body || {};
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  const allowedSourceTables = new Set(['safeguarding_concerns', 'sen_register']);
  try {
    const pathway = await P.startPathway(db, {
      childId: Number(child_id),
      templateKey: template_key || 'child_concern',
      startedBy: req.user.id,
      startedReason: started_reason || null,
      sourceTable: allowedSourceTables.has(source_table) ? source_table : null,
      sourceId: allowedSourceTables.has(source_table) ? (source_id || null) : null,
    });
    const [full] = await P.childPathways(db, Number(child_id));
    res.status(201).json(full || pathway);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/pathways/:pathwayId/stages/:stageId/complete
router.post('/:pathwayId/stages/:stageId/complete', async (req, res) => {
  const db = getPool();
  const { notes, evidence_table, evidence_id, evidence_note } = req.body || {};
  try {
    const { rows: own } = await db.query(
      `SELECT id FROM child_pathway_stages WHERE id=$1 AND child_pathway_id=$2`,
      [Number(req.params.stageId), Number(req.params.pathwayId)]);
    if (!own.length) return res.status(404).json({ error: 'Stage not found on this pathway' });
    const row = await P.completeStage(db, {
      childPathwayStageId: Number(req.params.stageId), staffId: req.user.id,
      notes, evidenceTable: evidence_table || null, evidenceId: evidence_id || null,
      evidenceNote: evidence_note || null,
    });
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/pathways/:pathwayId/stages/:stageId/skip — "if needed" stages only.
router.post('/:pathwayId/stages/:stageId/skip', async (req, res) => {
  const db = getPool();
  const { notes } = req.body || {};
  try {
    const { rows: own } = await db.query(
      `SELECT id FROM child_pathway_stages WHERE id=$1 AND child_pathway_id=$2`,
      [Number(req.params.stageId), Number(req.params.pathwayId)]);
    if (!own.length) return res.status(404).json({ error: 'Stage not found on this pathway' });
    const row = await P.skipStage(db, {
      childPathwayStageId: Number(req.params.stageId), staffId: req.user.id, notes,
    });
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// POST /api/pathways/:pathwayId/close — manager only: formally ends the record.
router.post('/:pathwayId/close', requireRole('manager'), async (req, res) => {
  const db = getPool();
  const { reason } = req.body || {};
  try {
    const row = await P.closePathway(db, {
      childPathwayId: Number(req.params.pathwayId), staffId: req.user.id, reason,
    });
    res.json(row);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
