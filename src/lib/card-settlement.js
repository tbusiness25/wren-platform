'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b524 (2026-10-21) — Barclaycard settlements.
//
// Toby, 21 Oct, reconciling: the "BCARD<ref> BGC" credits showed "no suggestion",
// because Barclaycard does not pay a card payment — it pays a BATCH of them, one
// lump, one to three working days later. Nothing in Wren looked for a SET of
// payments summing to a line, so every one of them fell to the bottom of the
// queue and he linked the last two by hand.
//
// Measured on prod (read-only, 2026-10-21): 10 BCARD credit lines, and exactly 4
// card payments in ladn.payments — the two pairs he linked by hand. The other 8
// BCARD lines (9 Jul – 1 Sep) settle card takings from the EyLog era, before Wren
// recorded card payments at all, so there is nothing in `payments` for them to
// match and there never will be. They are a separate, explicit one-click job —
// NOT an invoice match, which would invent a second payment for a bill EyLog has
// already shown as paid.
//
// WHY EXACT, AND ONLY EXACT. The combination is found by subset sum over the
// candidate payments. A tolerance would let a two-payment combination stand in
// for a three-payment one, credit the wrong families, and look confident doing
// it. If Barclaycard ever nets a merchant fee off the lump, no exact combination
// exists, the line goes to the review queue with the near-miss and the implied
// fee attached, and a person decides — which is the correct answer, because the
// fee is a cost that has to be posted somewhere.
//
// Pure functions. The DB reads and the writes live in src/lib/auto-allocate.js;
// this file does the arithmetic and can be tested without a database.
// ─────────────────────────────────────────────────────────────────────────────

// 2026-10-28: Barclays prints the merchant number straight after it ("BCARD1234567 BGC"),
// so \bBCARD\b never matched a real payout. BCARD, then digits or a word boundary.
const BCARD_RE = /\bBCARD(?:\d+\b|\b)/i;

/** Is this bank line a Barclaycard settlement credit? */
function isCardSettlementLine(line) {
  if (!line || Number(line.amount_pence) <= 0) return false;
  // `description` is bank text and may carry family names
  // (reference_payments_eylog_ref_is_bank_text_pii) — it is TESTED here and
  // never returned, logged or grouped by.
  return BCARD_RE.test(String(line.description || '')) || BCARD_RE.test(String(line.reference || ''));
}

// Local getters, not toISOString(): pg hands a DATE back as a LOCAL-midnight
// Date, which toISOString() rolls back a day west of UTC — and a settlement
// moved a day lands outside its own 1–3 working day window.
const ymd = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const dt = (d instanceof Date) ? d : new Date(d);
  if (isNaN(dt)) return null;
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
};

/**
 * Walk back N working days from a date, skipping weekends and the bank holidays
 * given. Returns 'YYYY-MM-DD'.
 *
 * Barclaycard settle on working days, so "1–3 working days earlier" over a bank
 * holiday weekend reaches back five calendar days. Counting calendar days would
 * have missed every Monday settlement after a long weekend.
 */
