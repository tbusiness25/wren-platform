'use strict';
/**
 * finance-calendar.js — b346 (2026-09-21)
 *
 * The dated list of what a nursery COMPANY owes, and to whom. A calendar with
 * teeth: it computes, it reminds, it never files anything and never talks to HMRC.
 *
 * THIS FILE IS PURE. No database, no clock, no I/O. Every function takes what it
 * needs — the company's settings, and `today` — and returns plain data. That is the
 * same choice b311 made for signals (`ctx.today` is injectable) and for the same
 * reason: a deadline calculator you can only test on the day it fires is one you
 * find out about on the day it fires.
 *
 * ── THE FOUR RULES OF THIS FILE ─────────────────────────────────────────────
 *  1. COMPUTE, DO NOT TYPE. Statutory dates derive from the company's financial
 *     year end (held once, in ladn.settings) and from the fixed tax calendar. There
 *     is not one hard-coded date for a specific company year anywhere below.
 *  2. DO NOT INVENT A DATE YOU CANNOT SOURCE. Every rule carries the wording it
 *     comes from and a GOV.UK / Pensions Regulator page. Where a rule needs a fact
 *     only the owner holds (year end, Companies House review date, pension duties
 *     start, payday) and it has not been entered, the rule reports `needs` — "needs
 *     a date from you" — and produces NO occurrence. Where a rule is genuinely
 *     conditional (VAT, P11D, EPS, instalments) it is listed under CONDITIONAL with
 *     an "only if…" and produces no date at all.
 *  3. OUR OWN DATE IS EARLIER, AND IS OURS. Each statutory rule has an internal
 *     date = statutory date minus a lead time (default below, editable), stepped
 *     BACK off weekends and bank holidays and never later than the statutory date.
 *     Internal-only rules (bank reconciliation, Xero catch-up, payroll cut-off) have
 *     no statutory date and are never made to look like they do — and their own dates
 *     are stepped back off a weekend or bank holiday too.
 *  4. MONEY DOES NOT APPEAR HERE. Deadlines and who-is-blocked only. No pay data,
 *     no amounts, no names of staff or families.
 *
 * Sources verified against GOV.UK / The Pensions Regulator on 2026-09-21; the exact
 * wording relied on is quoted in each rule's `rule` field.
 */

// ── date arithmetic (ISO strings, UTC maths — no local-midnight traps) ───────
const pad = n => String(n).padStart(2, '0');
const ISO_RX = /^(\d{4})-(\d{2})-(\d{2})$/;

function isIso(s) {
  const m = ISO_RX.exec(String(s || ''));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}
function parse(iso) {
  const m = ISO_RX.exec(String(iso).slice(0, 10));
  if (!m) throw new Error('bad date: ' + iso);
  return { y: +m[1], m: +m[2], d: +m[3] };
}
const fmt = ({ y, m, d }) => `${y}-${pad(m)}-${pad(d)}`;
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

function addDays(iso, n) {
  const { y, m, d } = parse(iso);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return fmt({ y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() });
}
/**
 * Add calendar months. A date that is the LAST DAY of its month lands on the last
 * day of the target month (31 Dec + 9 months = 30 Sep, not "31 Sep"); any other date
 * keeps its day-of-month, clamped if the target month is shorter.
 *
 * That month-end rule is what makes "9 months and 1 day after the end of the
 * accounting period" come out right for every month-end year end — 31 Dec → 1 Oct,
 * 30 Nov → 1 Sep, 28/29 Feb → 1 Dec — rather than drifting by a day in months of
 * different lengths.
 */
