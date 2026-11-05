'use strict';
const { getPool } = require('../db/pool');
const { fingerprintScenario } = require('./decision-fingerprint');

async function logDecision(args) {
  const {
    category,
    inputContext,
    optionsPresented = [],
    decisionMade = null,
    decidedByAiModel = null,
    decidedByStaffId = null,
    sourceTable = null,
    sourceId = null,
    relatedChildId = null,
    relatedStaffId = null,
  } = args;

  const fp = fingerprintScenario(category, inputContext);
  const pool = getPool();

  const r = await pool.query(`
    INSERT INTO decision_log
      (category, scenario_fingerprint, input_context, options_presented, decision_made,
       decided_by_ai_model, decided_by_staff_id, source_table, source_id,
       related_child_id, related_staff_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id
  `, [
    category,
    fp,
    JSON.stringify(inputContext),
    JSON.stringify(optionsPresented),
    decisionMade ? JSON.stringify(decisionMade) : null,
    decidedByAiModel,
    decidedByStaffId,
    sourceTable,
    sourceId,
    relatedChildId,
    relatedStaffId,
  ]);

  return r.rows[0].id;
}

async function completeDecision(id, args) {
  const { decisionMade, decidedByStaffId = null, wasAuto = false, outcome = {} } = args;
  const pool = getPool();
  await pool.query(`
    UPDATE decision_log SET
      decision_made       = $1,
      decided_by_staff_id = COALESCE($2, decided_by_staff_id),
      was_auto            = $3,
      outcome             = $4,
      decided_at          = NOW()
    WHERE id = $5
  `, [JSON.stringify(decisionMade), decidedByStaffId, wasAuto, JSON.stringify(outcome), id]);
}

async function undoDecision(id, args = {}) {
  const { reason = null } = args;
  const pool = getPool();
  await pool.query(
    `UPDATE decision_log SET undo_at = NOW(), undo_reason = $1 WHERE id = $2`,
    [reason, id]
  );
}

module.exports = { logDecision, completeDecision, undoDecision };
