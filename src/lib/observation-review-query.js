'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * observation-review-query.js — b536 (2026-10-29)
 *
 * The filter → SQL half of the observation reviewer (Roost → Curriculum →
 * Observations). One place builds the WHERE clause, so the list, the facet
 * counts, the total and the PDF export can never disagree about what the filter
 * means — a reviewer whose export does not match the list it was taken from is
 * worse than no reviewer.
 *
 * READ ONLY. There is no INSERT, UPDATE or DELETE anywhere in this file, and
 * the reviewer never changes an observation.
 *
 * ── AREA NORMALISATION (why this is not a cosmetic detail) ───────────────────
 * ladn.observations.eyfs_areas is free text written by three different things:
 * Wren's own pickers, the EyLog importer, and (historically) the EY tablet's
 * abbreviations. Measured 2026-10-29:
 *
 *   prod: "Expressive Arts and Design" 1,322 AND "Expressive arts and design" 1,186
 *         "Understanding The World"      633 AND "Understanding the world"     517
 *                                            AND "Understanding the World"       1
 *   dev:  the same case variants PLUS "UW", "PSED", "PD", "LIT",
 *         "Expressive Arts & Design", "Communication & Language",
 *         "Personal, Social & Emotional"
 *
 * So a filter that compares the raw string finds about half of Expressive Arts
 * and none of what the tablet wrote. Normalisation happens in TWO stages and
 * both are needed:
 *   1. in SQL — lower-case, '&' → 'and', whitespace collapsed. One expression
 *      (NORM_AREA), used by the filter and the facet alike.
 *   2. in JS   — the alias table folds the remaining spellings and the
 *      abbreviations onto the seven canonical areas.
 * CANON_AREAS / AREA_ALIASES / NORM_AREA are REUSED from setting-trends.js
 * (b‑trends) rather than copied; EXTRA_AREA_ALIASES below adds only the
 * abbreviations that file had no reason to know about.
 *
 * Anything that still does not fold is reported as `other`, with a count, not
 * silently dropped — Characteristics of Effective Learning, phonics phases and
 * SEND bands all live in this column too.
 *
 * ── AGE BANDS ────────────────────────────────────────────────────────────────
 * "Age band at the time of the observation" uses the TRACKER's own bands, read
 * from ladn.framework_statements for the setting's default framework, not a new
 * set invented here (the brief is explicit). birth_to_5_la's six positions —
 * Range 1 (0-9 months) … Range 6 (48-71 months) — become a partition by taking
 * each band's lower bound as the boundary, so every age lands in exactly one
 * band and the facet counts add up to the total. Falls back to that same six if
 * the table is empty or the labels do not parse.
 *
 * ── dsl_only ─────────────────────────────────────────────────────────────────
 * A safeguarding-only observation is excluded unless the viewer is the DSL or
 * deputy DSL — src/lib/ey-inbox-permissions.js's dslFlags() is the existing
 * check and is reused. Managers do NOT get a blanket pass here: unlike the
 * inbox (where canSeeSafeguarding() gives one), a dsl_only observation is
 * written precisely so it stays out of the general record, and a bulk export is
 * the last place to widen that. The caller passes `includeDsl` and this file
 * never decides it for itself.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const ST = require('./setting-trends');     // CANON_AREAS, AREA_ALIASES, NORM_AREA
const LT = require('./lookback-terms');     // todayYmd, ymd, termOf

// ── areas ────────────────────────────────────────────────────────────────────

/* The abbreviations the EY tablet wrote and the spellings the importer left
 * behind. Keys are already NORM_AREA-normalised (lower case, ' and ', single
 * spaces); values are a CANON_AREAS key. */
const EXTRA_AREA_ALIASES = {
  'cl': 'communication and language',
  'c and l': 'communication and language',                  // "C&L" after & folding
  'communication': 'communication and language',
  'communication and language development': 'communication and language',
  'psed': 'personal, social and emotional development',
  'personal, social and emotional': 'personal, social and emotional development',
  'personal social and emotional': 'personal, social and emotional development',
  'personal, social and emotional dev': 'personal, social and emotional development',
  'pd': 'physical development',
  'physical': 'physical development',
  'lit': 'literacy',
  'maths': 'mathematics',
  'math': 'mathematics',
  'uw': 'understanding the world',
  'utw': 'understanding the world',
  'understanding world': 'understanding the world',
  'ead': 'expressive arts and design',
  'expressive arts': 'expressive arts and design',
  'expressive arts and design': 'expressive arts and design',
};

/* ── THE WIRE VALUE FOR AN AREA IS A SLUG, NOT THE CANONICAL KEY ──────────────
 * Found by scripts/b536-verify.js: the canonical key
 * "personal, social and emotional development" CONTAINS A COMMA, and the query
 * string is comma-separated, so `areas=personal, social and…` arrived as two
 * tokens ("personal", "social and emotional development"), neither of which
 * folds — and the area filter silently matched nothing, returning every row.
 * A filter that silently does not filter is the worst possible failure for this
 * build, so the wire value is a comma-free slug. Every slug is already in
 * EXTRA_AREA_ALIASES (or is itself a canonical key), so canonOf() accepts both
 * forms and an old bookmark carrying a full key still works — as long as it has
 * no comma in it. */