function addMonths(iso, n) {
  const { y, m, d } = parse(iso);
  const eom = d === daysInMonth(y, m);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12), nm = (idx % 12) + 1;
  const dim = daysInMonth(ny, nm);
  return fmt({ y: ny, m: nm, d: eom ? dim : Math.min(d, dim) });
}
const weekday = iso => { const { y, m, d } = parse(iso); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); }; // 0 = Sunday
function diffDays(a, b) { // b - a, whole days
  const A = parse(a), B = parse(b);
  return Math.round((Date.UTC(B.y, B.m - 1, B.d) - Date.UTC(A.y, A.m - 1, A.d)) / 86400000);
}
const isNonWorking = (iso, holidays) => { const w = weekday(iso); return w === 0 || w === 6 || !!(holidays && holidays.has(iso)); };
/** Step BACK to the nearest working day (never forward: an internal date must not slip past the real one). */
function prevWorkingDay(iso, holidays) {
  let cur = iso;
  for (let i = 0; i < 10 && isNonWorking(cur, holidays); i++) cur = addDays(cur, -1);
  return cur;
}
const monthName = m => ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'][m - 1];
const shortMonth = m => monthName(m).slice(0, 3);
const niceDate = iso => { const { y, m, d } = parse(iso); return `${d} ${shortMonth(m)} ${y}`; };

// ── the company's settings, as the engine sees them ──────────────────────────
// Settings are strings in ladn.settings. `readContext` turns them into typed values
// and — importantly — into NULL when absent or malformed, so a typo can never
// silently become a date.
const SETTING_KEYS = {
  year_end_md:        'finance_year_end_md',          // 'MM-DD'
  cs_review_end:      'finance_cs_review_end',        // ISO — end of the current confirmation-statement review period
  pension_start:      'finance_pension_duties_start', // ISO — automatic-enrolment duties start date
  pension_last:       'finance_pension_last_reenrol', // ISO — the re-enrolment date chosen last cycle (optional)
  payday_dom:         'finance_payday_dom',           // 1..31
  pack_days:          'finance_accountant_pack_days', // days after year end the accountant wants the pack
  recon_dom:          'finance_bank_recon_dom',       // default 10
  xero_dom:           'finance_xero_dom',             // default 15
  cutoff_days:        'finance_payroll_cutoff_days',  // default 5
  from:               'finance_calendar_from',        // tracking start
  leads:              'finance_calendar_leads',       // JSON {rule_code: days}
};
const DEFAULTS = { recon_dom: 10, xero_dom: 15, cutoff_days: 5 };

const intIn = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= lo && n <= hi && String(n) === String(v).trim() ? n : null; };
function validMd(v) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(v || '').trim());
  if (!m) return null;
  const mo = +m[1], d = +m[2];
  if (mo < 1 || mo > 12 || d < 1) return null;
  // 02-29 is allowed (it means "the last day of February"); nothing else may exceed the month.
  const cap = mo === 2 ? 29 : daysInMonth(2001, mo);
  return d <= cap ? `${m[1]}-${m[2]}` : null;
}

/**
 * @param {Object<string,string>} raw   settings rows as {key: value}
 * @param {{today:string, holidays?:Set<string>}} env
 */
function readContext(raw, env) {
  const s = k => { const v = raw[k]; return v == null || String(v).trim() === '' ? null : String(v).trim(); };
  let leads = {};
  try { const j = s(SETTING_KEYS.leads); if (j) leads = JSON.parse(j) || {}; } catch { leads = {}; }
  const iso = k => { const v = s(k); return v && isIso(v) ? v : null; };
  return {
    today: env.today,
    holidays: env.holidays || new Set(),
    yearEndMd:  validMd(s(SETTING_KEYS.year_end_md)),
    csReviewEnd: iso(SETTING_KEYS.cs_review_end),
    pensionStart: iso(SETTING_KEYS.pension_start),
    pensionLast:  iso(SETTING_KEYS.pension_last),
    paydayDom:  intIn(s(SETTING_KEYS.payday_dom), 1, 31),
    packDays:   intIn(s(SETTING_KEYS.pack_days), 1, 400),
    reconDom:   intIn(s(SETTING_KEYS.recon_dom), 1, 28) || DEFAULTS.recon_dom,
    xeroDom:    intIn(s(SETTING_KEYS.xero_dom), 1, 28) || DEFAULTS.xero_dom,
    cutoffDays: (() => { const v = intIn(s(SETTING_KEYS.cutoff_days), 0, 20); return v == null ? DEFAULTS.cutoff_days : v; })(),
    trackingFrom: iso(SETTING_KEYS.from),
    leads: Object.fromEntries(Object.entries(leads).filter(([, v]) => Number.isInteger(v) && v >= 0 && v <= 180)),
  };
}

