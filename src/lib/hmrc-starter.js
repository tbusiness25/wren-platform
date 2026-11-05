'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// hmrc-starter.js — b303 (2026-09-10)
//
// The HMRC starter checklist's questions, once, so the form that asks them, the
// route that validates them and the screen that shows them back cannot disagree
// about the wording.
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
// Wren is collecting what the EMPLOYER needs in order to operate PAYE. It does
// not file anything with HMRC, it is not an RTI submission, and a starter who
// answers these questions has NOT discharged any obligation to HMRC. Nothing in
// this file renders a facsimile of HMRC's form, and no HMRC logo or crown
// appears anywhere in Wren. The GOV.UK starter-checklist link stays in the
// document pack (slug 'hmrc-starter-checklist') for anybody who has a P45 or
// would rather use the official form.
//
// ── THE EMPLOYEE STATEMENT ──────────────────────────────────────────────────
// Asked in HMRC's own words, not paraphrased. A payroll operator reading "B" on
// a screen needs to know what B meant to the person who ticked it, and the only
// safe way to guarantee that is to have shown them HMRC's sentence.
// `summary` is a one-line gloss for a table cell — it never replaces the
// statement, it sits next to the letter alongside it.
//
// ── HANDLING ────────────────────────────────────────────────────────────────
// Everything here describes special-category-adjacent payroll data about a named
// employee. It lives on ladn.staff and nowhere else: not in audit meta, not in a
// log line, not in an email body, not in AI context. The four new columns are in
// SALARY_PAY_FIELDS (src/lib/capabilities.js) so stripSalaryFields() removes them
// for anybody without view_staff_salaries, exactly as it already does tax_code.
// ─────────────────────────────────────────────────────────────────────────────

/** HMRC's three employee statements, verbatim from the starter checklist. */
const DECLARATIONS = [
  {
    letter: 'A',
    summary: 'First job since 6 April, and no other income since then.',
    statement:
      'This is my first job since 6 April and since the 6 April I have not received '
      + 'payments from: another job, Jobseeker’s Allowance, Employment and Support '
      + 'Allowance or Incapacity Benefit.',
    caveat: 'Do not choose this statement if you are in receipt of a State, Works or Private Pension.',
  },
  {
    letter: 'B',
    summary: 'Only job now, but there has been another since 6 April.',
    statement:
      'This is now my only job but since 6 April I have had another job, or have '
      + 'received Jobseeker’s Allowance, Employment and Support Allowance or '
      + 'Incapacity Benefit. I do not receive a State, Works or Private Pension.',
    caveat: 'Do not choose this statement if you are in receipt of a State, Works or Private Pension.',
  },
  {
    letter: 'C',
    summary: 'Another job, or a State / Works / Private Pension.',
    statement:
      'As well as my new job, I have another job or receive a State, Works or Private Pension.',
    caveat: null,
  },
];

const DECLARATION_LETTERS = DECLARATIONS.map(d => d.letter);
const DECLARATION_BY_LETTER = new Map(DECLARATIONS.map(d => [d.letter, d]));

/** Student loan repayment plans as payroll knows them. */
const STUDENT_LOAN_PLANS = [
  { value: 'none',  label: 'No student loan' },
  { value: 'plan1', label: 'Plan 1' },
  { value: 'plan2', label: 'Plan 2' },
  { value: 'plan4', label: 'Plan 4 (Scotland)' },
  { value: 'plan5', label: 'Plan 5' },
];
const STUDENT_LOAN_VALUES = STUDENT_LOAN_PLANS.map(p => p.value);
const STUDENT_LOAN_LABEL = new Map(STUDENT_LOAN_PLANS.map(p => [p.value, p.label]));

/** The one plain sentence every surface that asks these questions must carry. */
const PURPOSE_LINE =
  'We need these so we can pay you correctly through PAYE. Wren does not send anything '
  + 'to HMRC — this is the nursery collecting what it needs as your employer.';

// ── National Insurance number ────────────────────────────────────────────────
// Format: two letters, six digits, a final letter A–D.
//
// The letters are not free. HMRC never issues D, F, I, Q, U or V in either
// position, never O in the second, and reserves the prefixes BG, GB, KN, NK, NT,
// TN and ZZ. TN in particular is the one worth naming: it is a TEMPORARY number
// an employer invents from a date of birth when the real one is not to hand, and
// it is exactly what somebody types when they are guessing. Accepting it would
// put a number in the payroll field that HMRC cannot match to a person.
const NI_DISALLOWED_FIRST = new Set(['D', 'F', 'I', 'Q', 'U', 'V']);
const NI_DISALLOWED_SECOND = new Set(['D', 'F', 'I', 'O', 'Q', 'U', 'V']);
const NI_RESERVED_PREFIXES = new Set(['BG', 'GB', 'KN', 'NK', 'NT', 'TN', 'ZZ']);

/**
 * Normalise and validate a National Insurance number.
 *
 * BLANK IS VALID and returns { ok: true, value: null } — a starter under 16, or
 * one who genuinely has not been issued a number yet, must still be able to send
 * their details in. It is payroll data, not a gate on getting an account.
 *
 * Every failure names the actual problem. "Invalid" tells somebody filling in a
 * form on a phone nothing, and they retype the same thing.
 *
 * @param {*} v raw input
 * @returns {{ok:true,value:string|null}|{ok:false,error:string}}
 */
