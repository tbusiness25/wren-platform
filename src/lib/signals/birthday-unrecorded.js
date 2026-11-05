'use strict';
/**
 * b311 signal — a child on the roll with no date of birth.
 *
 * THE QUESTION
 *   How many children who are on the roll today have date_of_birth NULL?
 *
 * This is not a tidiness complaint. A missing DOB silently breaks four things
 * that all read it: the ratio engine's age banding (the child is counted in no
 * band at all — see bookedChildrenByBand, which filters on
 * `c.date_of_birth IS NOT NULL`), funding eligibility, the room-move engine,
 * and the age-out date the occupancy forecast is built from. So the count is
 * the finding, and the consequence is what makes it worth saying out loud.
 *
 * COUNTS, NEVER NAMES. The notification says how many and links to the list.
 * That is rule 4 satisfied — a count is traceable back to rows — and it keeps
 * this signal out of the child-name question entirely.
 */

const U = require('./_util');

module.exports = {
  key: 'birthday_unrecorded',
  label: 'Children on the roll with no date of birth',
  question: 'How many children in attendance have no date_of_birth?',
  category: 'signal_child_record_gap',
  priority: 30,
  recipients: 'all-managers',
  link: '/admin/children',
  defaults: {
    min_children: 1,
    cooldown_hours: 24 * 14,   // a fortnight: this is a job, not an alarm
    min_gap_hours: 24 * 3,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;
    const { rows } = await db.query(
      `SELECT count(*)::int AS n
         FROM children
        WHERE date_of_birth IS NULL
          AND COALESCE(is_active, true) = true
          AND COALESCE(is_demo, false) = false
          AND erased_at IS NULL
          AND (leave_date IS NULL OR leave_date >= $1::date)
          AND (start_date IS NULL OR start_date <= $1::date)`,
      [today]);
    const n = rows[0].n;
    if (n < cfg.min_children) return null;

    return {
      fingerprint: U.fingerprint({ n }),
      headline: `${n} ${U.plural(n, 'child', 'children')} on the roll ${U.plural(n, 'has', 'have')} no date of birth on record. `
        + `Without it they are counted in no age band, so they are invisible to ratios, funding and room moves.`,
      facts: { children_without_dob: n, as_of: today },
    };
  },
};
