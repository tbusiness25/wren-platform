'use strict';
/**
 * b311 signal — the funding headcount is coming and nothing has been submitted.
 *
 * Ealing pays for a term against a headcount taken on one named date. Miss it
 * and the money for that term is gone; there is no retrospective claim.
 *
 * THE QUESTION — two of them, because there are two ways to lose the money:
 *
 *   1. A term whose funding_eligible_date is within `lead_days` has no row in
 *      ladn.funding_submissions. The deadline is known and unmet.
 *
 *   2. The CURRENT term has no funding_eligible_date at all. Wren cannot tell
 *      you when the deadline is, which means it cannot warn you about (1). The
 *      absence of the date is itself the finding, and saying so is the only
 *      honest thing to do — verified on dev 2026-09-10: 21 of 22 funding_terms
 *      rows have funding_eligible_date NULL, so a signal that only implemented
 *      (1) would have been silent forever and looked like it was working.
 *
 * Variant 2 is quieter than variant 1 by a long way — a missing configuration
 * value is a thing to sort out one afternoon, not an alarm.
 */

const U = require('./_util');

module.exports = {
  key: 'funding_headcount',
  label: 'Funding headcount due, nothing submitted',
  question: 'Is a term\'s headcount date within N days with no submission — or does the current term have no headcount date at all?',
  category: 'signal_funding_headcount',
  priority: 12,
  recipients: 'all-managers',
  link: '/funding-dates.html',
  defaults: {
    lead_days: 14,
    grace_days: 7,
    cooldown_hours: 24 * 3,
    min_gap_hours: 24,
    // Variant 2 has its own, much longer, cooldown — applied by the runner via
    // the fingerprint, which changes when the variant changes.
    missing_date_cooldown_hours: 24 * 60,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;

    // ── Variant 1 — a dated deadline that has not been met ──────────────────
    const { rows: due } = await db.query(
      `SELECT t.id, t.name, t.funding_eligible_date,
              (SELECT count(*)::int FROM funding_submissions s WHERE s.term_id = t.id) AS submissions
         FROM funding_terms t
        WHERE t.funding_eligible_date IS NOT NULL
          AND t.funding_eligible_date >= ($1::date - ($2 || ' days')::interval)
          AND t.funding_eligible_date <= ($1::date + ($3 || ' days')::interval)
        ORDER BY t.funding_eligible_date ASC`,
      [today, String(cfg.grace_days), String(cfg.lead_days)]);

    const unmet = due.filter(r => r.submissions === 0);
    if (unmet.length) {
      const t = unmet[0];
      const dateStr = U.ymd(t.funding_eligible_date);
      const daysAway = U.daysBetween(today, dateStr);
      const when = daysAway >= 0
        ? `The headcount date is ${U.longDate(dateStr)} — ${U.inDays(daysAway)}.`
        : `The headcount date was ${U.longDate(dateStr)}, ${U.inDays(daysAway)}.`;
      return {
        fingerprint: U.fingerprint({ v: 'due', term: t.id, dateStr }),
        headline: `No funding submission has been recorded for ${t.name}. ${when}`,
        facts: { variant: 'deadline_unmet', term_id: t.id, term_name: t.name,
                 headcount_date: dateStr, days_away: daysAway, submissions: 0 },
      };
    }

    // ── Variant 2 — the current term has no headcount date recorded ─────────
    const { rows: cur } = await db.query(
      `SELECT id, name, start_date, end_date, funding_eligible_date
         FROM funding_terms
        WHERE is_current = true
        ORDER BY start_date DESC
        LIMIT 1`);
    if (!cur.length) return { dormant: true, reason: 'no funding term is marked current' };
    const term = cur[0];
    if (term.funding_eligible_date) return null;   // dated, and not yet in the window

    return {
      fingerprint: U.fingerprint({ v: 'nodate', term: term.id }),
      headline: `The current funding term (${term.name}) has no headcount date recorded, `
        + `so Wren cannot tell you when the submission is due or warn you before it passes.`,
      facts: { variant: 'headcount_date_missing', term_id: term.id, term_name: term.name,
               term_start: U.ymd(term.start_date), term_end: U.ymd(term.end_date) },
      cooldownHours: cfg.missing_date_cooldown_hours,
    };
  },
};
