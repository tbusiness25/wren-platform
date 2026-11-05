'use strict';
/**
 * b182 — Phonics ↔ framework linkage.
 *
 * Maps every Wren Phonics checkpoint (the 7 Phase-1 listening aspects, the six
 * phases, and each GPC in the content pack) onto the Literacy → Reading/Writing
 * sub-areas of whichever framework the setting has made ACTIVE
 * (settings.default_framework — written by the b180 Framework Builder).
 *
 * Deliberately conservative. Frameworks differ in shape:
 *   • fledge          Literacy exists, but has NO sub_area — it bands Literacy by age
 *                     in `aspect` ("Band 4 — Stretching wings"). We leave sub_area NULL.
 *   • b180 custom     Literacy → Comprehension / Word Reading / Writing in `sub_area`.
 * Where a strand genuinely has no counterpart we write the row with NULLs and
 * match_quality='unmatched' rather than inventing a mapping — an unmatched row is
 * a visible gap a practitioner can fix; a wrong row is a lie in the tracker.
 */

const fs = require('fs');
const path = require('path');

const CONTENT_DIR = path.join(__dirname, '../content/phonics');
const GPC_FILES = [
  'phase2-learning-gpc.json', 'phase3-learning-gpc.json', 'phase4-learning-gpc.json',
  'phase5-school-readiness-gpc.json', 'phase6-school-readiness-gpc.json',
];

function readJSON(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, rel), 'utf8')); }
  catch (e) { return null; }
}

// Wren's three phases (SPEC.md): Introduction=1, Learning=2-4, School Readiness=5-6.
function wrenPhaseOf(phase) {
  const n = Number(phase);
  if (n <= 1) return 'introduction';
  if (n <= 4) return 'learning';
  return 'school_readiness';
}

const PHASE_LABELS = {
  1: 'Introduction — the 7 listening aspects',
  2: 'Learning — Phase 2 GPCs (s a t p i n …)',
  3: 'Learning — Phase 3 digraphs and long vowels',
  4: 'Learning — Phase 4 adjacent consonants',
  5: 'School readiness — Phase 5 alternative spellings',
  6: 'School readiness — Phase 6 suffixes and prefixes',
};

/**
 * Every checkpoint we want a framework row for, strand-agnostic.
 * Each entry is expanded into a reading row and a writing row.
 */
function phonicsCheckpoints() {
  const out = [];

  // The 7 Phase-1 listening aspects — pre-letter, but they ARE the phonics start.
  for (const a of (readJSON('phase1-introduction.json') || [])) {
    out.push({ ref: `aspect:${a.code}`, kind: 'aspect', phase: 1, label: a.name || a.code });
  }

  // The six phases themselves — the coarse checkpoint a tracker actually shows.
  for (let p = 1; p <= 6; p++) {
    out.push({ ref: `phase:${p}`, kind: 'phase', phase: p, label: PHASE_LABELS[p] });
  }

  // Every GPC in the pack.
  for (const f of GPC_FILES) {
    for (const g of (readJSON(f) || [])) {
      if (!g || !g.grapheme) continue;
      out.push({
        ref: `gpc:${g.grapheme}`, kind: 'gpc', phase: Number(g.phase) || null,
        label: `${g.grapheme} ${g.ipa || ''}`.trim(),
      });
    }
  }
  return out;
}

// ── Framework shape discovery ────────────────────────────────────────────────

const LITERACY_AREA_RX = /litera/i;
// Fallback areas if a framework has no "Literacy" at all (some settings fold
// early reading into Communication & Language).
const FALLBACK_AREA_RX = /communication|language|english/i;

const READING_SUB_RX = /word reading|reading|decod|phonic/i;
const WRITING_SUB_RX = /writing|transcription|spell|handwrit/i;

// Statement text that genuinely IS about phonics — used to pin an exact statement_id.
const PHONICS_TEXT_RX =
  /phonic|grapheme|phoneme|blend|segment|sound out|initial sound|letter sound|rhyme|rhym|alliterat|sounds? in words|decod/i;