function normaliseNi(v) {
  if (v === undefined || v === null) return { ok: true, value: null };
  const raw = String(v).replace(/[\s\-.]/g, '').toUpperCase();
  if (!raw) return { ok: true, value: null };

  if (!/^[A-Z]{2}[0-9]{6}[A-Z]$/.test(raw)) {
    // The worked example must be a number this validator would ACCEPT. HMRC's own
    // specimen is QQ123456C, which is a specimen precisely because QQ is never
    // issued — printing it here would send anybody who copied it straight into
    // the "those letters are never used" branch below.
    return { ok: false, error: 'A National Insurance number is two letters, six digits and one '
                             + 'final letter — for example AB123456C. Leave it blank if you do not have one yet.' };
  }
  const first = raw[0], second = raw[1], prefix = raw.slice(0, 2), suffix = raw[8];

  if (NI_RESERVED_PREFIXES.has(prefix)) {
    return { ok: false, error: prefix === 'TN'
      ? 'TN numbers are temporary ones an employer makes up, not real National Insurance '
        + 'numbers. Please use the number on your payslip, P45 or HMRC letter, or leave it blank.'
      : `National Insurance numbers never start with ${prefix}. Please check the letters.` };
  }
  if (NI_DISALLOWED_FIRST.has(first) || NI_DISALLOWED_SECOND.has(second)) {
    return { ok: false, error: 'The letters D, F, I, Q, U and V are never used at the start of a '
                             + 'National Insurance number (nor O as the second letter). Please check them — '
                             + 'a 0 is easily read as an O.' };
  }
  if (suffix < 'A' || suffix > 'D') {
    return { ok: false, error: 'The last letter of a National Insurance number is always A, B, C or D.' };
  }
  return { ok: true, value: raw };
}

/**
 * Validate the employee statement letter.
 * Blank is valid: a starter with a P45 has nothing to declare, and the whole
 * block is optional in any case.
 */
function normaliseDeclaration(v) {
  if (v === undefined || v === null) return { ok: true, value: null };
  const s = String(v).trim().toUpperCase();
  if (!s) return { ok: true, value: null };
  if (!DECLARATION_BY_LETTER.has(s)) {
    return { ok: false, error: 'Please choose one of the three statements, A, B or C.' };
  }
  return { ok: true, value: s };
}

/** Validate the student loan plan. Blank is valid; 'none' is a real answer. */
function normaliseStudentLoan(v) {
  if (v === undefined || v === null) return { ok: true, value: null };
  const s = String(v).trim().toLowerCase();
  if (!s) return { ok: true, value: null };
  if (!STUDENT_LOAN_VALUES.includes(s)) {
    return { ok: false, error: 'Please choose a student loan plan from the list, or "No student loan".' };
  }
  return { ok: true, value: s };
}

/**
 * A staff row's payroll-starter answers, shaped for a screen.
 *
 * The declaration comes back as its LETTER and its SENTENCE together. A bare "B"
 * is useless to whoever runs payroll, and the summary alone loses the letter they
 * have to type into BrightPay.
 *
 * @param {object} s a ladn.staff row (or the part of one that survived a strip)
 */
function describe(s = {}) {
  const dec = s.starter_declaration ? DECLARATION_BY_LETTER.get(s.starter_declaration) : null;
  const plan = s.student_loan_plan || null;
  return {
    ni_number: s.ni_number || null,
    tax_code: s.tax_code || null,
    p45_provided: s.p45_provided === true,
    declaration: dec ? dec.letter : null,
    declaration_summary: dec ? dec.summary : null,
    declaration_statement: dec ? dec.statement : null,
    student_loan_plan: plan,
    student_loan_label: plan ? (STUDENT_LOAN_LABEL.get(plan) || plan) : null,
    postgrad_loan: s.postgrad_loan === true,
    // What payroll is still waiting for. A P45 supersedes the statement, so it
    // is only outstanding when there is no P45.
    missing: [
      s.ni_number ? null : 'National Insurance number',
      s.tax_code ? null : 'tax code',
      (s.p45_provided === true || s.starter_declaration) ? null : 'employee statement (A/B/C) or a P45',
      plan ? null : 'student loan answer',
    ].filter(Boolean),
    // Said on every surface that shows this, so nobody reads it as a filing.
    basis: 'Collected by the nursery to operate PAYE. Wren does not file with HMRC.',
  };
}

module.exports = {
  DECLARATIONS, DECLARATION_LETTERS, DECLARATION_BY_LETTER,
  STUDENT_LOAN_PLANS, STUDENT_LOAN_VALUES, STUDENT_LOAN_LABEL,
  PURPOSE_LINE,
  NI_RESERVED_PREFIXES, NI_DISALLOWED_FIRST, NI_DISALLOWED_SECOND,
  normaliseNi, normaliseDeclaration, normaliseStudentLoan,
  describe,
};
