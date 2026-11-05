'use strict';
/**
 * payroll-costs.js — b301 (2026-09-10)
 *
 * The bridge between Staff → Payroll and the Finance section.
 *
 * Toby: "it would also be good to link all of our payroll records with the
 * Finance section."
 *
 * Until now the only staff-cost figure Finance had came from Xero: either the
 * P&L lines whose ACCOUNT NAME matched /salar|wages?|payroll|pension|.../ in
 * finance-facts.js, or — on the dashboard tile labelled "Salary Cost Ratio" —
 * every expense divided by revenue, which is not a salary figure at all. Wren
 * generates its own payroll runs and neither of those read them.
 *
 * ── WHAT "STAFF COST" MEANS HERE, EXACTLY ───────────────────────────────────
 * Employer cost = total gross pay + employer's National Insurance.
 *
 *   IN   gross pay (what the run says people earned, before their own tax, NI
 *        and pension come out of it)
 *   IN   employer's NI, 13.8% of gross above the monthly primary threshold
 *   OUT  the employee's tax, NI and pension — those come OUT of gross and are
 *        already inside it. Adding them would count the same money twice.
 *   OUT  employer pension contributions. Wren does not model them: only the
 *        employee's 3% is calculated. So this figure is an UNDERSTATEMENT of
 *        true employer cost by roughly the employer's pension percentage, and
 *        every caller is told so via `excludes`.
 *
 * Everything here is an ESTIMATE, for the same reason the payroll screen says so:
 * basic-rate PAYE only, no tax-code arithmetic, no NI category letters. It is
 * good enough to put next to revenue and wrong enough that nobody should file it.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * This module returns money and does NO permission checking. Every caller must
 * gate it on canViewSalaries() from src/lib/capabilities.js — a floor manager
 * (staff.role 'manager' since b271) legitimately reads the Finance section and
 * must not see the wage bill. See src/routes/finance-intel.js.
 */

const { PAYE } = require('./payroll-engine');

const num = v => (v == null ? 0 : Number(v));

/** A payroll_runs row -> employer cost in pence, with employer NI back-filled. */
function employerCostPence(run) {
  const gross = num(run.total_gross_pence);
  // Runs generated before b301 have no stored employer NI. Recomputing it from the
  // run total rather than per line is slightly generous — the threshold is per
  // person per month — so a back-filled figure is marked `estimated_employer_ni`
  // and the run is re-priced properly the next time a line is edited.
  const stored = run.total_employer_ni_pence;
  const erNI = stored != null
    ? num(stored)
    : Math.round(Math.max(0, gross - PAYE.ni_primary_threshold_monthly_pence
                                     * num(run.staff_count)) * PAYE.ni_employer_rate);
  return { gross, employer_ni: erNI, total: gross + erNI, employer_ni_stored: stored != null };
}

const ymd = d => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  // pg hands back a DATE as a local-midnight Date; toISOString() would shift it
  // back a day for anyone west of UTC. Read the local parts.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Every payroll run as a monthly staff-cost figure, newest first.
 * Returns [] when payroll has never been run — never a zero, which would read as
 * "we spent nothing on staff".
 */
async function payrollMonths(db, { limit = 24 } = {}) {
  const { rows } = await db.query(`
    SELECT r.id, r.period_label, r.period_year, r.period_month, r.period_from, r.period_to,
           r.status, r.staff_count, r.total_gross_pence, r.total_tax_pence, r.total_ni_pence,
           r.total_pension_pence, r.total_net_pence, r.total_employer_ni_pence,
           r.period_shape, r.warning_count, r.finalised_at,
           COUNT(l.id)::int AS line_count,
           COUNT(l.id) FILTER (WHERE l.hours_inferred)::int AS inferred_lines
      FROM payroll_runs r
      LEFT JOIN payroll_staff_lines l ON l.run_id = r.id
     GROUP BY r.id
     ORDER BY r.period_year DESC, r.period_month DESC
     LIMIT $1`, [limit]).catch(() => ({ rows: [] }));

  return rows.map(r => {
    const cost = employerCostPence(r);
    return {
      run_id: r.id,
      month: `${r.period_year}-${String(r.period_month).padStart(2, '0')}`,
      period_year: Number(r.period_year),
      period_month: Number(r.period_month),
      period_label: r.period_label,
      period_from: ymd(r.period_from),
      period_to: ymd(r.period_to),
      period_shape: r.period_shape,
      status: r.status,
      finalised: r.status === 'finalised',
      staff_count: Number(r.staff_count) || 0,
      line_count: r.line_count,
      // A run whose hours were inferred from the rota rather than clocked is a
      // weaker figure, and the Finance surface says which.
      inferred_lines: r.inferred_lines,
      warning_count: Number(r.warning_count) || 0,
      gross_pence: cost.gross,
      employer_ni_pence: cost.employer_ni,
      employer_cost_pence: cost.total,
      employer_ni_stored: cost.employer_ni_stored,
      // Kept for the drill-through panel; not part of employer cost.
      employee_tax_pence: num(r.total_tax_pence),
      employee_ni_pence: num(r.total_ni_pence),
      employee_pension_pence: num(r.total_pension_pence),
      net_pence: num(r.total_net_pence),
    };
  });
}