// Strict first — 'name' alone matches "recognises their own name", which is a
// READING statement; that mis-pinned phase:2:writing on fledge before this.
const WRITING_TEXT_RX = /\bwrit(e|es|ing|ten)\b|makes? marks|mark[- ]?making|letter[- ]like|\bspell/i;
const WRITING_TEXT_RX_LOOSE = /\bmarks?\b|form(s|ing)? letters|handwrit|pencil/i;

/**
 * Load one framework's structure: areas, sub_areas, ordered progression bands.
 * Bands may live in `age_range` (b180 wizard + most sets) — we read that column.
 */
async function loadFrameworkShape(db, framework) {
  const { rows } = await db.query(
    `SELECT id, area, sub_area, aspect, age_range, statement_text, ordinal
       FROM framework_statements
      WHERE framework = $1
      ORDER BY id`, [framework]);
  if (!rows.length) return null;

  // Progression bands, in first-appearance order (framework_statements is seeded
  // band-by-band, so id order IS progression order for every shipped set).
  const bands = [];
  for (const r of rows) {
    const b = r.age_range || null;
    if (b && !bands.includes(b)) bands.push(b);
  }

  const areas = [];
  for (const r of rows) if (r.area && !areas.includes(r.area)) areas.push(r.area);

  return { framework, rows, bands, areas };
}

/**
 * Which band does a phonics phase belong in?
 *   Phase 1 (listening, pre-school)  → second-to-last band
 *   Phase 2-4 (Reception decoding)   → last band
 *   Phase 5-6 (Y1/Y2)                → null — genuinely beyond an EY framework
 * With <2 bands we return null rather than force one.
 */
function bandForPhase(bands, phase) {
  if (!bands || bands.length < 2) return null;
  const n = Number(phase);
  if (n <= 1) return bands[bands.length - 2];
  if (n <= 4) return bands[bands.length - 1];
  return null;
}

/** Pick the Literacy area (or the honest fallback), else null. */
function pickArea(shape) {
  if (!shape) return null;
  return shape.areas.find(a => LITERACY_AREA_RX.test(a))
      || shape.areas.find(a => FALLBACK_AREA_RX.test(a))
      || null;
}

/** Sub-areas that exist inside `area` for this framework. */
function subAreasOf(shape, area) {
  const set = [];
  for (const r of shape.rows) {
    if (r.area !== area) continue;
    if (r.sub_area && !set.includes(r.sub_area)) set.push(r.sub_area);
  }
  return set;
}

/**
 * Best statement inside (area, sub_area, band) whose text really is about
 * phonics/writing. Returns { id } or null — null means "structure matched but
 * no specific statement", which we record as 'heuristic', not 'exact'.
 */
function pickStatement(shape, { area, sub_area, band, strand }) {
  const inScope = shape.rows.filter(r =>
    r.area === area &&
    (sub_area ? r.sub_area === sub_area : true) &&
    (band ? r.age_range === band : true));
  if (!inScope.length) return null;
  // Prefer a statement that names the phonics/writing behaviour explicitly.
  const tiers = strand === 'writing'
    ? [WRITING_TEXT_RX, WRITING_TEXT_RX_LOOSE]
    : [PHONICS_TEXT_RX];
  for (const rx of tiers) {
    const hit = inScope.find(r => rx.test(r.statement_text || ''));
    if (hit) return hit;
  }
  return null;
}

/**
 * Build (but do not write) every map row for one framework.
 */
