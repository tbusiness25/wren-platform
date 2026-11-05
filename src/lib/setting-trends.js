'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * setting-trends.js — b529 (2026-10-26)
 *
 * ONE engine for "the trends and the gaps across the setting". Used by three
 * callers and computed identically for all three:
 *
 *   1. the page   — Roost → Curriculum → 🔭 Look back → "Setting trends" tab
 *   2. the card   — the What-needs-me board, via scripts/setting-trends-job.js
 *   3. the job    — the same script, in the last week of each term
 *
 * Toby, 2026-10-26: "an analysis of the children data … at the end of each term
 * if a lot of the boys are not doing so well in writing it would flag it … it
 * spots the trends and the gaps across the setting rather than the individual
 * child."
 *
 * ── WHAT THIS CAN AND CANNOT SAY ─────────────────────────────────────────────
 * b523 measured, read-only against production, that Wren does not yet hold an
 * attainment judgement for most children: 6,269 of 6,289 framework_tracker
 * cells carry the status the b25m backfill wrote for every EyLog-evidenced
 * cell, which means "there is evidence", not "the child is secure".
 *
 * So this engine reports TWO different things and never blurs them:
 *
 *   EVIDENCE COVERAGE  — the share of children with at least one observation
 *                        tagged to each area of learning this term. Recorded
 *                        directly. This is the headline, and it is honest.
 *   ATTAINMENT         — only from tracker cells that carry a REAL assessment
 *                        (assessed_by and assessed_at set, status not the
 *                        backfill default, created_at not after assessed_at,
 *                        which is the signature of the backdating import).
 *                        Where there are none, the answer is the sentence
 *                        "Wren can't show progress yet because the tracking
 *                        isn't assessed" — never a chart of defaults.
 *
 * ── GDPR ──────────────────────────────────────────────────────────────────────
 * Nothing that leaves this module names or identifies a child. There is no
 * child id, no date of birth, no name and no narrative text in any returned
 * value: a date of birth becomes an age band and a room INSIDE THE SQL, and
 * child ids exist only as join keys inside this file.
 *
 * Suppression is inherited from b523 (src/lib/lookback-stats.js): any group of
 * fewer than five DISTINCT CHILDREN carries no value at all and reports its
 * size as the string '<5'. It happens here, in the payload, so the grid, the
 * flags, the CSV and the What-needs-me card all inherit the rule for free — a
 * template cannot leak what it was never given.
 *
 * READ ONLY. There is not one INSERT, UPDATE or DELETE in this file. The job
 * that raises cards does its own writing, to cockpit_cards, and nowhere else.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const T = require('./lookback-terms');
const S = require('./lookback-stats');

// ── the areas of learning, and the several spellings they arrive in ──────────
// Measured on prod 2026-10-26: framework_statements holds 'Communication and
// Language' (birth_to_5_la, eyfs_statutory, development_matters, eylog_dev_matters),
// 'Communication & Language' (fledge), 'Understanding the World' (eyfs_statutory),
// 'Understanding The World' (birth_to_5_la) and 'Understanding the world'
// (eylog_dev_matters) — the same three areas under seven spellings. An earlier
// report drew them as separate bars, half of them suppressed.
//
// The normalised key is lower-cased, '&' folded to 'and', whitespace collapsed.
// Normalisation happens in SQL (so the grouping is done once, in one place) and
// the key is mapped to a display name here.
const CANON_AREAS = [
  { key: 'communication and language',                 label: 'Communication and Language',          short: 'C&L' },
  { key: 'personal, social and emotional development',  label: 'Personal, Social and Emotional Development', short: 'PSED' },
  { key: 'physical development',                        label: 'Physical Development',                short: 'PD' },
  { key: 'literacy',                                    label: 'Literacy',                            short: 'Lit' },
  { key: 'mathematics',                                 label: 'Mathematics',                         short: 'Maths' },
  { key: 'understanding the world',                     label: 'Understanding the World',             short: 'UTW' },
  { key: 'expressive arts and design',                  label: 'Expressive Arts and Design',          short: 'EAD' },
];

// Spellings that are the same area under a different name. Anything NOT in
// CANON_AREAS and not listed here is counted as "outside the seven areas"
// (Characteristics of Effective Learning, phonics phases, SEND bands, the
// Fledge Profile) and reported as a fact rather than silently dropped.
const AREA_ALIASES = {
  'communication and language development': 'communication and language',
  'personal social and emotional development': 'personal, social and emotional development',
  'personal, social, emotional development': 'personal, social and emotional development',
  'expressive art and design': 'expressive arts and design',
  'maths': 'mathematics',
  'literacy development': 'literacy',
};

/** A normalised area key → one of the seven, or null if it is not an area of learning. */
function canonicalArea(normKey) {
  if (!normKey) return null;
  const k = AREA_ALIASES[normKey] || normKey;
  return CANON_AREAS.find(a => a.key === k) || null;
}

// The SQL that produces the normalised key. Kept as one string so the three
// evidence sources cannot normalise differently from one another.
const NORM_AREA = txt => `regexp_replace(lower(replace(btrim(${txt}), ' & ', ' and ')), '\\s+', ' ', 'g')`;

// ── the groups the setting is split by ───────────────────────────────────────
// Each dimension is a column on the cohort query. 'Not recorded' is ALWAYS its
// own bucket and is never folded into the majority: a blank is a gap in what we
// know, not evidence that the child is in the other group. That matters here —
// on prod today 7 of 36 children have no gender and 16 no home language, which
// is a quarter of the setting invisible to a sex comparison and nearly half
// invisible to a language one.
const DIMENSIONS = [
  { key: 'sex',      label: 'Sex',            col: 'sex_group',    unknown: 'Not recorded' },
  { key: 'age',      label: 'Age band',       col: 'age_group',    unknown: 'Age not recorded' },
  { key: 'room',     label: 'Room',           col: 'room_group',   unknown: 'Outside room ages' },
  { key: 'funding',  label: 'Funded hours',   col: 'funded_group', unknown: null },
  { key: 'language', label: 'Language',       col: 'eal_group',    unknown: 'Not recorded' },
  { key: 'sen',      label: 'SEN',            col: 'sen_group',    unknown: null },
  { key: 'eypp',     label: 'EYPP',           col: 'eypp_group',   unknown: null },
];

