'use strict';
/* ===========================================================================
 * employment-rules-service.js — b318 (2026-09-11)
 *
 * The database half of the employment-rules engine. src/lib/employment-rules.js
 * does the arithmetic and knows nothing about Postgres; this file gathers the
 * facts that arithmetic needs.
 *
 * Nothing here invents a fact. Where a fact is missing — no entitlement on
 * file, no reported time recorded, no earnings figure — the check comes back
 * 'unknown' with the reason in words, and a human decides. That discipline is
 * inherited from b309, whose whole point was that a confident wrong number is
 * worse than an honest gap.
 * =========================================================================== */

const ER = require('../lib/employment-rules');
const leaveSvc = require('./leave-entitlement-service');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

// ── The catalogue ───────────────────────────────────────────────────────────
/**
 * @returns Map<rule_key, row> — empty Map if the table is absent, which lets
 *          every check fall back to the wording + defaults in the lib rather
 *          than disappearing silently on a schema that has not been migrated.
 */
async function loadRules(db, domain) {
  const m = new Map();
  try {
    const params = [];
    let where = '';
    if (domain) { params.push(domain); where = 'WHERE domain = $1'; }
    const { rows } = await db.query(
      `SELECT rule_key, title, domain, source_kind, source_ref, source_url, handbook_anchor,
              enforcement, is_active, config, supersedes_handbook, notes
         FROM ${SCHEMA()}.employment_rules ${where} ORDER BY domain, rule_key`, params);
    for (const r of rows) m.set(r.rule_key, r);
  } catch (_) { /* not migrated — the lib's fallbacks stand */ }
  return m;
}

/** Overrides already recorded against a subject, keyed by rule_key. */
async function overridesFor(db, subjectKind, subjectId) {
  const out = {};
  try {
    const { rows } = await db.query(
      `SELECT o.rule_key, o.reason, o.created_at, o.overridden_by,
              s.first_name || ' ' || s.last_name AS by_name
         FROM ${SCHEMA()}.employment_rule_overrides o
         LEFT JOIN ${SCHEMA()}.staff s ON s.id = o.overridden_by
        WHERE o.subject_kind=$1 AND o.subject_id=$2
        ORDER BY o.created_at DESC`, [subjectKind, subjectId]);
    for (const r of rows) if (!out[r.rule_key]) out[r.rule_key] = r;
  } catch (_) { /* not migrated */ }
  return out;
}

// ── Annual leave ────────────────────────────────────────────────────────────
/**
 * Every leave rule, checked against one request (saved or merely proposed).
 *
 * @param opt.staff_id, opt.start_date, opt.end_date, opt.request_type
 * @param opt.exclude_request_id  a saved request being re-checked — excluded
 *                                from its own overlap and summer counts
 * @param opt.now                 injectable, so a test is a test
 * @returns { findings, blocked, blocking, rule_count }
 */
async function leaveCheck(db, opt) {
  const s = SCHEMA();
  const rules = opt.rules || await loadRules(db, 'leave');
  const staffId = Number(opt.staff_id);
  const start = ER.ymd(opt.start_date);
  const end = ER.ymd(opt.end_date) || start;
  const type = opt.request_type || 'holiday';
  const now = opt.now instanceof Date ? opt.now : new Date();
  const excludeId = Number(opt.exclude_request_id) || 0;

  // Who else is already off. APPROVED only: a pending request is not yet
  // somebody's leave, and warning about one would mean the first person to open
  // the form blocks everyone behind them.
  let overlaps = [];
  try {
    const { rows } = await db.query(`
      SELECT ar.id, ar.staff_id, ar.start_date, ar.end_date,
             COALESCE(ar.request_type, ar.absence_type, 'holiday') AS request_type,
             s.first_name || ' ' || s.last_name AS name
        FROM ${s}.absence_requests ar
        JOIN ${s}.staff s ON s.id = ar.staff_id
       WHERE ar.status = 'approved'
         AND ar.staff_id <> $1
         AND ar.id <> $4
         AND ar.start_date <= $3::date AND ar.end_date >= $2::date
       ORDER BY ar.start_date`, [staffId, start, end, excludeId]);
    overlaps = rows.map(r => ({
      staff_id: r.staff_id, name: r.name,
      start_date: ER.ymd(r.start_date), end_date: ER.ymd(r.end_date),
      request_type: r.request_type,
    }));
  } catch (_) { /* leave the list empty; the check reports a pass it cannot disprove */ }

  // Holiday already booked in the capped months, this request excluded.
  const capRule = ER.ruleFor(rules, 'leave.summer_cap');
  const capMonths = Array.isArray(capRule.config.months) ? capRule.config.months.map(Number) : [7, 8];
  const year = Number(start.slice(0, 4));
  let summerDays = 0;
  try {
    const { rows } = await db.query(`
      SELECT ar.start_date, ar.end_date
        FROM ${s}.absence_requests ar
       WHERE ar.staff_id = $1
         AND ar.id <> $2
         AND ar.status IN ('approved','pending')
         AND COALESCE(ar.request_type, ar.absence_type, 'holiday') = 'holiday'
         AND ar.start_date <= $4::date AND ar.end_date >= $3::date`,
      [staffId, excludeId, `${year}-01-01`, `${year}-12-31`]);
    for (const r of rows) {
      summerDays += ER.eachDate(ER.ymd(r.start_date), ER.ymd(r.end_date))
        .filter(d => d.slice(0, 4) === String(year) && ER.isoDow(d) <= 5
                     && capMonths.indexOf(Number(d.slice(5, 7))) !== -1).length;
    }
  } catch (_) { /* 0 — the check says what it counted */ }

  // The entitlement, from the b309 engine. There is no second calculation here:
  // the number a rule is checked against is the number the screens already show.
  let entitlement = null;
  try {
    const e = await leaveSvc.entitlementFor(db, staffId, { on: start });
    entitlement = {
      set: !!(e && e.balance && e.balance.set),
      remainingDays: e && e.balance ? Number(e.balance.remainingDays) : null,
      yearEnd: e && e.year ? e.year.yearEnd : null,
      notSetReason: e && e.entitlement ? e.entitlement.notSetReason : null,
    };
  } catch (_) { entitlement = null; }

  const findings = ER.leaveChecks(rules, {
    request: { staff_id: staffId, start_date: start, end_date: end, request_type: type },
    now, overlaps, summer_days_booked: summerDays, entitlement,
  });

  const blocking = findings.filter(f => f.status === 'block');
  return {
    findings,
    blocked: blocking.length > 0,
    blocking,
    warnings: findings.filter(f => f.status === 'warn'),
    rule_count: findings.length,
  };
}

