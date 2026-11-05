'use strict';
/**
 * funding-receipts.js — b524 (2026-10-21). The July lesson, as a card.
 *
 * In July 2026 the under-2s funding did not arrive and nobody noticed, because
 * nothing in Wren ever said what the figure should have been. This collector is
 * the standing answer: for every claim month whose week count Ealing has
 * CONFIRMED, it compares what the claim should pay against what came in, and
 * raises ONE card when a month is short by more than the tolerance or when
 * nothing has arrived by the stated number of days after Ealing's own payment
 * date.
 *
 * ONE CARD PER CLAIM MONTH, not one per age band — the money arrives as a single
 * payment and chasing it is one job. The age-band split is on the Accounts
 * screen, where it is behind the finance guard.
 *
 * COUNTS, MONTHS AND TOTALS. No child is named or counted below the band level,
 * and no line of bank text appears. A claim month and an amount are the
 * company's own receivable, not anybody's personal data.
 *
 * IDLE WITHOUT THE b524 TABLES. The 06:45 host cron loads the WORKING TREE and
 * runs against PROD (feedback_devonly_does_not_cover_cron, and the b346 collector
 * that was caught by it), so until the migration is applied on prod this returns
 * ok:false and resolves nothing rather than throwing
 * `relation "funding_claim_receipts" does not exist` into the board.
 *
 * AND IT IS ALSO QUIET ON AN UNCONFIRMED MONTH. `weeks_confirmed = false` means
 * the expected figure is Wren's own calendar estimate, not Ealing's published
 * week count. Raising a shortfall off our own guess would fill the board with
 * cards about arithmetic.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');
const store = require('../../lib/accounts-store');

const SOURCE = 'funding-receipts';

const money = (p) => {
  const a = Math.abs(Math.trunc(Number(p) || 0));
  const s = `£${String(Math.floor(a / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${String(a % 100).padStart(2, '0')}`;
  return Number(p) < 0 ? `−${s}` : s;
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const label = (m) => `${MONTHS[(m.period_month || 1) - 1]} ${m.period_year}`;

async function collect() {
  const db = getPool();
  const have = await store.ready(db).catch(() => ({ ok: false, missing: ['unknown'] }));
  if (!have.ok) {
    // ok:false, no items — the b346 shape. The board shows nothing rather than
    // an error, and a migration card from src/services/attention/migrations.js
    // is what tells Toby the tables are not there.
    return { ok: false, source: SOURCE, items: [],
             reason: `b524 tables not present (${have.missing.join(', ')})` };
  }

  const months = await store.fundingExpectedVsReceived(db);
  const items = [];

  for (const m of months) {
    if (!m.is_short && !m.is_missing) continue;      // both already require weeks_confirmed

    // Which age bands the gap sits in, biggest first. Band names and amounts —
    // never a child.
    const worst = (m.bands || []).slice()
      .filter(b => b.shortfall_pence > 0)
      .sort((a, b) => b.shortfall_pence - a.shortfall_pence);
    const bandSentence = worst.length
      ? worst.slice(0, 3).map(b => `${b.label} ${money(b.shortfall_pence)}`).join(', ')
      : null;

    // `money: true` is RED in rag.js: "Money is either leaving or not arriving."
    // That is literally this card.
    const c = classify({ money: true, dueDate: m.payment_expected || null });
    const short = -m.difference_pence;

    items.push({
      source: SOURCE,
      // One key per claim period, so re-running the collector updates the card
      // rather than adding a second one, and the card disappears on its own when
      // the money arrives.
      source_key: `funding-claim-${m.claim_period_id}`,
      title: m.is_missing
        ? `${label(m)} funding has not arrived — ${money(m.expected_pence)} expected`
        : `${label(m)} funding is ${money(short)} short of the claim`,
      detail: [
        m.is_missing
          ? `Ealing's payment timetable gives ${m.payment_expected} for this claim and nothing has been matched to it, ${m.days_past_due} days later.`
          : `${money(m.received_pence)} arrived against ${money(m.expected_pence)} expected — ${Math.abs(m.difference_pct)}% short.`,
        bandSentence ? `The gap sits in: ${bandSentence}.` : null,
        `Worked out from ${m.children} funded children's claim hours, Ealing's ${m.weeks} weeks for the month, and the rate for each age band.`,
        m.adj_payment_expected ? `An adjustment payment is due ${m.adj_payment_expected}, which may still cover it.` : null,
      ].filter(Boolean).join(' '),
      why: c.why,
      rag: c.rag,
      category: 'finance',
      due_date: m.payment_expected || null,
      blocked_on: 'toby',
      effort_minutes: 20,
      action_url: '/admin/accounts/funding',
      evidence: {
        claim_period_id: m.claim_period_id, term_id: m.term_id,
        period: `${m.period_year}-${String(m.period_month).padStart(2, '0')}`,
        expected_pence: m.expected_pence, received_pence: m.received_pence,
        difference_pence: m.difference_pence, difference_pct: m.difference_pct,
        children: m.children, weeks: m.weeks, weeks_confirmed: m.weeks_confirmed,
        payment_expected: m.payment_expected, days_past_due: m.days_past_due,
        bands: (m.bands || []).map(b => ({ band: b.band, children: b.children,
          expected_pence: b.expected_pence, shortfall_pence: b.shortfall_pence })),
      },
      sort_hint: 0,     // ahead of the other finance cards: it is money owed to us
      // The collector raises the card; the dispatcher sends the Telegram. Kept
      // separate so a board refresh cannot buzz a phone twice — notify() is
      // called by notifyShortfalls() below, once per claim month, and the
      // dispatcher's own de-duplication does the rest.
      _notify: true,
    });
  }

  return { ok: true, source: SOURCE, items };
}

/**
 * Telegram Toby about the months this collector raised.
 *
 * Separate from collect() on purpose: the board is refreshed by several callers
 * (the cron, the Cockpit's own Refresh, the Accounts page) and a notification in
 * the collector would fire on each of them. This is called ONLY by the cron
 * wrapper, which is also the only caller with a reason to send anything.
 *
 * The de-duplication is the notification's own: one per claim period per state,
 * recorded in ladn.notifications via `related_table`/`related_id`, so a month
 * that is still short tomorrow does not send again.
 */
async function notifyShortfalls({ dryRun = false } = {}) {
  const db = getPool();
  const { items, ok } = await collect();
  if (!ok || !items.length) return { sent: 0, considered: 0, ok };

  const { notify } = require('../notification-dispatcher');
  let sent = 0;
  for (const it of items) {
    const ev = it.evidence;
    // Has this exact claim month already been notified in this state?
    const { rows } = await db.query(`
      SELECT 1 FROM notifications
       WHERE category = 'funding_receipt_short'
         AND related_table = 'funding_claim_periods'
         AND related_id = $1
         AND title = $2
       LIMIT 1`, [ev.claim_period_id, it.title]);
    if (rows.length) continue;
    if (dryRun) { sent++; continue; }
    notify('funding_receipt_short', 'all-managers', null, it.title, it.detail, {
      priority: 'high',
      relatedTable: 'funding_claim_periods',
      relatedId: ev.claim_period_id,
      link: '/admin/accounts/funding',
    });
    sent++;
  }
  return { sent, considered: items.length, ok: true, dry_run: dryRun };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect, notifyShortfalls, SOURCE };
