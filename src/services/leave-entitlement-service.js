'use strict';
/* ===========================================================================
 * leave-entitlement-service.js — b309 (2026-09-10)
 *
 * The database half of the annual-leave entitlement engine. src/lib/leave-
 * entitlement.js does the maths and knows nothing about Postgres; this file
 * gathers the inputs that maths needs and writes the answer down.
 *
 * The order of authority for one person's entitlement, highest first:
 *
 *   1. A MANUAL OVERRIDE on ladn.staff_leave_years (manual_override = true).
 *      A manager who has been told a figure by an accountant wins over any
 *      calculation, and the row records who set it and when.
 *   2. THE CALCULATION, from that person's work pattern + the setting's policy.
 *      This is what fills the table for everybody else.
 *   3. NOTHING. entitlement_days stays NULL and not_set_reason says why in
 *      words. There is deliberately no fourth option: the old code's fourth
 *      option was a hard-coded 28 and that is the bug this build removes.
 *
 * The work pattern itself has three possible homes, and they are consulted in
 * this order because that is the order of how current they are:
 *   a. ladn.staff_work_patterns — the per-staff, effective-dated schedule the
 *      Rota screen writes (2026-07-16). Unambiguous by construction.
 *   b. ladn.work_patterns joined to work_pattern_days, matched on staff_id.
 *      Two staff have duplicate rows here, so a person with two DIFFERENT
 *      patterns is reported ambiguous rather than guessed at — the same rule
 *      scripts/migrate-entitlement-days-v2.sql already used.
 *   c. ladn.staff.work_pattern_id — a named preset.
 *
 * day_of_week in both pattern tables is 0=Mon … 6=Sun (src/routes/work-
 * patterns.js:48). JavaScript's getUTCDay() is 0=Sun … 6=Sat. The conversion
 * happens in exactly one place below; get it wrong and every bank-holiday count
 * shifts by a day.
 * ===========================================================================*/

const LE = require('../lib/leave-entitlement');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Pattern-table 0=Mon…6=Sun  →  JS 0=Sun…6=Sat. */
const patternDowToJs = n => (Number(n) + 1) % 7;

/** A pg DATE comes back as a local-midnight JS Date — never String() it. */
function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

// ── Settings ────────────────────────────────────────────────────────────────
/**
 * The setting's leave policy. Every value has a documented default so a fresh
 * tenant with an empty settings table still calculates, and none of the defaults
 * is a leave *figure* — they are policy shapes (which weeks, which cap).
 */