// ── Sickness ────────────────────────────────────────────────────────────────
/**
 * The sickness rules against one absence row.
 * Manager-facing AND staff-facing: nothing here reveals a diagnosis or the
 * contents of a fit note, only that one exists (b309's Art.9 rule).
 */
async function sicknessCheck(db, absence, opt) {
  const rules = (opt && opt.rules) || await loadRules(db, 'sickness');
  const now = (opt && opt.now instanceof Date) ? opt.now : new Date();
  const findings = [];
  findings.push(ER.sickReportCheck(rules, absence.reported_at, ER.ymd(absence.start_date)));
  findings.push(ER.sickEvidenceCheck(rules, absence));
  findings.push(ER.returnToWorkCheck(rules, absence, now));
  return { findings, warnings: findings.filter(f => f.status === 'warn') };
}

/** The timeliness verdict alone, for stamping onto the row at write time. */
function reportTimeliness(rules, reportedAt, firstDay) {
  const f = ER.sickReportCheck(rules, reportedAt, firstDay);
  return f.timeliness || 'unknown';
}

// ── Statutory Sick Pay ──────────────────────────────────────────────────────
/**
 * SSP for one absence, from the law in force on the day it started.
 *
 * The earnings figure is taken from ladn.staff and never estimated: since
 * 6 April 2026 the answer is the LOWER of the flat rate and 80% of normal
 * weekly earnings, so a guessed salary produces a confidently wrong pound
 * figure. No salary on file → { set: false } and the reason in words.
 *
 * Manager-only at the route: annual_salary is behind view_staff_salaries.
 */
