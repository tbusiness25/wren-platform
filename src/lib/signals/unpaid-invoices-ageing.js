'use strict';
/**
 * b365 signal — invoices are ageing past their due date.
 *
 * THE QUESTION
 *   How many invoices are more than `age_days` past due with money still
 *   outstanding, and what do they add up to?
 *
 * "Outstanding" is the invoice less what has been ALLOCATED against it, not the
 * invoice less what its status says. b227 found invoices marked paid whose
 * allocations do not cover them; taking the status at face value would hide
 * exactly the debt this signal exists to find.
 *
 *
 * ── WHERE THE THRESHOLDS COME FROM ──────────────────────────────────────────
 * `defaults` below is the fallback. The live value is the SETTING, read through
 * ctx.setting(), so Toby can move it from the Settings screen without a deploy.
 * That also means the Roost "what would this say if…" preview and the test
 * harness change a threshold by overriding the SETTING (runner.makeSettingReader
 * takes overrides), not by passing cfg — cfg loses to a setting that exists, and
 * that precedence is deliberate: the stored value is what the nursery is running on.
 * ── NO FAMILY IS NAMED ──────────────────────────────────────────────────────
 * A count and a total, and a link to the chase list where the names properly
 * live. This notification goes to every manager and lands in a list a phone can
 * show on a lock screen, and "the Hendersons owe £1,400" is not a thing to put
 * there. child-name-guard.js checks the sent text against the roll on every
 * fire, so this is enforced rather than promised — but the SQL does not select
 * a name in the first place.
 */

const U = require('./_util');

module.exports = {
  key: 'unpaid_invoices_ageing',
  label: 'Invoices ageing past their due date',
  question: 'How many invoices are more than N days past due with money still outstanding, and how much?',
  category: 'signal_debt_ageing',
  priority: 18,
  recipients: 'all-managers',
  link: '/app.html#finance/reports',
  defaults: {
    age_days: 14,             // overridden by settings.finance_debt_age_days
    min_total_pence: 25000,   // overridden by settings.finance_debt_min_total_pence
    min_invoices: 2,
    cooldown_hours: 24 * 7,
    min_gap_hours: 24 * 2,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;
    const ageDays = parseInt(await ctx.setting('finance_debt_age_days', String(cfg.age_days)), 10) || cfg.age_days;
    const minTotal = parseInt(
      await ctx.setting('finance_debt_min_total_pence', String(cfg.min_total_pence)), 10) || cfg.min_total_pence;

    const { rows: [r] } = await db.query(
      `WITH owed AS (
         SELECT i.id, i.due_on,
                i.amount_pence - COALESCE(al.allocated, 0) AS outstanding_pence,
                ($1::date - i.due_on)                      AS days_overdue
           FROM invoices i
           LEFT JOIN (SELECT invoice_id, SUM(amount_pence) AS allocated
                        FROM payment_allocations GROUP BY invoice_id) al ON al.invoice_id = i.id
          WHERE i.credit_note_for_id IS NULL
            AND COALESCE(i.status,'') NOT IN ('draft','void','cancelled','written_off','writeoff','credited')
            AND i.due_on IS NOT NULL
            AND i.due_on < ($1::date - ($2 || ' days')::interval)
            AND i.amount_pence - COALESCE(al.allocated, 0) > 0
       )
       SELECT count(*)::int                                   AS invoices,
              COALESCE(SUM(outstanding_pence), 0)::bigint     AS total_pence,
              COALESCE(MAX(days_overdue), 0)::int             AS oldest_days,
              count(*) FILTER (WHERE days_overdue >= 60)::int  AS over_60,
              count(*) FILTER (WHERE days_overdue >= 90)::int  AS over_90,
              COALESCE(SUM(outstanding_pence) FILTER (WHERE days_overdue >= 90), 0)::bigint AS over_90_pence
         FROM owed`,
      [today, String(ageDays)]);

    const invoices = r.invoices, total = Number(r.total_pence);
    if (invoices < cfg.min_invoices) return null;
    if (total < minTotal) return null;

    const money = p => `£${(p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    const tail = r.over_90
      ? ` ${r.over_90} of them ${U.plural(r.over_90, 'is', 'are')} more than 90 days past due, worth ${money(Number(r.over_90_pence))}.`
      : '';

    return {
      fingerprint: U.fingerprint({ invoices, total, over90: r.over_90 }),
      headline: `${invoices} ${U.plural(invoices, 'invoice')} ${U.plural(invoices, 'is', 'are')} more than `
        + `${ageDays} days past due, with ${money(total)} outstanding. The oldest is ${r.oldest_days} days `
        + `overdue.${tail}`,
      facts: {
        age_days: ageDays, invoices, outstanding_pence: total,
        oldest_days_overdue: r.oldest_days, over_60: r.over_60, over_90: r.over_90,
        over_90_pence: Number(r.over_90_pence),
        basis: 'Invoice amount less what has been ALLOCATED against it — not what the status says. Drafts, '
             + 'credit notes, voids and write-offs are excluded.',
        where_the_names_are: 'Finance → Reports → Debtor chase list. No family is named in this notification.',
      },
    };
  },
};
