'use strict';
/**
 * b311 signal — pay day is close and this month's payroll run does not exist.
 *
 * THE QUESTION
 *   Is pay day within `lead_days`, and is there no ladn.payroll_runs row for
 *   the current period?
 *
 * "No row" is the honest test rather than "no FINALISED row": b228 found that
 * creating a payroll run had never actually worked, so a half-finished draft is
 * a real sign that somebody has started, and nagging them about it would be the
 * cron behaviour this build exists to avoid. A draft silences the signal; the
 * headline says so, so the manager can see which of the two states they are in.
 *
 * Pay day is settings.payroll_pay_day (seeded 28).
 */

const U = require('./_util');

module.exports = {
  key: 'payroll_run_due',
  label: 'Pay day coming up, payroll run not created',
  question: 'Is pay day within N days with no payroll_runs row for the period?',
  category: 'signal_payroll_run',
  priority: 11,
  recipients: 'all-managers',
  link: '/admin/payroll',
  defaults: {
    lead_days: 5,
    grace_days: 2,
    cooldown_hours: 48,
    min_gap_hours: 24,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;
    const payDay = parseInt(await ctx.setting('payroll_pay_day', '28'), 10) || 28;

    const t = U.parts(today);
    let payDate = U.dayOfMonth(t.y, t.m, payDay);
    if (U.daysBetween(today, payDate) < -cfg.grace_days) {
      const nm = U.nextMonth(t.y, t.m);
      payDate = U.dayOfMonth(nm.y, nm.m, payDay);
    }
    const pd = U.parts(payDate);
    const daysAway = U.daysBetween(today, payDate);
    if (daysAway > cfg.lead_days || daysAway < -cfg.grace_days) return null;

    const { rows } = await db.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE status = 'finalised')::int AS finalised
         FROM payroll_runs
        WHERE period_year = $1 AND period_month = $2`,
      [pd.y, pd.m]);
    const n = rows[0].n;

    if (n > 0) return null;   // somebody has started it.

    const label = U.monthLabel(pd.y, pd.m);
    const when = daysAway >= 0
      ? `Pay day is the ${U.ordinal(payDay)} — ${U.inDays(daysAway)}.`
      : `Pay day was the ${U.ordinal(payDay)}, ${U.inDays(daysAway)}.`;

    return {
      fingerprint: U.fingerprint({ period: `${pd.y}-${pd.m}`, n }),
      headline: `No payroll run exists for ${label}. ${when}`,
      facts: { period_year: pd.y, period_month: pd.m, pay_date: payDate,
               days_away: daysAway, payroll_runs_for_period: n },
    };
  },
};
