'use strict';
// ============================================================================
// b228 — Payroll engine (2026-08-25)
//
// One place that answers "how many hours did each staff member work in this
// date range, and what does that come to". Used by:
//   src/routes/payroll.js         — Staff → Payroll (the screen Toby asked for)
//   src/routes/finance-payroll.js — the older Finance → Payroll tab
//
// THE HONESTY RULE FOR THIS FILE
// -----------------------------------------------------------------------------
// ladn.staff_shifts is EMPTY. There are no clock-in/clock-out actuals for the
// nursery, so nothing here is a measurement unless staff_shifts says so. Every
// line carries `hours_source` and `hours_inferred`, and the screen prints them.
// Toby pays real people from these figures — a computed number must never be
// able to pass itself off as a measured one, and a staff member with no hours
// source must surface as a WARNING, never as a quiet £0.
// ============================================================================

// A rota is a plan, not a timesheet. We will only treat it as this period's
// hours when it actually covers the period — a rota published for one week of a
// four-week month would otherwise quietly pay everyone a quarter of their wages.
const ROTA_COVERAGE_MIN = 0.8;

// PAYE estimate constants. Deliberately IDENTICAL to the figures the original
// POST /runs used, so moving the maths in here cannot silently change anyone's
// pay. They are estimates: basic rate only, no tax-code arithmetic, no NI
// category letters, no student loan. Every surface that shows them says so.
const PAYE = {
  personal_allowance_annual_pence: 1257000,  // £12,570
  basic_rate: 0.20,
  ni_primary_threshold_monthly_pence: 102300, // £1,023
  ni_employee_rate: 0.08,
  ni_employer_rate: 0.138,
  pension_employee_default: 0.03,
  avg_month_days: 30.4375,
};