const AREA_SLUGS = {
  'communication and language': 'cl',
  'personal, social and emotional development': 'psed',
  'physical development': 'pd',
  'literacy': 'literacy',
  'mathematics': 'mathematics',
  'understanding the world': 'utw',
  'expressive arts and design': 'ead',
};
const slugFor = canonKey => AREA_SLUGS[canonKey] || String(canonKey || '').replace(/[^a-z]+/g, '-');
/** The seven areas with the slug the UI sends and the facets key on. */
const areaList = () => ST.CANON_AREAS.map(a => ({ key: a.key, slug: slugFor(a.key), label: a.label, short: a.short }));

/** '  Expressive Arts & Design ' → 'expressive arts and design'. Mirrors NORM_AREA. */
function normArea(raw) {
  return String(raw == null ? '' : raw)
    .trim().toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ');
}

/** A raw or normalised area string → one of the seven CANON_AREAS, or null. */
function canonOf(raw) {
  const n = normArea(raw);
  if (!n) return null;
  const k = EXTRA_AREA_ALIASES[n] || ST.AREA_ALIASES[n] || n;
  return ST.CANON_AREAS.find(a => a.key === k) || null;
}

/* Every normalised spelling that folds onto a canonical key — what the SQL
 * filter is given, so the folding is decided here once and not in the query. */
function spellingsFor(canonKey) {
  const out = new Set([canonKey]);
  for (const [alias, target] of Object.entries(ST.AREA_ALIASES)) if (target === canonKey) out.add(alias);
  for (const [alias, target] of Object.entries(EXTRA_AREA_ALIASES)) if (target === canonKey) out.add(alias);
  return [...out];
}

// The SQL expression that normalises ONE area string. Deliberately stronger
// than setting-trends' NORM_AREA on one point: '&' is folded with optional
// surrounding whitespace, because dev holds "Expressive Arts & Design" AND the
// tablet could write "Arts&Design". Same output for every input that file
// handles, so the two agree wherever both run.
const SQL_NORM_AREA = txt =>
  `regexp_replace(regexp_replace(lower(btrim(${txt})), '\\s*&\\s*', ' and ', 'g'), '\\s+', ' ', 'g')`;

// ── age bands ────────────────────────────────────────────────────────────────

/* The fallback partition: birth_to_5_la's six positions. Used when
 * framework_statements has no parseable "Range N (A-B months)" labels. */
const FALLBACK_BANDS = [
  { ordinal: 1, label: 'Range 1 (0-9 months)',   from: 0 },
  { ordinal: 2, label: 'Range 2 (9-18 months)',  from: 9 },
  { ordinal: 3, label: 'Range 3 (18-24 months)', from: 18 },
  { ordinal: 4, label: 'Range 4 (24-36 months)', from: 24 },
  { ordinal: 5, label: 'Range 5 (36-48 months)', from: 36 },
  { ordinal: 6, label: 'Range 6 (48-71 months)', from: 48 },
];

/** "Range 3 (18-24 months)" → { pos: 3, from: 18 }; "Range 1 (Birth to 12 months)" → { pos:1, from:0 }. */
function parseRangeLabel(label) {
  const s = String(label || '');
  const m = /^\s*Range\s+(\d+)\s*\(([^)]*)\)/i.exec(s);
  if (!m) return null;
  const pos = Number(m[1]);
  const inner = m[2];
  if (/^\s*birth/i.test(inner)) return { pos, from: 0 };
  const nums = inner.match(/\d+/g);
  if (!nums || !nums.length) return null;
  return { pos, from: Number(nums[0]) };
}

/**
 * The tracker's bands for `framework`, as a partition. One row per POSITION
 * (b278's reasoning: Birth to 5 Matters genuinely merges 1-2 for three aspects,
 * so the distinct labels outnumber the positions and offering both would let
 * two options mean one band).
 */
async function ageBands(db, framework) {
  let rows = [];
  try {
    const r = await db.query(
      `SELECT DISTINCT age_range FROM framework_statements
        WHERE framework = $1 AND COALESCE(is_active, true) = true AND age_range IS NOT NULL`,
      [framework || 'birth_to_5_la']);
    rows = r.rows;
  } catch (_) { rows = []; }

  const byPos = new Map();
  for (const r of rows) {
    const p = parseRangeLabel(r.age_range);
    if (!p) continue;
    // Keep the FIRST label seen for a position; a merged "Range 1-2 (…)" never
    // parses here (the regex wants one number), so it cannot win.
    if (!byPos.has(p.pos)) byPos.set(p.pos, { ordinal: p.pos, label: r.age_range, from: p.from });
  }
  const bands = [...byPos.values()].sort((a, b) => a.ordinal - b.ordinal);
  if (bands.length < 2) return { bands: FALLBACK_BANDS.slice(), derived: false };
  return { bands, derived: true };
}

