'use strict';
/**
 * b311 signal — an open safeguarding concern with nothing recorded against it.
 *
 * THE QUESTION
 *   How many concerns are open, were raised more than `stale_days` ago, and
 *   have had no action, no DSL review and no escalation recorded since?
 *
 * "No action recorded" is not the same as "nothing happened", and the wording
 * says so. What Ofsted asks to see is the record; a concern that was handled in
 * a corridor and never written down is exactly the gap worth surfacing.
 *
 * ── WHO IT GOES TO ──────────────────────────────────────────────────────────
 * The DSL, not the manager group. This is the one signal of the nine with a
 * named professional responsibility attached, and routing it to everyone with a
 * manager role would widen access to the fact that concerns are open. If no
 * staff row has is_dsl set, the runner falls back to all-managers — a nursery
 * with no DSL recorded has a bigger problem than this notification, and silence
 * is the wrong failure here.
 *
 * ── WHAT IT SAYS ────────────────────────────────────────────────────────────
 * A count and a link. No child, no category, no description — the notification
 * itself is not a safeguarding record and must not become one, and it lands in
 * a bell that other people can be standing next to.
 */

const U = require('./_util');

module.exports = {
  key: 'stale_safeguarding',
  label: 'Open safeguarding concern with no recorded action',
  question: 'How many open concerns have had nothing recorded against them for N days?',
  category: 'signal_safeguarding_stale',
  priority: 1,               // first claim on the daily cap, always
  recipients: 'dsl',
  link: '/admin/safeguarding',
  defaults: {
    stale_days: 7,
    min_concerns: 1,
    cooldown_hours: 24 * 3,
    min_gap_hours: 24,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;
    const { rows } = await db.query(
      `WITH open_concerns AS (
         SELECT c.id, c.concern_date, c.updated_at, c.dsl_reviewed_at, c.escalated_at,
                (SELECT max(a.created_at) FROM safeguarding_actions a WHERE a.concern_id = c.id) AS last_action
           FROM safeguarding_concerns c
          WHERE COALESCE(c.status, 'new') <> 'closed'
            AND c.closed_at IS NULL
       )
       SELECT count(*)::int AS open_total,
              count(*) FILTER (WHERE GREATEST(
                     COALESCE(last_action,      concern_date),
                     COALESCE(dsl_reviewed_at,  concern_date),
                     COALESCE(escalated_at,     concern_date),
                     concern_date
                   ) < ($1::date - ($2 || ' days')::interval))::int AS stale,
              min(concern_date) FILTER (WHERE GREATEST(
                     COALESCE(last_action,      concern_date),
                     COALESCE(dsl_reviewed_at,  concern_date),
                     COALESCE(escalated_at,     concern_date),
                     concern_date
                   ) < ($1::date - ($2 || ' days')::interval)) AS oldest,
              count(*) FILTER (WHERE last_action IS NULL
                   AND GREATEST(COALESCE(dsl_reviewed_at, concern_date),
                                COALESCE(escalated_at, concern_date),
                                concern_date)
                       < ($1::date - ($2 || ' days')::interval))::int AS no_action_at_all
         FROM open_concerns`,
      [today, String(cfg.stale_days)]);

    const stale = rows[0].stale, openTotal = rows[0].open_total,
          noAction = rows[0].no_action_at_all;
    if (stale < cfg.min_concerns) return null;

    const oldestDays = rows[0].oldest ? U.daysBetween(U.ymd(rows[0].oldest), today) : null;
    const oldestPart = oldestDays != null
      ? ` The oldest was raised ${oldestDays} days ago.`
      : '';

    return {
      fingerprint: U.fingerprint({ stale, openTotal }),
      headline: `${stale} of ${openTotal} open safeguarding ${U.plural(openTotal, 'concern', 'concerns')} ${U.plural(stale, 'has', 'have')} `
        + `had nothing recorded against ${U.plural(stale, 'it', 'them')} for more than ${cfg.stale_days} days.${oldestPart}`,
      facts: { stale, open_total: openTotal, no_action_at_all: noAction,
               stale_days: cfg.stale_days, oldest_age_days: oldestDays, as_of: today },
    };
  },
};