async function buildMapRows(db, framework) {
  const shape = await loadFrameworkShape(db, framework);
  if (!shape) return [];

  const area = pickArea(shape);
  const subs = area ? subAreasOf(shape, area) : [];
  const readingSub = subs.find(s => READING_SUB_RX.test(s)) || null;
  const writingSub = subs.find(s => WRITING_SUB_RX.test(s)) || null;

  const rows = [];
  for (const cp of phonicsCheckpoints()) {
    const band = bandForPhase(shape.bands, cp.phase);
    for (const strand of ['reading', 'writing']) {
      const sub = strand === 'writing' ? writingSub : readingSub;
      // Phase-1 listening aspects have no writing counterpart at all — record the
      // row as unmatched rather than pretending oral blending is a writing skill.
      const strandApplies = !(cp.kind === 'aspect' && strand === 'writing');

      let a = null, s = null, b = null, stmt = null, quality = 'unmatched';
      if (area && strandApplies) {
        a = area;
        s = sub;                 // may legitimately be null (fledge has no sub_areas)
        b = band;                // null for phases 5-6: an EY framework stops at school entry
        // Only pin a statement when the phase actually lands in a band. Phases 5-6
        // are Y1/Y2 — pinning them to a Reception statement would read as an
        // assessed match in the tracker when the framework simply doesn't go there.
        stmt = b ? pickStatement(shape, { area: a, sub_area: s, band: b, strand }) : null;
        quality = stmt ? 'exact' : 'heuristic';
      }

      rows.push({
        phonics_ref: `${cp.ref}:${strand}`,
        phonics_kind: cp.kind,
        strand,
        phase: cp.phase,
        wren_phase: wrenPhaseOf(cp.phase),
        label: cp.label,
        framework,
        area: a,
        sub_area: s,
        age_range: b,
        statement_id: stmt ? stmt.id : null,
        match_quality: quality,
      });
    }
  }
  return rows;
}

/**
 * Upsert the map for the given frameworks (default: the active framework, plus
 * fledge, plus every custom framework the b180 builder has created).
 * Returns a per-framework summary.
 */
async function seedPhonicsFrameworkMap(db, opts = {}) {
  let frameworks = opts.frameworks;
  if (!frameworks || !frameworks.length) {
    frameworks = [];
    const active = await getActiveFramework(db);
    if (active) frameworks.push(active);
    // fledge-off (2026-10-26): Fledge is only mapped while the switch is on.
    if (!frameworks.includes('fledge') &&
        await require('./fledge-switch').isFledgeEnabled(db)) frameworks.push('fledge');
    // Every framework the b180 wizard built.
    try {
      const { rows } = await db.query(
        `SELECT framework FROM framework_meta WHERE is_custom = true`);
      for (const r of rows) if (!frameworks.includes(r.framework)) frameworks.push(r.framework);
    } catch (e) { /* framework_meta only exists once b180 has been applied */ }
  }

  const summary = [];
  for (const fw of frameworks) {
    const rows = await buildMapRows(db, fw);
    if (!rows.length) { summary.push({ framework: fw, rows: 0, note: 'no framework_statements' }); continue; }
    for (const r of rows) {
      await db.query(`
        INSERT INTO phonics_framework_map
          (phonics_ref, phonics_kind, strand, phase, wren_phase, label,
           framework, area, sub_area, age_range, statement_id, match_quality)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (framework, phonics_ref) DO UPDATE SET
          phonics_kind = EXCLUDED.phonics_kind, strand = EXCLUDED.strand,
          phase = EXCLUDED.phase, wren_phase = EXCLUDED.wren_phase, label = EXCLUDED.label,
          area = EXCLUDED.area, sub_area = EXCLUDED.sub_area, age_range = EXCLUDED.age_range,
          statement_id = EXCLUDED.statement_id, match_quality = EXCLUDED.match_quality,
          updated_at = now()
      `, [r.phonics_ref, r.phonics_kind, r.strand, r.phase, r.wren_phase, r.label,
          r.framework, r.area, r.sub_area, r.age_range, r.statement_id, r.match_quality]);
    }
    const counts = rows.reduce((m, r) => { m[r.match_quality] = (m[r.match_quality] || 0) + 1; return m; }, {});
    summary.push({ framework: fw, rows: rows.length, ...counts });
  }
  return summary;
}

/** settings.default_framework — what b180 writes when a setting adopts its own curriculum. */
async function getActiveFramework(db) {
  try {
    const { rows } = await db.query(
      `SELECT value FROM settings WHERE key = 'default_framework' LIMIT 1`);
    // fledge-off (2026-10-26): was `|| 'fledge'`. The switch now decides — no row, or a
    // row still saying 'fledge' while Fledge is off, both read as Birth to 5 Matters.
    void rows;
    return await require('./fledge-switch').effectiveDefaultFramework(db);
  } catch (e) { return require('./fledge-switch').OFF_FALLBACK; }
}

module.exports = {
  seedPhonicsFrameworkMap, getActiveFramework, buildMapRows,
  phonicsCheckpoints, wrenPhaseOf, bandForPhase,
};
