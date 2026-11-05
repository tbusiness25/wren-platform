'use strict';
/**
 * inspection-toolkit.js — b356 (2026-09-24). Mounted at /api/inspection-toolkit.
 *
 * The EYFS inspection self-evaluation toolkit: every judgement area, what an inspector looks
 * for, and — the thing no competitor can do — what Wren already knows against each point,
 * pulled live from real data. Plus a space for the setting's own written answer, saved and
 * versioned. Manager-only (this is a leadership tool, same class as the Setting Report Card
 * this file complements — see src/routes/inspection.js, whose computeReadiness() this reuses
 * for the DSL/DBS/mandatory-training evidence rather than re-scoring those checks here).
 *
 * ⚠️ Seeded criterion wording (migrations/2026-09-24b-b356-...sql) is a SCAFFOLD, not a
 * transcription of Ofsted's own toolkit document — see the b356 NOTES. The mechanism below
 * (evidence, self-eval, versioning, RAG) works regardless of the exact wording.
 *
 * Deliberately NOT CPD: this is what the SETTING can evidence, not what an individual has
 * learned. Deliberately not a rewrite of the Setting Report Card: that answers "are we
 * compliant"; this answers "how would we evidence this to an inspector, and what do we think".
 *
 *   GET  /areas                      full toolkit — areas, criteria, current answers, live evidence
 *   PUT  /criteria/:id/answer        { body } — save the setting's own answer (versioned)
 *   GET  /criteria/:id/history       every previous version of an answer
 *   GET  /export                     the whole toolkit as JSON, for printing/keeping outside Wren
 */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { isRoostAllowed } = require('../lib/roost-allowlist');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
let computeReadiness = null;
try { ({ computeReadiness } = require('./inspection')); } catch { /* inspection.js not present in some editions */ }

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher', 'room_leader'];
const isManager = req => Number(req.user.id) === 1 || hasRole(req.user, MANAGER_ROLES);
const managerOnly = async (req, res, next) => {
  const no = () => res.status(403).json({ error: 'Management access required' });
  if (!isManager(req)) return no();
  let ok;
  try { ok = await isRoostAllowed(req.user.id); } catch { ok = Number(req.user.id) === 1; }
  return ok ? next() : no();
};
router.use(managerOnly);

const schemaMissing = e => e && (e.code === '42P01' || e.code === '42703');
function notApplied(res) {
  return res.status(503).json({
    error: 'schema_not_applied',
    message: 'The inspection toolkit tables are not present. Apply migrations/2026-09-24b-b356-recognition-inspection-parent-voice.sql.',
  });
}
function fail(res, e, what) {
  if (schemaMissing(e)) return notApplied(res);
  console.error(`[inspection-toolkit] ${what} failed:`, e && (e.code || 'error'));
  return res.status(500).json({ error: 'Something went wrong.' });
}