// ── date helpers — plain YYYY-MM-DD strings end to end ──────────────────────
// Wren has been bitten before by String(Date).slice(0,10) shifting a date across
// a timezone boundary (see the Xero push bug). Nothing in this file ever turns a
// date into a local Date and back.
const ymd = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
};
const parseYmd = (s) => new Date(s + 'T12:00:00Z');
const addDays = (s, n) => { const d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dowOf = (s) => parseYmd(s).getUTCDay();          // 0=Sun … 6=Sat
const isWeekend = (s) => { const d = dowOf(s); return d === 0 || d === 6; };
// staff_work_patterns.day_of_week is 0=Mon … 4=Fri (same convention as
// staff-analytics.js getWPDayIndex).
const wpDayOf = (s) => dowOf(s) - 1;
const daysBetween = (from, to) => {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const minsBetween = (start, end) => {
  if (!start || !end) return 0;
  const [sh, sm] = String(start).split(':').map(Number);
  const [eh, em] = String(end).split(':').map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
};

// ── period resolution ───────────────────────────────────────────────────────
// Toby's ask is "I choose dates", so from/to is the primary input. year/month
// stay supported because the existing Finance → Payroll tab posts them, and
// payroll_runs still stores (and uniquely constrains) them.
function lastWholeMonth(todayStr) {
  const today = todayStr || new Date().toISOString().slice(0, 10);
  let y = parseInt(today.slice(0, 4), 10);
  let m = parseInt(today.slice(5, 7), 10) - 1;
  if (m === 0) { m = 12; y -= 1; }
  return monthRange(y, m);
}

function monthRange(year, month) {
  const y = parseInt(year, 10), m = parseInt(month, 10);
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const nextY = m === 12 ? y + 1 : y, nextM = m === 12 ? 1 : m + 1;
  const to = addDays(`${nextY}-${String(nextM).padStart(2, '0')}-01`, -1);
  return { from, to };
}

function monthLabel(from, to) {
  const f = parseYmd(from), t = parseYmd(to);
  const opts = { month: 'long', year: 'numeric', timeZone: 'UTC' };
  const fm = f.toLocaleDateString('en-GB', opts);
  const tm = t.toLocaleDateString('en-GB', opts);
  const dOpts = { day: 'numeric', month: 'short', timeZone: 'UTC' };
  // A whole calendar month gets the plain month name. Anything else has to show
  // its real edges — "August 2026" on a 4-weekly run would be a lie.
  const whole = from.endsWith('-01') && to === monthRange(f.getUTCFullYear(), f.getUTCMonth() + 1).to;
  if (whole) return fm;
  return `${f.toLocaleDateString('en-GB', dOpts)} – ${t.toLocaleDateString('en-GB', dOpts)} ${t.getUTCFullYear()}`;
}

/**
 * Turn whatever the caller gave us into a concrete period.
 * @param {object} opts {from,to} | {year,month} | {shape,from}
 */
function resolvePeriod(opts = {}) {
  let from = ymd(opts.from), to = ymd(opts.to);
  const shape = opts.shape || opts.period_shape || (from && to ? 'custom' : 'monthly');

  if (!from && opts.year && opts.month) {
    const r = monthRange(opts.year, opts.month);
    from = r.from; to = r.to;
  }
  if (!from && !to) { const r = lastWholeMonth(); from = r.from; to = r.to; }

  if (from && !to) {
    if (shape === 'four_weekly') to = addDays(from, 27);
    else if (shape === 'weekly') to = addDays(from, 6);
    else {
      const y = parseInt(from.slice(0, 4), 10), m = parseInt(from.slice(5, 7), 10);
      to = monthRange(y, m).to;
    }
  }
  if (to < from) { const t = from; from = to; to = t; }

  // payroll_runs.period_year/period_month are NOT NULL and uniquely constrained,
  // so a run is always booked against the month its period STARTS in.
  const year  = parseInt(from.slice(0, 4), 10);
  const month = parseInt(from.slice(5, 7), 10);
  const days  = daysBetween(from, to);
  const wholeMonth = from.endsWith('-01') && to === monthRange(year, month).to;

  return {
    from, to, year, month,
    shape: wholeMonth && shape === 'custom' ? 'monthly' : shape,
    label: monthLabel(from, to),
    total_days: days.length,
    working_days: days.filter(d => !isWeekend(d)).length,
    whole_month: wholeMonth,
    // PAYE thresholds are monthly figures. A whole calendar month uses them as
    // they are; any other range is pro-rated by length and flagged an estimate.
    month_fraction: wholeMonth ? 1 : r2(days.length / PAYE.avg_month_days),
  };
}

// ── gathering ───────────────────────────────────────────────────────────────
async function gather(db, period, template) {
  const { from, to } = period;
  const toExcl = addDays(to, 1);

  const includeInactive = !!(template && template.include_inactive);
  const { rows: staff } = await db.query(`
    SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.role, s.is_active,
           s.contract_type, s.employment_type,
           s.contracted_hours, s.hours_per_week,
           -- 2026-09-29: an exact salary (fixed_annual_salary) beats the generated
           -- hourly x hours x 52 figure, which 2-dp rates can't make land on £56,000.
           s.hourly_rate, COALESCE(s.fixed_annual_salary, s.annual_salary) AS annual_salary, s.tax_code, s.payroll_reference,
           s.pension_eligible, s.pension_employee_contribution,
           s.work_pattern_id
    FROM staff s
    WHERE ($1::boolean OR s.is_active = true) AND COALESCE(s.is_demo, false) = false
    ORDER BY s.first_name, s.last_name
  `, [includeInactive]);

  // Per-staff day patterns. staff_work_patterns is the populated table (14 of
  // the active staff); work_patterns/work_pattern_days is the BrightHR import
  // and is joined through staff.work_pattern_id, which b229 is fixing — until
  // then it is NULL for everyone, so it can only ever be a fallback.
  const { rows: patterns } = await db.query(`
    SELECT staff_id, day_of_week, shift_start::text AS shift_start, shift_end::text AS shift_end,
           COALESCE(is_off, false) AS is_off, COALESCE(lunch_break_minutes, 0) AS lunch_break_minutes,
           COALESCE(effective_from::text, '2000-01-01') AS effective_from,
           COALESCE(effective_to::text,   '9999-12-31') AS effective_to
    FROM staff_work_patterns
    ORDER BY staff_id, day_of_week
  `);

  const { rows: wpDays } = await db.query(`
    SELECT wpd.work_pattern_id, wpd.day_of_week,
           wpd.shift_start::text AS shift_start, wpd.shift_end::text AS shift_end,
           COALESCE(wpd.is_off, false) AS is_off, COALESCE(wpd.break_minutes, 0) AS break_minutes
    FROM work_pattern_days wpd
  `).catch(() => ({ rows: [] }));

  // Measured hours, if they ever exist.
  const { rows: clocked } = await db.query(`
    SELECT staff_id,
           SUM(COALESCE(total_minutes,
               EXTRACT(EPOCH FROM (clock_out_time - clock_in_time)) / 60)) / 60.0 AS hours,
           COUNT(DISTINCT shift_date) AS days
    FROM staff_shifts
    WHERE shift_date >= $1::date AND shift_date < $2::date
      AND clock_in_time IS NOT NULL
    GROUP BY staff_id
  `, [from, toExcl]).catch(() => ({ rows: [] }));

  // Published rota — a plan, not a timesheet.
  const { rows: rostered } = await db.query(`
    SELECT staff_id,
           SUM(GREATEST(0, EXTRACT(EPOCH FROM (planned_end - planned_start)) / 3600
                           - COALESCE(break_mins, 0) / 60.0)) AS hours,
           COUNT(DISTINCT shift_date) AS days
    FROM rota_shifts
    WHERE shift_date >= $1::date AND shift_date < $2::date
      AND COALESCE(is_absent, false) = false
      AND COALESCE(is_open, false) = false
      AND staff_id IS NOT NULL
      AND planned_start IS NOT NULL AND planned_end IS NOT NULL
    GROUP BY staff_id
  `, [from, toExcl]).catch(() => ({ rows: [] }));

  const { rows: absences } = await db.query(`
    SELECT staff_id, start_date::text AS start_date, end_date::text AS end_date,
           COALESCE(absence_type, request_type, 'absence') AS absence_type,
           duration_hours, COALESCE(days_count, duration_days) AS days_count, half_day
    FROM absence_requests
    WHERE status = 'approved'
      AND start_date <= $2::date AND COALESCE(end_date, start_date) >= $1::date
  `, [from, to]).catch(() => ({ rows: [] }));

  const { rows: toil } = await db.query(`
    SELECT staff_id,
           SUM(CASE WHEN type ILIKE 'used%' OR type ILIKE 'taken%' THEN -COALESCE(hours,0)
                    ELSE COALESCE(hours,0) END) AS hours
    FROM toil_entries
    WHERE occurred_on >= $1::date AND occurred_on < $2::date
    GROUP BY staff_id
  `, [from, toExcl]).catch(() => ({ rows: [] }));

  return { staff, patterns, wpDays, clocked, rostered, absences, toil };
}

// ── per-staff hours ─────────────────────────────────────────────────────────
function patternHoursForDay(patterns, staffId, dateStr) {
  const wpDay = wpDayOf(dateStr);
  if (wpDay < 0 || wpDay > 4) return 0;   // pattern table only carries Mon–Fri
  const p = patterns.find(x =>
    x.staff_id === staffId && x.day_of_week === wpDay && !x.is_off &&
    dateStr >= x.effective_from && dateStr <= x.effective_to);
  if (!p) return 0;
  const mins = minsBetween(p.shift_start, p.shift_end) - (p.lunch_break_minutes || 0);
  return mins > 0 ? mins / 60 : 0;
}

function computeHours(s, period, data) {
  const days = daysBetween(period.from, period.to);
  const hasPattern = data.patterns.some(p =>
    p.staff_id === s.id && period.to >= p.effective_from && period.from <= p.effective_to);

  // 1. Contracted — what the work pattern says they should be doing.
  let patternHours = 0, patternDays = 0;
  for (const d of days) {
    const h = patternHoursForDay(data.patterns, s.id, d);
    if (h > 0) { patternHours += h; patternDays += 1; }
  }

  // 2. Absence — valued day by day at that day's pattern hours, so a Bank
  //    Holiday Monday off is worth a Monday, not an average day.
  let absenceHours = 0, absenceDays = 0;
  const dailyAvg = patternDays ? patternHours / patternDays : null;
  for (const a of data.absences) {
    if (a.staff_id !== s.id) continue;
    const aFrom = a.start_date > period.from ? a.start_date : period.from;
    const aTo   = (a.end_date || a.start_date) < period.to ? (a.end_date || a.start_date) : period.to;
    if (aTo < aFrom) continue;
    for (const d of daysBetween(aFrom, aTo)) {
      let h = patternHoursForDay(data.patterns, s.id, d);
      if (!h && !hasPattern && !isWeekend(d) && dailyAvg == null) {
        // No pattern at all — fall back to a contracted daily figure if we have
        // one, otherwise the absence is recorded in days only.
        const wk = Number(s.hours_per_week || s.contracted_hours || 0);
        h = wk ? wk / 5 : 0;
      }
      if (h <= 0) continue;
      if (a.half_day) h = h / 2;
      absenceHours += h; absenceDays += 1;
    }
  }

  // 3. Actuals, best source first.
  const clocked  = data.clocked.find(x => x.staff_id === s.id);
  const rostered = data.rostered.find(x => x.staff_id === s.id);
  const workingDays = period.working_days || 1;
  const clockedDays  = clocked  ? Number(clocked.days)  : 0;
  const rosteredDays = rostered ? Number(rostered.days) : 0;
  const expectedDays = patternDays || workingDays;

  const warnings = [];
  let hours = 0, source = 'none', inferred = true;

  if (clocked && Number(clocked.hours) > 0 && clockedDays >= expectedDays * ROTA_COVERAGE_MIN) {
    hours = Number(clocked.hours); source = 'clocked'; inferred = false;
  } else if (rostered && Number(rostered.hours) > 0 && rosteredDays >= expectedDays * ROTA_COVERAGE_MIN) {
    hours = Number(rostered.hours); source = 'rostered'; inferred = true;
  } else if (patternHours > 0) {
    hours = patternHours; source = 'work_pattern'; inferred = true;
    if (rostered && rosteredDays > 0) {
      warnings.push({ code: 'partial_rota', message:
        `Rota covers only ${rosteredDays} of ${expectedDays} working days in this period, so the work pattern was used instead.` });
    }
  } else {
    const wk = Number(s.hours_per_week || s.contracted_hours || 0);
    if (wk > 0) {
      hours = wk * (workingDays / 5); source = 'contracted_hours'; inferred = true;
      // No day pattern, so the contracted figure IS the contracted hours for the
      // period. Leaving it at 0 would show a line paid for hours it was never
      // "contracted" to do, which reads as an overpayment that isn't one.
      patternHours = hours;
      patternDays = workingDays;
    } else {
      hours = 0; source = 'none'; inferred = true;
    }
  }

  if (!hasPattern) {
    warnings.push({ code: 'no_work_pattern', message:
      'No work pattern on file for this period. ' + (source === 'none'
        ? 'There is nothing to calculate hours from — check this line before paying.'
        : `Hours came from ${sourceLabel(source)} instead.`) });
  }
  if (source === 'none') {
    warnings.push({ code: 'no_hours_source', message:
      'No clock-in record, no rota and no work pattern — Wren cannot say how many hours this person worked. This is NOT zero hours; it is no data.' });
  }

  const toilRow = data.toil.find(x => x.staff_id === s.id);
  const toilHours = toilRow ? Number(toilRow.hours) || 0 : 0;

  return {
    contracted_hours: r2(patternHours),
    contracted_days: patternDays,
    actual_hours: r2(hours),
    absence_hours: r2(absenceHours),
    absence_days: absenceDays,
    toil_hours: r2(toilHours),
    hours_source: source,
    hours_inferred: inferred,
    rota_days: rosteredDays,
    clocked_days: clockedDays,
    warnings,
  };
}

function sourceLabel(src) {
  return {
    clocked: 'clock-in records',
    rostered: 'the published rota',
    work_pattern: 'the work pattern',
    contracted_hours: 'contracted weekly hours',
    none: 'nothing',
  }[src] || src;
}

// ── pay ─────────────────────────────────────────────────────────────────────
const SALARIED = new Set(['salaried', 'salary', 'annual', 'fixed', 'fixed_salary']);

function payBasisFor(s) {
  const ct = String(s.contract_type || s.employment_type || '').toLowerCase();
  if (SALARIED.has(ct)) return Number(s.annual_salary) > 0 ? 'salaried' : 'unknown';
  if (Number(s.hourly_rate) > 0) return 'hourly';
  if (Number(s.annual_salary) > 0) return 'salaried';
  return 'unknown';
}

function computePay(s, hrs, period, template) {
  const deductAbsence = template ? template.deduct_absence !== false : true;
  const payToil = !!(template && template.pay_toil);

  let paidHours = hrs.actual_hours;
  // Absence is only deducted when it is not already missing from the hours. The
  // rota excludes absent shifts and the work-pattern expansion counts the day as
  // worked, so the deduction applies to the pattern/contracted sources only.
  const absenceDeducted = deductAbsence && ['work_pattern', 'contracted_hours'].includes(hrs.hours_source)
    ? Math.min(hrs.absence_hours, paidHours) : 0;
  paidHours = r2(paidHours - absenceDeducted + (payToil ? Math.max(0, hrs.toil_hours) : 0));

  const basis = payBasisFor(s);
  const ratePence = Math.round((Number(s.hourly_rate) || 0) * 100);
  const warnings = [];

  let gross = 0;
  if (basis === 'hourly') {
    gross = Math.round(paidHours * ratePence);
  } else if (basis === 'salaried') {
    gross = Math.round((Number(s.annual_salary) * 100 / 12) * period.month_fraction);
  } else {
    warnings.push({ code: 'no_pay_rate', message:
      'No hourly rate and no annual salary on file. Gross pay cannot be calculated — add a rate on the staff record, then regenerate.' });
  }

  // PAYE estimate. Basic rate only, thresholds pro-rated for a non-monthly
  // period. Not a substitute for payroll software — every surface says so.
  const paMonthly = Math.round(PAYE.personal_allowance_annual_pence / 12 * period.month_fraction);
  const niThresh  = Math.round(PAYE.ni_primary_threshold_monthly_pence * period.month_fraction);
  const pensionRate = s.pension_employee_contribution != null && Number(s.pension_employee_contribution) > 0
    ? Number(s.pension_employee_contribution) / 100
    : PAYE.pension_employee_default;

  const tax     = Math.round(Math.max(0, gross - paMonthly) * PAYE.basic_rate);
  const ni      = Math.round(Math.max(0, gross - niThresh) * PAYE.ni_employee_rate);
  const erNI    = Math.round(Math.max(0, gross - niThresh) * PAYE.ni_employer_rate);
  const pension = s.pension_eligible === false ? 0 : Math.round(gross * pensionRate);
  const net     = gross - tax - ni - pension;

  return {
    pay_basis: basis,
    hourly_rate_pence: ratePence,
    paid_hours: paidHours,
    absence_deducted_hours: r2(absenceDeducted),
    gross_pence: gross, tax_pence: tax, ni_pence: ni,
    employer_ni_pence: erNI, pension_pence: pension, net_pence: net,
    tax_code: s.tax_code || null,
    warnings,
  };
}

// ── the whole run ───────────────────────────────────────────────────────────
/**
 * Compute (but do NOT save) a payroll run.
 * @returns {Promise<{period, lines, totals, data_quality}>}
 */
async function computeRun(db, opts = {}) {
  const period = resolvePeriod(opts);
  const template = opts.template || null;
  const data = await gather(db, period, template);

  const roles = template && Array.isArray(template.include_roles) ? template.include_roles : [];
  const excluded = new Set((template && Array.isArray(template.exclude_staff_ids) ? template.exclude_staff_ids : []).map(Number));

  const lines = [];
  for (const s of data.staff) {
    if (excluded.has(Number(s.id))) continue;
    if (roles.length && !roles.includes(s.role)) continue;

    const hrs = computeHours(s, period, data);
    const pay = computePay(s, hrs, period, template);
    const warnings = hrs.warnings.concat(pay.warnings);
    if (hrs.hours_inferred && hrs.hours_source !== 'none') {
      warnings.push({ code: 'inferred_hours', message:
        `Hours are INFERRED from ${sourceLabel(hrs.hours_source)}, not measured. There are no clock-in records for this period.` });
    }
    lines.push({
      staff_id: s.id,
      staff_name: `${s.first_name} ${s.last_name}`.trim(),
      role: s.role || null,
      contract_type: s.contract_type || s.employment_type || 'hourly',
      ...hrs,
      ...pay,
      hours_worked: pay.paid_hours,   // the column payroll_staff_lines already has
      warnings,
      blocking: warnings.some(w => w.code === 'no_pay_rate' || w.code === 'no_hours_source'),
    });
  }

  const sum = (k) => lines.reduce((a, l) => a + (Number(l[k]) || 0), 0);
  const totals = {
    staff_count: lines.length,
    contracted_hours: r2(sum('contracted_hours')),
    actual_hours: r2(sum('actual_hours')),
    paid_hours: r2(sum('paid_hours')),
    absence_hours: r2(sum('absence_hours')),
    toil_hours: r2(sum('toil_hours')),
    gross_pence: sum('gross_pence'),
    tax_pence: sum('tax_pence'),
    ni_pence: sum('ni_pence'),
    employer_ni_pence: sum('employer_ni_pence'),
    pension_pence: sum('pension_pence'),
    net_pence: sum('net_pence'),
    warning_lines: lines.filter(l => l.warnings.length).length,
    blocking_lines: lines.filter(l => l.blocking).length,
  };

  const bySource = {};
  lines.forEach(l => { bySource[l.hours_source] = (bySource[l.hours_source] || 0) + 1; });

  return {
    period, template, lines, totals,
    hours_sources: bySource,
    hours_note: Object.entries(bySource)
      .map(([k, n]) => `${n} from ${sourceLabel(k)}`).join(', '),
    data_quality: buildDataQuality(lines, bySource),
  };
}

function buildDataQuality(lines, bySource) {
  const q = [];
  if (!bySource.clocked) {
    q.push({ level: 'warn', issue: 'No clock-in data',
      detail: 'staff_shifts holds no clock-in/clock-out records for this period, so NOTHING in this run is a measured figure. Every hours total below is inferred from the rota or the work pattern.' });
  }
  const noPattern = lines.filter(l => l.warnings.some(w => w.code === 'no_work_pattern'));
  if (noPattern.length) {
    q.push({ level: 'warn', issue: `${noPattern.length} staff have no work pattern on file`,
      detail: 'Their hours could not be taken from a contracted pattern: ' + noPattern.map(l => l.staff_name).join(', ') + '.' });
  }
  const noRate = lines.filter(l => l.pay_basis === 'unknown');
  if (noRate.length) {
    q.push({ level: 'bad', issue: `${noRate.length} staff have no pay rate on file`,
      detail: 'Gross pay shows as missing, not as £0: ' + noRate.map(l => l.staff_name).join(', ') + '. Add an hourly rate or an annual salary on the staff record and regenerate.' });
  }
  q.push({ level: 'info', issue: 'Tax, NI and pension are estimates',
    detail: 'Basic-rate PAYE only — no tax-code arithmetic, no NI category letters, no student loan, no salary sacrifice. Use BrightPay, Sage or Xero Payroll for the real figures and for the RTI submission.' });
  return q;
}

// ── persistence ─────────────────────────────────────────────────────────────
/**
 * Save a computed run. Throws {status:409} if the month is already taken —
 * payroll_runs carries a UNIQUE(period_year, period_month) from its original
 * migration and dropping it would be a destructive change to a prod table.
 */
async function saveRun(db, computed, meta = {}) {
  const { period, totals, lines } = computed;

  const { rows: [clash] } = await db.query(
    'SELECT id, period_label FROM payroll_runs WHERE period_year=$1 AND period_month=$2',
    [period.year, period.month]);
  if (clash) {
    const err = new Error(`A payroll run already exists for ${clash.period_label} (run #${clash.id}). Wren allows one run per calendar month — open that run, or delete it before generating again.`);
    err.status = 409; err.existing_run_id = clash.id;
    throw err;
  }

  const { rows: [run] } = await db.query(`
    INSERT INTO payroll_runs
      (period_label, period_year, period_month, period_from, period_to, status, staff_count,
       total_gross_pence, total_tax_pence, total_ni_pence, total_pension_pence, total_net_pence,
       period_shape, template_id, hours_note, warning_count, generated_by,
       total_employer_ni_pence)
    VALUES ($1,$2,$3,$4,$5,'draft',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    RETURNING *
  `, [period.label, period.year, period.month, period.from, period.to, totals.staff_count,
      totals.gross_pence, totals.tax_pence, totals.ni_pence, totals.pension_pence, totals.net_pence,
      period.shape, meta.template_id || null, computed.hours_note, totals.warning_lines,
      // b301: employer NI was computed per line and then discarded, because there was no
      // column for it. It is the whole difference between what people were paid and what
      // employing them cost, which is the figure the Finance section needs.
      meta.generated_by || null, totals.employer_ni_pence]);

  for (const l of lines) {
    await db.query(`
      INSERT INTO payroll_staff_lines
        (run_id, staff_id, staff_name, role, contract_type, pay_basis,
         hours_worked, contracted_hours, absence_hours, toil_hours,
         hours_source, hours_inferred, hourly_rate_pence,
         gross_pence, tax_pence, ni_pence, pension_pence, net_pence, warnings,
         employer_ni_pence)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
    `, [run.id, l.staff_id, l.staff_name, l.role, l.contract_type, l.pay_basis,
        l.paid_hours, l.contracted_hours, l.absence_deducted_hours, l.toil_hours,
        l.hours_source, l.hours_inferred, l.hourly_rate_pence,
        l.gross_pence, l.tax_pence, l.ni_pence, l.pension_pence, l.net_pence,
        JSON.stringify(l.warnings), l.employer_ni_pence]);
  }
  return run;
}

/** Recompute one saved line's pay after an edit, and roll the run totals up. */
async function recalcRun(db, runId) {
  const { rows: [t] } = await db.query(`
    SELECT COUNT(*)::int AS n,
           COALESCE(SUM(gross_pence),0)::bigint   AS gross,
           COALESCE(SUM(tax_pence),0)::bigint     AS tax,
           COALESCE(SUM(ni_pence),0)::bigint      AS ni,
           COALESCE(SUM(pension_pence),0)::bigint AS pension,
           COALESCE(SUM(net_pence),0)::bigint     AS net,
           COALESCE(SUM(employer_ni_pence),0)::bigint AS employer_ni
    FROM payroll_staff_lines WHERE run_id=$1`, [runId]);
  await db.query(`
    UPDATE payroll_runs
       SET staff_count=$1, total_gross_pence=$2, total_tax_pence=$3, total_ni_pence=$4,
           total_pension_pence=$5, total_net_pence=$6, total_employer_ni_pence=$7,
           updated_at=NOW()
     WHERE id=$8`,
    [t.n, t.gross, t.tax, t.ni, t.pension, t.net, t.employer_ni, runId]);
  return t;
}

/** Re-price a single line from edited hours/rate, using the same PAYE estimate. */
function repriceLine(line, period) {
  const gross = line.pay_basis === 'salaried'
    ? Number(line.gross_pence) || 0
    : Math.round((Number(line.hours_worked) || 0) * (Number(line.hourly_rate_pence) || 0));
  const frac = period && period.month_fraction ? period.month_fraction : 1;
  const paMonthly = Math.round(PAYE.personal_allowance_annual_pence / 12 * frac);
  const niThresh  = Math.round(PAYE.ni_primary_threshold_monthly_pence * frac);
  const tax     = Math.round(Math.max(0, gross - paMonthly) * PAYE.basic_rate);
  const ni      = Math.round(Math.max(0, gross - niThresh) * PAYE.ni_employee_rate);
  const pension = Math.round(gross * PAYE.pension_employee_default);
  // b301: employer NI moves with gross, so an edited line has to re-price it too —
  // otherwise the Finance figure keeps the pre-edit employer cost.
  const erNI = Math.round(Math.max(0, gross - niThresh) * PAYE.ni_employer_rate);
  return { gross_pence: gross, tax_pence: tax, ni_pence: ni, pension_pence: pension,
           employer_ni_pence: erNI, net_pence: gross - tax - ni - pension };
}

module.exports = {
  computeRun, saveRun, recalcRun, repriceLine,
  resolvePeriod, lastWholeMonth, monthRange, sourceLabel, payBasisFor,
  PAYE, ROTA_COVERAGE_MIN,
  _internal: { ymd, addDays, daysBetween, isWeekend, patternHoursForDay, computeHours, computePay },
};
