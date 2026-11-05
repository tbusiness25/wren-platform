'use strict';
// accountant-gate.js — b480 (2026-10-12)
//
// Nathan (Toby's brother, external accountant) was using Toby's own Roost login
// because staff id 23 (role 'manager' on prod) was never on the Roost person
// allowlist (ladn.settings 'roost_admin_staff_ids' — see src/lib/roost-allowlist.js).
// This is the boundary that makes a real 'accountant' role safe to let into
// Roost WITHOUT that allowlist: every request carrying an 'accountant' JWT must
// be a GET/HEAD, and must match one of the finance paths below. Anything else —
// a write verb, or a GET outside this list (children, observations, diary,
// safeguarding, SEN, HR, staff, settings, messages…) — is refused here, before
// the request reaches any route file.
//
// This is the hard boundary, not the nav (ladn.nav_layout role='accountant' rows
// just hide the sidebar items — presentation only, per nav-layout.js's own header
// comment) and not the per-route 'manager'/'deputy_manager'/'admin' role arrays
// (widened additively in the finance route files to also accept 'accountant' —
// safe only BECAUSE this gate has already restricted which paths an accountant
// token can ever reach).
//
// Deliberately narrower than the whole Finance nav group: fee-sandbox (rate
// modelling), fee-schedule (itemised billing setup), stretch-recon, supplier-
// register and finance-hmrc (tax calendar) are NOT finance *reporting* — none
// of them are in Toby's list ("Invoices & Payments, Funding, Reconcile, statements,
// forecasts, the accountant data pack export, Xero status") — so they stay out.
// finance-intel.js (AI financial intelligence, guards the wage bill explicitly)
// and finance-wages.js/finance-payroll.js (staff pay) are also deliberately
// excluded, on top of the staff-pay fields already being stripped by
// canViewSalaries() for anyone without view_staff_salaries — accountant never
// gets that capability, so even a route reachable here degrades the payroll
// lines rather than ever omitting a 403 and leaking them.
//
// /api/finance/accountant-pack is the b481 export (built on the same 'track
// money' as the rest of the money UI) — both the nested and a possible
// top-level mount are allow-listed here ahead of it landing. See NOTES.
const ACCOUNTANT_ALLOWED_PATHS = [
  /^\/money(\/|$)/i,
  /^\/finance\/invoices(\/|$)/i,
  /^\/finance\/payments(\/|$)/i,
  /^\/finance\/opening-balance(\/|$)/i,
  /^\/finance\/payment-plan(\/|$)/i,
  /^\/finance\/reconcile(\/|$)/i,
  /^\/finance\/payment-matching(\/|$)/i,
  // b524 (2026-10-21) — Finance → Accounts, the one money home. Nathan is the
  // bookkeeper and this is the page he lands on. READ-ONLY comes from the gate
  // itself (GET/HEAD only, enforced in server-unified.js before any route runs),
  // not from anything in the router — so no write path is opened by listing it.
  //
  // What it returns: fee-run counts and totals, payroll run TOTALS, the bank
  // summary, Ealing funding expected-vs-received by age band, the auto-allocate
  // queue and the duplicate-line dry run. No child, family, bill-payer or staff
  // NAME, and no line of bank text, by construction (see the router's header).
  //
  // Pay: accountant never holds view_staff_salaries, so canViewSalaries() is
  // false and the payroll figures are OMITTED from /accounts/home rather than
  // zeroed, and /accounts/payroll-runs, /accounts/payroll/* and /accounts/ledger
  // 403 on requireSalaryView inside the router. Listing the prefix here does not
  // widen that — it is a second gate, not this one.
  /^\/finance\/accounts(\/|$)/i,
  /^\/finance\/forecast(\/|$)/i,
  /^\/finance\/dashboard(\/|$)/i,
  /^\/finance\/pnl(\/|$)/i,
  /^\/finance\/reports(\/|$)/i,
  /^\/finance\/termly-report(\/|$)/i,
  /^\/finance\/status$/i,              // finance-xero.js — Xero connection status
  /^\/finance\/xero\/accounts$/i,
  /^\/finance\/xero\/monthly-pl$/i,
  /^\/finance\/xero\/push-candidates$/i,
  /^\/finance\/accountant-pack(\/|$)/i, // b481's export, nested guess
  /^\/accountant-pack(\/|$)/i,          // b481's export, top-level guess
  /^\/funding\/terms(\/|$)/i,
  /^\/funding\/calendar$/i,
  // b480 review F2: /funding/child/:id removed — it returns child_funding.* (carer NI
  // number, declaration_token) and no finance page calls it (only child-profile.html).
  /^\/payments-admin\/ledger(\/|$)/i,
  // The shell itself — every Roost page calls these on boot, accountant's
  // page included. None of these name a child, a family or a colleague.
  /^\/auth\/(me|logout|refresh)$/i,
  /^\/nav-layout(\/|$)/i,
  // b480 review F3: the old pattern's optional group also matched '/notifications/',
  // the full notification list (bodies included) for this staff id.
  /^\/notifications\/(unread-count|prefs)$/i,
];

function isAccountantRole(role) {
  return role === 'accountant';
}

function isAccountantPathAllowed(path) {
  const p = String(path || '');
  return ACCOUNTANT_ALLOWED_PATHS.some((re) => re.test(p));
}

module.exports = { ACCOUNTANT_ALLOWED_PATHS, isAccountantRole, isAccountantPathAllowed };