// ── evidence dispatcher — "what Wren already knows" against a criterion ───────────────────────
// Every branch is defensive: a metric that cannot be computed (table missing, no rows) answers
// null rather than throwing, so one broken metric never takes down the whole toolkit page.
const READINESS_DELEGATE = { dsl_training: 'dsl-training', dbs_checks: 'dbs-checks', mandatory_training: 'mandatory-training' };
async function evidenceFor(db, schema, key) {
  const s = schema || 'ladn';
  try {
    if (READINESS_DELEGATE[key]) {
      if (!computeReadiness) return null;
      const readiness = await computeReadiness(db, s);
      const cat = readiness.categories.find(c => c.id === READINESS_DELEGATE[key]);
      if (!cat) return null;
      return { kind: 'score', value: cat.score, max: cat.max, rag: cat.rag, label: cat.label, issues: cat.issues };
    }
    if (key === 'observation_count_30d') {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${s}.observations WHERE created_at > now() - interval '30 days'`);
      return { kind: 'count', value: rows[0].n, label: `${rows[0].n} observation${rows[0].n === 1 ? '' : 's'} recorded in the last 30 days` };
    }
    if (key === 'safeguarding_open_concerns') {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${s}.safeguarding_concerns WHERE status IN ('new','under_review')`);
      return { kind: 'count', value: rows[0].n, label: `${rows[0].n} open safeguarding concern${rows[0].n === 1 ? '' : 's'}`, rag: rows[0].n > 0 ? 'amber' : 'green' };
    }
    if (key === 'sen_active_count') {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${s}.sen_register WHERE is_active IS NOT FALSE`);
      return { kind: 'count', value: rows[0].n, label: `${rows[0].n} child${rows[0].n === 1 ? '' : 'ren'} on the SEN register with a provision plan` };
    }
    if (key === 'ratio_compliance_90d') {
      const { rows } = await db.query(
        `SELECT count(*) FILTER (WHERE ratio_ok) AS ok, count(*) AS total FROM ${s}.room_headcounts
          WHERE status = 'completed' AND completed_at > now() - interval '90 days'`);
      const ok = Number(rows[0].ok || 0), total = Number(rows[0].total || 0);
      if (!total) return { kind: 'count', value: null, label: 'No completed ratio headcounts in the last 90 days' };
      const pct = Math.round((100 * ok) / total);
      return { kind: 'pct', value: pct, label: `${pct}% of ${total} completed headcounts met ratio in the last 90 days`, rag: pct >= 95 ? 'green' : pct >= 80 ? 'amber' : 'red' };
    }
    if (key === 'supervision_completion') {
      const { rows } = await db.query(
        `SELECT count(*) FILTER (WHERE status = 'completed') AS done, count(*) AS total FROM ${s}.supervisions
          WHERE scheduled_date > now() - interval '180 days'`);
      const done = Number(rows[0].done || 0), total = Number(rows[0].total || 0);
      if (!total) return { kind: 'count', value: null, label: 'No supervisions scheduled in the last 6 months' };
      const pct = Math.round((100 * done) / total);
      return { kind: 'pct', value: pct, label: `${pct}% of ${total} scheduled supervisions completed in the last 6 months`, rag: pct >= 90 ? 'green' : pct >= 60 ? 'amber' : 'red' };
    }
  } catch { return null; }
  return null;
}

// GET /areas — the whole toolkit.
router.get('/areas', async (req, res) => {
  const db = getPool();
  const schema = process.env.PG_SCHEMA || 'ladn';
  try {
    const { rows: areas } = await db.query(`SELECT id, ref_code, title, sort_order FROM inspection_toolkit_areas ORDER BY sort_order, id`);
    const { rows: criteria } = await db.query(`
      SELECT c.id, c.area_id, c.ref_code, c.criterion, c.look_for, c.evidence_metric, c.sort_order,
             a.body, a.version, to_char(a.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at, a.updated_by,
             btrim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS updated_by_name
        FROM inspection_toolkit_criteria c
        LEFT JOIN inspection_toolkit_answers a ON a.criterion_id = c.id
        LEFT JOIN staff s ON s.id = a.updated_by
       ORDER BY c.sort_order, c.id`);
    for (const c of criteria) {
      c.evidence = c.evidence_metric ? await evidenceFor(db, schema, c.evidence_metric) : null;
      c.answered = !!(c.body && c.body.trim().length >= 20);
    }
    const byArea = new Map(areas.map(a => [a.id, { ...a, criteria: [] }]));
    for (const c of criteria) { const a = byArea.get(c.area_id); if (a) a.criteria.push(c); }
    // RAG per area = self-evaluation COMPLETENESS, not a compliance judgement (that's the
    // Setting Report Card's job) — green once every criterion in the area has a real answer.
    const out = [...byArea.values()].map(a => {
      const total = a.criteria.length;
      const answered = a.criteria.filter(c => c.answered).length;
      const rag = total === 0 ? 'red' : answered === 0 ? 'red' : answered === total ? 'green' : 'amber';
      return { ...a, answered, total, rag };
    });
    res.json({ areas: out });
  } catch (e) { fail(res, e, 'areas'); }
});

// PUT /criteria/:id/answer — save the setting's own answer. Versioned: the old body is kept in
// history, never silently overwritten.
router.put('/criteria/:id/answer', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  const body = String((req.body && req.body.body) || '').replace(/\r\n?/g, '\n').trim();
  if (body.length > 8000) return res.status(400).json({ error: 'too_long', message: 'That answer is over 8000 characters — please shorten it.' });
  const db = getPool();
  try {
    const { rows: crit } = await db.query('SELECT id FROM inspection_toolkit_criteria WHERE id = $1', [id]);
    if (!crit.length) return res.status(404).json({ error: 'not_found' });
    const { rows } = await db.query(
      `INSERT INTO inspection_toolkit_answers (criterion_id, body, version, updated_by, updated_at)
       VALUES ($1, $2, 1, $3, now())
       ON CONFLICT (criterion_id) DO UPDATE
         SET body = $2, version = inspection_toolkit_answers.version + 1, updated_by = $3, updated_at = now()
       RETURNING body, version, updated_at`, [id, body, req.user.id]);
    await db.query(
      `INSERT INTO inspection_toolkit_answer_history (criterion_id, version, body, updated_by)
       VALUES ($1, $2, $3, $4)`, [id, rows[0].version, body, req.user.id]);
    res.json({ ok: true, version: rows[0].version });
  } catch (e) { fail(res, e, 'save answer'); }
});

// GET /criteria/:id/history
router.get('/criteria/:id/history', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'not_found' });
  try {
    const { rows } = await getPool().query(
      `SELECT h.version, h.body, to_char(h.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at,
              btrim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS updated_by_name
         FROM inspection_toolkit_answer_history h LEFT JOIN staff s ON s.id = h.updated_by
        WHERE h.criterion_id = $1 ORDER BY h.version DESC LIMIT 50`, [id]);
    res.json({ history: rows });
  } catch (e) { fail(res, e, 'history'); }
});

// GET /export — the whole toolkit as JSON (criterion, look-for, evidence snapshot, answer).
// "Exportable" from the brief: a manager can save/print this; no PDF renderer in this build.
router.get('/export', async (req, res) => {
  const db = getPool();
  const schema = process.env.PG_SCHEMA || 'ladn';
  try {
    const { rows: areas } = await db.query(`SELECT id, ref_code, title FROM inspection_toolkit_areas ORDER BY sort_order, id`);
    const { rows: criteria } = await db.query(`
      SELECT c.id, c.area_id, c.criterion, c.look_for, c.evidence_metric, a.body, a.version, a.updated_at
        FROM inspection_toolkit_criteria c LEFT JOIN inspection_toolkit_answers a ON a.criterion_id = c.id
       ORDER BY c.sort_order, c.id`);
    for (const c of criteria) c.evidence = c.evidence_metric ? await evidenceFor(db, schema, c.evidence_metric) : null;
    const byArea = new Map(areas.map(a => [a.id, { ...a, criteria: [] }]));
    for (const c of criteria) { const a = byArea.get(c.area_id); if (a) a.criteria.push(c); }
    res.setHeader('Content-Disposition', `attachment; filename="inspection-toolkit-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ exported_at: new Date().toISOString(), areas: [...byArea.values()] });
  } catch (e) { fail(res, e, 'export'); }
});

module.exports = router;
