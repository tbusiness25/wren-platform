'use strict';
/* ===========================================================================
 * leave-hours-service.js — b522 (2026-10-20)
 *
 * The database half of the hours-based leave engine. src/lib/leave-hours.js
 * does the arithmetic and knows nothing about Postgres; this file gathers the
 * inputs and writes the answer down.
 *
 * WHAT IT DELIBERATELY DOES NOT DUPLICATE
 * ---------------------------------------
 * Two questions already have exactly one answer in this codebase and this file
 * asks rather than re-answers them:
 *   • "what days and hours does this person work?" — leave-entitlement-service
 *     .workPatternFor(), which consults staff_work_patterns, then work_patterns,
 *     then the named preset, in that order, and reports AMBIGUOUS rather than
 *     guessing when a person has two different patterns on file.
 *   • "which holiday year is this date in?" — leave-entitlement.holidayYearFor().
 * If either answer is ever wrong it is wrong in one place for both engines,
 * which is the only arrangement in which it can be fixed once.
 *
 * WHERE THE LEDGER LIVES, AND WHY IT IS SPLIT
 * -------------------------------------------
 * HOLIDAY deductions are DERIVED, every read, from absence_requests and
 * hr_absences. They are not copied into staff_leave_ledger. A mirror of a
 * booking is a thing that can disagree with the booking, and a leave balance
 * that disagrees with the calendar it is drawn from is worse than no balance.
 * The precedence between the two absence tables — an absence_requests row wins
 * for a given (staff_id, start_date) and the hr_absences row for the same
 * absence is suppressed — is copied verbatim from src/routes/absence.js GET
 * /all, services/bradford-factor.js and leave-entitlement-service.leaveUsage,
 * because a fourth opinion about which table wins is the last thing this
 * schema needs.
 *
 * BANK HOLIDAY and CLOSURE deductions ARE stored, in staff_leave_ledger,
 * because they are generated from a rule rather than entered by anyone and
 * therefore have no other home — and because a manager needs to be able to
 * exempt one (is_void) without that exemption being recomputed away on the
 * next page load. The sweep that writes them is an UPSERT keyed on
 * (staff_id, kind, entry_date), so it is safe to run on every read, and it is.
 *
 * SIGNS: staff_leave_ledger.hours is SIGNED — negative takes hours out of the
 * allowance, positive puts them in. Every balance SUMs; nothing branches on
 * kind to decide a direction. See the migration's comment block.
 * ===========================================================================*/

const https = require('https');
const LH = require('../lib/leave-hours');
const LE = require('../lib/leave-entitlement');
const LES = require('./leave-entitlement-service');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const isDate = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = v => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const ymd = LES.ymd;
const today = () => new Date().toISOString().slice(0, 10);

/** gov.uk's own feed. England and Wales only — the brief, and the only division
 *  ladn.bank_holidays has ever held (its PK is holiday_date alone, so it cannot
 *  hold two divisions for one date anyway). */
const GOV_UK_URL = 'https://www.gov.uk/bank-holidays.json';
const DIVISION = 'england-and-wales';

// ── Policy ──────────────────────────────────────────────────────────────────
/**
 * The setting's hours-leave policy. Every value has a documented default so a
 * fresh tenant with an empty settings table still calculates, and no default is
 * a leave FIGURE — they are policy shapes.
 *
 * closureDeduct defaults to FALSE and the migration seeds it false: deducting
 * the Christmas shutdown from everyone's allowance changes what every member of
 * staff is owed, which is Toby's decision and not a default's.
 */
