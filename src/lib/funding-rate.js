'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// One place that turns an entitlement into an hourly rate. (2026-09-23)
//
// Before this, the mapping was copy-pasted into funding.js, finance-invoices.js,
// finance-reports.js, finance-xero.js and occupancy-v2.js — and every one of those copies
// knew about universal, extended and the two-year-old rates, while NONE of them knew about
// `funding_terms.rate_under_2`. So the under-2 rate sat in the database, correct, and no code
// path could ever reach it. Autumn 2026 had nine under-2s billed at the 3-4 year old rate as a
// direct result.
//
// Toby, 2026-09-23, on why the age bands differ:
//   "With the under-twos funding and the 2-year-old funding it's just extended entitlement,
//    because obviously it's only eligible [working] parents who can get it anyway, so it's
//    always going to be the 30. Whereas with the three-year-old funding it can either be the
//    universal 15 or the extended 30, so that's why for the 3-year-olds it's different."
//
// So: under 2 and two-year-old working-parent places are always the working entitlement and
// have their own rate. Only the 3-4 population splits into universal vs extended.
// ─────────────────────────────────────────────────────────────────────────────

// The entitlement types Wren uses. 'two_year' is the legacy spelling still on older rows.
const TYPES = {
  none: { label: 'Not funded', rateKey: null },
  under_2: { label: 'Under 2 (working parent)', rateKey: 'rate_under_2' },
  '2yr_working': { label: '2-year-old (working parent)', rateKey: 'rate_2yr_working_parents' },
  '2yr_disadvantaged': { label: '2-year-old (disadvantaged)', rateKey: 'rate_2yr_disadvantaged' },
  two_year: { label: '2-year-old (legacy row)', rateKey: 'rate_2yr_working_parents' },
  universal: { label: 'Universal 15 (3-4)', rateKey: 'rate_3yr_universal' },
  extended: { label: 'Extended 30 (3-4)', rateKey: 'rate_3yr_extended' },
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The hourly rate a term pays for an entitlement. 0 when unfunded or the rate is unset. */
function rateFor(term, fundingType) {
  const t = TYPES[fundingType];
  if (!t || !t.rateKey || !term) return 0;
  return num(term[t.rateKey]);
}

/** Age band on a given date — the LA counts age at the start of the funding period. */
function ageBand(dob, onDate) {
  if (!dob) return 'unknown';
  const d = new Date(dob), on = new Date(onDate || Date.now());
  if (isNaN(d) || isNaN(on)) return 'unknown';
  let years = on.getFullYear() - d.getFullYear();
  const m = on.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && on.getDate() < d.getDate())) years--;
  if (years < 2) return 'under_2';
  if (years < 3) return 'two';
  if (years < 5) return 'three_four';
  return 'over_5';
}

/**
 * Which entitlement an age band can hold.
 * Under-2 and two-year-old funded places exist only for eligible working parents, so the
 * category follows from the age. A 3-4 year old may be on either, so this never overrides one.
 */
function expectedTypeFor(band, currentType) {
  if (band === 'under_2') return 'under_2';
  if (band === 'two') return (currentType === '2yr_disadvantaged') ? '2yr_disadvantaged' : '2yr_working';
  return null;   // 3-4 (and anything else): universal or extended, both legitimate — caller decides
}

/** True when the row's entitlement cannot be right for the child's age. */
function mismatched(band, fundingType) {
  if (!fundingType || fundingType === 'none') return false;
  const want = expectedTypeFor(band, fundingType);
  return !!want && want !== fundingType;
}

module.exports = { TYPES, rateFor, ageBand, expectedTypeFor, mismatched };