async function leavePolicy(db) {
  const s = SCHEMA();
  const out = {
    yearStartMd: '01-01',
    policyLeaveWeeks: 5,
    carryCapDays: 5,
    bhHandling: 'in_addition',
  };
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM ${s}.settings
        WHERE key IN ('leave_year_start_md','leave_policy_weeks','leave_carry_over_cap_days','leave_bh_handling')`);
    for (const r of rows) {
      if (r.key === 'leave_year_start_md' && /^\d{2}-\d{2}$/.test(r.value)) out.yearStartMd = r.value;
      if (r.key === 'leave_policy_weeks' && num(r.value) > 0) out.policyLeaveWeeks = num(r.value);
      if (r.key === 'leave_carry_over_cap_days' && num(r.value) != null) out.carryCapDays = num(r.value);
      if (r.key === 'leave_bh_handling' && ['in_addition', 'deducted'].includes(r.value)) out.bhHandling = r.value;
    }
  } catch (_) { /* settings table absent in an older schema — defaults stand */ }
  return out;
}

/** England & Wales bank holidays in a range, as 'YYYY-MM-DD' strings. */
async function bankHolidays(db, from, to) {
  try {
    const { rows } = await db.query(
      `SELECT holiday_date::text AS d FROM ${SCHEMA()}.bank_holidays
        WHERE COALESCE(division,'england-and-wales')='england-and-wales'
          AND holiday_date BETWEEN $1::date AND $2::date
        ORDER BY holiday_date`, [from, to]);
    return rows.map(r => r.d);
  } catch (_) { return []; }
}

// ── The work pattern ────────────────────────────────────────────────────────
/**
 * b522 — day_of_week rows (0=Mon..6=Sun) with times → { JS dow -> hours }.
 * Shared by the work_patterns and preset arms below so the shift arithmetic and
 * the Mon-based→Sunday-based conversion exist once, not three times.
 * `breakKey` differs between the tables: work_pattern_days.break_minutes vs
 * staff_work_patterns.lunch_break_minutes.
 */
function dayHoursFromRows(rows, breakKey) {
  const out = {};
  for (const r of rows || []) {
    if (r.is_off || !r.shift_start || !r.shift_end) continue;
    const [sh, sm] = String(r.shift_start).split(':').map(Number);
    const [eh, em] = String(r.shift_end).split(':').map(Number);
    if (![sh, sm, eh, em].every(Number.isFinite)) continue;
    const h = Math.max(0, (eh * 60 + em) - (sh * 60 + sm) - (Number(r[breakKey]) || 0)) / 60;
    if (h > 0) out[patternDowToJs(r.day_of_week)] = Math.round(h * 100) / 100;
  }
  return Object.keys(out).length ? out : null;
}


/**
 * @returns {{daysPerWeek:number|null, weeklyHours:number|null, workingDows:number[]|null,
 *            dayHours:object|null, bhHandling:string|null, source:string,
 *            ambiguous:boolean, note:string}}
 * dayHours (b522) is { JS dow 0=Sun..6=Sat -> contracted hours }, with
 * non-working days ABSENT. It is null when the pattern records which days but
 * not what times — the hours engine needs times and will not invent them.
 */
async function workPatternFor(db, staffId) {
  const s = SCHEMA();
  const none = { daysPerWeek: null, weeklyHours: null, workingDows: null, dayHours: null,
                 bhHandling: null,
                 source: 'none', ambiguous: false, note: 'No work pattern on file.' };

  // (a) staff_work_patterns — the current, effective-dated schedule.
  try {
    const { rows } = await db.query(
      `SELECT day_of_week, is_off, shift_start::text AS shift_start, shift_end::text AS shift_end,
              COALESCE(lunch_break_minutes,0) AS lunch
         FROM ${s}.staff_work_patterns
        WHERE staff_id=$1 AND effective_to IS NULL
          AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
        ORDER BY day_of_week`, [staffId]);
    const worked = rows.filter(r => !r.is_off && r.shift_start && r.shift_end);
    if (worked.length) {
      let hours = 0;
      // dayHours (b522): { JS dow 0=Sun..6=Sat -> contracted hours that day }.
      // A day the person does not work is ABSENT, never zero — see
      // src/lib/leave-hours.js patternTotals() for why that distinction carries
      // weight: it is how "a bank holiday on a non-working day deducts nothing"
      // becomes the absence of a row rather than a row of zero.
      const dayHours = {};
      for (const r of worked) {
        const [sh, sm] = String(r.shift_start).split(':').map(Number);
        const [eh, em] = String(r.shift_end).split(':').map(Number);
        const h = Math.max(0, (eh * 60 + em) - (sh * 60 + sm) - (Number(r.lunch) || 0)) / 60;
        hours += h;
        if (h > 0) dayHours[patternDowToJs(r.day_of_week)] = Math.round(h * 100) / 100;
      }
      return {
        daysPerWeek: worked.length,
        weeklyHours: Math.round(hours * 100) / 100,
        workingDows: worked.map(r => patternDowToJs(r.day_of_week)),
        dayHours,
        bhHandling: null,
        source: 'staff_work_patterns',
        ambiguous: false,
        note: `${worked.length} day${worked.length === 1 ? '' : 's'} a week from the current staff schedule`,
      };
    }
  } catch (_) { /* table absent — fall through */ }

  // (b) work_patterns + work_pattern_days, matched on staff_id.
  try {
    const { rows: pats } = await db.query(
      `SELECT wp.id, wp.weekly_hours, wp.public_holiday_handling, wp.source,
              (SELECT count(*) FROM ${s}.work_pattern_days d
                WHERE d.work_pattern_id=wp.id AND COALESCE(d.is_off,false)=false) AS dpw
         FROM ${s}.work_patterns wp
        WHERE wp.staff_id=$1
        ORDER BY wp.updated_at DESC NULLS LAST, wp.id DESC`, [staffId]);
    const usable = pats.filter(p => Number(p.dpw) > 0);
    if (usable.length) {
      const shapes = new Set(usable.map(p => `${p.dpw}|${p.weekly_hours}`));
      if (shapes.size > 1) {
        return { ...none, ambiguous: true, source: 'work_patterns',
          note: `${usable.length} different work patterns are on file for this person — pick one before an entitlement can be calculated.` };
      }
      const p = usable[0];
      const { rows: days } = await db.query(
        `SELECT day_of_week, shift_start::text AS shift_start, shift_end::text AS shift_end,
                is_off, COALESCE(break_minutes,0) AS break_minutes
           FROM ${s}.work_pattern_days
          WHERE work_pattern_id=$1 AND COALESCE(is_off,false)=false ORDER BY day_of_week`, [p.id]);
      // b522: per-day hours where the pattern records times. Where it records
      // only which days, dayHours stays null and the hours engine says so in
      // words rather than spreading weekly_hours evenly and calling it fact.
      const dh = dayHoursFromRows(days, 'break_minutes');
      return {
        daysPerWeek: Number(p.dpw),
        weeklyHours: num(p.weekly_hours),
        workingDows: days.length ? days.map(d => patternDowToJs(d.day_of_week)) : null,
        dayHours: dh,
        bhHandling: ['in_addition', 'deducted'].includes(p.public_holiday_handling) ? p.public_holiday_handling
          : (p.public_holiday_handling === 'not_deducted' ? 'in_addition' : null),
        source: 'work_patterns',
        ambiguous: false,
        note: `${p.dpw} day${Number(p.dpw) === 1 ? '' : 's'} a week from work pattern #${p.id}`,
      };
    }
  } catch (_) { /* fall through */ }

  // (c) the named preset on staff.work_pattern_id.
  try {
    const { rows } = await db.query(
      `SELECT wp.id, wp.name, wp.weekly_hours, wp.public_holiday_handling,
              (SELECT count(*) FROM ${s}.work_pattern_days d
                WHERE d.work_pattern_id=wp.id AND COALESCE(d.is_off,false)=false) AS dpw
         FROM ${s}.staff st JOIN ${s}.work_patterns wp ON wp.id = st.work_pattern_id
        WHERE st.id=$1`, [staffId]);
    const p = rows[0];
    if (p && Number(p.dpw) > 0) {
      const { rows: days } = await db.query(
        `SELECT day_of_week, shift_start::text AS shift_start, shift_end::text AS shift_end,
                is_off, COALESCE(break_minutes,0) AS break_minutes
           FROM ${s}.work_pattern_days
          WHERE work_pattern_id=$1 AND COALESCE(is_off,false)=false ORDER BY day_of_week`, [p.id]);
      return {
        daysPerWeek: Number(p.dpw),
        weeklyHours: num(p.weekly_hours),
        workingDows: days.length ? days.map(d => patternDowToJs(d.day_of_week)) : null,
        dayHours: dayHoursFromRows(days, 'break_minutes'),
        bhHandling: p.public_holiday_handling === 'not_deducted' ? 'in_addition'
          : (['in_addition', 'deducted'].includes(p.public_holiday_handling) ? p.public_holiday_handling : null),
        source: 'preset',
        ambiguous: false,
        note: `${p.dpw} day${Number(p.dpw) === 1 ? '' : 's'} a week from preset "${p.name}"`,
      };
    }
  } catch (_) { /* fall through */ }

  return none;
}

