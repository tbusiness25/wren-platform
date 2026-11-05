const express = require('express');
const router = express.Router();
const https = require('https');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { calculateBradfordFactor } = require('../services/bradford-factor');
const { notify } = require('../services/notification-dispatcher');
const ratioEngine = require('../services/ratio-engine');
// b309 (2026-09-10) — the annual-leave entitlement engine. Every balance this
// file reports now comes from here. There is no fallback figure: where an
// entitlement cannot be calculated the response carries entitlement_days: null
// and a not_set_reason in plain English, and the screens print "not set".
// The number 28 used to be hard-coded in four places in this file.
const leaveSvc = require('../services/leave-entitlement-service');
// b318 (2026-09-11) — the written-down rules: LADN's own handbook first, the
// statutory position where the handbook is silent. Every finding carries the
// rule in one sentence and the document it comes from, so a decline says WHY
// and a practitioner can plan around it instead of guessing.
const ruleSvc = require('../services/employment-rules-service');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const isManager = req => MANAGER_ROLES.includes(req.user && req.user.role);

router.use(authenticate);

// ── AI AUTHORISATION LOGIC ─────────────────────────────────
async function aiAuthoriseHoliday(db, staffId, startDate, endDate, requestType) {
  // Rule 1: sick → never auto-approve
  if (requestType === 'sick') return { decision: 'manual_review', reason: 'Sick leave always requires manual review.' };

  // Rule 1b: DETERMINISTIC RATIO GATE (A3 engine). Authoritative pass/fail on
  // booked-children-by-age-band × qualified ratio staff (Toby/the chef/the office manager excluded),
  // +1 spare (Q6), and the 14-day block rule (Q9). On fail: block + nearest passing dates.
  try {
    const rg = await ratioEngine.checkRange(db, startDate, endDate, staffId);
    if (rg.blackout) {
      return { decision: 'manual_review', reason: rg.blackout_note, flags: ['blackout_over_14d'], ratio: rg };
    }
    if (!rg.pass) {
      const near = (rg.nearest_passing_dates || []);
      const suffix = near.length ? ` Nearest dates that pass ratios: ${near.join(', ')}.` : '';
      return {
        decision: 'decline_ratio',
        reason: `${rg.failing_days[0]?.reason || 'Staffing ratios cannot be maintained on the requested dates.'}${suffix}`,
        flags: ['ratio_fail'], ratio: rg
      };
    }
  } catch (e) {
    console.error('[absence] ratio-engine error (continuing to legacy checks):', e.message);
  }

  // Rule 2/3: Room clash
  const { rows: staff } = await db.query('SELECT id, room_id FROM staff WHERE id=$1', [staffId]);
  const roomId = staff[0]?.room_id;
  if (roomId) {
    const { rows: clashes } = await db.query(`
      SELECT ar.staff_id FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      WHERE ar.status='approved' AND ar.staff_id != $1
        AND ar.start_date <= $3::date AND ar.end_date >= $2::date
        AND s.room_id = $4
    `, [staffId, startDate, endDate, roomId]);
    if (clashes.length > 0) {
      const { rows: rs } = await db.query(
        'SELECT COUNT(*) as total FROM staff WHERE room_id=$1 AND is_active=true', [roomId]
      );
      const total = parseInt(rs[0].total) || 1;
      if (clashes.length >= Math.floor(total / 2)) {
        return { decision: 'decline_clash', reason: `${clashes.length} other staff already approved off — minimum staffing ratios cannot be maintained.` };
      }
      return { decision: 'manual_review', reason: `${clashes.length} other staff member(s) from your room already have approved leave overlapping these dates. Manager review required.`, flags: ['potential_clash'] };
    }
  }

  // Rule 3: Bradford Factor (combined hr_absences + absence_requests, rolling 52 weeks)
  const bf = await calculateBradfordFactor(db, staffId);
  if (bf.score > 200) {
    return { decision: 'manual_review', reason: `Bradford Factor score is ${bf.score} — above the 200 threshold. Manager review required before any leave is approved.`, bradford: bf };
  }
  if (bf.score > 100) {
    // Flag but don't block — falls through to further checks
  }

  // Rule 4: Notice period
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const reqStart = new Date(startDate);
  const noticeDays = Math.floor((reqStart - today) / 86400000);
  if (noticeDays < 2) {
    return { decision: 'manual_review', reason: 'Less than 2 days notice — manager must review urgently.', flags: ['short_notice'] };
  }

  // Rule 5: Holiday entitlement
  //
  // b309: this used to fall back to a hard-coded 28 days minus whatever had been
  // approved, which meant a three-day-a-week practitioner was being told she had
  // twenty spare days she had never been entitled to. It now asks the engine, and
  // when the engine cannot answer it says so and sends the request to a human
  // rather than inventing a headroom figure to compare against.
  if (requestType === 'holiday') {
    const reqDays = Math.max(1, Math.floor((new Date(endDate) - reqStart) / 86400000) + 1);
    const ent = await leaveSvc.entitlementFor(db, staffId, { on: startDate });
    if (!ent.balance.set) {
      return {
        decision: 'manual_review',
        reason: `Holiday entitlement is not set for this person — ${ent.entitlement.notSetReason || 'no figure on file'}. A manager has to decide this one.`,
        flags: ['entitlement_not_set'],
      };
    }
    const remaining = ent.balance.remainingDays;
    const awaiting  = ent.balance.pendingDays;
    if (reqDays > remaining) {
      return { decision: 'decline_no_entitlement', reason: `Only ${remaining.toFixed(1)} days holiday remaining this year — not enough to cover this ${reqDays}-day request.` };
    }
    if (reqDays > remaining - awaiting) {
      return { decision: 'manual_review', reason: `This request may exceed available entitlement once pending requests are accounted for (${remaining.toFixed(1)} days remaining, ${awaiting} days awaiting approval).`, flags: ['entitlement_tight'] };
    }
  }

  // Rule 6: Same day-of-week pattern
  const twelveMonthsAgo = new Date();
  twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
  const { rows: history } = await db.query(`
    SELECT start_date, request_type FROM absence_requests
    WHERE staff_id=$1 AND status='approved' AND start_date >= $2::date
    ORDER BY start_date
  `, [staffId, twelveMonthsAgo.toISOString().split('T')[0]]);

  const reqDow = new Date(startDate).getDay();
  const sameDow = history.filter(h => new Date(h.start_date).getDay() === reqDow).length;
  if (sameDow >= 3) {
    return { decision: 'manual_review', reason: `Pattern detected: ${sameDow} previous absences start on this day of the week. Manager review required.`, flags: ['pattern_dow'] };
  }

  // Bradford 101-200: conditional approve (auto-approved but flagged)
  if (bf.score > 100) {
    return { decision: 'conditional_approve', reason: `Approved — Bradford Factor score of ${bf.score} is elevated. A welfare conversation is recommended.`, bradford: bf, flags: ['bradford_elevated'] };
  }

  // Short notice 2-13 days: flag but approve
  if (noticeDays < 14) {
    return { decision: 'conditional_approve', reason: `Approved with short notice (${noticeDays} day${noticeDays !== 1 ? 's' : ''}). Manager has been notified.`, flags: ['short_notice'] };
  }

  // Rule 7 (b318): the HANDBOOK's own leave rules, and the statutory notice.
  //
  // These run LAST on purpose. The gates above are about whether the nursery
  // can legally open with this person away; these are about whether the request
  // fits the rules the setting has written down. A ratio failure is a fact, a
  // handbook breach is a judgement — so a handbook breach routes to a human
  // rather than deciding by itself, unless Toby has set that rule to 'block'.
  let ruleFindings = [];
  try {
    const rc = await ruleSvc.leaveCheck(db, {
      staff_id: staffId, start_date: startDate, end_date: endDate, request_type: requestType,
    });
    ruleFindings = rc.findings || [];
    if (rc.blocked) {
      const b = rc.blocking[0];
      return {
        decision: 'decline_rule',
        reason: `${b.rule} — ${b.source}. ${b.detail}`,
        flags: ['handbook_rule'], rule_findings: ruleFindings,
      };
    }
    const warns = ruleFindings.filter(f => f.status === 'warn');
    if (warns.length) {
      return {
        decision: 'manual_review',
        reason: warns.map(w => `${w.rule} — ${w.source}. ${w.detail}`).join(' '),
        flags: ['handbook_rule'], rule_findings: ruleFindings,
      };
    }
  } catch (e) {
    console.error('[absence] employment-rules error (continuing):', e.message);
  }

  // All clear
  return { decision: 'auto_approve', reason: 'No conflicts detected. Leave approved automatically.', bradford: bf, rule_findings: ruleFindings };
}

