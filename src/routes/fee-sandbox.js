'use strict';
// b270 (2026-09-02) — Fee Modeller SANDBOX: model next year's fee structure
// without touching a single live fee.
//
// A "scenario" is a named, fully-editable fee structure — a day rate per
// (fee band, days-per-week), plus the weekly consumables rate per band.
//
// ── 2026-11-03 — priced through the invoice engine, child by child ──────────
// Toby: "I just need to make sure that it's 100 percent accurate data… I always
// just like to see all the data because then I know for 100 percent that it's
// correct." The sandbox used to price an anonymous cohort with its own maths
// (src/lib/fee-model.js), and that cohort had drifted from what invoices do:
//   * funding came from the highest term_id, not the current term — ids are not
//     in date order, so it read Summer 26 (55) instead of Autumn 2026 (3);
//   * the room came from children.room_id, not the booking, so rates and cells
//     showed "Any room / no room set";
//   * the band was age on the day, with no Pre-school floor (room_min_fee_band);
//   * a demo child was counted, and standing discounts were not.
// Now every child is priced by buildDfeLineItems — the function that writes the
// real invoices — fed by LEGACY_CHILD_SELECT + applyFeeBandRule exactly as a
// bulk run is. "Now" is the live fee schedule; "new" changes nothing but the
// scenario's day rates and consumables rate. And because the reference month is
// the month just invoiced, every child's "now" is checked against their actual
// invoice for that month, to the penny, on screen.
//
// ── What this route may and may not do ──────────────────────────────────────
//   * Writes ONLY to ladn.fee_scenarios / ladn.fee_scenario_rates.
//     It NEVER writes to ladn.fee_items. Applying a scenario to the live fee
//     schedule is a separate build and a separate decision (Toby's brief).
//   * /simulate and /compare carry each child's name and family, because the
//     manager setting fees asked to see exactly who pays what (manager-only, behind
//     the Roost allow-list). The board paper and the CSV stay anonymous — those
//     get circulated. scripts/b270-verify.js asserts both halves.

const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireCapabilityLevel } = require('../lib/capabilities');
const FM = require('../lib/fee-model');

const AGE_BANDS = ['under_2', '2yo', '3_4yo'];
const BAND_LABEL = { under_2: 'Baby Room (under 2s)', '2yo': '2 year olds', '3_4yo': '3–4 year olds' };
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

router.use(authenticate);

