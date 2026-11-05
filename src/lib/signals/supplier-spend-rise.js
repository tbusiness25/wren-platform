'use strict';
/**
 * b365 signal — a supplier's bill has climbed, or a cost category is rising.
 *
 * Toby: "cheaper supplier, way to save money etc."
 *
 * Wren cannot tell you a supplier is cheaper elsewhere — it has no prices from
 * anywhere else, and a signal that implied otherwise would be inventing the
 * comparison. What it CAN do is notice the thing that makes you go and look:
 * a bill that has gone up without anyone deciding it should.
 *
 * TWO QUESTIONS, in priority order. Whichever answers first is the finding.
 *
 *   A. A SUPPLIER whose spend in the last complete month is more than
 *      `rise_pct` above its own average over the `baseline_months` before it,
 *      counted from the Xero transaction mirror (ladn.xero_transactions).
 *
 *   B. A COST CATEGORY that has risen in each of the last three complete
 *      months, counted from the P&L mirror (ladn.finance_pnl_lines). This is
 *      the branch that works even when the transaction mirror is empty.
 *
 * ── IT GOES DORMANT RATHER THAN GUESSING ────────────────────────────────────
 * Question A needs the transaction mirror. On a setting where Xero's
 * api.xro/2.0 refuses the connection (b204 — still 403 with an empty body on
 * the client_credentials path, re-measured 2026-09-29) the mirror is empty, and
 * an empty mirror means "nothing synced", not "no spend". So: if the mirror
 * holds nothing for the window, A is skipped and B is asked; if NEITHER source
 * has data, the signal reports dormant with the reason, and says nothing at all.
 *
 *
 * ── WHERE THE THRESHOLDS COME FROM ──────────────────────────────────────────
 * `defaults` below is the fallback. The live value is the SETTING, read through
 * ctx.setting(), so Toby can move it from the Settings screen without a deploy.
 * That also means the Roost "what would this say if…" preview and the test
 * harness change a threshold by overriding the SETTING (runner.makeSettingReader
 * takes overrides), not by passing cfg — cfg loses to a setting that exists, and
 * that precedence is deliberate: the stored value is what the nursery is running on.
 * ── MATERIALITY ─────────────────────────────────────────────────────────────
 * A supplier going from £4 to £9 is a 125% rise and is not news. `min_spend`
 * (settings.finance_supplier_min_spend_pence, £200) is the floor, and it is the
 * difference between a signal you read and a signal you mute.
 */

const U = require('./_util');

/** Accounts that are not a "supplier cost" in any useful sense. */
const NOT_A_SUPPLIER_COST = /salar|wage|payroll|pension|national insurance|depreciation|interest paid|corporation tax|dividend|drawings|suspense|sundry bank diff/i;

