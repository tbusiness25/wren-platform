'use strict';
/**
 * shift-patterns.js — b189 (2026-08-19): NAMED shift patterns, and the rule that
 * the break belongs to the pattern rather than to the individual shift.
 *
 * BACKGROUND (audited on prod 2026-08-18): ladn.rota_shifts held 300 shifts and
 * every single one had `label` NULL. Ten distinct start/end combinations were being
 * rostered but none of them had a name. Worse, `break_mins` disagreed between
 * IDENTICAL shifts — 12:00-18:00 existed with both 30 and 60 minutes, and so did
 * 08:00-14:00. Same shift, different break, no reason recorded anywhere.
 *
 * THE RULE THIS FILE ENFORCES:
 *   shift_patterns.break_mins is the DEFAULT and the reference value.
 *   rota_shifts.break_mins remains a per-shift OVERRIDE for genuine exceptions.
 *   New shifts take their break FROM the pattern (see defaultBreakFor()).
 *   Where an existing shift disagrees we WARN (breakDrift()) — we never retro-edit.
 *   Historical shifts are reported, not corrected: a break that was actually taken
 *   is a fact about the past, and rewriting it would be falsifying a working-time
 *   record.
 *
 * RELATIONSHIP TO b192 (src/lib/shift-types.js): b192 classifies a shift into one of
 * three broad TYPES (Day / AM / PM / Custom) stored in rota_shifts.label, driven by
 * settings key 'shift_type_defaults'. b189 is finer: ten NAMED patterns in a real
 * table, matched on exact start+end, stored in rota_shifts.pattern_id. Both coexist;
 * neither writes the other's column.
 */

// Match is on start+end ONLY — deliberately not on break_mins, because break_mins is
// exactly the field that is inconsistent in the live data. Including it would mean the
// drifted shifts silently failed to match their own pattern and the drift would vanish
// from the report instead of being surfaced.
function hhmm(t) {
  if (t == null || t === '') return null;
  return String(t).substring(0, 5);
}

/** "07:45" → 465. Returns null on anything unparseable. */
function toMinutes(t) {
  const s = hhmm(t);
  if (!s || !/^\d{1,2}:\d{2}$/.test(s)) return null;
  const [h, m] = s.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  return h * 60 + m;
}

/** 465 → "07:45". */
function fromMinutes(mins) {
  const m = Math.max(0, Math.round(mins));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Paid hours implied by a pattern: elapsed time minus the break. */
function paidHours(startTime, endTime, breakMins) {
  const s = toMinutes(startTime), e = toMinutes(endTime);
  if (s == null || e == null) return null;
  const elapsed = (e >= s ? e - s : (e + 24 * 60) - s);   // tolerate an overnight pattern
  const paid = elapsed - (parseInt(breakMins, 10) || 0);
  return Math.round((paid / 60) * 100) / 100;
}

/**
 * All patterns, ordered for display. `activeOnly` defaults to true because every
 * caller that is choosing a pattern for a NEW shift wants only live ones; the
 * reporting callers pass false so a retired pattern still resolves by id.
 * Never throws — an un-migrated edition (no shift_patterns table) gets [].
 */
async function listPatterns(db, activeOnly = true) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, start_time::text AS start_time, end_time::text AS end_time,
              break_mins, paid_hours, active, sort_order
         FROM shift_patterns
        ${activeOnly ? 'WHERE active = true' : ''}
        ORDER BY sort_order, start_time, end_time`
    );
    return rows.map(r => ({ ...r, start_time: hhmm(r.start_time), end_time: hhmm(r.end_time),
                            paid_hours: r.paid_hours == null ? null : Number(r.paid_hours) }));
  } catch (e) {
    return [];   // pre-migration edition — callers degrade to "no named patterns"
  }
}

/** Exact start+end match against the pattern list. Returns the pattern or null. */
function matchPattern(patterns, startTime, endTime) {
  const s = hhmm(startTime), e = hhmm(endTime);
  if (!s || !e) return null;
  return (patterns || []).find(p => hhmm(p.start_time) === s && hhmm(p.end_time) === e) || null;
}

/**
 * The break a NEW shift should get. Pattern first (requirement 2: "default it from
 * the pattern"), then the caller's own fallback, then 30. An explicit override that
 * the manager typed is respected by the caller — this only supplies the DEFAULT.
 */
function defaultBreakFor(patterns, startTime, endTime, fallback) {
  const p = matchPattern(patterns, startTime, endTime);
  if (p && Number.isFinite(parseInt(p.break_mins, 10))) return parseInt(p.break_mins, 10);
  return Number.isFinite(parseInt(fallback, 10)) ? parseInt(fallback, 10) : 30;
}

/**
 * Does this shift's break disagree with its pattern's? Returns null when it agrees,
 * when there is no pattern, or when either number is missing. WARNING ONLY — the
 * caller must never write a correction off the back of this.
 */
function breakDrift(pattern, shiftBreakMins) {
  if (!pattern) return null;
  const expected = parseInt(pattern.break_mins, 10);
  const actual = parseInt(shiftBreakMins, 10);
  if (!Number.isFinite(expected) || !Number.isFinite(actual)) return null;
  if (expected === actual) return null;
  return {
    pattern_id: pattern.id,
    pattern_name: pattern.name,
    expected_break_mins: expected,
    actual_break_mins: actual,
    delta_mins: actual - expected,
    message: `${pattern.name} normally carries a ${expected}-minute break — this shift has ${actual}.`,
  };
}

/** Paid minutes a shift is actually worth, honouring the per-shift override. */
function paidMinutesForShift(shift, pattern) {
  const s = toMinutes(shift.planned_start), e = toMinutes(shift.planned_end);
  if (s == null || e == null) return 0;
  const elapsed = (e >= s ? e - s : (e + 24 * 60) - s);
  const brk = Number.isFinite(parseInt(shift.break_mins, 10))
    ? parseInt(shift.break_mins, 10)
    : (pattern ? (parseInt(pattern.break_mins, 10) || 0) : 0);
  return Math.max(0, elapsed - brk);
}

module.exports = {
  hhmm, toMinutes, fromMinutes, paidHours,
  listPatterns, matchPattern, defaultBreakFor, breakDrift, paidMinutesForShift,
};