/** months → the band ordinal in `bands`, or null when the age is unknown. */
function bandOrdinalOf(bands, months) {
  if (months == null || !Number.isFinite(Number(months))) return null;
  const m = Number(months);
  let hit = null;
  for (const b of bands) if (m >= b.from) hit = b.ordinal;
  return hit == null ? (bands[0] ? bands[0].ordinal : null) : hit;
}

/** The [from, to) month window for one band ordinal. `to` is null for the last. */
function bandWindow(bands, ordinal) {
  const i = bands.findIndex(b => b.ordinal === Number(ordinal));
  if (i < 0) return null;
  return { from: bands[i].from, to: i + 1 < bands.length ? bands[i + 1].from : null };
}

// ── the date-range presets ───────────────────────────────────────────────────

const PRESETS = ['last30', 'half_term', 'term', 'last12m', 'custom'];

function addDays(ymd, n) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const p = x => String(x).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * Resolve a preset to { from, to, preset, label, source }.
 *
 * 'half_term' and 'term' prefer ladn.school_terms — Ealing's published teaching
 * half-terms, which is what Toby means by "this half term". When no row covers
 * today (dev's table is almost entirely future-dated, and prod has nothing
 * before Sept 2026) it falls back to lookback-terms' STATUTORY term and says so
 * in `source`, so the UI can label it honestly rather than returning nothing.
 */
async function resolveWindow(db, q) {
  const today = LT.todayYmd();
  const preset = PRESETS.includes(String(q.preset || '')) ? String(q.preset) : (q.from || q.to ? 'custom' : 'last12m');

  if (preset === 'custom') {
    const from = LT.isYmd(q.from) ? q.from : null;
    const to = LT.isYmd(q.to) ? q.to : null;
    return { preset, from, to, label: 'Custom range', source: 'custom' };
  }
  if (preset === 'last30')  return { preset, from: addDays(today, -29), to: today, label: 'Last 30 days', source: 'rolling' };
  if (preset === 'last12m') return { preset, from: addDays(today, -364), to: today, label: 'Last 12 months', source: 'rolling' };

  // half_term / term, from school_terms if today is inside one
  let row = null;
  try {
    const r = await db.query(
      `SELECT academic_year, term, half, name, start_date, end_date
         FROM school_terms WHERE $1::date BETWEEN start_date AND end_date
        ORDER BY start_date LIMIT 1`, [today]);
    row = r.rows[0] || null;
  } catch (_) { row = null; }

  if (row && preset === 'half_term') {
    return { preset, from: LT.ymd(row.start_date), to: LT.ymd(row.end_date),
      label: `${row.name} (${row.academic_year})`, source: 'school_terms' };
  }
  if (row && preset === 'term') {
    let span = null;
    try {
      const r2 = await db.query(
        `SELECT MIN(start_date) AS s, MAX(end_date) AS e FROM school_terms
          WHERE academic_year = $1 AND term = $2`, [row.academic_year, row.term]);
      span = r2.rows[0] || null;
    } catch (_) { span = null; }
    if (span && span.s) {
      return { preset, from: LT.ymd(span.s), to: LT.ymd(span.e),
        label: `${row.term} term (${row.academic_year})`, source: 'school_terms' };
    }
  }

  // Fallback: the statutory term (defined for every year, past or future).
  const t = LT.termOf(today);
  if (!t) return { preset, from: addDays(today, -364), to: today, label: 'Last 12 months', source: 'rolling' };
  if (preset === 'term') {
    return { preset, from: t.start, to: t.end,
      label: `${t.term} (statutory term, ${t.academic_year})`, source: 'statutory' };
  }
  // A statutory term split in two — the nearest honest thing to a half term
  // when no published half-term covers today.
  const mid = addDays(t.start, Math.floor((Date.parse(t.end) - Date.parse(t.start)) / 86400000 / 2));
  const firstHalf = today <= mid;
  return {
    preset, from: firstHalf ? t.start : addDays(mid, 1), to: firstHalf ? mid : t.end,
    label: `${t.term} ${firstHalf ? 'first' : 'second'} half (derived, ${t.academic_year})`,
    source: 'statutory',
  };
}

/** A human label for an obs_tags value. A bare number is an EyLog tag id. */
const WREN_TAG_LABELS = {
  planned_activity: 'Planned activity', tracking: 'Tracking',
  next_step_followup: 'Next-step follow-up', baseline: 'Baseline',
  termly_update: 'Termly update', parental: 'Parent observation',
  phonics_group: 'Phonics group',
};
function tagLabel(k) {
  const key = String(k == null ? '' : k);
  if (WREN_TAG_LABELS[key]) return WREN_TAG_LABELS[key];
  if (/^\d+$/.test(key)) return `EyLog tag ${key} (meaning not recorded)`;
  return key;
}

// ── the filter ───────────────────────────────────────────────────────────────