// Fees are commercially sensitive: manager-level only. Two gates, the stricter
// wins — the role check mirrors every other finance route, and the capability
// check is what the Permissions screen can actually report on.
router.use((req, res, next) => {
  const role = req.user?.role;
  if (!['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'].includes(role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});
const canView = requireCapabilityLevel('finance.view', 'view');
const canEdit = requireCapabilityLevel('finance.edit', 'edit');

// The invoice engine. Required lazily: finance-invoices.js is a route module and
// this keeps load order irrelevant.
function engine() {
  const fe = require('./finance-invoices').__feeEngine;
  if (!fe) throw new Error('The invoice engine is not available to the Fee Modeller');
  return fe;
}

// ── settings ────────────────────────────────────────────────────────────────
async function loadSettings(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings
      WHERE key IN ('invoice_session_hours','consumables_enabled','meal_charge_hours_basis',
                    'meal_charge_2yo_weekly_pence','meal_charge_3_4yo_weekly_pence')`);
  const s = {};
  for (const r of rows) s[r.key] = r.value;
  const num = (k, d) => { const n = Number(s[k]); return Number.isFinite(n) && n > 0 ? n : d; };
  const consumablesEnabled = String(s.consumables_enabled || '').toLowerCase() === 'true';
  return {
    dayHours: num('invoice_session_hours', FM.DAY_HOURS),
    consumablesEnabled,
    mealHoursBasis: num('meal_charge_hours_basis', 21.92),
    // The weekly consumables rate a funded child pays (for mealHoursBasis funded
    // hours), as the invoice engine charges it today. Zero when it is switched off.
    mealWeekly: {
      under_2: 0,
      '2yo':   consumablesEnabled ? num('meal_charge_2yo_weekly_pence', 0) : 0,
      '3_4yo': consumablesEnabled ? num('meal_charge_3_4yo_weekly_pence', 0) : 0,
    },
    weeksPerYear: FM.WEEKS_PER_YEAR,
    termWeeks:    FM.TERM_WEEKS,
  };
}

async function getRooms(db) {
  const { rows } = await db.query(
    `SELECT id, name, COALESCE(display_name, name) AS display_name,
            min_age_months, max_age_months, capacity
       FROM rooms ORDER BY min_age_months, id`);
  return rows;
}

// The month the roll is priced in: this calendar month, in London. It is the
// month just invoiced, which is what lets "now" be checked against real invoices.
function referenceMonth(d = new Date()) {
  const iso = d.toLocaleDateString('en-CA', { timeZone: 'Europe/London' });   // YYYY-MM-DD
  const [year, month] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return {
    year, month, todayIso: iso,
    fromIso: `${year}-${mm}-01`, toIso: `${year}-${mm}-${String(last).padStart(2, '0')}`,
    label: new Date(Date.UTC(year, month - 1, 1))
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
  };
}

function isoOf(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

// Funded hours a week exactly as buildDfeLineItems reads them: the current-term
// allocation, nothing at all for an allocation of type 'none' (b532), else the
// child's own flags.
function fundedHoursWeek(c) {
  const none = c.funding_type === 'none';
  const u = none ? 0 : (c.universal_hours_week != null ? parseFloat(c.universal_hours_week) : null);
  const e = none ? 0 : (c.extended_hours_week != null ? parseFloat(c.extended_hours_week) : null);
  const uh = u != null ? u : ((c.funded_hours_30 || c.funded_hours_15) ? 15 : 0);
  const eh = e != null ? e : (c.funded_hours_30 ? 15 : 0);
  const two = (!none && !uh && !eh && c.two_year_funded) ? 15 : 0;
  return FM.round2((uh || 0) + (eh || 0) + two);
}

// ── The roll: every child a bulk invoice run would bill this month ──────────
async function buildRoll(db, { withNames = false } = {}) {
  const ENG = engine();
  const ref = referenceMonth();
  const { year, month } = ref;

  const [{ rows: [term] }, { rows: allTerms }, { rows: mealRows }, { rows: ooRows }] = await Promise.all([
    db.query(`SELECT * FROM funding_terms WHERE is_current = true ORDER BY start_date DESC LIMIT 1`),
    db.query(`SELECT id, start_date, end_date, holiday_dates FROM funding_terms ORDER BY start_date`),
    db.query(`SELECT key, value FROM settings WHERE key IN
               ('meal_charge_2yo_weekly_pence','meal_charge_3_4yo_weekly_pence','meal_charge_hours_basis','consumables_enabled')`),
    db.query(`SELECT o.child_id FROM child_fee_optouts o JOIN fee_items f ON f.id = o.fee_item_id
               WHERE o.opted_out = true AND o.status = 'approved'
                 AND f.formula ILIKE '%weekly_funded_hours%'`),
  ]);
  // Built exactly as POST /api/finance/invoices/generate builds it.
  const ms = Object.fromEntries(mealRows.map(r => [r.key, r.value]));
  const liveMeal = {
    rate2:  (parseFloat(ms.meal_charge_2yo_weekly_pence)   || 0) / 100,
    rate34: (parseFloat(ms.meal_charge_3_4yo_weekly_pence) || 0) / 100,
    basis:  parseFloat(ms.meal_charge_hours_basis) || 21.92,
    enabled: String(ms.consumables_enabled || '').toLowerCase() === 'true',
  };
  const optedOut = new Set(ooRows.map(r => Number(r.child_id)));

  // The invoice run's own children ($1 term, $2/$3 the month), less anyone whose
  // leaving date has already passed — a bulk run would still pick them up, but they
  // are not paying next year's fees.
  const { rows: kids } = await db.query(
    `${ENG.LEGACY_CHILD_SELECT}
       AND (c.leave_date IS NULL OR c.leave_date >= $4::date)
     ORDER BY c.id`, [term ? term.id : null, year, month, ref.todayIso]);
  await ENG.applyFeeBandRule(db, kids, year, month);

  const ids = kids.map(k => k.id);
  const DISC = require('../lib/invoice-discounts');
  const discounts = new Map();
  for (const id of ids) {
    discounts.set(id, await DISC.applicableDiscounts(db, id, ref.fromIso, ref.toIso));
  }

  // This month's real invoice per child: the live one, never a credit note, never one
  // that has since been reissued, never EyLog history.
  const { rows: invRows } = ids.length ? await db.query(
    `SELECT DISTINCT ON (i.child_id) i.child_id, i.id, i.invoice_number, i.amount_pence, i.status
       FROM invoices i
      WHERE i.period_year = $1 AND i.period_month = $2
        AND i.child_id = ANY($3::int[])
        AND i.credit_note_for_id IS NULL AND i.eylog_ref IS NULL
        AND i.status NOT IN ('credit_note','written_off')
        AND NOT EXISTS (SELECT 1 FROM invoices r
                         WHERE r.reissued_from_id = i.id AND r.status <> 'written_off')
      ORDER BY i.child_id, i.id DESC`, [year, month, ids]) : { rows: [] };
  const invoices = new Map(invRows.map(r => [Number(r.child_id), r]));

  // Names and families — only for the screens that show them (never the board paper
  // or the CSV). The family key is the billing email, the one Reconcile and the
  // discount engine group siblings by; it is used here and never sent.
  const people = new Map();
  if (withNames && ids.length) {
    let rows;
    try {
      ({ rows } = await db.query(
        `SELECT c.id, c.first_name, c.last_name, c.preferred_name,
                c.parent_1_name, c.parent_2_name,
                NULLIF(lower(btrim(c.primary_contact_email)), '') AS family_key,
                fr.payment_ref
           FROM children c
           LEFT JOIN family_payment_refs fr
             ON fr.retired_at IS NULL
            AND fr.family_key = NULLIF(lower(btrim(c.primary_contact_email)), '')
          WHERE c.id = ANY($1::int[])`, [ids]));
    } catch (_) {
      ({ rows } = await db.query(
        `SELECT c.id, c.first_name, c.last_name, c.preferred_name,
                c.parent_1_name, c.parent_2_name,
                NULLIF(lower(btrim(c.primary_contact_email)), '') AS family_key,
                NULL AS payment_ref
           FROM children c WHERE c.id = ANY($1::int[])`, [ids]));
    }
    for (const r of rows) people.set(Number(r.id), r);
  }

  return { ENG, ref, term, allTerms, liveMeal, optedOut, discounts, invoices, people, kids };
}

// ── Scenario rates ──────────────────────────────────────────────────────────
function rateKey(r) { return `${r.room_id ?? ''}|${r.age_band ?? ''}|${r.days_per_week ?? ''}`; }
function buildRateIndex(rates) {
  const idx = new Map();
  for (const r of rates) idx.set(rateKey(r), r);
  return idx;
}
// Rates are set per fee band — invoices price by band (age on the 1st of the month,
// then the room floor), never by room. A row saved against a room by the old grid is
// still honoured, but only where no band-wide rate exists.
function lookupRate(rates, band, days) {
  const idx = buildRateIndex(rates);
  const hit = idx.get(`|${band}|${days}`) || idx.get(`|${band}|`);
  if (hit) return hit;
  return rates.filter(r => r.room_id != null && r.age_band === band &&
                           (r.days_per_week === days || r.days_per_week == null))
              .sort((a, b) => (a.days_per_week == null) - (b.days_per_week == null) || a.room_id - b.room_id)[0] || null;
}
function prepScenario(rates) {
  const meal = {};
  for (const b of AGE_BANDS) {
    const r = rates.find(x => x.age_band === b && x.meal_charge_weekly_pence != null);
    meal[b] = r ? Number(r.meal_charge_weekly_pence) || 0 : 0;
  }
  return { rates, meal };
}

// ── Price one child for one standard month ──────────────────────────────────
// scen === null → the live fee schedule, untouched (price overrides included).
// asInvoiced → keep the child's start/leave dates, i.e. exactly this month's bill,
// part month and all; otherwise a standard full month (equally spread, 52/12).
function priceChild(ctx, kid, scen, { asInvoiced = false } = {}) {
  const ENG = ctx.ENG, CAT = ENG.DFE_CATEGORIES;
  const c = { ...kid };
  if (!asInvoiced) { c.start_date = null; c.leave_date = null; }
  if (!(c.booked_days > 0)) return null;               // no booking pattern = nothing to price
  let meal = ctx.liveMeal;
  if (scen) {
    const r = lookupRate(scen.rates, c.fee_band, Number(c.booked_days));
    if (!r) return null;
    c.day_rate_pence = Number(r.day_rate_pence);
    c.catalogue_day_rate_pence = Number(r.day_rate_pence);   // funded hours come off at the NEW hourly rate
    c.price_override_id = null; c.price_override_reason = null;
    meal = { ...ctx.liveMeal, rate2: (scen.meal['2yo'] || 0) / 100, rate34: (scen.meal['3_4yo'] || 0) / 100 };
    meal.enabled = meal.rate2 > 0 || meal.rate34 > 0;
  }
  const DISC = require('../lib/invoice-discounts');
  const out = ENG.buildDfeLineItems({
    child: c, year: ctx.ref.year, month: ctx.ref.month, monthLabel: ctx.ref.label,
    term: ctx.term, allTerms: ctx.allTerms, credits: [],
    discounts: ctx.discounts.get(c.id) || [], meal,
    consumablesOptedOut: ctx.optedOut.has(c.id), extras: [],
  });
  let childcare = 0, funding = 0, consumables = 0, discount = 0, other = 0;
  for (const l of out.lineItems) {
    const a = Number(l.amount_pence) || 0;
    if (l.is_funded) funding += a;
    else if (l.category === CAT.FOOD) consumables += a;
    else if (DISC.isDiscountLine(l)) discount += a;
    else if (l.category === CAT.PAID_HOURS) childcare += a;
    else other += a;
  }
  return {
    day_rate_pence: Number(c.day_rate_pence) || 0,
    childcare_pence: childcare,
    funding_pence: funding,           // negative: funded hours at £0
    consumables_pence: consumables,
    discount_pence: discount,         // negative
    other_pence: other,
    total_pence: out.chargeablePence,
    price_overridden: !!c.price_override_id,
  };
}

function fundingLabel(c) {
  return ({
    under_2: 'Under-2 working parents', '2yr_working': '2-year working parents',
    '2yr_disadvantaged': '2-year (disadvantaged)', two_year: '2-year funding',
    extended: '30 hours', universal: '15 hours',
  })[c.funding_type] || (c.funding_type && c.funding_type !== 'none' ? c.funding_type : null);
}

// ── Price the whole roll under two structures ───────────────────────────────
// a / b: a prepared scenario, or null for the live fee schedule.
function priceRoll(ctx, a, b, { withNames = false } = {}) {
  const IB = require('../services/itemised-billing');
  const famCount = new Map();
  if (withNames) {
    for (const k of ctx.kids) {
      const p = ctx.people.get(k.id);
      if (p && p.family_key) famCount.set(p.family_key, (famCount.get(p.family_key) || 0) + 1);
    }
  }

  const children = [], unpriced = [];
  for (const k of ctx.kids) {
    const days = Number(k.booked_days) || 0;
    const fundedHrs = fundedHoursWeek(k);
    const ageBand = k.date_of_birth ? IB.ageBandOn(isoOf(k.date_of_birth), ctx.ref.fromIso) : null;
    const startIso = isoOf(k.start_date), leaveIso = isoOf(k.leave_date);
    const row = {
      child_id: k.id,
      room: k.booking_room_name || k.room_name || k.room || null,
      band: k.fee_band || null,
      // The room floor moved this child up a band (an under-2 in Pre-school bills at 2yo).
      floor_applied: !!(ageBand && k.fee_band && ageBand !== k.fee_band),
      age_band: ageBand,
      days_per_week: days,
      pattern: DAY_NAMES.filter((_, i) => k[['mon', 'tue', 'wed', 'thu', 'fri'][i]]).join(' '),
      funded: fundedHrs > 0,
      funding_label: fundedHrs > 0 ? fundingLabel(k) : null,
      funded_hours_week: fundedHrs,
      entitlement_hours: fundedHrs > 0
        ? FM.termTimeEntitlement({ totalHoursWeek: fundedHrs, eylogHoursBasis: k.eylog_hours_basis }).entitlementHours
        : 0,
      starts_on: startIso && startIso > ctx.ref.todayIso ? startIso : null,
      leaves_on: leaveIso || null,
      discounts: (ctx.discounts.get(k.id) || []).map(d => d.name),
      consumables_opted_out: ctx.optedOut.has(k.id),
    };
    if (withNames) {
      const p = ctx.people.get(k.id) || {};
      row.name = [p.preferred_name || p.first_name, p.last_name].filter(Boolean).join(' ');
      row.family = [p.parent_1_name, p.parent_2_name].filter(Boolean).join(' & ') || null;
      row.family_ref = p.payment_ref || null;
      row.children_in_family = p.family_key ? (famCount.get(p.family_key) || 1) : 1;
    }

    const pa = priceChild(ctx, k, a);
    const pb = priceChild(ctx, k, b);
    // The check: this month's bill through the engine, against the invoice actually issued.
    const asInv = priceChild(ctx, k, null, { asInvoiced: true });
    const inv = ctx.invoices.get(k.id);
    row.invoice = inv ? {
      invoice_number: inv.invoice_number, status: inv.status,
      amount_pence: Number(inv.amount_pence),
      engine_pence: asInv ? asInv.total_pence : null,
      matches: !!asInv && Number(inv.amount_pence) === asInv.total_pence,
      part_month: !!asInv && pa != null && !a && asInv.total_pence !== pa.total_pence,
    } : null;

    if (!pa || !pb) {
      unpriced.push({ ...row, reason: !days ? 'no booking pattern' : 'no rate for this band and days' });
      continue;
    }
    row.a = pa; row.b = pb;
    row.change_pence = pb.total_pence - pa.total_pence;
    row.change_pct = pa.total_pence ? FM.round2((row.change_pence / pa.total_pence) * 100) : null;
    children.push(row);
  }

  // Toby's order: Baby Room, then 2s, then 3–4s; funded before unfunded; then days.
  const BI = b => { const i = AGE_BANDS.indexOf(b); return i < 0 ? 9 : i; };
  const order = (x, y) => BI(x.band) - BI(y.band) || (y.funded - x.funded) ||
                          x.days_per_week - y.days_per_week;
  children.sort((x, y) => order(x, y) ||
    String(x.name || '').localeCompare(String(y.name || '')) || x.child_id - y.child_id);

  const groups = new Map();
  for (const c of children) {
    const key = `${c.band}|${c.funded ? 'funded' : 'unfunded'}|${c.days_per_week}`;
    if (!groups.has(key)) {
      groups.set(key, { key, band: c.band, funded: c.funded, days_per_week: c.days_per_week,
        children: 0, a_rates: new Set(), b_rates: new Set(),
        a_total_pence: 0, b_total_pence: 0, change_pence: 0, child_ids: [] });
    }
    const g = groups.get(key);
    g.children++; g.child_ids.push(c.child_id);
    g.a_rates.add(c.a.day_rate_pence); g.b_rates.add(c.b.day_rate_pence);
    g.a_total_pence += c.a.total_pence; g.b_total_pence += c.b.total_pence;
    g.change_pence += c.change_pence;
  }
  const groupRows = [...groups.values()].map(g => ({
    ...g,
    a_rates: [...g.a_rates].sort((x, y) => x - y),
    b_rates: [...g.b_rates].sort((x, y) => x - y),
    a_per_child_pence: Math.round(g.a_total_pence / g.children),
    b_per_child_pence: Math.round(g.b_total_pence / g.children),
    change_pct: g.a_total_pence ? FM.round2((g.change_pence / g.a_total_pence) * 100) : null,
  })).sort(order);

  const sum = (f) => children.reduce((s, c) => s + f(c), 0);
  const aTotal = sum(c => c.a.total_pence), bTotal = sum(c => c.b.total_pence);
  let worst = null;
  for (const c of children) if (!worst || c.change_pence > worst.change_pence) worst = c;
  const invChecked = children.concat(unpriced).filter(c => c.invoice);
  const totals = {
    children_priced: children.length,
    children_unpriced: unpriced.length,
    a_monthly_pence: aTotal,
    b_monthly_pence: bTotal,
    change_monthly_pence: bTotal - aTotal,
    change_pct: aTotal ? FM.round2(((bTotal - aTotal) / aTotal) * 100) : 0,
    a_annual_pence: aTotal * 12,
    b_annual_pence: bTotal * 12,
    change_annual_pence: (bTotal - aTotal) * 12,
    b_breakdown: {
      childcare_pence: sum(c => c.b.childcare_pence), funding_pence: sum(c => c.b.funding_pence),
      consumables_pence: sum(c => c.b.consumables_pence), discount_pence: sum(c => c.b.discount_pence),
    },
    a_breakdown: {
      childcare_pence: sum(c => c.a.childcare_pence), funding_pence: sum(c => c.a.funding_pence),
      consumables_pence: sum(c => c.a.consumables_pence), discount_pence: sum(c => c.a.discount_pence),
    },
    paying_more: children.filter(c => c.change_pence > 0).length,
    paying_less: children.filter(c => c.change_pence < 0).length,
    unchanged: children.filter(c => c.change_pence === 0).length,
    avg_change_monthly_pence: children.length ? Math.round((bTotal - aTotal) / children.length) : 0,
    worst_change_monthly_pence: worst ? worst.change_pence : 0,
    worst_child_id: worst ? worst.child_id : null,
    invoice_check: {
      month_label: ctx.ref.label,
      children_with_invoice: invChecked.length,
      matched: invChecked.filter(c => c.invoice.matches).length,
      differ: invChecked.filter(c => !c.invoice.matches).length,
      invoiced_pence: invChecked.reduce((s, c) => s + c.invoice.amount_pence, 0),
      engine_pence: invChecked.reduce((s, c) => s + (c.invoice.engine_pence || 0), 0),
      no_invoice: children.concat(unpriced).filter(c => !c.invoice).length,
    },
  };
  return { totals, groups: groupRows, children, unpriced };
}

// The anonymous view, for the board paper and the CSV: groups and totals only.
function anonymise(priced) {
  return {
    totals: { ...priced.totals, worst_child_id: undefined },
    groups: priced.groups.map(g => ({ ...g, child_ids: undefined })),
  };
}

async function loadRates(db, scenarioId) {
  const { rows } = await db.query(
    `SELECT id, scenario_id, room_id, age_band, days_per_week,
            day_rate_pence, meal_charge_weekly_pence
       FROM fee_scenario_rates WHERE scenario_id = $1
      ORDER BY room_id NULLS FIRST, age_band, days_per_week NULLS FIRST`, [scenarioId]);
  return rows.map(r => ({ ...r, day_rate_pence: Number(r.day_rate_pence),
    meal_charge_weekly_pence: r.meal_charge_weekly_pence == null ? null : Number(r.meal_charge_weekly_pence) }));
}

function normaliseRates(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const r of input) {
    const rate = Number(r.day_rate_pence);
    if (!Number.isFinite(rate) || rate < 0) continue;
    let d = r.days_per_week;
    d = (d === null || d === undefined || d === '') ? null : Number(d);
    if (d !== null && (!Number.isInteger(d) || d < 1 || d > 5)) continue;
    const meal = (r.meal_charge_weekly_pence === null || r.meal_charge_weekly_pence === undefined || r.meal_charge_weekly_pence === '')
      ? null : Number(r.meal_charge_weekly_pence);
    out.push({
      room_id: r.room_id == null || r.room_id === '' ? null : Number(r.room_id),
      age_band: AGE_BANDS.includes(r.age_band) ? r.age_band : null,
      days_per_week: d,
      day_rate_pence: Math.round(rate),
      meal_charge_weekly_pence: meal == null || !Number.isFinite(meal) ? null : Math.round(meal),
    });
  }
  return out;
}

async function replaceRates(db, scenarioId, rates) {
  await db.query(`DELETE FROM fee_scenario_rates WHERE scenario_id = $1`, [scenarioId]);
  for (const r of rates) {
    await db.query(
      `INSERT INTO fee_scenario_rates
         (scenario_id, room_id, age_band, days_per_week, day_rate_pence, meal_charge_weekly_pence)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [scenarioId, r.room_id, r.age_band, r.days_per_week, r.day_rate_pence, r.meal_charge_weekly_pence]);
  }
}