// ── Telegram helper ────────────────────────────────────────
// login-20261023: through the one Telegram sender (src/lib/notifications.js), which carries the dev guard.
function telegramNotify(text) { require('../lib/notifications').sendTelegramNow({ text, parse_mode: 'HTML' }); }

// GET /my — own requests
router.get('/my', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.*, s2.first_name || ' ' || s2.last_name as approved_by_name
      FROM absence_requests ar
      LEFT JOIN staff s2 ON s2.id = ar.approved_by
      WHERE ar.staff_id=$1
      ORDER BY ar.start_date DESC LIMIT 50
    `, [req.user.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /all — manager view: UNION absence_requests (wren-submitted) + hr_absences (BrightHR historical)
router.get('/all', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.id, ar.staff_id, ar.start_date, ar.end_date,
        ar.request_type as absence_type, ar.request_type,
        ar.status, ar.notes, ar.created_at, ar.days_count,
        ar.auto_approved, ar.ai_decision_reason, ar.rejected_reason,
        ar.half_day, ar.room_impact_baby, ar.room_impact_preschool,
        COALESCE(ar.created_via, 'wren') as created_via,
        s.first_name || ' ' || s.last_name as staff_name,
        s.first_name, s.last_name, s.room_id,
        r.name as room_name,
        'absence_request' as record_source
      FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      LEFT JOIN rooms r ON r.id = s.room_id
      UNION ALL
      SELECT ha.id + 100000 as id, ha.staff_id,
        ha.start_date, ha.end_date,
        ha.absence_type, ha.absence_type as request_type,
        'approved' as status, ha.reason as notes, ha.created_at,
        ha.duration_days as days_count,
        true as auto_approved, null as ai_decision_reason, null as rejected_reason,
        null as half_day, false as room_impact_baby, false as room_impact_preschool,
        'brighthr' as created_via,
        s.first_name || ' ' || s.last_name as staff_name,
        s.first_name, s.last_name, s.room_id,
        r.name as room_name,
        'hr_absences' as record_source
      FROM hr_absences ha
      JOIN staff s ON s.id = ha.staff_id
      LEFT JOIN rooms r ON r.id = s.room_id
      -- De-dupe: absence_requests (Wren-submitted / nightly BrightHR API sync) are
      -- authoritative for their (staff_id,start_date); suppress the overlapping
      -- hr_absences (BrightHR CSV historical) row so it isn't listed twice.
      -- Mirrors the same precedence used in services/bradford-factor.js.
      WHERE NOT EXISTS (
        SELECT 1 FROM absence_requests ar2
        WHERE ar2.staff_id = ha.staff_id AND ar2.start_date = ha.start_date
      )
      ORDER BY created_at DESC LIMIT 2000
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /pending — pending requests only
router.get('/pending', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.*, s.first_name || ' ' || s.last_name as staff_name, s.room_id
      FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      WHERE ar.status='pending'
      ORDER BY ar.created_at ASC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENTITLEMENT (b309, 2026-09-10 — rewritten so that no number in here is made up)
//
// The three GETs below used to answer, in order: whatever hr_holiday_entitlement
// happened to hold (3 rows for an 18-person team), whatever staff_entitlement
// held (0 rows), and then — for everybody else — a literal 28. That last branch
// is why every leave balance on every screen was fictional.
//
// They now all go through services/leave-entitlement-service.js, which reads the
// person's work pattern, the setting's leave policy and the statutory floor, and
// returns the workings alongside the answer. Where it cannot answer it returns
// entitlement_days: null with not_set_reason set, and the caller must render
// "not set". A wrong balance that looks right is worse than a blank.
//
// The response keys the old screens read — entitlement_days, taken_days,
// remaining_days, awaiting_approval_days, carried_over_days — are all still
// present and mean the same thing, so nothing that consumes this breaks. They
// are now accompanied by `workings`, `not_set`, `not_set_reason` and `sourced`.
// ═══════════════════════════════════════════════════════════════════════════

/** The legacy response shape, kept byte-for-byte compatible, plus the new fields. */
function entitlementResponse(r) {
  const e = r.entitlement, b = r.balance;
  return {
    source: r.manual_override ? 'manual_override' : 'calculated',
    staff_id: r.staff_id,
    not_set: !b.set,
    not_set_reason: b.notSetReason,
    // legacy keys — same names, same meanings, real numbers
    entitlement_days: e.entitlementDays,
    entitlement_hours: e.entitlementHours,
    taken_days: b.takenDays,
    upcoming_days: b.upcomingDays,
    awaiting_approval_days: b.pendingDays,
    remaining_days: b.remainingDays,
    carried_over_days: e.carriedInApplied,
    year_start: r.year.yearStart,
    year_end: r.year.yearEnd,
    year: r.year.label,
    // new: the evidence
    total_available_days: b.totalAvailableDays,
    remaining_if_pending_approved: b.remainingIfPendingApproved,
    bank_holiday_days: e.bankHolidayDays,
    bank_holiday_dates: e.bankHolidayDates,
    statutory_floor_days: e.statutoryFloorDays,
    top_up_days: e.topUpDays,
    days_per_week: e.daysPerWeek,
    weekly_hours: e.weeklyHours,
    hours_per_day: e.hoursPerDay,
    policy_leave_weeks: e.policyLeaveWeeks,
    bh_handling: e.bhHandling,
    pattern_source: r.pattern.source,
    pattern_note: r.pattern.note,
    accrued_days: r.accrued.accruedDays,
    accrued_note: r.accrued.note,
    sourced: r.sourced,
    reconciles: r.reconciles,
    reconcile_note: r.reconcile_note,
    workings: e.workings,
  };
}

// GET /entitlement/my — own entitlement, with the workings
router.get('/entitlement/my', async (req, res) => {
  try {
    const r = await leaveSvc.entitlementFor(getPool(), req.user.id, { on: req.query.on });
    res.json(entitlementResponse(r));
  } catch (e) {
    console.error('[absence/entitlement/my]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /entitlement/:staffId/workings — the step list on its own, for the drawer
router.get('/entitlement/:staffId/workings', async (req, res) => {
  const staffId = parseInt(req.params.staffId, 10);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staffId must be a number' });
  if (!isManager(req) && staffId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await leaveSvc.entitlementFor(getPool(), staffId, { on: req.query.on });
    res.json({
      staff_id: staffId,
      not_set: !r.balance.set,
      not_set_reason: r.balance.notSetReason,
      entitlement_days: r.entitlement.entitlementDays,
      workings: r.entitlement.workings,
      reconcile_note: r.reconcile_note,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /entitlement/:staffId — one person (own, or any if manager)
router.get('/entitlement/:staffId', async (req, res) => {
  const staffId = parseInt(req.params.staffId, 10);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staffId must be a number' });
  if (!isManager(req) && staffId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  try {
    const r = await leaveSvc.entitlementFor(getPool(), staffId, { on: req.query.on });
    // annual_leave_days / used_days kept for the older callers of this endpoint.
    res.json({ ...entitlementResponse(r),
      annual_leave_days: r.entitlement.entitlementDays,
      used_days: r.balance.takenDays });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /entitlement — every active staff member (manager)
router.get('/entitlement', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const { rows: staff } = await db.query(
      `SELECT id, first_name, last_name, role, job_title FROM staff WHERE is_active=true ORDER BY last_name, first_name`);
    const out = [];
    for (const s of staff) {
      const r = await leaveSvc.entitlementFor(db, s.id, { on: req.query.on });
      out.push({
        id: s.id,
        name: `${s.first_name} ${s.last_name}`.trim(),
        role: s.role,
        job_title: s.job_title,
        ...entitlementResponse(r),
        annual_leave_days: r.entitlement.entitlementDays,
        used_days: r.balance.takenDays,
      });
    }
    const set = out.filter(x => !x.not_set).length;
    res.set('X-Wren-Entitlement-Coverage', `${set}/${out.length}`);
    res.json(out);
  } catch (e) {
    console.error('[absence/entitlement]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /entitlement/recompute — recalculate and persist every active staff member.
// Manager-only. Idempotent, and it never overwrites a manual override.
router.post('/entitlement/recompute', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const { rows: staff } = await db.query('SELECT id FROM staff WHERE is_active=true ORDER BY id');
    let set = 0, notSet = 0, mismatched = 0;
    for (const s of staff) {
      const r = await leaveSvc.entitlementFor(db, s.id, { on: req.body && req.body.on });
      await leaveSvc.persist(db, r);
      if (r.balance.set) set++; else notSet++;
      if (r.reconciles === false) mismatched++;
    }
    res.json({ ok: true, staff: staff.length, with_entitlement: set, not_set: notSet,
      disagrees_with_brighthr: mismatched });
  } catch (e) {
    console.error('[absence/entitlement/recompute]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /entitlement/:staffId — a manager sets or clears a manual override.
// Body: { entitlement_days | null, reason, carried_in_days?, carry_cap_days?, clear? }
router.put('/entitlement/:staffId', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const staffId = parseInt(req.params.staffId, 10);
  if (!Number.isInteger(staffId)) return res.status(400).json({ error: 'staffId must be a number' });
  const b = req.body || {};
  try {
    const db = getPool();
    const base = await leaveSvc.entitlementFor(db, staffId, { on: b.on });
    const y = base.year;

    if (b.clear) {
      await db.query(
        `UPDATE staff_leave_years SET manual_override=false, not_set_reason=NULL, updated_at=now()
          WHERE staff_id=$1 AND year_start=$2::date`, [staffId, y.yearStart]);
      const fresh = await leaveSvc.entitlementFor(db, staffId, { on: b.on });
      await leaveSvc.persist(db, fresh);
      return res.json({ ok: true, cleared: true, ...entitlementResponse(fresh) });
    }

    const days = b.entitlement_days === null || b.entitlement_days === ''
      ? null : Number(b.entitlement_days);
    if (days !== null && (!Number.isFinite(days) || days < 0 || days > 200)) {
      return res.status(400).json({ error: 'entitlement_days must be a number between 0 and 200, or null' });
    }
    if (!b.reason || String(b.reason).trim().length < 3) {
      return res.status(400).json({ error: 'A reason is required for a manual entitlement — it is what the workings show instead of a calculation.' });
    }
    const hpd = base.entitlement.hoursPerDay;
    await db.query(`
      INSERT INTO staff_leave_years
        (staff_id, year_start, year_end, entitlement_days, entitlement_hours,
         carried_in_days, carry_cap_days, manual_override, not_set_reason, source, computed_at, updated_at)
      VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,true,$8,'manual',now(),now())
      ON CONFLICT (staff_id, year_start) DO UPDATE SET
        entitlement_days=EXCLUDED.entitlement_days,
        entitlement_hours=EXCLUDED.entitlement_hours,
        carried_in_days=COALESCE(EXCLUDED.carried_in_days, staff_leave_years.carried_in_days),
        carry_cap_days=COALESCE(EXCLUDED.carry_cap_days, staff_leave_years.carry_cap_days),
        manual_override=true, not_set_reason=EXCLUDED.not_set_reason,
        source='manual', updated_at=now()`,
      [staffId, y.yearStart, y.yearEnd, days,
       days != null && hpd ? Math.round(days * hpd * 100) / 100 : null,
       b.carried_in_days == null ? null : Number(b.carried_in_days),
       b.carry_cap_days   == null ? null : Number(b.carry_cap_days),
       `Set by ${req.user.name || ('staff #' + req.user.id)}: ${String(b.reason).trim().slice(0, 400)}`]);

    const fresh = await leaveSvc.entitlementFor(db, staffId, { on: b.on });
    res.json({ ok: true, ...entitlementResponse(fresh) });
  } catch (e) {
    console.error('[absence/entitlement PUT]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /entitlement/roll — the holiday-year roll. Dry run unless {apply:true}.
// Deliberately a button and not a cron: an unattended job that zeroed everyone's
// balance at midnight on 1 January would be worse than one a human presses.
router.post('/entitlement/roll', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  try {
    const db = getPool();
    const today = new Date().toISOString().slice(0, 10);
    const nextYear = `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
    const out = await leaveSvc.rollYear(db, {
      fromYearStart: b.from || today,
      toYearStart:   b.to   || nextYear,
      apply: b.apply === true,
    });
    res.json(out);
  } catch (e) {
    console.error('[absence/entitlement/roll]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /calendar — month view
//
// b229 extended this additively. The original contract is untouched:
//   GET /calendar?month=8&year=2026  →  [ {…}, {…} ]   (a bare array, as before)
// The Roost day-cell calendar in staff/absence-mgmt.html consumes that array
// directly, so the default response shape MUST stay an array.
//
// Two additions, both opt-in:
//   ?from=YYYY-MM-DD&to=YYYY-MM-DD
//     An explicit date range instead of a whole month. The booking form needs
//     this because a requested holiday routinely straddles a month boundary,
//     and asking for "August" when someone books 28 Aug–4 Sep hides half the
//     colleagues who are already off. When from/to are given, month/year are
//     ignored. Overlap semantics (start <= to AND end >= from) — the old
//     month filter matched only absences whose START or END fell in the month,
//     which silently dropped anything spanning right across it.
//   ?view=grid
//     Returns { from, to, month, year, staff:[…], absences:[…] } instead of the
//     bare array. The staff roster is what makes a BrightHR-shaped grid possible
//     — a row per person, including the ones who are NOT off, because "who is
//     available" is the question a manager is actually asking. Active staff
//     only; id, name and room only — no contact details, no pay, no PII beyond
//     the name already present on every absence row.
//
// b229 ALSO fixed what the calendar was reading FROM. It queried only
// absence_requests (250 rows, 4 types, nothing before April 2026). The bulk of
// Toby's BrightHR history lives in ladn.hr_absences — 2,944 rows across all 18
// matched staff, back to 2018, 16 absence types, including 83 future-dated ones.
// GET /all, the Bradford Factor, the cockpit monitors and the owner digest all
// already read it; the calendar was the outlier, so it showed a fraction of what
// BrightHR shows and Toby asked for a calendar "the same as brighthr".
//
// The UNION and its precedence rule are copied from GET /all above, deliberately
// unchanged: absence_requests wins for a given (staff_id, start_date) because
// those are Wren-submitted or came off the nightly API sync, and the hr_absences
// CSV row for the same absence is suppressed rather than drawn twice. Same rule
// as services/bradford-factor.js, so a day that counts once there counts once
// here. hr_absences rows have no status column — they are historical fact, so
// they are treated as 'approved', which also keeps them inside the existing
// status IN ('approved','pending') contract.
router.get('/calendar', async (req, res) => {
  const { month, year, from, to, view } = req.query;
  const m = parseInt(month) || new Date().getMonth() + 1;
  const y = parseInt(year) || new Date().getFullYear();

  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const useRange = isDate(from) && isDate(to) && from <= to;
  // Whole-month bounds when no explicit range was asked for.
  const monthFrom = `${y}-${String(m).padStart(2, '0')}-01`;
  const monthTo   = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const rangeFrom = useRange ? from : monthFrom;
  const rangeTo   = useRange ? to   : monthTo;

  try {
    const db = getPool();
    // The month/year path keeps its original absence_requests WHERE clause
    // verbatim so nothing that relies on today's results changes; only ?from/?to
    // takes the overlap clause. Both then UNION the historical set on a plain
    // date-overlap, which is correct for either window.
    const arWhere = useRange
      ? `ar.start_date <= $2::date AND ar.end_date >= $1::date`
      : `(EXTRACT(YEAR FROM ar.start_date)=$1 OR EXTRACT(YEAR FROM ar.end_date)=$1)
         AND (EXTRACT(MONTH FROM ar.start_date)=$2 OR EXTRACT(MONTH FROM ar.end_date)=$2)`;
    const params = useRange ? [rangeFrom, rangeTo] : [y, m];

    const { rows } = await db.query(`
      SELECT ar.id, ar.staff_id, ar.start_date, ar.end_date, ar.request_type,
        ar.status, ar.days_count, ar.auto_approved,
        s.first_name || ' ' || s.last_name as staff_name, s.room_id,
        r.name as room_name, 'absence_request' AS record_source
      FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE ar.status IN ('approved','pending')
        AND ${arWhere}
      UNION ALL
      SELECT ha.id + 100000 AS id, ha.staff_id,
        ha.start_date, COALESCE(ha.end_date, ha.start_date) AS end_date,
        ha.absence_type AS request_type,
        'approved' AS status, ha.duration_days AS days_count, true AS auto_approved,
        s.first_name || ' ' || s.last_name as staff_name, s.room_id,
        r.name as room_name, 'hr_absences' AS record_source
      FROM hr_absences ha
      JOIN staff s ON s.id = ha.staff_id
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE ha.start_date <= $${useRange ? 2 : 4}::date
        AND COALESCE(ha.end_date, ha.start_date) >= $${useRange ? 1 : 3}::date
        AND NOT EXISTS (
          SELECT 1 FROM absence_requests ar2
          WHERE ar2.staff_id = ha.staff_id AND ar2.start_date = ha.start_date
        )
      ORDER BY start_date
    `, useRange ? params : [...params, rangeFrom, rangeTo]);

    // login-20261023 — everyone can see who is off (it is shift information), but WHY a colleague
    // is off (sickness, compassionate, medical…) is an employee record. Non-managers see a
    // colleague's non-holiday absence as 'away'; their own and managers' views are unchanged.
    if (!['manager', 'deputy_manager', 'admin', 'owner'].includes(req.user && req.user.role) && Number(req.user && req.user.id) !== 1) {
      for (const r of rows) {
        if (Number(r.staff_id) === Number(req.user.id)) continue;
        if (!['holiday', 'annual_leave', 'annual leave', 'public holiday', 'toil', 'time off in lieu', 'training / events'].includes(String(r.request_type || '').toLowerCase())) r.request_type = 'away';
      }
    }

    if (view !== 'grid') return res.json(rows);   // unchanged contract

    const { rows: staff } = await db.query(`
      SELECT s.id, s.first_name || ' ' || s.last_name AS name,
             COALESCE(s.preferred_name, s.first_name) AS short_name,
             s.role, s.room_id, r.name AS room_name
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.is_active = true
      ORDER BY r.name NULLS LAST, s.first_name, s.last_name
    `);
    res.json({ from: rangeFrom, to: rangeTo, month: m, year: y, staff, absences: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /request — submit new absence
router.post('/request', async (req, res) => {
  const { start_date, end_date, request_type, half_day, notes,
          // b318 — WHEN the absence was reported, and to whom. Nothing recorded
          // this before, so the handbook's 10pm/6:30am deadline could not be
          // checked even in hindsight. Defaults to now for a sick request made
          // in Wren; a manager entering a phone call that came in at 07:10 sets
          // reported_at explicitly rather than having it stamped at typing time.
          reported_at, reported_channel, reported_to, report_note } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });

  // Booking window: today → 31 Dec of current year
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const reqStart = new Date(start_date); reqStart.setHours(0, 0, 0, 0);
  const reqEnd   = new Date(end_date);   reqEnd.setHours(0, 0, 0, 0);
  const windowEnd = new Date(today.getFullYear(), 11, 31);
  if (reqEnd < reqStart) return res.status(400).json({ error: 'End date must be on or after start date.', code: 'date_order' });
  if (reqStart < today)  return res.status(400).json({ error: 'Cannot book absences in the past.', code: 'booking_window' });
  if (reqStart > windowEnd) {
    return res.status(400).json({
      error: `Booking window: you can request absence up to 31 Dec ${today.getFullYear()}. Dates in ${reqStart.getFullYear()} will open for booking on 1 Jan ${reqStart.getFullYear()}.`,
      code: 'booking_window'
    });
  }

  // Calculate working days
  const s = new Date(start_date), e = new Date(end_date);
  let days = 0;
  for (let d = new Date(s); d <= e; d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) days++;
  }
  if (half_day) days = days - 0.5;

  try {
    const db = getPool();
    const ai = await aiAuthoriseHoliday(db, req.user.id, start_date, end_date, request_type || 'holiday');

    // Auto-approval kill-switch (Toby, 2026-07-13): until settings.absence_auto_approve='true',
    // approve-decisions land as PENDING for manager review. Auto-declines (ratio/clash) still block.
    let effectiveDecision = ai.decision;
    let autoApproveOn = false;
    try {
      const { rows: aa } = await db.query("SELECT value FROM settings WHERE key='absence_auto_approve'");
      autoApproveOn = aa.length > 0 && aa[0].value === 'true';
    } catch (_) { /* settings unavailable — fail safe: no auto-approval */ }
    if (!autoApproveOn && (ai.decision === 'auto_approve' || ai.decision === 'conditional_approve')) {
      effectiveDecision = 'manual_review';
      ai.reason = `[Auto-approve is off — queued for manager review] ${ai.reason}`;
    }

    const decisionToStatus = {
      auto_approve: 'approved',
      conditional_approve: 'approved',
      manual_review: 'pending',
      decline_ratio: 'declined',          // ratio breach — block at request time (A3 gatekeeper)
      decline_clash: 'declined',
      decline_no_entitlement: 'declined',
      // b318: only reached where Toby has set that handbook rule to 'block'.
      // Every rule ships at 'warn', so this decision cannot occur by default.
      decline_rule: 'declined',
    };
    const status       = decisionToStatus[effectiveDecision] || 'pending';
    const autoApproved = status === 'approved';

    // b318 — the reporting facts, and the handbook verdict on them, stamped at
    // write time so the row itself says whether the deadline was met. The
    // verdict is recomputed on read too; storing it is what makes "show me
    // every late report this term" one query instead of a scan.
    const isSick = (request_type || 'holiday') === 'sick';
    const reportedAt = isSick ? (reported_at ? new Date(reported_at) : new Date()) : null;
    let timeliness = null;
    if (isSick) {
      try {
        const sickRules = await ruleSvc.loadRules(db, 'sickness');
        timeliness = ruleSvc.reportTimeliness(sickRules, reportedAt, start_date);
      } catch (e) { console.error('[absence] timeliness:', e.message); }
    }

    const { rows } = await db.query(`
      INSERT INTO absence_requests (staff_id, start_date, end_date, request_type,
        absence_type, half_day, days_count, notes, status, auto_approved, ai_decision_reason, created_via,
        reported_at, reported_channel, reported_to, report_timeliness, report_note)
      VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,'wren',$11,$12,$13,$14,$15)
      RETURNING *
    `, [req.user.id, start_date, end_date, request_type || 'holiday',
        half_day, days, notes, status, autoApproved, ai.reason,
        reportedAt, isSick ? (reported_channel || 'wren') : null,
        isSick && reported_to ? Number(reported_to) : null, timeliness,
        isSick ? (report_note || null) : null]);

    // Per-absence running summary → manager (Telegram). Deterministic; fires on
    // EVERY request so the manager has a live picture of the leave queue + any
    // statutory-ratio impact. Replaces the old manual_review-only alert.
    try {
      const { rows: st } = await db.query('SELECT first_name, last_name FROM staff WHERE id=$1', [req.user.id]);
      const name = st[0] ? `${st[0].first_name} ${st[0].last_name}` : `Staff #${req.user.id}`;
      const { rows: pend } = await db.query("SELECT COUNT(*)::int AS c FROM absence_requests WHERE status='pending'");
      const pendingCount = pend[0] ? pend[0].c : 0;
      const icon = status === 'approved' ? '✅' : status === 'declined' ? '⛔' : '📋';
      const decisionLabel = {
        auto_approve: 'auto-approved',
        conditional_approve: 'approved (flagged)',
        manual_review: 'needs manager review',
        decline_ratio: 'BLOCKED — staffing ratio breach',
        decline_clash: 'declined — room staffing clash',
        decline_no_entitlement: 'declined — no entitlement left',
        decline_rule: 'BLOCKED — breaks a handbook rule set to block',
      }[ai.decision] || status;
      let ratioLine = '';
      const fd = ai.ratio && ai.ratio.failing_days;
      if (Array.isArray(fd) && fd.length) {
        ratioLine = `\n⚠️ Ratio fails on ${fd.length} day(s) — first: <i>${fd[0].reason}</i>`;
      }
      const range = `${start_date}${end_date !== start_date ? ' → ' + end_date : ''}`;
      // b318: the approver reads the SAME sentences the requester read — the
      // rule, and which document it comes from. Not a score, not a flag name.
      const ruleLines = (ai.rule_findings || [])
        .filter(f => f.status === 'warn' || f.status === 'block')
        .slice(0, 4)
        .map(f => `\n📕 <b>${f.rule}</b> <i>(${f.source})</i>\n     ${f.detail}`)
        .join('');
      telegramNotify(
        `${icon} <b>Absence ${decisionLabel}</b>\n${name} — ${request_type || 'holiday'} · ${range} (${days}d)` +
        `${ratioLine}${ruleLines}\n<i>${ai.reason}</i>\n📊 ${pendingCount} request(s) now awaiting manager action.`
      );
    } catch (e) { console.error('[absence] summary telegram error:', e.message); }

    // Notification system: fire staff_sick to all-managers when type is sick
    if ((request_type || 'holiday') === 'sick') {
      const { rows: st } = await db.query('SELECT first_name, last_name FROM staff WHERE id=$1', [req.user.id]);
      const name = st[0] ? `${st[0].first_name} ${st[0].last_name}` : `Staff #${req.user.id}`;
      // b318 — a late report is said out loud, with the rule, at the moment the
      // manager first hears about the absence. Never a diagnosis: this line
      // carries dates and a deadline and nothing about anybody's health.
      let lateLine = '';
      try {
        const sickRules = await ruleSvc.loadRules(db, 'sickness');
        const f = require('../lib/employment-rules').sickReportCheck(sickRules, rows[0].reported_at, start_date);
        if (f.status === 'warn') lateLine = ` ${f.rule} — ${f.source}. ${f.detail}`;
      } catch (_) { /* the notification still goes out */ }
      notify('staff_sick', 'all-managers', null,
        `${name} called in sick`,
        `Absence request: ${start_date}${end_date !== start_date ? ' → ' + end_date : ''}.${ai.reason ? ' ' + ai.reason : ''}${lateLine}`,
        { priority: 'high', relatedTable: 'absence_requests', relatedId: rows[0].id }
      );
    }

    // Internal notification for auto-declined requests
    if (status === 'declined') {
      await db.query(`
        INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
        VALUES ('staff', $1, 'absence', 'Leave request declined', $2, '/hr.html#absences', 'absence_requests', $3, 'high')
      `, [req.user.id, ai.reason, rows[0].id]).catch(() => {});
    }

    res.status(201).json({ ...rows[0], ai_decision: ai.decision, ai_reason: ai.reason,
      ai_flags: ai.flags || [], bradford: ai.bradford, rule_findings: ai.rule_findings || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST / — alias for /request
router.post('/', async (req, res) => {
  const { start_date, end_date, absence_type, request_type, duration_days, duration_hours, notes } = req.body;
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO absence_requests (staff_id, start_date, end_date, absence_type,
        request_type, days_count, duration_days, duration_hours, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$6,$7,$8)
      RETURNING *
    `, [req.user.id, start_date, end_date, absence_type || request_type || 'holiday',
        request_type || absence_type || 'holiday', duration_days, duration_hours, notes]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/ai-check — run AI check before approving
router.post('/:id/ai-check', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM absence_requests WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const req_ = rows[0];
    const result = await aiAuthoriseHoliday(db, req_.staff_id, req_.start_date, req_.end_date, req_.request_type || req_.absence_type);
    // Store the AI decision reason
    await db.query('UPDATE absence_requests SET ai_decision_reason=$1 WHERE id=$2', [result.reason, req.params.id]);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/approve
// b488 (M11) — state guard. Approving an already-DECLINED request is an
// override of that decision (almost always the A3 ratio gatekeeper's own
// auto-decline, created with no approved_by) — allowed only for the same
// manager-level roles already gated above, but it must carry a reason and is
// stamped is_override so it can't silently look like a first-time decision.
router.put('/:id/approve', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows: cur } = await db.query('SELECT status FROM absence_requests WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const isOverride = cur[0].status === 'declined';
    const reason = (req.body.reason || '').trim();
    if (isOverride && !reason) {
      return res.status(400).json({ error: 'override_reason_required',
        message: 'This request was declined — approving it now is an override and needs a reason.' });
    }
    const { rows } = await db.query(`
      UPDATE absence_requests
      SET status='approved', approved_by=$1, auto_approved=$2,
          is_override=$3, override_reason=$4
      WHERE id=$5 RETURNING *
    `, [req.user.id, req.body.auto_approved || false, isOverride, isOverride ? reason : null, req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/decline
// b488 (M11) — the mirror of the above: declining an already-APPROVED request
// is an override (usually of an auto-approval) and needs a reason, recorded
// the same way. A plain first-time decline (from 'pending') is unaffected.
router.put('/:id/decline', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows: cur } = await db.query('SELECT status FROM absence_requests WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const isOverride = cur[0].status === 'approved';
    const reason = (req.body.reason || '').trim();
    if (isOverride && !reason) {
      return res.status(400).json({ error: 'override_reason_required',
        message: 'This request was already approved — declining it now is an override and needs a reason.' });
    }
    const { rows } = await db.query(`
      UPDATE absence_requests
      SET status='declined', approved_by=$1, rejected_reason=$2,
          is_override=$3, override_reason=$4
      WHERE id=$5 RETURNING *
    `, [req.user.id, reason || null, isOverride, isOverride ? reason : null, req.params.id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /pending-review — requests needing manager action (manual_review + conditional_approve statuses)
router.get('/pending-review', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ar.*, s.first_name, s.last_name, s.room_id,
        r.name as room_name,
        (SELECT COUNT(*) FROM absence_requests ar2
         WHERE ar2.staff_id=ar.staff_id AND ar2.status='approved'
           AND ar2.start_date >= NOW() - INTERVAL '1 year') AS absences_ytd
      FROM absence_requests ar
      JOIN staff s ON s.id = ar.staff_id
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE ar.status IN ('pending')
         OR (ar.status='approved' AND ar.auto_approved=true AND ar.ai_decision_reason ILIKE '%elevated%')
      ORDER BY ar.created_at ASC
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /bradford-watchlist — all active staff sorted by Bradford score
router.get('/bradford-watchlist', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows: staffList } = await db.query(`SELECT id, first_name, last_name, room_id FROM staff WHERE is_active=true ORDER BY last_name`);
    const results = await Promise.all(staffList.map(async s => {
      const bf = await calculateBradfordFactor(db, s.id);
      return { ...s, ...bf };
    }));
    results.sort((a, b) => b.score - a.score);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /bradford/:staffId — Bradford factor (combined hr_absences + absence_requests)
router.get('/bradford/:staffId', async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin']) && req.user.id !== parseInt(req.params.staffId)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const bf = await calculateBradfordFactor(db, parseInt(req.params.staffId));
    res.json({ staff_id: parseInt(req.params.staffId), ...bf,
      rag: bf.score > 200 ? 'red' : bf.score > 100 ? 'amber' : bf.score > 50 ? 'yellow' : 'green' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /preview  { request_type, start_date, end_date }
// Transparency preview for the leave-request form (Toby, 2026-07-14): runs the SAME
// gates as aiAuthoriseHoliday but without early exit, and returns every check with
// its weighting so staff can see exactly how their request will be assessed BEFORE
// submitting. Self-only: always previews for req.user.id. Read-only — writes nothing.
router.post('/preview', async (req, res) => {
  const db = getPool();
  const staffId = req.user.id;
  const { request_type = 'holiday', start_date, end_date } = req.body || {};
  if (!start_date || !end_date) return res.status(400).json({ error: 'start_date and end_date required' });
  const checks = [];
  let percent = 95;        // auto-approval baseline
  let hardBlock = false;   // any fail → declined at request time
  let review = false;      // any review trigger → goes to manager
  const cap = v => { percent = Math.min(percent, v); };

  try {
    // Sick leave never auto-approves
    if (request_type === 'sick') {
      review = true; cap(50);
      checks.push({ key: 'sick', label: 'Request type', status: 'review', points: 'to manager',
        detail: 'Sick leave always goes to your manager — it is never decided automatically.' });
    }

    // Gate 1: statutory staffing ratios (deterministic, authoritative)
    try {
      const rg = await ratioEngine.checkRange(db, start_date, end_date, staffId);
      if (rg.blackout) {
        review = true; cap(40);
        checks.push({ key: 'ratio', label: 'Staffing ratios', status: 'review', points: 'to manager', detail: rg.blackout_note });
      } else if (!rg.pass) {
        hardBlock = true;
        const near = (rg.nearest_passing_dates || []);
        checks.push({ key: 'ratio', label: 'Staffing ratios', status: 'fail', points: 'blocks request',
          detail: `${rg.failing_days?.[0]?.reason || 'Ratios cannot be maintained on these dates.'}${near.length ? ` Nearest dates that pass: ${near.join(', ')}.` : ''}` });
      } else {
        checks.push({ key: 'ratio', label: 'Staffing ratios', status: 'pass', points: '—',
          detail: 'Legal child:staff ratios hold on every requested day with you away.' });
      }
    } catch (e) {
      checks.push({ key: 'ratio', label: 'Staffing ratios', status: 'review', points: '—', detail: 'Ratio check unavailable — a manager will confirm.' });
    }

    // Gate 2: room clash
    const { rows: staff } = await db.query('SELECT room_id FROM staff WHERE id=$1', [staffId]);
    const roomId = staff[0]?.room_id;
    if (roomId) {
      const { rows: clashes } = await db.query(`
        SELECT ar.staff_id FROM absence_requests ar
        JOIN staff s ON s.id = ar.staff_id
        WHERE ar.status='approved' AND ar.staff_id != $1
          AND ar.start_date <= $3::date AND ar.end_date >= $2::date
          AND s.room_id = $4
      `, [staffId, start_date, end_date, roomId]);
      if (clashes.length > 0) {
        const { rows: rs } = await db.query('SELECT COUNT(*) as total FROM staff WHERE room_id=$1 AND is_active=true', [roomId]);
        const total = parseInt(rs[0].total) || 1;
        if (clashes.length >= Math.floor(total / 2)) {
          hardBlock = true;
          checks.push({ key: 'clash', label: 'Room cover', status: 'fail', points: 'blocks request',
            detail: `${clashes.length} of your room already approved off over these dates — minimum staffing cannot be maintained.` });
        } else {
          review = true; percent -= 30;
          checks.push({ key: 'clash', label: 'Room cover', status: 'flag', points: '−30%',
            detail: `${clashes.length} other staff in your room already have approved leave overlapping these dates — manager decides.` });
        }
      } else {
        checks.push({ key: 'clash', label: 'Room cover', status: 'pass', points: '—', detail: 'No overlapping approved leave in your room.' });
      }
    }

    // Gate 3: Bradford Factor (your own score, rolling 52 weeks: spells² × days)
    try {
      const bf = await calculateBradfordFactor(db, staffId);
      const formula = `${bf.instances ?? 0} spells² × ${bf.days_total ?? 0} days = ${bf.score}`;
      if (bf.score > 200) {
        review = true; cap(40);
        checks.push({ key: 'bradford', label: 'Bradford Factor', status: 'review', points: 'to manager',
          detail: `Your score is ${bf.score} (${formula}) — above the 200 threshold, so a manager reviews any leave.` });
      } else if (bf.score > 100) {
        percent -= 10;
        checks.push({ key: 'bradford', label: 'Bradford Factor', status: 'flag', points: '−10%',
          detail: `Your score is ${bf.score} (${formula}) — elevated (over 100). Approvable, but flagged for a welfare chat.` });
      } else {
        checks.push({ key: 'bradford', label: 'Bradford Factor', status: 'pass', points: '—',
          detail: `Your score is ${bf.score} (${formula}) — under the 100 threshold.` });
      }
    } catch (e) {
      checks.push({ key: 'bradford', label: 'Bradford Factor', status: 'review', points: '—', detail: 'Score unavailable.' });
    }

    // Gate 4: notice period
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const noticeDays = Math.floor((new Date(start_date) - today) / 86400000);
    if (noticeDays < 2) {
      review = true; cap(40);
      checks.push({ key: 'notice', label: 'Notice given', status: 'review', points: 'to manager',
        detail: `${noticeDays} day${noticeDays === 1 ? '' : 's'} notice — under 2 days always goes to a manager urgently.` });
    } else if (noticeDays < 14) {
      percent -= 10;
      checks.push({ key: 'notice', label: 'Notice given', status: 'flag', points: '−10%',
        detail: `${noticeDays} days notice — approvable, but under the 14 days we ask for, so your manager is notified.` });
    } else {
      checks.push({ key: 'notice', label: 'Notice given', status: 'pass', points: '—', detail: `${noticeDays} days notice.` });
    }

    // Gate 5: entitlement (holiday only)
    // b309: same engine as the authorisation path, so the number a practitioner
    // is shown before submitting is the number the decision is actually made on.
    if (request_type === 'holiday') {
      const reqDays = Math.max(1, Math.floor((new Date(end_date) - new Date(start_date)) / 86400000) + 1);
      const ent = await leaveSvc.entitlementFor(db, staffId, { on: start_date });
      if (!ent.balance.set) {
        review = true; cap(40);
        checks.push({ key: 'entitlement', label: 'Holiday entitlement', status: 'review', points: 'to manager',
          detail: `Your holiday entitlement has not been set yet — ${ent.entitlement.notSetReason || 'no figure on file'}. We are not going to guess at a balance, so a manager decides this one.` });
      } else {
        const remaining = ent.balance.remainingDays;
        const awaiting  = ent.balance.pendingDays;
        if (reqDays > remaining) {
          hardBlock = true;
          checks.push({ key: 'entitlement', label: 'Holiday entitlement', status: 'fail', points: 'blocks request',
            detail: `This is a ${reqDays}-day request but you have ${remaining.toFixed(1)} days remaining this year (${ent.entitlement.entitlementDays} days entitlement${ent.entitlement.carriedInApplied ? ` + ${ent.entitlement.carriedInApplied} carried over` : ''}, ${ent.balance.takenDays} taken, ${ent.balance.upcomingDays} already booked).` });
        } else if (reqDays > remaining - awaiting) {
          review = true; percent -= 20;
          checks.push({ key: 'entitlement', label: 'Holiday entitlement', status: 'flag', points: '−20%',
            detail: `${remaining.toFixed(1)} days remaining but ${awaiting} awaiting approval — this could take you over, so a manager checks.` });
        } else {
          checks.push({ key: 'entitlement', label: 'Holiday entitlement', status: 'pass', points: '—',
            detail: `${reqDays}-day request, ${remaining.toFixed(1)} of ${ent.balance.totalAvailableDays} days remaining.` });
        }
      }
    }

    // Gate 6: same day-of-week pattern (last 12 months)
    const twelveMonthsAgo = new Date(); twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const { rows: history } = await db.query(`
      SELECT start_date FROM absence_requests
      WHERE staff_id=$1 AND status='approved' AND start_date >= $2::date
    `, [staffId, twelveMonthsAgo.toISOString().split('T')[0]]);
    const reqDow = new Date(start_date).getDay();
    const sameDow = history.filter(h => new Date(h.start_date).getDay() === reqDow).length;
    if (sameDow >= 3) {
      review = true; cap(40);
      checks.push({ key: 'pattern', label: 'Absence pattern', status: 'review', points: 'to manager',
        detail: `${sameDow} of your previous absences started on this day of the week, so a manager reviews this one.` });
    } else {
      checks.push({ key: 'pattern', label: 'Absence pattern', status: 'pass', points: '—', detail: 'No repeating day-of-week pattern.' });
    }

    // Gate 7 (b318): the rules we have actually written down.
    //
    // The six gates above are Wren's own judgement — ratios, Bradford, patterns.
    // These are the SETTING'S rules, quoted from its handbook, plus the statutory
    // notice period. They are listed last so the practitioner reads "here is what
    // the computer thinks" and then "here is what the handbook says", which is
    // the order those two things deserve.
    //
    // Each one carries `rule` and `source`, and the screen prints both. A check
    // that says "no" without saying whose rule it is teaches nobody anything.
    try {
      const rc = await ruleSvc.leaveCheck(db, {
        staff_id: staffId, start_date, end_date, request_type,
      });
      for (const f of rc.findings) {
        const map = { pass: 'pass', note: 'pass', unknown: 'review', warn: 'flag', block: 'fail' };
        if (f.status === 'block') { hardBlock = true; }
        else if (f.status === 'warn') { review = true; percent -= 15; }
        else if (f.status === 'unknown') { review = true; cap(50); }
        checks.push({
          key: f.rule_key, label: f.title, status: map[f.status] || 'pass',
          points: f.status === 'warn' ? '−15%' : f.status === 'block' ? 'blocks request'
                : f.status === 'unknown' ? 'to manager' : '—',
          detail: f.detail,
          rule: f.rule,
          source: f.source,
          source_url: f.source_url,
          anchor: f.anchor,
          handbook_out_of_date: f.supersedes_handbook || false,
        });
      }
    } catch (e) {
      console.error('[absence/preview] employment-rules:', e.message);
      checks.push({ key: 'handbook', label: 'Handbook rules', status: 'review', points: '—',
        detail: 'The handbook rule check is unavailable — a manager will confirm.' });
    }

    // Overall
    if (hardBlock) percent = 5;
    percent = Math.max(5, Math.min(95, Math.round(percent)));
    const { rows: aa } = await db.query("SELECT value FROM settings WHERE key='absence_auto_approve'");
    const autoApproveOn = aa.length && aa[0].value === 'true';
    const band = hardBlock ? 'blocked' : percent >= 80 ? 'high' : percent >= 55 ? 'medium' : 'low';
    const headline = hardBlock
      ? 'This request would be declined as things stand — see the failing check below.'
      : review
        ? `Around ${percent}% — this will go to your manager to decide, with the flags below attached.`
        : autoApproveOn
          ? `Around ${percent}% — on today's numbers this would be approved automatically.`
          : `Around ${percent}% — every check passes; your manager gets it marked "recommend approve".`;
    res.json({ percent, band, headline, checks, auto_approve_enabled: autoApproveOn,
      note: 'Estimate based on today\'s bookings, rotas and approved leave — it can change if those change before you submit. Your manager sees the same checks, and a person always makes the final call on anything not approved automatically.' });
  } catch (e) {
    console.error('[absence/preview]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PROOF OF ABSENCE — fit notes (b309, 2026-09-10)
//
// A fit note is a doctor's statement about somebody's health. Under UK GDPR
// Art.9 that is special-category data, so this whole block is written to a
// tighter rule than the rest of the file:
//
//   * The file is stored on disk under DATA_DIR/absence-proof, never in the
//     database and never inside the repo. Same mechanism as the incident photo
//     path in src/routes/incidents.js — deliberately reused, not reinvented.
//   * Only a manager, or the person the absence belongs to, can download it. A
//     colleague with a valid staff token gets a 403.
//   * The download is token-checked against the PORTAL AUDIENCE, so a parents
//     token can never reach it even if the URL leaks.
//   * The notification says a fit note was attached. It never says what it says,
//     never names a condition, and never carries the filename — an original
//     filename like "sick-note-depression.pdf" is exactly the leak this avoids,
//     so the stored name is random and the original is shown only in the UI to
//     people already allowed to see the file.
//   * Nothing here is ever put in AI context. No route in this block returns
//     the file content, and the metadata does not go near /api/ai or the RAG
//     corpus.
// Retention: employment record — 6 years after employment ends
// (wren-docs/compliance/record-retention.md). Nothing here auto-deletes.
// ═══════════════════════════════════════════════════════════════════════════
const PROOF_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'absence-proof')
  : path.join(__dirname, '../../data/ladn/uploads/absence-proof');

const PROOF_EXT = { '.pdf': 1, '.jpg': 1, '.jpeg': 1, '.png': 1, '.heic': 1, '.webp': 1 };

const _proofUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      try { fs.mkdirSync(PROOF_DIR, { recursive: true }); } catch (_) {}
      cb(null, PROOF_DIR);
    },
    filename(req, file, cb) {
      // Random name on disk. The original filename is stored in the DB column
      // and shown only to people already allowed to see the document itself.
      const ext = (path.extname(file.originalname) || '.pdf').toLowerCase().replace(/[^.a-z0-9]/g, '');
      cb(null, `proof_${crypto.randomBytes(12).toString('hex')}${PROOF_EXT[ext] ? ext : '.bin'}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!PROOF_EXT[ext]) return cb(new Error(`Accepted file types: ${Object.keys(PROOF_EXT).join(', ')}`));
    cb(null, true);
  },
});

/** The absence row plus whether this caller is allowed near its proof. */
async function proofAccess(db, req, id) {
  const { rows } = await db.query(
    `SELECT ar.id, ar.staff_id, ar.request_type, ar.start_date,
            ar.proof_filename, ar.proof_stored_name, ar.proof_mime, ar.proof_size_bytes,
            ar.proof_kind, ar.proof_uploaded_at, ar.proof_uploaded_by
       FROM absence_requests ar WHERE ar.id=$1`, [id]);
  const row = rows[0] || null;
  if (!row) return { row: null, canRead: false, canWrite: false };
  const own = row.staff_id === req.user.id;
  return {
    row,
    // The subject of a medical document always has a right to their own copy
    // (UK GDPR Art.15). Everyone else has to be a manager.
    canRead: own || isManager(req),
    canWrite: own || isManager(req),
  };
}

// POST /:id/proof — attach a fit note / self-certificate to an absence request.
router.post('/:id/proof', (req, res, next) => {
  _proofUpload.single('proof')(req, res, err => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field name: proof)' });
  const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch (_) {} };
  try {
    const db = getPool();
    const acc = await proofAccess(db, req, id);
    if (!acc.row)      { cleanup(); return res.status(404).json({ error: 'Not found' }); }
    if (!acc.canWrite) { cleanup(); return res.status(403).json({ error: 'Forbidden' }); }
    if (acc.row.proof_stored_name) {
      cleanup();
      return res.status(409).json({ error: 'A proof document is already attached. Remove it first.' });
    }
    const kind = ['fit_note', 'self_cert', 'other'].includes(req.body && req.body.kind)
      ? req.body.kind : 'fit_note';
    await db.query(`
      UPDATE absence_requests
         SET proof_filename=$1, proof_stored_name=$2, proof_mime=$3, proof_size_bytes=$4,
             proof_kind=$5, proof_uploaded_at=now(), proof_uploaded_by=$6
       WHERE id=$7`,
      [String(req.file.originalname || 'document').slice(0, 200), req.file.filename,
       req.file.mimetype, req.file.size, kind, req.user.id, id]);

    // Managers are told a document exists. They are NOT told what it is called
    // or what it says — the notification body is the one place this could leak
    // into an inbox, a Telegram chat or a push preview.
    try {
      notify('absence_proof_uploaded', 'all-managers', null,
        'Proof of absence attached',
        `A ${kind === 'self_cert' ? 'self-certificate' : 'fit note'} has been attached to absence request #${id}. Open the request in Roost to view it.`,
        { relatedTable: 'absence_requests', relatedId: id });
    } catch (_) { /* notification failure must not lose the upload */ }

    res.status(201).json({ ok: true, id, kind, filename: req.file.originalname, size_bytes: req.file.size });
  } catch (e) {
    cleanup();
    console.error('[absence/proof upload]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/proof/meta — is there one, who attached it, when. No file content.
router.get('/:id/proof/meta', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const acc = await proofAccess(getPool(), req, id);
    if (!acc.row)     return res.status(404).json({ error: 'Not found' });
    if (!acc.canRead) return res.status(403).json({ error: 'Forbidden' });
    const r = acc.row;
    res.json({
      id,
      has_proof: !!r.proof_stored_name,
      kind: r.proof_kind,
      filename: r.proof_filename,
      mime: r.proof_mime,
      size_bytes: r.proof_size_bytes ? Number(r.proof_size_bytes) : null,
      uploaded_at: r.proof_uploaded_at,
      uploaded_by: r.proof_uploaded_by,
      note: 'Medical evidence. Visible to managers and to the person it belongs to only.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/proof — stream the document itself.
router.get('/:id/proof', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const acc = await proofAccess(getPool(), req, id);
    if (!acc.row)     return res.status(404).json({ error: 'Not found' });
    if (!acc.canRead) return res.status(403).json({ error: 'Forbidden' });
    if (req.user.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
    const stored = acc.row.proof_stored_name;
    if (!stored) return res.status(404).json({ error: 'No proof attached' });
    const full = path.join(PROOF_DIR, path.basename(stored));
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'File missing on disk' });
    res.setHeader('Content-Type', acc.row.proof_mime || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `inline; filename="${String(acc.row.proof_filename || 'proof').replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(full);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /:id/proof — remove it. Manager or the person it belongs to.
router.delete('/:id/proof', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const db = getPool();
    const acc = await proofAccess(db, req, id);
    if (!acc.row)      return res.status(404).json({ error: 'Not found' });
    if (!acc.canWrite) return res.status(403).json({ error: 'Forbidden' });
    const stored = acc.row.proof_stored_name;
    await db.query(`
      UPDATE absence_requests
         SET proof_filename=NULL, proof_stored_name=NULL, proof_mime=NULL, proof_size_bytes=NULL,
             proof_kind=NULL, proof_uploaded_at=NULL, proof_uploaded_by=NULL
       WHERE id=$1`, [id]);
    if (stored) {
      try { fs.unlinkSync(path.join(PROOF_DIR, path.basename(stored))); } catch (_) {}
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /ratio-check?staff_id=&start=YYYY-MM-DD&end=YYYY-MM-DD
// Deterministic preview for the leave-request form: per-day pass/fail + nearest dates.
router.get('/ratio-check', async (req, res) => {
  const { start, end } = req.query;
  const staffId = req.query.staff_id ? parseInt(req.query.staff_id, 10) : (req.user && req.user.id);
  if (!start) return res.status(400).json({ error: 'start (date) required' });
  try {
    const result = await ratioEngine.checkRange(getPool(), start, end || start, staffId);
    res.json(result);
  } catch (e) {
    console.error('[absence/ratio-check]', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// b318 (2026-09-11) — SICKNESS PROCESS: reporting, return to work, SSP
//
// Appended. Nothing above is changed beyond the two places that now record WHEN
// an absence was reported and run the handbook's leave rules.
// ═══════════════════════════════════════════════════════════════════════════

// PUT /:id/reported — record (or correct) when an absence was reported.
//
// A manager taking a phone call at 07:10 records 07:10, not the moment they got
// to a keyboard. The timeliness verdict is recomputed and re-stamped, so
// correcting the time corrects the flag rather than leaving a stale one behind.
router.put('/:id/reported', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const db = getPool();
    const { rows: cur } = await db.query(
      'SELECT id, staff_id, start_date FROM absence_requests WHERE id=$1', [id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    if (cur[0].staff_id !== req.user.id && !isManager(req)) return res.status(403).json({ error: 'Forbidden' });

    const at = req.body && req.body.reported_at ? new Date(req.body.reported_at) : new Date();
    if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'reported_at is not a valid date/time' });

    const ER = require('../lib/employment-rules');
    const sickRules = await ruleSvc.loadRules(db, 'sickness');
    const startYmd = ER.ymd(cur[0].start_date);
    const verdict = ER.sickReportCheck(sickRules, at, startYmd);

    const { rows } = await db.query(`
      UPDATE absence_requests
         SET reported_at = $2, report_timeliness = $3,
             reported_channel = COALESCE($4, reported_channel),
             reported_to = COALESCE($5, reported_to),
             report_note = COALESCE($6, report_note)
       WHERE id = $1 RETURNING id, reported_at, reported_channel, reported_to, report_timeliness`,
      [id, at, verdict.timeliness || 'unknown',
       (req.body && req.body.reported_channel) || null,
       req.body && req.body.reported_to ? Number(req.body.reported_to) : null,
       (req.body && req.body.report_note) || null]);
    res.json({ ...rows[0], finding: verdict });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/return-to-work — the form, and optionally the interview.
//
// The handbook asks for the form BEFORE returning (Sickness D)3) and makes the
// interview optional (D)4). Both are recorded as timestamps rather than as a
// boolean, because "when" is the part that matters when a pattern is discussed
// six months later.
router.put('/:id/return-to-work', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const db = getPool();
    const { rows: cur } = await db.query(
      'SELECT id, staff_id FROM absence_requests WHERE id=$1', [id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    if (cur[0].staff_id !== req.user.id && !isManager(req)) return res.status(403).json({ error: 'Forbidden' });
    const b = req.body || {};
    const { rows } = await db.query(`
      UPDATE absence_requests
         SET rtw_form_at      = CASE WHEN $2::boolean THEN COALESCE($3::timestamptz, now()) ELSE rtw_form_at END,
             rtw_interview_at = CASE WHEN $4::boolean THEN COALESCE($5::timestamptz, now()) ELSE rtw_interview_at END,
             return_to_work_date  = COALESCE($6::date, return_to_work_date),
             return_to_work_notes = COALESCE($7, return_to_work_notes)
       WHERE id = $1
       RETURNING id, rtw_form_at, rtw_interview_at, return_to_work_date, return_to_work_notes`,
      [id, b.form === true, b.form_at || null, b.interview === true, b.interview_at || null,
       b.return_date || null, b.notes || null]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /sickness-process — the manager's board: every sickness absence with the
// handbook's four questions answered. Late report? Self-cert or fit note?
// Return-to-work form? Interview?
//
// NEVER a diagnosis. This endpoint returns dates, a timeliness verdict and
// whether a document exists — nothing about anybody's health, and nothing from
// inside a fit note (b309's Art.9 rule, kept).
router.get('/sickness-process', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const db = getPool();
    const ER = require('../lib/employment-rules');
    const rules = await ruleSvc.loadRules(db, 'sickness');
    const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || ''))
      ? req.query.from : ER.addDays(ER.londonParts(new Date()).ymd, -120);
    const { rows } = await db.query(`
      SELECT ar.id, ar.staff_id, ar.start_date, ar.end_date, ar.status,
             ar.reported_at, ar.reported_channel, ar.report_timeliness,
             ar.rtw_form_at, ar.rtw_interview_at,
             ar.proof_uploaded_at, ar.proof_kind,
             s.first_name || ' ' || s.last_name AS staff_name
        FROM absence_requests ar
        JOIN staff s ON s.id = ar.staff_id
       WHERE COALESCE(ar.request_type, ar.absence_type) = 'sick'
         AND ar.start_date >= $1::date
       ORDER BY ar.start_date DESC`, [from]);
    const now = new Date();
    const out = rows.map(r => {
      const findings = [
        ER.sickReportCheck(rules, r.reported_at, ER.ymd(r.start_date)),
        ER.sickEvidenceCheck(rules, r),
        ER.returnToWorkCheck(rules, r, now),
      ];
      return {
        id: r.id, staff_id: r.staff_id, staff_name: r.staff_name,
        start_date: ER.ymd(r.start_date), end_date: ER.ymd(r.end_date), status: r.status,
        reported_at: r.reported_at, reported_channel: r.reported_channel,
        timeliness: r.report_timeliness || findings[0].timeliness || 'unknown',
        has_proof: !!r.proof_uploaded_at, proof_kind: r.proof_kind,
        rtw_form_at: r.rtw_form_at, rtw_interview_at: r.rtw_interview_at,
        findings,
        open_points: findings.filter(f => f.status === 'warn').length,
      };
    });
    res.json({
      from,
      count: out.length,
      late_reports: out.filter(r => r.timeliness === 'late').length,
      unknown_reports: out.filter(r => r.timeliness === 'unknown').length,
      missing_rtw: out.filter(r => r.findings[2].status === 'warn').length,
      absences: out,
      note: 'Dates and process only. Nothing here says why anybody was ill, and a fit note is never opened by this endpoint.',
    });
  } catch (e) {
    console.error('[absence/sickness-process]', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