const TYPES = ['learning_story', 'planned_activity', 'milestone', 'note', '2year_check', 'assessment'];
const REVIEW_STATUSES = ['published', 'pending_review', 'returned'];
const FLAGS = ['baseline', 'termly_update', 'parental'];
const SORTS = {
  date_desc: 'f.created_at DESC, f.id DESC',
  date_asc:  'f.created_at ASC, f.id ASC',
  age_asc:   'f.age_months ASC NULLS LAST, f.created_at DESC',
  age_desc:  'f.age_months DESC NULLS LAST, f.created_at DESC',
};

const csvInts = v => String(v == null ? '' : v).split(',')
  .map(s => parseInt(s, 10)).filter(Number.isInteger);
const csvStrs = v => String(v == null ? '' : v).split(',')
  .map(s => s.trim()).filter(Boolean);
const bool01 = v => (v === '1' || v === 'true' ? true : (v === '0' || v === 'false' ? false : null));

/**
 * Parse a query string into the filter object every other function here takes.
 * Unknown values are DROPPED, never passed through — a typo narrows nothing
 * rather than reaching SQL.
 */
function parseFilters(q, bands) {
  const areaTokens = csvStrs(q.areas);
  const areaKeys = areaTokens.map(a => { const c = canonOf(a); return c ? c.key : null; }).filter(Boolean);
  return {
    /* FAIL CLOSED on an area filter that folds onto nothing. Dropping unknown
     * values is right for every other field (a typo narrows nothing, which is
     * harmless), but for `areas` it meant "I asked for Literacy and got all
     * 15,200 rows" — the comma bug above. The route turns this into a 400. */
    areas_unmatched: areaTokens.length > 0 && areaKeys.length === 0 ? areaTokens.length : 0,
    child_ids:      csvInts(q.child_ids),
    room_ids:       csvInts(q.room_ids),
    key_person_ids: csvInts(q.key_person_ids),
    staff_ids:      csvInts(q.staff_ids),
    author_names:   csvStrs(q.author_names),
    age_bands:      csvInts(q.age_bands).filter(o => bands.some(b => b.ordinal === o)),
    areas:          [...new Set(areaKeys)],
    other_area:     q.other_area === '1',
    no_area:        q.no_area === '1',
    statement_ids:  csvInts(q.statement_ids),
    coel:           csvStrs(q.coel),
    /* b536 — what obs_tags turned out to be. TWO populations in one text[] column:
     *   · Wren's own closed set (src/routes/observations.js VALID_OBS_TAGS):
     *     planned_activity / tracking / next_step_followup / baseline /
     *     termly_update / parental, plus phonics_group written by phonics.js.
     *   · EyLog's own observation_tags, imported VERBATIM as bare numeric ids by
     *     scripts/eylog-import/eylog_transform.py (`pg_text_array(ob.get(
     *     'observation_tags'))`). On prod: {9}×1708 {3}×263 {4}×139 {2}×135, all
     *     of them on rows with an eylog_ref. There is NO dictionary for those ids
     *     anywhere in Wren — src/lib/termly-sources.js reached the same conclusion
     *     in b277 and refused to guess, and so does this. They are offered as
     *     "EyLog tag N" so Toby can match a number he knows against a count.
     * They are NOT COEL: COEL lives in observation_statements.coel_characteristic
     * and has its own filter above. */
    tags:           csvStrs(q.tags),
    types:          csvStrs(q.types).filter(t => TYPES.includes(t)),
    flags:          csvStrs(q.flags).filter(f => FLAGS.includes(f)),
    shared:         bool01(q.shared),
    review_status:  csvStrs(q.review_status).filter(s => REVIEW_STATUSES.includes(s)),
    has_analysis:   bool01(q.has_analysis),
    has_next_steps: bool01(q.has_next_steps),
    has_photos:     bool01(q.has_photos),
    source:         ['wren', 'eylog'].includes(String(q.source)) ? String(q.source) : null,
    group_mode:     q.group_mode === 'per_group' ? 'per_group' : 'per_child',
    q:              String(q.q || '').trim().slice(0, 120),
    sort:           SORTS[q.sort] ? String(q.sort) : 'date_desc',
  };
}

/**
 * Build the WHERE fragments + bound parameters. Everything is a placeholder —
 * no caller value is ever interpolated into SQL text.
 *
 * @returns {{where:string[], params:any[]}}
 */