// ── Baseline, read from the LIVE fee schedule (never invented) ──────────────
// One row per (band, days). The live schedule carries a days-per-week ladder as
// fee_items.code = 'session_total_weekday_<N>_<band>'; the flat day rate is
// 'day_<band>' — the one the invoice engine actually charges, so it wins.
async function buildBaselineRates(db) {
  const settings = await loadSettings(db);
  const { rows: items } = await db.query(
    `SELECT code, age_band, price_pence, unit FROM fee_items
      WHERE active AND price_pence IS NOT NULL AND price_pence > 0`);

  const ladder = {};   // band -> days -> pence
  const flat   = {};   // band -> pence
  for (const it of items) {
    let m = /^session_total_weekday_(\d)_(.+)$/.exec(it.code || '');
    if (m) {
      const band = m[2], d = Number(m[1]);
      if (!ladder[band]) ladder[band] = {};
      ladder[band][d] = Number(it.price_pence);
      continue;
    }
    m = /^day_(.+)$/.exec(it.code || '');
    if (m) {
      const band = m[1] === 'under2' ? 'under_2' : m[1];
      flat[band] = Number(it.price_pence);
    }
  }

  const rates = [];
  for (const band of AGE_BANDS) {
    const meal = settings.mealWeekly[band] || null;
    for (let d = 1; d <= 5; d++) {
      const p = flat[band] ?? ladder[band]?.[d];
      if (p) rates.push({ room_id: null, age_band: band, days_per_week: d,
                          day_rate_pence: p, meal_charge_weekly_pence: meal });
    }
  }
  return rates;
}