// ── year-end helpers ─────────────────────────────────────────────────────────
/** The financial year end that falls in calendar year `y`. '02-29' / '02-28' both mean "last day of February". */
function fyEndInYear(md, y) {
  const [mo, d] = md.split('-').map(Number);
  if (mo === 2 && d >= 28) return fmt({ y, m: 2, d: daysInMonth(y, 2) });
  return fmt({ y, m: mo, d: Math.min(d, daysInMonth(y, mo)) });
}
function fyEnds(ctx, back = 2, fwd = 2) {
  if (!ctx.yearEndMd) return [];
  const y0 = parse(ctx.today).y;
  const out = [];
  for (let y = y0 - back; y <= y0 + fwd; y++) out.push(fyEndInYear(ctx.yearEndMd, y));
  return out;
}
/** UK tax years that END on 5 April in the given calendar years. */
function taxYearEnds(ctx, back = 2, fwd = 2) {
  const y0 = parse(ctx.today).y, out = [];
  for (let y = y0 - back; y <= y0 + fwd; y++) out.push(`${y}-04-05`);
  return out;
}
const taxYearLabel = end5Apr => { const y = parse(end5Apr).y; return `${y - 1}-${String(y).slice(2)}`; };
/** All months (y,m) from `back` months ago to `fwd` months ahead of today. */
function monthsAround(ctx, back = 3, fwd = 14) {
  const { y, m } = parse(ctx.today), out = [];
  for (let i = -back; i <= fwd; i++) {
    const idx = y * 12 + (m - 1) + i;
    out.push({ y: Math.floor(idx / 12), m: (idx % 12) + 1 });
  }
  return out;
}
const nextMonth = ({ y, m }) => (m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 });
const ym = ({ y, m }) => `${y}-${pad(m)}`;

/** Payday in month (y,m): the configured day (clamped to the month), stepped back off a weekend / bank holiday. */
function paydayIn(ctx, y, m) {
  const d = Math.min(ctx.paydayDom, daysInMonth(y, m));
  return prevWorkingDay(fmt({ y, m, d }), ctx.holidays);
}

// ── the rules ────────────────────────────────────────────────────────────────
const SRC = {
  ctPay:   { label: 'GOV.UK — Pay Corporation Tax', url: 'https://www.gov.uk/pay-corporation-tax' },
  ctRet:   { label: 'GOV.UK — Company Tax Return deadlines', url: 'https://www.gov.uk/company-tax-returns/deadlines' },
  chAcc:   { label: 'GOV.UK — Prepare and file your limited company’s annual accounts', url: 'https://www.gov.uk/prepare-file-annual-accounts-for-limited-company' },
  chCs:    { label: 'GOV.UK — Confirmation statement (running a limited company)', url: 'https://www.gov.uk/running-a-limited-company/confirmation-statement' },
  sa:      { label: 'GOV.UK — Self Assessment tax return deadlines', url: 'https://www.gov.uk/self-assessment-tax-returns/deadlines' },
  payePay: { label: 'GOV.UK — Pay employers’ PAYE', url: 'https://www.gov.uk/pay-paye-tax' },
  fps:     { label: 'GOV.UK — Running payroll: reporting to HMRC', url: 'https://www.gov.uk/running-payroll/reporting-to-hmrc' },
  finalFps:{ label: 'GOV.UK — Send your final payroll report', url: 'https://www.gov.uk/payroll-annual-reporting/send-your-final-payroll-report' },
  p60:     { label: 'GOV.UK — Give employees a P60', url: 'https://www.gov.uk/payroll-annual-reporting/give-employees-p60-form' },
  p11d:    { label: 'GOV.UK — Expenses and benefits: deadlines', url: 'https://www.gov.uk/employer-reporting-expenses-benefits/deadlines' },
  vat:     { label: 'GOV.UK — When to register for VAT', url: 'https://www.gov.uk/vat-registration/when-to-register' },
  tpr:     { label: 'The Pensions Regulator — complete your re-declaration of compliance by your deadline',
             url: 'https://www.thepensionsregulator.gov.uk/en/employers/re-enrolment/i-am-or-will-be-an-employer-with-staff-to-put-back-into-my-scheme/complete-your-re-declaration-of-compliance-by-your-deadline' },
  own:     { label: 'Our own rule — Nursery finance routine (change it under Company dates)', url: null },
};