module.exports = {
  key: 'supplier_spend_rise',
  label: 'A supplier or cost category is climbing',
  question: 'Is a supplier\'s monthly spend more than N% above its own baseline, or has a cost category risen three months running?',
  category: 'signal_supplier_rise',
  priority: 30,
  recipients: 'all-managers',
  link: '/app.html#finance/pnl',
  defaults: {
    rise_pct: 15,              // overridden by settings.finance_supplier_rise_pct
    min_spend_pence: 20000,    // overridden by settings.finance_supplier_min_spend_pence
    baseline_months: 3,
    rising_months: 3,
    cooldown_hours: 24 * 21,
    min_gap_hours: 24 * 7,
  },

  async evaluate(ctx) {
    const { db, today, cfg } = ctx;
    const risePct = parseFloat(
      await ctx.setting('finance_supplier_rise_pct', String(cfg.rise_pct))) || cfg.rise_pct;
    const minSpend = parseInt(
      await ctx.setting('finance_supplier_min_spend_pence', String(cfg.min_spend_pence)), 10) || cfg.min_spend_pence;

    const t = U.parts(today);
    const prev = t.m === 1 ? { y: t.y - 1, m: 12 } : { y: t.y, m: t.m - 1 };
    const lastComplete = `${prev.y}-${String(prev.m).padStart(2, '0')}-01`;
    const money = p => `£${(p / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;

    // ── A. a supplier against its own baseline ──────────────────────────────
    const { rows: [mirror] } = await db.query(
      `SELECT count(*)::int AS n FROM xero_transactions
        WHERE direction = 'out'
          AND txn_date >= ($1::date - ($2 || ' months')::interval)`,
      [lastComplete, String(cfg.baseline_months)]);

    if (mirror.n > 0) {
      const { rows: sup } = await db.query(
        `WITH spend AS (
           SELECT lower(btrim(contact_name)) AS supplier_key,
                  min(contact_name)          AS supplier,
                  date_trunc('month', txn_date)::date AS m,
                  SUM(total_pence)::bigint   AS pence
             FROM xero_transactions
            WHERE direction = 'out'
              AND contact_name IS NOT NULL AND btrim(contact_name) <> ''
              AND txn_date >= ($1::date - ($2 || ' months')::interval)
              AND txn_date <  ($1::date + interval '1 month')
            GROUP BY 1, 3
         ), split AS (
           SELECT supplier_key, max(supplier) AS supplier,
                  COALESCE(SUM(pence) FILTER (WHERE m = $1::date), 0)::bigint AS last_pence,
                  COALESCE(AVG(pence) FILTER (WHERE m < $1::date), 0)::bigint AS baseline_pence,
                  count(*) FILTER (WHERE m < $1::date)::int                   AS baseline_months
             FROM spend GROUP BY supplier_key
         )
         SELECT * FROM split
          WHERE baseline_months >= 2
            AND last_pence >= $3::bigint
            AND baseline_pence > 0
            AND last_pence::numeric > baseline_pence::numeric * (1 + $4::numeric / 100)
          ORDER BY (last_pence - baseline_pence) DESC
          LIMIT 5`,
        [lastComplete, String(cfg.baseline_months), minSpend, risePct]);

      if (sup.length) {
        const s = sup[0];
        const last = Number(s.last_pence), base = Number(s.baseline_pence);
        const up = Math.round(((last - base) / base) * 100);
        const others = sup.length - 1;
        return {
          fingerprint: U.fingerprint({ v: 'supplier', k: s.supplier_key, month: lastComplete, up }),
          headline: `${s.supplier} billed ${money(last)} in ${U.monthLabel(prev.y, prev.m)}, ${up}% above their `
            + `own average of ${money(base)} over the previous ${s.baseline_months} months.`
            + (others > 0 ? ` ${others} other supplier${others === 1 ? ' is' : 's are'} also up by more than ${risePct}%.` : '')
            + ' Wren has no prices from anywhere else, so it cannot tell you whether that is a good price — only that it moved.',
          facts: {
            variant: 'supplier_above_own_baseline',
            month: `${prev.y}-${String(prev.m).padStart(2, '0')}`,
            threshold_pct: risePct, min_spend_pence: minSpend,
            source: 'ladn.xero_transactions (local Xero mirror)',
            rows: sup.map(r => ({
              supplier: r.supplier, last_pence: Number(r.last_pence),
              baseline_pence: Number(r.baseline_pence), baseline_months: r.baseline_months,
              up_pct: Math.round(((Number(r.last_pence) - Number(r.baseline_pence)) / Number(r.baseline_pence)) * 100),
            })),
          },
        };
      }
    }

    // ── B. a cost category rising three months running ──────────────────────
    const { rows: cat } = await db.query(
      `SELECT l.account_name,
              EXTRACT(year  FROM p.period_from)::int AS y,
              EXTRACT(month FROM p.period_from)::int AS m,
              SUM(l.amount_pence)::bigint            AS pence
         FROM finance_pnl_periods p
         JOIN finance_pnl_lines   l ON l.period_id = p.id
        WHERE l.section NOT ILIKE '%income%'
          AND l.section NOT ILIKE '%revenue%'
          AND COALESCE(p.is_partial, false) = false
          AND p.period_from <= $1::date
        GROUP BY 1, 2, 3
        ORDER BY 1, 2 DESC, 3 DESC`,
      [lastComplete]);

    if (!cat.length && !mirror.n) {
      return { dormant: true,
               reason: 'neither the Xero transaction mirror nor the P&L mirror holds any spend for this window — '
                     + 'nothing has synced, which is not the same as no spend' };
    }

    const byAccount = new Map();
    for (const r of cat) {
      if (NOT_A_SUPPLIER_COST.test(r.account_name || '')) continue;
      if (!byAccount.has(r.account_name)) byAccount.set(r.account_name, []);
      byAccount.get(r.account_name).push(Number(r.pence));   // already newest-first
    }

    const rising = [];
    for (const [account, series] of byAccount) {
      const need = Math.max(2, cfg.rising_months);
      if (series.length < need + 1) continue;
      const window = series.slice(0, need + 1);              // newest … oldest
      let up = true;
      for (let i = 0; i < need; i++) if (!(window[i] > window[i + 1])) { up = false; break; }
      if (!up) continue;
      if (window[0] < minSpend) continue;
      const oldest = window[need];
      if (oldest <= 0) continue;
      rising.push({ account, latest_pence: window[0], months_ago_pence: oldest,
                    up_pct: Math.round(((window[0] - oldest) / oldest) * 100), months: need });
    }
    if (!rising.length) return null;

    rising.sort((a, b) => (b.latest_pence - b.months_ago_pence) - (a.latest_pence - a.months_ago_pence));
    const r0 = rising[0];
    const others = rising.length - 1;

    return {
      fingerprint: U.fingerprint({ v: 'category', a: r0.account, month: lastComplete, up: r0.up_pct }),
      headline: `${r0.account} has risen in each of the last ${r0.months} months — ${money(r0.months_ago_pence)} `
        + `to ${money(r0.latest_pence)}, up ${r0.up_pct}%.`
        + (others > 0 ? ` ${others} other cost ${U.plural(others, 'category', 'categories')} ${U.plural(others, 'is', 'are')} rising too.` : '')
        + ' This is the accounts, not a supplier — the category may hold several of them.',
      facts: {
        variant: 'category_rising_three_months',
        month: `${prev.y}-${String(prev.m).padStart(2, '0')}`,
        threshold_pct: risePct, min_spend_pence: minSpend,
        source: 'ladn.finance_pnl_lines (local Xero P&L mirror)',
        transaction_mirror_rows: mirror.n,
        transaction_mirror_note: mirror.n
          ? null
          : 'The per-supplier question was skipped: the Xero transaction mirror is empty for this window.',
        rows: rising.slice(0, 8),
      },
    };
  },
};