// A room is derived from AGE, not from children.room_id, for the same reason
// b523 does it: room_id is the room the child is in TODAY and mis-files every
// historical term. At LADN the rooms are themselves age bands (Baby Room
// 6–24 months, Pre-school 24–60), so this dimension nearly duplicates the age
// band — the limits text says so rather than implying two findings where there
// is one. It earns its place for settings whose rooms are not age bands.
const ROOM_SQL = asOf => `
  COALESCE(
    (SELECT COALESCE(NULLIF(btrim(r.display_name),''), r.name)
       FROM rooms r
      WHERE (date_part('year',  age((${asOf})::date, c.date_of_birth)) * 12
           + date_part('month', age((${asOf})::date, c.date_of_birth)))::int >= r.min_age_months
        AND (date_part('year',  age((${asOf})::date, c.date_of_birth)) * 12
           + date_part('month', age((${asOf})::date, c.date_of_birth)))::int <  r.max_age_months
      ORDER BY r.min_age_months
      LIMIT 1),
    'Outside room ages')`;

// ── thresholds ───────────────────────────────────────────────────────────────
// The coverage floor and the gap size are this build's own numbers and are
// stated on the page next to every flag they produce, so a manager who
// disagrees can see exactly what the flag means.
const THIN_AREA_PCT   = 50;   // an area evidenced for under half the cohort
const GROUP_GAP_PP    = 20;   // percentage points below the rest
const DEFAULT_GAP_DAYS = 21;  // only used when the setting has set no standard

// ═════════════════════════════════════════════════════════════════════════════
// The term spine
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Resolve the term to report on. 'current' (or nothing) means the term today
 * sits in. A term key like '2025-2026-T1' names one.
 *
 * The spine is b523's: the STATUTORY early-years terms (Autumn 1 Sep – 31 Dec,
 * Spring 1 Jan – 31 Mar, Summer 1 Apr – 31 Aug), because ladn.school_terms
 * holds nothing before September 2026 while the data starts in 2023, so a
 * report keyed on school_terms cannot look back at all. ladn.funding_terms
 * agrees with the statutory boundaries for 2026/27 onwards and disagrees for
 * earlier years (its rows carry rates, some are archived duplicates), so it is
 * not the spine either — but when a funding term matches the window exactly its
 * name is carried through, so the page can say which one it is.
 */
