'use strict';
/* ===========================================================================
 * leave.js — b522 (2026-10-20)
 *
 * The hours-based holiday allowance: policy, the per-person card, the ledger,
 * the bank-holiday cache, and the opening-balance import for the January
 * switch off BrightHR.
 *
 * WHAT IS NOT HERE, ON PURPOSE
 * ----------------------------
 * Booking, approving and declining absence, the month/year/grid calendar, the
 * Bradford factor and the sickness process all already live in
 * src/routes/absence.js and this file does not re-implement any of them. The
 * new Roost pages call BOTH: /api/absence for the calendar and the request
 * queue, /api/leave for the allowance and the ledger. One absence request has
 * one home, and it is the one it already had.
 *
 * WHO CAN SEE WHAT
 * ----------------
 *   • anyone signed in: their OWN card and their OWN ledger ('/my', and
 *     /:staffId where :staffId is themselves).
 *   • manager / deputy_manager / admin: everyone's card, the dashboard, the
 *     ledger, adjustments, the policy, the opening-balance import.
 * There is no third tier. A room leader can already see their room's rota;
 * a colleague's holiday balance is not the same class of fact, so it is not
 * readable by role here, and anything that should widen it should widen it
 * deliberately rather than by inheriting from the rota.
 *
 * Parent tokens: 'leave' is in PARENT_DENY in editions/ladn/server-unified.js,
 * and this router refuses role=parent on its own as the belt-and-braces layer.
 * ===========================================================================*/

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const LH = require('../lib/leave-hours');
const LE = require('../lib/leave-entitlement');
const LHS = require('../services/leave-hours-service');

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner'];
const isManager = req => MANAGER_ROLES.includes(req.user && req.user.role);
const managerOnly = (req, res, next) =>
  isManager(req) ? next() : res.status(403).json({ error: 'Manager access required' });

// A parent token has no business anywhere in here. The server's PARENT_DENY set
// already stops it; this is the router's own refusal, so the rule survives a
// future mount that forgets the list.
router.use((req, res, next) => {
  if (req.user && req.user.role === 'parent') return res.status(403).json({ error: 'Not available' });
  next();
});

router.param('staffId', (req, res, next, v) => {
  if (!/^\d+$/.test(v)) return res.status(404).json({ error: 'Not found' });
  next();
});
router.param('id', (req, res, next, v) => {
  if (!/^\d+$/.test(v)) return res.status(404).json({ error: 'Not found' });
  next();
});

/** Self, or a manager. Returns the resolved staff id or sends a 403. */
function resolveSubject(req, res) {
  const want = parseInt(req.params.staffId, 10);
  const me = parseInt(req.user && req.user.id, 10);
  if (!want) { res.status(400).json({ error: 'staffId required' }); return null; }
  if (want === me || isManager(req)) return want;
  res.status(403).json({ error: 'You can only see your own leave record' });
  return null;
}

const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

