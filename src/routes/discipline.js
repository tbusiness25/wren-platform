'use strict';
/* ===========================================================================
 * discipline.js — b318 (2026-09-11)
 *
 * A disciplinary record that walks the ACAS Code of Practice, and will not let
 * you record an outcome you have not earned.
 *
 * THE POINT, stated plainly because it is easy to misread this screen: it is
 * NOT here to make dismissal easier. It is here to make a fair process the path
 * of least resistance, and provable afterwards. The one thing in this build
 * that refuses rather than warns is recording an outcome before an invitation
 * and a meeting exist — because that is not a record of a fair process, it is a
 * record of an unfair one, and a record that lets you write it is worse than no
 * record at all.
 *
 * WHY NOW. From 1 January 2027 the qualifying period for unfair dismissal falls
 * from two years to six months and the compensatory award becomes uncapped
 * (Employment Rights Act 2025; commencement regulations 2026). An unreasonable
 * failure to follow the ACAS Code already lets a tribunal adjust an award by up
 * to 25% (TULR(C)A 1992, s.207A). The two together turn "we did not write it
 * down" from an embarrassment into an unbounded number.
 *
 * WHO SEES WHAT. Manager-level for everything except GET /my, which is a person
 * reading their OWN record — they are entitled to it, and being able to see the
 * process you are inside is half of what makes it fair.
 * =========================================================================== */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const ER = require('../lib/employment-rules');
const svc = require('../services/employment-rules-service');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const isManager = req => MANAGER_ROLES.includes(req.user && req.user.role);

const CASE_TYPES = ['conduct', 'capability', 'gross_misconduct'];
const OUTCOMES = ['no_action', 'informal', 'verbal_warning', 'written_warning',
                  'final_written_warning', 'demotion', 'suspension_without_pay', 'dismissal'];
const STEP_KEYS = ER.ACAS_STEPS.map(s => s.key);

router.use(authenticate);