/** The same thing keyed by 'YYYY-MM', for joining onto a P&L period. */
async function payrollByMonth(db, opts) {
  const out = new Map();
  for (const m of await payrollMonths(db, opts)) {
    // One run per calendar month is enforced by a UNIQUE constraint on
    // payroll_runs(period_year, period_month), so this cannot collide.
    out.set(m.month, m);
  }
  return out;
}

/**
 * ── b303 (2026-09-10): can we actually run payroll for these people? ────────
 *
 * A tax code or an employee statement missing for somebody with a LIVE CONTRACT
 * is not a data-tidiness nag, it is a payroll problem: without a code the run
 * falls back to a basic-rate estimate, and without a statement (and without a
 * P45 to supersede it) the employer has nothing on file saying which code was
 * right. b303 put the starter checklist's questions on the form a new starter
 * fills in; this is what notices when they were never answered.
 *
 * COUNTS ONLY. This function returns numbers and a link and NEVER a name — the
 * board and the Finance tab both render it verbatim, and neither is a place to
 * publish which member of staff has no NI number on file. The person who needs
 * to know that opens the staff record. (memory/feedback_counts_only_every_write_path.md)
 *
 * "Live contract" = active, not terminated, and not past a contract_end.
 * Somebody who left in June is not a payroll problem in September.
 *
 * Tolerates a tenant that has not run the b303 migration: the columns are read
 * through to_jsonb so a missing one yields NULL rather than a 42703, and the
 * caller gets `available:false` instead of an exception.
 */
async function payrollReadiness(db) {
  const LIVE = `s.is_active = true
                AND COALESCE(s.terminated, false) = false
                AND (s.contract_end IS NULL OR s.contract_end >= CURRENT_DATE)`;
  try {
    const { rows } = await db.query(`
      SELECT
        COUNT(*)::int AS live_contracts,
        COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(s.tax_code,'')),'') IS NULL)::int
          AS missing_tax_code,
        COUNT(*) FILTER (WHERE s.starter_declaration IS NULL
                           AND COALESCE(s.p45_provided, false) = false)::int
          AS missing_declaration,
        COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(s.ni_number,'')),'') IS NULL)::int
          AS missing_ni_number,
        COUNT(*) FILTER (WHERE s.student_loan_plan IS NULL)::int
          AS missing_student_loan,
        COUNT(*) FILTER (WHERE NULLIF(btrim(COALESCE(s.tax_code,'')),'') IS NULL
                            OR (s.starter_declaration IS NULL
                                AND COALESCE(s.p45_provided, false) = false))::int
          AS people_affected
      FROM staff s
      WHERE ${LIVE} AND COALESCE(s.is_demo, false) = false`);
    const r = rows[0] || {};
    return {
      available: true,
      live_contracts: Number(r.live_contracts) || 0,
      missing_tax_code: Number(r.missing_tax_code) || 0,
      missing_declaration: Number(r.missing_declaration) || 0,
      missing_ni_number: Number(r.missing_ni_number) || 0,
      missing_student_loan: Number(r.missing_student_loan) || 0,
      // The headline: people for whom payroll cannot be run properly. NI number
      // and student loan are deliberately NOT in it — they change what a payslip
      // says, but a run without them still produces a defensible figure.
      people_affected: Number(r.people_affected) || 0,
      action_url: '/admin/finance/payroll',
      basis: 'Live contract = active, not terminated, not past a contract end date. '
           + 'A P45 supersedes the employee statement, so somebody with one is not counted as missing it.',
      // Said on every surface, so nobody reads this as an HMRC filing state.
      not_a_filing: 'Wren does not file with HMRC. This is what the employer needs on file to operate PAYE.',
    };
  } catch (e) {
    // A tenant without the b303 columns, or without a staff table at all.
    return { available: false, reason: e.message, live_contracts: 0, people_affected: 0 };
  }
}

/** The standing caveat. Any surface showing these figures must show this too. */
const BASIS = 'Employer cost = gross pay + employer NI (13.8% above the monthly primary '
            + 'threshold). Employee tax, NI and pension are already inside gross and are not '
            + 'added again. Employer pension contributions are NOT modelled, so this '
            + 'understates true employer cost. PAYE figures are basic-rate estimates — use '
            + 'BrightPay, Sage or Xero Payroll for anything filed.';

const EXCLUDES = ['employer pension contributions', 'agency and cover staff paid outside payroll',
                  'apprenticeship levy', 'employment allowance relief'];

module.exports = { payrollMonths, payrollByMonth, employerCostPence, payrollReadiness, BASIS, EXCLUDES };
