'use strict';
// staff-celebrations.js — credited-service maths + upcoming-events computation
// for b142 (birthdays, work anniversaries, Christmas, Eid). No shift-level/FTE
// maths — credit_factor bands are a manager judgement call, that's the point.
//
// Dates are handled as 'YYYY-MM-DD' strings throughout (queried with ::text)
// to avoid node-postgres's local-timezone Date parsing for the DATE type.

const { getPool } = require('../db/pool');

const MONTH_DAYS = 30.436875; // 365.2425 / 12
const DAY_MS = 86400000;

const CHECKLIST_ITEMS_BY_TYPE = {
  birthday:    ['card', 'vouchers'],
  christmas:   ['card', 'vouchers'],
  anniversary: ['card', 'vouchers', 'flowers', 'window_notice', 'newsletter'],
  eid:         ['flowers'],
  other:       ['card', 'vouchers'],
};

const CHECKLIST_ITEM_LABELS = {
  card: 'Card ordered (right size to hold vouchers flat!)',
  vouchers: 'Vouchers ordered',
  flowers: 'Flowers timed with handover',
  window_notice: 'Congratulations notice up in front window',
  newsletter: 'Line added to parents newsletter',
};

const DEFAULT_POLICY = {
  birthday_voucher: 50,
  christmas_tiers: [50, 70, 100],
  anniversary_milestones: { '5': 200, '10': 300, '15': 400, '20': 500, every_5_after_20: 500 },
  notice_lead_days: 14,
  card_size_reminder: 'Card must be large enough to hold the vouchers flat — check before ordering.',
};

function todayStr(d) {
  const dt = d || new Date();
  return dt.toISOString().slice(0, 10);
}

function parseISO(dateStr) {
  return new Date(dateStr + 'T00:00:00Z');
}

function diffDays(dateStr, asOfStr) {
  return Math.round((parseISO(dateStr) - parseISO(asOfStr)) / DAY_MS);
}