// ═══════════════════════════════════════════════════════════════════════════
// POLICY
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/leave/policy — the setting's leave policy, plus what it implies.
router.get('/policy', async (req, res) => {
  const db = getPool();
  try {
    const policy = await LHS.hoursPolicy(db);
    const year = LE.holidayYearFor(new Date().toISOString().slice(0, 10), policy.yearStartMd);
    let fetchedAt = null, closures = [];
    try {
      const { rows } = await db.query(
        `SELECT value FROM ${SCHEMA()}.settings WHERE key='leave_bh_fetched_at'`);
      fetchedAt = rows.length ? rows[0].value : null;
    } catch (_) { /* optional */ }
    closures = await LHS.closureRows(db, year.yearStart, year.yearEnd);
    const bhs = await LHS.bankHolidayRows(db, year.yearStart, year.yearEnd, policy.division);
    res.json({
      policy, year,
      bank_holidays: bhs,
      bank_holidays_fetched_at: fetchedAt,
      closures,
      // Said in words, because the sentence is the thing a manager needs to be
      // able to read back to a member of staff who disagrees with their balance.
      explanation: [
        `Everyone's allowance is ${policy.contractWeeks} weeks of their own contracted hours.`,
        policy.bhDeduct
          ? 'Bank holidays are INSIDE that allowance: one falling on a contracted working day deducts that day\'s hours automatically, and one falling on a non-working day deducts nothing.'
          : 'Bank holidays are NOT deducted from the allowance.',
        policy.closureDeduct
          ? 'Nursery closure days are deducted the same way.'
          : 'Nursery closure days are NOT deducted from the allowance.',
        `The holiday year runs ${year.yearStart} to ${year.yearEnd}.`,
        policy.carryCapHours > 0
          ? `Up to ${policy.carryCapHours} hours may be carried into the next year.`
          : 'No hours carry into the next year unless a manager enters a carry-over figure for someone.',
      ],
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/leave/policy — manager. Only the keys named here, only sane values.
router.put('/policy', managerOnly, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const writes = [];
  if (num(b.contract_weeks) != null) {
    const w = num(b.contract_weeks);
    if (w <= 0 || w > 12) return res.status(400).json({ error: 'Contract weeks must be between 0 and 12' });
    if (w < LH.STATUTORY_WEEKS) {
      // Allowed, but it is a statement about the law and the response says so.
      // The engine tops every individual up to the statutory floor anyway.
      writes.push(['leave_contract_weeks', String(w)]);
    } else writes.push(['leave_contract_weeks', String(w)]);
  }
  if (b.year_start_md != null) {
    if (!/^\d{2}-\d{2}$/.test(String(b.year_start_md)))
      return res.status(400).json({ error: 'Holiday-year start must be MM-DD' });
    writes.push(['leave_year_start_md', String(b.year_start_md)]);
  }
  if (b.bh_deduct != null) writes.push(['leave_bh_deduct', b.bh_deduct ? 'true' : 'false']);
  if (b.closure_deduct != null) writes.push(['leave_closure_deduct', b.closure_deduct ? 'true' : 'false']);
  if (num(b.carry_cap_hours) != null) {
    const c = num(b.carry_cap_hours);
    if (c < 0 || c > 400) return res.status(400).json({ error: 'Carry-over cap must be between 0 and 400 hours' });
    writes.push(['leave_carry_over_cap_hours', String(c)]);
  }
  if (!writes.length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    for (const [k, v] of writes) {
      await db.query(
        `INSERT INTO ${SCHEMA()}.settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, v]);
    }
    const policy = await LHS.hoursPolicy(db);
    res.json({
      ok: true, changed: writes.map(w => w[0]), policy,
      note: policy.contractWeeks < LH.STATUTORY_WEEKS
        ? `${policy.contractWeeks} weeks is below the ${LH.STATUTORY_WEEKS}-week statutory minimum. Every individual allowance is still topped up to the minimum, so nobody is short — but the setting itself no longer describes what people get.`
        : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// BANK HOLIDAYS
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/leave/bank-holidays?from=&to=
router.get('/bank-holidays', async (req, res) => {
  const db = getPool();
  const y = new Date().getFullYear();
  const from = isDate(req.query.from) ? req.query.from : `${y}-01-01`;
  const to   = isDate(req.query.to)   ? req.query.to   : `${y + 2}-12-31`;
  try {
    const policy = await LHS.hoursPolicy(db);
    const rows = await LHS.bankHolidayRows(db, from, to, policy.division);
    res.json({ from, to, division: policy.division, count: rows.length, dates: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leave/bank-holidays/refresh — manager. Re-fetch the gov.uk feed.
// The ONLY outbound request in this file. A failure changes nothing: the
// response carries the reason and the cache is left exactly as it was.
router.post('/bank-holidays/refresh', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const out = await LHS.refreshBankHolidays(db, { dryRun: !!(req.body && req.body.dry_run) });
    res.status(out.ok ? 200 : 502).json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// THE CARD
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/leave/allowance/my?on=YYYY-MM-DD — the signed-in person's own card.
router.get('/allowance/my', async (req, res) => {
  const db = getPool();
  const me = parseInt(req.user && req.user.id, 10);
  if (!me) return res.status(400).json({ error: 'No staff id on this token' });
  try {
    res.json(await LHS.allowanceFor(db, me, { on: req.query.on }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leave/allowances?on= — manager. Every active person's card, for the
// dashboard. Heavier than it looks (the bank-holiday sweep runs per person), so
// the ledger is omitted; the person page fetches that.
router.get('/allowances', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const out = await LHS.allAllowances(db, { on: req.query.on });
    // A dashboard wants the figures, not five hundred workings.
    out.people = out.people.map(p => p.error ? p : ({
      staff_id: p.staff_id, staff_name: p.staff_name, role: p.role, room_id: p.room_id,
      pattern: p.pattern,
      allowance_hours: p.allowance.allowanceHours,
      total_available_hours: p.balance.totalAvailableHours,
      taken_hours: p.balance.takenHours,
      booked_hours: p.balance.bookedHours,
      pending_hours: p.balance.pendingHours,
      bank_holiday_hours: p.balance.bankHolidayHours,
      closure_hours: p.balance.closureHours,
      adjustment_hours: p.balance.adjustmentHours,
      remaining_hours: p.balance.remainingHours,
      percent_remaining: p.balance.percentRemaining,
      in_days: p.in_days,
      accrued_hours: p.accrued.accruedHours,
      accrual_mode: p.allowance.accrualMode,
      opening_balance: p.opening_balance,
      manual_override: p.manual_override,
      set: p.balance.set,
      not_set_reason: p.balance.notSetReason,
      employment: p.employment,
      ledger_counts: p.ledger_counts,
    }));
    const set = out.people.filter(p => p.set);
    out.totals = {
      people: out.people.length,
      with_an_allowance: set.length,
      without_a_pattern: out.people.filter(p => !p.set).length,
      allowance_hours: LH.round2(set.reduce((a, p) => a + (p.allowance_hours || 0), 0)),
      remaining_hours: LH.round2(set.reduce((a, p) => a + (p.remaining_hours || 0), 0)),
      bank_holiday_hours: LH.round2(set.reduce((a, p) => a + (p.bank_holiday_hours || 0), 0)),
      pending_hours: LH.round2(out.people.reduce((a, p) => a + (p.pending_hours || 0), 0)),
    };
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/leave/allowance/:staffId?on= — self or manager. The full card.
router.get('/allowance/:staffId', async (req, res) => {
  const id = resolveSubject(req, res);
  if (!id) return;
  const db = getPool();
  try {
    res.json(await LHS.allowanceFor(db, id, { on: req.query.on }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leave/allowance/:staffId/recompute — manager. Recalculate AND write
// the figure down, so the number a screen showed can be audited later.
router.post('/allowance/:staffId/recompute', managerOnly, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.staffId, 10);
  try {
    const r = await LHS.allowanceFor(db, id, { on: req.body && req.body.on });
    await LHS.persist(db, r);
    res.json({ ok: true, allowance: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leave/recompute-all — manager. The same for everyone active.
router.post('/recompute-all', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const out = await LHS.allAllowances(db, { on: req.body && req.body.on });
    let written = 0; const problems = [];
    for (const p of out.people) {
      if (p.error) { problems.push({ staff_id: p.staff_id, error: p.error }); continue; }
      try { await LHS.persist(db, p); written += 1; }
      catch (e) { problems.push({ staff_id: p.staff_id, error: e.message }); }
    }
    res.json({ ok: true, year: out.year, written, problems });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/leave/allowance/:staffId — manager. The per-person knobs:
// contract_weeks, accrual_mode, carry_in_hours, and a manual override of the
// figure itself. Writes staff_leave_years; never touches b309's days columns.
router.put('/allowance/:staffId', managerOnly, async (req, res) => {
  const db = getPool();
  const s = SCHEMA();
  const id = parseInt(req.params.staffId, 10);
  const b = req.body || {};
  try {
    const policy = await LHS.hoursPolicy(db);
    const on = isDate(b.on) ? b.on : new Date().toISOString().slice(0, 10);
    const year = LE.holidayYearFor(on, policy.yearStartMd);

    if (b.contract_weeks != null && b.contract_weeks !== '' && !(num(b.contract_weeks) > 0 && num(b.contract_weeks) <= 12))
      return res.status(400).json({ error: 'Contract weeks must be between 0 and 12' });
    if (b.accrual_mode != null && !['fixed', 'irregular_1207'].includes(String(b.accrual_mode)))
      return res.status(400).json({ error: 'Accrual mode must be "fixed" or "irregular_1207"' });
    if (b.allowance_hours != null && b.allowance_hours !== '' && !(num(b.allowance_hours) >= 0))
      return res.status(400).json({ error: 'The allowance must be a number of hours, 0 or more' });

    const override = b.manual_override === true || b.manual_override === 'true';
    if (override && num(b.allowance_hours) == null)
      return res.status(400).json({ error: 'A manual override needs an allowance figure in hours' });
    if (override && !String(b.override_reason || '').trim())
      return res.status(400).json({ error: 'A manual override needs a reason — it is what the workings will show instead of the calculation' });

    await db.query(`
      INSERT INTO ${s}.staff_leave_years
        (staff_id, year_start, year_end, unit, contract_weeks, accrual_mode,
         carry_in_hours, carry_cap_hours, allowance_hours,
         hours_manual_override, hours_override_reason, created_at, updated_at)
      VALUES ($1,$2::date,$3::date,'hours',$4,$5,$6,$7,$8,$9,$10,now(),now())
      ON CONFLICT (staff_id, year_start) DO UPDATE SET
        unit                  = 'hours',
        contract_weeks        = COALESCE($4, ${s}.staff_leave_years.contract_weeks),
        accrual_mode          = COALESCE($5, ${s}.staff_leave_years.accrual_mode),
        carry_in_hours        = COALESCE($6, ${s}.staff_leave_years.carry_in_hours),
        carry_cap_hours       = COALESCE($7, ${s}.staff_leave_years.carry_cap_hours),
        allowance_hours       = CASE WHEN $9 THEN $8 ELSE ${s}.staff_leave_years.allowance_hours END,
        hours_manual_override = $9,
        hours_override_reason = CASE WHEN $9 THEN $10 ELSE NULL END,
        updated_at            = now()`,
      [id, year.yearStart, year.yearEnd,
       num(b.contract_weeks), b.accrual_mode || null,
       num(b.carry_in_hours), num(b.carry_cap_hours),
       num(b.allowance_hours), override, b.override_reason || null]);

    const r = await LHS.allowanceFor(db, id, { on });
    await LHS.persist(db, r);
    res.json({ ok: true, allowance: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// THE LEDGER
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/leave/ledger/:staffId?on= — self or manager.
router.get('/ledger/:staffId', async (req, res) => {
  const id = resolveSubject(req, res);
  if (!id) return;
  const db = getPool();
  try {
    const r = await LHS.allowanceFor(db, id, { on: req.query.on });
    res.json({
      staff_id: id, staff_name: r.staff_name, year: r.year,
      balance: r.balance, ledger: r.ledger, counts: r.ledger_counts,
      pattern: r.pattern, opening_balance: r.opening_balance,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leave/ledger/:staffId — manager. A hand adjustment, signed.
// `hours` POSITIVE gives hours back, NEGATIVE takes them away, and the form
// label says exactly that — the sign is the whole meaning of the entry, so it
// is never inferred from a separate "type" dropdown.
router.post('/ledger/:staffId', managerOnly, async (req, res) => {
  const db = getPool();
  const s = SCHEMA();
  const id = parseInt(req.params.staffId, 10);
  const b = req.body || {};
  const hours = num(b.hours);
  if (hours == null || hours === 0)
    return res.status(400).json({ error: 'Enter a number of hours — positive to add to the allowance, negative to take from it' });
  if (Math.abs(hours) > 2000)
    return res.status(400).json({ error: 'That is more hours than a year contains — check the figure' });
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Give the adjustment a short label, so the ledger reads as a sentence' });
  try {
    const policy = await LHS.hoursPolicy(db);
    const on = isDate(b.entry_date) ? b.entry_date : (isDate(b.on) ? b.on : new Date().toISOString().slice(0, 10));
    const year = LE.holidayYearFor(on, policy.yearStartMd);
    const kind = b.kind === 'accrual' ? 'accrual' : 'adjustment';
    const { rows } = await db.query(`
      INSERT INTO ${s}.staff_leave_ledger
        (staff_id, year_start, entry_date, kind, hours, label, detail, source, created_by, created_at, updated_at)
      VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,'manual',$8,now(),now())
      RETURNING id`,
      [id, year.yearStart, isDate(b.entry_date) ? b.entry_date : null, kind,
       LH.round2(hours), label, b.detail || null, req.user.id]);
    const r = await LHS.allowanceFor(db, id, { on });
    res.json({ ok: true, id: rows[0].id, balance: r.balance, ledger: r.ledger });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leave/ledger/:id/void and /unvoid — manager. Exempting a generated
// line (a bank holiday someone worked, a closure day that did not apply to them)
// WITHOUT deleting it, so the ledger still shows that it was once deducted.
//
// The sweep that regenerates bank-holiday lines deliberately leaves a human's
// void alone — see leave-hours-service.syncAutoLedger — so this sticks.
router.post('/ledger/:id/void', managerOnly, async (req, res) => {
  const db = getPool();
  const s = SCHEMA();
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'Give a reason — it is what the ledger will show in place of the deduction' });
  if (reason.startsWith(LHS.AUTO_VOID_PREFIX))
    return res.status(400).json({ error: 'That wording is reserved for the automatic sweep — please write your own reason' });
  try {
    const { rows } = await db.query(`
      UPDATE ${s}.staff_leave_ledger
         SET is_void=true, void_reason=$2, voided_by=$3, voided_at=now(), updated_at=now()
       WHERE id=$1 RETURNING staff_id, year_start::text AS year_start`,
      [parseInt(req.params.id, 10), reason, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = await LHS.allowanceFor(db, rows[0].staff_id, { on: rows[0].year_start });
    res.json({ ok: true, balance: r.balance, ledger: r.ledger });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/ledger/:id/unvoid', managerOnly, async (req, res) => {
  const db = getPool();
  const s = SCHEMA();
  try {
    const { rows } = await db.query(`
      UPDATE ${s}.staff_leave_ledger
         SET is_void=false, void_reason=NULL, voided_by=NULL, voided_at=NULL, updated_at=now()
       WHERE id=$1 RETURNING staff_id, year_start::text AS year_start`,
      [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = await LHS.allowanceFor(db, rows[0].staff_id, { on: rows[0].year_start });
    res.json({ ok: true, balance: r.balance, ledger: r.ledger });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// OPENING BALANCES — the January switch off BrightHR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse an opening-balance CSV. Deliberately forgiving about the SHAPE of the
 * file (BrightHR's own export, a hand-typed sheet, column order, a BOM) and
 * deliberately unforgiving about the CONTENT: a row that does not match exactly
 * one member of staff is reported, never guessed at, because an opening balance
 * credited to the wrong person is a balance nobody will think to check.
 *
 * Columns, matched case- and space-insensitively, first match wins:
 *   who   : staff_id | id | employee | name | staff | full name | employee name
 *   hours : hours | remaining | remaining hours | balance | opening balance
 *   note  : note | notes | comment
 */
function parseCsv(text) {
  const out = { rows: [], errors: [] };
  const clean = String(text || '').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();
  if (!clean) { out.errors.push('The file was empty.'); return out; }
  const lines = clean.split('\n').filter(l => l.trim());
  if (lines.length < 2) { out.errors.push('The file needs a header row and at least one data row.'); return out; }

  // A tiny RFC-4180 splitter: quoted fields, doubled quotes inside them.
  const split = line => {
    const cells = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === ',') { cells.push(cur); cur = ''; }
      else cur += c;
    }
    cells.push(cur);
    return cells.map(x => x.trim());
  };

  const norm = h => String(h).toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  const head = split(lines[0]).map(norm);
  const find = names => { for (const n of names) { const i = head.indexOf(n); if (i >= 0) return i; } return -1; };
  const iWho = find(['staff id', 'id', 'employee', 'name', 'staff', 'full name', 'employee name']);
  const iHrs = find(['hours', 'remaining', 'remaining hours', 'balance', 'opening balance', 'remaining balance']);
  const iNote = find(['note', 'notes', 'comment']);
  if (iWho < 0) { out.errors.push(`No column naming the person. The header was: ${head.join(', ')}. One of these is needed: staff id, id, name, employee.`); }
  if (iHrs < 0) { out.errors.push(`No column of hours. The header was: ${head.join(', ')}. One of these is needed: hours, remaining, balance, opening balance.`); }
  if (out.errors.length) return out;

  for (let i = 1; i < lines.length; i++) {
    const c = split(lines[i]);
    const who = (c[iWho] || '').trim();
    const raw = (c[iHrs] || '').trim();
    if (!who && !raw) continue;
    const hours = Number(String(raw).replace(/[^0-9.\-]/g, ''));
    out.rows.push({
      line: i + 1, who,
      hours: Number.isFinite(hours) ? Math.round(hours * 100) / 100 : null,
      hours_raw: raw,
      note: iNote >= 0 ? (c[iNote] || '').trim() : '',
    });
  }
  if (!out.rows.length) out.errors.push('No data rows were readable.');
  return out;
}

/** Match a CSV "who" to exactly one member of staff, or say why not. */
async function matchStaff(db, who) {
  const s = SCHEMA();
  if (/^\d+$/.test(who)) {
    const { rows } = await db.query(
      `SELECT id, first_name, last_name FROM ${s}.staff WHERE id=$1`, [parseInt(who, 10)]);
    if (!rows.length) return { error: `No member of staff has id ${who}.` };
    return { staff_id: rows[0].id, name: `${rows[0].first_name} ${rows[0].last_name}`.trim(), matched_on: 'id' };
  }
  const { rows } = await db.query(`
    SELECT id, first_name, last_name FROM ${s}.staff
     WHERE COALESCE(is_active,true)=true
       AND (lower(first_name || ' ' || last_name) = lower($1)
         OR lower(COALESCE(preferred_name,'') || ' ' || last_name) = lower($1)
         OR lower(COALESCE(email,'')) = lower($1))`, [who]);
  if (!rows.length) return { error: `No active member of staff matches "${who}".` };
  if (rows.length > 1) {
    return { error: `"${who}" matches ${rows.length} people (ids ${rows.map(r => r.id).join(', ')}). Use the staff id instead.` };
  }
  return { staff_id: rows[0].id, name: `${rows[0].first_name} ${rows[0].last_name}`.trim(), matched_on: 'name' };
}

// POST /api/leave/opening-balances/preview — manager. Parse and match, write
// NOTHING. The import below takes the same body; previewing first is the point.
router.post('/opening-balances/preview', managerOnly, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const parsed = parseCsv(b.csv);
  if (parsed.errors.length) return res.status(400).json({ errors: parsed.errors });
  try {
    const policy = await LHS.hoursPolicy(db);
    const asAt = isDate(b.as_at) ? b.as_at : new Date().toISOString().slice(0, 10);
    const on = isDate(b.on) ? b.on : asAt;
    const year = LE.holidayYearFor(on, policy.yearStartMd);
    const mode = b.mode === 'replaces_remaining' ? 'replaces_remaining' : 'carry_in';
    const rows = [];
    for (const r of parsed.rows) {
      const m = await matchStaff(db, r.who);
      rows.push({
        ...r, ...m,
        ok: !m.error && r.hours != null && r.hours >= 0,
        problem: m.error || (r.hours == null ? `"${r.hours_raw}" is not a number of hours.`
          : (r.hours < 0 ? 'A negative opening balance is not something this import will write — enter it as an adjustment instead.' : null)),
      });
    }
    res.json({
      year, mode, as_at: asAt,
      mode_means: mode === 'carry_in'
        ? `Each figure will be treated as hours CARRIED INTO ${year.label}, added on top of the allowance Wren calculates.`
        : `Each figure will be treated as the person's REMAINING balance on ${asAt}. Wren will then count only deductions dated on or after that day, and ignore anything before it.`,
      rows, ready: rows.filter(r => r.ok).length, problems: rows.filter(r => !r.ok).length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/leave/opening-balances/import — manager. Writes only the rows that
// matched exactly one person; refuses the whole file if any row is a problem
// unless `skip_problems` is explicitly set, because a half-imported set of
// balances is harder to spot than a rejected file.
router.post('/opening-balances/import', managerOnly, async (req, res) => {
  const db = getPool();
  const s = SCHEMA();
  const b = req.body || {};
  const parsed = parseCsv(b.csv);
  if (parsed.errors.length) return res.status(400).json({ errors: parsed.errors });
  try {
    const policy = await LHS.hoursPolicy(db);
    // `as_at` is the cutover day and normally sits inside the year being
    // imported; `on` overrides which year that is, same as the single-person
    // PUT above, so the two paths pick a year by one rule and not two.
    const asAt = isDate(b.as_at) ? b.as_at : new Date().toISOString().slice(0, 10);
    const on = isDate(b.on) ? b.on : asAt;
    const year = LE.holidayYearFor(on, policy.yearStartMd);
    const mode = b.mode === 'replaces_remaining' ? 'replaces_remaining' : 'carry_in';

    const resolved = [];
    for (const r of parsed.rows) {
      const m = await matchStaff(db, r.who);
      resolved.push({ ...r, ...m, ok: !m.error && r.hours != null && r.hours >= 0 });
    }
    const problems = resolved.filter(r => !r.ok);
    if (problems.length && !b.skip_problems) {
      return res.status(400).json({
        error: `${problems.length} of ${resolved.length} rows could not be matched to exactly one member of staff, so nothing was imported. Fix them, or send skip_problems to import the rest.`,
        problems: problems.map(p => ({ line: p.line, who: p.who, problem: p.error || `"${p.hours_raw}" is not a number of hours.` })),
      });
    }
    let written = 0;
    for (const r of resolved.filter(x => x.ok)) {
      await db.query(`
        INSERT INTO ${s}.staff_leave_years
          (staff_id, year_start, year_end, unit, opening_balance_hours, opening_balance_mode,
           opening_balance_as_at, opening_balance_note, opening_balance_source,
           opening_balance_by, opening_balance_at, created_at, updated_at)
        VALUES ($1,$2::date,$3::date,'hours',$4,$5,$6::date,$7,'csv',$8,now(),now(),now())
        ON CONFLICT (staff_id, year_start) DO UPDATE SET
          opening_balance_hours = EXCLUDED.opening_balance_hours,
          opening_balance_mode  = EXCLUDED.opening_balance_mode,
          opening_balance_as_at = EXCLUDED.opening_balance_as_at,
          opening_balance_note  = EXCLUDED.opening_balance_note,
          opening_balance_source= 'csv',
          opening_balance_by    = EXCLUDED.opening_balance_by,
          opening_balance_at    = now(),
          updated_at            = now()`,
        [r.staff_id, year.yearStart, year.yearEnd, r.hours, mode, asAt,
         r.note || `Imported from CSV on ${new Date().toISOString().slice(0, 10)}`, req.user.id]);
      written += 1;
    }
    res.json({ ok: true, year, mode, as_at: asAt, written, skipped: problems.length,
               problems: problems.map(p => ({ line: p.line, who: p.who, problem: p.error })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/leave/opening-balance/:staffId — manager. One person, by hand.
// hours = null clears it.
router.put('/opening-balance/:staffId', managerOnly, async (req, res) => {
  const db = getPool();
  const s = SCHEMA();
  const id = parseInt(req.params.staffId, 10);
  const b = req.body || {};
  const hours = num(b.hours);
  if (hours != null && (hours < 0 || hours > 2000))
    return res.status(400).json({ error: 'An opening balance must be between 0 and 2000 hours' });
  const mode = b.mode === 'replaces_remaining' ? 'replaces_remaining' : 'carry_in';
  try {
    const policy = await LHS.hoursPolicy(db);
    // TWO dates, and conflating them was a bug: `as_at` is the day the figure
    // describes, `on` is any day inside the leave year being edited. They are
    // usually the same, and in January they are NOT — a manager clearing a 2027
    // balance while it is still October 2026 was silently clearing the 2026 row
    // and getting a cheerful 200 back. The year is now chosen explicitly, and
    // the response names it so the caller can see which one it wrote.
    const asAt = isDate(b.as_at) ? b.as_at : new Date().toISOString().slice(0, 10);
    const on = isDate(b.on) ? b.on : asAt;
    const year = LE.holidayYearFor(on, policy.yearStartMd);
    await db.query(`
      INSERT INTO ${s}.staff_leave_years
        (staff_id, year_start, year_end, unit, opening_balance_hours, opening_balance_mode,
         opening_balance_as_at, opening_balance_note, opening_balance_source,
         opening_balance_by, opening_balance_at, created_at, updated_at)
      VALUES ($1,$2::date,$3::date,'hours',$4,$5,$6::date,$7,'manual',$8,now(),now(),now())
      ON CONFLICT (staff_id, year_start) DO UPDATE SET
        opening_balance_hours  = EXCLUDED.opening_balance_hours,
        opening_balance_mode   = CASE WHEN EXCLUDED.opening_balance_hours IS NULL THEN NULL ELSE EXCLUDED.opening_balance_mode END,
        opening_balance_as_at  = CASE WHEN EXCLUDED.opening_balance_hours IS NULL THEN NULL ELSE EXCLUDED.opening_balance_as_at END,
        opening_balance_note   = EXCLUDED.opening_balance_note,
        opening_balance_source = CASE WHEN EXCLUDED.opening_balance_hours IS NULL THEN NULL ELSE 'manual' END,
        opening_balance_by     = EXCLUDED.opening_balance_by,
        opening_balance_at     = now(),
        updated_at             = now()`,
      [id, year.yearStart, year.yearEnd, hours, mode, hours == null ? null : asAt,
       b.note || null, req.user.id]);
    const r = await LHS.allowanceFor(db, id, { on });
    res.json({ ok: true, year, as_at: hours == null ? null : asAt, allowance: r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// SICKNESS — the stats a dashboard shows next to the holiday figures
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/leave/sickness?months=12 — manager. Sickness per person: the
// Bradford score, and spells/days over a window the caller chooses.
//
// The score comes from services/bradford-factor.js, which is also what the
// Bradford watchlist on the existing absence page uses — one score, one
// definition, and if the formula is ever argued about it is argued about once.
// NOTE its real contract: it takes a window END DATE and always looks back
// exactly 52 weeks. It does NOT take a number of months. So `months` here
// governs the spell/day counts this endpoint computes itself, and the score is
// labelled rolling_12m because that is what it is — the two are reported as
// separate figures rather than one figure pretending to follow the filter.
router.get('/sickness', managerOnly, async (req, res) => {
  const db = getPool();
  const s = SCHEMA();
  const months = [3, 6, 12, 24].includes(parseInt(req.query.months, 10))
    ? parseInt(req.query.months, 10) : 12;
  try {
    const { calculateBradfordFactor } = require('../services/bradford-factor');
    const { rows: staff } = await db.query(
      `SELECT id, first_name || ' ' || last_name AS name, role, room_id
         FROM ${s}.staff WHERE COALESCE(is_active,true)=true AND COALESCE(terminated,false)=false
        ORDER BY first_name, last_name`);

    // Spells and days in the chosen window, from BOTH absence tables with the
    // same precedence rule as everywhere else: an absence_requests row wins for
    // a given (staff_id, start_date) and the hr_absences twin is suppressed.
    const { rows: win } = await db.query(`
      WITH ar AS (
        SELECT staff_id, start_date, COALESCE(days_count, duration_days, 1)::numeric AS days
          FROM ${s}.absence_requests
         WHERE status='approved'
           AND (LOWER(COALESCE(request_type,''))='sick' OR LOWER(COALESCE(absence_type,''))='sick')
           AND start_date >= (CURRENT_DATE - ($1 || ' months')::interval)
      ),
      hr AS (
        SELECT h.staff_id, h.start_date, COALESCE(h.duration_days,1)::numeric AS days
          FROM ${s}.hr_absences h
         WHERE LOWER(COALESCE(h.absence_type,'')) LIKE 'sick%'
           AND h.start_date >= (CURRENT_DATE - ($1 || ' months')::interval)
           AND NOT EXISTS (SELECT 1 FROM ar WHERE ar.staff_id=h.staff_id AND ar.start_date=h.start_date)
      )
      SELECT staff_id, count(*)::int AS spells, ROUND(SUM(days),1) AS days
        FROM (SELECT * FROM ar UNION ALL SELECT * FROM hr) x
       GROUP BY staff_id`, [String(months)]);
    const byStaff = new Map(win.map(r => [r.staff_id, r]));

    const out = [];
    for (const st of staff) {
      let bf = null;
      try { bf = await calculateBradfordFactor(db, st.id); } catch (_) { bf = null; }
      const w = byStaff.get(st.id);
      out.push({
        staff_id: st.id, name: st.name, role: st.role, room_id: st.room_id,
        // The score and its classification, over the service's own 52 weeks.
        bradford_rolling_12m: bf ? { score: bf.score, instances: bf.instances,
                                     days_total: bf.days_total, classification: bf.classification } : null,
        // And the window the caller actually asked for.
        window: { months, spells: w ? w.spells : 0, days: w ? Number(w.days) : 0 },
      });
    }
    out.sort((a, b) => (b.bradford_rolling_12m ? b.bradford_rolling_12m.score : 0)
                     - (a.bradford_rolling_12m ? a.bradford_rolling_12m.score : 0));
    res.json({
      months, people: out,
      note: 'The Bradford score always covers a rolling 52 weeks (S squared x D, where S is distinct spells and D is total days). The spells and days under "window" follow the filter.',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