async function sspFor(db, absence, opt) {
  const s = SCHEMA();
  const rules = (opt && opt.rules) || await loadRules(db, 'sickness');
  const r = ER.ruleFor(rules, 'sickness.ssp_day_one');

  const settings = await readSettings(db, ['ssp_weekly_rate', 'ssp_percent_of_earnings']);
  const rate = Number(settings.ssp_weekly_rate) || Number(r.config.weekly_rate);
  const pct = Number(settings.ssp_percent_of_earnings) || Number(r.config.percent_of_earnings) || 80;

  // Normal weekly earnings, and which column they came from — printed in the
  // workings so a disagreement can be traced to the payroll field.
  let weekly = null, earningsFrom = null;
  try {
    const { rows } = await db.query(
      `SELECT annual_salary, hourly_rate, hours_per_week, contracted_hours
         FROM ${s}.staff WHERE id=$1`, [absence.staff_id]);
    const st = rows[0] || {};
    if (Number(st.annual_salary) > 0) {
      weekly = Math.round((Number(st.annual_salary) / 52) * 100) / 100;
      earningsFrom = `annual salary £${Number(st.annual_salary).toFixed(2)} ÷ 52`;
    } else if (Number(st.hourly_rate) > 0 && Number(st.hours_per_week || st.contracted_hours) > 0) {
      const h = Number(st.hours_per_week || st.contracted_hours);
      weekly = Math.round(Number(st.hourly_rate) * h * 100) / 100;
      earningsFrom = `£${Number(st.hourly_rate).toFixed(2)}/hour × ${h} hours a week`;
    }
  } catch (_) { /* leave null */ }

  // The days this person normally works, from the b309 work pattern. Falls back
  // to Mon–Fri only when there is no pattern at all, and says so.
  let dows = null, patternNote = null;
  try {
    const p = await leaveSvc.workPatternFor(db, absence.staff_id);
    if (p && Array.isArray(p.workingDows) && p.workingDows.length) {
      // leave-entitlement-service works in JS weekdays (0=Sun); the lib wants ISO.
      dows = p.workingDows.map(j => (Number(j) === 0 ? 7 : Number(j))).sort((a, b) => a - b);
      patternNote = p.note;
    }
  } catch (_) { /* fall through */ }
  if (!dows) { dows = [1, 2, 3, 4, 5]; patternNote = 'No work pattern on file — Monday to Friday assumed.'; }

  const out = ER.sspCalculate({
    start_date: absence.start_date,
    end_date: absence.end_date,
    qualifying_dows: dows,
    weekly_earnings: weekly,
    weekly_rate: rate,
    percent: pct,
  });
  out.rule = r.rule;
  out.rule_source = r.source;
  out.source_url = r.source_url;
  out.earnings_basis = earningsFrom;
  out.pattern_note = patternNote;
  out.weekly_earnings = weekly;
  if (out.workings && earningsFrom) {
    out.workings.unshift({ step: 'Normal weekly earnings', value: weekly == null ? 'not on file' : `£${weekly.toFixed(2)}`, note: earningsFrom });
  }
  return out;
}

// ── Working time ────────────────────────────────────────────────────────────
/**
 * Adult working-time warnings for one rota week.
 *
 * Under-18s are EXCLUDED here and handled by the b317 young-worker check on
 * rota.js — their limits are tighter, and reporting an adult warning against a
 * sixteen-year-old would understate the problem.
 */
async function workingTimeForWeek(db, weekStart, opt) {
  const s = SCHEMA();
  const rules = (opt && opt.rules) || await loadRules(db, 'working_time');
  const { rows: weekRows } = await db.query(
    `SELECT id FROM ${s}.rota_weeks WHERE week_start=$1::date`, [weekStart]);
  if (!weekRows.length) {
    return { week_start: weekStart, count: 0, staff: [], note: 'No rota week exists for that date yet.' };
  }
  const { rows } = await db.query(`
    SELECT rs.id, rs.staff_id, rs.shift_date, rs.planned_start::text AS planned_start,
           rs.planned_end::text AS planned_end, rs.break_mins, rs.is_absent,
           st.first_name, st.last_name, st.date_of_birth
      FROM ${s}.rota_shifts rs
      JOIN ${s}.staff st ON st.id = rs.staff_id
     WHERE rs.rota_week_id = $1
       AND rs.is_open IS NOT TRUE
       AND (st.date_of_birth IS NULL OR st.date_of_birth <= ($2::date - INTERVAL '18 years'))
     ORDER BY rs.staff_id, rs.shift_date, rs.planned_start`, [weekRows[0].id, weekStart]);

  const byStaff = new Map();
  for (const r of rows) {
    if (!byStaff.has(r.staff_id)) byStaff.set(r.staff_id, { staff: r, shifts: [] });
    byStaff.get(r.staff_id).shifts.push(r);
  }

  const out = [];
  let total = 0;
  for (const { staff, shifts } of byStaff.values()) {
    const findings = ER.adultWorkingTimeWarnings(rules, shifts, weekStart, { opted_out: false });
    if (!findings.length) continue;
    total += findings.length;
    out.push({
      staff_id: staff.staff_id,
      staff_name: `${staff.first_name} ${staff.last_name}`,
      findings,
    });
  }
  return {
    week_start: weekStart, count: total, staff: out,
    note: total
      ? 'Warnings only — nothing has been changed. Staff under 18 are checked separately, against tighter limits.'
      : 'No adult working-time limits are breached in this week. Staff under 18 are checked separately, against tighter limits.',
  };
}

// ── The handbook ────────────────────────────────────────────────────────────

const crypto = require('crypto');
const hash = s => crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');

/** The LIVE handbook, from the one place it is edited. */
async function liveHandbook(db) {
  const s = SCHEMA();
  const settings = await readSettings(db, ['handbook_document_slug']);
  const slug = settings.handbook_document_slug || 'employee-handbook';
  const { rows } = await db.query(
    `SELECT id, slug, title, body_html, updated_at
       FROM ${s}.starter_pack_documents WHERE slug=$1`, [slug]);
  const doc = rows[0] || null;
  if (!doc || !doc.body_html) return null;
  return {
    slug: doc.slug, title: doc.title, body_html: doc.body_html,
    updated_at: doc.updated_at, content_hash: hash(doc.body_html),
  };
}