function workingDaysBefore(dateStr, n, holidays = new Set()) {
  const d = new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`);
  if (isNaN(d)) return null;
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (holidays.has(d.toISOString().slice(0, 10))) continue;
    left--;
  }
  return d.toISOString().slice(0, 10);
}

/**
 * The window of payment dates a settlement on `settledOn` could be paying for:
 * from `maxDays` working days before, to `minDays` working days before, inclusive.
 */
function candidateWindow(settledOn, { minDays = 1, maxDays = 3, holidays = new Set() } = {}) {
  const from = workingDaysBefore(settledOn, maxDays, holidays);
  const to   = workingDaysBefore(settledOn, minDays, holidays);
  return (from && to) ? { from, to } : null;
}

/**
 * Every subset of `payments` whose amounts sum to exactly `targetPence`.
 *
 * Exhaustive over the candidate set, which is why the set has to be bounded:
 * a window of 1–3 working days holds a handful of card payments in a nursery,
 * not hundreds. `maxItems` and `maxCombos` are hard stops — if either trips, the
 * caller gets `truncated:true` and the line goes to review rather than being
 * matched off a partial search. Guessing under a cap is worse than not guessing.
 */
function findExactSubsets(payments, targetPence, { maxItems = 14, maxCombos = 200000 } = {}) {
  const items = (payments || []).filter(p => Number(p.amount_pence) > 0);
  if (!items.length || !(targetPence > 0)) return { subsets: [], truncated: false };
  if (items.length > maxItems) return { subsets: [], truncated: true, reason: `${items.length} candidate card payments in the window — too many to search exhaustively` };

  const subsets = [];
  let visited = 0, truncated = false;

  // Depth-first with a running total. Items sorted descending so a subset that
  // has already overshot prunes early.
  const sorted = items.slice().sort((a, b) => Number(b.amount_pence) - Number(a.amount_pence));
  const chosen = [];
  (function walk(i, sum) {
    if (truncated) return;
    if (++visited > maxCombos) { truncated = true; return; }
    if (sum === targetPence && chosen.length) { subsets.push(chosen.slice()); return; }
    if (sum > targetPence || i >= sorted.length) return;
    for (let j = i; j < sorted.length; j++) {
      chosen.push(sorted[j]);
      walk(j + 1, sum + Number(sorted[j].amount_pence));
      chosen.pop();
      if (truncated) return;
    }
  })(0, 0);

  return { subsets, truncated, reason: truncated ? 'search cap reached' : null };
}

/**
 * Pick between competing exact combinations: "the combination nearest in time".
 *
 * Nearest = the smallest gap between the settlement date and the LATEST payment
 * in the combination (the settlement follows the last take in the batch). Ties
 * break on the tighter spread of dates within the combination, then on fewer
 * payments, then on the lowest payment id — so the answer is deterministic and
 * does not change between two runs over the same data.
 */
function rankSubsets(subsets, settledOn) {
  const settle = new Date(`${String(settledOn).slice(0, 10)}T00:00:00Z`).getTime();
  const dayOf = (p) => new Date(`${ymd(p.paid_on || p.created_at)}T00:00:00Z`).getTime();
  return (subsets || []).map((s) => {
    const days = s.map(dayOf).filter(t => !isNaN(t));
    const latest = days.length ? Math.max(...days) : NaN;
    const earliest = days.length ? Math.min(...days) : NaN;
    return {
      payments: s,
      gap_days:    isNaN(latest) ? 9999 : Math.round((settle - latest) / 86400000),
      spread_days: (isNaN(latest) || isNaN(earliest)) ? 9999 : Math.round((latest - earliest) / 86400000),
      count: s.length,
      min_id: Math.min(...s.map(p => Number(p.id))),
    };
  }).sort((a, b) =>
    (a.gap_days - b.gap_days) ||
    (a.spread_days - b.spread_days) ||
    (a.count - b.count) ||
    (a.min_id - b.min_id));
}

/**
 * Match one BCARD line against the card payments in its window.
 *
 * Returns one of:
 *   { outcome:'matched',  payments, gross_pence, net_pence, fee_pence:0, … }  — exact, certain
 *   { outcome:'review',   reason, … }                                          — the review queue
 *   { outcome:'eylog_era', … }                                                 — nothing in Wren to match
 *
 * `eylogCutover` is the date Wren started recording card payments. A settlement
 * before it cannot have Wren payments behind it, and saying "no suggestion" about
 * it forever is what buried the other eight lines.
 */
function matchSettlement(line, candidates, {
  minDays = 1, maxDays = 3, holidays = new Set(), eylogCutover = '2026-09-26',
} = {}) {
  const settledOn = ymd(line.transaction_date);
  const target = Number(line.amount_pence);
  const base = { bank_line_id: line.id, settled_on: settledOn, net_pence: target };

  if (settledOn && settledOn < String(eylogCutover).slice(0, 10)) {
    return Object.assign({}, base, {
      outcome: 'eylog_era', era: 'eylog',
      reason: `Settled ${settledOn}, before Wren began recording card payments (${eylogCutover}) — the takings behind it were recorded in EyLog.`,
    });
  }

  const win = candidateWindow(settledOn, { minDays, maxDays, holidays });
  if (!win) return Object.assign({}, base, { outcome: 'review', reason: 'The settlement has no usable date.' });

  const inWindow = (candidates || []).filter((p) => {
    const d = ymd(p.paid_on || p.created_at);
    return d && d >= win.from && d <= win.to;
  });

  if (!inWindow.length) {
    return Object.assign({}, base, { outcome: 'review', window: win,
      reason: `No card payments were recorded between ${win.from} and ${win.to} (${minDays}–${maxDays} working days before the settlement).` });
  }

  const { subsets, truncated, reason } = findExactSubsets(inWindow, target);
  if (truncated) {
    return Object.assign({}, base, { outcome: 'review', window: win,
      reason: `Not matched automatically: ${reason}.` });
  }

  if (!subsets.length) {
    // No exact combination. Hand over the NEAREST one, from either side, rather
    // than just "no match".
    //
    // Which side matters, and this is the bit that was wrong first time round: a
    // merchant fee makes the credit SMALLER than the takings, so the combination
    // that explains it sums ABOVE the target, and
    //   fee = gross (the card payments) − net (what the bank credited).
    // Searching only below the target found a SMALLER subset instead — for a
    // £340 credit against £200 + £150 of takings it proposed the £200 payment
    // alone and called the other £140 a fee. Nearest from either side, ties to
    // the one above, is what gives a fee figure worth showing a person.
    const all = findClosest(inWindow, target);
    const fee = all ? all.sum - target : null;   // positive ⇒ a fee was deducted
    return Object.assign({}, base, { outcome: 'review', window: win,
      candidates_in_window: inWindow.length,
      near_miss: all ? { payment_count: all.items.length, gross_pence: all.sum,
                         implied_fee_pence: fee } : null,
      reason: all
        ? `No combination of the ${inWindow.length} card payments in the window adds up exactly. The closest is ${all.items.length} payment(s) totalling ${all.sum}p against a ${target}p credit${fee > 0 ? ` — ${fee}p less than the takings, which is the shape of a merchant fee` : ` — ${Math.abs(fee)}p more than the takings`}.`
        : `None of the ${inWindow.length} card payments in the window add up to the credit.` });
  }

  const ranked = rankSubsets(subsets, settledOn);
  const best = ranked[0];
  const gross = best.payments.reduce((a, p) => a + Number(p.amount_pence), 0);

  return Object.assign({}, base, {
    outcome: 'matched', era: 'wren', certainty: 'certain',
    rule: 'card_settlement_exact_subset',
    window: win,
    payments: best.payments.map(p => ({ id: p.id, amount_pence: Number(p.amount_pence), paid_on: ymd(p.paid_on || p.created_at) })),
    payment_count: best.payments.length,
    gross_pence: gross,
    net_pence: target,
    fee_pence: gross - target,          // 0 for an exact match, by construction
    gap_days: best.gap_days,
    alternatives: ranked.length - 1,
    // More than one exact combination is worth saying out loud even when the
    // tie-break is deterministic: two different sets of families can add to the
    // same number, and the person reconciling should know the choice was made.
    note: ranked.length > 1
      ? `${ranked.length} combinations add up exactly; the one settling ${best.gap_days} day(s) after its last payment was taken.`
      : null,
  });
}

/**
 * The subset whose sum is NEAREST the target, from either side.
 *
 * Ties break towards the sum ABOVE the target, because that is the merchant-fee
 * shape (takings minus a fee equals the credit) and it is the answer a person
 * reconciling actually wants. Then towards fewer payments, then the lowest id,
 * so two runs over the same data give the same answer.
 *
 * Bounded by the same visit cap as findExactSubsets: this is only ever called on
 * a window of a few days' card takings.
 */
function findClosest(items, target) {
  const list = (items || []).filter(p => Number(p.amount_pence) > 0)
    .sort((a, b) => Number(b.amount_pence) - Number(a.amount_pence));
  if (!list.length) return null;
  // Searching above the target needs a ceiling or every superset is explored.
  // Twice the target is generous and bounded.
  const ceiling = target * 2;
  let best = null;
  const chosen = [];
  let visited = 0;
  const better = (cand) => {
    if (!best) return true;
    const dc = Math.abs(cand.sum - target), db = Math.abs(best.sum - target);
    if (dc !== db) return dc < db;
    const ac = cand.sum >= target, ab = best.sum >= target;
    if (ac !== ab) return ac;                      // prefer the one above
    if (cand.items.length !== best.items.length) return cand.items.length < best.items.length;
    return Math.min(...cand.items.map(p => Number(p.id))) < Math.min(...best.items.map(p => Number(p.id)));
  };
  (function walk(i, sum) {
    if (++visited > 200000) return;
    if (sum > 0) { const cand = { sum, items: chosen.slice() }; if (better(cand)) best = cand; }
    if (i >= list.length || sum > ceiling) return;
    for (let j = i; j < list.length; j++) {
      chosen.push(list[j]);
      walk(j + 1, sum + Number(list[j].amount_pence));
      chosen.pop();
    }
  })(0, 0);
  return best;
}

module.exports = {
  BCARD_RE, isCardSettlementLine, workingDaysBefore, candidateWindow,
  findExactSubsets, rankSubsets, matchSettlement, findClosest,
};