async function hoursPolicy(db) {
  const s = SCHEMA();
  const out = {
    yearStartMd: '01-01',
    contractWeeks: LH.STATUTORY_WEEKS,
    bhDeduct: true,
    closureDeduct: false,
    carryCapHours: 0,
    division: DIVISION,
    unit: 'hours',
  };
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM ${s}.settings
        WHERE key IN ('leave_year_start_md','leave_contract_weeks','leave_bh_deduct',
                      'leave_closure_deduct','leave_carry_over_cap_hours','leave_bh_division','leave_unit')`);
    for (const r of rows) {
      const v = r.value;
      if (r.key === 'leave_year_start_md' && /^\d{2}-\d{2}$/.test(v)) out.yearStartMd = v;
      if (r.key === 'leave_contract_weeks' && num(v) > 0) out.contractWeeks = num(v);
      if (r.key === 'leave_bh_deduct') out.bhDeduct = String(v) === 'true';
      if (r.key === 'leave_closure_deduct') out.closureDeduct = String(v) === 'true';
      if (r.key === 'leave_carry_over_cap_hours' && num(v) != null) out.carryCapHours = Math.max(0, num(v));
      if (r.key === 'leave_bh_division' && v) out.division = String(v);
      if (r.key === 'leave_unit' && ['hours', 'days'].includes(v)) out.unit = v;
    }
  } catch (_) { /* settings table absent in an older schema — defaults stand */ }
  return out;
}

// ── Bank holidays ───────────────────────────────────────────────────────────
/** Cached England-and-Wales bank holidays in a range: [{date, name}]. */
async function bankHolidayRows(db, from, to, division) {
  if (!isDate(from) || !isDate(to) || from > to) return [];
  try {
    const { rows } = await db.query(
      `SELECT holiday_date::text AS date, name FROM ${SCHEMA()}.bank_holidays
        WHERE COALESCE(division,$3) = $3 AND holiday_date BETWEEN $1::date AND $2::date
        ORDER BY holiday_date`, [from, to, division || DIVISION]);
    return rows.map(r => ({ date: r.date, name: r.name || 'Bank holiday' }));
  } catch (_) { return []; }
}

/** GET a JSON URL. Resolves {status, json} or rejects. 10s ceiling. */
function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Wren/LADN b522 leave' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return reject(new Error(`redirected to ${res.headers.location}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; if (body.length > 2e6) req.destroy(new Error('response too large')); });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve({ status: res.statusCode, json: JSON.parse(body) }); }
        catch (e) { reject(new Error('response was not JSON')); }
      });
    });
    req.setTimeout(10000, () => req.destroy(new Error('timed out after 10s')));
    req.on('error', reject);
  });
}

/**
 * Re-fetch gov.uk's England-and-Wales bank holidays into the cache.
 *
 * The cache is the point: every allowance read hits ladn.bank_holidays, never
 * the internet, so a gov.uk outage or an offline box changes nobody's balance.
 * This is the only function here that makes an outbound request, it is only
 * ever called from an explicit manager action or a (not installed) nightly
 * script, and a failure returns a reason rather than throwing — a refresh that
 * could not reach gov.uk must leave the 83 cached dates exactly as they were.
 *
 * ON CONFLICT (holiday_date) matches the table's existing primary key.
 */