/**
 * Each rule: what it is, the wording it comes from, our default lead time, who
 * normally holds the ball, where the evidence should live, and how to expand it
 * into dated occurrences. `needs` lists the settings without which it cannot be
 * scheduled at all.
 *
 * `leadDays` — our own earlier date. `effort` — minutes, for ranking on the board.
 */
const RULES = [
  { code: 'year-end', group: 'company', kind: 'marker', title: 'Company year end', recurrence: 'annual',
    needs: ['yearEndMd'], leadDays: 0, effort: null, blocked: 'toby',
    rule: 'The last day of the company’s financial year. Every corporation tax and Companies House date below counts from it, which is why it is the one date Wren asks you to enter.',
    source: SRC.chAcc, evidence: '',
    occurrences: ctx => fyEnds(ctx).map(fye => ({ period: `FY${fye}`, label: `Year ending ${niceDate(fye)}`, marker: fye })) },

  { code: 'accountant-pack', group: 'company', kind: 'internal', title: 'Year-end pack to the accountant', recurrence: 'annual',
    needs: ['yearEndMd', 'packDays'], leadDays: 0, effort: 120, blocked: 'toby',
    rule: 'Our own date, and it is the accountant’s to set: they told you how many days after the year end they need the bank statements, payroll summaries and receipts (Company dates → “Accountant’s deadline”). Wren does not guess it.',
    source: SRC.own, evidence: 'The email or upload that sent the pack, and the accountant’s acknowledgement.',
    occurrences: ctx => fyEnds(ctx).map(fye => ({ period: `FY${fye}`, label: `Pack for year ending ${niceDate(fye)}`, internal: addDays(fye, ctx.packDays) })) },

  { code: 'ct-return', group: 'company', kind: 'statutory', title: 'Company Tax Return (CT600)', recurrence: 'annual',
    needs: ['yearEndMd'], leadDays: 30, effort: 60, blocked: 'accountant',
    rule: '“The deadline for your tax return is 12 months after the end of the accounting period it covers.”',
    source: SRC.ctRet, evidence: 'HMRC’s filing receipt for the CT600 (the accountant will hold a copy too).',
    occurrences: ctx => fyEnds(ctx).map(fye => ({ period: `FY${fye}`, label: `Year ending ${niceDate(fye)}`, statutory: addMonths(fye, 12) })) },

  { code: 'ct-payment', group: 'company', kind: 'statutory', title: 'Corporation Tax payment', recurrence: 'annual',
    needs: ['yearEndMd'], leadDays: 14, effort: 20, blocked: 'toby',
    rule: '“You must pay your Corporation Tax 9 months and 1 day after the end of your accounting period.” Assumes the company is not “large” (taxable profits over £1.5 million pay by instalments instead — see Only if…). Needs the accountant’s figure first.',
    source: SRC.ctPay, evidence: 'The bank line for the payment and HMRC’s payment confirmation.',
    occurrences: ctx => fyEnds(ctx).map(fye => ({ period: `FY${fye}`, label: `Year ending ${niceDate(fye)}`, statutory: addDays(addMonths(fye, 9), 1) })) },

  { code: 'ch-accounts', group: 'company', kind: 'statutory', title: 'Annual accounts to Companies House', recurrence: 'annual',
    needs: ['yearEndMd'], leadDays: 30, effort: 30, blocked: 'accountant',
    rule: '“9 months after your company’s financial year ends” (private limited company; the first accounts are due 21 months after the date you registered with Companies House).',
    source: SRC.chAcc, evidence: 'Companies House’s filing-accepted confirmation.',
    occurrences: ctx => fyEnds(ctx).map(fye => ({ period: `FY${fye}`, label: `Year ending ${niceDate(fye)}`, statutory: addMonths(fye, 9) })) },

  { code: 'confirmation-statement', group: 'company', kind: 'statutory', title: 'Confirmation statement', recurrence: 'annual',
    needs: ['csReviewEnd'], leadDays: 14, effort: 15, blocked: 'toby',
    rule: 'File at least once every 12 months; you have up to 14 days after the review period ends. Gov.uk’s own example: incorporated 1 January 2018, review period ends 31 December 2018, file by 14 January 2019. The review date is on your Companies House record; filing early starts a new review period, so update the date if you do.',
    source: SRC.chCs, evidence: 'Companies House’s confirmation-statement accepted email.',
    occurrences: ctx => [0, 1, 2].map(k => {
      const r = addMonths(ctx.csReviewEnd, 12 * k);
      return { period: `CS${r}`, label: `Review period ending ${niceDate(r)}`, statutory: addDays(r, 14) };
    }) },

  { code: 'pension-redeclaration', group: 'company', kind: 'statutory', title: 'Pension re-declaration of compliance', recurrence: 'cycle',
    needs: ['pensionStart'], leadDays: 30, effort: 30, blocked: 'toby',
    rule: '“Within five months of the third anniversary of your automatic enrolment duties start date.” The Pensions Regulator’s own example: duties start 1 June 2020, third anniversary 1 June 2023, deadline 31 October 2023. The employer repeats it every three years; later cycles count from the re-enrolment date you chose last time, which is why the deadline is flagged “confirm” once that date is entered.',
    source: SRC.tpr, evidence: 'The Pensions Regulator’s declaration-of-compliance receipt.',
    occurrences: ctx => {
      const anchors = ctx.pensionLast
        ? [addMonths(ctx.pensionLast, 36), addMonths(ctx.pensionLast, 72)]
        : [36, 72, 108].map(n => addMonths(ctx.pensionStart, n));
      return anchors.map(a => ({
        period: `PENS${a}`, label: `Cycle from ${niceDate(a)}`, statutory: addDays(addMonths(a, 5), -1),
        verify: !!ctx.pensionLast || parse(a).d > 28,
      }));
    } },

  { code: 'sa-return', group: 'personal', kind: 'statutory', title: 'Self Assessment return and balancing payment (Toby)', recurrence: 'annual',
    needs: [], leadDays: 30, effort: 90, blocked: 'toby',
    rule: 'Online return and any tax owed: by 31 January after the tax year ends on 5 April (a paper return must reach HMRC by 31 October). The same date is also the first payment on account for the following year.',
    source: SRC.sa, evidence: 'HMRC’s submission receipt and the SA302 tax calculation.',
    occurrences: ctx => taxYearEnds(ctx).map(e => ({ period: `TY${taxYearLabel(e)}`, label: `Tax year ${taxYearLabel(e)} (ends ${niceDate(e)})`, statutory: `${parse(e).y + 1}-01-31` })) },

  { code: 'sa-poa2', group: 'personal', kind: 'statutory', title: 'Self Assessment — second payment on account (Toby)', recurrence: 'annual',
    needs: [], leadDays: 14, effort: 20, blocked: 'toby',
    rule: 'The second payment on account is due 31 July. (It relates to the tax year that ended the previous 5 April.)',
    source: SRC.sa, evidence: 'The bank line for the payment and HMRC’s payment confirmation.',
    occurrences: ctx => taxYearEnds(ctx).map(e => ({ period: `TY${taxYearLabel(e)}`, label: `Tax year ${taxYearLabel(e)} (ends ${niceDate(e)})`, statutory: `${parse(e).y}-07-31` })) },

  { code: 'paye-payment', group: 'payroll', kind: 'statutory', title: 'PAYE and NIC payment to HMRC', recurrence: 'monthly',
    needs: [], leadDays: 3, effort: 15, blocked: 'toby',
    rule: 'Monthly payments: “the 22nd of the next tax month” if paying electronically (“it must reach HMRC by the 19th of the month” if paying by post). Tax months run from the 6th to the 5th, so pay for 6 September – 5 October is due by 22 October. HMRC may allow quarterly payments — see Only if…',
    source: SRC.payePay, evidence: 'The bank line and HMRC’s payment confirmation for the tax month.',
    occurrences: ctx => monthsAround(ctx).map(({ y, m }) => {
      const prev = m === 1 ? { y: y - 1, m: 12 } : { y, m: m - 1 };
      return { period: ym({ y, m }), label: `Tax month 6 ${shortMonth(prev.m)} – 5 ${shortMonth(m)} ${y}`, statutory: fmt({ y, m, d: 22 }) };
    }) },

  { code: 'rti-fps', group: 'payroll', kind: 'statutory', title: 'Full Payment Submission (FPS) to HMRC', recurrence: 'monthly',
    needs: ['paydayDom'], leadDays: 1, effort: 15, blocked: 'toby',
    rule: '“Send the FPS on or before your employees’ payday, even if you pay HMRC quarterly instead of monthly.” Payday is taken as the day you set, moved back to the working day before when it falls on a weekend or bank holiday.',
    source: SRC.fps, evidence: 'The payroll software’s submission receipt for the pay date.',
    occurrences: ctx => monthsAround(ctx).map(({ y, m }) => ({ period: ym({ y, m }), label: `Pay date in ${monthName(m)} ${y}`, statutory: paydayIn(ctx, y, m) })) },

  { code: 'payroll-cutoff', group: 'internal', kind: 'internal', title: 'Payroll cut-off', recurrence: 'monthly',
    needs: ['paydayDom'], leadDays: 0, effort: 30, blocked: 'toby',
    rule: 'Our own rule: hours, absence and changes are in N days before payday, so payroll is run and checked before the FPS is due (Company dates → “Payroll cut-off”).',
    source: SRC.own, evidence: 'The finalised payroll run for the month.',
    occurrences: ctx => monthsAround(ctx).map(({ y, m }) => ({ period: ym({ y, m }), label: `Pay date in ${monthName(m)} ${y}`, internal: addDays(paydayIn(ctx, y, m), -ctx.cutoffDays) })) },

  { code: 'p60', group: 'payroll', kind: 'statutory', title: 'P60s to employees', recurrence: 'annual',
    needs: [], leadDays: 14, effort: 45, blocked: 'toby',
    rule: 'Every employee on the payroll at 5 April must have a P60 by 31 May.',
    source: SRC.p60, evidence: 'The P60 batch as issued (payroll software) and the date it was sent.',
    occurrences: ctx => taxYearEnds(ctx).map(e => ({ period: `TY${taxYearLabel(e)}`, label: `Tax year ${taxYearLabel(e)}`, statutory: `${parse(e).y}-05-31` })) },

  { code: 'rti-final-fps', group: 'payroll', kind: 'statutory', title: 'Final FPS of the tax year', recurrence: 'annual',
    needs: ['paydayDom'], leadDays: 3, effort: 15, blocked: 'toby',
    rule: '“Send your final Full Payment Submission (FPS) on or before your employees’ last payday of the tax year (which ends on 5 April).” Wren takes the last payday on or before 5 April from your payday setting.',
    source: SRC.finalFps, evidence: 'The payroll software’s submission receipt for the last pay date.',
    occurrences: ctx => taxYearEnds(ctx).map(e => {
      const { y } = parse(e);
      let last = paydayIn(ctx, y, 4);
      if (last > e) last = paydayIn(ctx, y, 3);
      return { period: `TY${taxYearLabel(e)}`, label: `Tax year ${taxYearLabel(e)}`, statutory: last };
    }) },

  { code: 'bank-reconciliation', group: 'internal', kind: 'internal', title: 'Bank accounts reconciled', recurrence: 'monthly',
    needs: [], leadDays: 0, effort: 45, blocked: 'toby', attests: true,
    rule: 'Our own rule: every bank account reconciled in Xero by day N of the following month. Marking it done records “reconciled through” — the termly money report only trusts months up to that date, and refuses to give a number for anything later.',
    source: SRC.own, evidence: 'Xero’s Bank Reconciliation Summary report for the month, kept with the month’s papers.',
    occurrences: ctx => monthsAround(ctx).map(({ y, m }) => {
      const n = nextMonth({ y, m });
      return { period: ym({ y, m }), label: `${monthName(m)} ${y}`, internal: fmt({ y: n.y, m: n.m, d: ctx.reconDom }),
               month_end: fmt({ y, m, d: daysInMonth(y, m) }) };
    }) },

  { code: 'xero-catch-up', group: 'internal', kind: 'internal', title: 'Xero brought up to date', recurrence: 'monthly',
    needs: [], leadDays: 0, effort: 60, blocked: 'toby',
    rule: 'Our own rule: every transaction for the month coded in Xero and receipts attached by day N of the following month, so the accountant is never working from a month that is still moving.',
    source: SRC.own, evidence: 'A note of what was outstanding and cleared, or the Xero “to reconcile” count at zero.',
    occurrences: ctx => monthsAround(ctx).map(({ y, m }) => {
      const n = nextMonth({ y, m });
      return { period: ym({ y, m }), label: `${monthName(m)} ${y}`, internal: fmt({ y: n.y, m: n.m, d: ctx.xeroDom }) };
    }) },
];

