'use strict';
/**
 * termly-sources.js — b277 (2026-09-04)
 *
 * "The staff member has done the termly update" — WHERE that fact comes from.
 *
 * ── WHY THIS IS ITS OWN FILE ────────────────────────────────────────────────
 * Toby, 2026-09-04: "as we are still using Eylog … Next term we will be on wren,
 * so staff get reminders … and wont be on eylog anyway."
 *
 * So the EyLog dependency has a known end date, and the build has to survive it
 * without being rewritten. Everything downstream of this file — the watcher, the
 * document, the tracker, the reminders — takes a COMPLETION SIGNAL and never asks
 * where it came from. Switching to Wren-native is one settings row:
 *
 *     UPDATE ladn.settings SET value='wren' WHERE key='termly_watcher_sources';
 *
 * A third source (a CSV, a different MIS, an API) is a new entry in SOURCES and
 * nothing else. That is the "one swappable input, not baked through" the brief
 * asked for, and it is checked by scripts/b277-verify.js, which runs the whole
 * pipeline with the eylog source switched off.
 *
 * ── NOTHING HERE SCRAPES EYLOG ──────────────────────────────────────────────
 * The brief is explicit: "from Wren's own tables, NOT by scraping EyLog live".
 * Both sources read ladn.observations. EyLog's rows are already there — pulled
 * nightly by /app/eylog-sync.sh into observations.eylog_ref. This module
 * makes no network call of any kind and has no EyLog credentials.
 *
 * ── ⚠ WHAT EYLOG ACTUALLY GIVES US (measured on prod, 2026-09-04) ───────────
 * This matters more than any code in the file, so it is written down here and
 * not only in the notes:
 *
 *     13,866 EyLog observations in ladn.observations
 *          0 have a title                     ← titles are not imported at all
 *     13,866 have observation_type='learning_story'   ← the type never varies
 *          0 have termly_update = true        ← nothing sets the flag
 *     obs_tags are bare numeric ids: {9}×1423 {3}×198 {2}×128 {4}×63 …
 *              with no dictionary anywhere in Wren, and tag 9 appears 20–230
 *              times EVERY month, so it is not a termly marker.
 *         26 have 'termly update' in observation_text
 *
 * There is therefore NO field coming out of EyLog today that reliably says "this
 * is a termly update". Rather than invent one, the EyLog matcher is configured
 * rather than guessed:
 *
 *   1. termly_update = true            — always counts, whoever set it
 *   2. obs_tags && termly_watcher_eylog_tags  — OFF until Toby fills in the id
 *   3. observation_text ~* termly_watcher_eylog_text_re  — the 26-row fallback
 *
 * `previewSources()` exists so rule 2 can be filled in from evidence: it returns
 * per-tag counts for a cycle so Toby can match a number he knows ("we did 34
 * updates last term") against a tag id, without anybody guessing in code.
 */

const TC = require('./termly-cycle');

// The settings this module reads. Duplicated as defaults so a schema where the
// b277 migration has not run yet still behaves — the Wren-native source works
// out of the box, which is the one that matters after this term.
const DEFAULTS = {
  enabled: true,
  sources: ['wren', 'eylog'],
  eylog_tags: [],
  eylog_text_re: 'termly[[:space:]]+update',
};

const SETTING_KEYS = {
  enabled:       'termly_watcher_enabled',
  sources:       'termly_watcher_sources',
  eylog_tags:    'termly_watcher_eylog_tags',
  eylog_text_re: 'termly_watcher_eylog_text_re',
};

const SOURCE_IDS = ['wren', 'eylog'];

const csv = v => String(v == null ? '' : v).split(',').map(s => s.trim()).filter(Boolean);