async function refreshBankHolidays(db, { url = GOV_UK_URL, dryRun = false } = {}) {
  const s = SCHEMA();
  const out = { ok: false, fetched: 0, inserted: 0, updated: 0,
                first: null, last: null, error: null, dry_run: !!dryRun, source: url };
  let payload;
  try {
    const r = await getJson(url);
    payload = r.json;
  } catch (e) {
    out.error = `Could not reach ${url}: ${e.message}. The ${(await bankHolidayRows(db, '1900-01-01', '2999-12-31')).length} dates already cached are unchanged.`;
    return out;
  }
  const div = payload && payload[DIVISION];
  const events = div && Array.isArray(div.events) ? div.events : null;
  if (!events) {
    out.error = `The feed did not contain an "${DIVISION}" division with an events array.`;
    return out;
  }
  const clean = events
    .filter(e => e && isDate(String(e.date || '')))
    .map(e => ({ date: String(e.date), title: String(e.title || 'Bank holiday').slice(0, 200),
                 notes: e.notes ? String(e.notes).slice(0, 500) : null, bunting: !!e.bunting }));
  out.fetched = clean.length;
  if (!clean.length) { out.error = 'The feed contained no usable dates.'; return out; }
  clean.sort((a, b) => (a.date < b.date ? -1 : 1));
  out.first = clean[0].date; out.last = clean[clean.length - 1].date;
  if (dryRun) { out.ok = true; return out; }

  for (const e of clean) {
    const { rows } = await db.query(
      `INSERT INTO ${s}.bank_holidays (holiday_date, name, division, notes, bunting, source, fetched_at, updated_at)
       VALUES ($1::date,$2,$3,$4,$5,'gov.uk',now(),now())
       ON CONFLICT (holiday_date) DO UPDATE SET
         name     = EXCLUDED.name,
         division = COALESCE(${s}.bank_holidays.division, EXCLUDED.division),
         notes    = EXCLUDED.notes,
         bunting  = EXCLUDED.bunting,
         source   = 'gov.uk',
         fetched_at = now(),
         updated_at = now()
       RETURNING (xmax = 0) AS was_insert`,
      [e.date, e.title, DIVISION, e.notes, e.bunting]);
    // xmax = 0 on the returned row distinguishes an INSERT from a DO UPDATE.
    // There is no way to see the PRE-update values in RETURNING — the table
    // reference there is the new row — so "updated" means "the row already
    // existed and has been refreshed", not "something about it changed".
    if (rows[0] && rows[0].was_insert) out.inserted += 1;
    else out.updated += 1;
  }
  try {
    await db.query(
      `INSERT INTO ${s}.settings (key, value) VALUES ('leave_bh_fetched_at',$1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [new Date().toISOString()]);
  } catch (_) { /* a settings write failing must not fail the refresh */ }
  out.ok = true;
  return out;
}

// ── Closure days ────────────────────────────────────────────────────────────
/**
 * The nursery's OWN closures in a range: [{date, name}], from ladn.settings
 * 'closure_dates'. Bank holidays are NOT included, which is the difference
 * between this and src/lib/closures.js loadClosures(): that function answers
 * "is the nursery open?" and merges both sources, which is right for occupancy
 * and would double-deduct here. The parser itself is reused from that file so
 * the accepted shapes ("2026-12-24", {date,name}, {from,to,name}) stay one
 * vocabulary.
 */
async function closureRows(db, from, to) {
  if (!isDate(from) || !isDate(to) || from > to) return [];
  let parse;
  try { ({ parseClosureSetting: parse } = require('../lib/closures')); }
  catch (_) { return []; }
  try {
    const { rows } = await db.query(
      `SELECT value FROM ${SCHEMA()}.settings WHERE key='closure_dates'`);
    if (!rows.length) return [];
    const map = parse(rows[0].value);
    const out = [];
    for (const [date, name] of map) if (date >= from && date <= to) out.push({ date, name: name || 'Closure' });
    out.sort((a, b) => (a.date < b.date ? -1 : 1));
    return out;
  } catch (_) { return []; }
}

// ── The generated half of the ledger ────────────────────────────────────────
/**
 * Write (upsert) this person's bank-holiday and closure deductions for one
 * holiday year, and void any that no longer apply.
 *
 * Idempotent by construction: the unique index staff_leave_ledger_auto_uq on
 * (staff_id, kind, entry_date) for the two generated kinds makes every write an
 * upsert, so this is safe to call on every read of the person's card — and it
 * is called there, because a manager who fixes a working pattern must see the
 * bank-holiday deductions follow it immediately rather than at 3am.
 *
 * "Voided" rather than deleted: if a pattern changes so that Easter Monday is
 * no longer a working day, the row stays, with is_void and a reason, so the
 * ledger shows that it WAS deducted and no longer is. Nothing in this file ever
 * deletes a row.
 *
 * A row a HUMAN voided (void_reason not starting with the generated prefix) is
 * never un-voided by this sweep — a manager's exemption outranks the rule.
 */
const AUTO_VOID_PREFIX = 'No longer a contracted working day';

/**
 * @param {object} [window] {start, end} — the part of the holiday year this
 *   person is EMPLOYED for. Deductions are clamped to it, because a bank
 *   holiday before someone started is not theirs to spend: their allowance was
 *   already pro-rated down for the months they were not here, so charging them
 *   for January as well would take the same months off twice. Defaults to the
 *   whole year when not given.
 */
async function syncAutoLedger(db, staffId, year, pattern, policy, window) {
  const s = SCHEMA();
  const res = { bank_holiday: { written: 0, voided: 0, hours: 0 },
                closure: { written: 0, voided: 0, hours: 0 }, skipped: null,
                window: null };

  const dayHours = pattern && pattern.dayHours;
  if (!dayHours || !Object.keys(dayHours).length) {
    res.skipped = 'No working pattern with times on file, so there is nothing to deduct a bank holiday from.';
    return res;
  }

  const from = (window && isDate(window.start) && window.start > year.yearStart) ? window.start : year.yearStart;
  const to   = (window && isDate(window.end)   && window.end   < year.yearEnd)   ? window.end   : year.yearEnd;
  res.window = { from, to };
  if (from > to) { res.skipped = 'Not employed on any day of this holiday year.'; return res; }

  const want = new Map();   // 'kind|date' -> {kind, date, hours, label}
  if (policy.bhDeduct) {
    for (const bh of await bankHolidayRows(db, from, to, policy.division)) {
      const h = LH.hoursOnDate(dayHours, bh.date);
      if (h > 0) want.set(`bank_holiday|${bh.date}`, { kind: 'bank_holiday', date: bh.date, hours: h, label: bh.name });
    }
  }
  if (policy.closureDeduct) {
    const bhDates = new Set((await bankHolidayRows(db, from, to, policy.division)).map(b => b.date));
    for (const c of await closureRows(db, from, to)) {
      // A closure listed on a date that is ALSO a bank holiday is already
      // deducted as a bank holiday. Deducting it twice would be the obvious bug
      // and the hardest one to spot on a card.
      if (bhDates.has(c.date) && policy.bhDeduct) continue;
      const h = LH.hoursOnDate(dayHours, c.date);
      if (h > 0) want.set(`closure|${c.date}`, { kind: 'closure', date: c.date, hours: h, label: c.name });
    }
  }

  for (const w of want.values()) {
    await db.query(
      `INSERT INTO ${s}.staff_leave_ledger
         (staff_id, year_start, entry_date, kind, hours, label, detail, source, is_void, created_at, updated_at)
       VALUES ($1,$2::date,$3::date,$4,$5,$6,$7,$8,false,now(),now())
       ON CONFLICT (staff_id, kind, entry_date) WHERE kind IN ('bank_holiday','closure') AND entry_date IS NOT NULL
       DO UPDATE SET
         year_start = EXCLUDED.year_start,
         hours      = EXCLUDED.hours,
         label      = EXCLUDED.label,
         detail     = EXCLUDED.detail,
         -- Re-apply only what this sweep itself had voided. A manager's own
         -- exemption (any other void_reason) survives untouched.
         is_void     = CASE WHEN ${s}.staff_leave_ledger.void_reason LIKE $9 THEN false
                            ELSE ${s}.staff_leave_ledger.is_void END,
         void_reason = CASE WHEN ${s}.staff_leave_ledger.void_reason LIKE $9 THEN NULL
                            ELSE ${s}.staff_leave_ledger.void_reason END,
         updated_at = now()`,
      [staffId, year.yearStart, w.date, w.kind, -Math.abs(w.hours), w.label,
       `${w.hours} contracted hours on this day`,
       w.kind === 'bank_holiday' ? 'auto_bank_holiday' : 'auto_closure',
       `${AUTO_VOID_PREFIX}%`]);
    res[w.kind].written += 1;
    res[w.kind].hours = LH.round2(res[w.kind].hours + w.hours);
  }

  // Void generated rows in this year that the rule no longer produces.
  const keepDates = { bank_holiday: [], closure: [] };
  for (const w of want.values()) keepDates[w.kind].push(w.date);
  for (const kind of ['bank_holiday', 'closure']) {
    const { rowCount } = await db.query(
      `UPDATE ${s}.staff_leave_ledger
          SET is_void=true,
              void_reason=$4,
              voided_at=now(),
              updated_at=now()
        WHERE staff_id=$1 AND kind=$2 AND year_start=$3::date
          AND COALESCE(is_void,false)=false
          AND entry_date IS NOT NULL
          AND NOT (entry_date::text = ANY($5::text[]))`,
      [staffId, kind, year.yearStart,
       `${AUTO_VOID_PREFIX} (or the deduction was switched off in Settings).`,
       keepDates[kind]]);
    res[kind].voided = rowCount || 0;
  }
  return res;
}

// ── The derived half of the ledger ──────────────────────────────────────────
/**
 * HOLIDAY rows for one person in one window, derived from the bookings, in
 * hours. Never stored. Costing, in order of how much we trust it:
 *   1. absence_requests.duration_hours, if whoever booked it recorded hours.
 *   2. the working pattern across the booked dates — the only source that knows
 *      a week off is 37.5 h for one practitioner and 22.5 h for another.
 *   3. days x the person's average contracted day, as a last resort, flagged
 *      `estimated` so a card can say so.
 */
async function derivedHolidayLedger(db, staffId, from, to, pattern) {
  const s = SCHEMA();
  const dayHours = pattern && pattern.dayHours;
  const perDay = pattern && pattern.weeklyHours && pattern.daysPerWeek
    ? pattern.weeklyHours / pattern.daysPerWeek : null;

  let rows = [];
  try {
    const q = await db.query(`
      WITH ar AS (
        SELECT id, start_date::text AS start_date, end_date::text AS end_date,
               duration_hours, COALESCE(days_count, duration_days, 1)::numeric AS days,
               status, half_day, notes, 'absence_requests'::text AS src
          FROM ${s}.absence_requests
         WHERE staff_id=$1 AND request_type='holiday'
           AND status IN ('approved','pending')
           AND start_date BETWEEN $2::date AND $3::date
      ),
      hr AS (
        SELECT h.id, h.start_date::text AS start_date, COALESCE(h.end_date,h.start_date)::text AS end_date,
               h.duration_hours, COALESCE(h.duration_days,1)::numeric AS days,
               'approved'::text AS status, NULL::text AS half_day, h.reason AS notes,
               'hr_absences'::text AS src
          FROM ${s}.hr_absences h
         WHERE h.staff_id=$1 AND h.absence_type='Annual leave'
           AND h.start_date BETWEEN $2::date AND $3::date
           AND NOT EXISTS (SELECT 1 FROM ar WHERE ar.start_date = h.start_date)
      )
      SELECT * FROM ar UNION ALL SELECT * FROM hr ORDER BY start_date`, [staffId, from, to]);
    rows = q.rows;
  } catch (e) {
    // A demo schema with no hr_absences must not blank a real balance.
    try {
      const q = await db.query(`
        SELECT id, start_date::text AS start_date, end_date::text AS end_date,
               duration_hours, COALESCE(days_count, duration_days, 1)::numeric AS days,
               status, half_day, notes, 'absence_requests'::text AS src
          FROM ${s}.absence_requests
         WHERE staff_id=$1 AND request_type='holiday' AND status IN ('approved','pending')
           AND start_date BETWEEN $2::date AND $3::date
         ORDER BY start_date`, [staffId, from, to]);
      rows = q.rows;
    } catch (_) { rows = []; }
  }

  return rows.map(r => {
    const halfFactor = r.half_day && String(r.half_day).toLowerCase() !== 'none' && String(r.half_day) !== 'false'
      ? 0.5 : null;
    let hours = num(r.duration_hours);
    let basis = 'booked hours';
    let estimated = false;
    if (!(hours > 0)) {
      if (dayHours && Object.keys(dayHours).length) {
        const span = LH.hoursForRange(dayHours, r.start_date, r.end_date || r.start_date, halfFactor);
        if (span.hours > 0) {
          hours = span.hours;
          basis = `${span.workingDays} contracted working day${span.workingDays === 1 ? '' : 's'} in the booking`;
        }
      }
    }
    if (!(hours > 0) && perDay > 0) {
      hours = LH.round2(Number(r.days) * perDay * (halfFactor || 1));
      basis = `${r.days} day${Number(r.days) === 1 ? '' : 's'} × ${LH.round2(perDay)} h (average contracted day)`;
      estimated = true;
    }
    return {
      id: `${r.src}:${r.id}`,
      ref_table: r.src, ref_id: r.id,
      kind: 'holiday',
      entry_date: r.start_date,
      end_date: r.end_date || r.start_date,
      hours: -LH.round2(hours || 0),       // SIGNED, like every stored row
      label: halfFactor ? 'Holiday (half day)' : 'Holiday',
      detail: basis + (estimated ? ' — estimated, no hours were recorded on the booking' : ''),
      status: r.status || 'approved',
      source: r.src,
      estimated,
      is_void: false,
      notes: r.notes || null,
    };
  });
}

/** The stored half: generated + hand-entered rows for one person and year. */
async function storedLedger(db, staffId, year) {
  const s = SCHEMA();
  try {
    const { rows } = await db.query(
      `SELECT l.id, l.kind, l.entry_date::text AS entry_date, l.hours, l.label, l.detail,
              l.source, COALESCE(l.is_void,false) AS is_void, l.void_reason, l.created_by,
              l.created_at, l.voided_at,
              (st.first_name || ' ' || st.last_name) AS created_by_name
         FROM ${s}.staff_leave_ledger l
         LEFT JOIN ${s}.staff st ON st.id = l.created_by
        WHERE l.staff_id=$1 AND l.year_start=$2::date
        ORDER BY l.entry_date NULLS LAST, l.id`, [staffId, year.yearStart]);
    return rows.map(r => ({ ...r, hours: Number(r.hours), status: 'approved',
                            created_by_name: r.created_by_name || null }));
  } catch (_) { return []; }
}

// ── Hours actually worked (12.07% accrual) ──────────────────────────────────
/** Worked hours in a window, from ladn.staff_shifts (derived by src/lib/clock-day.js). */
async function hoursWorked(db, staffId, from, to) {
  try {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(worked_minutes),0)::numeric AS mins
         FROM ${SCHEMA()}.staff_shifts
        WHERE staff_id=$1 AND shift_date BETWEEN $2::date AND $3::date`, [staffId, from, to]);
    const mins = Number(rows[0] && rows[0].mins) || 0;
    return mins > 0 ? LH.round2(mins / 60) : 0;
  } catch (_) { return null; }
}

