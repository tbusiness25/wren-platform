'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * lookback-metrics.js — b523 (2026-10-20)
 *
 * The engine behind Roost → Curriculum → 🔭 Look back: the inset-day report on
 * how the children have been progressing over the last one to five years.
 *
 * Toby, 2026-10-20: "a look back at maybe the last year … or compare the last
 * five years of data and say how the children have been progressing: how long
 * next steps take to achieve, are the children more settled or less settled,
 * what we think's working. That can all feed back into the self-reflection
 * workbooks."
 *
 * ── THE TWO RULES THIS FILE IS BUILT AROUND ──────────────────────────────────
 *
 * 1. AGGREGATES ONLY, AND SUPPRESSION HAPPENS IN THE ENGINE.
 *    Nothing that leaves this module names or identifies a child. There is no
 *    child id, no date of birth, no name, no narrative text in any return value
 *    — not even one that a template happens not to render. Age is turned into a
 *    room INSIDE the SQL, so a date of birth never crosses into JavaScript at
 *    all. Every bucket goes through lookback-stats.cell()/distribution(), which
 *    blanks any group of fewer than five DISTINCT CHILDREN and reports its size
 *    as the string '<5'.
 *
 * 2. SAY WHAT EACH NUMBER IS WORTH.
 *    Several of the questions Toby asked cannot be answered well from what Wren
 *    records today, and a projector chart that looks confident is worse than no
 *    chart. So every section carries a `confidence` rating and an explicit
 *    `limits` list, and a measure with no data says "too thin yet" rather than
 *    drawing a flat line through one data point. Measured read-only against
 *    prod on 2026-10-20, the honest state of play is:
 *
 *      observations      14,969 rows, Sept 2023 → today        STRONG
 *      attendance        12,533 register rows, 52 children     STRONG for presence
 *      diary             12,281 daily_diary + 17,821 sleep     GOOD
 *      framework_tracker  6,289 cells, but 6,269 of them are
 *                        status 'observed' — the b25m backfill
 *                        default, not a practitioner judgement  COVERAGE ONLY,
 *                                                               NOT ATTAINMENT
 *      next_steps           361 rows, of which exactly ONE is
 *                        achieved and 292 are the b393 retire
 *                        sweep                                 TOO THIN YET
 *      termly_child_reviews / termly_child_evaluations  EMPTY   NOT AVAILABLE
 *      observations.termly_update                       0 rows  NOT AVAILABLE
 *      child_tags           3 rows (all demo)                   NOT AVAILABLE
 *      room_move_log        4 rows                              NOT AVAILABLE
 *      key-person history   no such table anywhere              NOT AVAILABLE
 *
 *    That list is the second half of the deliverable. On an inset day "we cannot
 *    yet answer this, and here is the one field that would let us" is a finding,
 *    and it is the finding that changes practice.
 *
 * ── WHY ROOMS ARE DERIVED FROM AGE ───────────────────────────────────────────
 * children.room_id is the room a child is in TODAY. Using it would file a 2023
 * observation about a baby under Pre-school, because that child has since moved
 * up — and the two-room split is the main lens Toby wants. So every row is
 * placed by the child's age in completed months ON THE DAY OF THE ROW, matched
 * against ladn.rooms.min_age_months/max_age_months. A row whose child was
 * outside every room's band (under 6 months, or over 5) is reported honestly as
 * 'Outside room ages' rather than quietly dropped.
 *
 * All SQL here is unqualified: src/db/pool.js sets search_path to the instance's
 * schema, so this reads ladn on LADN and the tenant's own schema elsewhere. It
 * is READ ONLY — there is not one INSERT, UPDATE or DELETE in this file.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const T = require('./lookback-terms');
const S = require('./lookback-stats');

const ROOM_UNKNOWN = 'Outside room ages';

// Settling windows. Six weeks is the nursery's own settling-in period; weeks
// 7–18 are the child's own baseline, which is what makes the comparison a
// WITHIN-CHILD one and therefore not a comparison between families.
const SETTLE_DAYS   = 42;    // 6 weeks
const BASELINE_DAYS = 126;   // weeks 7–18 inclusive

// Separation / unsettled language. A keyword count over practitioner narrative
// is a WEAK proxy and the report says so loudly: it measures how a practitioner
// writes at least as much as how a child felt.
const SEPARATION_WORDS = [
  'settl', 'separat', 'upset', 'cried', 'crying', 'tearful', 'distress',
  'missed mum', 'missed dad', 'missed his mum', 'missed her mum', 'reassur',
  'comfort', 'cuddle', 'clingy', 'unsettl',
];

// ── small helpers ────────────────────────────────────────────────────────────

/** Place one dated row in a term. Rows outside the window are already excluded
 *  by SQL, so a null here means a null date. */
function termKeyOf(d) { const t = T.termOf(d); return t ? t.key : null; }

