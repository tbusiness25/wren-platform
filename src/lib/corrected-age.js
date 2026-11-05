'use strict';
// ===========================================================================
// b268 — CORRECTED AGE (2026-09-02)
//
// A baby born nine weeks early is nine weeks behind their birth certificate.
// Their *corrected* age — chronological age minus the weeks of prematurity —
// is the age their development should be read against. Judging a 12-month-old
// who arrived at 31 weeks against 12-month expectations manufactures a concern
// that isn't there, and can just as easily mask a real one.
//
// `ladn.child_about_me.premature_weeks` (b268) is where the nursery records it,
// off the Baby Room "All About Me" form question "I was born premature (how
// many weeks early?)". This module is the single place that turns that number
// into an age, so every surface labels it the same way.
//
// CORRECTION IS DISPLAY-ONLY, DELIBERATELY. Statutory windows still run on
// actual age — the two-year progress check is due between 24 and 36 months of
// *chronological* age however early the child arrived — so nothing here is
// wired into an eligibility test. It changes what a practitioner reads, not
// what the law asks of them.
//
// Convention (NHS / Bliss): correction is applied up to the second birthday and
// dropped after it. CORRECT_UNTIL_MONTHS below is that cut-off.
// ===========================================================================

/** Correction stops mattering at 2 years chronological (NHS/Bliss convention). */
const CORRECT_UNTIL_MONTHS = 24;

/** Weeks of prematurity outside this range are treated as not recorded. */
const MIN_WEEKS = 1;
const MAX_WEEKS = 17;   // a 23-week birth is ~17 weeks early; anything beyond is a typo

/**
 * Whole months between a date of birth and a reference date.
 * pg returns DATE as a local-midnight JS Date, so read it with LOCAL getters —
 * toISOString() would shift a BST date back a day and can move a child across a
 * band boundary on their birthday. (Same reasoning as src/lib/two-year-check.js.)
 */
function ageInMonths(dob, on) {
  if (!dob) return null;
  const d = (dob instanceof Date) ? dob : new Date(dob);
  const t = on ? ((on instanceof Date) ? on : new Date(on)) : new Date();
  if (isNaN(d) || isNaN(t)) return null;
  let m = (t.getFullYear() - d.getFullYear()) * 12 + (t.getMonth() - d.getMonth());
  if (t.getDate() < d.getDate()) m -= 1;
  return m;
}

/** Normalise whatever came out of the DB / a form field into usable weeks, or null. */
function normaliseWeeks(prematureWeeks) {
  const w = Math.round(Number(prematureWeeks));
  if (!Number.isFinite(w) || w < MIN_WEEKS || w > MAX_WEEKS) return null;
  return w;
}

/**
 * Corrected age in whole months, or null when there is nothing to correct
 * (no prematurity recorded, out of range, or the child is past two).
 * Never returns a negative age.
 */
function correctedAgeMonths(ageMonths, prematureWeeks) {
  const age = Math.round(Number(ageMonths));
  const weeks = normaliseWeeks(prematureWeeks);
  if (weeks == null || !Number.isFinite(age)) return null;
  if (age >= CORRECT_UNTIL_MONTHS) return null;
  // 4.348 weeks per month; floor so we never overstate how old the baby is.
  const corrected = Math.floor(age - (weeks / 4.348));
  return corrected < 0 ? 0 : corrected;
}

/** "2 years 3 months" / "9 months" — the house format for an age in months. */
function formatAgeMonths(months) {
  const m = Math.round(Number(months));
  if (!Number.isFinite(m) || m < 0) return '';
  if (m < 12) return `${m} month${m === 1 ? '' : 's'}`;
  const y = Math.floor(m / 12), rem = m % 12;
  const yStr = `${y} year${y === 1 ? '' : 's'}`;
  return rem ? `${yStr} ${rem} month${rem === 1 ? '' : 's'}` : yStr;
}

/**
 * The whole picture for one child, for any surface that shows age-banded
 * developmental expectations. Returns the same shape whether or not the child
 * was premature, so callers can render unconditionally.
 *
 *   { age_months, premature_weeks, corrected_age_months,
 *     corrected: bool, age_label, corrected_label, note }
 *
 * `note` is the plain-language line to show next to the age. Null when there is
 * no correction to make.
 */
function correctedAge(ageMonths, prematureWeeks, opts = {}) {
  const age = Number.isFinite(Number(ageMonths)) ? Math.round(Number(ageMonths)) : null;
  const weeks = normaliseWeeks(prematureWeeks);
  const corrected = correctedAgeMonths(age, weeks);
  const out = {
    age_months: age,
    premature_weeks: weeks,
    corrected_age_months: corrected,
    corrected: corrected != null,
    age_label: age == null ? '' : formatAgeMonths(age),
    corrected_label: corrected == null ? '' : formatAgeMonths(corrected),
    note: null,
  };
  if (corrected != null) {
    out.note = `Born ${weeks} week${weeks === 1 ? '' : 's'} early — corrected age ` +
               `${out.corrected_label} (actual ${out.age_label}). Read development against the corrected age.`;
  } else if (weeks != null && age != null && age >= CORRECT_UNTIL_MONTHS) {
    // Still worth saying, because the record exists and staff will wonder why
    // nothing is being corrected any more.
    out.note = `Born ${weeks} week${weeks === 1 ? '' : 's'} early. Past two years, so age is no longer corrected.`;
  }
  return out;
}

/**
 * Attach the corrected-age block to a child payload in place.
 * `child.age_months` (or a dob) plus a premature_weeks value in, the same object
 * back out carrying premature_weeks / corrected_age_months / corrected_age_note.
 */
function decorateChild(child, prematureWeeks, on) {
  if (!child) return child;
  const months = child.age_months != null
    ? child.age_months
    : ageInMonths(child.date_of_birth, on);
  const c = correctedAge(months, prematureWeeks);
  child.premature_weeks = c.premature_weeks;
  child.corrected_age_months = c.corrected_age_months;
  child.corrected_age_label = c.corrected_label || null;
  child.corrected_age_note = c.note;
  return child;
}

/**
 * One-liner SQL fragment for the common "pull premature_weeks alongside the
 * child" join. Callers still choose their own alias for children.
 *   LEFT JOIN child_about_me cam ON cam.child_id = c.id
 */
const ABOUT_ME_JOIN = 'LEFT JOIN child_about_me cam ON cam.child_id = c.id';

module.exports = {
  CORRECT_UNTIL_MONTHS, MIN_WEEKS, MAX_WEEKS, ABOUT_ME_JOIN,
  ageInMonths, normaliseWeeks, correctedAgeMonths, formatAgeMonths,
  correctedAge, decorateChild,
};