async function loadSourceConfig(db) {
  const cfg = {
    enabled: DEFAULTS.enabled,
    sources: DEFAULTS.sources.slice(),
    eylog_tags: DEFAULTS.eylog_tags.slice(),
    eylog_text_re: DEFAULTS.eylog_text_re,
  };
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
      [Object.values(SETTING_KEYS)]);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));

    if (m[SETTING_KEYS.enabled] != null) {
      cfg.enabled = !/^(off|false|0|no)$/i.test(String(m[SETTING_KEYS.enabled]).trim());
    }
    if (m[SETTING_KEYS.sources] != null) {
      // An unknown id is dropped rather than throwing: a typo in a settings row
      // must not take the watcher down, it must narrow it — and describeSources()
      // reports what was dropped so the typo is visible on the status endpoint.
      const wanted = csv(m[SETTING_KEYS.sources]).map(s => s.toLowerCase());
      cfg.sources = wanted.filter(s => SOURCE_IDS.includes(s));
      cfg.unknown_sources = wanted.filter(s => !SOURCE_IDS.includes(s));
    }
    if (m[SETTING_KEYS.eylog_tags] != null) cfg.eylog_tags = csv(m[SETTING_KEYS.eylog_tags]);
    if (m[SETTING_KEYS.eylog_text_re] != null) cfg.eylog_text_re = String(m[SETTING_KEYS.eylog_text_re]).trim();
  } catch (_) { /* no settings table — the defaults above are the shipped behaviour */ }
  return cfg;
}

/**
 * Human-readable account of what is switched on. Feeds GET /status, so a
 * misconfiguration is visible on a screen rather than only in a log line.
 */