function resolveTerm(termKey, today) {
  const t = T.ymd(today) || T.todayYmd();
  // A term key is PARSED, not looked up in a spine. An earlier draft searched
  // T.termSpine('2019-09-01', today) and so silently fell back to the current
  // term for anything older than September 2019 — including the 2019 test
  // cohort, which made the whole engine look as though it ignored its argument.
  // Parsing cannot have a horizon: it works for 2018 and for 2031.
  const m = /^(\d{4})-(\d{4})-T([1-3])$/.exec(String(termKey || ''));
  if (m) {
    const ayStart = Number(m[1]);
    const ord = Number(m[3]);
    // A date that is unambiguously inside the wanted term, handed to termOf so
    // there is ONE definition of a term's boundaries in the codebase.
    const inside = ord === 1 ? (ayStart + '-09-15')
                 : ord === 2 ? ((ayStart + 1) + '-02-15')
                 :             ((ayStart + 1) + '-06-15');
    const term = T.termOf(inside);
    if (term && term.key === termKey) return withAsOf(term, t);
  }
  return withAsOf(T.termOf(t), t);
}
function withAsOf(term, today) {
  // Never measure past today: a term in progress is measured to today, and the
  // page says "so far" rather than implying a finished term.
  const asOf = term.end > today ? today : term.end;
  return Object.assign({}, term, {
    as_of: asOf,
    in_progress: term.end > today,
    days_elapsed: Math.max(1, Math.round((new Date(asOf) - new Date(term.start)) / 86400000) + 1),
  });
}
/** The term before this one, or null if it starts before there is any data. */
function previousTerm(term) {
  const prev = T.termOf(new Date(new Date(term.start + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10));
  return prev ? withAsOf(prev, prev.end) : null;
}

// ═════════════════════════════════════════════════════════════════════════════
// The cohort: one row per child on roll in the term, attributes only
// ═════════════════════════════════════════════════════════════════════════════
/**
 * "On roll in that term" = started on or before the term's as-of date and had
 * not left before the term began. Demo rows and erased rows are excluded.
 * is_active is deliberately NOT used: it describes today, so it would drop
 * every child who has since left and make a past term look smaller than it was.
 */
async function loadCohort(db, term) {
  const { rows } = await db.query(`
    SELECT c.id AS child_id,
           CASE
             WHEN upper(btrim(COALESCE(c.gender, ''))) IN ('M', 'MALE', 'BOY')   THEN 'Boys'
             WHEN upper(btrim(COALESCE(c.gender, ''))) IN ('F', 'FEMALE', 'GIRL') THEN 'Girls'
             WHEN btrim(COALESCE(c.gender, '')) = ''                            THEN 'Not recorded'
             ELSE 'Recorded another way'
           END AS sex_group,
           CASE
             WHEN c.date_of_birth IS NULL THEN 'Age not recorded'
             WHEN (date_part('year',  age($2::date, c.date_of_birth)) * 12
                 + date_part('month', age($2::date, c.date_of_birth)))::int < 24 THEN 'Under 2'
             WHEN (date_part('year',  age($2::date, c.date_of_birth)) * 12
                 + date_part('month', age($2::date, c.date_of_birth)))::int < 36 THEN '2 year olds'
             WHEN (date_part('year',  age($2::date, c.date_of_birth)) * 12
                 + date_part('month', age($2::date, c.date_of_birth)))::int < 60 THEN '3–4 year olds'
             ELSE 'Over 5'
           END AS age_group,
           ${ROOM_SQL('$2')} AS room_group,
           CASE WHEN EXISTS (
                  SELECT 1 FROM child_funding cf
                    JOIN funding_terms ft ON ft.id = cf.term_id
                   WHERE cf.child_id = c.id
                     AND COALESCE(ft.is_archived, false) = false
                     AND ft.start_date <= $3::date AND ft.end_date >= $1::date)
                THEN 'Funded hours' ELSE 'No funded hours' END AS funded_group,
           CASE
             WHEN btrim(COALESCE(c.home_language, '')) = '' THEN 'Not recorded'
             WHEN btrim(lower(COALESCE(c.home_language, ''))) IN ('english', 'en', 'eng') THEN 'English at home'
             ELSE 'Another language at home'
           END AS eal_group,
           CASE WHEN COALESCE(c.send_needs, false)
                  OR btrim(COALESCE(c.sen_status, '')) NOT IN ('', 'N', 'None', 'none', 'no', 'No')
                  OR EXISTS (SELECT 1 FROM sen_register sr
                              WHERE sr.child_id = c.id AND COALESCE(sr.is_active, true) = true)
                THEN 'On the SEN register' ELSE 'Not on the register' END AS sen_group,
           CASE WHEN COALESCE(c.eypp_eligible, false)
                  OR COALESCE(c.pupil_premium, false)
                  OR EXISTS (SELECT 1 FROM child_funding cf
                               JOIN funding_terms ft ON ft.id = cf.term_id
                              WHERE cf.child_id = c.id
                                AND COALESCE(ft.is_archived, false) = false
                                AND ft.start_date <= $3::date AND ft.end_date >= $1::date
                                AND (COALESCE(cf.eypp_eligible, false) OR COALESCE(cf.pupil_premium, false)))
                THEN 'EYPP' ELSE 'No EYPP' END AS eypp_group,
           (c.gender IS NULL      OR btrim(c.gender) = '')        AS gender_blank,
           (c.home_language IS NULL OR btrim(c.home_language) = '') AS language_blank,
           (c.date_of_birth IS NULL)                              AS dob_blank
      FROM children c
     WHERE COALESCE(c.is_demo, false) = false
       AND c.erased_at IS NULL
       AND c.start_date IS NOT NULL
       AND c.start_date <= $3::date
       AND (c.leave_date IS NULL OR c.leave_date >= $1::date)`,
    [term.start, term.as_of, term.as_of]);
  return rows;
}

// ═════════════════════════════════════════════════════════════════════════════
// Evidence: which children have an observation tagged to which area
// ═════════════════════════════════════════════════════════════════════════════
/**
 * THREE sources, unioned, because on prod no one of them is the answer. Counted
 * read-only on 2026-10-26, for the 1,390 observations written since 1 September:
 *
 *   observation_statements → framework_statements.area   299 observations
 *   observations.linked_framework_ids → …                 45 observations
 *   observations.eyfs_areas (the array the EY form writes) 583 observations
 *
 * Statement linking collapsed across the EyLog cutover (b523 measured 93% →
 * 0.3%), so a coverage report built on statements alone would say Literacy
 * reaches 5 children when the area tags say 22. "Tagged to the area" is what a
 * practitioner means, and all three places are how Wren stores that tag, so the
 * union is the honest measure. The split between the sources is returned as a
 * fact, because a shift from statements to bare area tags is itself a finding.
 */
async function loadEvidence(db, term, childIds) {
  if (!childIds.length) return [];
  const { rows } = await db.query(`
    WITH roll AS (SELECT unnest($3::int[]) AS child_id),
    obs AS (
      SELECT o.id, o.child_id
        FROM observations o
        JOIN roll ON roll.child_id = o.child_id
       WHERE o.created_at::date >= $1 AND o.created_at::date <= $2
         AND COALESCE(o.dsl_only, false) = false
         AND COALESCE(o.review_status, 'published') = 'published'
    )
    SELECT child_id, area_key, min(src) AS src, count(DISTINCT id)::int AS observations
      FROM (
        SELECT obs.child_id, obs.id, ${NORM_AREA('fs.area')} AS area_key, '1-statement' AS src
          FROM obs
          JOIN observation_statements os ON os.observation_id = obs.id
          JOIN framework_statements fs   ON fs.id = os.statement_id
         WHERE fs.area IS NOT NULL
        UNION ALL
        SELECT obs.child_id, obs.id, ${NORM_AREA('fs.area')}, '2-linked'
          FROM obs
          JOIN observations o2 ON o2.id = obs.id
          JOIN framework_statements fs ON fs.id = ANY(o2.linked_framework_ids)
         WHERE fs.area IS NOT NULL
        UNION ALL
        SELECT obs.child_id, obs.id, ${NORM_AREA('a')}, '3-area-tag'
          FROM obs
          JOIN observations o3 ON o3.id = obs.id
          CROSS JOIN LATERAL unnest(COALESCE(o3.eyfs_areas, '{}'::text[])) AS a
         WHERE btrim(COALESCE(a, '')) <> ''
      ) x
     WHERE area_key <> ''
     GROUP BY child_id, area_key`,
    [term.start, term.as_of, childIds]);
  return rows;
}

/** Observations written in the term, per child — for the volume fact and the gap flag. */
async function loadActivity(db, term, childIds) {
  if (!childIds.length) {
    return { per_child: [], gap: { gap_days: DEFAULT_GAP_DAYS, source: 'default', overdue: 0, never: 0, eligible: 0 } };
  }
  const { rows: std } = await db.query(
    `SELECT value FROM observation_standards WHERE key = 'max_gap_days_without_obs'`).catch(() => ({ rows: [] }));
  const standard = Number(std && std[0] && std[0].value);
  // ONE DEFINITION OF "TOO LONG WITHOUT AN OBSERVATION", and it is the
  // setting's own. The brief for this build said 21 days; Wren already holds
  // this setting's answer in observation_standards.max_gap_days_without_obs
  // (14 on prod, typed into Staff → Performance → Standards) and b311's
  // unobserved-children signal already measures against it. A second number
  // here would mean the trends tab and the daily signal disagreed about the
  // same children, so the standard wins and the page prints which number it
  // used and where it came from. 21 is the fallback when no standard is set.
  const gapDays = standard > 0 ? Math.round(standard) : DEFAULT_GAP_DAYS;
  const gapSource = standard > 0 ? 'observation_standards.max_gap_days_without_obs' : 'default';

  const { rows } = await db.query(`
    WITH roll AS (SELECT unnest($3::int[]) AS child_id),
    counted AS (
      SELECT roll.child_id,
             count(o.id)::int AS obs,
             max(o.created_at)::date AS last_obs
        FROM roll
        LEFT JOIN observations o
               ON o.child_id = roll.child_id
              AND o.created_at::date >= $1 AND o.created_at::date <= $2
              AND COALESCE(o.dsl_only, false) = false
              AND COALESCE(o.review_status, 'published') = 'published'
       GROUP BY roll.child_id
    ),
    ever AS (
      SELECT roll.child_id, max(o.created_at)::date AS last_ever
        FROM roll
        LEFT JOIN observations o ON o.child_id = roll.child_id
       GROUP BY roll.child_id
    )
    SELECT c.child_id, c.obs, e.last_ever,
           -- A child who joined inside the gap window cannot be overdue: they
           -- have not been here long enough. Same exclusion as b311.
           (ch.start_date <= ($2::date - ($4 || ' days')::interval)) AS long_enough
      FROM counted c
      JOIN ever e     ON e.child_id = c.child_id
      JOIN children ch ON ch.id = c.child_id`,
    [term.start, term.as_of, childIds, String(gapDays)]);

  const cut = new Date(term.as_of); cut.setDate(cut.getDate() - gapDays);
  const cutYmd = T.ymd(cut);
  const eligible = rows.filter(r => r.long_enough);
  const overdue = eligible.filter(r => !r.last_ever || T.ymd(r.last_ever) < cutYmd);
  return {
    per_child: rows.map(r => ({ child_id: r.child_id, obs: r.obs })),
    gap: {
      gap_days: gapDays,
      source: gapSource,
      overdue: overdue.length,
      never: eligible.filter(r => !r.last_ever).length,
      eligible: eligible.length,
      as_of: term.as_of,
    },
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Attainment — only where somebody actually assessed something
// ═════════════════════════════════════════════════════════════════════════════
/**
 * A cell counts as a REAL assessment only when all four hold:
 *   assessed_by IS NOT NULL      — a person did it
 *   assessed_at IS NOT NULL      — on a date
 *   status <> 'observed'         — not the b25m backfill's default, which means
 *                                  "there is evidence", not "the child is secure"
 *   NOT (created_at > assessed_at + 1 day)
 *                                — the signature of the backfill, which
 *                                  BACKDATED assessed_at to the observation
 *                                  date while created_at is the import date
 *
 * On prod that leaves 70 cells of 6,289, across 19 children (measured
 * 2026-10-26) — which is why this section usually says so rather than drawing.
 */
async function loadAttainment(db, term, childIds) {
  if (!childIds.length) return { cells: [], total_cells: 0, default_cells: 0 };
  const { rows } = await db.query(`
    WITH roll AS (SELECT unnest($3::int[]) AS child_id)
    SELECT ft.child_id, ft.status,
           ${NORM_AREA("COALESCE(NULLIF(btrim(ft.area), ''), fs.area)")} AS area_key,
           (ft.assessed_by IS NOT NULL
            AND ft.assessed_at IS NOT NULL
            AND ft.status IS DISTINCT FROM 'observed'
            AND NOT (ft.created_at IS NOT NULL AND ft.assessed_at IS NOT NULL
                     AND ft.created_at > ft.assessed_at + interval '1 day')) AS real_assessment
      FROM framework_tracker ft
      JOIN roll ON roll.child_id = ft.child_id
      LEFT JOIN framework_statements fs ON fs.id = ft.statement_id
     WHERE ft.assessed_at::date >= $1 AND ft.assessed_at::date <= $2`,
    [term.start, term.as_of, childIds]);
  return {
    cells: rows.filter(r => r.real_assessment),
    total_cells: rows.length,
    default_cells: rows.filter(r => !r.real_assessment).length,
  };
}

/** Next steps opened in or before the term and never reviewed. */
async function loadNextSteps(db, term, childIds) {
  if (!childIds.length) return { open: 0, never_reviewed: 0, children: 0, oldest_days: null };
  const { rows } = await db.query(`
    WITH roll AS (SELECT unnest($2::int[]) AS child_id)
    SELECT n.child_id,
           n.last_reviewed_at IS NOT NULL AS ever_reviewed,
           ($1::date - n.created_at::date)::int AS age_days
      FROM next_steps n
      JOIN roll ON roll.child_id = n.child_id
     WHERE n.created_at::date <= $1
       -- 'open' uses b523's definition, unchanged: not closed and not completed.
       AND n.closed_at IS NULL
       AND COALESCE(n.status, '') NOT IN ('completed', 'cancelled')`,
    [term.as_of, childIds]);
  const unreviewed = rows.filter(r => !r.ever_reviewed);
  return {
    open: rows.length,
    never_reviewed: unreviewed.length,
    children: new Set(unreviewed.map(r => r.child_id)).size,
    oldest_days: unreviewed.length ? Math.max(...unreviewed.map(r => Number(r.age_days) || 0)) : null,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Shaping: the grid, suppressed
// ═════════════════════════════════════════════════════════════════════════════
/** Distinct-children coverage of one area within one set of children. */
function coverageCell(childIdsInGroup, evidencedByArea, areaKey) {
  const n = childIdsInGroup.length;
  if (S.suppressed(n)) return S.suppressedCell();
  const have = childIdsInGroup.filter(id => (evidencedByArea.get(areaKey) || new Set()).has(id)).length;
  return Object.assign(S.cell(S.pct(have, n), n, { children_evidenced: have }), { of: n });
}

/**
 * The buckets of one dimension, each with its member child ids. Buckets are
 * ordered by size, except that the 'not recorded' bucket is always last — it is
 * a gap in the data, not a finding, and it should not head the grid.
 */
function bucketsOf(cohort, dim) {
  const m = new Map();
  for (const c of cohort) {
    const k = c[dim.col] || dim.unknown || 'Not recorded';
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c.child_id);
  }
  const isUnknown = k => dim.unknown ? k === dim.unknown : /not recorded/i.test(k);
  return [...m.entries()]
    .map(([label, ids]) => ({ dim: dim.key, dim_label: dim.label, key: dim.key + ':' + label, label, ids, unknown: isUnknown(label) }))
    .sort((a, b) => (a.unknown - b.unknown) || (b.ids.length - a.ids.length) || a.label.localeCompare(b.label));
}

// ═════════════════════════════════════════════════════════════════════════════
// The flags
// ═════════════════════════════════════════════════════════════════════════════
/**
 * Every flag states the numbers behind it, in its own `detail` sentence, so a
 * card on the What-needs-me board is readable without opening the report. No
 * flag is ever raised from a suppressed figure — the suppression is applied
 * before the comparison, not after.
 */
function buildFlags(ctx) {
  const { term, cohort, areasAll, grid, activity, nextSteps, attributes } = ctx;
  const flags = [];
  const n = cohort.length;

  // 1. an area evidenced for under half the cohort
  for (const row of areasAll) {
    if (row.suppressed || row.value == null) continue;
    if (row.value >= THIN_AREA_PCT) continue;
    flags.push({
      key: 'area-thin:' + row.area_short,
      severity: row.value < 25 ? 'high' : 'medium',
      kind: 'area_thin',
      title: `${row.area} evidenced for ${row.value}% of the children`,
      detail: `${row.children_evidenced} of ${row.of} children on roll in ${term.label} have at least one observation tagged to ${row.area}`
            + ` — ${row.value}%, under the ${THIN_AREA_PCT}% this report flags at.`
            + (ctx.areas_median_pct == null ? ''
               : ` The middle figure across the seven areas this term is ${ctx.areas_median_pct}%.`),
      numbers: { area: row.area, pct: row.value, children_evidenced: row.children_evidenced, cohort: row.of, threshold: THIN_AREA_PCT },
    });
  }

  // 2. a group more than 20 percentage points below the rest, both ≥ 5
  for (const g of grid.gaps) {
    // A bucket label is a NOUN PHRASE, not a plural noun: 'Boys' reads, but
    // 'No funded hours are 36.9 points behind' and '10 of 17 no funded hours'
    // do not. The label is quoted and the children are counted around it, so
    // every one of the seven splits produces a sentence.
    flags.push({
      key: 'group-gap:' + g.dim + ':' + g.group + ':' + g.area_short,
      severity: g.gap_pp >= 35 ? 'high' : 'medium',
      kind: 'group_gap',
      title: `${g.group}: ${g.gap_pp} points behind the rest on ${g.area}`,
      detail: `${g.group_evidenced} of the ${g.group_n} children in “${g.group}” (${g.group_pct}%) ${g.group_evidenced === 1 ? 'has' : 'have'} an observation tagged to ${g.area} this term,`
            + ` against ${g.rest_evidenced} of ${g.rest_n} (${g.rest_pct}%) of the rest — a gap of ${g.gap_pp} percentage points.`
            + ` Both groups are at or above the five-child floor, so neither figure is suppressed.`,
      numbers: g,
    });
  }

  // 3. children with no observation for longer than the setting's standard
  if (activity.gap.overdue > 0) {
    flags.push({
      key: 'obs-gap',
      severity: activity.gap.overdue >= Math.max(3, Math.round(activity.gap.eligible * 0.15)) ? 'high' : 'medium',
      kind: 'obs_gap',
      title: `${activity.gap.overdue} ${activity.gap.overdue === 1 ? 'child has' : 'children have'} had no observation for more than ${activity.gap.gap_days} days`,
      detail: `${activity.gap.overdue} of ${activity.gap.eligible} children who have been on roll longer than ${activity.gap.gap_days} days`
            + ` have no observation newer than ${activity.gap.gap_days} days before ${activity.gap.as_of}`
            + (activity.gap.never ? `, and ${activity.gap.never} of those have never had one` : '')
            + `. The gap is this setting's own standard (${activity.gap.source}). This view is a count only — the list of who they are is on Staff → Observation performance.`,
      link: '/admin/staff/obs-performance',
      link_label: 'Who they are (Staff → Observation performance)',
      numbers: activity.gap,
    });
  }

  // 4. next steps opened but not reviewed
  if (nextSteps.never_reviewed >= 5) {
    flags.push({
      key: 'next-steps-unreviewed',
      severity: nextSteps.never_reviewed >= 20 ? 'high' : 'medium',
      kind: 'next_steps_unreviewed',
      title: `${nextSteps.never_reviewed} open next steps have never been reviewed`,
      detail: `${nextSteps.never_reviewed} of ${nextSteps.open} next steps that are still open, across ${nextSteps.children >= S.MIN_GROUP ? nextSteps.children + ' children' : 'fewer than five children'},`
            + ` have no review recorded against them`
            + (nextSteps.oldest_days ? `; the oldest was set ${nextSteps.oldest_days} days ago` : '')
            + `. A next step nobody returns to is a plan, not a practice.`,
      numbers: { open: nextSteps.open, never_reviewed: nextSteps.never_reviewed, oldest_days: nextSteps.oldest_days },
    });
  }

  // 5. a missing attribute, because it blinds the analysis
  for (const a of attributes) {
    if (!a.blank) continue;
    // 15%, not 25%: measured on prod, gender is blank for 9 of 40 children —
    // 22.5%, nearly a quarter of the setting invisible to a sex comparison, and
    // under a 25% bar that would have been filed as 'for the record' and never
    // reached the board. A blank on a fifth of the children is worth a card.
    const share = a.blank / Math.max(1, n);
    flags.push({
      key: 'attribute-missing:' + a.key,
      severity: share >= 0.15 ? 'medium' : 'low',
      kind: 'attribute_missing',
      title: `${a.blank} of ${n} ${a.blank === 1 ? 'children has' : 'children have'} no ${a.label.toLowerCase()} recorded`,
      detail: `${a.blank} of the ${n} children on roll in ${term.label} ${a.blank === 1 ? 'has' : 'have'} no ${a.label.toLowerCase()} on their record`
            + ` (${S.pct(a.blank, n)}%). ${a.blank === 1 ? 'That child cannot' : 'Those children cannot'} appear on either side of a ${a.compares} comparison, so every ${a.compares} figure`
            + ` in this report describes the ${n - a.blank} children we do know about. This is a gap in what we record, not a finding about the children.`,
      numbers: { blank: a.blank, cohort: n, pct: S.pct(a.blank, n) },
    });
  }

  const rank = { high: 0, medium: 1, low: 2 };
  return flags.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.key.localeCompare(b.key));
}

// ═════════════════════════════════════════════════════════════════════════════
// buildTrends — the whole thing
// ═════════════════════════════════════════════════════════════════════════════
/**
 * @param {object} db      a pg pool (search_path already set to the instance's schema)
 * @param {object} [opts]  { term: 'current' | '<term key>', today: 'YYYY-MM-DD', compare: true }
 */
async function buildTrends(db, opts) {
  const o = opts || {};
  const today = T.ymd(o.today) || T.todayYmd();
  const term = resolveTerm(o.term, today);

  const cohort = await loadCohort(db, term);
  const childIds = cohort.map(c => c.child_id);
  // Sequential, not Promise.all: a pg POOL would run these in parallel happily,
  // but scripts/b529-prod-forecast.js hands in a single read-only Client, where
  // overlapping queries are queued with a deprecation warning and will be an
  // error in pg 9. Four small queries against forty children cost nothing.
  const evidence = await loadEvidence(db, term, childIds);
  const activity = await loadActivity(db, term, childIds);
  const attainment = await loadAttainment(db, term, childIds);
  const nextSteps = await loadNextSteps(db, term, childIds);

  // child ids per canonical area, and the source split
  const evidencedByArea = new Map();
  const srcSplit = { '1-statement': 0, '2-linked': 0, '3-area-tag': 0 };
  let outsideSeven = 0;
  const outsideNames = new Set();
  for (const r of evidence) {
    const canon = canonicalArea(r.area_key);
    if (!canon) { outsideSeven += 1; outsideNames.add(r.area_key); continue; }
    if (!evidencedByArea.has(canon.key)) evidencedByArea.set(canon.key, new Set());
    evidencedByArea.get(canon.key).add(r.child_id);
    srcSplit[r.src] = (srcSplit[r.src] || 0) + 1;
  }

  // ── coverage for the whole cohort ──────────────────────────────────────────
  const areasAll = CANON_AREAS.map(a => {
    const c = coverageCell(childIds, evidencedByArea, a.key);
    return Object.assign({ area: a.label, area_key: a.key, area_short: a.short }, c);
  });
  const shown = areasAll.filter(a => !a.suppressed && a.value != null).map(a => a.value);
  const areasMedian = shown.length ? S.round(S.median(shown), 1) : null;

  // ── the heat grid: areas × groups ─────────────────────────────────────────
  const dims = [];
  const gaps = [];
  for (const dim of DIMENSIONS) {
    const buckets = bucketsOf(cohort, dim);
    const usable = buckets.filter(b => !b.unknown && b.ids.length >= S.MIN_GROUP);
    const dimOut = {
      key: dim.key,
      label: dim.label,
      buckets: buckets.map(b => ({ key: b.key, label: b.label, n: b.ids.length, unknown: b.unknown,
                                   suppressed: S.suppressed(b.ids.length) })),
      comparable: usable.length >= 2,
      why_not: null,
    };
    if (!dimOut.comparable) {
      const biggest = buckets.filter(b => !b.unknown).sort((a, b) => b.ids.length - a.ids.length);
      dimOut.why_not = buckets.length <= 1
        ? `Every child on roll is in one bucket (${(buckets[0] || {}).label || 'none'}), so there is nothing to compare.`
        : `Only ${usable.length} of the ${buckets.filter(b => !b.unknown).length} groups reach the five-child floor`
          + (biggest.length ? ` (${biggest.map(b => b.label + ' ' + (S.suppressed(b.ids.length) ? '<5' : b.ids.length)).join(', ')})` : '')
          + `, so a comparison would either be one group against itself or would publish a figure for fewer than five children.`;
    }
    dims.push(dimOut);

    // the grid cells, and the gaps worth flagging
    for (const b of buckets) {
      b.cells = CANON_AREAS.map(a => coverageCell(b.ids, evidencedByArea, a.key));
    }
    dimOut.cells = buckets.map(b => ({ key: b.key, cells: b.cells }));

    if (!dimOut.comparable) continue;
    for (const b of usable) {
      const restIds = cohort.filter(c => !b.ids.includes(c.child_id) && !buckets.find(x => x.unknown && x.ids.includes(c.child_id)))
        .map(c => c.child_id);
      if (S.suppressed(restIds.length)) continue;     // the rest is too small to publish
      CANON_AREAS.forEach((a, i) => {
        const mine = b.cells[i];
        const theirs = coverageCell(restIds, evidencedByArea, a.key);
        if (mine.suppressed || theirs.suppressed || mine.value == null || theirs.value == null) return;
        const gapPp = S.round(theirs.value - mine.value, 1);
        if (gapPp <= GROUP_GAP_PP) return;
        gaps.push({
          dim: dim.key, dim_label: dim.label, group: b.label, group_key: b.key,
          area: a.label, area_short: a.short, area_key: a.key,
          group_pct: mine.value, group_n: mine.of, group_evidenced: mine.children_evidenced,
          rest_pct: theirs.value, rest_n: theirs.of, rest_evidenced: theirs.children_evidenced,
          gap_pp: gapPp, threshold_pp: GROUP_GAP_PP,
        });
      });
    }
  }
  gaps.sort((a, b) => b.gap_pp - a.gap_pp);

  // ── attainment, if anybody assessed anything ──────────────────────────────
  const realChildren = new Set(attainment.cells.map(c => c.child_id));
  const statusMix = [...new Set(attainment.cells.map(c => c.status))].map(st => {
    const rs = attainment.cells.filter(c => c.status === st);
    const kids = new Set(rs.map(r => r.child_id)).size;
    return Object.assign({ label: st }, S.cell(rs.length, kids, { cells: rs.length }));
  }).sort((a, b) => (b.cells || 0) - (a.cells || 0));
  const attainmentOut = {
    available: realChildren.size >= S.MIN_GROUP,
    assessed_children: realChildren.size >= S.MIN_GROUP ? realChildren.size : '<5',
    cohort: cohort.length,
    real_cells: attainment.cells.length,
    default_cells: attainment.default_cells,
    total_cells: attainment.total_cells,
    status_mix: realChildren.size >= S.MIN_GROUP ? statusMix : [],
    why: realChildren.size >= S.MIN_GROUP
      ? `${realChildren.size} of ${cohort.length} children have at least one genuinely assessed tracker cell in ${term.label}`
        + ` (${attainment.cells.length} cells of the ${attainment.total_cells} written in the term; the other ${attainment.default_cells}`
        + ` carry the backfill default, which records that there is evidence, not that the child is secure).`
        + ` Read it as what those children were assessed as — not as the setting's attainment.`
      : `Wren can't show progress yet because the tracking isn't assessed.`
        + ` ${attainment.total_cells} tracker cells were written in ${term.label} and ${attainment.default_cells} of them carry the status the`
        + ` b25m backfill wrote for every EyLog-evidenced cell, which means "there is evidence", not "the child is secure".`
        + ` Fewer than five children have a cell with an assessor, a date and a status somebody chose, so there is nothing here that could be`
        + ` shown without either publishing an individual child or drawing a picture of an import.`,
  };

  // ── the attributes that blind the analysis ────────────────────────────────
  const attributes = [
    { key: 'gender',        label: 'Gender',        compares: 'sex',      blank: cohort.filter(c => c.gender_blank).length },
    { key: 'home_language', label: 'Home language', compares: 'language', blank: cohort.filter(c => c.language_blank).length },
    { key: 'date_of_birth', label: 'Date of birth', compares: 'age band', blank: cohort.filter(c => c.dob_blank).length },
  ];

  const ctx = {
    term, cohort, areasAll, areas_median_pct: areasMedian,
    grid: { gaps }, activity, nextSteps, attributes,
  };
  const flags = buildFlags(ctx);

  const out = {
    generated_at: new Date().toISOString(),
    today,
    term: {
      key: term.key, label: term.label, short: term.short, start: term.start, end: term.end,
      as_of: term.as_of, in_progress: term.in_progress, academic_year: term.academic_year,
    },
    cohort: {
      children: cohort.length,
      observations: activity.per_child.reduce((a, r) => a + (Number(r.obs) || 0), 0),
      children_with_any: activity.per_child.filter(r => Number(r.obs) > 0).length,
      definition: 'Children who had started by ' + term.as_of + ' and had not left before ' + term.start
                + '. Demo and erased records excluded. is_active is not used, so a child who has since left still counts in the term they were here.',
    },
    suppression: {
      min_group: S.MIN_GROUP,
      rule: `No percentage is shown for any group of fewer than ${S.MIN_GROUP} children; its size is reported as '<5'.`,
    },
    coverage: {
      areas: areasAll,
      median_pct: areasMedian,
      source_split: {
        statement_links: srcSplit['1-statement'] || 0,
        observation_linked_ids: srcSplit['2-linked'] || 0,
        area_tags: srcSplit['3-area-tag'] || 0,
        outside_seven_areas: outsideSeven,
        outside_names: [...outsideNames].sort(),
      },
    },
    grid: { areas: CANON_AREAS.map(a => ({ key: a.key, label: a.label, short: a.short })), dimensions: dims },
    gaps,
    attainment: attainmentOut,
    activity: { gap: activity.gap },
    next_steps: nextSteps,
    attributes,
    flags,
    confidence: S.confidence(areasMedian == null ? 'thin' : 'fair'),
    limits: limitsFor(term, attainmentOut, srcSplit, dims),
  };

  if (o.compare !== false) out.comparison = await compareWithPrevious(db, term, out, today);
  return out;
}

/** The same coverage figures for the previous term, and the movement. */
async function compareWithPrevious(db, term, current, today) {
  const prev = previousTerm(term);
  if (!prev) return null;
  const cohort = await loadCohort(db, prev);
  if (!cohort.length) {
    return { term: { key: prev.key, label: prev.label }, available: false,
             why: `No child was on roll in ${prev.label} — the records do not go back that far.` };
  }
  const ids = cohort.map(c => c.child_id);
  const evidence = await loadEvidence(db, prev, ids);
  const byArea = new Map();
  for (const r of evidence) {
    const canon = canonicalArea(r.area_key);
    if (!canon) continue;
    if (!byArea.has(canon.key)) byArea.set(canon.key, new Set());
    byArea.get(canon.key).add(r.child_id);
  }
  const areas = CANON_AREAS.map(a => {
    const c = coverageCell(ids, byArea, a.key);
    const now = current.coverage.areas.find(x => x.area_key === a.key) || {};
    const move = (c.suppressed || now.suppressed || c.value == null || now.value == null)
      ? null : S.round(now.value - c.value, 1);
    return Object.assign({ area: a.label, area_short: a.short, area_key: a.key, move_pp: move }, c);
  });
  // A term still running is compared on like-for-like days, or not at all: a
  // half-finished Autumn against a whole Summer is not a fall in practice.
  const partial = term.in_progress;
  return {
    term: { key: prev.key, label: prev.label, start: prev.start, end: prev.end },
    available: true,
    cohort: cohort.length,
    areas,
    partial,
    note: partial
      ? `${term.label} is still running: ${term.days_elapsed} days of it so far against the whole of ${prev.label}.`
        + ` A lower figure here is at least partly the term being shorter, so read the movement at the end of term, not now.`
      : `Both terms are complete, so the movement is comparable — though the children are not the same children: `
        + `${cohort.length} were on roll in ${prev.label} and ${current.cohort.children} in ${term.label}.`,
  };
}

function limitsFor(term, attainment, srcSplit, dims) {
  const tagOnly = srcSplit['3-area-tag'] || 0;
  const stmt = srcSplit['1-statement'] || 0;
  const out = [
    'COVERAGE IS NOT ATTAINMENT. "Evidenced" means at least one observation this term carried a tag for that area. It says nothing about how well the child is doing in it — a child with ten Literacy observations and a child with one both count once.',
    `"Tagged to an area" is read from all three places Wren stores it: a statement link (observation_statements, ${stmt} child-area pairs this term), the observation's own linked statement ids (${srcSplit['2-linked'] || 0}) and the area tags the EY form writes (${tagOnly}). A child and an area are counted ONCE and attributed to the strongest source that carried them, so a zero on the middle one means nothing arrived only that way — not that the column is unused. Statement linking collapsed across the EyLog cutover — b523 measured it falling from 93% of observations to 0.3% — so statements alone would badly understate coverage. If that split shifts between terms, some of the movement in this report is a change in how we tag, not in what we did.`,
    'The room is derived from each child\'s age on ' + term.as_of + ', not from children.room_id, because room_id is the room the child is in today and would mis-file every past term. At LADN the rooms ARE age bands (Baby Room 6–24 months, Pre-school 24–60), so the Room rows and the Age band rows are close to the same split — treat them as one finding, not two.',
    `No percentage is shown for any group of fewer than five children. On a projector in a staff room that floor is not negotiable, so a small group simply reads '<5' and takes no part in any comparison.`,
    'A blank attribute is its own group and is never folded into the majority. A comparison therefore describes only the children whose attribute we know, which is stated under each one.',
    attainment.available
      ? 'The attainment figures cover only the children with a genuinely assessed tracker cell, which is a minority of the setting. They are not the setting\'s attainment.'
      : attainment.why,
    'The unreviewed-next-steps figure counts next steps that are open TODAY, because next_steps records one current status and no history. For the term in progress that is exactly right; for a past term it describes what is still outstanding from it, not what was outstanding at the time.',
    'There is no history table behind framework_tracker and no stored termly judgement per child (ladn.termly_child_reviews and termly_child_evaluations are empty on production), so this report cannot say a child moved from emerging to secure. One finalised termly judgement per child per term is the single change that would turn this section from coverage into progress.',
  ];
  const unusable = dims.filter(d => !d.comparable);
  if (unusable.length) {
    out.push('Not every split can be compared in ' + term.label + ': '
      + unusable.map(d => d.label.toLowerCase() + ' — ' + d.why_not).join(' ')
      + ' Those rows are drawn, so the gap in what we record is visible, but no flag is raised from them.');
  }
  out.push('The term is the STATUTORY early-years term (Autumn 1 Sep – 31 Dec, Spring 1 Jan – 31 Mar, Summer 1 Apr – 31 Aug), not a school half-term: ladn.school_terms holds nothing before September 2026 while the children\'s records start in 2023.');
  return out;
}

module.exports = {
  buildTrends, resolveTerm, previousTerm,
  canonicalArea, bucketsOf, buildFlags, coverageCell, limitsFor,
  loadCohort, loadEvidence, loadActivity, loadAttainment, loadNextSteps,
  CANON_AREAS, AREA_ALIASES, DIMENSIONS, NORM_AREA,
  THIN_AREA_PCT, GROUP_GAP_PP, DEFAULT_GAP_DAYS,
};