async function ensureBaseline(db, userId) {
  const { rows: [existing] } = await db.query(
    `SELECT id FROM fee_scenarios WHERE is_baseline = true LIMIT 1`);
  const rates = await buildBaselineRates(db);
  if (existing) {
    await replaceRates(db, existing.id, rates);
    await db.query(`UPDATE fee_scenarios SET updated_at = now() WHERE id = $1`, [existing.id]);
    return { id: existing.id, created: false, rate_count: rates.length };
  }
  const { rows: [s] } = await db.query(
    `INSERT INTO fee_scenarios (name, notes, effective_from, is_baseline, created_by)
     VALUES ($1,$2,CURRENT_DATE,true,$3) RETURNING id`,
    ['Baseline — current live fee schedule',
     'Read from the live fee schedule (ladn.fee_items). Always present so a new structure has something to be compared against.',
     userId || null]);
  await replaceRates(db, s.id, rates);
  return { id: s.id, created: true, rate_count: rates.length };
}

// A scenario id → prepared rates, or null when it is the baseline: the baseline IS
// the live schedule, so it is priced by the engine untouched (price overrides and all).
async function scenarioForPricing(db, id) {
  const { rows: [s] } = await db.query(`SELECT id, name, is_baseline, effective_from FROM fee_scenarios WHERE id = $1`, [id]);
  if (!s) return { s: null, prep: null };
  return { s, prep: s.is_baseline ? null : prepScenario(await loadRates(db, s.id)) };
}