/** Group rows by a key, as a Map. */
function by(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (k == null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}
function distinct(rows, f) { return new Set(rows.map(f).filter(v => v != null)).size; }
function sum(rows, f) { return rows.reduce((a, r) => a + (Number(f(r)) || 0), 0); }

/** The SQL that turns a date + a date of birth into a room name, without the
 *  date of birth ever leaving Postgres. Used by every section. */
const ROOM_SQL = (dateExpr) => `
  COALESCE(
    (SELECT COALESCE(NULLIF(btrim(r.display_name),''), r.name)
       FROM rooms r
      WHERE (date_part('year',  age((${dateExpr})::date, c.date_of_birth)) * 12
           + date_part('month', age((${dateExpr})::date, c.date_of_birth)))::int >= r.min_age_months
        AND (date_part('year',  age((${dateExpr})::date, c.date_of_birth)) * 12
           + date_part('month', age((${dateExpr})::date, c.date_of_birth)))::int <  r.max_age_months
      ORDER BY r.min_age_months
      LIMIT 1),
    '${ROOM_UNKNOWN}')`;

/** A prompt is attached to every chart: this is what feeds the b163
 *  self-reflection workbook discussion on the day. */
function prompt(explain, tryThis) { return { explain, try: tryThis }; }

/** A chart the engine could not fill, said plainly rather than drawn empty. */
function emptyChart(key, title, why) {
  return { key, title, kind: 'none', empty: true, why };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. NEXT STEPS — how long they take, and how many are never looked at again
// ═════════════════════════════════════════════════════════════════════════════
async function nextStepsSection(db, win, settings) {
  const staleWeeks = Number(settings.next_steps_stale_weeks) || 12;

  // One row per next step. Area of learning comes from the linked framework
  // statement where there is one (on prod: 1 of 361) and otherwise from the
  // parent observation's first EYFS area — which is the only place the area
  // actually lives for an EyLog-imported next step.
  const { rows } = await db.query(`
    SELECT n.created_at::date                              AS set_on,
           COALESCE(n.closed_at, CASE WHEN n.status = 'completed' THEN n.updated_at END)::date AS closed_on,
           n.closed_at IS NOT NULL                         AS has_closed_at,
           CASE
             WHEN n.close_reason = 'achieved' OR n.status = 'completed' THEN 'achieved'
             WHEN n.close_reason IN ('retired','superseded','parked')   THEN n.close_reason
             WHEN n.closed_at IS NOT NULL                              THEN 'closed (no reason)'
             ELSE 'active'
           END                                             AS outcome,
           n.last_reviewed_at IS NOT NULL                  AS ever_reviewed,
           n.review_due,
           n.child_id,
           ${ROOM_SQL('n.created_at')}                     AS room,
           regexp_replace(
             replace(COALESCE(NULLIF(btrim(fs.area), ''), NULLIF(btrim(o.eyfs_areas[1]), ''), 'Not recorded'),
                     ' & ', ' and '),
             '\\s+', ' ', 'g')                                      AS area   -- see the note in trackerSection
      FROM next_steps n
      JOIN children c ON c.id = n.child_id
      LEFT JOIN framework_statements fs ON fs.id = n.framework_statement_id
      LEFT JOIN observations o          ON o.id = n.observation_id
     WHERE n.created_at::date >= $1 AND n.created_at::date <= $2
       AND c.date_of_birth IS NOT NULL`, [win.from, win.to]);

  const spine = T.termSpine(win.from, win.to);
  const achieved = rows.filter(r => r.outcome === 'achieved' && r.closed_on && r.set_on);
  const days = r => Math.max(0, Math.round((new Date(r.closed_on) - new Date(r.set_on)) / 86400000));

  // Is the "retired" pile one sweep or a habit? If 292 rows closed on a single
  // day, that is the b393 clean-up and calling it an outcome would be a lie.
  const retired = rows.filter(r => r.outcome === 'retired' && r.closed_on);
  const byCloseDay = by(retired, r => T.ymd(r.closed_on));
  let biggestSweep = { day: null, rows: 0 };
  for (const [d, rs] of byCloseDay) if (rs.length > biggestSweep.rows) biggestSweep = { day: d, rows: rs.length };

  const active = rows.filter(r => r.outcome === 'active');
  const staleCut = new Date(win.to); staleCut.setDate(staleCut.getDate() - staleWeeks * 7);
  const stale = active.filter(r => new Date(r.set_on) < staleCut);

  // ── chart: time to achieve, by term set ──────────────────────────────────
  const byTermAch = by(achieved, r => termKeyOf(r.set_on));
  const timeByTerm = spine.map(t => {
    const rs = byTermAch.get(t.key) || [];
    const d = S.distribution(rs.map(days), distinct(rs, r => r.child_id));
    return { label: t.short, full: t.label, academic_year: t.academic_year, ...d };
  });

  const byRoomAch = by(achieved, r => r.room);
  const timeByRoom = [...byRoomAch.entries()].map(([room, rs]) => ({
    label: room, ...S.distribution(rs.map(days), distinct(rs, r => r.child_id)),
  })).sort((a, b) => (b.rows || 0) - (a.rows || 0));

  const byAreaAch = by(achieved, r => r.area);
  const timeByArea = [...byAreaAch.entries()].map(([area, rs]) => ({
    label: area, ...S.distribution(rs.map(days), distinct(rs, r => r.child_id)),
  })).sort((a, b) => (b.rows || 0) - (a.rows || 0));

  // ── chart: what happens to a next step, by term set ──────────────────────
  const OUTCOMES = ['achieved', 'active', 'retired', 'superseded', 'parked', 'closed (no reason)'];
  const bySet = by(rows, r => termKeyOf(r.set_on));
  const outcomeMix = spine.map(t => {
    const rs = bySet.get(t.key) || [];
    const kids = distinct(rs, r => r.child_id);
    if (S.suppressed(kids)) return { label: t.short, full: t.label, ...S.suppressedCell(), parts: null, total: null };
    return {
      label: t.short, full: t.label, n: kids, suppressed: false, value: rs.length, total: rs.length,
      parts: OUTCOMES.map(o => ({ key: o, rows: rs.filter(r => r.outcome === o).length })),
    };
  });

  // ── chart: never reviewed / stale, by term set (active steps only) ───────
  const byActiveTerm = by(active, r => termKeyOf(r.set_on));
  const reviewMix = spine.map(t => {
    const rs = byActiveTerm.get(t.key) || [];
    const kids = distinct(rs, r => r.child_id);
    if (S.suppressed(kids)) return { label: t.short, full: t.label, ...S.suppressedCell() };
    return {
      label: t.short, full: t.label, n: kids, suppressed: false,
      value: S.pct(rs.filter(r => !r.ever_reviewed).length, rs.length),
      rows: rs.length, never_reviewed: rs.filter(r => !r.ever_reviewed).length,
    };
  });

  const achievableN = distinct(achieved, r => r.child_id);
  const conf = achieved.length >= 20 ? 'fair' : (achieved.length ? 'thin' : 'thin');

  return {
    key: 'next-steps',
    title: 'Next steps: how long they take',
    question: 'When we set a next step for a child, how long does it take to be achieved — and how many are never looked at again?',
    confidence: S.confidence(conf),
    source: 'ladn.next_steps (the b393 lifecycle columns), linked to the observation that set it.',
    limits: [
      `A next step counts as achieved when close_reason = 'achieved' or the legacy status = 'completed'. In this window ${achieved.length} did, across ${achievableN} ${achievableN === 1 ? 'child' : 'children'}.`,
      biggestSweep.rows >= 20
        ? `${biggestSweep.rows} next steps were retired on one day (${biggestSweep.day}). That is the b393 clean-up of the EyLog backlog, not a judgement about any child — it is excluded from every "how long" figure and shown separately so the outcome mix is not read as practice.`
        : 'No single-day bulk retirement found in this window.',
      'The 354 next steps imported from EyLog carry a creation date but no review history, so "never reviewed" counts them as never reviewed. That is literally true and it is also an artefact of the import — read the trend from the first full term after the b393 deploy.',
      'Only one next step on production carries a framework statement, so "area of learning" is taken from the parent observation\'s first EYFS area. A next step whose observation has no area is shown as "Not recorded" rather than being spread across the others.',
    ],
    facts: [
      { label: 'Next steps set in this window',  value: rows.length },
      { label: 'Achieved',                       value: achieved.length },
      { label: 'Still active',                   value: active.length },
      { label: `Active and older than ${staleWeeks} weeks`, value: stale.length },
      { label: 'Active and never reviewed',      value: active.filter(r => !r.ever_reviewed).length },
      { label: 'Retired in the b393 clean-up',   value: biggestSweep.rows >= 20 ? biggestSweep.rows : 0 },
    ],
    charts: [
      {
        key: 'ns-time-term', kind: 'dist', title: 'Days from set to achieved',
        subtitle: 'Median, with the middle half shaded. By the statutory term the next step was SET in.',
        unit: 'days', axis: 'Days', data: timeByTerm,
        prompt: prompt(
          'If a term stands out, what was different about it — who was on the floor, how many children were on roll, whether planning was running weekly?',
          'Pick one realistic target for this term — e.g. "a next step is reviewed within 4 weeks and closed within 8" — and decide who checks it.'),
      },
      {
        key: 'ns-time-room', kind: 'dist', title: 'Days from set to achieved, by room',
        subtitle: 'Room is the child\'s room on the day the step was set, derived from age.',
        unit: 'days', axis: 'Days', data: timeByRoom,
        prompt: prompt(
          'Does a difference between the rooms reflect the children, the kind of next steps we set there, or how the room plans?',
          'Agree one change in the slower room, and say how we would see it in this chart next term.'),
      },
      {
        key: 'ns-time-area', kind: 'dist', title: 'Days from set to achieved, by area of learning',
        subtitle: 'From the linked framework statement, else the parent observation\'s first EYFS area.',
        unit: 'days', axis: 'Days', data: timeByArea,
        prompt: prompt(
          'Are the slowest areas genuinely harder, or the ones where we are least sure what a next step should look like?',
          'Choose the area we are weakest on and plan one CPD session or one shared example for it.'),
      },
      {
        key: 'ns-outcome', kind: 'stacked', title: 'What happened to the next steps we set',
        subtitle: 'Every next step set in the term, by where it ended up.',
        unit: 'next steps', keys: OUTCOMES, data: outcomeMix,
        prompt: prompt(
          'Is the active share growing because we are setting more, or because we are closing fewer?',
          'Decide whether "retire" is a legitimate ending we should use more honestly, or a sign the step should never have been set.'),
      },
      {
        key: 'ns-review', kind: 'bar', title: 'Active next steps never reviewed',
        subtitle: 'Share of the still-open next steps set in that term with no review ever recorded.',
        unit: '%', axis: '% never reviewed', data: reviewMix, max: 100,
        prompt: prompt(
          'Where does a review actually happen in our week — and is it recorded anywhere a chart can see?',
          'Put the review in one named slot (e.g. key-person time on a Thursday) and agree it gets recorded on the step, not just discussed.'),
      },
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. FRAMEWORK TRACKER — coverage, honestly, and what we cannot see
// ═════════════════════════════════════════════════════════════════════════════
async function trackerSection(db, win) {
  const { rows } = await db.query(`
    SELECT ft.assessed_at::date                                  AS on_date,
           ft.status,
           ft.child_id,
           ft.statement_id,
           -- Area names arrive in two spellings from two imports:
           -- 'Communication and Language' and 'Communication & Language' are the
           -- same area and were landing as two bars, one of them suppressed. The
           -- ampersand form is folded into the word form and the spacing
           -- collapsed, so an area is counted once. Nothing is renamed in the
           -- table; this is a read-time normalisation only.
           regexp_replace(
             replace(COALESCE(NULLIF(btrim(ft.area), ''), NULLIF(btrim(fs.area), ''), 'Not recorded'),
                     ' & ', ' and '),
             '\\s+', ' ', 'g')                                       AS area,
           ft.framework,
           -- A GENUINE re-assessment is an edit made after the row was created.
           -- Comparing updated_at with assessed_at looks like 5,852 of 6,289
           -- cells on prod and means nothing at all: the b25m backfill BACKDATED
           -- assessed_at to the observation date while created_at is the import
           -- date, so created_at > assessed_at for exactly the same 5,852 rows.
           -- Against created_at the true figure is 1. Measured 2026-10-20.
           (ft.updated_at IS NOT NULL AND ft.created_at IS NOT NULL
            AND ft.updated_at > ft.created_at + interval '1 day')   AS reassessed,
           (ft.created_at IS NOT NULL AND ft.assessed_at IS NOT NULL
            AND ft.created_at > ft.assessed_at + interval '1 day')  AS backdated,
           ${ROOM_SQL('ft.assessed_at')}                          AS room
      FROM framework_tracker ft
      JOIN children c ON c.id = ft.child_id
      LEFT JOIN framework_statements fs ON fs.id = ft.statement_id
     WHERE ft.assessed_at::date >= $1 AND ft.assessed_at::date <= $2
       AND c.date_of_birth IS NOT NULL`, [win.from, win.to]);

  const spine = T.termSpine(win.from, win.to);
  const statusMix = [...by(rows, r => r.status).entries()]
    .map(([k, rs]) => ({ status: k || 'not recorded', rows: rs.length }))
    .sort((a, b) => b.rows - a.rows);
  const dominant = statusMix[0] || { status: null, rows: 0 };
  const dominantShare = S.pct(dominant.rows, rows.length);

  // Coverage: distinct statements evidenced per child, per term. This is what
  // the tracker CAN answer. Attainment is what it cannot — see limits.
  const byTerm = by(rows, r => termKeyOf(r.on_date));
  const coverage = spine.map(t => {
    const rs = byTerm.get(t.key) || [];
    const perChild = [...by(rs, r => r.child_id).values()].map(v => distinct(v, r => r.statement_id));
    const d = S.distribution(perChild, distinct(rs, r => r.child_id));
    return { label: t.short, full: t.label, academic_year: t.academic_year, ...d, cells: d.suppressed ? null : rs.length };
  });

  const byRoomTerm = spine.map(t => {
    const rs = byTerm.get(t.key) || [];
    const parts = [...by(rs, r => r.room).entries()].map(([room, v]) => ({
      key: room, rows: S.suppressed(distinct(v, r => r.child_id)) ? null : distinct(v, r => r.statement_id),
    }));
    const kids = distinct(rs, r => r.child_id);
    if (S.suppressed(kids)) return { label: t.short, full: t.label, ...S.suppressedCell(), parts: null };
    return { label: t.short, full: t.label, n: kids, suppressed: false, value: rs.length, parts };
  });

  const areaRows = [...by(rows, r => r.area).entries()].map(([area, rs]) => {
    const kids = distinct(rs, r => r.child_id);
    return S.suppressed(kids)
      ? { label: area, ...S.suppressedCell() }
      : { label: area, value: distinct(rs, r => r.statement_id), n: kids, suppressed: false, cells: rs.length };
  }).sort((a, b) => (b.value || 0) - (a.value || 0));

  const reassessed = rows.filter(r => r.reassessed).length;
  const backdated   = rows.filter(r => r.backdated).length;

  return {
    key: 'tracker',
    title: 'Framework tracker: what we have evidenced',
    question: 'Are the children moving through the framework — and across which areas?',
    confidence: S.confidence('weak'),
    source: 'ladn.framework_tracker, joined to framework_statements for the area.',
    limits: [
      dominantShare != null && dominantShare >= 90
        ? `This is COVERAGE, NOT ATTAINMENT. ${dominantShare}% of the cells in this window carry the single status '${dominant.status}', which is the value the b25m statement-level backfill wrote for every EyLog-evidenced cell. It means "there is evidence", not "the child is secure". An on-track / emerging / exceeding chart built on that would be a picture of an import, so this report does not draw one.`
        : 'Statuses in this window are mixed enough to read, but check the counts per status before drawing a conclusion from any one term.',
      'THERE IS NO HISTORY TABLE BEHIND framework_tracker. A cell holds ONE current status and an update overwrites it, so movement between assessment points cannot be reconstructed for the past at all — only "evidenced for the first time in this term" can. '
        + `Of the ${rows.length} cells in this window, ${reassessed} ${reassessed === 1 ? 'has' : 'have'} ever been edited after being created. `
        + `A tempting comparison of updated_at against assessed_at suggests ${backdated} instead; that number is worthless, because the b25m backfill backdated assessed_at to the observation date while created_at is the import date. `
        + 'Until a status change is written to a history row, "children moved from emerging to secure this term" is a sentence Wren cannot evidence.',
      'ladn.termly_child_reviews and ladn.termly_child_evaluations are both EMPTY on production, and no observation is flagged termly_update, so there are no stored assessment points to compare between. That is the single biggest gap for this report: one finalised termly judgement per child per term would turn this whole section from coverage into progress.',
      'assessed_at is when the cell was written, which for backfilled rows is the import date, not the date the practitioner saw the child.',
    ],
    facts: [
      { label: 'Tracker cells written in this window', value: rows.length },
      { label: 'Distinct statements evidenced',        value: distinct(rows, r => r.statement_id) },
      { label: 'Cells re-assessed later',              value: reassessed },
      { label: 'Statuses in use',                      value: statusMix.length },
    ],
    status_mix: statusMix,
    charts: [
      {
        key: 'ft-coverage', kind: 'dist', title: 'Framework statements evidenced per child',
        subtitle: 'Median per child, with the middle half shaded, by the statutory term the cell was written in.',
        unit: 'statements', axis: 'Statements per child', data: coverage,
        prompt: prompt(
          'Does a rise mean we observed more, or that an import landed that term? Check it against the observation volume chart before claiming it.',
          'Agree what good coverage looks like for one child in one term, as a number, so this chart has a line to be measured against.'),
      },
      {
        key: 'ft-room', kind: 'stacked', title: 'Statements evidenced, by room',
        subtitle: 'Distinct statements per room per term. Room derived from age on the day the cell was written.',
        unit: 'statements', keysFromParts: true, data: byRoomTerm,
        prompt: prompt(
          'Is one room evidencing far more than the other — and is that the children, the staffing, or the habit of linking an observation to a statement?',
          'If one room links statements and the other does not, pair them up for a session rather than sending a reminder.'),
      },
      {
        key: 'ft-area', kind: 'bar', title: 'Breadth by area of learning',
        subtitle: 'Distinct statements evidenced in each area across the whole window.',
        unit: 'statements', axis: 'Distinct statements', data: areaRows,
        prompt: prompt(
          'The thinnest areas — are they genuinely less relevant to our age range, or the ones we are least confident observing?',
          'Take the thinnest area and plan it into next term explicitly, then look at this chart again on the next inset day.'),
      },
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. SETTLING — four proxies, and the limit of each one said out loud
// ═════════════════════════════════════════════════════════════════════════════
async function settlingSection(db, win) {
  // Register coverage first, because every presence-based proxy depends on how
  // honestly absence is recorded — and on prod it mostly is not.
  const cov = (await db.query(`
    SELECT count(*)::int AS rows,
           count(*) FILTER (WHERE absent)::int AS absent_rows,
           count(*) FILTER (WHERE sign_in_time IS NOT NULL)::int AS signed_in,
           count(DISTINCT child_id)::int AS children
      FROM attendance WHERE date >= $1 AND date <= $2`, [win.from, win.to])).rows[0];

  // One row per child who STARTED inside the window and has had time for a
  // baseline: their first-6-week attendance rate against their own weeks 7–18.
  // Everything is computed in SQL; only the ratio and the starting term come
  // out. Children who started too recently to have a baseline are counted and
  // excluded, not quietly dropped.
  const { rows: settle } = await db.query(`
    WITH starters AS (
      SELECT c.id, c.start_date, c.date_of_birth, c.leave_date
        FROM children c
       WHERE c.start_date IS NOT NULL
         AND c.start_date >= $1 AND c.start_date <= $2
         AND c.date_of_birth IS NOT NULL
    ), att AS (
      SELECT s.id,
             count(*) FILTER (WHERE a.date >= s.start_date
                                AND a.date <  s.start_date + ${SETTLE_DAYS}
                                AND a.sign_in_time IS NOT NULL)::int AS first_days,
             count(*) FILTER (WHERE a.date >= s.start_date + ${SETTLE_DAYS}
                                AND a.date <  s.start_date + ${BASELINE_DAYS}
                                AND a.sign_in_time IS NOT NULL)::int AS later_days
        FROM starters s LEFT JOIN attendance a ON a.child_id = s.id
       GROUP BY s.id
    ), diary AS (
      SELECT s.id,
             count(*) FILTER (WHERE d.date >= s.start_date AND d.date < s.start_date + ${SETTLE_DAYS})::int AS first_diary,
             count(*) FILTER (WHERE d.date >= s.start_date AND d.date < s.start_date + ${SETTLE_DAYS}
                                AND (d.sleep_from IS NOT NULL OR COALESCE(btrim(d.naps),'') <> ''))::int AS first_sleep,
             count(*) FILTER (WHERE d.date >= s.start_date AND d.date < s.start_date + ${SETTLE_DAYS}
                                AND (COALESCE(btrim(d.lunch),'') <> '' OR COALESCE(btrim(d.meals),'') <> ''))::int AS first_food,
             count(*) FILTER (WHERE d.date >= s.start_date + ${SETTLE_DAYS} AND d.date < s.start_date + ${BASELINE_DAYS})::int AS later_diary,
             count(*) FILTER (WHERE d.date >= s.start_date + ${SETTLE_DAYS} AND d.date < s.start_date + ${BASELINE_DAYS}
                                AND (d.sleep_from IS NOT NULL OR COALESCE(btrim(d.naps),'') <> ''))::int AS later_sleep,
             count(*) FILTER (WHERE d.date >= s.start_date + ${SETTLE_DAYS} AND d.date < s.start_date + ${BASELINE_DAYS}
                                AND (COALESCE(btrim(d.lunch),'') <> '' OR COALESCE(btrim(d.meals),'') <> ''))::int AS later_food
        FROM starters s LEFT JOIN daily_diary d ON d.child_id = s.id
       GROUP BY s.id
    ), seps AS (
      SELECT s.id,
             count(*) FILTER (WHERE o.created_at::date >= s.start_date
                                AND o.created_at::date <  s.start_date + ${SETTLE_DAYS})::int AS first_obs,
             count(*) FILTER (WHERE o.created_at::date >= s.start_date
                                AND o.created_at::date <  s.start_date + ${SETTLE_DAYS}
                                AND (${SEPARATION_WORDS.map((_, i) => `lower(COALESCE(o.observation_text,'') || ' ' || COALESCE(o.title,'')) LIKE $${i + 3}`).join(' OR ')}))::int AS first_sep,
             count(*) FILTER (WHERE o.created_at::date >= s.start_date + ${SETTLE_DAYS}
                                AND o.created_at::date <  s.start_date + ${BASELINE_DAYS})::int AS later_obs,
             count(*) FILTER (WHERE o.created_at::date >= s.start_date + ${SETTLE_DAYS}
                                AND o.created_at::date <  s.start_date + ${BASELINE_DAYS}
                                AND (${SEPARATION_WORDS.map((_, i) => `lower(COALESCE(o.observation_text,'') || ' ' || COALESCE(o.title,'')) LIKE $${i + 3}`).join(' OR ')}))::int AS later_sep
        FROM starters s LEFT JOIN observations o ON o.child_id = s.id
       GROUP BY s.id
    )
    SELECT s.start_date,
           ${ROOM_SQL('s.start_date')}                        AS room,
           (s.start_date + ${BASELINE_DAYS} <= $2::date)      AS has_baseline,
           att.first_days, att.later_days,
           diary.first_diary, diary.first_sleep, diary.first_food,
           diary.later_diary, diary.later_sleep, diary.later_food,
           seps.first_obs, seps.first_sep, seps.later_obs, seps.later_sep
      FROM starters s
      JOIN children c ON c.id = s.id
      LEFT JOIN att   ON att.id   = s.id
      LEFT JOIN diary ON diary.id = s.id
      LEFT JOIN seps  ON seps.id  = s.id`,
    [win.from, win.to, ...SEPARATION_WORDS.map(w => '%' + w + '%')]);

  const spine = T.termSpine(win.from, win.to);
  const withBaseline = settle.filter(r => r.has_baseline);
  const tooRecent = settle.length - withBaseline.length;

  // (a) attendance: first-6-week rate ÷ own weeks 7–18 rate. 1.0 = in as often
  //     from the start as once settled; below 1.0 = a slower start.
  const attRatio = r => {
    const f = Number(r.first_days) || 0, l = Number(r.later_days) || 0;
    if (!l) return null;
    const fRate = f / (SETTLE_DAYS / 7);                      // days per week, first 6
    const lRate = l / ((BASELINE_DAYS - SETTLE_DAYS) / 7);    // days per week, weeks 7–18
    if (!lRate) return null;
    return S.round(fRate / lRate, 2);
  };
  const byStartTerm = by(withBaseline, r => termKeyOf(T.ymd(r.start_date)));
  const attendanceChart = spine.map(t => {
    const rs = byStartTerm.get(t.key) || [];
    const vals = rs.map(attRatio).filter(v => v != null);
    const d = S.distribution(vals, rs.length);
    return { label: t.short, full: t.label, academic_year: t.academic_year, ...d };
  });

  // (b) diary consistency: share of first-6-week diary days carrying a sleep
  //     AND a food note, against the same child's weeks 7–18.
  const diaryRatio = r => {
    const fd = Number(r.first_diary) || 0, ld = Number(r.later_diary) || 0;
    if (!fd || !ld) return null;
    const f = ((Number(r.first_sleep) || 0) + (Number(r.first_food) || 0)) / (2 * fd);
    const l = ((Number(r.later_sleep) || 0) + (Number(r.later_food) || 0)) / (2 * ld);
    if (!l) return null;
    return S.round(f / l, 2);
  };
  const diaryChart = spine.map(t => {
    const rs = byStartTerm.get(t.key) || [];
    const vals = rs.map(diaryRatio).filter(v => v != null);
    const d = S.distribution(vals, rs.length);
    return { label: t.short, full: t.label, academic_year: t.academic_year, ...d };
  });

  // (c) separation language: share of a new child's first-6-week observations
  //     using settling / separation words, against their own weeks 7–18.
  const sepChart = spine.map(t => {
    const rs = byStartTerm.get(t.key) || [];
    const kids = rs.length;
    const fObs = sum(rs, r => r.first_obs), fSep = sum(rs, r => r.first_sep);
    const lObs = sum(rs, r => r.later_obs), lSep = sum(rs, r => r.later_sep);
    if (S.suppressed(kids) || !fObs) return { label: t.short, full: t.label, ...S.suppressedCell(), parts: null };
    return {
      label: t.short, full: t.label, n: kids, suppressed: false,
      value: S.pct(fSep, fObs), later: lObs ? S.pct(lSep, lObs) : null,
      rows: fObs,
    };
  });

  // (d) key-person continuity. There is no history, so the only honest number
  //     is how many children's CURRENT key person has left the setting.
  const kp = (await db.query(`
    SELECT count(*) FILTER (WHERE c.key_person_id IS NULL)::int                       AS no_key_person,
           count(*) FILTER (WHERE c.key_person_id IS NOT NULL
                              AND (st.id IS NULL OR st.is_active IS NOT TRUE))::int   AS key_person_gone,
           count(*)::int                                                              AS on_roll,
           count(DISTINCT c.key_person_id)::int                                       AS key_people
      FROM children c LEFT JOIN staff st ON st.id = c.key_person_id
     WHERE c.leave_date IS NULL OR c.leave_date > $1::date`, [win.to])).rows[0];

  const roomRows = [...by(withBaseline, r => r.room).entries()].map(([room, rs]) => {
    const vals = rs.map(attRatio).filter(v => v != null);
    return { label: room, ...S.distribution(vals, rs.length) };
  }).sort((a, b) => (b.rows || 0) - (a.rows || 0));

  return {
    key: 'settling',
    title: 'Settling: are the children settling better or worse?',
    question: 'Are new children settling more easily than they used to — and what do we actually know about it?',
    confidence: S.confidence('weak'),
    source: 'ladn.attendance, ladn.daily_diary and ladn.observations, windowed on each child\'s own start_date.',
    limits: [
      `EVERY MEASURE HERE IS A PROXY. Wren records no settling judgement, so none of these is "how settled a child was" — each is something that tends to move with it. Each chart compares a child's FIRST SIX WEEKS against THAT SAME CHILD'S weeks 7–18, so nothing compares one family with another, and ${tooRecent} ${tooRecent === 1 ? 'child who started' : 'children who started'} too recently to have a baseline ${tooRecent === 1 ? 'is' : 'are'} excluded rather than counted as settled.`,
      `ATTENDANCE IS THE WEAKEST LINK IN THE CHAIN: only ${cov.absent_rows} of ${cov.rows} register rows in this window carry absent = true. A day a child was off and a day nobody completed the register look identical, so a low ratio can mean an unsettled start OR a quiet week on the register. Read the shape across terms, never a single term.`,
      'DIARY CONSISTENCY MEASURES US AS MUCH AS THE CHILD. A new child\'s sleep and food are written up carefully in week one because they are new; the same child in week ten may be just as settled and less written about. Take a fall towards 1.0 as the recording levelling off, not as a child unsettling.',
      'SEPARATION LANGUAGE IS A KEYWORD COUNT over the practitioner\'s own words (' + SEPARATION_WORDS.slice(0, 6).join(', ') + ', …). It measures vocabulary at least as much as feeling: a practitioner who writes warmly about a cuddle scores the same as one recording real distress. No observation text leaves the database — only the counts.',
      'KEY-PERSON CHANGES CANNOT BE COUNTED AT ALL. children.key_person_id holds one current value and there is no history table anywhere in the schema, so a change leaves no trace. The number below is the nearest honest thing: children whose key person is no longer active staff. To answer the real question, Wren needs a key_person_history row written on every change — a small, additive build.',
    ],
    facts: [
      { label: 'Children who started in this window', value: settle.length },
      { label: 'With a full 18-week baseline',         value: withBaseline.length },
      { label: 'Register rows marked absent',         value: cov.absent_rows, note: `of ${cov.rows} rows` },
      { label: 'Children with no key person',         value: kp.no_key_person },
      { label: 'Key person no longer active staff',   value: kp.key_person_gone },
    ],
    charts: [
      {
        key: 'set-att', kind: 'dist', title: 'First six weeks against the child\'s own baseline',
        subtitle: 'Attendance days per week in weeks 1–6 ÷ the same child\'s weeks 7–18. 1.0 = in as often from the start.',
        unit: '×', axis: 'Ratio to own baseline', data: attendanceChart, reference: 1,
        prompt: prompt(
          'A low term — was it the children, the time of year, or how carefully the register was kept that term?',
          'Decide one thing we would change about the first fortnight, and make sure the register is complete enough next term to show whether it worked.'),
      },
      {
        key: 'set-att-room', kind: 'dist', title: 'Same measure, by room',
        subtitle: 'Room derived from the child\'s age on their start date.',
        unit: '×', axis: 'Ratio to own baseline', data: roomRows, reference: 1,
        prompt: prompt(
          'Babies and pre-schoolers settle differently — does the gap here match what we see on the floor?',
          'Write down what the smoother room does in week one that the other does not.'),
      },
      {
        key: 'set-diary', kind: 'dist', title: 'Diary detail in the first six weeks',
        subtitle: 'Share of diary days with a sleep AND a food note, against the same child\'s weeks 7–18.',
        unit: '×', axis: 'Ratio to own baseline', data: diaryChart, reference: 1,
        prompt: prompt(
          'Is a value well above 1.0 good care of a new family, or a level of detail we could not sustain?',
          'Agree the minimum a diary carries every day, for every child, and stop measuring care by how much extra a new child gets.'),
      },
      {
        key: 'set-sep', kind: 'bar', title: 'Settling language in a new child\'s observations',
        subtitle: 'Share of first-six-week observations using settling or separation words. The lighter mark is the same children\'s weeks 7–18.',
        unit: '%', axis: '% of observations', data: sepChart, compareKey: 'later', compareLabel: 'weeks 7–18', max: 100,
        prompt: prompt(
          'Does the fall from the first six weeks to weeks 7–18 match what we remember of those children settling?',
          'If we want to measure settling properly, decide on ONE recorded judgement — a settling note at two and six weeks — and we will have a real answer by the next inset day.'),
      },
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. OBSERVATIONS — volume and quality signals, per room and term
// ═════════════════════════════════════════════════════════════════════════════
async function observationsSection(db, win) {
  const { rows } = await db.query(`
    SELECT o.created_at::date AS on_date,
           o.child_id, o.staff_id,
           ${ROOM_SQL('o.created_at')} AS room,
           (o.eyfs_areas IS NOT NULL AND array_length(o.eyfs_areas,1) > 0)                 AS has_area,
           (o.analysis   IS NOT NULL AND length(btrim(o.analysis))   > 0)                   AS has_analysis,
           (o.next_steps IS NOT NULL AND length(btrim(o.next_steps)) > 0)                   AS has_next_step,
           (o.photo_urls IS NOT NULL AND array_length(o.photo_urls,1) > 0)                  AS has_photo,
           COALESCE(o.shared_with_parents, false)                                           AS shared,
           (o.linked_framework_ids IS NOT NULL AND array_length(o.linked_framework_ids,1) > 0) AS has_stmt,
           (o.staff_id IS NOT NULL AND o.staff_id = c.key_person_id)                        AS by_key_person,
           length(COALESCE(o.observation_text,''))                                          AS chars,
           COALESCE(array_length(o.eyfs_areas,1), 0)                                        AS n_areas
      FROM observations o
      JOIN children c ON c.id = o.child_id
     WHERE o.created_at::date >= $1 AND o.created_at::date <= $2
       AND c.date_of_birth IS NOT NULL`, [win.from, win.to]);

  // Distinct areas named across the window, per child per term — breadth, not volume.
  const { rows: areaRows } = await db.query(`
    SELECT o.created_at::date AS on_date, o.child_id,
           regexp_replace(replace(btrim(a.area), ' & ', ' and '), '\\s+', ' ', 'g') AS area
      FROM observations o
      JOIN children c ON c.id = o.child_id
      CROSS JOIN LATERAL unnest(COALESCE(o.eyfs_areas, ARRAY[]::text[])) AS a(area)
     WHERE o.created_at::date >= $1 AND o.created_at::date <= $2
       AND c.date_of_birth IS NOT NULL AND btrim(a.area) <> ''`, [win.from, win.to]);

  const spine = T.termSpine(win.from, win.to);
  const byTerm = by(rows, r => termKeyOf(r.on_date));
  const byTermArea = by(areaRows, r => termKeyOf(r.on_date));

  const volume = spine.map(t => {
    const rs = byTerm.get(t.key) || [];
    const kids = distinct(rs, r => r.child_id);
    if (S.suppressed(kids)) return { label: t.short, full: t.label, academic_year: t.academic_year, ...S.suppressedCell(), parts: null };
    const parts = [...by(rs, r => r.room).entries()].map(([room, v]) => ({ key: room, rows: v.length }));
    return {
      label: t.short, full: t.label, academic_year: t.academic_year,
      n: kids, suppressed: false, value: rs.length, parts,
      per_child: S.round(rs.length / kids, 1),
      contributors: distinct(rs, r => r.staff_id),
    };
  });

  const perChild = spine.map(t => {
    const rs = byTerm.get(t.key) || [];
    const counts = [...by(rs, r => r.child_id).values()].map(v => v.length);
    return { label: t.short, full: t.label, academic_year: t.academic_year, ...S.distribution(counts, counts.length) };
  });

  const QUALITY = [
    ['has_area',      'Names an EYFS area'],
    ['has_analysis',  'Has practitioner analysis'],
    ['has_next_step', 'Sets a next step'],
    ['has_stmt',      'Linked to a framework statement'],
    ['has_photo',     'Has a photo'],
    ['shared',        'Shared with the family'],
    ['by_key_person', 'Written by the key person'],
  ];
  const quality = QUALITY.map(([k, label]) => ({
    key: k, label,
    series: spine.map(t => {
      const rs = byTerm.get(t.key) || [];
      const kids = distinct(rs, r => r.child_id);
      if (S.suppressed(kids) || !rs.length) return { label: t.short, full: t.label, ...S.suppressedCell() };
      return { label: t.short, full: t.label, n: kids, suppressed: false, value: S.pct(rs.filter(r => r[k]).length, rs.length), rows: rs.length };
    }),
  }));

  const breadth = spine.map(t => {
    const rs = byTermArea.get(t.key) || [];
    const perKid = [...by(rs, r => r.child_id).values()].map(v => distinct(v, r => r.area));
    return { label: t.short, full: t.label, academic_year: t.academic_year, ...S.distribution(perKid, perKid.length) };
  });

  const roomQuality = [...by(rows, r => r.room).entries()].map(([room, rs]) => {
    const kids = distinct(rs, r => r.child_id);
    if (S.suppressed(kids)) return { label: room, ...S.suppressedCell(), metrics: null };
    return {
      label: room, n: kids, suppressed: false, value: rs.length,
      metrics: QUALITY.map(([k, label]) => ({ key: k, label, value: S.pct(rs.filter(r => r[k]).length, rs.length) })),
      median_chars: S.median(rs.map(r => r.chars)),
    };
  }).sort((a, b) => (b.value || 0) - (a.value || 0));

  const withArea = rows.filter(r => r.has_area).length;

  return {
    key: 'observations',
    title: 'Observations: how much, and how good',
    question: 'How much are we observing, how well, and is that changing?',
    confidence: S.confidence('strong'),
    source: 'ladn.observations (the b354 model: EYFS areas, analysis, next step, framework link, photo, sharing).',
    limits: [
      `${withArea} of ${rows.length} observations in this window name an EYFS area (${S.pct(withArea, rows.length)}%), so the breadth chart speaks for about half the record. The rest are not counted as "no area" in the breadth figures — they are simply absent from them.`,
      'The quality signals are PRESENCE signals: whether a field was filled in, not whether what was written was any good. "Has practitioner analysis" means the analysis box is not empty. Reading one properly is still a human job — this chart only says where to look.',
      'Volume per child depends on who was on roll that term, so a term with few children on roll can show a high per-child figure without anybody observing more.',
      'Observations imported from EyLog (14,415 of 14,433 rows on prod at the last count) were written in EyLog\'s own screens, which had different fields. A step change at the import boundary is a change of system, not of practice.',
    ],
    facts: [
      { label: 'Observations in this window', value: rows.length },
      { label: 'Children observed',           value: distinct(rows, r => r.child_id) },
      { label: 'Staff who wrote one',         value: distinct(rows, r => r.staff_id) },
      { label: 'Share naming an EYFS area',   value: (S.pct(withArea, rows.length) ?? 0) + '%' },
      { label: 'Share shared with families',  value: (S.pct(rows.filter(r => r.shared).length, rows.length) ?? 0) + '%' },
    ],
    charts: [
      {
        key: 'ob-volume', kind: 'stacked', title: 'Observations per term, by room',
        subtitle: 'Room derived from each child\'s age on the day of the observation.',
        unit: 'observations', keysFromParts: true, data: volume,
        prompt: prompt(
          'Where volume rises or falls, what changed — staffing, ratios, the system we were using, or how we talked about observation?',
          'Decide whether volume is a thing we want to move at all, or whether the next target should be about quality instead.'),
      },
      {
        key: 'ob-per-child', kind: 'dist', title: 'Observations per child per term',
        subtitle: 'Median per child, with the middle half shaded.',
        unit: 'observations', axis: 'Per child', data: perChild,
        prompt: prompt(
          'Is the spread wide? A wide middle half means some children are observed far more than others.',
          'Agree a floor — no child goes a term with fewer than N — and name who checks it mid-term.'),
      },
      {
        key: 'ob-quality', kind: 'multiline', title: 'Quality signals over time',
        subtitle: 'Share of each term\'s observations carrying each field.',
        unit: '%', axis: '% of observations', series: quality, max: 100,
        prompt: prompt(
          'Which line would we most like to lift, and is it low because the field is hard or because it is hidden in the form?',
          'Pick ONE line to move this year. Write the target in the self-reflection workbook and look at this chart next inset day.'),
      },
      {
        key: 'ob-breadth', kind: 'dist', title: 'Areas of learning covered per child',
        subtitle: 'Distinct EYFS areas named about a child in a term. Seven is everything.',
        unit: 'areas', axis: 'Areas per child', data: breadth, max: 7,
        prompt: prompt(
          'Are we drawn to the same two or three areas? Which do we almost never write about?',
          'Choose the area we cover least and plan one week of provision around it, then check this chart again.'),
      },
      {
        key: 'ob-room-quality', kind: 'table', title: 'Quality by room, whole window',
        subtitle: 'Each quality signal as a share of that room\'s observations.',
        unit: '%', data: roomQuality,
        prompt: prompt(
          'Where the rooms differ by a lot, is it the children, the staff, or what each room believes an observation is for?',
          'Have the stronger room show the other one two of their own observations — not a policy, two real examples.'),
      },
    ],
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. YEAR ON YEAR — last year against this, and the trend where data exists
// ═════════════════════════════════════════════════════════════════════════════
async function yearOnYearSection(db, win) {
  const years = win.academic_years;
  const bounds = y => ({ from: Number(y.slice(0, 4)) + '-09-01', to: Number(y.slice(5)) + '-08-31' });

  const out = [];
  for (const y of years) {
    const b = bounds(y);
    const to = b.to > win.to ? win.to : b.to;
    if (b.from > win.to) continue;
    const q = async (sql, params) => (await db.query(sql, params || [b.from, to])).rows[0];

    const roll = await q(`SELECT count(DISTINCT child_id)::int AS n FROM attendance WHERE date >= $1 AND date <= $2`);
    const obs  = await q(`
      SELECT count(*)::int AS rows, count(DISTINCT child_id)::int AS children,
             count(DISTINCT staff_id)::int AS staff,
             count(*) FILTER (WHERE eyfs_areas IS NOT NULL AND array_length(eyfs_areas,1) > 0)::int AS with_area,
             count(*) FILTER (WHERE next_steps IS NOT NULL AND length(btrim(next_steps)) > 0)::int AS with_next_step,
             count(*) FILTER (WHERE COALESCE(shared_with_parents,false))::int AS shared
        FROM observations WHERE created_at::date >= $1 AND created_at::date <= $2`);
    const ns = await q(`
      SELECT count(*)::int AS set_rows,
             count(*) FILTER (WHERE close_reason = 'achieved' OR status = 'completed')::int AS achieved,
             count(*) FILTER (WHERE closed_at IS NULL AND status NOT IN ('completed','cancelled'))::int AS still_active
        FROM next_steps WHERE created_at::date >= $1 AND created_at::date <= $2`);
    const ft = await q(`
      SELECT count(*)::int AS cells, count(DISTINCT child_id)::int AS children,
             count(DISTINCT statement_id)::int AS statements
        FROM framework_tracker WHERE assessed_at::date >= $1 AND assessed_at::date <= $2`);
    const moves = await q(`
      SELECT count(*) FILTER (WHERE start_date >= $1 AND start_date <= $2)::int AS starters,
             count(*) FILTER (WHERE leave_date >= $1 AND leave_date <= $2)::int AS leavers
        FROM children`);
    const att = await q(`
      SELECT count(*)::int AS rows, count(*) FILTER (WHERE absent)::int AS absent_rows
        FROM attendance WHERE date >= $1 AND date <= $2`);

    const kids = Number(roll.n) || 0;
    const suppressedYear = S.suppressed(kids);
    out.push({
      academic_year: y,
      label: T.academicYearShort(y),
      partial: to < b.to,
      covers: { from: b.from, to },
      n: suppressedYear ? '<5' : kids,
      suppressed: suppressedYear,
      metrics: suppressedYear ? null : {
        children_on_roll:      kids,
        observations:          Number(obs.rows),
        obs_per_child:         S.round(Number(obs.rows) / kids, 1),
        obs_contributors:      Number(obs.staff),
        obs_with_area_pct:     S.pct(obs.with_area, obs.rows),
        obs_with_next_step_pct: S.pct(obs.with_next_step, obs.rows),
        obs_shared_pct:        S.pct(obs.shared, obs.rows),
        next_steps_set:        Number(ns.set_rows),
        next_steps_achieved:   Number(ns.achieved),
        next_steps_active:     Number(ns.still_active),
        tracker_cells:         Number(ft.cells),
        tracker_statements:    Number(ft.statements),
        starters:              Number(moves.starters),
        leavers:               Number(moves.leavers),
        register_rows:         Number(att.rows),
        register_absent_rows:  Number(att.absent_rows),
      },
    });
  }

  const full = out.filter(y => !y.partial && !y.suppressed);
  const withData = out.filter(y => !y.suppressed);
  const firstWithData = withData[0];

  const HEADLINES = [
    { key: 'obs_per_child',          label: 'Observations per child',          unit: '' },
    { key: 'obs_with_area_pct',      label: 'Observations naming an area',     unit: '%' },
    { key: 'obs_with_next_step_pct', label: 'Observations setting a next step', unit: '%' },
    { key: 'obs_shared_pct',         label: 'Observations shared with families', unit: '%' },
    { key: 'tracker_statements',     label: 'Framework statements evidenced',  unit: '' },
    { key: 'next_steps_set',         label: 'Next steps set',                  unit: '' },
    { key: 'next_steps_achieved',    label: 'Next steps achieved',             unit: '' },
    { key: 'children_on_roll',       label: 'Children with a register row',    unit: '' },
  ];

  return {
    key: 'year-on-year',
    title: 'Year on year',
    question: 'Last year against this year — and the trend across every year we hold.',
    confidence: S.confidence(withData.length >= 3 ? 'fair' : 'thin'),
    source: 'All of the above, cut by academic year (1 September – 31 August).',
    limits: [
      firstWithData
        ? `Wren holds no early-years record before ${firstWithData.covers.from.slice(0, 7)} — the first register row is 2023-09-22 and the first observation is in the autumn of 2023. A five-year comparison is therefore a ${withData.length}-year comparison, and any earlier column in a chart would be an empty space, not a zero.`
        : 'No academic year in this window holds enough data to report.',
      out.some(y => y.partial)
        ? `${out.filter(y => y.partial).map(y => y.label).join(', ')} ${out.filter(y => y.partial).length === 1 ? 'is' : 'are'} a PART YEAR — the window stops at ${win.to}. Count-based rows (observations, next steps set) are therefore not comparable with a full year; the per-child and percentage rows are.`
        : 'Every year shown is a complete academic year.',
      'A year boundary at 1 September cuts the autumn term in two places differently from a funding year — the funding figures on the Finance screens will not match these counts, and are not meant to.',
      'The EyLog cutover sits inside this window. A change between 2025/26 and 2026/27 may be the system changing rather than the practice.',
    ],
    facts: [
      { label: 'Academic years with data', value: withData.length },
      { label: 'Complete years',           value: full.length },
      { label: 'Earliest data',            value: firstWithData ? firstWithData.covers.from : '—' },
    ],
    years: out,
    headlines: HEADLINES,
    charts: HEADLINES.map(h => ({
      key: 'yoy-' + h.key, kind: 'line', title: h.label, unit: h.unit,
      subtitle: 'By academic year. A part year is marked.',
      data: out.map(y => ({
        label: y.label, full: y.academic_year, partial: y.partial,
        n: y.n, suppressed: y.suppressed,
        value: y.metrics ? y.metrics[h.key] : null,
      })),
      prompt: prompt(
        'Is the direction of this line something we chose, or something that happened to us?',
        'If it is going the wrong way and we care, name the one thing we will do about it this year — and who owns it.'),
    })),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// The whole report
// ═════════════════════════════════════════════════════════════════════════════
async function readSettings(db) {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('next_steps_stale_weeks','next_steps_soft_limit','setting_name')`);
    return Object.fromEntries(rows.map(r => [r.key, r.value]));
  } catch (_) { return {}; }
}

/**
 * Build the whole look-back report.
 * @param {object} db    a pg pool
 * @param {object} opts  { years, today, sections }
 */
async function buildReport(db, opts) {
  const o = opts || {};
  const today = T.ymd(o.today) || T.todayYmd();
  const win = T.windowForYears(o.years, today);
  const settings = await readSettings(db);

  const ALL = {
    'next-steps':   nextStepsSection,
    'tracker':      trackerSection,
    'settling':     settlingSection,
    'observations': observationsSection,
    'year-on-year': yearOnYearSection,
  };
  // A ?sections= list is filtered against what exists. If NOTHING in it is a
  // real section name, fall back to the whole report rather than returning an
  // empty one: a typo in a URL should not hand a manager a blank inset day and
  // no explanation. (Caught by the harness, which asked for 'nonsense'.)
  const asked = Array.isArray(o.sections) ? o.sections.filter(k => ALL[k]) : [];
  const wanted = asked.length ? asked : Object.keys(ALL);

  const sections = [];
  for (const k of wanted) {
    try {
      sections.push(await ALL[k](db, win, settings));
    } catch (e) {
      // One broken section must never take the inset day's report down with it.
      sections.push({
        key: k, title: k, question: '', error: true,
        confidence: S.confidence('missing'),
        limits: ['This section could not be built: ' + (e && e.message ? e.message : 'unknown error') + '. The rest of the report is unaffected.'],
        facts: [], charts: [],
      });
    }
  }

  return {
    generated_at: new Date().toISOString(),
    today,
    window: win,
    setting_name: settings.setting_name || 'the setting',
    suppression: { min_group: S.MIN_GROUP, rule: `Any group of fewer than ${S.MIN_GROUP} children is blanked and its size reported as '<5'. No individual child appears anywhere in this report.` },
    term_basis: 'Statutory early-years terms (Autumn 1 Sep – 31 Dec, Spring 1 Jan – 31 Mar, Summer 1 Apr – 31 Aug). Ealing\'s published school half-terms only exist in Wren from September 2026, so they cannot carry a look-back.',
    sections,
  };
}

module.exports = {
  buildReport, ROOM_UNKNOWN, SETTLE_DAYS, BASELINE_DAYS, SEPARATION_WORDS,
  nextStepsSection, trackerSection, settlingSection, observationsSection, yearOnYearSection,
};
