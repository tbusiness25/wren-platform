'use strict';
/**
 * plan-status.js — b290 (2026-09-08)
 *
 * One question, asked from six places: is this half-term's plan PUBLISHED, or
 * is the room team still working on it?
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 * A draft plan must not reach a parent. Not on the public website, not in a
 * newsletter, not in a termly update document, not through the parents portal.
 * Staff see drafts — that is the whole point of a draft — so this module is only
 * ever applied on the PARENT side of the line.
 *
 * ── Why it is a module and not four copies of `AND status = 'published'` ────
 * The column is added by migrations/2026-09-08-b290-plan-drafts.sql, which runs
 * on the `ladn` schema. The same router files are mounted on the demo editions
 * (demo_eyfs / demo_primary / demo_secondary), on wren-ht and on the two
 * prospect instances, whose schemas get migrations when somebody runs them. A
 * bare `AND status = 'published'` in public-curriculum.js would turn every one
 * of those pages into a 500 the moment this shipped.
 *
 * So: ask the catalogue once, cache the answer, and degrade to the pre-b290
 * behaviour on a schema that has not been migrated. That is the same shape as
 * the 42P01 handling in src/routes/paperwork.js — an un-migrated schema gets the
 * old behaviour, never an error page.
 *
 * ── Which way does it fail? ─────────────────────────────────────────────────
 * Column ABSENT  → no filter. The schema has no drafts because it has no draft
 *                  concept, so every row is as published as it ever was. This is
 *                  not a privacy hole: it is exactly what the page did yesterday.
 * Column PRESENT → filter. And note the filter is `status = 'published'`, not
 *                  `status <> 'draft'` — a value nobody has thought of yet
 *                  (say a future 'archived') stays off the parents' page rather
 *                  than falling through the gap.
 */

const CACHE_MS = 60 * 1000;
let _cache = new Map();          // schema → { at, present }

function schemaName() { return process.env.PG_SCHEMA || 'ladn'; }

/**
 * Does ladn.term_plans carry the b290 `status` column on THIS schema?
 * Cached for a minute; a DB error is cached as "absent" for one cycle rather
 * than hammering the catalogue on every request.
 */
async function hasStatusColumn(db) {
  const s = schemaName();
  const hit = _cache.get(s);
  if (hit && (Date.now() - hit.at) < CACHE_MS) return hit.present;
  let present = false;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'term_plans' AND column_name = 'status'`,
      [s]);
    present = rows.length > 0;
  } catch (e) {
    console.error('[plan-status] catalogue read failed:', e.message);
    present = false;
  }
  _cache.set(s, { at: Date.now(), present });
  return present;
}

/**
 * A SQL fragment to AND into a parent-facing WHERE clause, or '' on a schema
 * without the column. Takes NO user input, so it cannot carry an injection: the
 * only variable part is `alias`, which callers pass as a literal.
 *
 *   const gate = await publishedOnlySql(db, 'p');
 *   `SELECT … FROM term_plans p WHERE p.room_id = $1 ${gate}`
 *
 * @param {object} db     pg pool
 * @param {string} alias  table alias, or '' for an unaliased FROM term_plans
 */
async function publishedOnlySql(db, alias) {
  if (!await hasStatusColumn(db)) return '';
  const a = /^[a-z_][a-z0-9_]*$/i.test(String(alias || '')) ? `${alias}.` : '';
  return ` AND ${a}status = 'published'`;
}

/**
 * The same decision for a row already in hand.
 * A row from an un-migrated schema has no `status` key at all and stays visible;
 * a row that has one must say 'published'.
 */
function isPublishedRow(row) {
  if (!row) return false;
  if (!('status' in row) || row.status == null) return true;
  return String(row.status) === 'published';
}

/** True when the row is on a migrated schema AND is explicitly a draft. */
function isDraftRow(row) {
  return !!row && 'status' in row && String(row.status) === 'draft';
}

/** Test seam — the cache is per schema and per process, and tests switch schema. */
function _resetCache() { _cache = new Map(); }

module.exports = {
  hasStatusColumn, publishedOnlySql, isPublishedRow, isDraftRow,
  PUBLISHED: 'published', DRAFT: 'draft', _resetCache,
};
