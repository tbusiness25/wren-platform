'use strict';
/**
 * shift-types.js — b192 (2026-08-18): Day / AM / PM shift patterns.
 *
 * Toby sets working-time patterns by hand with a three-way selector. The chosen
 * type is stored in `rota_shifts.label` (no new "type" column — label was NULL on
 * every one of the 300 live shifts, so it is free to carry this meaning).
 *
 *   Day  — a full day        (default 08:00–18:00, 60m break)
 *   AM   — a morning half    (default 08:00–14:00, 30m break)
 *   PM   — an afternoon half (default 12:00–18:00, 30m break)
 *   Custom — anything else; times are whatever the manager typed.
 *
 * THE ONE RULE THAT MATTERS DOWNSTREAM:
 *   An AM and a PM on the SAME DATE for the SAME staff member is ONE day worked,
 *   not two. Every day-count therefore has to be COUNT(DISTINCT shift_date) —
 *   never COUNT(*) over rota_shifts. See `daysWorked()` below and the SQL comment
 *   block in scripts/migrations/2026-08-18-b192-rota-shift-types.sql.
 *
 * Defaults are settings-driven (ladn.settings key `shift_type_defaults`, JSON) so
 * they can be changed without a deploy.
 */

const SHIFT_TYPES = ['Day', 'AM', 'PM', 'Custom'];

// Shipped fallbacks — used when settings has no `shift_type_defaults` row, and as
// the base that a partial settings blob is merged over.
const DEFAULT_SHIFT_TYPE_DEFAULTS = Object.freeze({
  Day: { start: '08:00', end: '18:00', break_mins: 60 },
  AM:  { start: '08:00', end: '14:00', break_mins: 30 },
  PM:  { start: '12:00', end: '18:00', break_mins: 30 },
});

const SETTINGS_KEY = 'shift_type_defaults';

function hhmm(t) {
  if (t == null || t === '') return null;
  return String(t).substring(0, 5);
}

/** Deep-ish merge of a stored blob over the shipped defaults; unknown keys ignored. */
function mergeDefaults(stored) {
  const out = {};
  for (const type of ['Day', 'AM', 'PM']) {
    const base = DEFAULT_SHIFT_TYPE_DEFAULTS[type];
    const over = (stored && typeof stored === 'object' && stored[type]) || {};
    out[type] = {
      start: hhmm(over.start) || base.start,
      end: hhmm(over.end) || base.end,
      break_mins: Number.isFinite(parseInt(over.break_mins, 10)) ? parseInt(over.break_mins, 10) : base.break_mins,
    };
  }
  return out;
}

/** Read the settings-driven defaults. Never throws — falls back to the shipped set. */
async function getShiftTypeDefaults(db) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [SETTINGS_KEY]);
    if (rows.length && rows[0].value) return mergeDefaults(JSON.parse(rows[0].value));
  } catch (e) { /* fall through — defaults are always usable */ }
  return mergeDefaults(null);
}

/** Persist defaults (manager action). Returns the merged, stored object. */
async function saveShiftTypeDefaults(db, incoming, staffId) {
  const merged = mergeDefaults(incoming);
  await db.query(
    `INSERT INTO settings (key, value, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value,
       updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [SETTINGS_KEY, JSON.stringify(merged), staffId || null]
  );
  return merged;
}

/**
 * Which of the three named patterns do these times match? Exact start+end match
 * only — break_mins is deliberately NOT part of the test, because break_mins is
 * inconsistent in the live data (12:00–18:00 exists with both 30 and 60). Break
 * disagreements are reported as warnings instead, never auto-corrected.
 */
function classifyShift(start, end, defaults) {
  const d = defaults || DEFAULT_SHIFT_TYPE_DEFAULTS;
  const s = hhmm(start), e = hhmm(end);
  if (!s || !e) return 'Custom';
  for (const type of ['Day', 'AM', 'PM']) {
    if (d[type] && hhmm(d[type].start) === s && hhmm(d[type].end) === e) return type;
  }
  return 'Custom';
}

/**
 * Slot key used for uniqueness and for "is this the same half of the day?" checks.
 * MUST stay in lockstep with the generated column rota_shifts.shift_slot:
 *   CASE WHEN label IN ('AM','PM') THEN label ELSE 'FULL' END
 */
function slotOf(label) {
  return (label === 'AM' || label === 'PM') ? label : 'FULL';
}

/** SQL expression for the same thing, for queries that predate the generated column. */
const SLOT_SQL = `(CASE WHEN %s.label IN ('AM','PM') THEN %s.label ELSE 'FULL' END)`;
function slotSql(alias) {
  const a = alias || 'rota_shifts';
  return SLOT_SQL.replace(/%s/g, a);
}

/** Normalise whatever the client sent into something safe to store in `label`. */
function normaliseLabel(label) {
  if (label == null) return null;
  const raw = String(label).trim();
  if (!raw) return null;
  const match = SHIFT_TYPES.find(t => t.toLowerCase() === raw.toLowerCase());
  return match || raw;   // free-text labels ("Early", "Cover") are still allowed → slot FULL
}

/**
 * Days worked, applying the AM+PM rule: count DISTINCT dates, not shift rows.
 * `shifts` is any array of objects with a shift_date (Date or ISO string).
 */
function daysWorked(shifts) {
  const dates = new Set();
  for (const s of (shifts || [])) {
    if (!s || !s.shift_date) continue;
    const d = s.shift_date instanceof Date
      ? s.shift_date.toISOString().slice(0, 10)
      : String(s.shift_date).slice(0, 10);
    dates.add(d);
  }
  return dates.size;
}

/**
 * Does this shift's break disagree with its type's default? Returns null when it
 * matches (or the type has no default). Warning only — b192 never auto-fixes breaks.
 */
function breakWarning(label, breakMins, defaults) {
  const d = defaults || DEFAULT_SHIFT_TYPE_DEFAULTS;
  const def = d[label];
  if (!def) return null;
  const actual = parseInt(breakMins, 10);
  if (!Number.isFinite(actual)) return null;
  if (actual === def.break_mins) return null;
  return { type: label, expected: def.break_mins, actual };
}

module.exports = {
  SHIFT_TYPES,
  DEFAULT_SHIFT_TYPE_DEFAULTS,
  SETTINGS_KEY,
  getShiftTypeDefaults,
  saveShiftTypeDefaults,
  mergeDefaults,
  classifyShift,
  slotOf,
  slotSql,
  normaliseLabel,
  daysWorked,
  breakWarning,
};