/** Listed, dated in words, and NEVER scheduled: each is conditional, and a made-up date is worse than none. */
const CONDITIONAL = [
  { code: 'vat', title: 'VAT registration', when: 'Only if taxable turnover passes £90,000 in any rolling 12 months.',
    rule: '“You have to register within 30 days of the end of the month when you went over the threshold”; the effective date is the first day of the second month after. Exempt supplies do not count towards taxable turnover — ask the accountant whether any of the nursery’s income is taxable before treating this as applicable.',
    source: SRC.vat },
  { code: 'eps', title: 'Employer Payment Summary (EPS)', when: 'Only if there is a reduction to claim — for example statutory pay you are recovering.',
    rule: 'Send an EPS by the 19th of the following tax month to claim any reduction on what you owe HMRC.', source: SRC.fps },
  { code: 'paye-quarterly', title: 'PAYE paid quarterly', when: 'Only if HMRC has told you that you may pay quarterly.',
    rule: 'Due “the 22nd after the end of the quarter — for example, 22 July for the 6 April to 5 July quarter.” The FPS is still due on every payday.', source: SRC.payePay },
  { code: 'p11d', title: 'P11D, P11D(b) and Class 1A National Insurance', when: 'Only if the company gave anyone expenses or benefits that must be reported.',
    rule: 'Report by 6 July after the tax year ends; pay any Class 1A National Insurance by 22 July (19 July if paying by cheque).', source: SRC.p11d },
  { code: 'ct-instalments', title: 'Corporation Tax by instalments', when: 'Only if the company’s taxable profits are over £1.5 million.',
    rule: 'Companies with taxable profits over £1.5 million pay in instalments rather than 9 months and 1 day after the period end, so the Corporation Tax date above would be wrong. Not modelled — ask the accountant.', source: SRC.ctPay },
];

