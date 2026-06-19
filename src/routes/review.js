'use strict';
// review.js — the Review / autonomy queue API (Hawk admin portal).
//
// Phase 1 of the 2031 automation vision (wren-docs/2031-automation-vision.md):
// AI-proposed or AI-edited content (CPD courses + assessment modules) lands here pending review.
// The manager Approves / Edits / Rejects. EVERY verdict is logged to ladn.decision_log via
// src/lib/decision-log.js with a scenario fingerprint, which feeds scripts/confidence-update.js ->
// ladn.decision_confidence. That is the "it remembers" learning hook — repeated consistent verdicts
// on the same scenario raise confidence so the scenario can later graduate Suggest -> Approve -> Auto.
//
// IMPORTANT: this surface only SUGGESTS / records approvals. Nothing auto-executes (that is a later
// phase). Everything is auditable (append-only decision_log) and reversible.

const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { logDecision } = require('../lib/decision-log');

router.use(authenticate);

const isManager = r => ['manager', 'deputy_manager', 'admin'].includes(r);
function requireManager(req, res, next) {
  if (!isManager(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  next();
}

// ── GET /api/review/queue ─────────────────────────────────────────────────────
// Everything pending the manager's review: AI-generated/edited CPD courses (status='review')
// and assessment modules (review_status='pending').
router.get('/queue', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const [{ rows: courses }, { rows: modules }] = await Promise.all([
      db.query(`
        SELECT c.id, c.name, c.description, c.category, c.is_mandatory, c.cpd_hours,
               c.created_by, c.created_at,
               (SELECT COUNT(*) FROM course_sections s WHERE s.course_id = c.id) AS section_count,
               (SELECT COUNT(*) FROM course_quiz_questions q WHERE q.course_id = c.id) AS question_count
        FROM courses c
        WHERE c.status = 'review'
        ORDER BY c.is_mandatory DESC, c.name
      `),
      db.query(`
        SELECT id, name, description, attaches_to, origin, created_at,
               jsonb_array_length(fields) AS field_count
        FROM modules
        WHERE review_status = 'pending'
        ORDER BY name
      `),
    ]);

    res.json({
      courses: courses.map(c => ({ ...c, item_type: 'course' })),
      modules: modules.map(m => ({ ...m, item_type: 'module' })),
      total: courses.length + modules.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/review/item/:type/:id ────────────────────────────────────────────
// Full preview of a pending item so the manager can read it before deciding.
router.get('/item/:type/:id', requireManager, async (req, res) => {
  const { type, id } = req.params;
  try {
    const db = getPool();
    if (type === 'course') {
      const { rows: c } = await db.query(`SELECT * FROM courses WHERE id=$1`, [id]);
      if (!c.length) return res.status(404).json({ error: 'Not found' });
      const [{ rows: sections }, { rows: questions }] = await Promise.all([
        db.query(`SELECT id, order_index, title, content_md, section_type
                  FROM course_sections WHERE course_id=$1 ORDER BY order_index`, [id]),
        db.query(`SELECT id, order_index, question_text, options, correct_index, explanation
                  FROM course_quiz_questions WHERE course_id=$1 ORDER BY order_index`, [id]),
      ]);
      return res.json({ item_type: 'course', course: c[0], sections, questions });
    }
    if (type === 'module') {
      const { rows: m } = await db.query(`SELECT * FROM modules WHERE id=$1`, [id]);
      if (!m.length) return res.status(404).json({ error: 'Not found' });
      return res.json({ item_type: 'module', module: m[0] });
    }
    return res.status(400).json({ error: 'Unknown type' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── The learning hook ─────────────────────────────────────────────────────────
// Write the manager's verdict to decision_log. category='cpd_suggestion' (allowed by the
// decision_log CHECK constraint). The input_context drives the scenario fingerprint
// (item_type + item_kind + origin + is_mandatory); the decision_made records the verdict +
// which fields were edited. confidence-update.js then aggregates per fingerprint.
async function logReviewDecision({ action, item_type, item_kind, origin, is_mandatory,
                                   editedFields = [], staffId, sourceTable, sourceId }) {
  return logDecision({
    category: 'cpd_suggestion',
    inputContext: { item_type, item_kind, origin: origin || 'ai_generated', is_mandatory: !!is_mandatory },
    optionsPresented: ['approve', 'edit', 'reject'],
    decisionMade: { action, edited_fields: editedFields },
    decidedByStaffId: staffId,
    decidedByAiModel: null,
    sourceTable,
    sourceId: parseInt(sourceId, 10) || null,
  });
}

// ── POST /api/review/:type/:id/approve ────────────────────────────────────────
// Publish the item as-is and log an 'approve' decision.
router.post('/:type/:id/approve', requireManager, async (req, res) => {
  const { type, id } = req.params;
  try {
    const db = getPool();
    let item_kind, origin, is_mandatory, name;

    if (type === 'course') {
      const { rows } = await db.query(
        `UPDATE courses SET status='published', published_at=NOW(),
           reviewed_by=$2, last_reviewed_at=NOW()
         WHERE id=$1 AND status='review'
         RETURNING id, name, category, is_mandatory, created_by`,
        [id, req.user.name || `staff:${req.user.id}`]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found or already reviewed' });
      ({ category: item_kind, is_mandatory, name } = rows[0]);
      origin = 'ai_generated';
    } else if (type === 'module') {
      const { rows } = await db.query(
        `UPDATE modules SET review_status='approved', is_active=true, updated_at=NOW(), updated_by=$2
         WHERE id=$1 AND review_status='pending'
         RETURNING id, name, attaches_to, origin`,
        [id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found or already reviewed' });
      item_kind = rows[0].attaches_to; origin = rows[0].origin || 'ai_generated';
      is_mandatory = false; name = rows[0].name;
    } else {
      return res.status(400).json({ error: 'Unknown type' });
    }

    const decisionId = await logReviewDecision({
      action: 'approve', item_type: type, item_kind, origin, is_mandatory,
      editedFields: [], staffId: req.user.id,
      sourceTable: type === 'course' ? 'courses' : 'modules', sourceId: id,
    });

    res.json({ ok: true, action: 'approve', name, decision_log_id: decisionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/review/:type/:id/reject ─────────────────────────────────────────
// Bin the item (soft — never DROP) and log a 'reject' decision.
router.post('/:type/:id/reject', requireManager, async (req, res) => {
  const { type, id } = req.params;
  const reason = (req.body && req.body.reason) || null;
  try {
    const db = getPool();
    let item_kind, origin, is_mandatory, name;

    if (type === 'course') {
      const { rows } = await db.query(
        `UPDATE courses SET status='rejected', reviewed_by=$2, last_reviewed_at=NOW()
         WHERE id=$1 AND status='review'
         RETURNING id, name, category, is_mandatory`,
        [id, req.user.name || `staff:${req.user.id}`]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found or already reviewed' });
      ({ category: item_kind, is_mandatory, name } = rows[0]);
      origin = 'ai_generated';
    } else if (type === 'module') {
      const { rows } = await db.query(
        `UPDATE modules SET review_status='rejected', is_active=false, updated_at=NOW(), updated_by=$2
         WHERE id=$1 AND review_status='pending'
         RETURNING id, name, attaches_to, origin`,
        [id, req.user.id]
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found or already reviewed' });
      item_kind = rows[0].attaches_to; origin = rows[0].origin || 'ai_generated';
      is_mandatory = false; name = rows[0].name;
    } else {
      return res.status(400).json({ error: 'Unknown type' });
    }

    const decisionId = await logReviewDecision({
      action: 'reject', item_type: type, item_kind, origin, is_mandatory,
      editedFields: reason ? ['_reason'] : [], staffId: req.user.id,
      sourceTable: type === 'course' ? 'courses' : 'modules', sourceId: id,
    });

    res.json({ ok: true, action: 'reject', name, decision_log_id: decisionId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/review/:type/:id/edit ───────────────────────────────────────────
// Save the manager's edits AND publish, logging an 'edit' decision recording which fields changed.
// Course-editable: name, description. Module-editable: name, description.
// (Field-level structural editing happens in Module Builder / Course editor; here we capture the
//  manager's headline corrections so the loop learns "manager renames AI courses" as a pattern.)
router.post('/:type/:id/edit', requireManager, async (req, res) => {
  const { type, id } = req.params;
  const body = req.body || {};
  try {
    const db = getPool();
    const editable = ['name', 'description'];
    const editedFields = [];

    if (type === 'course') {
      const { rows: cur } = await db.query(`SELECT name, description, category, is_mandatory FROM courses WHERE id=$1 AND status='review'`, [id]);
      if (!cur.length) return res.status(404).json({ error: 'Not found or already reviewed' });
      const sets = [], vals = [];
      for (const f of editable) {
        if (body[f] !== undefined && body[f] !== cur[0][f]) {
          vals.push(body[f]); sets.push(`${f}=$${vals.length}`); editedFields.push(f);
        }
      }
      vals.push(id);
      const publishClause = `status='published', published_at=NOW(), reviewed_by='${(req.user.name || ('staff:'+req.user.id)).replace(/'/g, "''")}', last_reviewed_at=NOW()`;
      const setSql = sets.length ? sets.join(', ') + ', ' + publishClause : publishClause;
      const { rows } = await db.query(
        `UPDATE courses SET ${setSql} WHERE id=$${vals.length} RETURNING id, name, category, is_mandatory`, vals);
      const decisionId = await logReviewDecision({
        action: 'edit', item_type: 'course', item_kind: rows[0].category, origin: 'ai_edited',
        is_mandatory: rows[0].is_mandatory, editedFields, staffId: req.user.id,
        sourceTable: 'courses', sourceId: id,
      });
      return res.json({ ok: true, action: 'edit', name: rows[0].name, edited_fields: editedFields, decision_log_id: decisionId });
    }

    if (type === 'module') {
      const { rows: cur } = await db.query(`SELECT name, description, attaches_to, origin FROM modules WHERE id=$1 AND review_status='pending'`, [id]);
      if (!cur.length) return res.status(404).json({ error: 'Not found or already reviewed' });
      const sets = [], vals = [];
      for (const f of editable) {
        if (body[f] !== undefined && body[f] !== cur[0][f]) {
          vals.push(body[f]); sets.push(`${f}=$${vals.length}`); editedFields.push(f);
        }
      }
      vals.push(req.user.id); const byIdx = vals.length;
      vals.push(id);
      const setSql = (sets.length ? sets.join(', ') + ', ' : '') +
        `review_status='approved', is_active=true, updated_at=NOW(), updated_by=$${byIdx}`;
      const { rows } = await db.query(
        `UPDATE modules SET ${setSql} WHERE id=$${vals.length} RETURNING id, name, attaches_to, origin`, vals);
      const decisionId = await logReviewDecision({
        action: 'edit', item_type: 'module', item_kind: rows[0].attaches_to,
        origin: 'ai_edited', is_mandatory: false, editedFields, staffId: req.user.id,
        sourceTable: 'modules', sourceId: id,
      });
      return res.json({ ok: true, action: 'edit', name: rows[0].name, edited_fields: editedFields, decision_log_id: decisionId });
    }

    return res.status(400).json({ error: 'Unknown type' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/review/decisions ─────────────────────────────────────────────────
// The audit/learning view: recent review verdicts + the confidence the loop has built per scenario.
router.get('/decisions', requireManager, async (req, res) => {
  try {
    const db = getPool();
    const { rows: decisions } = await db.query(`
      SELECT dl.id, dl.scenario_fingerprint, dl.input_context, dl.decision_made,
             dl.decided_by_staff_id, dl.source_table, dl.source_id,
             COALESCE(dl.decided_at, dl.created_at) AS at,
             s.first_name || ' ' || s.last_name AS staff_name,
             dc.sample_count, dc.consistent_decisions, dc.current_confidence
      FROM ladn.decision_log dl
      LEFT JOIN ladn.staff s ON s.id = dl.decided_by_staff_id
      LEFT JOIN ladn.decision_confidence dc
        ON dc.category = dl.category AND dc.scenario_fingerprint = dl.scenario_fingerprint
      WHERE dl.category = 'cpd_suggestion'
      ORDER BY COALESCE(dl.decided_at, dl.created_at) DESC
      LIMIT 100
    `);

    const { rows: confidence } = await db.query(`
      SELECT scenario_fingerprint, sample_count, consistent_decisions, current_confidence, last_updated
      FROM ladn.decision_confidence
      WHERE category = 'cpd_suggestion'
      ORDER BY current_confidence DESC, sample_count DESC
    `);

    res.json({ decisions, confidence });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
