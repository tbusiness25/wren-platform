'use strict';
/* fledge-off (2026-10-26) — THE one switch for Fledge.
 *
 * Toby, 26 Oct 2026: "we're not launching [Fledge] yet, so don't mention it, turn
 * it off and everything's Birth to 5 and they're allowed to tag the statements."
 *
 * The switch is one ladn.settings row:
 *     key = 'fledge_enabled', value = 'true'   → Fledge is on (as before this build)
 *     absent, or any other value               → Fledge is OFF (the default)
 *
 * Every server path that knows about Fledge asks THIS file — nothing else reads the
 * row — and the browser learns it from `fledge_enabled` on GET /api/features/public
 * (staff portals, read by public/js/wren-fledge.js) and GET /api/parents/settings
 * (the parents app).
 *
 * Off means: no Fledge page, nav item, card or wording is shown; every fallback that
 * used to land on 'fledge' lands on Birth to 5 Matters (birth_to_5_la) instead; and
 * no NEW statement link to a Fledge statement is written. Nothing is deleted — rows
 * tagged against Fledge before today stay as history, and setting the row to 'true'
 * brings every surface back unchanged.
 *
 * Short-cached (30 s) like the other per-request settings reads. One schema per
 * process (src/db/pool.js), so one cache entry is enough.
 */
const FLEDGE = 'fledge';
const OFF_FALLBACK = 'birth_to_5_la';   // Birth to 5 Matters — what LADN works to
const TTL_MS = 30 * 1000;

let _cache = { at: 0, on: false };

function _parse(v) {
  return /^(true|1|on|yes)$/i.test(String(v == null ? '' : v).trim());
}

function _pool(db) {
  if (db && typeof db.query === 'function') return db;
  return require('../db/pool').getPool();
}

/** true only when ladn.settings.fledge_enabled says so. Never throws (fails OFF). */
async function isFledgeEnabled(db) {
  const now = Date.now();
  if (now - _cache.at < TTL_MS) return _cache.on;
  let on = false;
  try {
    const { rows } = await _pool(db).query(
      `SELECT value FROM settings WHERE key = 'fledge_enabled' LIMIT 1`);
    on = !!(rows[0] && _parse(rows[0].value));
  } catch (_) { on = false; }
  _cache = { at: now, on };
  return on;
}

/** Forget the cached value (after a settings write, and in tests). */
function clearFledgeCache() { _cache = { at: 0, on: false }; }

/** Is this framework key (internal 'fledge' or the drawer's 'Fledge') Fledge? */
function isFledgeKey(fw) { return String(fw || '').trim().toLowerCase() === FLEDGE; }

/**
 * The framework to use when a caller has no setting row to go on — the value every
 * `|| 'fledge'` fallback used to hard-code. With the switch on that stays 'fledge'
 * (unchanged behaviour); with it off it is Birth to 5 Matters.
 */
async function fallbackFramework(db) {
  return (await isFledgeEnabled(db)) ? FLEDGE : OFF_FALLBACK;
}

/**
 * settings.default_framework, honouring the switch: a missing row falls back as
 * above, and a row that still says 'fledge' while the switch is off is read as
 * Birth to 5 Matters (the row itself is not rewritten).
 */
async function effectiveDefaultFramework(db) {
  const on = await isFledgeEnabled(db);
  let v = null;
  try {
    const { rows } = await _pool(db).query(
      `SELECT value FROM settings WHERE key = 'default_framework' LIMIT 1`);
    v = (rows[0] && rows[0].value) || null;
  } catch (_) { v = null; }
  if (!v) return on ? FLEDGE : OFF_FALLBACK;
  if (!on && isFledgeKey(v)) return OFF_FALLBACK;
  return v;
}

/** Drop Fledge from a list of framework keys (or {framework} objects) when off. */
async function withoutFledge(db, list) {
  if (!Array.isArray(list)) return list;
  if (await isFledgeEnabled(db)) return list;
  return list.filter(k => !isFledgeKey(k && typeof k === 'object' ? k.framework : k));
}

/**
 * framework_statements ids → the same list without Fledge statements, when the
 * switch is off. The write-side guard: every path that creates a statement link
 * (observation save, tracker link, confirmed/AI statement links, learning games)
 * passes its ids through here, so no NEW Fledge-tagged row is written while Fledge
 * is off. If the check itself fails the ids are kept — never lose a practitioner's
 * tag over a lookup error.
 */
async function dropFledgeStatementIds(db, ids) {
  if (!Array.isArray(ids) || !ids.length) return ids;
  if (await isFledgeEnabled(db)) return ids;
  const nums = [...new Set(ids.map(Number).filter(Number.isFinite))];
  if (!nums.length) return ids;
  try {
    const { rows } = await _pool(db).query(
      `SELECT id FROM framework_statements WHERE id = ANY($1::int[]) AND framework = $2`,
      [nums, FLEDGE]);
    if (!rows.length) return ids;
    const bad = new Set(rows.map(r => Number(r.id)));
    return ids.filter(i => !bad.has(Number(i)));
  } catch (_) { return ids; }
}

module.exports = {
  FLEDGE, OFF_FALLBACK,
  isFledgeEnabled, clearFledgeCache, isFledgeKey,
  fallbackFramework, effectiveDefaultFramework, withoutFledge, dropFledgeStatementIds,
};
