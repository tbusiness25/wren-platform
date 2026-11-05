'use strict';
// Finance — payment plans (calculator preview + persisted plans + baby pre-funding).
// Build log 2026-08-03 §2. Mounted at /api/finance/payment-plan (manager-gated).
//
// Endpoints:
//   POST   /preview                    compute an arrears + instalment plan (no write)
//   POST   /                           create + persist a plan for a child
//   GET    /child/:childId             list plans for a child
//   PATCH  /:id                        update a plan (status / schedule / amounts)
//   POST   /baby-prefunding/:childId   generate a suggested baby deferral plan
//
// Money is integer pence throughout. Pure maths lives in services/payment-plan.js.

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const PP = require('../services/payment-plan');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
const managerGuard = (req, res, next) => {
  // b480: 'accountant' added — safe only because the accountant-scope gate in
  // server-unified.js has already restricted that role to GET requests on a
  // short allowlist (this router's paths included) before this ever runs.
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'accountant'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);
router.use(express.json({ limit: '32kb' }));

// Resolve the child's leave date from the DB when the caller doesn't pass one.
async function childLeaveDate(db, childId) {
  const { rows } = await db.query(
    'SELECT leave_date FROM children WHERE id=$1', [childId]);
  return rows[0] && rows[0].leave_date
    ? new Date(rows[0].leave_date).toISOString().slice(0, 10) : null;
}

// Derive the under-2 working-parent funding start date for a child.
// Source of truth (in priority order):
//   1) explicit override passed by the caller,
//   2) start_date of the funding_term the child already has a funded booking in,
//   3) start_date of the earliest funding_term that begins on/after the date the
//      child reaches ELIGIBILITY_MONTHS months old (default 9). Under-2 working-
//      parent funding is claimable from the term after the 9-month birthday.
const ELIGIBILITY_MONTHS = 9;
async function fundingStartFor(db, childId, override) {
  if (override) return { date: override, source: 'override' };
  // (2) existing funded booking's term
  try {
    const { rows } = await db.query(`
      SELECT ft.start_date
      FROM child_funding cf JOIN funding_terms ft ON ft.id = cf.term_id
      WHERE cf.child_id = $1
      ORDER BY ft.start_date ASC LIMIT 1`, [childId]);
    if (rows[0] && rows[0].start_date) {
      return { date: new Date(rows[0].start_date).toISOString().slice(0, 10), source: 'existing_child_funding_term' };
    }
  } catch { /* fall through */ }
  // (3) first term on/after the 9-month birthday
  const { rows: kid } = await db.query('SELECT date_of_birth FROM children WHERE id=$1', [childId]);
  if (!kid[0] || !kid[0].date_of_birth) return { date: null, source: 'unknown_no_dob' };
  const dob = new Date(kid[0].date_of_birth);
  const eligible = new Date(dob); eligible.setMonth(eligible.getMonth() + ELIGIBILITY_MONTHS);
  const eligibleIso = eligible.toISOString().slice(0, 10);
  const { rows: term } = await db.query(`
    SELECT start_date FROM funding_terms
    WHERE start_date >= $1 ORDER BY start_date ASC LIMIT 1`, [eligibleIso]);
  if (term[0] && term[0].start_date) {
    return { date: new Date(term[0].start_date).toISOString().slice(0, 10), source: 'computed_from_9mo_birthday', eligible_from: eligibleIso };
  }
  return { date: null, source: 'no_matching_funding_term', eligible_from: eligibleIso };
}