// ── Meta ────────────────────────────────────────────────────────────────────
router.get('/meta', canView, async (req, res) => {
  try {
    const db = getPool();
    const [rooms, settings] = await Promise.all([getRooms(db), loadSettings(db)]);
    await ensureBaseline(db, req.user?.id);   // there is always a baseline to compare against
    const ref = referenceMonth();
    res.json({
      rooms,
      bands: AGE_BANDS.map(b => ({ key: b, label: BAND_LABEL[b] })),
      age_bands: AGE_BANDS.map(b => ({ key: b, label: BAND_LABEL[b] })),
      settings,
      reference_month: { year: ref.year, month: ref.month, label: ref.label },
      constants: {
        weeks_per_year: FM.WEEKS_PER_YEAR,
        term_weeks: FM.TERM_WEEKS,
        day_hours: settings.dayHours,
        eylog_stretch_basis_weeks: FM.EYLOG_STRETCH_BASIS_WEEKS,
        meal_hours_basis: settings.mealHoursBasis,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Scenario CRUD ───────────────────────────────────────────────────────────
router.get('/scenarios', canView, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT s.id, s.name, s.notes, s.effective_from, s.is_baseline,
              s.created_by, s.created_at, s.updated_at,
              (SELECT count(*) FROM fee_scenario_rates r WHERE r.scenario_id = s.id) AS rate_count
         FROM fee_scenarios s
        ORDER BY s.is_baseline DESC, s.updated_at DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Literal paths BEFORE '/scenarios/:id', or ':id' swallows them.
router.post('/scenarios/seed-baseline', canEdit, async (req, res) => {
  try {
    const out = await ensureBaseline(getPool(), req.user?.id);
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/scenarios', canEdit, async (req, res) => {
  const { name, notes, effective_from, copy_from } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });
  try {
    const db = getPool();
    let rates = normaliseRates(req.body?.rates);
    if (!rates.length && copy_from) rates = await loadRates(db, Number(copy_from));
    if (!rates.length) rates = await buildBaselineRates(db);

    const { rows: [s] } = await db.query(
      `INSERT INTO fee_scenarios (name, notes, effective_from, is_baseline, created_by)
       VALUES ($1,$2,$3,false,$4) RETURNING *`,
      [String(name).trim(), notes || null, effective_from || null, req.user?.id || null]);
    await replaceRates(db, s.id, rates);
    res.status(201).json({ ...s, rate_count: rates.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/scenarios/:id', canView, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [s] } = await db.query(`SELECT * FROM fee_scenarios WHERE id = $1`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    res.json({ ...s, rates: await loadRates(db, s.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/scenarios/:id', canEdit, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [s] } = await db.query(`SELECT * FROM fee_scenarios WHERE id = $1`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });

    const { name, notes, effective_from } = req.body || {};
    const sets = [], vals = [];
    if (name != null)           { vals.push(String(name).trim()); sets.push(`name = $${vals.length}`); }
    if (notes !== undefined)    { vals.push(notes || null);       sets.push(`notes = $${vals.length}`); }
    if (effective_from !== undefined) { vals.push(effective_from || null); sets.push(`effective_from = $${vals.length}`); }
    if (sets.length) {
      vals.push(req.params.id);
      await db.query(`UPDATE fee_scenarios SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length}`, vals);
    }
    if (Array.isArray(req.body?.rates)) {
      // The baseline is rebuilt from the live fee schedule every time the screen
      // opens, so a save to it would be silently thrown away. Say so instead.
      if (s.is_baseline) return res.status(400).json({ error: 'The baseline mirrors the live fee schedule — duplicate it to change rates' });
      await replaceRates(db, s.id, normaliseRates(req.body.rates));
      await db.query(`UPDATE fee_scenarios SET updated_at = now() WHERE id = $1`, [s.id]);
    }
    const { rows: [updated] } = await db.query(`SELECT * FROM fee_scenarios WHERE id = $1`, [s.id]);
    res.json({ ...updated, rates: await loadRates(db, s.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/scenarios/:id', canEdit, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [s] } = await db.query(`SELECT is_baseline FROM fee_scenarios WHERE id = $1`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });
    // The baseline is the thing everything else is measured against — keep it.
    if (s.is_baseline) return res.status(400).json({ error: 'The baseline scenario cannot be deleted' });
    await db.query(`DELETE FROM fee_scenarios WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, deleted_id: Number(req.params.id) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Simulate ────────────────────────────────────────────────────────────────
// Body: { scenario_id } or { rates: [...] } (unsaved, as typed in the grid).
// Always priced against the LIVE fee schedule, child by child: that is "what
// they pay now", and it is checked against this month's real invoices.
router.post('/simulate', canView, async (req, res) => {
  try {
    const db = getPool();
    let prep;
    if (Array.isArray(req.body?.rates) && req.body.rates.length) prep = prepScenario(normaliseRates(req.body.rates));
    else if (req.body?.scenario_id) {
      const sc = await scenarioForPricing(db, Number(req.body.scenario_id));
      if (!sc.s) return res.status(404).json({ error: 'Scenario not found' });
      prep = sc.prep;
    } else return res.status(400).json({ error: 'scenario_id or rates required' });
    if (prep && !prep.rates.length) return res.status(400).json({ error: 'scenario has no rates' });

    const ctx = await buildRoll(db, { withNames: true });
    const priced = priceRoll(ctx, null, prep, { withNames: true });
    res.json({
      reference_month: { year: ctx.ref.year, month: ctx.ref.month, label: ctx.ref.label },
      funding_term: ctx.term ? { id: ctx.term.id, name: ctx.term.name } : null,
      a_label: 'Now (live fee schedule)',
      ...priced,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Compare two scenarios, child by child ───────────────────────────────────
router.post('/compare', canView, async (req, res) => {
  try {
    const db = getPool();
    const aId = Number(req.body?.a_id || req.body?.scenario_id_a);
    const bId = Number(req.body?.b_id || req.body?.scenario_id_b);
    if (!aId || !bId) return res.status(400).json({ error: 'a_id and b_id required' });

    const [A, B] = await Promise.all([scenarioForPricing(db, aId), scenarioForPricing(db, bId)]);
    if (!A.s || !B.s) return res.status(404).json({ error: 'One or both scenarios not found' });

    const ctx = await buildRoll(db, { withNames: true });
    const priced = priceRoll(ctx, A.prep, B.prep, { withNames: true });

    // Rate by rate, per band and days. The baseline's rates are the live schedule's.
    const [ratesA, ratesB] = await Promise.all([loadRates(db, aId), loadRates(db, bId)]);
    const rateRows = [];
    for (const band of AGE_BANDS) {
      for (let d = 1; d <= 5; d++) {
        const ra = lookupRate(ratesA, band, d), rb = lookupRate(ratesB, band, d);
        const pA = ra ? Number(ra.day_rate_pence) : null;
        const pB = rb ? Number(rb.day_rate_pence) : null;
        if (pA == null && pB == null) continue;
        rateRows.push({
          age_band: band, days_per_week: d, a_pence: pA, b_pence: pB,
          children: priced.children.filter(c => c.band === band && c.days_per_week === d).length,
          change_pence: (pA != null && pB != null) ? pB - pA : null,
          change_pct: (pA && pB != null) ? FM.round2(((pB - pA) / pA) * 100) : null,
        });
      }
    }

    res.json({
      reference_month: { year: ctx.ref.year, month: ctx.ref.month, label: ctx.ref.label },
      a: { ...A.s, priced_as: A.s.is_baseline ? 'live fee schedule' : 'scenario rates' },
      b: { ...B.s, priced_as: B.s.is_baseline ? 'live fee schedule' : 'scenario rates' },
      rates: rateRows,
      ...priced,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Export: CSV (rate table + change column + totals), anonymous ────────────
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const pounds = p => p == null ? '' : (Number(p) / 100).toFixed(2);

router.get('/scenarios/:id/export.csv', canView, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [s] } = await db.query(`SELECT * FROM fee_scenarios WHERE id = $1`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });

    const settings = await loadSettings(db);
    const rates    = await loadRates(db, s.id);
    const { rows: [base] } = await db.query(`SELECT id, name FROM fee_scenarios WHERE is_baseline = true LIMIT 1`);
    const baseRates = base ? await loadRates(db, base.id) : [];

    const ctx = await buildRoll(db);
    const priced = anonymise(priceRoll(ctx, null, s.is_baseline ? null : prepScenario(rates)));
    const t = priced.totals;

    const L = [];
    L.push(['Fee scenario', s.name].map(csvCell).join(','));
    L.push(['Effective from', s.effective_from ? isoOf(s.effective_from) : ''].map(csvCell).join(','));
    L.push(['Compared against', 'the live fee schedule'].map(csvCell).join(','));
    L.push(['Children as at', ctx.ref.label].map(csvCell).join(','));
    L.push(['Basis', `invoice engine, ${settings.weeksPerYear} weeks/year spread over 12 months, ${settings.dayHours}-hour day`].map(csvCell).join(','));
    L.push('');
    L.push('Band,Days per week,Day rate (£),Current rate (£),Change (£),Change (%)');
    for (const band of AGE_BANDS) {
      for (let d = 1; d <= 5; d++) {
        const r = lookupRate(rates, band, d), b = lookupRate(baseRates, band, d);
        if (!r) continue;
        const p = Number(r.day_rate_pence), bp = b ? Number(b.day_rate_pence) : null;
        L.push([BAND_LABEL[band], d, pounds(p), pounds(bp),
          bp == null ? '' : pounds(p - bp), bp ? (((p - bp) / bp) * 100).toFixed(2) : ''].map(csvCell).join(','));
      }
    }
    L.push('');
    L.push('Totals,Now (£),This structure (£),Change (£)');
    L.push(['Monthly', pounds(t.a_monthly_pence), pounds(t.b_monthly_pence), pounds(t.change_monthly_pence)].map(csvCell).join(','));
    L.push(['Annual', pounds(t.a_annual_pence), pounds(t.b_annual_pence), pounds(t.change_annual_pence)].map(csvCell).join(','));
    L.push(['Children priced', t.children_priced].map(csvCell).join(','));
    L.push(['Change (%)', t.change_pct].map(csvCell).join(','));
    L.push('');
    L.push('Band,Funded,Days,Children,Now per child / month (£),New per child / month (£),Change per child / month (£),Now total / month (£),New total / month (£)');
    for (const g of priced.groups) {
      L.push([BAND_LABEL[g.band] || g.band, g.funded ? 'Funded' : 'Not funded', g.days_per_week, g.children,
        pounds(g.a_per_child_pence), pounds(g.b_per_child_pence),
        pounds(g.b_per_child_pence - g.a_per_child_pence),
        pounds(g.a_total_pence), pounds(g.b_total_pence)].map(csvCell).join(','));
    }

    const slug = String(s.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="fee-scenario-${s.id}-${slug}.csv"`);
    res.send(L.join('\n'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Board paper: the printable summary, as data — anonymous ─────────────────
router.get('/scenarios/:id/board-paper', canView, async (req, res) => {
  try {
    const db = getPool();
    const { rows: [s] } = await db.query(`SELECT * FROM fee_scenarios WHERE id = $1`, [req.params.id]);
    if (!s) return res.status(404).json({ error: 'Not found' });

    const settings = await loadSettings(db);
    const rates    = await loadRates(db, s.id);
    const { rows: [base] } = await db.query(`SELECT id, name FROM fee_scenarios WHERE is_baseline = true LIMIT 1`);
    const baseRates = base ? await loadRates(db, base.id) : [];

    const ctx = await buildRoll(db);
    const priced = anonymise(priceRoll(ctx, null, s.is_baseline ? null : prepScenario(rates)));

    const rateRows = [];
    for (const band of AGE_BANDS) {
      for (let d = 1; d <= 5; d++) {
        const r = lookupRate(rates, band, d), b = lookupRate(baseRates, band, d);
        if (!r) continue;
        const p = Number(r.day_rate_pence), bp = b ? Number(b.day_rate_pence) : null;
        rateRows.push({
          age_band: band, days_per_week: d, day_rate_pence: p, baseline_pence: bp,
          change_pence: bp == null ? null : p - bp,
          change_pct: bp ? FM.round2(((p - bp) / bp) * 100) : null,
        });
      }
    }

    res.json({
      scenario: s,
      baseline: base || null,
      reference_month: { year: ctx.ref.year, month: ctx.ref.month, label: ctx.ref.label },
      basis: { weeks_per_year: settings.weeksPerYear, term_weeks: settings.termWeeks, day_hours: settings.dayHours },
      rates: rateRows,
      totals: priced.totals,
      groups: priced.groups,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
// Exported for scripts/b270-verify.js — the pricing must be assertable without
// standing up an HTTP server.
module.exports.__test = { buildRoll, priceRoll, priceChild, prepScenario, buildBaselineRates, loadSettings, lookupRate, referenceMonth };