// ── Leave taken / booked in a year ──────────────────────────────────────────
/**
 * Days of HOLIDAY inside [from, to], split into taken (already happened),
 * upcoming (approved, still to come) and pending (awaiting a decision).
 *
 * Reads BOTH ladn.absence_requests (Wren-submitted) and ladn.hr_absences (the
 * 2,944 BrightHR CSV rows). The precedence rule is copied verbatim from
 * src/routes/absence.js GET /all and services/bradford-factor.js: an
 * absence_requests row wins for a given (staff_id, start_date), and the
 * hr_absences row for the same absence is suppressed rather than counted twice.
 */
async function leaveUsage(db, staffId, from, to) {
  const s = SCHEMA();
  const out = { takenDays: 0, upcomingDays: 0, pendingDays: 0 };
  try {
    const { rows } = await db.query(`
      WITH ar AS (
        SELECT start_date, COALESCE(days_count, duration_days, 1)::numeric AS days, status
          FROM ${s}.absence_requests
         WHERE staff_id=$1 AND request_type='holiday'
           AND status IN ('approved','pending')
           AND start_date BETWEEN $2::date AND $3::date
      ),
      hr AS (
        SELECT h.start_date, COALESCE(h.duration_days,1)::numeric AS days, 'approved'::text AS status
          FROM ${s}.hr_absences h
         WHERE h.staff_id=$1 AND h.absence_type='Annual leave'
           AND h.start_date BETWEEN $2::date AND $3::date
           AND NOT EXISTS (SELECT 1 FROM ar WHERE ar.start_date = h.start_date)
      ),
      all_rows AS (SELECT * FROM ar UNION ALL SELECT * FROM hr)
      SELECT
        COALESCE(SUM(days) FILTER (WHERE status='approved' AND start_date <= CURRENT_DATE), 0) AS taken,
        COALESCE(SUM(days) FILTER (WHERE status='approved' AND start_date >  CURRENT_DATE), 0) AS upcoming,
        COALESCE(SUM(days) FILTER (WHERE status='pending'), 0) AS pending
      FROM all_rows`, [staffId, from, to]);
    out.takenDays    = Number(rows[0].taken)    || 0;
    out.upcomingDays = Number(rows[0].upcoming) || 0;
    out.pendingDays  = Number(rows[0].pending)  || 0;
  } catch (e) {
    // A missing hr_absences table on a demo schema must not blank a real balance.
    try {
      const { rows } = await db.query(`
        SELECT COALESCE(SUM(COALESCE(days_count,duration_days,1)) FILTER (WHERE status='approved' AND start_date <= CURRENT_DATE),0) AS taken,
               COALESCE(SUM(COALESCE(days_count,duration_days,1)) FILTER (WHERE status='approved' AND start_date >  CURRENT_DATE),0) AS upcoming,
               COALESCE(SUM(COALESCE(days_count,duration_days,1)) FILTER (WHERE status='pending'),0) AS pending
          FROM ${s}.absence_requests
         WHERE staff_id=$1 AND request_type='holiday' AND start_date BETWEEN $2::date AND $3::date`,
        [staffId, from, to]);
      out.takenDays = Number(rows[0].taken) || 0;
      out.upcomingDays = Number(rows[0].upcoming) || 0;
      out.pendingDays = Number(rows[0].pending) || 0;
    } catch (_) { /* leave the zeroes */ }
  }
  return out;
}