// ── The main entry point ────────────────────────────────────────────────────
/**
 * Everything a card or a person page needs about one person's leave in one
 * holiday year, in hours.
 *
 * @param {object}  db
 * @param {number}  staffId
 * @param {object}  [opt]
 * @param {string}  [opt.on]      any date in the holiday year of interest. Default today.
 * @param {boolean} [opt.sync]    run the bank-holiday/closure sweep first. Default true.
 * @param {boolean} [opt.ledger]  include the full ledger. Default true.
 * @param {object}  [opt.policy]  a policy already loaded, to avoid N queries in a list.
 */
async function allowanceFor(db, staffId, opt = {}) {
  const s = SCHEMA();
  const on = isDate(opt.on) ? opt.on : today();
  const policy = opt.policy || await hoursPolicy(db);
  const year = LE.holidayYearFor(on, policy.yearStartMd);

  let staffName = null, role = null, roomId = null, contractStart = null, terminationDate = null, active = null;
  try {
    const { rows } = await db.query(
      `SELECT first_name, last_name, role, room_id, contract_start, termination_date, is_active
         FROM ${s}.staff WHERE id=$1`, [staffId]);
    if (rows.length) {
      staffName = `${rows[0].first_name || ''} ${rows[0].last_name || ''}`.trim();
      role = rows[0].role || null;
      roomId = rows[0].room_id;
      contractStart = ymd(rows[0].contract_start);
      terminationDate = ymd(rows[0].termination_date);
      active = rows[0].is_active;
    }
  } catch (_) { /* keep the nulls */ }

  const pattern = await LES.workPatternFor(db, staffId);
  const stored = await storedYear(db, staffId, year.yearStart);

  const accrualMode = (stored && stored.accrual_mode) === 'irregular_1207' ? 'irregular_1207' : 'fixed';
  const worked = accrualMode === 'irregular_1207'
    ? await hoursWorked(db, staffId, year.yearStart, minStr(on, year.yearEnd))
    : null;

  const allowance = LH.computeAllowance({
    yearStart: year.yearStart,
    yearEnd: year.yearEnd,
    dayHours: pattern.dayHours,
    contractWeeks: stored && num(stored.contract_weeks) != null ? num(stored.contract_weeks) : policy.contractWeeks,
    employmentStart: contractStart,
    employmentEnd: terminationDate,
    accrualMode,
    hoursWorked: worked,
    carryInHours: stored && num(stored.carry_in_hours) != null ? num(stored.carry_in_hours) : 0,
    carryCapHours: stored && num(stored.carry_cap_hours) != null ? num(stored.carry_cap_hours) : policy.carryCapHours,
  });

  // A manual override replaces the FIGURE and keeps the workings, which now end
  // with the override — so the page still shows what the calculation said and
  // what a human decided instead. Same shape as b309's manual_override.
  let overridden = false;
  if (stored && stored.hours_manual_override && num(stored.allowance_hours) != null) {
    const manual = num(stored.allowance_hours);
    allowance.workings.push({
      label: 'Manual override',
      detail: stored.hours_override_reason || 'set by a manager, replacing the calculated figure',
      value: `${manual} h`,
    });
    allowance.allowanceHours = manual;
    allowance.totalAvailableHours = LH.round2(manual + (allowance.carryInApplied || 0));
    allowance.notSetReason = null;
    overridden = true;
  }
  if (allowance.allowanceHours == null && pattern.ambiguous) allowance.notSetReason = pattern.note;

  let sync = null;
  if (opt.sync !== false && !terminationIsBefore(terminationDate, year.yearStart)) {
    try {
      sync = await syncAutoLedger(db, staffId, year, pattern, policy,
        { start: allowance.windowStart, end: allowance.windowEnd });
    } catch (e) { sync = { error: e.message }; }
  }

  const opening = stored && num(stored.opening_balance_hours) != null ? {
    hours: num(stored.opening_balance_hours),
    mode: stored.opening_balance_mode === 'replaces_remaining' ? 'replaces_remaining' : 'carry_in',
    asAt: ymd(stored.opening_balance_as_at) || year.yearStart,
    note: stored.opening_balance_note || null,
    source: stored.opening_balance_source || null,
    at: stored.opening_balance_at || null,
  } : null;

  const derived = await derivedHolidayLedger(db, staffId, year.yearStart, year.yearEnd, pattern);
  const kept = await storedLedger(db, staffId, year);
  const ledger = [...derived, ...kept].sort((a, b) => {
    const ad = a.entry_date || '9999-99-99', bd = b.entry_date || '9999-99-99';
    return ad < bd ? -1 : (ad > bd ? 1 : 0);
  });

  const balance = LH.balanceHours(allowance, ledger, opening);
  const accrued = LH.accruedToDate(allowance, on);

  return {
    staff_id: staffId, staff_name: staffName, role, room_id: roomId, is_active: active,
    year: { ...year, start_md: policy.yearStartMd },
    policy,
    pattern: {
      source: pattern.source, note: pattern.note, ambiguous: pattern.ambiguous,
      days_per_week: pattern.daysPerWeek, weekly_hours: pattern.weeklyHours,
      day_hours: pattern.dayHours || null,
      has_times: !!(pattern.dayHours && Object.keys(pattern.dayHours).length),
    },
    employment: { contract_start: contractStart, termination_date: terminationDate },
    allowance,
    accrued,
    opening_balance: opening,
    balance,
    ledger: opt.ledger === false ? undefined : ledger,
    ledger_counts: {
      holiday: ledger.filter(r => r.kind === 'holiday' && !r.is_void).length,
      bank_holiday: ledger.filter(r => r.kind === 'bank_holiday' && !r.is_void).length,
      closure: ledger.filter(r => r.kind === 'closure' && !r.is_void).length,
      adjustment: ledger.filter(r => ['adjustment', 'accrual'].includes(r.kind) && !r.is_void).length,
      voided: ledger.filter(r => r.is_void).length,
      voided_bank_holiday: ledger.filter(r => r.is_void && r.kind === 'bank_holiday').length,
      voided_closure: ledger.filter(r => r.is_void && r.kind === 'closure').length,
    },
    in_days: {
      allowance: LH.hoursToDays(allowance.allowanceHours, pattern.weeklyHours, pattern.daysPerWeek),
      remaining: LH.hoursToDays(balance.remainingHours, pattern.weeklyHours, pattern.daysPerWeek),
      taken: LH.hoursToDays(balance.takenHours, pattern.weeklyHours, pattern.daysPerWeek),
      booked: LH.hoursToDays(balance.bookedHours, pattern.weeklyHours, pattern.daysPerWeek),
    },
    manual_override: overridden,
    sync,
    computed_at: new Date().toISOString(),
  };
}

