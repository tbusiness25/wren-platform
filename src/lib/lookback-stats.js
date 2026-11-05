'use strict';
/* ═══════════════════════════════════════════════════════════════════════════════
 * lookback-stats.js — b523 (2026-10-20)
 *
 * Suppression, summary statistics and confidence labels for the "Look back"
 * report. Pure functions, no DB.
 *
 * ── SUPPRESSION IS NOT A RENDERING CHOICE ────────────────────────────────────
 * Toby's rule for this report: "Never show any individual child. Suppress any
 * group under 5." LADN has two rooms and roughly forty children on roll, so an
 * un-suppressed cell is often one family — and a projector in a room full of
 * staff is the least private screen in the building.
 *
 * So suppression happens HERE, server-side, inside the shape the route returns.
 * A suppressed bucket carries no value at all: `value` is null and `n` is the
 * string '<5', never the real count. A template cannot leak what it was never
 * given, and a later chart, CSV or slide pack inherits the rule for free.
 *
 * The threshold counts DISTINCT CHILDREN, not rows. Four hundred observations
 * about one child is still one child.
 * ═══════════════════════════════════════════════════════════════════════════════ */

const MIN_GROUP = 5;

/** Distinct-children floor. Returns null (= suppressed) or the count. */
function suppressed(childCount) {
  return !(Number(childCount) >= MIN_GROUP);
}

/**
 * Wrap one measured bucket in the shape every chart consumes.
 * @param {number|null} value    the statistic, or null if it could not be computed
 * @param {number} children      DISTINCT children behind it
 * @param {object} extra         anything else the chart needs (rows, parts, …)
 */
function cell(value, children, extra) {
  const sup = suppressed(children);
  return Object.assign({
    value: sup ? null : (value == null || Number.isNaN(value) ? null : value),
    n: sup ? '<5' : Number(children),
    suppressed: sup,
  }, sup ? {} : (extra || {}));
}

/** A bucket that is suppressed keeps its label and loses everything else. */
function suppressedCell() { return { value: null, n: '<5', suppressed: true }; }

// ── summary statistics ───────────────────────────────────────────────────────
function sorted(nums) {
  return nums.filter(v => v != null && !Number.isNaN(Number(v))).map(Number).sort((a, b) => a - b);
}
function median(nums) {
  const s = sorted(nums);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** Nearest-rank percentile (p in 0..1). Deliberately not interpolated: with
 *  twenty data points an interpolated quartile invents a value nobody measured. */
function percentile(nums, p) {
  const s = sorted(nums);
  if (!s.length) return null;
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx];
}
function mean(nums) {
  const s = sorted(nums);
  if (!s.length) return null;
  return s.reduce((a, b) => a + b, 0) / s.length;
}
function pct(part, whole) {
  const w = Number(whole);
  if (!w) return null;
  return Math.round((Number(part) / w) * 1000) / 10;
}
function round(v, dp) {
  if (v == null || Number.isNaN(Number(v))) return null;
  const f = Math.pow(10, dp == null ? 1 : dp);
  return Math.round(Number(v) * f) / f;
}

/**
 * A median plus its spread, suppressed by distinct children.
 * `values` is one number per OBSERVED UNIT; `children` the distinct children.
 */
function distribution(values, children) {
  const s = sorted(values);
  if (suppressed(children) || !s.length) {
    return { value: null, n: suppressed(children) ? '<5' : Number(children), suppressed: suppressed(children), rows: null };
  }
  return {
    value: round(median(s), 1),
    p25: round(percentile(s, 0.25), 1),
    p75: round(percentile(s, 0.75), 1),
    min: round(s[0], 1),
    max: round(s[s.length - 1], 1),
    rows: s.length,
    n: Number(children),
    suppressed: false,
  };
}

// ── confidence: say out loud how much a number is worth ──────────────────────
// Every chart in this report carries one of these. The report's whole value on
// an inset day is that staff can tell a finding from an artefact of recording,
// so the rating is part of the payload, not a footnote somebody might add later.
const CONFIDENCE = {
  strong:  { key: 'strong',  label: 'Good data',     note: 'Recorded directly, consistently, over the whole window.' },
  fair:    { key: 'fair',    label: 'Fair data',     note: 'Recorded directly but not consistently — read trends, not single terms.' },
  weak:    { key: 'weak',    label: 'Weak proxy',    note: 'Stands in for the thing we actually want to know. Read it with the limit stated below.' },
  thin:    { key: 'thin',    label: 'Too thin yet',  note: 'The measure is right but there is not enough recorded data to answer it. What to start recording is the finding.' },
  missing: { key: 'missing', label: 'Not available', note: 'Wren does not hold what this question needs. The gap, and what would close it, is stated below.' },
};
function confidence(key) { return CONFIDENCE[key] || CONFIDENCE.weak; }

module.exports = {
  MIN_GROUP, suppressed, cell, suppressedCell,
  median, percentile, mean, pct, round, distribution,
  CONFIDENCE, confidence,
};
