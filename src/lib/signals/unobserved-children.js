'use strict';
/**
 * b311 signal — children who have gone longer without an observation than the
 * setting's OWN standard allows.
 *
 * THE QUESTION
 *   How many children on the roll have no observation newer than
 *   observation_standards.max_gap_days_without_obs?
 *
 * The threshold is not invented here and it is not a national average. It is
 * the number this setting typed into Staff → Performance → Standards
 * (`max_gap_days_without_obs`, 14 on prod). Measuring practice against a number
 * a manager chose is the difference between a signal and a lecture; if they
 * think 14 days is wrong, the fix is to change the standard, and this signal
 * will immediately agree with them.
 *
 * Children who have been on the roll for less than the gap are excluded — a
 * child who started on Monday cannot be overdue on Wednesday.
 *
 * COUNTS, NEVER NAMES. The link opens the list.
 */

const U = require('./_util');

const DEFAULT_GAP_DAYS = 14;

module.exports = {
  key: 'unobserved_children',
  label: 'Children past the setting\'s observation gap',
  question: 'How many children have no observation inside max_gap_days_without_obs?',
  category: 'signal_observation_gap',
  priority: 35,
  recipients: 'all-managers',
  link: '/admin/staff/obs-performance',
  defaults: {
    min_children: 3,
    cooldown_hours: 24 * 7,
    min_gap_hours: 24 * 2,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;

    let gap = DEFAULT_GAP_DAYS;
    try {
      const { rows } = await db.query(
        `SELECT value FROM observation_standards WHERE key = 'max_gap_days_without_obs'`);
      if (rows.length && Number(rows[0].value) > 0) gap = Math.round(Number(rows[0].value));
    } catch (_) { /* no standards table on this edition → the EYFS default */ }

    const { rows } = await db.query(
      `WITH roll AS (
         SELECT c.id, c.key_person_id
           FROM children c
          WHERE COALESCE(c.is_active, true) = true
            AND COALESCE(c.is_demo, false) = false
            AND c.erased_at IS NULL
            AND (c.leave_date IS NULL OR c.leave_date >= $1::date)
            AND c.start_date IS NOT NULL
            AND c.start_date <= ($1::date - ($2 || ' days')::interval)
       ),
       latest AS (
         SELECT child_id, max(created_at) AS last_at
           FROM observations
          GROUP BY child_id
       )
       SELECT count(*)::int AS roll,
              count(*) FILTER (
                WHERE l.last_at IS NULL
                   OR l.last_at < ($1::date - ($2 || ' days')::interval)
              )::int AS overdue,
              count(*) FILTER (WHERE l.last_at IS NULL)::int AS never,
              count(*) FILTER (
                WHERE r.key_person_id IS NULL
                  AND (l.last_at IS NULL OR l.last_at < ($1::date - ($2 || ' days')::interval))
              )::int AS overdue_without_key_person
         FROM roll r
         LEFT JOIN latest l ON l.child_id = r.id`,
      [today, String(gap)]);

    const roll = rows[0].roll, overdue = rows[0].overdue,
          never = rows[0].never, noKey = rows[0].overdue_without_key_person;
    if (!roll) return { dormant: true, reason: 'no children have been on the roll longer than the gap' };
    if (overdue < cfg.min_children) return null;

    const neverPart = never > 0
      ? ` ${never} of them ${U.plural(never, 'has', 'have')} never had one.`
      : '';

    return {
      fingerprint: U.fingerprint({ overdue, never, gap }),
      headline: `${overdue} of ${roll} children have had no observation for more than ${gap} days, `
        + `which is this setting's own standard.${neverPart}`,
      facts: { overdue, roll, never_observed: never, gap_days: gap,
               overdue_without_key_person: noKey, as_of: today,
               standard: 'observation_standards.max_gap_days_without_obs' },
    };
  },
};