function describeSources(cfg) {
  const out = [];
  for (const id of SOURCE_IDS) {
    const on = cfg.sources.includes(id);
    if (id === 'wren') {
      out.push({
        id, enabled: on,
        label: 'Wren — the "Progress Update & Tracking" box on an observation',
        detail: on
          ? 'A practitioner ticking the box on an observation in Wren completes that child\'s update.'
          : 'Switched off. Ticking the box in Wren will not publish anything.',
        matchers: ['observations.termly_update = true'],
      });
    } else {
      const matchers = ['observations.termly_update = true (whoever set it)'];
      if (cfg.eylog_tags.length) matchers.push(`obs_tags overlaps {${cfg.eylog_tags.join(',')}}`);
      if (cfg.eylog_text_re) matchers.push(`observation_text ~* '${cfg.eylog_text_re}'`);
      out.push({
        id, enabled: on,
        label: 'EyLog — observations imported by the nightly sync',
        detail: on
          ? (cfg.eylog_tags.length
              ? 'Matching on the EyLog tag ids configured in Settings.'
              : 'No EyLog tag id is configured, so only the text fallback is matching. '
                + 'Use the tag preview to find the right id — see logs/b277.NOTES.md.')
          : 'Switched off. This is the setting to use once the setting has left EyLog.',
        matchers,
        needs_attention: on && !cfg.eylog_tags.length,
      });
    }
  }
  if (cfg.unknown_sources && cfg.unknown_sources.length) {
    out.push({ id: null, enabled: false, label: 'Unrecognised source in settings',
      detail: `termly_watcher_sources names ${cfg.unknown_sources.join(', ')}, which is not a source Wren has. It has been ignored.`,
      matchers: [], needs_attention: true });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// The SQL each source contributes
// ═══════════════════════════════════════════════════════════════════════════
/**
 * A source is a predicate over ladn.observations plus a label for WHY a row
 * matched. Params are appended to a shared array so the two can be OR'd into one
 * query — the sweep runs hourly and one query beats two.
 *
 * `matched_by` is carried all the way onto the report row. When somebody asks in
 * six months why a document exists, the answer is on the document.
 */
function sourceClause(id, cfg, params) {
  if (id === 'wren') {
    // Wren-native: the flag, set by a person in Wren, on a row that did not come
    // from EyLog. Explicitly excluding eylog_ref keeps the two sources disjoint
    // so a row can never be counted twice or attributed to the wrong one.
    return { sql: `(o.eylog_ref IS NULL AND o.termly_update = true)`, matched: `'wren:flag'` };
  }
  if (id === 'eylog') {
    const parts = [];
    const labels = [];
    parts.push(`o.termly_update = true`);
    labels.push(`WHEN o.termly_update = true THEN 'eylog:flag'`);

    if (cfg.eylog_tags.length) {
      params.push(cfg.eylog_tags);
      const p = `$${params.length}`;
      parts.push(`o.obs_tags && ${p}::text[]`);
      labels.push(`WHEN o.obs_tags && ${p}::text[] THEN 'eylog:tag'`);
    }
    if (cfg.eylog_text_re) {
      params.push(cfg.eylog_text_re);
      const p = `$${params.length}`;
      // ~* is POSIX case-insensitive. A malformed regex in a settings row raises
      // 2201B at query time; the watcher catches it and reports the setting by
      // name rather than dying with "invalid regular expression".
      parts.push(`o.observation_text ~* ${p}`);
      labels.push(`WHEN o.observation_text ~* ${p} THEN 'eylog:text'`);
    }
    return {
      sql: `(o.eylog_ref IS NOT NULL AND (${parts.join(' OR ')}))`,
      matched: `CASE ${labels.join(' ')} ELSE 'eylog:unknown' END`,
    };
  }
  return null;
}

/**
 * Every completion signal inside one cycle.
 *
 * A "completion" is one observation. A child with two flagged observations in a
 * half-term has completed once — the EARLIEST is the completion, because that is
 * when the key person did the work and it is what the on-time maths has to be
 * measured against. Taking the latest would let a correction typed in week six
 * turn an on-time update into a late one.
 *
 * @param {object} db     pg pool (search_path already ladn)
 * @param {object} cycle  from src/lib/termly-cycle.js
 * @param {object} opts   { config, childIds, on, limit }
 * @returns {Promise<Array>} [{ child_id, staff_id, observation_id, source,
 *                              matched_by, completed_on, completed_at }]
 */
async function detectCompletions(db, cycle, opts = {}) {
  if (!cycle) return [];
  const cfg = opts.config || await loadSourceConfig(db);
  const active = cfg.sources.filter(s => SOURCE_IDS.includes(s));
  if (!active.length) return [];

  // The window is the half-term itself. An update written during the break that
  // follows still belongs to the cycle it was written FOR, so the window runs to
  // the day the NEXT cycle opens rather than to the last teaching day — which is
  // the same rule currentCycle() uses to decide which cycle is live.
  const from = cycle.opens_on;
  const to = opts.window_to || TC.ymd(new Date());
  const params = [from, to];

  const clauses = [];
  const cases = [];
  for (const id of active) {
    const c = sourceClause(id, cfg, params);
    if (!c) continue;
    clauses.push(c.sql);
    cases.push({ id, sql: c.sql, matched: c.matched });
  }
  if (!clauses.length) return [];

  let childFilter = '';
  if (Array.isArray(opts.childIds) && opts.childIds.length) {
    params.push(opts.childIds.map(Number).filter(Number.isFinite));
    childFilter = ` AND o.child_id = ANY($${params.length}::int[])`;
  }

  const sourceCase = cases.map(c => `WHEN ${c.sql} THEN '${c.id}'`).join(' ');
  const matchedCase = cases.map(c => `WHEN ${c.sql} THEN ${c.matched}`).join(' ');

  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 500, 1), 2000);

  const { rows } = await db.query(`
    SELECT DISTINCT ON (o.child_id)
           o.child_id,
           o.id           AS observation_id,
           o.staff_id,
           o.eylog_ref,
           to_char(o.created_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS completed_on,
           o.created_at                             AS completed_at,
           CASE ${sourceCase} ELSE 'unknown' END    AS source,
           CASE ${matchedCase} ELSE 'unknown' END   AS matched_by
      FROM observations o
     -- weeklybugs-20261031 (staff-app:16): o.created_at is timestamptz; a bare ::date compares
     -- it in the SESSION timezone (UTC), not Europe/London. During BST that silently drops an
     -- update logged in the first hour of a London day (e.g. 00:30 BST = 23:30 UTC the day
     -- before) outside the cycle's open date, so it never counts as "done" and the child shows
     -- overdue despite being current. Same fix as child-day-gate.js's revealedTodayClause.
     WHERE (o.created_at AT TIME ZONE 'Europe/London') >= $1::date
       AND (o.created_at AT TIME ZONE 'Europe/London') <  ($2::date + 1)
       AND COALESCE(o.review_status, 'published') = 'published'
       AND COALESCE(o.dsl_only, false) = false
       AND o.child_id IS NOT NULL
       AND (${clauses.join(' OR ')})${childFilter}
     ORDER BY o.child_id, o.created_at ASC, o.id ASC
     LIMIT ${limit}`, params);

  return rows.map(r => ({
    child_id: r.child_id,
    observation_id: r.observation_id,
    staff_id: r.staff_id || null,
    source: r.source,
    source_ref: r.eylog_ref || `obs:${r.observation_id}`,
    matched_by: r.matched_by,
    completed_on: r.completed_on,
    completed_at: r.completed_at,
    cycle_key: cycle.key,
  }));
}