function addDays(dateStr, days) {
  const dt = parseISO(dateStr);
  dt.setUTCDate(dt.getUTCDate() + Math.round(days));
  return dt.toISOString().slice(0, 10);
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Next occurrence (this year or next) of a recurring month/day, on or after asOfStr.
function nextOccurrenceOfMonthDay(baseDateStr, asOfStr) {
  const base = parseISO(baseDateStr);
  const asOf = parseISO(asOfStr);
  const month = base.getUTCMonth();
  let day = base.getUTCDate();
  const asOfYear = asOf.getUTCFullYear();
  const candidateYear = year => {
    if (month === 1 && day === 29 && !isLeapYear(year)) return 28; // clamp 29 Feb
    return day;
  };
  let year = asOfYear;
  let d = new Date(Date.UTC(year, month, candidateYear(year)));
  if (d < asOf) {
    year += 1;
    d = new Date(Date.UTC(year, month, candidateYear(year)));
  }
  return d.toISOString().slice(0, 10);
}

function monthsBetween(startStr, endStr) {
  const days = (parseISO(endStr) - parseISO(startStr)) / DAY_MS;
  return Math.max(0, days / MONTH_DAYS);
}

async function getPolicy() {
  const db = getPool();
  const { rows } = await db.query(`SELECT value FROM settings WHERE key='staff_celebration_policy'`);
  if (!rows.length) return DEFAULT_POLICY;
  try { return { ...DEFAULT_POLICY, ...JSON.parse(rows[0].value) }; }
  catch { return DEFAULT_POLICY; }
}

async function setPolicy(policy, updatedBy) {
  const db = getPool();
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('staff_celebration_policy',$1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=NOW()`,
    [JSON.stringify(policy), updatedBy || null]
  );
  return policy;
}

function anniversaryAmount(policy, years) {
  const m = policy.anniversary_milestones || {};
  if (m[String(years)] != null) return Number(m[String(years)]);
  if (years >= 20 && m.every_5_after_20 != null) return Number(m.every_5_after_20);
  return null;
}

// ── Credited service ─────────────────────────────────────────────────────────

async function getServicePeriods(staffId) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT id, staff_id, start_date::text, end_date::text, engagement_type, credit_factor, notes,
            created_at, updated_at
     FROM staff_service_periods WHERE staff_id=$1 ORDER BY start_date`,
    [staffId]
  );
  return rows.map(r => ({ ...r, credit_factor: Number(r.credit_factor) }));
}

async function getBaseline(staffId) {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT staff_id, baseline_months, as_of_date::text, agreed_by, note, created_at, updated_at
     FROM staff_service_baseline WHERE staff_id=$1`,
    [staffId]
  );
  if (!rows.length) return null;
  return { ...rows[0], baseline_months: Number(rows[0].baseline_months) };
}

// Computes credited months as of `asOf` (defaults to today), plus the next
// 5-year milestone and its projected date along the open period's credit factor.
async function computeCreditedService(staffId, opts) {
  const asOf = (opts && opts.asOf) || todayStr();
  const [periods, baseline] = await Promise.all([getServicePeriods(staffId), getBaseline(staffId)]);

  // A period straddling the baseline date must be CLIPPED to start at the
  // baseline (its pre-baseline time is already folded into baseline_months),
  // not excluded outright — excluding it dropped all post-baseline credit too,
  // including for periods still open today (2026-07-23 q01 finding).
  const eligible = baseline
    ? periods
        .filter(p => !p.end_date || p.end_date > baseline.as_of_date)
        .map(p => (p.start_date <= baseline.as_of_date ? { ...p, start_date: baseline.as_of_date } : p))
    : periods;

  let creditedMonths = baseline ? baseline.baseline_months : 0;
  for (const p of eligible) {
    const end = p.end_date || asOf;
    if (end < p.start_date) continue;
    creditedMonths += monthsBetween(p.start_date, end) * p.credit_factor;
  }

  // Most recently-started open (end_date NULL) eligible period — used to project forward.
  const openPeriods = eligible.filter(p => !p.end_date).sort((a, b) => (a.start_date < b.start_date ? 1 : -1));
  const openPeriod = openPeriods[0] || null;

  const currentMonthsFloor = Math.floor(creditedMonths / 60) * 60;
  const nextMilestoneMonths = currentMonthsFloor + 60;
  const nextMilestoneYears = nextMilestoneMonths / 12;

  let nextMilestoneDate = null;
  if (openPeriod && openPeriod.credit_factor > 0) {
    const monthsNeeded = nextMilestoneMonths - creditedMonths;
    const daysNeeded = (monthsNeeded * MONTH_DAYS) / openPeriod.credit_factor;
    nextMilestoneDate = addDays(asOf, daysNeeded);
  }

  return {
    staff_id: staffId,
    as_of: asOf,
    credited_months: Math.round(creditedMonths * 100) / 100,
    credited_years: Math.round((creditedMonths / 12) * 100) / 100,
    next_milestone_years: nextMilestoneYears,
    next_milestone_date: nextMilestoneDate,
    accruing: !!(openPeriod && openPeriod.credit_factor > 0),
    open_period: openPeriod,
    baseline,
    periods,
  };
}

// ── Checklist ─────────────────────────────────────────────────────────────────

function eventKey(e) {
  const year = e.date.slice(0, 4);
  if (e.type === 'birthday') return `birthday-${e.staff_id}-${year}`;
  if (e.type === 'anniversary') return `anniversary-${e.staff_id}-${year}-${e.milestone_years}`;
  if (e.type === 'christmas') return `christmas-${e.staff_id}-${year}`;
  return `occasion-${e.occasion_id}-${year}`;
}

async function ensureChecklistRow(e) {
  const db = getPool();
  const key = eventKey(e);
  const year = Number(e.date.slice(0, 4));
  await db.query(
    `INSERT INTO staff_celebration_checklist
       (event_key, event_type, staff_id, occasion_id, event_date, event_year, milestone_years, title, voucher_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (event_key) DO NOTHING`,
    [key, e.type, e.staff_id || null, e.occasion_id || null, e.date, year,
     e.milestone_years || null, e.title || null, e.voucher_amount != null ? e.voucher_amount : null]
  );
  const { rows } = await db.query(
    `SELECT id, event_key, event_type, staff_id, occasion_id, event_date::text, event_year,
            milestone_years, title, voucher_amount, voucher_tier, checklist_state, created_at, updated_at
     FROM staff_celebration_checklist WHERE event_key=$1`,
    [key]
  );
  return rows[0];
}

// ── Upcoming events ───────────────────────────────────────────────────────────

async function getUpcomingEvents(daysAhead, opts) {
  const asOf = (opts && opts.asOf) || todayStr();
  const db = getPool();
  const policy = await getPolicy();
  const events = [];

  const { rows: staffRows } = await db.query(
    `SELECT id, first_name, last_name, preferred_name, date_of_birth::text
     FROM staff WHERE is_active=true AND terminated IS NOT TRUE`
  );
  const staffById = {};
  for (const s of staffRows) staffById[s.id] = s;
  const staffName = s => (s.preferred_name || s.first_name) + ' ' + s.last_name;

  // Birthdays
  for (const s of staffRows) {
    if (!s.date_of_birth) continue;
    const date = nextOccurrenceOfMonthDay(s.date_of_birth, asOf);
    const daysUntil = diffDays(date, asOf);
    if (daysUntil >= 0 && daysUntil <= daysAhead) {
      events.push({
        type: 'birthday', staff_id: s.id, staff_name: staffName(s), date, days_until: daysUntil,
        title: `${staffName(s)}'s birthday`, voucher_amount: policy.birthday_voucher,
      });
    }
  }

  // Anniversaries — any staff with at least one service period
  const { rows: withPeriods } = await db.query(`SELECT DISTINCT staff_id FROM staff_service_periods`);
  for (const row of withPeriods) {
    const s = staffById[row.staff_id];
    if (!s) continue; // inactive/terminated — skip from upcoming view
    const result = await computeCreditedService(row.staff_id, { asOf });
    if (!result.next_milestone_date) continue;
    const daysUntil = diffDays(result.next_milestone_date, asOf);
    if (daysUntil >= 0 && daysUntil <= daysAhead) {
      events.push({
        type: 'anniversary', staff_id: s.id, staff_name: staffName(s), date: result.next_milestone_date,
        days_until: daysUntil, milestone_years: result.next_milestone_years,
        title: `${staffName(s)} — ${result.next_milestone_years}-year work anniversary`,
        voucher_amount: anniversaryAmount(policy, result.next_milestone_years),
      });
    }
  }

  // Christmas / Eid / other occasions
  const { rows: occasions } = await db.query(
    `SELECT id, staff_id, kind, title, occasion_date::text, recurrence, voucher_amount, notes
     FROM staff_occasions`
  );
  for (const occ of occasions) {
    let date;
    if (occ.recurrence === 'annual') {
      date = nextOccurrenceOfMonthDay(occ.occasion_date, asOf);
    } else {
      if (occ.occasion_date < asOf) continue;
      date = occ.occasion_date;
    }
    const daysUntil = diffDays(date, asOf);
    if (daysUntil < 0 || daysUntil > daysAhead) continue;

    if (occ.kind === 'christmas' && occ.staff_id == null) {
      for (const s of staffRows) {
        events.push({
          type: 'christmas', staff_id: s.id, staff_name: staffName(s), occasion_id: occ.id, date, days_until: daysUntil,
          title: occ.title || 'Christmas', voucher_amount: null,
        });
      }
    } else {
      const type = occ.kind.startsWith('eid') ? 'eid' : 'other';
      events.push({
        type, staff_id: occ.staff_id, staff_name: occ.staff_id ? staffName(staffById[occ.staff_id] || {}) : null,
        occasion_id: occ.id, date, days_until: daysUntil, title: occ.title,
        voucher_amount: occ.voucher_amount != null ? Number(occ.voucher_amount) : null,
      });
    }
  }

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  for (const e of events) {
    const row = await ensureChecklistRow(e);
    e.event_key = row.event_key;
    e.checklist_id = row.id;
    e.checklist_state = row.checklist_state;
    e.voucher_tier = row.voucher_tier;
    e.checklist_items = (CHECKLIST_ITEMS_BY_TYPE[e.type] || []).map(k => ({
      key: k, label: CHECKLIST_ITEM_LABELS[k], done: !!(row.checklist_state && row.checklist_state[k] && row.checklist_state[k].done),
    }));
  }

  return events;
}

module.exports = {
  MONTH_DAYS,
  CHECKLIST_ITEMS_BY_TYPE,
  CHECKLIST_ITEM_LABELS,
  DEFAULT_POLICY,
  todayStr,
  nextOccurrenceOfMonthDay,
  monthsBetween,
  getPolicy,
  setPolicy,
  anniversaryAmount,
  getServicePeriods,
  getBaseline,
  computeCreditedService,
  eventKey,
  ensureChecklistRow,
  getUpcomingEvents,
};
