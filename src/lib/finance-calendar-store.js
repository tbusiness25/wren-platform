'use strict';
/**
 * finance-calendar-store.js — b346
 *
 * The database side of the finance calendar. The rule engine
 * (src/lib/finance-calendar.js) is pure; everything that reads or writes a table
 * lives here, so the route, the What-needs-me collector and the reminder sweep all
 * load the calendar the same way and cannot disagree about what is open.
 *
 * Schema-unqualified table names throughout: the pool sets search_path per edition.
 * Every read tolerates the b346 migration not having been applied — `hasTables()`
 * is how a caller finds out, and the answer is "idle", never a 500.
 */

const cal = require('./finance-calendar');

/** Today in London as YYYY-MM-DD. The containers run UTC and the host runs Europe/London; this is right in both. */
function londonToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

async function hasTables(db) {
  const { rows } = await db.query(`SELECT to_regclass('finance_calendar_items') AS a, to_regclass('finance_calendar_log') AS b`);
  return !!(rows[0] && rows[0].a && rows[0].b);
}

async function loadSettingsMap(db) {
  const keys = Object.values(cal.SETTING_KEYS);
  const { rows } = await db.query(`SELECT key, value FROM settings WHERE key = ANY($1)`, [keys]);
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

async function loadHolidays(db) {
  try {
    const { rows } = await db.query(`SELECT to_char(holiday_date, 'YYYY-MM-DD') AS d FROM bank_holidays`);
    return new Set(rows.map(r => r.d));
  } catch { return new Set(); }   // no table → weekends only
}

async function loadStatuses(db) {
  const { rows } = await db.query(`
    SELECT i.rule_code, i.period_key, i.status, i.done_at, i.done_by, i.done_note, i.evidence_location,
           to_char(i.attested_through, 'YYYY-MM-DD') AS attested_through, i.blocked_on,
           s.first_name AS done_by_name
      FROM finance_calendar_items i
      LEFT JOIN staff s ON s.id = i.done_by`);
  return new Map(rows.map(r => [`${r.rule_code}:${r.period_key}`, r]));
}

/**
 * One consistent picture: settings → context → schedule → statuses merged on.
 * `today` is injectable for tests.
 */
async function loadCalendar(db, { today = londonToday(), horizonDays = 430 } = {}) {
  const [raw, holidays, statuses] = await Promise.all([loadSettingsMap(db), loadHolidays(db), loadStatuses(db)]);
  const ctx = cal.readContext(raw, { today, holidays });
  const schedule = cal.buildSchedule(ctx, { horizonDays });
  const occurrences = schedule.occurrences.map(o => {
    const st = statuses.get(o.key) || null;
    const status = st ? st.status : 'open';
    return Object.assign({}, o, {
      status,
      blocked_on: (st && st.blocked_on) || o.blocked_on,
      blocked_default: o.blocked_on,
      done_at: st && st.done_at ? new Date(st.done_at).toISOString() : null,
      done_by_name: st ? st.done_by_name || null : null,
      done_note: st ? st.done_note : null,
      evidence_location: st ? st.evidence_location : null,
      attested_through: st ? st.attested_through : null,
      phase: status === 'open' ? cal.phaseOf(o, today) : status,
    });
  });
  return { today, ctx, raw, schedule: Object.assign({}, schedule, { occurrences }), occurrences, statuses };
}

/**
 * "Reconciled through" — the latest date somebody has attested that every bank
 * account was reconciled to. Cumulative on purpose: a reconciliation to 31 August
 * covers every earlier month, which is how a bank reconciliation works. Returns
 * null when nothing has been attested.
 */
async function attestedThrough(db) {
  if (!(await hasTables(db))) return { through: null, by: null, at: null, note: null, period: null };
  const { rows } = await db.query(`
    SELECT to_char(i.attested_through, 'YYYY-MM-DD') AS through, i.done_at, i.done_note, i.period_key, s.first_name AS by
      FROM finance_calendar_items i
      LEFT JOIN staff s ON s.id = i.done_by
     WHERE i.rule_code = 'bank-reconciliation' AND i.status = 'done' AND i.attested_through IS NOT NULL
     ORDER BY i.attested_through DESC, i.done_at DESC
     LIMIT 1`);
  const r = rows[0];
  return r ? { through: r.through, by: r.by || null, at: r.done_at ? new Date(r.done_at).toISOString() : null, note: r.done_note, period: r.period_key }
           : { through: null, by: null, at: null, note: null, period: null };
}

module.exports = { londonToday, hasTables, loadSettingsMap, loadHolidays, loadStatuses, loadCalendar, attestedThrough };