/** The current published version row, or null. */
async function currentVersion(db) {
  const s = SCHEMA();
  try {
    const { rows } = await db.query(
      `SELECT id, version, title, is_current, effective_date, content_hash, source_slug,
              section_count, requires_ack, published_at, published_by, changes_summary
         FROM ${s}.staff_handbook_versions
        WHERE is_current = true AND source_slug IS NOT NULL
        ORDER BY version DESC LIMIT 1`);
    return rows[0] || null;
  } catch (_) { return null; }
}

/**
 * Publish a new version IF the live document has actually changed.
 *
 * An edit makes a new version and acknowledgements reset, because the
 * acknowledgement is per version_id. Re-publishing an unchanged document is a
 * no-op rather than an insult to the twenty-eight people who would otherwise be
 * asked to read it again for nothing — `force` overrides that where the change
 * is genuinely material but the bytes are the same (a reissue).
 */
async function publishVersion(db, opt) {
  const s = SCHEMA();
  const live = await liveHandbook(db);
  if (!live) return { published: false, reason: 'No handbook document is on file.' };
  const cur = await currentVersion(db);
  if (cur && cur.content_hash === live.content_hash && !(opt && opt.force)) {
    return { published: false, unchanged: true, version: cur, reason: 'The handbook has not changed since the last version.' };
  }
  const sections = ER.handbookSections(live.body_html);
  const nextVersion = (cur ? Number(cur.version) : 0) + 1;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE ${s}.staff_handbook_versions SET is_current=false WHERE is_current=true`);
    const { rows } = await client.query(`
      INSERT INTO ${s}.staff_handbook_versions
        (version, title, body_html, content_hash, source_slug, section_count, is_current,
         effective_date, published_by, published_at, changes_summary, requires_ack)
      VALUES ($1,$2,$3,$4,$5,$6,true,$7::date,$8,now(),$9,$10)
      RETURNING id, version, title, content_hash, section_count, effective_date, published_at`,
      [nextVersion, live.title || 'Employee Handbook', live.body_html, live.content_hash,
       live.slug, sections.length,
       (opt && opt.effective_date) || ER.londonParts(new Date()).ymd,
       (opt && opt.published_by) || null,
       (opt && opt.changes_summary) || null,
       opt && opt.requires_ack === false ? false : true]);
    await client.query('COMMIT');
    return { published: true, version: rows[0], previous_version: cur ? cur.version : null };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Who has acknowledged the current version, and who has not. */
async function acknowledgementState(db, versionId) {
  const s = SCHEMA();
  const { rows } = await db.query(`
    SELECT st.id AS staff_id, st.first_name, st.last_name, st.role,
           a.acknowledged_at
      FROM ${s}.staff st
      LEFT JOIN ${s}.handbook_acknowledgements a
             ON a.staff_id = st.id AND a.version_id = $1
     WHERE st.is_active = true
     ORDER BY (a.acknowledged_at IS NULL) DESC, st.last_name, st.first_name`, [versionId]);
  const done = rows.filter(r => r.acknowledged_at);
  return {
    version_id: versionId,
    total: rows.length,
    acknowledged: done.length,
    outstanding: rows.length - done.length,
    staff: rows.map(r => ({
      staff_id: r.staff_id,
      name: `${r.first_name} ${r.last_name}`,
      role: r.role,
      acknowledged_at: r.acknowledged_at,
    })),
  };
}

/** Where our handbook is behind the law. */
async function handbookFlags(db) {
  const s = SCHEMA();
  try {
    const { rows } = await db.query(
      `SELECT id, anchor, section_title, topic, severity, handbook_says, law_says,
              source_ref, source_url, effective_from, resolved_at, resolution_note
         FROM ${s}.handbook_flags ORDER BY (resolved_at IS NOT NULL), effective_from DESC NULLS LAST, id`);
    return rows;
  } catch (_) { return []; }
}

// ── Settings ────────────────────────────────────────────────────────────────
async function readSettings(db, keys) {
  const out = {};
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM ${SCHEMA()}.settings WHERE key = ANY($1::text[])`, [keys]);
    for (const r of rows) out[r.key] = r.value;
  } catch (_) { /* defaults stand */ }
  return out;
}

module.exports = {
  loadRules, overridesFor,
  leaveCheck,
  sicknessCheck, reportTimeliness, sspFor,
  workingTimeForWeek,
  liveHandbook, currentVersion, publishVersion, acknowledgementState, handbookFlags,
  readSettings, hash,
};