// ── The stored row ──────────────────────────────────────────────────────────
async function storedYear(db, staffId, yearStart) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM ${SCHEMA()}.staff_leave_years WHERE staff_id=$1 AND year_start=$2::date`,
      [staffId, yearStart]);
    return rows[0] || null;
  } catch (_) { return null; }
}

/**
 * The BrightHR figure for this person, if one was ever loaded. Read-only: this
 * function never writes to staff_entitlement or hr_holiday_entitlement.
 * @returns {{sourcedDays:number|null, sourcedHours:number|null, unit:string|null}}
 */
async function brightHrFigure(db, staffId, yearStart, yearEnd) {
  const s = SCHEMA();
  const out = { sourcedDays: null, sourcedHours: null, unit: null, from: null };
  try {
    const { rows } = await db.query(
      `SELECT entitlement_days, carried_over_days FROM ${s}.hr_holiday_entitlement
        WHERE staff_id=$1 AND year_start <= $3::date AND COALESCE(year_end,$3::date) >= $2::date
        ORDER BY year_start DESC LIMIT 1`, [staffId, yearStart, yearEnd]);
    if (rows.length && num(rows[0].entitlement_days) != null) {
      out.sourcedDays = num(rows[0].entitlement_days);
      out.unit = 'days';
      out.from = 'hr_holiday_entitlement';
      return out;
    }
  } catch (_) { /* fall through */ }
  try {
    const { rows } = await db.query(
      `SELECT annual_leave_days, annual_leave_hours, entitlement_unit
         FROM ${s}.staff_entitlement WHERE staff_id=$1`, [staffId]);
    if (rows.length) {
      out.sourcedDays  = num(rows[0].annual_leave_days);
      out.sourcedHours = num(rows[0].annual_leave_hours);
      out.unit = rows[0].entitlement_unit || null;
      out.from = 'staff_entitlement';
    }
  } catch (_) { /* nothing sourced */ }
  return out;
}

// ── The main entry point ────────────────────────────────────────────────────
/**
 * Everything a screen needs about one person's leave in one holiday year.
 *
 * @param {object} db      pg pool
 * @param {number} staffId
 * @param {object} [opt]
 * @param {string} [opt.on]        any date in the holiday year of interest. Default today.
 * @param {boolean}[opt.withUsage] include taken/booked/remaining. Default true.
 * @returns {object}
 */
async function entitlementFor(db, staffId, opt = {}) {
  const s = SCHEMA();
  const on = isDate(opt.on) ? opt.on : new Date().toISOString().slice(0, 10);
  const policy = await leavePolicy(db);
  const year = LE.holidayYearFor(on, policy.yearStartMd);

  // Employment dates.
  let contractStart = null, terminationDate = null, staffName = null, active = null;
  try {
    const { rows } = await db.query(
      `SELECT first_name, last_name, contract_start, termination_date, is_active
         FROM ${s}.staff WHERE id=$1`, [staffId]);
    if (rows.length) {
      contractStart   = ymd(rows[0].contract_start);
      terminationDate = ymd(rows[0].termination_date);
      staffName = `${rows[0].first_name || ''} ${rows[0].last_name || ''}`.trim();
      active = rows[0].is_active;
    }
  } catch (_) { /* keep the nulls */ }

  const pattern = await workPatternFor(db, staffId);
  const stored  = await storedYear(db, staffId, year.yearStart);
  const bhs     = await bankHolidays(db, year.yearStart, year.yearEnd);
  const sourced = await brightHrFigure(db, staffId, year.yearStart, year.yearEnd);

  const carriedIn = stored && num(stored.carried_in_days) != null ? num(stored.carried_in_days) : 0;
  const carryCap  = stored && num(stored.carry_cap_days)  != null ? num(stored.carry_cap_days)  : policy.carryCapDays;

  const ent = LE.computeEntitlement({
    yearStart: year.yearStart,
    yearEnd:   year.yearEnd,
    daysPerWeek: stored && num(stored.days_per_week) != null && stored.manual_override
      ? num(stored.days_per_week) : pattern.daysPerWeek,
    weeklyHours: stored && num(stored.weekly_hours) != null && stored.manual_override
      ? num(stored.weekly_hours) : pattern.weeklyHours,
    policyLeaveWeeks: stored && num(stored.policy_leave_weeks) != null
      ? num(stored.policy_leave_weeks) : policy.policyLeaveWeeks,
    employmentStart: contractStart,
    employmentEnd:   terminationDate,
    workingDows: pattern.workingDows,
    bankHolidays: bhs,
    bhHandling: (stored && stored.bh_handling) || pattern.bhHandling || policy.bhHandling,
    carriedInDays: carriedIn,
    carryCapDays: carryCap,
  });

  // A manual override replaces the FIGURE but keeps the workings, which now end
  // with the override — so the screen still shows what the calculation said and
  // what a human decided instead.
  let overridden = false;
  if (stored && stored.manual_override && num(stored.entitlement_days) != null) {
    const manual = num(stored.entitlement_days);
    ent.workings.push({
      label: 'Manual override',
      detail: stored.not_set_reason || 'set by a manager, replacing the calculated figure',
      value: `${manual} days`,
    });
    ent.entitlementDays = manual;
    ent.entitlementHours = num(stored.entitlement_hours);
    ent.totalAvailableDays = Math.round((manual + (ent.carriedInApplied || 0)) * 100) / 100;
    ent.notSetReason = null;
    overridden = true;
  }

  // If nothing produced a figure, say why — in the words the screen will print.
  if (ent.entitlementDays == null && pattern.ambiguous) ent.notSetReason = pattern.note;

  const usage = opt.withUsage === false
    ? { takenDays: 0, upcomingDays: 0, pendingDays: 0 }
    : await leaveUsage(db, staffId, year.yearStart, year.yearEnd);

  const balance = LE.balanceFor(ent, usage);
  const accrued = LE.accruedToDate(ent, on);

  // Does the calculation agree with what BrightHR said? Half a day of tolerance:
  // BrightHR rounds, and the point of the check is to catch a WRONG figure, not
  // to flag a rounding difference as a discrepancy.
  let reconciles = null, reconcileNote = null;
  const cmpDays = sourced.sourcedDays;
  if (ent.entitlementDays != null && cmpDays != null) {
    reconciles = Math.abs(ent.entitlementDays - cmpDays) <= 0.5;
    reconcileNote = reconciles
      ? `Agrees with the BrightHR export (${cmpDays} days).`
      : `Does NOT agree with the BrightHR export: Wren calculates ${ent.entitlementDays} days, the export says ${cmpDays}.`;
  }

  return {
    staff_id: staffId,
    staff_name: staffName,
    is_active: active,
    year: { ...year, start_md: policy.yearStartMd },
    policy,
    pattern,
    employment: { contract_start: contractStart, termination_date: terminationDate },
    bank_holidays_in_year: bhs.length,
    entitlement: ent,
    accrued,
    usage,
    balance,
    sourced,
    reconciles,
    reconcile_note: reconcileNote,
    manual_override: overridden,
    stored_row_id: stored ? stored.id : null,
    computed_at: new Date().toISOString(),
  };
}

/**
 * Persist what entitlementFor() worked out, so the figure a screen showed is the
 * figure that can be audited later. Never overwrites a manual override.
 */
async function persist(db, result) {
  const s = SCHEMA();
  const e = result.entitlement;
  const y = result.year;
  await db.query(`
    INSERT INTO ${s}.staff_leave_years
      (staff_id, year_start, year_end, policy_leave_weeks, days_per_week, weekly_hours, hours_per_day,
       employment_start, employment_end, bh_handling, carried_in_days, carry_cap_days,
       bank_holiday_days, statutory_floor_days, entitlement_days, entitlement_hours, top_up_days,
       sourced_days, sourced_hours, source, reconciles, not_set_reason, workings, computed_at, updated_at)
    VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb,now(),now())
    ON CONFLICT (staff_id, year_start) DO UPDATE SET
      year_end=EXCLUDED.year_end,
      policy_leave_weeks   = CASE WHEN ${s}.staff_leave_years.manual_override THEN ${s}.staff_leave_years.policy_leave_weeks ELSE EXCLUDED.policy_leave_weeks END,
      days_per_week        = CASE WHEN ${s}.staff_leave_years.manual_override THEN ${s}.staff_leave_years.days_per_week ELSE EXCLUDED.days_per_week END,
      weekly_hours         = CASE WHEN ${s}.staff_leave_years.manual_override THEN ${s}.staff_leave_years.weekly_hours ELSE EXCLUDED.weekly_hours END,
      hours_per_day        = CASE WHEN ${s}.staff_leave_years.manual_override THEN ${s}.staff_leave_years.hours_per_day ELSE EXCLUDED.hours_per_day END,
      employment_start=EXCLUDED.employment_start,
      employment_end=EXCLUDED.employment_end,
      bh_handling=EXCLUDED.bh_handling,
      bank_holiday_days=EXCLUDED.bank_holiday_days,
      statutory_floor_days=EXCLUDED.statutory_floor_days,
      entitlement_days     = CASE WHEN ${s}.staff_leave_years.manual_override THEN ${s}.staff_leave_years.entitlement_days ELSE EXCLUDED.entitlement_days END,
      entitlement_hours    = CASE WHEN ${s}.staff_leave_years.manual_override THEN ${s}.staff_leave_years.entitlement_hours ELSE EXCLUDED.entitlement_hours END,
      top_up_days=EXCLUDED.top_up_days,
      sourced_days=EXCLUDED.sourced_days,
      sourced_hours=EXCLUDED.sourced_hours,
      source               = CASE WHEN ${s}.staff_leave_years.manual_override THEN ${s}.staff_leave_years.source ELSE EXCLUDED.source END,
      reconciles=EXCLUDED.reconciles,
      not_set_reason       = CASE WHEN ${s}.staff_leave_years.manual_override THEN ${s}.staff_leave_years.not_set_reason ELSE EXCLUDED.not_set_reason END,
      workings=EXCLUDED.workings,
      computed_at=now(), updated_at=now()
    RETURNING id`,
    [result.staff_id, y.yearStart, y.yearEnd,
     e.policyLeaveWeeks, e.daysPerWeek, e.weeklyHours, e.hoursPerDay,
     result.employment.contract_start, result.employment.termination_date, e.bhHandling,
     e.carriedInDays, e.carryCapDays,
     e.bankHolidayDays, e.statutoryFloorDays, e.entitlementDays, e.entitlementHours, e.topUpDays,
     result.sourced.sourcedDays, result.sourced.sourcedHours,
     e.entitlementDays == null ? null : (result.sourced.sourcedDays != null ? 'work_pattern+brighthr_export' : 'work_pattern'),
     result.reconciles, e.notSetReason,
     JSON.stringify(e.workings || [])]);
}

/**
 * Roll the holiday year: create next year's row for everyone, carrying forward
 * whatever is unused up to the cap. Idempotent — re-running it on the same year
 * updates rather than duplicates, and it never touches a manual override.
 *
 * Nothing schedules this. It is called from POST /api/absence/entitlement/roll
 * so a human decides when the year turns, which is the right shape while there
 * is exactly one setting: an unattended cron that silently zeroed everyone's
 * balance at midnight on 1 January would be worse than a button.
 */
async function rollYear(db, { fromYearStart, toYearStart, apply = false }) {
  const s = SCHEMA();
  const policy = await leavePolicy(db);
  const prev = LE.holidayYearFor(fromYearStart, policy.yearStartMd);
  const next = LE.holidayYearFor(toYearStart, policy.yearStartMd);
  const { rows: staff } = await db.query(
    `SELECT id FROM ${s}.staff WHERE is_active=true ORDER BY id`);

  const plan = [];
  for (const st of staff) {
    const prevRes = await entitlementFor(db, st.id, { on: prev.yearStart });
    const unused = prevRes.balance.set ? Math.max(0, prevRes.balance.remainingDays) : null;
    const carried = unused == null ? null : Math.min(unused, policy.carryCapDays);
    plan.push({ staff_id: st.id, unused, carried, cap: policy.carryCapDays });
    if (apply) {
      await db.query(`
        INSERT INTO ${s}.staff_leave_years (staff_id, year_start, year_end, carried_in_days, carry_cap_days, created_at, updated_at)
        VALUES ($1,$2::date,$3::date,$4,$5,now(),now())
        ON CONFLICT (staff_id, year_start) DO UPDATE
          SET carried_in_days = CASE WHEN ${s}.staff_leave_years.manual_override
                                     THEN ${s}.staff_leave_years.carried_in_days ELSE EXCLUDED.carried_in_days END,
              carry_cap_days  = EXCLUDED.carry_cap_days,
              updated_at = now()`,
        [st.id, next.yearStart, next.yearEnd, carried, policy.carryCapDays]);
      const res = await entitlementFor(db, st.id, { on: next.yearStart });
      await persist(db, res);
    }
  }
  return { from: prev, to: next, cap: policy.carryCapDays, applied: apply, staff: plan.length, plan };
}

module.exports = {
  entitlementFor, persist, rollYear,
  leavePolicy, bankHolidays, workPatternFor, leaveUsage, brightHrFigure,
  patternDowToJs, ymd, dayHoursFromRows,
};
