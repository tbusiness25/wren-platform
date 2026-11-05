'use strict';
// ============================================================================
// b114 — Fee items / funding rates / opt-outs / calculator / stretch recon
// Mounted at /api/fee-items. Manager-guarded. Additive — no existing invoice
// machinery is replaced; the itemised invoice generator lives in
// finance-invoices.js and writes into the same invoices table.
// ============================================================================

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const IB = require('../services/itemised-billing');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
const managerGuard = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

const VALID_CATEGORIES = ['additional_paid_hours', 'food', 'non_food_consumables', 'activities', 'funded_entitlement'];
const VALID_UNITS = ['session', 'day', 'week'];
const VALID_BANDS = ['under_2', '2yo', '3_4yo'];

// ── helpers ───────────────────────────────────────────────────────────────────
async function currentTerm(db) {
  const { rows: [t] } = await db.query(
    `SELECT * FROM funding_terms WHERE is_current=true ORDER BY start_date DESC LIMIT 1`);
  return t || null;
}
async function fundingRatesMap(db, year) {
  // Latest funding_rates for a year, keyed by band → pence_per_hour.
  const { rows } = await db.query(
    `SELECT age_band, pence_per_hour FROM funding_rates
     WHERE ($1::text IS NULL OR funding_year=$1) ORDER BY updated_at DESC`, [year || null]);
  const m = {};
  for (const r of rows) if (!(r.age_band in m)) m[r.age_band] = Number(r.pence_per_hour);
  return m;
}
function rateForBand(map, band) {
  // 3_4yo funding is the 3yo hourly rate.
  if (band === '3_4yo') return map['3yo'] || map['3_4yo'] || 0;
  return map[band] || 0;
}
// b216 — the fee-formula variables that live in ladn.settings (meal rates,
// reviewed each April). Every caller of buildItemisedLines has to supply these or
// a formula naming one throws: an unknown identifier is rejected rather than
// silently evaluated as zero, which is the right way round.
// b299 — meal_charge_hours_basis is no longer read. It existed only to divide a
// rate by 21.92 funded hours, and a charge scaled by funded hours is a shortfall.
async function formulaVarsFor(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN
      ('meal_charge_2yo_weekly_pence','meal_charge_3_4yo_weekly_pence')`);
  return IB.mealFormulaVars(Object.fromEntries(rows.map(r => [r.key, r.value])));
}

async function activeFeeItems(db) {
  const { rows } = await db.query(`SELECT * FROM fee_items ORDER BY id`);
  return rows;
}
// Approved opt-out fee_item ids for a child.
async function approvedOptOuts(db, childId) {
  const { rows } = await db.query(
    `SELECT fee_item_id FROM child_fee_optouts
     WHERE child_id=$1 AND opted_out=true AND status='approved'`, [childId]);
  return rows.map(r => Number(r.fee_item_id));
}

// ════════════════════════════════════════════════════════════════════════════
// FEE ITEMS CRUD (with effective dating)
// ════════════════════════════════════════════════════════════════════════════
router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const onDate = req.query.on_date || null;
    const { rows } = await db.query(`SELECT * FROM fee_items ORDER BY statutory_category, age_band NULLS FIRST, effective_from`);
    let items = rows;
    if (onDate) items = rows.filter(it => IB.itemActiveOn(it, String(onDate).slice(0, 10)));
    res.json({ fee_items: items, count: items.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/', async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  if (!b.name || !VALID_CATEGORIES.includes(b.statutory_category))
    return res.status(400).json({ error: 'name and valid statutory_category required' });
  if (b.unit && !VALID_UNITS.includes(b.unit)) return res.status(400).json({ error: 'invalid unit' });
  if (b.age_band && !VALID_BANDS.includes(b.age_band)) return res.status(400).json({ error: 'invalid age_band' });
  if (b.price_pence != null && Number(b.price_pence) < 0) return res.status(400).json({ error: 'price_pence cannot be negative' });
  // Validate any formula up front so bad expressions never reach billing.
  // Validate against the SAME variable set billing uses. b299 dropped
  // weekly_funded_hours, so a shortfall formula is refused here rather than
  // saving cleanly and then throwing at invoice time.
  if (b.formula) { try { IB.evalFormula(b.formula, { days: 5, weekly_funded_hours: 15, ...await formulaVarsFor(db) }, { allowFundedHours: b.optoutable !== false }); }
    catch (e) { return res.status(400).json({ error: 'Invalid formula: ' + e.message }); } }
  try {
    const { rows: [row] } = await db.query(`
      INSERT INTO fee_items
        (code, name, statutory_category, unit, price_pence, formula, age_band, optoutable,
         waive_when_funding_covers_day, note, effective_from, effective_to, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true),COALESCE($9,false),$10,
              COALESCE($11,CURRENT_DATE),$12,COALESCE($13,true))
      RETURNING *`,
      [b.code || null, b.name, b.statutory_category, b.unit || 'day',
       b.price_pence != null ? parseInt(b.price_pence) : null, b.formula || null,
       b.age_band || null, b.optoutable, b.waive_when_funding_covers_day, b.note || null,
       b.effective_from || null, b.effective_to || null, b.active]);
    recordAudit({ req, action: 'create', entity_type: 'fee_item', entity_id: row.id, meta: { name: row.name } });
    res.json({ ok: true, fee_item: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/:id', async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  if (b.statutory_category && !VALID_CATEGORIES.includes(b.statutory_category))
    return res.status(400).json({ error: 'invalid statutory_category' });
  if (b.unit && !VALID_UNITS.includes(b.unit)) return res.status(400).json({ error: 'invalid unit' });
  if (b.age_band && !VALID_BANDS.includes(b.age_band)) return res.status(400).json({ error: 'invalid age_band' });
  if (b.price_pence != null && Number(b.price_pence) < 0) return res.status(400).json({ error: 'price_pence cannot be negative' });
  // Validate against the SAME variable set billing uses. b299 dropped
  // weekly_funded_hours, so a shortfall formula is refused here rather than
  // saving cleanly and then throwing at invoice time.
  if (b.formula) { try { IB.evalFormula(b.formula, { days: 5, weekly_funded_hours: 15, ...await formulaVarsFor(db) }, { allowFundedHours: b.optoutable !== false }); }
    catch (e) { return res.status(400).json({ error: 'Invalid formula: ' + e.message }); } }
  try {
    const cols = ['name', 'statutory_category', 'unit', 'price_pence', 'formula', 'age_band',
      'optoutable', 'waive_when_funding_covers_day', 'note', 'effective_from', 'effective_to', 'active'];
    const sets = [], vals = [];
    for (const c of cols) if (c in b) { vals.push(b[c] === '' ? null : b[c]); sets.push(`${c}=$${vals.length}`); }
    if (!sets.length) return res.json({ ok: true });
    sets.push('updated_at=NOW()');
    vals.push(req.params.id);
    const { rows: [row] } = await db.query(
      `UPDATE fee_items SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!row) return res.status(404).json({ error: 'Not found' });
    recordAudit({ req, action: 'update', entity_type: 'fee_item', entity_id: row.id });
    res.json({ ok: true, fee_item: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Soft-delete: end-date + deactivate (never hard-delete — invoices reference it).
router.delete('/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [row] } = await db.query(
      `UPDATE fee_items SET active=false, effective_to=COALESCE(effective_to,CURRENT_DATE), updated_at=NOW()
       WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    recordAudit({ req, action: 'deactivate', entity_type: 'fee_item', entity_id: row.id });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// FUNDING RATES (with provisional toggle)
// ════════════════════════════════════════════════════════════════════════════
router.get('/funding-rates', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM funding_rates ORDER BY funding_year DESC, age_band`);
    res.json({ funding_rates: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/funding-rates', async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  if (!b.age_band || !b.funding_year || b.pence_per_hour == null)
    return res.status(400).json({ error: 'age_band, funding_year, pence_per_hour required' });
  if (Number(b.pence_per_hour) < 0) return res.status(400).json({ error: 'pence_per_hour cannot be negative' });
  try {
    const { rows: [row] } = await db.query(`
      INSERT INTO funding_rates (age_band, pence_per_hour, funding_year, provisional)
      VALUES ($1,$2,$3,COALESCE($4,true))
      ON CONFLICT (age_band, funding_year)
      DO UPDATE SET pence_per_hour=EXCLUDED.pence_per_hour, provisional=EXCLUDED.provisional, updated_at=NOW()
      RETURNING *`, [b.age_band, parseInt(b.pence_per_hour), b.funding_year, b.provisional]);
    recordAudit({ req, action: 'upsert', entity_type: 'funding_rate', entity_id: row.id });
    res.json({ ok: true, funding_rate: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Confirm a provisional year (provisional=false) or a single rate.
router.post('/funding-rates/confirm', async (req, res) => {
  const db = getPool();
  const { funding_year, id } = req.body || {};
  try {
    let row;
    if (id) ({ rows: [row] } = await db.query(
      `UPDATE funding_rates SET provisional=false, updated_at=NOW() WHERE id=$1 RETURNING *`, [id]));
    else if (funding_year) await db.query(
      `UPDATE funding_rates SET provisional=false, updated_at=NOW() WHERE funding_year=$1`, [funding_year]);
    else return res.status(400).json({ error: 'id or funding_year required' });
    recordAudit({ req, action: 'confirm', entity_type: 'funding_rate', meta: { funding_year, id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// OPT-OUT APPROVALS QUEUE
// ════════════════════════════════════════════════════════════════════════════
router.get('/optouts', async (req, res) => {
  const db = getPool();
  try {
    const status = req.query.status || null;
    const { rows } = await db.query(`
      SELECT o.*, c.first_name||' '||c.last_name AS child_name, fi.name AS fee_item_name,
             fi.statutory_category, fi.optoutable
      FROM child_fee_optouts o
      JOIN children c ON c.id=o.child_id
      JOIN fee_items fi ON fi.id=o.fee_item_id
      WHERE ($1::text IS NULL OR o.status=$1)
      ORDER BY (o.status='pending') DESC, o.created_at DESC`, [status]);
    res.json({ optouts: rows, count: rows.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Manager can create an opt-out directly (already approved).
router.post('/optouts', async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  if (!b.child_id || !b.fee_item_id) return res.status(400).json({ error: 'child_id and fee_item_id required' });
  try {
    const { rows: exist } = await db.query(
      `SELECT (SELECT 1 FROM children WHERE id=$1) AS child_ok, (SELECT 1 FROM fee_items WHERE id=$2) AS item_ok`,
      [b.child_id, b.fee_item_id]);
    if (!exist[0].child_ok) return res.status(400).json({ error: 'child_id not found' });
    if (!exist[0].item_ok) return res.status(400).json({ error: 'fee_item_id not found' });
    const { rows: [row] } = await db.query(`
      INSERT INTO child_fee_optouts (child_id, fee_item_id, opted_out, status, effective_from, requested_by, approved_by, approved_at, note)
      VALUES ($1,$2,COALESCE($3,true),'approved',COALESCE($4,CURRENT_DATE),$5,$6,NOW(),$7)
      ON CONFLICT (child_id, fee_item_id)
      DO UPDATE SET opted_out=EXCLUDED.opted_out, status='approved', approved_by=EXCLUDED.approved_by,
                    approved_at=NOW(), effective_from=EXCLUDED.effective_from, note=EXCLUDED.note, updated_at=NOW()
      RETURNING *`,
      [b.child_id, b.fee_item_id, b.opted_out, b.effective_from, req.user.name || 'staff', req.user.id, b.note || null]);
    recordAudit({ req, action: 'create', entity_type: 'fee_optout', entity_id: row.id, meta: { child_id: b.child_id } });
    res.json({ ok: true, optout: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/optouts/:id/approve', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [row] } = await db.query(`
      UPDATE child_fee_optouts SET status='approved', approved_by=$1, approved_at=NOW(), updated_at=NOW()
      WHERE id=$2 RETURNING *`, [req.user.id, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    recordAudit({ req, action: 'approve', entity_type: 'fee_optout', entity_id: row.id });
    res.json({ ok: true, optout: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/optouts/:id/reject', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [row] } = await db.query(`
      UPDATE child_fee_optouts SET status='rejected', opted_out=false, approved_by=$1, approved_at=NOW(),
             note=COALESCE($2,note), updated_at=NOW()
      WHERE id=$3 RETURNING *`, [req.user.id, (req.body || {}).note || null, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    recordAudit({ req, action: 'reject', entity_type: 'fee_optout', entity_id: row.id });
    res.json({ ok: true, optout: row });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// CALCULATOR — itemised estimate from the SAME tables (one source of truth).
// Body: { age_band | date_of_birth, weekly_funded_hours, days_per_week,
//         funded_days_per_week, private_days_per_week, weeks, opted_out_item_ids,
//         on_date }
// ════════════════════════════════════════════════════════════════════════════
router.post('/calculate', async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  try {
    const term = await currentTerm(db);
    const feeItems = await activeFeeItems(db);
    const ratesMap = await fundingRatesMap(db, b.funding_year || null);
    const ageBand = b.age_band || IB.ageBandFromDob(b.date_of_birth);
    if (!ageBand) return res.status(400).json({ error: 'age_band or date_of_birth required' });
    if (!VALID_BANDS.includes(ageBand)) return res.status(400).json({ error: 'invalid age_band' });
    if (Number(b.weekly_funded_hours || 0) < 0) return res.status(400).json({ error: 'weekly_funded_hours cannot be negative' });
    if (b.weeks != null && Number(b.weeks) < 0) return res.status(400).json({ error: 'weeks cannot be negative' });
    const daysPerWeek = Number(b.days_per_week || 0);
    const fundedDays = b.funded_days_per_week != null ? Number(b.funded_days_per_week) : daysPerWeek;
    const privateDays = b.private_days_per_week != null ? Number(b.private_days_per_week)
                       : Math.max(0, daysPerWeek - fundedDays);
    const result = IB.buildItemisedLines({
      ageBand,
      weeklyFundedHours: Number(b.weekly_funded_hours || 0),
      daysPerWeek, fundedDaysPerWeek: fundedDays, privateDaysPerWeek: privateDays,
      weeks: Number(b.weeks || IB.WEEKS_PER_MONTH),
      feeItems, fundingRatePence: rateForBand(ratesMap, ageBand),
      optedOutItemIds: b.opted_out_item_ids || [],
      periodLabel: b.period_label || '', onDateIso: (b.on_date || IB.AGE_BAND_REFERENCE),
      formulaVars: await formulaVarsFor(db),
    });
    res.json({ ok: true, age_band: ageBand, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════
// STRETCH RECONCILIATION — July-leavers view. Read-only evidence.
// Ealing pays term-time only (no August). Uses funding_terms as the
// claimable calendar. Per stretched-funded child WITH a leave_date:
//   annual entitlement hrs · delivered (register) · claimable (Ealing calendar)
//   · claimed (if recorded) · delta · verdict.
// ════════════════════════════════════════════════════════════════════════════
// Count funded weekdays (Mon–Fri) in [startIso, endIso] across term ranges,
// excluding each term's holiday_dates. Ealing's real funded calendar therefore
// lives entirely in funding_terms — fixing the table fixes this report.
function fundedWeekdaysBetween(startIso, endIso, terms) {
  if (!startIso || !endIso || endIso < startIso) return 0;
  let count = 0;
  const start = new Date(startIso + 'T00:00:00Z'), end = new Date(endIso + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    const inTerm = terms.some(t => {
      const s = IB.toIso(t.start_date), e = IB.toIso(t.end_date);
      if (!s || !e || iso < s || iso > e) return false;
      const hols = Array.isArray(t.holiday_dates) ? t.holiday_dates
                 : (t.holiday_dates && Array.isArray(t.holiday_dates.dates) ? t.holiday_dates.dates : []);
      return !hols.map(x => IB.toIso(x)).includes(iso);
    });
    if (inTerm) count++;
  }
  return count;
}

router.get('/stretch-reconciliation', async (req, res) => {
  const db = getPool();
  try {
    const term = await currentTerm(db);
    const { rows: terms } = await db.query(
      `SELECT id, start_date, end_date, holiday_dates FROM funding_terms ORDER BY start_date`);
    const asOf = (req.query.as_of || new Date().toISOString().slice(0, 10)).slice(0, 10);

    // Stretched-funded children with a leave_date. Aggregate register + bookings
    // in SQL; compute calendar weeks + verdict in JS.
    const { rows: kids } = await db.query(`
      SELECT c.id AS child_id, c.leave_date, c.start_date,
             COALESCE(c.stretch_weeks, 52) AS stretch_weeks,
             cf.total_hours_week, cf.universal_hours_week, cf.extended_hours_week,
             cf.hours_used AS claimed_hours,
             (SELECT COUNT(DISTINCT a.date) FROM attendance a
                WHERE a.child_id=c.id AND a.absent IS NOT TRUE
                  AND a.date >= $1 AND a.date <= LEAST(c.leave_date, $2::date)) AS attended_days,
             (SELECT COALESCE(SUM((cb.mon::int+cb.tue::int+cb.wed::int+cb.thu::int+cb.fri::int)),0)
                FROM child_bookings cb
                WHERE cb.child_id=c.id AND cb.is_active=true AND COALESCE(cb.funded,true)=true) AS booked_days_per_week
      FROM children c
      JOIN child_funding cf ON cf.child_id=c.id AND cf.term_id=$3
      WHERE cf.stretched_funding=true AND c.leave_date IS NOT NULL
      ORDER BY c.leave_date`, [
        term ? term.start_date : '2026-04-06', asOf, term ? term.id : null]);

    const termStart = term ? IB.toIso(term.start_date) : '2026-04-06';
    const report = kids.map(k => {
      const totalWk = Number(k.total_hours_week || 0);
      const stretchWeeks = Number(k.stretch_weeks) || 52;
      const annualEntitlement = round2(totalWk * stretchWeeks);           // stretched annual funded hrs
      const termtimeWeekly = round2(annualEntitlement / IB.FUNDED_WEEKS_PER_YEAR);
      const leaveIso = k.leave_date ? IB.toIso(k.leave_date) : asOf;
      const endIso = leaveIso < asOf ? leaveIso : asOf;
      // Claimable under the Ealing calendar (term-time only, from funding_terms).
      const claimableWeekdays = fundedWeekdaysBetween(termStart, endIso, terms);
      const claimableWeeks = claimableWeekdays / 5;
      const claimableHrs = round2(claimableWeeks * termtimeWeekly);
      // Delivered from the attendance register.
      const bookedDays = Number(k.booked_days_per_week) || 5;
      const hrsPerFundedDay = bookedDays > 0 ? termtimeWeekly / bookedDays : 0;
      const deliveredHrs = round2(Number(k.attended_days || 0) * hrsPerFundedDay);
      const claimedHrs = k.claimed_hours != null ? round2(Number(k.claimed_hours)) : null;
      const delta = round2(claimableHrs - deliveredHrs);   // + => claimable ahead of delivery
      let verdict;
      if (Math.abs(delta) < 0.5) verdict = 'in step';
      else if (delta > 0) verdict = `paid ahead of delivery by ${delta.toFixed(1)} hrs`;
      else verdict = `under-claimed by ${Math.abs(delta).toFixed(1)} hrs`;
      return {
        child_id: k.child_id, leave_date: leaveIso,
        annual_entitlement_hrs: annualEntitlement,
        termtime_weekly_hrs: termtimeWeekly,
        delivered_hrs: deliveredHrs,
        claimable_hrs: claimableHrs,
        claimed_hrs: claimedHrs,
        claimable_weekdays: claimableWeekdays,
        attended_days: Number(k.attended_days || 0),
        delta_hrs: delta,
        verdict,
      };
    });

    res.json({
      ok: true, as_of: asOf, term: term ? term.name : null,
      calendar_note: 'Claimable hours are counted from funding_terms (Ealing funds term-time only — no August). If a term row still ends 31 Aug or lacks summer holiday_dates, the claimable column over-states; encode Ealing’s real funded weeks in funding_terms to correct it. Report is read-only evidence — no claims are made.',
      count: report.length, children: report,
    });
  } catch (e) { console.error('[fee-items] stretch-recon error:', e.message); res.status(500).json({ error: e.message }); }
});

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

module.exports = router;