// ── GET /steps — the ACAS steps, in order, with what each one is for ────────
// Readable by everybody: a person facing a disciplinary is entitled to know
// what is supposed to happen and in what order.
router.get('/steps', async (req, res) => {
  try {
    const db = getPool();
    const rules = await svc.loadRules(db, 'discipline');
    const order = ER.ruleFor(rules, 'discipline.acas_order');
    const accompany = ER.ruleFor(rules, 'discipline.right_to_be_accompanied');
    const expiry = ER.ruleFor(rules, 'discipline.warning_expiry');
    res.json({
      steps: ER.ACAS_STEPS,
      outcomes: OUTCOMES,
      case_types: CASE_TYPES,
      rules: [order, accompany, expiry].map(r => ({
        rule_key: r.rule_key, rule: r.rule, source: r.source, source_url: r.source_url,
        enforcement: r.enforcement, anchor: r.anchor, config: r.config,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /cases ──────────────────────────────────────────────────────────────
router.get('/cases', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const params = [];
    const where = [];
    if (req.query.staff_id) { params.push(Number(req.query.staff_id)); where.push(`c.staff_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`c.status = $${params.length}`); }
    const { rows } = await db.query(`
      SELECT c.*, s.first_name || ' ' || s.last_name AS staff_name, s.job_title,
             (SELECT count(*) FROM ${SCHEMA()}.disciplinary_case_steps st WHERE st.case_id = c.id)::int AS step_count,
             (SELECT max(st.occurred_on) FROM ${SCHEMA()}.disciplinary_case_steps st WHERE st.case_id = c.id) AS last_step_on
        FROM ${SCHEMA()}.disciplinary_cases c
        JOIN ${SCHEMA()}.staff s ON s.id = c.staff_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY (c.status = 'open') DESC, c.opened_on DESC, c.id DESC`, params);
    const today = ER.londonParts(new Date()).ymd;
    res.json(rows.map(r => ({
      ...r,
      warning_live: r.warning_expires_on
        ? ER.ymd(r.warning_expires_on) >= today
        : null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /my — your own record ───────────────────────────────────────────────
// Deliberately not "everything about the case": the concern, the dates, the
// outcome and the appeal rights. Investigation notes about other people are
// not yours to read, and this endpoint does not return the steps' attendee
// lists for that reason.
router.get('/my', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.reference, c.case_type, c.concern, c.status, c.opened_on,
             c.outcome, c.outcome_on, c.outcome_note, c.warning_expires_on,
             c.appeal_lodged_on, c.appeal_heard_on, c.appeal_outcome, c.closed_on
        FROM ${SCHEMA()}.disciplinary_cases c
       WHERE c.staff_id = $1 ORDER BY c.opened_on DESC`, [req.user.id]);
    const rules = await svc.loadRules(db, 'discipline');
    const accompany = ER.ruleFor(rules, 'discipline.right_to_be_accompanied');
    res.json({
      cases: rows,
      your_rights: [
        { right: accompany.rule, source: accompany.source, source_url: accompany.source_url },
        { right: 'You have the right to appeal any disciplinary decision, in writing to your line manager.',
          source: 'Employee Handbook — Capability/Disciplinary Appeal Procedure' },
        { right: 'You will not normally be dismissed for a first breach, except for gross misconduct.',
          source: 'Employee Handbook — Disciplinary Procedures, A) 4) f)' },
      ],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /cases/:id — the case, its steps, and what it is waiting on ─────────
router.get('/cases/:id', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.*, s.first_name || ' ' || s.last_name AS staff_name, s.job_title, s.contract_start
        FROM ${SCHEMA()}.disciplinary_cases c
        JOIN ${SCHEMA()}.staff s ON s.id = c.staff_id
       WHERE c.id = $1`, [req.params.id]);
    const c = rows[0];
    if (!c) return res.status(404).json({ error: 'Not found' });
    const { rows: steps } = await db.query(`
      SELECT st.*, s.first_name || ' ' || s.last_name AS recorded_by_name
        FROM ${SCHEMA()}.disciplinary_case_steps st
        LEFT JOIN ${SCHEMA()}.staff s ON s.id = st.recorded_by
       WHERE st.case_id = $1 ORDER BY st.occurred_on, st.id`, [req.params.id]);

    const rules = await svc.loadRules(db, 'discipline');
    const gate = ER.canRecordOutcome(steps);
    const next = ER.nextStep(c, steps);
    const position = ER.unfairDismissalPosition(rules, c.contract_start, new Date());
    const accompanimentGaps = steps
      .filter(s => (s.step_key === 'invitation' || s.step_key === 'appeal_invitation')
                   && s.accompaniment_offered !== true)
      .map(s => ({
        step_key: s.step_key, occurred_on: ER.ymd(s.occurred_on),
        message: ER.ruleFor(rules, 'discipline.right_to_be_accompanied').rule,
        source: ER.ruleFor(rules, 'discipline.right_to_be_accompanied').source,
      }));

    res.json({
      case: c,
      steps,
      acas_steps: ER.ACAS_STEPS,
      can_record_outcome: gate,
      next_step: next,
      accompaniment_gaps: accompanimentGaps,
      dismissal_position: position,
      warning: c.outcome ? ER.warningExpiry(rules, c.outcome, c.outcome_on) : null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /cases — open one ──────────────────────────────────────────────────
router.post('/cases', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  if (!b.staff_id) return res.status(400).json({ error: 'staff_id required' });
  if (!b.concern || !String(b.concern).trim()) {
    return res.status(400).json({ error: 'A concern is required. "What is this about" is the first ACAS step and the record starts there.' });
  }
  if (b.case_type && !CASE_TYPES.includes(b.case_type)) {
    return res.status(400).json({ error: `case_type must be one of ${CASE_TYPES.join(', ')}` });
  }
  if (Number(b.staff_id) === req.user.id) {
    return res.status(400).json({ error: 'You cannot open a disciplinary case about yourself.' });
  }
  try {
    const db = getPool();
    const { rows: st } = await db.query(
      `SELECT id, contract_start FROM ${SCHEMA()}.staff WHERE id=$1`, [Number(b.staff_id)]);
    if (!st.length) return res.status(404).json({ error: 'No such member of staff' });
    const start = ER.ymd(st[0].contract_start);
    const today = ER.londonParts(new Date()).ymd;
    const serviceMonths = start ? Math.round((ER.daysBetweenYmd(start, today) / 30.4375) * 100) / 100 : null;

    const client = await db.connect();
    let created;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        INSERT INTO ${SCHEMA()}.disciplinary_cases
          (staff_id, reference, case_type, concern, opened_on, opened_by, service_months_at_open,
           suspended_from, suspended_to, suspension_paid)
        VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6,$7,$8::date,$9::date,$10)
        RETURNING *`,
        [Number(b.staff_id), b.reference || null, b.case_type || 'conduct',
         String(b.concern).trim(), b.opened_on || null, req.user.id, serviceMonths,
         b.suspended_from || null, b.suspended_to || null,
         typeof b.suspension_paid === 'boolean' ? b.suspension_paid : null]);
      created = rows[0];
      // The concern IS the first ACAS step, so it is written as one rather than
      // left as a field nobody counts. Without this the case opens already
      // missing step one, which reads as a process failure that never happened.
      await client.query(`
        INSERT INTO ${SCHEMA()}.disciplinary_case_steps
          (case_id, step_key, occurred_on, summary, recorded_by)
        VALUES ($1,'concern',$2::date,$3,$4)`,
        [created.id, ER.ymd(created.opened_on), String(b.concern).trim(), req.user.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    await recordAudit({ req, action: 'create', entity_type: 'disciplinary_case', entity_id: created.id,
      meta: { staff_id: created.staff_id, case_type: created.case_type } }).catch(() => {});
    res.status(201).json(created);
  } catch (e) {
    console.error('[discipline] create:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /cases/:id/steps — record a step ───────────────────────────────────
// Steps may only be added in a valid order. An INVITATION before an
// INVESTIGATION is refused, and so is a MEETING before an invitation: the whole
// value of the record is that it proves the order, and a record you can fill in
// backwards proves nothing.
router.post('/cases/:id/steps', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  if (!STEP_KEYS.includes(b.step_key)) {
    return res.status(400).json({ error: `step_key must be one of ${STEP_KEYS.join(', ')}` });
  }
  if (!b.occurred_on) return res.status(400).json({ error: 'occurred_on required' });
  try {
    const db = getPool();
    const { rows: cs } = await db.query(
      `SELECT * FROM ${SCHEMA()}.disciplinary_cases WHERE id=$1`, [req.params.id]);
    if (!cs.length) return res.status(404).json({ error: 'Not found' });
    const { rows: steps } = await db.query(
      `SELECT step_key, occurred_on FROM ${SCHEMA()}.disciplinary_case_steps
        WHERE case_id=$1 ORDER BY occurred_on, id`, [req.params.id]);

    const have = new Set(steps.map(s => s.step_key));
    const idx = ER.ACAS_ORDER[b.step_key];
    // Every REQUIRED step before this one has to exist already. The appeal
    // steps are not required, so they gate only on 'outcome' — you cannot
    // appeal a decision that has not been made.
    const missing = ER.ACAS_STEPS
      .filter(s => s.required && ER.ACAS_ORDER[s.key] < idx && !have.has(s.key))
      .map(s => s.label.toLowerCase());
    if (missing.length) {
      return res.status(409).json({
        error: `Record ${missing.join(', then ')} first.`,
        code: 'acas_order',
        rule: 'Investigate, invite in writing, hold the meeting, then decide — and offer an appeal.',
        source: 'ACAS Code of Practice 1 on disciplinary and grievance procedures, paras 5–27',
        missing,
      });
    }
    // A date that precedes the step before it is almost always a typo, and a
    // record with the meeting before the invitation is the exact defect this
    // whole file exists to prevent — so it is refused, with the dates shown.
    const prior = steps
      .filter(s => ER.ACAS_ORDER[s.step_key] < idx)
      .sort((a, b2) => ER.ACAS_ORDER[a.step_key] - ER.ACAS_ORDER[b2.step_key]);
    const last = prior[prior.length - 1];
    if (last && ER.ymd(b.occurred_on) < ER.ymd(last.occurred_on)) {
      return res.status(409).json({
        error: `That date is before the ${last.step_key.replace(/_/g, ' ')} on ${ER.prettyRange(last.occurred_on, last.occurred_on)}. Steps cannot run backwards.`,
        code: 'acas_order_date',
      });
    }

    const { rows } = await db.query(`
      INSERT INTO ${SCHEMA()}.disciplinary_case_steps
        (case_id, step_key, occurred_on, summary, accompaniment_offered, accompanied_by,
         companion_declined, attendees, recorded_by, document_ref)
      VALUES ($1,$2,$3::date,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [Number(req.params.id), b.step_key, b.occurred_on, b.summary || null,
       typeof b.accompaniment_offered === 'boolean' ? b.accompaniment_offered : null,
       b.accompanied_by || null,
       typeof b.companion_declined === 'boolean' ? b.companion_declined : null,
       b.attendees || null, req.user.id, b.document_ref || null]);

    // A formal invitation with no record that the right to be accompanied was
    // offered is a WARNING, not a refusal — it may have been offered verbally
    // and not ticked. But it is said out loud, now, while it can still be fixed.
    let warning = null;
    if ((b.step_key === 'invitation' || b.step_key === 'appeal_invitation')
        && b.accompaniment_offered !== true) {
      const rules = await svc.loadRules(db, 'discipline');
      const r = ER.ruleFor(rules, 'discipline.right_to_be_accompanied');
      warning = { rule: r.rule, source: r.source, source_url: r.source_url,
        detail: 'This invitation does not record that the right to be accompanied was offered. If it was, tick it; if it was not, send a corrected invitation before the meeting.' };
    }
    await recordAudit({ req, action: 'update', entity_type: 'disciplinary_case', entity_id: Number(req.params.id),
      meta: { step: b.step_key, occurred_on: b.occurred_on } }).catch(() => {});
    res.status(201).json({ step: rows[0], warning });
  } catch (e) {
    console.error('[discipline] step:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /cases/:id/outcome — THE ONE THAT BLOCKS ────────────────────────────
router.put('/cases/:id/outcome', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  if (!OUTCOMES.includes(b.outcome)) {
    return res.status(400).json({ error: `outcome must be one of ${OUTCOMES.join(', ')}` });
  }
  try {
    const db = getPool();
    const { rows: cs } = await db.query(
      `SELECT * FROM ${SCHEMA()}.disciplinary_cases WHERE id=$1`, [req.params.id]);
    if (!cs.length) return res.status(404).json({ error: 'Not found' });
    const { rows: steps } = await db.query(
      `SELECT step_key, occurred_on FROM ${SCHEMA()}.disciplinary_case_steps
        WHERE case_id=$1 ORDER BY occurred_on, id`, [req.params.id]);

    const gate = ER.canRecordOutcome(steps);
    if (!gate.ok) {
      return res.status(409).json({
        error: gate.message,
        code: 'acas_order',
        missing: gate.missing,
        rule: 'Investigate, invite in writing, hold the meeting, then decide — and offer an appeal.',
        source: 'ACAS Code of Practice 1 on disciplinary and grievance procedures, paras 9–21',
        source_url: 'https://www.acas.org.uk/acas-code-of-practice-on-disciplinary-and-grievance-procedures',
      });
    }

    const rules = await svc.loadRules(db, 'discipline');
    const outcomeOn = b.outcome_on || ER.londonParts(new Date()).ymd;
    const exp = ER.warningExpiry(rules, b.outcome, outcomeOn);

    const client = await db.connect();
    let updated;
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`
        UPDATE ${SCHEMA()}.disciplinary_cases
           SET outcome = $2, outcome_note = $3, outcome_on = $4::date, outcome_by = $5,
               warning_expires_on = $6::date,
               outcome_letter_sent_at = CASE WHEN $7::boolean THEN now() ELSE outcome_letter_sent_at END,
               updated_at = now()
         WHERE id = $1 RETURNING *`,
        [Number(req.params.id), b.outcome, b.outcome_note || null, outcomeOn, req.user.id,
         exp ? exp.expires_on : null, b.letter_sent === true]);
      updated = rows[0];
      // The outcome is itself an ACAS step, recorded so the timeline is complete
      // without anybody having to remember to add it twice.
      await client.query(`
        INSERT INTO ${SCHEMA()}.disciplinary_case_steps
          (case_id, step_key, occurred_on, summary, recorded_by)
        VALUES ($1,'outcome',$2::date,$3,$4)`,
        [Number(req.params.id), outcomeOn,
         `${b.outcome.replace(/_/g, ' ')}${b.outcome_note ? ' — ' + b.outcome_note : ''}`, req.user.id]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }

    await recordAudit({ req, action: 'update', entity_type: 'disciplinary_case', entity_id: Number(req.params.id),
      meta: { outcome: b.outcome } }).catch(() => {});
    res.json({
      case: updated,
      warning: exp,
      reminder: b.letter_sent === true
        ? 'Outcome recorded and the letter marked sent.'
        : 'The outcome and the right of appeal have to be given in writing (ACAS Code, para 19). Mark the letter sent once it has gone.',
    });
  } catch (e) {
    console.error('[discipline] outcome:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /cases/:id/appeal ───────────────────────────────────────────────────
router.put('/cases/:id/appeal', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  try {
    const db = getPool();
    const { rows: cs } = await db.query(
      `SELECT outcome FROM ${SCHEMA()}.disciplinary_cases WHERE id=$1`, [req.params.id]);
    if (!cs.length) return res.status(404).json({ error: 'Not found' });
    if (!cs[0].outcome) {
      return res.status(409).json({
        error: 'There is no outcome to appeal against yet.',
        code: 'acas_order',
        source: 'ACAS Code of Practice 1, para 25',
      });
    }
    const { rows } = await db.query(`
      UPDATE ${SCHEMA()}.disciplinary_cases
         SET appeal_lodged_on = COALESCE($2::date, appeal_lodged_on),
             appeal_heard_on  = COALESCE($3::date, appeal_heard_on),
             appeal_outcome   = COALESCE($4, appeal_outcome),
             appeal_note      = COALESCE($5, appeal_note),
             updated_at = now()
       WHERE id = $1 RETURNING *`,
      [Number(req.params.id), b.appeal_lodged_on || null, b.appeal_heard_on || null,
       b.appeal_outcome || null, b.appeal_note || null]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /cases/:id/close ────────────────────────────────────────────────────
router.put('/cases/:id/close', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  const status = ['closed', 'withdrawn', 'open'].includes(b.status) ? b.status : 'closed';
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE ${SCHEMA()}.disciplinary_cases
         SET status = $2,
             closed_on = CASE WHEN $2 = 'open' THEN NULL ELSE COALESCE($3::date, CURRENT_DATE) END,
             updated_at = now()
       WHERE id = $1 RETURNING *`, [Number(req.params.id), status, b.closed_on || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await recordAudit({ req, action: 'update', entity_type: 'disciplinary_case', entity_id: Number(req.params.id),
      meta: { status } }).catch(() => {});
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /warnings — live warnings across the team ───────────────────────────
// A warning that has expired is "normally disregarded for disciplinary
// purposes" (handbook, Disciplinary H). This separates the live ones from the
// spent ones instead of leaving a manager to work out the dates.
router.get('/warnings', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.staff_id, c.outcome, c.outcome_on, c.warning_expires_on, c.case_type, c.concern,
             s.first_name || ' ' || s.last_name AS staff_name
        FROM ${SCHEMA()}.disciplinary_cases c
        JOIN ${SCHEMA()}.staff s ON s.id = c.staff_id
       WHERE c.warning_expires_on IS NOT NULL
       ORDER BY c.warning_expires_on DESC`);
    const today = ER.londonParts(new Date()).ymd;
    const live = rows.filter(r => ER.ymd(r.warning_expires_on) >= today);
    const spent = rows.filter(r => ER.ymd(r.warning_expires_on) < today);
    const rules = await svc.loadRules(db, 'discipline');
    const r = ER.ruleFor(rules, 'discipline.warning_expiry');
    res.json({ live, spent, rule: r.rule, source: r.source, periods_months: r.config });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