// ── POST /preview ─────────────────────────────────────────────────────────────
// Body: { monthly_pence, pay_now_pence, start_date?, leave_date?, child_id?,
//         catch_up_monthly_pence?, catch_up_months? }
router.post('/preview', async (req, res) => {
  const db = getPool();
  try {
    const b = req.body || {};
    if (b.monthly_pence == null) return res.status(400).json({ error: 'monthly_pence required' });

    let leaveDate = b.leave_date;
    if (!leaveDate && b.child_id) leaveDate = await childLeaveDate(db, Number(b.child_id));

    const plan = PP.computePlan({
      monthlyPence:   Number(b.monthly_pence),
      payNowPence:    Number(b.pay_now_pence || 0),
      startDate:      b.start_date,
      leaveDate:      leaveDate || b.start_date || new Date().toISOString().slice(0, 10),
      catchUpMonthly: b.catch_up_monthly_pence != null ? Number(b.catch_up_monthly_pence) : undefined,
      catchUpMonths:  b.catch_up_months != null ? Number(b.catch_up_months) : undefined,
    });
    res.json({ ok: true, plan });
  } catch (e) {
    console.error('[payment-plan] preview:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST / ────────────────────────────────────────────────────────────────────
// Persist a plan. Body: { child_id, monthly_pence, pay_now_pence, reason?,
//   start_date?, leave_date?, catch_up_monthly_pence?, catch_up_months?, status? }
router.post('/', async (req, res) => {
  const db = getPool();
  try {
    const b = req.body || {};
    if (!b.child_id || b.monthly_pence == null) {
      return res.status(400).json({ error: 'child_id and monthly_pence required' });
    }
    let leaveDate = b.leave_date;
    if (!leaveDate) leaveDate = await childLeaveDate(db, Number(b.child_id));

    const plan = PP.computePlan({
      monthlyPence:   Number(b.monthly_pence),
      payNowPence:    Number(b.pay_now_pence || 0),
      startDate:      b.start_date,
      leaveDate:      leaveDate || b.start_date || new Date().toISOString().slice(0, 10),
      catchUpMonthly: b.catch_up_monthly_pence != null ? Number(b.catch_up_monthly_pence) : undefined,
      catchUpMonths:  b.catch_up_months != null ? Number(b.catch_up_months) : undefined,
    });

    const { rows } = await db.query(`
      INSERT INTO payment_plans (child_id, monthly_pence, pay_now_pence, schedule, reason, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, child_id, monthly_pence, pay_now_pence, schedule, reason, status, created_by, created_at`,
      [Number(b.child_id), Number(b.monthly_pence), Number(b.pay_now_pence || 0),
       JSON.stringify(plan), b.reason || null, b.status || 'proposed', req.user?.id || null]);

    recordAudit({ req, action: 'create', entity_type: 'payment_plan', entity_id: rows[0].id,
      meta: { child_id: Number(b.child_id), balance_pence: plan.balance_at_leave_pence } });
    res.status(201).json({ ok: true, payment_plan: rows[0] });
  } catch (e) {
    console.error('[payment-plan] create:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── GET /child/:childId ───────────────────────────────────────────────────────
router.get('/child/:childId', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT id, child_id, monthly_pence, pay_now_pence, schedule, reason, status,
             created_by, created_at
      FROM payment_plans WHERE child_id=$1 ORDER BY created_at DESC`,
      [Number(req.params.childId)]);
    res.json({ payment_plans: rows });
  } catch (e) {
    console.error('[payment-plan] list:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── PATCH /:id ────────────────────────────────────────────────────────────────
// Body may include: status, reason, monthly_pence, pay_now_pence, schedule (recompute
// happens client-side or via /preview; here we accept the supplied schedule/amounts).
router.patch('/:id', async (req, res) => {
  const db = getPool();
  try {
    const b = req.body || {};
    const sets = [], vals = [];
    const set = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
    if (b.status != null)         set('status', String(b.status));
    if (b.reason != null)         set('reason', String(b.reason));
    if (b.monthly_pence != null)  set('monthly_pence', Number(b.monthly_pence));
    if (b.pay_now_pence != null)  set('pay_now_pence', Number(b.pay_now_pence));
    if (b.schedule != null)       set('schedule', JSON.stringify(b.schedule));
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(Number(req.params.id));
    const { rows } = await db.query(
      `UPDATE payment_plans SET ${sets.join(', ')} WHERE id=$${vals.length}
       RETURNING id, child_id, monthly_pence, pay_now_pence, schedule, reason, status, created_at`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    recordAudit({ req, action: 'update', entity_type: 'payment_plan', entity_id: rows[0].id, meta: { status: rows[0].status } });
    res.json({ ok: true, payment_plan: rows[0] });
  } catch (e) {
    console.error('[payment-plan] update:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── POST /baby-prefunding/:childId ────────────────────────────────────────────
// Generate a suggested baby pre-funding deferral plan. Body (all optional):
//   { monthly_pence, start_date, funding_start_date, small_monthly_pence,
//     catch_up_months, save? }  — save=true persists it as status 'proposed'.
router.post('/baby-prefunding/:childId', async (req, res) => {
  const db = getPool();
  try {
    const childId = Number(req.params.childId);
    const b = req.body || {};
    if (b.monthly_pence == null) return res.status(400).json({ error: 'monthly_pence required' });

    // start date: caller override → child's DB start_date → today
    let startDate = b.start_date;
    if (!startDate) {
      const { rows } = await db.query('SELECT start_date FROM children WHERE id=$1', [childId]);
      startDate = rows[0] && rows[0].start_date
        ? new Date(rows[0].start_date).toISOString().slice(0, 10)
        : new Date().toISOString().slice(0, 10);
    }
    const fs = await fundingStartFor(db, childId, b.funding_start_date);
    if (!fs.date) return res.status(422).json({ error: 'Could not determine funding start date', funding_source: fs });

    const result = PP.babyPrefundingPlan({
      monthlyPence:      Number(b.monthly_pence),
      startDate,
      fundingStartDate:  fs.date,
      smallMonthlyPence: b.small_monthly_pence != null ? Number(b.small_monthly_pence) : undefined,
      catchUpMonths:     b.catch_up_months != null ? Number(b.catch_up_months) : undefined,
    });
    result.funding_source = fs;

    let saved = null;
    if (b.save) {
      const { rows } = await db.query(`
        INSERT INTO payment_plans (child_id, monthly_pence, pay_now_pence, schedule, reason, status, created_by)
        VALUES ($1,$2,$3,$4,$5,'proposed',$6)
        RETURNING id, child_id, status, created_at`,
        [childId, Number(b.monthly_pence), result.deferral.holding_payment_pence,
         JSON.stringify(result), `Baby pre-funding deferral (funding from ${fs.date})`, req.user?.id || null]);
      saved = rows[0];
      recordAudit({ req, action: 'create', entity_type: 'payment_plan', entity_id: saved.id,
        meta: { child_id: childId, kind: 'baby_prefunding', deferred_pence: result.deferral.deferred_balance_pence } });
    }
    res.json({ ok: true, ...result, saved });
  } catch (e) {
    console.error('[payment-plan] baby-prefunding:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;