const minStr = (a, b) => (a < b ? a : b);
const terminationIsBefore = (term, date) => !!(term && term < date);

async function storedYear(db, staffId, yearStart) {
  try {
    const { rows } = await db.query(
      `SELECT * FROM ${SCHEMA()}.staff_leave_years WHERE staff_id=$1 AND year_start=$2::date`,
      [staffId, yearStart]);
    return rows[0] || null;
  } catch (_) { return null; }
}

/**
 * Persist the hours half of what allowanceFor() worked out, so the figure a
 * screen showed is the figure that can be audited later. Never overwrites a
 * manual override, and never touches b309's days columns.
 */
async function persist(db, result) {
  const s = SCHEMA();
  const a = result.allowance;
  const y = result.year;
  const b = result.balance;
  await db.query(`
    INSERT INTO ${s}.staff_leave_years
      (staff_id, year_start, year_end, unit, contract_weeks, weekly_hours, hours_per_day,
       allowance_hours, allowance_full_hours, carry_in_hours, carry_cap_hours,
       accrual_mode, accrued_hours, bank_holiday_hours, closure_hours,
       employment_start, employment_end, hours_workings, hours_not_set_reason,
       hours_computed_at, created_at, updated_at)
    VALUES ($1,$2::date,$3::date,'hours',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,now(),now(),now())
    ON CONFLICT (staff_id, year_start) DO UPDATE SET
      year_end             = EXCLUDED.year_end,
      unit                 = EXCLUDED.unit,
      contract_weeks       = CASE WHEN ${s}.staff_leave_years.hours_manual_override
                                  THEN ${s}.staff_leave_years.contract_weeks ELSE EXCLUDED.contract_weeks END,
      weekly_hours         = CASE WHEN ${s}.staff_leave_years.manual_override
                                  THEN ${s}.staff_leave_years.weekly_hours ELSE EXCLUDED.weekly_hours END,
      hours_per_day        = CASE WHEN ${s}.staff_leave_years.manual_override
                                  THEN ${s}.staff_leave_years.hours_per_day ELSE EXCLUDED.hours_per_day END,
      allowance_hours      = CASE WHEN ${s}.staff_leave_years.hours_manual_override
                                  THEN ${s}.staff_leave_years.allowance_hours ELSE EXCLUDED.allowance_hours END,
      allowance_full_hours = EXCLUDED.allowance_full_hours,
      carry_in_hours       = CASE WHEN ${s}.staff_leave_years.hours_manual_override
                                  THEN ${s}.staff_leave_years.carry_in_hours ELSE EXCLUDED.carry_in_hours END,
      carry_cap_hours      = EXCLUDED.carry_cap_hours,
      accrual_mode         = COALESCE(${s}.staff_leave_years.accrual_mode, EXCLUDED.accrual_mode),
      accrued_hours        = EXCLUDED.accrued_hours,
      bank_holiday_hours   = EXCLUDED.bank_holiday_hours,
      closure_hours        = EXCLUDED.closure_hours,
      employment_start     = EXCLUDED.employment_start,
      employment_end       = EXCLUDED.employment_end,
      hours_workings       = EXCLUDED.hours_workings,
      hours_not_set_reason = EXCLUDED.hours_not_set_reason,
      hours_computed_at    = now(),
      updated_at           = now()
    RETURNING id`,
    [result.staff_id, y.yearStart, y.yearEnd,
     a.contractWeeks, a.weeklyHours,
     a.weeklyHours && a.daysPerWeek ? LH.round2(a.weeklyHours / a.daysPerWeek) : null,
     a.allowanceHours, a.allowanceFullHours, a.carryInHours, a.carryCapHours,
     a.accrualMode, a.accrualMode === 'irregular_1207' ? a.allowanceHours : null,
     b.bankHolidayHours, b.closureHours,
     result.employment.contract_start, result.employment.termination_date,
     JSON.stringify(a.workings || []), a.notSetReason]);
}

