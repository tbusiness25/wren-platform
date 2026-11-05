'use strict';
/**
 * b311 signal — a large share of the roll ages out next September.
 *
 * Toby: "it could even say next September lots of your children are going to be
 * leaving so change your availability now … it's much better at predicting
 * things than I am because by then it's often too late."
 *
 * This is the signal that is furthest from a reminder. Nothing is due, nothing
 * is late, and no screen in Wren is red. It is arithmetic on dates of birth
 * that a person would have to sit down and do on purpose.
 *
 * THE QUESTION
 *   On the next 1 September, how many of today's children will have reached
 *   school age — and what share of the roll is that?
 *
 * "School age" is settings.school_start_age_months (60), the same number the
 * admissions engine and the public availability heat-map use to free a seat.
 * Using anything else here would make this notification disagree with the
 * occupancy screen it tells you to go and look at.
 *
 * THE WINDOW is what stops it being useless. It speaks between `max_days_ahead`
 * and `min_days_ahead` before the September in question — roughly November to
 * early July — because "change your availability now" is only advice while
 * there is a now to change it in.
 */

const U = require('./_util');

module.exports = {
  key: 'autumn_exodus',
  label: 'Big September leaving cohort',
  question: 'What share of today\'s roll reaches school age by the next 1 September?',
  category: 'signal_occupancy_forecast',
  priority: 40,
  recipients: 'all-managers',
  link: '/occupancy-v2.html',
  defaults: {
    min_children: 4,
    min_share: 0.2,          // a fifth of the roll
    min_days_ahead: 60,      // stop ~2 months out: too late to fill the places
    max_days_ahead: 300,     // start ~10 months out
    cooldown_hours: 24 * 45,
    min_gap_hours: 24 * 14,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;
    const t = U.parts(today);
    // The next 1 September, counting today's 1 September as still ahead.
    const targetYear = (t.m > 9 || (t.m === 9 && t.d > 1)) ? t.y + 1 : t.y;
    const target = `${targetYear}-09-01`;
    const ahead = U.daysBetween(today, target);
    if (ahead > cfg.max_days_ahead || ahead < cfg.min_days_ahead) return null;

    const schoolMonths = parseInt(await ctx.setting('school_start_age_months', '60'), 10) || 60;

    const { rows } = await db.query(
      `WITH roll AS (
         SELECT id, date_of_birth, leave_date
           FROM children
          WHERE COALESCE(is_active, true) = true
            AND COALESCE(is_demo, false) = false
            AND erased_at IS NULL
            AND date_of_birth IS NOT NULL
            AND (start_date  IS NULL OR start_date  <= $1::date)
            AND (leave_date  IS NULL OR leave_date  >= $1::date)
       )
       SELECT count(*)::int AS roll,
              count(*) FILTER (
                WHERE (EXTRACT(YEAR FROM age($2::date, date_of_birth)) * 12
                     + EXTRACT(MONTH FROM age($2::date, date_of_birth))) >= $3
              )::int AS aging_out,
              count(*) FILTER (
                WHERE (EXTRACT(YEAR FROM age($2::date, date_of_birth)) * 12
                     + EXTRACT(MONTH FROM age($2::date, date_of_birth))) >= $3
                  AND leave_date IS NULL
              )::int AS unplanned
         FROM roll`,
      [today, target, schoolMonths]);

    const roll = rows[0].roll, agingOut = rows[0].aging_out, unplanned = rows[0].unplanned;
    if (!roll) return null;
    if (agingOut < cfg.min_children) return null;
    const share = agingOut / roll;
    if (share < cfg.min_share) return null;

    const pct = Math.round(share * 100);
    const planned = agingOut - unplanned;

    return {
      fingerprint: U.fingerprint({ target, agingOut, roll }),
      headline: `${agingOut} of your ${roll} children — ${pct}% of the roll — reach school age by 1 September ${targetYear}. `
        + `${planned} of them ${U.plural(planned, 'has', 'have')} a leaving date recorded; ${unplanned} ${U.plural(unplanned, 'does', 'do')} not.`,
      facts: { target_date: target, roll, aging_out: agingOut, unplanned,
               planned, share_pct: pct, school_start_age_months: schoolMonths,
               days_ahead: ahead },
    };
  },
};
