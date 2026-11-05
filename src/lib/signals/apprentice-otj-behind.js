'use strict';
/**
 * b317 signal — an apprentice is behind their off-the-job hours.
 *
 * THE QUESTION
 *   For each active apprenticeship with a target and an expected end date: do
 *   the hours still to log, spread over the weeks left, now need MORE per week
 *   than the training plan said — by enough of a margin to be real?
 *
 * WHY THIS AND NOT "hours logged is below X%"
 *   A percentage tells a manager something they can already see. The number
 *   that is worth interrupting someone for is the one they cannot work out at a
 *   glance: what the rate has to become from here. An apprentice sitting at 30%
 *   nine months in is fine; an apprentice at 30% with eight weeks left is not,
 *   and the same percentage describes both.
 *
 * WHY IT FIRES EARLY OR NOT AT ALL
 *   The whole point of Toby's brief is that the recording does not happen — so
 *   the FIRST thing this signal will find, in a nursery that has just started
 *   using it, is an apprentice with almost nothing logged. That is correct and
 *   it is the useful case: it is exactly the position somebody is in at the end
 *   of the year with no evidence. But it means the signal must be quiet where
 *   there is nothing to say:
 *     - no target set        -> dormant. Nagging about a number nobody entered
 *                               is how a signal gets muted, and then the real
 *                               one is missed too.
 *     - no expected end date -> skipped for that apprentice; there is no rate
 *                               to compute.
 *     - just started         -> `grace_days` after the start date, because a
 *                               fortnight's gap at the beginning is noise.
 *
 * NEVER NAMES A CHILD, and this one never carries any child data at all — it
 * counts staff records. It does name the apprentice: that is staff data going
 * to managers, which is the same audience the rest of the staff signals have,
 * and a headline that said "an apprentice" would send the manager hunting.
 */

const U = require('./_util');
const R = require('../otj-rules');

module.exports = {
  key: 'apprentice_otj_behind',
  label: 'An apprentice is behind their off-the-job hours',
  question: 'Does an apprentice now need more hours per week than planned to reach their target by their end date?',
  category: 'signal_apprentice_otj',
  priority: 34,
  recipients: 'all-managers',
  link: '/apprenticeships.html',
  defaults: {
    // How much worse than the plan counts as behind. 1.25 = "a quarter more per
    // week than we said" — under that, a fortnight of half-term catches it up.
    ratio_trigger: 1.25,
    // Where no weekly plan is recorded, fall back to the rate the whole
    // programme implies, and use the same margin against that.
    grace_days: 28,
    // Below this many hours still needed, it is not worth a notification
    // whatever the ratio says.
    min_remaining_hours: 10,
    cooldown_hours: 168,     // a week: this moves slowly, and so should the nag
    min_gap_hours: 72,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;

    const { rows } = await db.query(`
      SELECT a.id, a.staff_id, a.otj_target_hours, a.planned_weekly_hours,
             a.start_date, a.expected_end_date,
             s.first_name, s.last_name,
             COALESCE((SELECT sum(e.minutes) FROM otj_entries e
                        WHERE e.apprenticeship_id = a.id), 0)::int AS logged_minutes
        FROM apprenticeships a
        JOIN staff s ON s.id = a.staff_id
       WHERE a.status = 'active'
         AND COALESCE(s.is_active, true) = true
         AND COALESCE(s.terminated, false) = false
       ORDER BY a.id`);

    if (!rows.length) {
      return { dormant: true, reason: 'No active apprenticeships are recorded.' };
    }

    const withTarget = rows.filter(r => r.otj_target_hours != null && Number(r.otj_target_hours) > 0);
    if (!withTarget.length) {
      return {
        dormant: true,
        reason: `${rows.length} ${U.plural(rows.length, 'apprentice')} on file, but none has an off-the-job target set — enter it from the provider's training plan and this starts watching.`,
      };
    }

    const behind = [];
    for (const r of withTarget) {
      if (!r.expected_end_date) continue;
      // A fortnight into a programme there is nothing to judge.
      const start = U.ymd(r.start_date);
      if (start && U.daysBetween(start, today) < cfg.grace_days) continue;

      const p = R.progress({
        targetHours: r.otj_target_hours,
        loggedMinutes: r.logged_minutes,
        endDate: U.ymd(r.expected_end_date),
        today,
        plannedWeekly: r.planned_weekly_hours,
      });
      if (p.remaining == null || p.remaining < cfg.min_remaining_hours) continue;

      // Overdue is its own, worse, case: the end date has gone by and hours are
      // still owed. There is no rate to compute, so it is reported as itself.
      if (p.status === 'overdue') {
        behind.push({ r, p, bar: null, ratio: null, overdue: true });
        continue;
      }
      if (p.per_week_needed == null) continue;

      // The bar: the plan where there is one, otherwise the even rate the whole
      // programme implied from the day it started.
      let bar = (r.planned_weekly_hours != null && Number(r.planned_weekly_hours) > 0)
        ? Number(r.planned_weekly_hours) : null;
      if (bar == null && start) {
        const totalWeeks = U.daysBetween(start, U.ymd(r.expected_end_date)) / 7;
        if (totalWeeks > 0) bar = Number(r.otj_target_hours) / totalWeeks;
      }
      if (bar == null || bar <= 0) continue;

      const ratio = p.per_week_needed / bar;
      if (ratio >= cfg.ratio_trigger) {
        behind.push({ r, p, bar: Math.round(bar * 100) / 100, ratio: Math.round(ratio * 100) / 100, overdue: false });
      }
    }

    if (!behind.length) return null;

    // Worst first — the one with least time and most owed.
    behind.sort((a, b) => (b.overdue ? 1 : 0) - (a.overdue ? 1 : 0) || (b.ratio || 99) - (a.ratio || 99));
    const worst = behind[0];
    const name = `${worst.r.first_name} ${worst.r.last_name}`;

    const headline = worst.overdue
      ? `${name}'s apprenticeship end date has passed with ${worst.p.remaining} off-the-job hours still to log`
        + (behind.length > 1 ? `, and ${behind.length - 1} ${U.plural(behind.length - 1, 'other apprentice is', 'other apprentices are')} behind too.` : '.')
      : `${name} has ${worst.p.logged} of ${worst.p.target} off-the-job hours logged with ${worst.p.weeks_left} weeks left — `
        + `that is ${worst.p.per_week_needed} hours a week from here, against a plan of ${worst.bar}.`
        + (behind.length > 1 ? ` ${behind.length - 1} ${U.plural(behind.length - 1, 'other apprentice is', 'other apprentices are')} behind too.` : '');

    return {
      fingerprint: U.fingerprint({
        ids: behind.map(b => b.r.id).sort().join(','),
        // Bucketed so a tenth of an hour of new logging does not read as "the
        // numbers moved" and shorten the cooldown.
        worst: Math.round((worst.ratio || 0) * 4) / 4,
        overdue: worst.overdue,
      }),
      headline,
      facts: {
        apprentices_behind: behind.length,
        active_apprenticeships: rows.length,
        with_target: withTarget.length,
        worst: {
          apprenticeship_id: worst.r.id,
          staff_id: worst.r.staff_id,
          logged_hours: worst.p.logged,
          target_hours: worst.p.target,
          weeks_left: worst.p.weeks_left,
          per_week_needed: worst.p.per_week_needed,
          planned_weekly: worst.bar,
          overdue: worst.overdue,
        },
      },
      containsChildData: false,
    };
  },
};