/**
 * Every active person's card, for the dashboard. One policy load, not N; the
 * bank-holiday sweep runs for each person because that is what makes the figures
 * on the dashboard the same figures as on the person page.
 */
async function allAllowances(db, opt = {}) {
  const s = SCHEMA();
  const policy = await hoursPolicy(db);
  const on = isDate(opt.on) ? opt.on : today();
  let staff = [];
  try {
    const { rows } = await db.query(
      `SELECT id FROM ${s}.staff
        WHERE COALESCE(is_active,true)=true AND COALESCE(terminated,false)=false
        ORDER BY first_name, last_name`);
    staff = rows;
  } catch (_) { return { year: LE.holidayYearFor(on, policy.yearStartMd), policy, people: [] }; }

  const people = [];
  for (const st of staff) {
    try {
      const r = await allowanceFor(db, st.id, { on, policy, ledger: false, sync: opt.sync !== false });
      people.push(r);
    } catch (e) {
      people.push({ staff_id: st.id, error: e.message });
    }
  }
  return { year: LE.holidayYearFor(on, policy.yearStartMd), policy, people };
}

module.exports = {
  hoursPolicy, bankHolidayRows, refreshBankHolidays, closureRows,
  syncAutoLedger, derivedHolidayLedger, storedLedger, hoursWorked,
  allowanceFor, allAllowances, persist, storedYear,
  GOV_UK_URL, DIVISION, AUTO_VOID_PREFIX,
};
