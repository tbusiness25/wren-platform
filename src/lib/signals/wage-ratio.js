'use strict';
/**
 * b365 signal — the wage bill is running above its share of fee income.
 *
 * THE QUESTION
 *   For the most recent COMPLETE month that has both a payroll run and fee
 *   income: is employer staff cost above `max_pct` of fee income?
 *
 * ── THE FIGURE, AND THE TWO THINGS IT IS NOT ────────────────────────────────
 * Employer cost = gross + employer NI. Employee tax, NI and pension come OUT of
 * gross and are already inside it. Employer PENSION is not modelled by Wren at
 * all, so this UNDERSTATES the true cost — which means a signal that fires is
 * certainly right and a silent one may still be wrong. The headline says so.
 *
 * It is also not the "Salary Cost Ratio" the Finance dashboard used to show.
 * b301 found that tile was computing every expense over revenue and labelling it
 * salary: 95% on wren_dev against a real wage bill of 24%. This reads
 * payroll_runs, which is the wage bill.
 *
 * ── WHICH INCOME ────────────────────────────────────────────────────────────
 * Fees BILLED for that month's care (b365's invoice-period rule), not money
 * received in the month. A family paying late does not make the staff cheaper,
 * and a ratio that moves because somebody settled an old invoice is noise.
 *
 *
 * ── WHERE THE THRESHOLDS COME FROM ──────────────────────────────────────────
 * `defaults` below is the fallback. The live value is the SETTING, read through
 * ctx.setting(), so Toby can move it from the Settings screen without a deploy.
 * That also means the Roost "what would this say if…" preview and the test
 * harness change a threshold by overriding the SETTING (runner.makeSettingReader
 * takes overrides), not by passing cfg — cfg loses to a setting that exists, and
 * that precedence is deliberate: the stored value is what the nursery is running on.
 * ── IT WILL NOT SPEAK ABOUT AN OPEN MONTH ───────────────────────────────────
 * A draft payroll run for a month still being traded compares a partial wage
 * bill against partial income; the answer is meaningless in both directions.
 * Only finalised runs over closed months are considered.
 */

const U = require('./_util');

module.exports = {
  key: 'wage_ratio',
  label: 'Wage bill above its share of fee income',
  question: 'Is employer staff cost above N% of the fees billed for the last complete month?',
  category: 'signal_wage_ratio',
  priority: 20,
  recipients: 'all-managers',
  link: '/app.html#finance/pnl',
  defaults: {
    max_pct: 55,               // overridden by settings.finance_wage_ratio_max_pct
    min_income_pence: 100000,  // below £1,000 of income a ratio is arithmetic, not a finding
    cooldown_hours: 24 * 21,
    min_gap_hours: 24 * 7,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;
    const maxPct = parseFloat(await ctx.setting('finance_wage_ratio_max_pct', String(cfg.max_pct))) || cfg.max_pct;
    const t = U.parts(today);

    // The last COMPLETE month. Standing on 29 September, that is August.
    const prev = t.m === 1 ? { y: t.y - 1, m: 12 } : { y: t.y, m: t.m - 1 };

    // The run is read through src/lib/payroll-costs.js, not queried here: that
    // module is b301's single definition of employer cost, and it back-fills
    // employer NI for runs generated before it had a column. Querying
    // payroll_runs directly made this notification disagree with the Finance
    // screen it links to by exactly that NI — measured on wren_dev 2026-09-29,
    // July 2026 read 73.3% here and 75.6% there.
    const costs = require('../payroll-costs');
    const all = await costs.payrollMonths(db, { limit: 36 }).catch(() => []);
    const runs = all
      .filter(r => r.finalised && r.period_year && r.period_month
                && (r.period_year * 12 + r.period_month) <= (prev.y * 12 + prev.m))
      .sort((a, b) => (b.period_year * 12 + b.period_month) - (a.period_year * 12 + a.period_month));
    if (!runs.length) {
      return { dormant: true, reason: 'no finalised payroll run covers a complete month' };
    }
    const run = runs[0];
    const gross = run.gross_pence;
    const erNi = run.employer_ni_stored ? run.employer_ni_pence : null;
    const cost = run.employer_cost_pence;
    if (!cost) return { dormant: true, reason: 'the payroll run for that month records no gross pay' };

    // Fees billed for that month's care — the same period rule as b365 part 1.
    const AP = require('../allocation-period');
    const { rows: [inc] } = await db.query(
      `SELECT COALESCE(SUM(i.amount_pence), 0)::bigint AS billed_pence,
              count(*)::int                            AS invoices
         FROM invoices i
         ${AP.PERIOD_SQL}
        WHERE i.credit_note_for_id IS NULL
          AND COALESCE(i.status,'') NOT IN ('draft','void','cancelled')
          AND ap.period_year = $1 AND ap.period_month = $2`,
      [run.period_year, run.period_month]);

    const income = Number(inc.billed_pence);
    if (income < cfg.min_income_pence) {
      return { dormant: true,
               reason: `only £${(income / 100).toFixed(2)} of fees is recorded for that month — too little to form a ratio` };
    }

    const pct = (cost / income) * 100;
    if (pct <= maxPct) return null;   // silence is the success case

    const money = p => `£${(p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
    const label = U.monthLabel(run.period_year, run.period_month);
    // erNi is null when the run stored none and b301 recomputed it from the run
    // total. The figure IS included — it is just slightly generous, because the
    // NI threshold is per person per month and a run total cannot see that.
    const niNote = erNi == null
      ? ' Employer NI was not stored on that run and has been recomputed from the run total, so treat it as approximate.'
      : '';

    return {
      fingerprint: U.fingerprint({ run: run.run_id, pct: Math.round(pct) }),
      headline: `Staff cost was ${pct.toFixed(1)}% of fee income in ${label} — ${money(cost)} against `
        + `${money(income)} billed — above the ${maxPct}% you set. Employer pension is not included, `
        + `so the real share is higher than this.${niNote}`,
      facts: {
        period: `${run.period_year}-${String(run.period_month).padStart(2, '0')}`,
        payroll_run_id: run.run_id, staff_count: run.staff_count,
        gross_pence: gross, employer_ni_pence: run.employer_ni_pence,
        employer_ni_stored: run.employer_ni_stored, employer_cost_pence: cost,
        fees_billed_pence: income, invoices: inc.invoices,
        ratio_pct: Number(pct.toFixed(1)), threshold_pct: maxPct,
        basis: 'Employer cost = gross + employer NI. Employee tax/NI/pension are already inside gross. '
             + 'Employer PENSION is not modelled by Wren, so this understates true staff cost.',
      },
    };
  },
};