/**
 * One child, one cycle — the hook path. Same rules as the sweep, so a document
 * created by the tick-the-box hook is identical to one the sweep would have
 * created an hour later.
 */
async function detectForChild(db, cycle, childId, opts = {}) {
  const list = await detectCompletions(db, cycle, Object.assign({}, opts, { childIds: [childId], limit: 1 }));
  return list[0] || null;
}

/**
 * ⚠ THE TOOL THAT CLOSES THE EYLOG GAP.
 *
 * "Which EyLog tag id means termly update?" cannot be answered from Wren's data
 * — the ids arrive without a dictionary. It CAN be answered by counting: a tag
 * used ~once per child per half-term is a termly update; tag 9, used 20–230
 * times a month, is not.
 *
 * Returns per-tag counts inside the cycle alongside the number of DISTINCT
 * children each tag touched, so Toby can compare against a roll he knows. No
 * observation text, no names, no ids of children — counts only.
 */
async function previewSources(db, cycle, opts = {}) {
  if (!cycle) return { cycle: null, tags: [], text_matches: null, flagged: null };
  const cfg = opts.config || await loadSourceConfig(db);
  const to = opts.window_to || TC.ymd(new Date());

  const { rows: tagRows } = await db.query(`
    SELECT t.tag,
           count(*)                       AS observations,
           count(DISTINCT o.child_id)     AS children,
           count(DISTINCT o.staff_id)     AS staff
      FROM observations o
      CROSS JOIN LATERAL unnest(COALESCE(o.obs_tags, ARRAY[]::text[])) AS t(tag)
     WHERE o.eylog_ref IS NOT NULL
       AND o.created_at >= $1::date AND o.created_at < ($2::date + 1)
     GROUP BY t.tag
     ORDER BY count(DISTINCT o.child_id) DESC, count(*) DESC
     LIMIT 40`, [cycle.opens_on, to]);

  // How many children are OWED an update this cycle — the number a real termly
  // tag's "children" count should be close to.
  const { rows: owedRows } = await db.query(
    `SELECT count(*) AS n FROM children WHERE is_active = true`);

  let textMatches = null;
  if (cfg.eylog_text_re) {
    try {
      const { rows } = await db.query(`
        SELECT count(*) AS observations, count(DISTINCT child_id) AS children
          FROM observations
         WHERE eylog_ref IS NOT NULL
           AND created_at >= $1::date AND created_at < ($2::date + 1)
           AND observation_text ~* $3`, [cycle.opens_on, to, cfg.eylog_text_re]);
      textMatches = { pattern: cfg.eylog_text_re, ...rows[0] };
    } catch (e) {
      textMatches = { pattern: cfg.eylog_text_re, error: `That regular expression is not valid (${e.code || e.message}). Fix settings.termly_watcher_eylog_text_re.` };
    }
  }

  const { rows: flagRows } = await db.query(`
    SELECT count(*) FILTER (WHERE eylog_ref IS NOT NULL)  AS eylog,
           count(*) FILTER (WHERE eylog_ref IS NULL)      AS wren
      FROM observations
     WHERE termly_update = true
       AND created_at >= $1::date AND created_at < ($2::date + 1)`, [cycle.opens_on, to]);

  return {
    cycle: { key: cycle.key, label: cycle.label, from: cycle.opens_on, to },
    active_children: Number(owedRows[0] ? owedRows[0].n : 0),
    tags: tagRows.map(r => ({
      tag: r.tag,
      observations: Number(r.observations),
      children: Number(r.children),
      staff: Number(r.staff),
      configured: cfg.eylog_tags.includes(String(r.tag)),
    })),
    text_matches: textMatches,
    flagged: { eylog: Number(flagRows[0].eylog), wren: Number(flagRows[0].wren) },
    how_to_read: 'A termly-update tag touches roughly one observation per child per half-term: '
      + 'its "children" count should be close to the number of active children and its '
      + '"observations" count close to the same. A tag with far more observations than '
      + 'children is a general tag, not this one.',
  };
}

module.exports = {
  SOURCE_IDS, SETTING_KEYS, DEFAULTS,
  loadSourceConfig, describeSources,
  detectCompletions, detectForChild, previewSources,
};