const RULE_BY_CODE = Object.fromEntries(RULES.map(r => [r.code, r]));

// ── the schedule ─────────────────────────────────────────────────────────────
const PARTIES = ['toby', 'accountant', 'bank', 'hmrc'];

/**
 * Expand every rule into dated occurrences.
 *
 * @returns {{
 *   occurrences: object[],   // dated, sorted by due date
 *   needs: object[],         // rules that cannot be scheduled until a company date is entered
 *   conditional: object[],   // “only if…” rows — no dates
 *   tracking_from: string,
 * }}
 */
function buildSchedule(ctx, { horizonDays = 430 } = {}) {
  const today = ctx.today;
  const from = ctx.trackingFrom || addDays(today, -35);
  const horizon = addDays(today, horizonDays);
  const occurrences = [], needs = [];

  for (const rule of RULES) {
    const missing = rule.needs.filter(k => ctx[k] == null);
    if (missing.length) { needs.push({ rule: rule.code, title: rule.title, missing: missing.map(k => NEED_LABEL[k]), keys: missing }); continue; }

    const lead = ctx.leads[rule.code] != null ? ctx.leads[rule.code] : rule.leadDays;
    for (const o of rule.occurrences(ctx)) {
      let statutory = o.statutory || null, internal = o.internal || null;
      if (statutory && internal == null) {
        // Our own earlier date: statutory minus the lead time, stepped BACK off a
        // non-working day, and never past the statutory date itself.
        internal = prevWorkingDay(addDays(statutory, -lead), ctx.holidays);
        if (internal > statutory) internal = statutory;
      } else if (internal && !statutory) {
        // An internal-only job (bank reconciliation, Xero catch-up, payroll cut-off, the accountant's pack) is never planned for
        // a weekend or a bank holiday either: a cut-off that lands on a Sunday is a cut-off nobody can meet.
        internal = prevWorkingDay(internal, ctx.holidays);
      }
      const marker = o.marker || null;
      const due = statutory || internal || marker;
      const first = internal || statutory || marker;

      if (marker) { if (marker < addDays(today, -30) || marker > horizon) continue; }
      else if (due < from || first > horizon) continue;

      occurrences.push({
        key: `${rule.code}:${o.period}`,
        rule: rule.code, period: o.period, label: o.label,
        group: rule.group, kind: rule.kind, title: rule.title, recurrence: rule.recurrence,
        statutory, internal, marker, due,
        blocked_on: rule.blocked, effort_minutes: rule.effort,
        lead_days: rule.kind === 'statutory' ? lead : null,
        verify: !!o.verify, month_end: o.month_end || null, attests: !!rule.attests,
      });
    }
  }
  occurrences.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : a.key < b.key ? -1 : 1));
  return { occurrences, needs, conditional: CONDITIONAL, tracking_from: from };
}