function buildWhere(filters, win, bands, includeDsl) {
  const where = [];
  const params = [];
  const P = v => { params.push(v); return '$' + params.length; };

  // dsl_only first: the one condition that is not the caller's to choose.
  if (!includeDsl) where.push(`COALESCE(o.dsl_only, false) = false`);

  if (win.from) where.push(`o.created_at >= ${P(win.from)}::date`);
  if (win.to)   where.push(`o.created_at < (${P(win.to)}::date + 1)`);

  if (filters.child_ids.length)      where.push(`o.child_id = ANY(${P(filters.child_ids)}::int[])`);
  if (filters.room_ids.length)       where.push(`c.room_id = ANY(${P(filters.room_ids)}::int[])`);
  if (filters.key_person_ids.length) where.push(`c.key_person_id = ANY(${P(filters.key_person_ids)}::int[])`);

  // Practitioner: a staff id OR, for an import with no staff row, the recorded
  // author_name. ORed together so "these three people" works across both.
  if (filters.staff_ids.length || filters.author_names.length) {
    const bits = [];
    if (filters.staff_ids.length)    bits.push(`o.staff_id = ANY(${P(filters.staff_ids)}::int[])`);
    if (filters.author_names.length) bits.push(`btrim(COALESCE(o.author_name,'')) = ANY(${P(filters.author_names)}::text[])`);
    where.push('(' + bits.join(' OR ') + ')');
  }

  // Areas. Three independent switches that OR together: the chosen canonical
  // areas, "something outside the seven", and "nothing tagged at all".
  const areaBits = [];
  if (filters.areas.length) {
    const spellings = [...new Set(filters.areas.flatMap(spellingsFor))];
    areaBits.push(`EXISTS (SELECT 1 FROM unnest(COALESCE(o.eyfs_areas, ARRAY[]::text[])) a
                            WHERE ${SQL_NORM_AREA('a')} = ANY(${P(spellings)}::text[]))`);
  }
  if (filters.other_area) {
    const known = [...new Set(ST.CANON_AREAS.flatMap(a => spellingsFor(a.key)))];
    areaBits.push(`EXISTS (SELECT 1 FROM unnest(COALESCE(o.eyfs_areas, ARRAY[]::text[])) a
                            WHERE ${SQL_NORM_AREA('a')} <> ALL(${P(known)}::text[]))`);
  }
  if (filters.no_area) areaBits.push(`COALESCE(array_length(o.eyfs_areas, 1), 0) = 0`);
  if (areaBits.length) where.push('(' + areaBits.join(' OR ') + ')');

  if (filters.statement_ids.length) {
    where.push(`EXISTS (SELECT 1 FROM observation_statements os
                         WHERE os.observation_id = o.id
                           AND os.statement_id = ANY(${P(filters.statement_ids)}::int[]))`);
  }
  if (filters.coel.length) {
    where.push(`EXISTS (SELECT 1 FROM observation_statements os
                         WHERE os.observation_id = o.id
                           AND os.coel_characteristic = ANY(${P(filters.coel)}::text[]))`);
  }

  if (filters.tags.length) where.push(`o.obs_tags && ${P(filters.tags)}::text[]`);

  if (filters.types.length) where.push(`COALESCE(o.observation_type,'learning_story') = ANY(${P(filters.types)}::text[])`);

  // Flags AND together: "baseline AND termly update" is a real question.
  for (const f of filters.flags) where.push(`COALESCE(o.${f}, false) = true`);

  if (filters.shared !== null) where.push(`COALESCE(o.shared_with_parents, false) = ${P(filters.shared)}`);
  if (filters.review_status.length) where.push(`o.review_status = ANY(${P(filters.review_status)}::text[])`);

  const filled = col => `COALESCE(btrim(regexp_replace(COALESCE(o.${col},''), '<[^>]*>', '', 'g')), '') <> ''`;
  if (filters.has_analysis   !== null) where.push(filters.has_analysis   ? filled('analysis')   : `NOT (${filled('analysis')})`);
  if (filters.has_next_steps !== null) where.push(filters.has_next_steps ? filled('next_steps') : `NOT (${filled('next_steps')})`);
  if (filters.has_photos     !== null) {
    where.push(filters.has_photos
      ? `COALESCE(array_length(o.photo_urls, 1), 0) > 0`
      : `COALESCE(array_length(o.photo_urls, 1), 0) = 0`);
  }

  if (filters.source === 'eylog') where.push(`o.eylog_ref IS NOT NULL`);
  if (filters.source === 'wren')  where.push(`o.eylog_ref IS NULL`);

  if (filters.age_bands.length) {
    const bits = filters.age_bands.map(ord => {
      const w = bandWindow(bands, ord);
      if (!w) return null;
      const lo = `_age_m >= ${P(w.from)}`;
      return w.to == null ? `(${lo})` : `(${lo} AND _age_m < ${P(w.to)})`;
    }).filter(Boolean);
    if (bits.length) where.push('(' + bits.join(' OR ') + ')');
  }

  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, m => '\\' + m)}%`;
    const p = P(like);
    where.push(`(o.observation_text ILIKE ${p} OR COALESCE(o.analysis,'') ILIKE ${p}
                 OR COALESCE(o.next_steps,'') ILIKE ${p} OR COALESCE(o.title,'') ILIKE ${p})`);
  }

  return { where, params };
}

/* Age in whole months on the date of the observation. Inlined as a macro
 * because the age-band filter needs it in the WHERE (where a SELECT alias is
 * not visible) as well as in the projection. */
const AGE_M_SQL = `CASE WHEN c.date_of_birth IS NULL THEN NULL ELSE
  (date_part('year',  age(o.created_at::date, c.date_of_birth)) * 12
 + date_part('month', age(o.created_at::date, c.date_of_birth)))::int END`;

/** The shared FROM + WHERE, with _age_m substituted. */
function baseFrom(where) {
  const sql = where.length ? where.join('\n       AND ').replace(/_age_m/g, `(${AGE_M_SQL})`) : 'TRUE';
  return `
    FROM observations o
    LEFT JOIN children c ON c.id = o.child_id
    LEFT JOIN staff   s ON s.id = o.staff_id
   WHERE ${sql}`;
}

/* The projection. `group_rank` and `group_size` are WINDOW functions, so they
 * are computed over the FILTERED set — collapsing a group observation to one
 * card must count the rows that matched, not every sibling row in the table. */
const PROJECT = `
  o.id, o.child_id, o.staff_id, o.created_at, o.observation_type, o.title,
  o.eyfs_areas, o.obs_tags, o.photo_urls, o.group_uuid,
  (o.eylog_ref IS NOT NULL) AS from_eylog,
  COALESCE(o.baseline,false)  AS baseline,
  COALESCE(o.termly_update,false) AS termly_update,
  COALESCE(o.parental,false)  AS parental,
  COALESCE(o.planned_activity,false) AS planned_activity,
  COALESCE(o.shared_with_parents,false) AS shared_with_parents,
  o.review_status,
  o.observation_text, o.analysis, o.next_steps,
  c.first_name AS child_first_name, c.last_name AS child_last_name,
  c.preferred_name AS child_preferred_name, c.room_id, c.key_person_id,
  ${AGE_M_SQL} AS age_months,
  COALESCE(NULLIF(btrim(s.first_name || ' ' || s.last_name), ''), o.author_name) AS author,
  COALESCE(array_length(o.photo_urls, 1), 0) AS photo_count,
  row_number() OVER (PARTITION BY COALESCE(o.group_uuid::text, 'o' || o.id) ORDER BY o.id) AS group_rank,
  count(*)     OVER (PARTITION BY COALESCE(o.group_uuid::text, 'o' || o.id)) AS group_size`;

/**
 * The rows for one page, plus the total.
 *
 * `group_mode: 'per_group'` returns ONE card per group observation (the lowest
 * id) with group_size set, which is what "individual vs group" means on screen.
 * The collapse happens after the filter, so a group whose other children did
 * not match is still shown once — with the size of the matching part.
 */
async function listRows(db, { filters, win, bands, includeDsl, limit, offset, noLimit }) {
  const { where, params } = buildWhere(filters, win, bands, includeDsl);
  const from = baseFrom(where);
  const collapse = filters.group_mode === 'per_group' ? 'WHERE f.group_rank = 1' : '';

  const totalSql = `
    WITH f AS (SELECT ${PROJECT} ${from})
    SELECT COUNT(*)::int AS n FROM f ${collapse}`;
  const { rows: tr } = await db.query(totalSql, params);
  const total = tr[0] ? tr[0].n : 0;

  const page = [...params];
  let tail = '';
  if (!noLimit) {
    page.push(limit); tail += ` LIMIT $${page.length}`;
    page.push(offset); tail += ` OFFSET $${page.length}`;
  } else {
    page.push(limit); tail += ` LIMIT $${page.length}`;   // the export cap still applies
  }
  const rowSql = `
    WITH f AS (SELECT ${PROJECT} ${from})
    SELECT f.* FROM f ${collapse} ORDER BY ${SORTS[filters.sort]}${tail}`;
  const { rows } = await db.query(rowSql, page);

  // Statements per observation, in one extra query rather than N.
  const ids = rows.map(r => r.id);
  const stmts = new Map();
  if (ids.length) {
    try {
      const { rows: sr } = await db.query(`
        SELECT os.observation_id, os.statement_id, os.framework, os.statement_code,
               os.coel_characteristic, os.coel_level, COALESCE(os.is_next_step,false) AS is_next_step,
               fs.area, fs.aspect, fs.age_range, fs.statement_text
          FROM observation_statements os
          LEFT JOIN framework_statements fs ON fs.id = os.statement_id
         WHERE os.observation_id = ANY($1::int[])
         ORDER BY os.observation_id, os.id`, [ids]);
      for (const r of sr) {
        if (!stmts.has(r.observation_id)) stmts.set(r.observation_id, []);
        stmts.get(r.observation_id).push(r);
      }
    } catch (_) { /* a setting without the table still gets its observations */ }
  }
  for (const r of rows) r.statements = stmts.get(r.id) || [];

  return { total, rows };
}

/**
 * Facet counts for the CURRENT filter, so the UI can show "Literacy (296)"
 * before the choice is made. Each facet is counted over the filter with that
 * facet's OWN clause removed — otherwise choosing Literacy would show
 * "Literacy (296), everything else (0)", which tells the user nothing.
 */
async function facets(db, { filters, win, bands, includeDsl }) {
  const run = async (dropped, sql) => {
    const f2 = Object.assign({}, filters, dropped);
    const { where, params } = buildWhere(f2, win, bands, includeDsl);
    const from = baseFrom(where);
    const collapse = filters.group_mode === 'per_group' ? 'WHERE f.group_rank = 1' : '';
    const { rows } = await db.query(sql.replace('{{FROM}}', from).replace('{{COLLAPSE}}', collapse), params);
    return rows;
  };

  const [areaRows, authorRows, typeRows, bandRows, flagRows, tagRows] = await Promise.all([
    run({ areas: [], other_area: false, no_area: false }, `
      WITH f AS (SELECT ${PROJECT} {{FROM}}), g AS (SELECT * FROM f {{COLLAPSE}})
      SELECT ${SQL_NORM_AREA('a')} AS k, COUNT(*)::int AS n
        FROM g, unnest(COALESCE(g.eyfs_areas, ARRAY[]::text[])) a GROUP BY 1`),
    run({ staff_ids: [], author_names: [] }, `
      WITH f AS (SELECT ${PROJECT} {{FROM}}), g AS (SELECT * FROM f {{COLLAPSE}})
      SELECT g.staff_id, g.author, COUNT(*)::int AS n FROM g GROUP BY 1, 2 ORDER BY 3 DESC`),
    run({ types: [] }, `
      WITH f AS (SELECT ${PROJECT} {{FROM}}), g AS (SELECT * FROM f {{COLLAPSE}})
      SELECT COALESCE(g.observation_type,'learning_story') AS k, COUNT(*)::int AS n FROM g GROUP BY 1`),
    run({ age_bands: [] }, `
      WITH f AS (SELECT ${PROJECT} {{FROM}}), g AS (SELECT * FROM f {{COLLAPSE}})
      SELECT g.age_months, COUNT(*)::int AS n FROM g GROUP BY 1`),
    run({ flags: [], has_analysis: null, has_next_steps: null, has_photos: null, shared: null, source: null }, `
      WITH f AS (SELECT ${PROJECT} {{FROM}}), g AS (SELECT * FROM f {{COLLAPSE}})
      SELECT COUNT(*) FILTER (WHERE g.baseline)::int        AS baseline,
             COUNT(*) FILTER (WHERE g.termly_update)::int   AS termly_update,
             COUNT(*) FILTER (WHERE g.parental)::int        AS parental,
             COUNT(*) FILTER (WHERE g.shared_with_parents)::int AS shared,
             COUNT(*) FILTER (WHERE g.photo_count > 0)::int AS has_photos,
             COUNT(*) FILTER (WHERE COALESCE(btrim(regexp_replace(COALESCE(g.analysis,''),'<[^>]*>','','g')),'') <> '')::int AS has_analysis,
             COUNT(*) FILTER (WHERE COALESCE(btrim(regexp_replace(COALESCE(g.next_steps,''),'<[^>]*>','','g')),'') <> '')::int AS has_next_steps,
             COUNT(*) FILTER (WHERE g.from_eylog)::int      AS from_eylog,
             COUNT(*) FILTER (WHERE NOT g.from_eylog)::int  AS from_wren,
             COUNT(*) FILTER (WHERE g.group_size > 1)::int  AS in_group,
             COUNT(*)::int                                  AS all_rows
        FROM g`),
    run({ tags: [] }, `
      WITH f AS (SELECT ${PROJECT} {{FROM}}), g AS (SELECT * FROM f {{COLLAPSE}})
      SELECT t AS k, COUNT(*)::int AS n
        FROM g, unnest(COALESCE(g.obs_tags, ARRAY[]::text[])) t GROUP BY 1 ORDER BY 2 DESC`),
  ]);

  // Fold the normalised area keys onto the seven, keeping the leftovers visible.
  const byCanon = new Map(ST.CANON_AREAS.map(a => [a.key, 0]));
  let other = 0;
  for (const r of areaRows) {
    const c = canonOf(r.k);
    if (c) byCanon.set(c.key, (byCanon.get(c.key) || 0) + r.n);
    else other += r.n;
  }
  const areas = areaList().map(a => Object.assign({}, a, { n: byCanon.get(a.key) || 0 }));

  const bandCounts = new Map(bands.map(b => [b.ordinal, 0]));
  let noAge = 0;
  for (const r of bandRows) {
    const o = bandOrdinalOf(bands, r.age_months);
    if (o == null) noAge += r.n; else bandCounts.set(o, (bandCounts.get(o) || 0) + r.n);
  }

  return {
    areas,
    area_other: other,
    authors: authorRows.map(r => ({ staff_id: r.staff_id, name: r.author || 'Not recorded', n: r.n })),
    types: typeRows.map(r => ({ key: r.k, n: r.n })),
    age_bands: bands.map(b => ({ ordinal: b.ordinal, label: b.label, from: b.from, n: bandCounts.get(b.ordinal) || 0 })),
    age_unknown: noAge,
    flags: flagRows[0] || {},
    tags: tagRows.map(r => ({ key: r.k, label: tagLabel(r.k), n: r.n })),
  };
}

/** The lists the filter bar's pickers need. Counts and labels only. */
async function options(db, framework) {
  const [kids, rooms, staff, authors, stmts, coel, tags] = await Promise.all([
    db.query(`SELECT c.id, btrim(c.first_name || ' ' || c.last_name) AS name,
                     c.room_id, c.key_person_id,
                     (c.status = 'active' AND COALESCE(c.is_active,true)
                      AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)) AS on_roll
                FROM children c ORDER BY c.first_name, c.last_name`).catch(() => ({ rows: [] })),
    db.query(`SELECT id, COALESCE(NULLIF(btrim(display_name),''), name) AS name
                FROM rooms ORDER BY COALESCE(min_age_months, 0), id`).catch(() => ({ rows: [] })),
    db.query(`SELECT id, btrim(first_name || ' ' || last_name) AS name, role,
                     COALESCE(is_active,true) AS is_active
                FROM staff WHERE COALESCE(is_demo,false) = false
               ORDER BY first_name, last_name`).catch(() => ({ rows: [] })),
    db.query(`SELECT btrim(author_name) AS name, COUNT(*)::int AS n
                FROM observations WHERE staff_id IS NULL AND btrim(COALESCE(author_name,'')) <> ''
               GROUP BY 1 ORDER BY 2 DESC LIMIT 60`).catch(() => ({ rows: [] })),
    db.query(`SELECT fs.id, fs.area, fs.aspect, fs.age_range, fs.statement_code,
                     left(fs.statement_text, 160) AS statement_text
                FROM framework_statements fs
               WHERE fs.framework = $1 AND COALESCE(fs.is_active,true) = true
                 AND fs.statement_text NOT LIKE '(stub%'
               ORDER BY fs.area, fs.ordinal NULLS LAST, fs.id`, [framework || 'birth_to_5_la'])
      .catch(() => ({ rows: [] })),
    db.query(`SELECT DISTINCT coel_characteristic AS k FROM observation_statements
               WHERE coel_characteristic IS NOT NULL ORDER BY 1`).catch(() => ({ rows: [] })),
    db.query(`SELECT t AS k, COUNT(*)::int AS n
                FROM observations, unnest(COALESCE(obs_tags, ARRAY[]::text[])) t
               GROUP BY 1 ORDER BY 2 DESC LIMIT 40`).catch(() => ({ rows: [] })),
  ]);
  return {
    children: kids.rows, rooms: rooms.rows, staff: staff.rows,
    import_authors: authors.rows, statements: stmts.rows,
    coel: coel.rows.map(r => r.k),
    tags: tags.rows.map(r => ({ key: r.k, label: tagLabel(r.k), n: r.n })),
    areas: areaList(),
    types: TYPES, review_statuses: REVIEW_STATUSES, flags: FLAGS, presets: PRESETS,
  };
}

/* The indexes this build wants. Every one is CREATE INDEX IF NOT EXISTS, so a
 * repeated run is a no-op, and they live HERE rather than in a migration file so
 * the DDL applied to wren_dev and the DDL written into the NOTES for prod cannot
 * drift apart. Nothing calls indexDdl() on boot — it is applied deliberately, by
 * scripts/b536-verify.js on dev and by hand on prod.
 *
 * The trigram index is built last and separately because pg_trgm does NOT live in
 * the same schema on both databases — `public` on prod, `ladn` on wren_dev — so a
 * bare `gin_trgm_ops` resolves on one and fails on the other. The opclass's own
 * namespace is read out of the catalogue instead of guessed.
 *
 * ⚠ A multi-statement psql -c "a; b; c" is ONE implicit transaction: the trgm
 * failure above rolled back the three indexes that had already said CREATE INDEX.
 * Apply these one statement per call. */
async function indexDdl(db) {
  const stmts = [
    `CREATE INDEX IF NOT EXISTS observations_created_at_idx ON ladn.observations (created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS observations_staff_created_idx ON ladn.observations (staff_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS observations_eyfs_areas_gin ON ladn.observations USING gin (eyfs_areas)`,
  ];
  try {
    const { rows } = await db.query(
      `SELECT n.nspname FROM pg_opclass o JOIN pg_namespace n ON n.oid = o.opcnamespace
        WHERE o.opcname = 'gin_trgm_ops' LIMIT 1`);
    if (rows[0] && rows[0].nspname) {
      stmts.push(`CREATE INDEX IF NOT EXISTS observations_text_trgm
                    ON ladn.observations USING gin (observation_text ${rows[0].nspname}.gin_trgm_ops)`);
    }
  } catch (_) { /* no pg_trgm: the ILIKE filter still works, just without the index */ }
  return stmts;
}

module.exports = {
  // areas
  normArea, canonOf, spellingsFor, SQL_NORM_AREA, EXTRA_AREA_ALIASES,
  tagLabel, WREN_TAG_LABELS,
  AREA_SLUGS, slugFor, areaList,
  CANON_AREAS: ST.CANON_AREAS,
  // age bands
  ageBands, bandOrdinalOf, bandWindow, parseRangeLabel, FALLBACK_BANDS,
  // window + filters
  resolveWindow, parseFilters, buildWhere, PRESETS, TYPES, FLAGS, REVIEW_STATUSES, SORTS,
  // queries
  listRows, facets, options, indexDdl,
};