const NEED_LABEL = {
  yearEndMd: 'the company’s financial year end',
  csReviewEnd: 'the Companies House review-period end date',
  pensionStart: 'the pension duties start date',
  paydayDom: 'the day of the month staff are paid',
  packDays: 'the accountant’s deadline for the year-end pack (days after year end)',
};

/**
 * Where an OPEN occurrence stands today. This is only the calendar's own
 * vocabulary (upcoming / due soon / overdue) — the colour on the board and on the
 * screen is decided by src/services/attention/rag.js, the one place colours are
 * decided, and not here.
 */
function phaseOf(o, today) {
  if (o.marker) return 'marker';
  const first = o.internal || o.statutory;
  if (today < first) return 'upcoming';
  const end = o.statutory || o.internal;
  if (today > end) return 'overdue';
  return 'due_soon';
}

/** The public description of a rule — the screen prints this next to every date it shows. */
function describeRule(code) {
  const r = RULE_BY_CODE[code];
  if (!r) return null;
  return { code: r.code, title: r.title, group: r.group, kind: r.kind, recurrence: r.recurrence,
           rule: r.rule, source: r.source, evidence: r.evidence, default_lead_days: r.kind === 'statutory' ? r.leadDays : null,
           default_blocked_on: r.blocked, needs: r.needs.map(k => NEED_LABEL[k]) };
}

module.exports = {
  // engine
  RULES, CONDITIONAL, PARTIES, SETTING_KEYS, DEFAULTS, NEED_LABEL,
  readContext, buildSchedule, phaseOf, describeRule,
  // date helpers (exported so the verifier can test them directly)
  isIso, parse, fmt, addDays, addMonths, weekday, diffDays, daysInMonth,
  prevWorkingDay, isNonWorking, fyEndInYear, paydayIn, niceDate, validMd,
};
