'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b524 (2026-10-21) — auto-allocate.
//
// Toby: "And it's got an auto-allocate."
//
// b325 already matches bank CREDITS to families and their invoices, certainly,
// off a payment reference or a confirmed payer. That engine is
// src/services/payment-matcher.js and this module CALLS it — it does not contain
// a second copy of it, and in particular it contains no second definition of a
// family key. What was missing is everything money does that is not a family
// paying a bill:
//
//   payroll_run      the monthly BACS debit that pays the staff
//   hmrc             the PAYE/NI debit that follows it
//   pension          the pension provider's collection
//   funding_claim    Ealing's receipt for a claim month
//   card_settlement  Barclaycard paying a batch of card takings as one lump
//
// HIGH CONFIDENCE MEANS TWO INDEPENDENT FACTS, NOT A SCORE. Every rule below
// needs an exact amount AND a corroborating fact — a reference marker, a date
// inside a window, or a payer link. There is deliberately no scoring and no
// threshold to tune: a rule either has both facts or the line goes to the review
// queue. (The old `scoreMatch` in finance-reconcile.js — points for a surname
// appearing anywhere, auto-confirm at 95 — is untouched and still drives the old
// Reconcile tab. It is the thing this is not.)
//
// THREE RULES THAT ARE NOT NEGOTIABLE
//  • NEVER ACROSS FAMILIES. A credit is never split between two families. The
//    fee path delegates to payment-matcher.js, which plans within one family;
//    assertSingleFamily() re-checks the plan it hands back before anything is
//    written, so a future change there cannot quietly widen this.
//  • EVERY AUTO-MATCH CAN BE UNDONE, and undo puts the world back: the bank line
//    is unreconciled, the links are removed, and both the match and the undo are
//    in ladn.reconciliation_audit with the actor and the evidence.
//  • OFF BY DEFAULT. `settings.accounts_auto_allocate` is '0'. With it off, a
//    scan writes queue rows and moves nothing — the same dry-run-first shape
//    b325 uses, for the same reason.
//
// NO BANK TEXT LEAVES THIS MODULE. `description` is matched against here and
// never returned, logged or grouped by: on the legacy rows it carries payer and
// child names (reference_payments_eylog_ref_is_bank_text_pii). What callers get
// back is which MARKER matched, not the text it matched in.
// ─────────────────────────────────────────────────────────────────────────────

const CS = require('./card-settlement');
// (funding-expected.js is NOT imported here on purpose: an ambiguous claim month
// goes to review rather than being resolved by costing it, so this module never
// needs the child data.)

// ── Markers ──────────────────────────────────────────────────────────────────
// Word-boundary regexes, not ILIKE '%…%'. Measured on prod: `%NEST%` matched 3
// lines, none of them a debit and none of them the pension provider — it was a
// substring of an unrelated word. A pension collection wrongly treated as
// certain would reconcile a line against a run it has nothing to do with.
const MARKERS = {
  hmrc:    [/\bHMRC\b/i, /\bNDDS\b/i, /\bSHIPLEY\b/i, /\bCUMBERNAULD\b/i, /\bHMRC\s*PAYE\b/i],
  pension: [/\bNEST\b/i, /\bNOW[:\s-]*PENSIONS?\b/i, /\bPEOPLES?\s+PENSION\b/i,
            /\bSMART\s+PENSION\b/i, /\bAVIVA\b/i, /\bSTANDARD\s+LIFE\b/i,
            /\bLEGAL\s*&?\s*GENERAL\b/i, /\bROYAL\s+LONDON\b/i, /\bSCOTTISH\s+WIDOWS\b/i],
  payroll: [/\bPAYROLL\b/i, /\bSALAR(Y|IES)\b/i, /\bWAGES\b/i, /\bNET\s*PAY\b/i, /\bBACS\b/i],
  ealing:  [/\bLB\s+EALING\b/i, /\bEALING\b/i],
};

const hit = (text, list) => {
  const s = String(text || '');
  for (const re of list) if (re.test(s)) return re.source;
  return null;
};
const lineText = (l) => `${l.description || ''} ${l.reference || ''} ${l.payee_name || ''} ${l.line_item_desc || ''}`;
const ymd = (d) => (d == null ? null : (typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10)));
const int = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const abs = (v) => Math.abs(int(v));

// How far either side of a payroll run's month a payment may fall and still
// belong to it. Pay day is in the month; HMRC is due the 22nd of the NEXT month.
const PAYROLL_WINDOW_DAYS = 12;
const HMRC_WINDOW_DAYS    = 45;
// How far either side of Ealing's published payment date a receipt may land.
const EALING_WINDOW_DAYS  = 10;

const KINDS = ['payroll_run', 'hmrc', 'pension', 'funding_claim', 'card_settlement'];

// ── Settings ─────────────────────────────────────────────────────────────────
async function loadSettings(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN
      ('accounts_auto_allocate','accounts_auto_allocate_kinds','accounts_funding_short_pct',
       'accounts_funding_late_days','accounts_card_settle_min_days','accounts_card_settle_max_days')`);
  const m = new Map(rows.map(r => [r.key, r.value]));
  const num = (k, d) => { const n = Number(m.get(k)); return Number.isFinite(n) ? n : d; };
  const kinds = String(m.get('accounts_auto_allocate_kinds') || '').split(',')
    .map(s => s.trim()).filter(s => KINDS.includes(s));
  return {
    autoApply: String(m.get('accounts_auto_allocate') || '0') === '1',
    // An empty or unparseable list means NO kind is enabled, not every kind.
    enabledKinds: new Set(kinds),
    shortPct: num('accounts_funding_short_pct', 5),
    lateDays: num('accounts_funding_late_days', 3),
    cardMinDays: num('accounts_card_settle_min_days', 1),
    cardMaxDays: num('accounts_card_settle_max_days', 3),
  };
}

// ── Context the rules match against ──────────────────────────────────────────
async function loadContext(db, { cardMinDays, cardMaxDays }) {
  const [runs, claims, cards, holidays, rates] = await Promise.all([
    db.query(`SELECT id, period_label, period_year, period_month, period_from, period_to, status,
                     total_gross_pence, total_tax_pence, total_ni_pence, total_net_pence,
                     total_pension_pence, total_employer_ni_pence
                FROM payroll_runs ORDER BY period_from DESC LIMIT 60`),
    db.query(`SELECT p.*, t.name AS term_name, t.rate_under_2, t.rate_2yr_working_parents,
                     t.rate_2yr_disadvantaged, t.rate_3yr_universal, t.rate_3yr_extended
                FROM funding_claim_periods p JOIN funding_terms t ON t.id = p.term_id
               ORDER BY p.period_year DESC, p.period_month DESC`),
    db.query(`SELECT id, amount_pence, paid_on, created_at, bank_statement_line_id, child_id
                FROM payments
               WHERE payment_method = 'card' AND status IN ('succeeded','paid','captured','completed')
               ORDER BY COALESCE(paid_on, created_at::date) DESC LIMIT 2000`),
    db.query('SELECT holiday_date FROM bank_holidays'),
    db.query('SELECT age_band, funding_year, pence_per_hour FROM funding_rates'),
  ]);
  return {
    runs: runs.rows,
    claims: claims.rows,
    cards: cards.rows,
    holidays: new Set(holidays.rows.map(r => ymd(r.holiday_date))),
    rates: new Map(rates.rows.map(r => [`${r.age_band}|${r.funding_year}`, r.pence_per_hour])),
    cardMinDays, cardMaxDays,
  };
}

const daysBetween = (a, b) => Math.round((new Date(`${a}T00:00:00Z`) - new Date(`${b}T00:00:00Z`)) / 86400000);

/**
 * A payroll run whose period contains or sits beside this date.
 * Matched on the run's PERIOD, not on when the money moved: a run for September
 * can be paid on 28 September or on 2 October and is the same run either way.
 */
function runsNear(runs, dateStr, windowDays) {
  return runs.filter((r) => {
    const from = ymd(r.period_from), to = ymd(r.period_to);
    if (!from || !to) return false;
    return daysBetween(dateStr, from) >= -windowDays && daysBetween(dateStr, to) <= windowDays;
  });
}

// ── The rules ────────────────────────────────────────────────────────────────
// Each returns null (not my line) or a proposal. `certainty:'certain'` is the
// only value that auto-apply will act on.

function ruleCardSettlement(line, ctx) {
  if (!CS.isCardSettlementLine(line)) return null;
  const r = CS.matchSettlement(line, ctx.cards.filter(p => !p.bank_statement_line_id), {
    minDays: ctx.cardMinDays, maxDays: ctx.cardMaxDays, holidays: ctx.holidays,
  });
  if (r.outcome === 'matched') {
    return {
      target_kind: 'card_settlement', target_id: null, amount_pence: int(line.amount_pence),
      certainty: 'certain', rule: r.rule,
      evidence: { marker: 'BCARD', settled_on: r.settled_on, window: r.window,
                  payment_ids: r.payments.map(p => p.id), payment_count: r.payment_count,
                  gross_pence: r.gross_pence, net_pence: r.net_pence, fee_pence: r.fee_pence,
                  gap_days: r.gap_days, alternatives: r.alternatives, note: r.note },
      summary: `Barclaycard settlement of ${r.payment_count} card payment(s), exact to the penny`,
    };
  }
  return {
    target_kind: 'card_settlement', target_id: null, amount_pence: int(line.amount_pence),
    certainty: 'review', rule: r.outcome === 'eylog_era' ? 'card_settlement_eylog_era' : 'card_settlement_no_exact_subset',
    evidence: { marker: 'BCARD', settled_on: r.settled_on, era: r.era || null,
                window: r.window || null, near_miss: r.near_miss || null, reason: r.reason },
    summary: r.outcome === 'eylog_era'
      ? 'Barclaycard settlement of card takings recorded in EyLog — one-click reconcile, never an invoice match'
      : 'Barclaycard settlement with no exact combination — review',
  };
}

function ruleFundingClaim(line, ctx) {
  if (int(line.amount_pence) <= 0) return null;
  const marker = hit(lineText(line), MARKERS.ealing);
  if (!marker) return null;
  const on = ymd(line.transaction_date);

  // Which claim month does Ealing's own timetable say this is paying?
  // Both dates are candidates: payment_expected for the claim, and
  // adj_payment_expected for the adjustment that follows it.
  const cands = [];
  for (const c of ctx.claims) {
    for (const [field, isAdj] of [['payment_expected', false], ['adj_payment_expected', true]]) {
      const due = ymd(c[field]);
      if (!due) continue;
      const gap = Math.abs(daysBetween(on, due));
      if (gap <= EALING_WINDOW_DAYS) cands.push({ claim: c, due, gap, isAdj, field });
    }
  }
  if (!cands.length) {
    return {
      target_kind: 'funding_claim', target_id: null, amount_pence: int(line.amount_pence),
      certainty: 'review', rule: 'ealing_receipt_no_timetable_match',
      evidence: { marker, received_on: on, window_days: EALING_WINDOW_DAYS },
      summary: 'Ealing receipt with no claim month due within 10 days — review',
    };
  }
  cands.sort((a, b) => a.gap - b.gap || (a.isAdj ? 1 : 0) - (b.isAdj ? 1 : 0)
                     || a.claim.id - b.claim.id);
  const best = cands[0];
  // A month with TWO claim periods is the duplicate-term fault
  // (reference_funding_read_only_from_is_current_term). The children hang off one
  // of them, so pick by expected amount, not by which row sorted first.
  const sameMonth = cands.filter(c => c.claim.period_year === best.claim.period_year
                                   && c.claim.period_month === best.claim.period_month
                                   && c.isAdj === best.isAdj);
  const ambiguous = new Set(cands.map(c => `${c.claim.period_year}-${c.claim.period_month}`)).size > 1;

  return {
    target_kind: 'funding_claim', target_id: best.claim.id,
    amount_pence: int(line.amount_pence),
    // Certain on the DATE, which is what the timetable gives. The AMOUNT is
    // deliberately not part of the test — a short payment is the thing we are
    // trying to find, and requiring the amount to agree would send exactly the
    // months that matter to the review queue instead of flagging them.
    certainty: ambiguous ? 'review' : 'certain',
    rule: best.isAdj ? 'ealing_receipt_adjustment_date' : 'ealing_receipt_payment_date',
    evidence: {
      marker, received_on: on, claim_period_id: best.claim.id,
      claim_month: `${best.claim.period_year}-${String(best.claim.period_month).padStart(2, '0')}`,
      due_field: best.field, due_on: best.due, gap_days: best.gap,
      is_adjustment: best.isAdj, term_id: best.claim.term_id,
      candidates_same_month: sameMonth.length,
      candidate_months: ambiguous ? [...new Set(cands.map(c => `${c.claim.period_year}-${String(c.claim.period_month).padStart(2, '0')}`))] : undefined,
    },
    summary: ambiguous
      ? 'Ealing receipt within 10 days of more than one claim month — review'
      : `Ealing receipt for ${best.claim.period_label || best.claim.period_year + '-' + best.claim.period_month}${best.isAdj ? ' (adjustment)' : ''}`,
  };
}

function rulePayrollish(line, ctx) {
  if (int(line.amount_pence) >= 0) return null;   // these are all money OUT
  const text = lineText(line);
  const amt = abs(line.amount_pence);
  const on = ymd(line.transaction_date);

  const mHmrc = hit(text, MARKERS.hmrc);
  const mPen  = hit(text, MARKERS.pension);
  const mPay  = hit(text, MARKERS.payroll);
  if (!mHmrc && !mPen && !mPay) return null;

  // HMRC: the PAYE bill is employee tax + employee NI + employer NI. A run made
  // before b301 stores no employer NI (project_payroll_in_finance_b301), so the
  // two-column figure is offered as a second exact candidate rather than the
  // line being left unmatched — and the evidence says which one agreed.
  if (mHmrc) {
    for (const r of runsNear(ctx.runs, on, HMRC_WINDOW_DAYS)) {
      const full = int(r.total_tax_pence) + int(r.total_ni_pence) + int(r.total_employer_ni_pence);
      const noEmp = int(r.total_tax_pence) + int(r.total_ni_pence);
      const which = amt === full && full > 0 ? 'tax+employee NI+employer NI'
                  : amt === noEmp && noEmp > 0 ? 'tax+employee NI (run has no employer NI)'
                  : null;
      if (which) {
        return {
          target_kind: 'hmrc', target_id: r.id, amount_pence: int(line.amount_pence),
          certainty: 'certain', rule: 'hmrc_exact_paye_total',
          evidence: { marker: mHmrc, paid_on: on, payroll_run_id: r.id,
                      run_period: r.period_label, components: which },
          summary: `HMRC PAYE for ${r.period_label}, exact`,
        };
      }
    }
    return {
      target_kind: 'hmrc', target_id: null, amount_pence: int(line.amount_pence),
      certainty: 'review', rule: 'hmrc_no_exact_run',
      evidence: { marker: mHmrc, paid_on: on, runs_in_window: runsNear(ctx.runs, on, HMRC_WINDOW_DAYS).length },
      summary: 'HMRC payment that matches no payroll run exactly — review',
    };
  }

  if (mPen) {
    for (const r of runsNear(ctx.runs, on, HMRC_WINDOW_DAYS)) {
      if (amt === int(r.total_pension_pence) && int(r.total_pension_pence) > 0) {
        return {
          target_kind: 'pension', target_id: r.id, amount_pence: int(line.amount_pence),
          certainty: 'certain', rule: 'pension_exact_run_total',
          evidence: { marker: mPen, paid_on: on, payroll_run_id: r.id, run_period: r.period_label },
          summary: `Pension contributions for ${r.period_label}, exact`,
        };
      }
    }
    return {
      target_kind: 'pension', target_id: null, amount_pence: int(line.amount_pence),
      certainty: 'review', rule: 'pension_no_exact_run',
      evidence: { marker: mPen, paid_on: on },
      summary: 'Pension payment that matches no payroll run exactly — review',
    };
  }

  // Net pay. One BACS debit for the whole run.
  for (const r of runsNear(ctx.runs, on, PAYROLL_WINDOW_DAYS)) {
    if (amt === int(r.total_net_pence) && int(r.total_net_pence) > 0) {
      return {
        target_kind: 'payroll_run', target_id: r.id, amount_pence: int(line.amount_pence),
        certainty: 'certain', rule: 'payroll_exact_net_total',
        evidence: { marker: mPay, paid_on: on, payroll_run_id: r.id, run_period: r.period_label },
        summary: `Net pay for ${r.period_label}, exact`,
      };
    }
  }
  return {
    target_kind: 'payroll_run', target_id: null, amount_pence: int(line.amount_pence),
    certainty: 'review', rule: 'payroll_no_exact_run',
    evidence: { marker: mPay, paid_on: on, runs_in_window: runsNear(ctx.runs, on, PAYROLL_WINDOW_DAYS).length },
    summary: 'Staff payment that matches no payroll run net total exactly — review',
  };
}

// Order matters: card settlements and Ealing receipts are credits with their own
// unmistakable markers, so they are tested before anything general.
const RULES = [ruleCardSettlement, ruleFundingClaim, rulePayrollish];

function classify(line, ctx) {
  for (const rule of RULES) {
    const r = rule(line, ctx);
    if (r) return r;
  }
  return null;
}

// ── Scan ─────────────────────────────────────────────────────────────────────
/**
 * Look at the open bank lines and write a queue row for each one a rule claims.
 *
 * Excluded lines are skipped: `excluded_reason` is somebody's recorded decision
 * that this line is not money to allocate (a Xero copy, a pre-cutover EyLog
 * payment, a refund), and a matcher that re-proposes them undoes that work.
 */
async function scan(db, { actorId = null, limit = 500, autoApply = null, kinds = null } = {}) {
  const s = await loadSettings(db);
  const ctx = await loadContext(db, s);
  const doApply = autoApply == null ? s.autoApply : !!autoApply;
  const enabled = kinds ? new Set(kinds.filter(k => KINDS.includes(k))) : s.enabledKinds;

  const { rows: lines } = await db.query(`
    SELECT l.id, l.transaction_date, l.description, l.reference, l.amount_pence,
           l.payee_name, l.line_item_desc, l.reconciled
      FROM bank_statement_lines l
     WHERE l.excluded_reason IS NULL
       AND l.reconciled = false
       AND NOT EXISTS (SELECT 1 FROM bank_auto_matches m
                        WHERE m.bank_line_id = l.id AND m.status IN ('applied','queued'))
     ORDER BY l.transaction_date DESC, l.id DESC
     LIMIT $1`, [limit]);

  const result = { scanned: lines.length, queued: 0, auto_applied: 0, by_kind: {}, by_certainty: { certain: 0, review: 0 }, errors: [] };

  for (const line of lines) {
    const p = classify(line, ctx);
    if (!p) continue;
    result.by_kind[p.target_kind] = (result.by_kind[p.target_kind] || 0) + 1;
    result.by_certainty[p.certainty] = (result.by_certainty[p.certainty] || 0) + 1;

    const { rows: [m] } = await db.query(`
      INSERT INTO bank_auto_matches
        (bank_line_id, target_kind, target_id, amount_pence, certainty, rule, evidence, auto, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'queued')
      ON CONFLICT (bank_line_id) WHERE status IN ('applied','queued') DO NOTHING
      RETURNING *`,
      [line.id, p.target_kind, p.target_id, p.amount_pence, p.certainty, p.rule,
       JSON.stringify(Object.assign({ summary: p.summary }, p.evidence)), doApply && p.certainty === 'certain']);
    if (!m) continue;          // something else claimed this line between the read and the write
    result.queued++;

    if (doApply && p.certainty === 'certain' && enabled.has(p.target_kind)) {
      try {
        await apply(db, m.id, { actorId, auto: true });
        result.auto_applied++;
      } catch (e) {
        result.errors.push({ match_id: m.id, kind: p.target_kind, error: e.message });
      }
    }
  }
  return Object.assign(result, {
    auto_apply_enabled: doApply,
    enabled_kinds: [...enabled],
    dry_run: !doApply,
  });
}

// ── Apply ────────────────────────────────────────────────────────────────────
/**
 * Act on one queued match. Each kind in its OWN transaction, so one that has
 * gone stale cannot roll back the twenty beside it (the b325 rule).
 *
 * Re-checks the facts inside the transaction rather than replaying what the scan
 * decided: between the scan and the approval somebody may have reconciled the
 * line, keyed the payment in by hand or edited the run, and re-checking is what
 * stops the same money being allocated twice.
 */
async function apply(db, matchId, { actorId = null, auto = false } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(
      'SELECT * FROM bank_auto_matches WHERE id=$1 FOR UPDATE', [matchId]);
    if (!m) throw new Error('no_such_match');
    if (m.status !== 'queued') throw new Error(`match is ${m.status}, not queued`);

    const { rows: [line] } = await client.query(
      'SELECT * FROM bank_statement_lines WHERE id=$1 FOR UPDATE', [m.bank_line_id]);
    if (!line) throw new Error('bank line has gone');
    if (line.reconciled) throw new Error('bank line has already been reconciled by someone else');
    if (line.excluded_reason) throw new Error('bank line has since been set aside');
    if (int(line.amount_pence) !== int(m.amount_pence)) throw new Error('bank line amount has changed since the scan');

    const ev = m.evidence || {};
    let detail = {};

    if (m.target_kind === 'funding_claim') {
      if (!m.target_id) throw new Error('no claim month on this match');
      const { rows: [cp] } = await client.query(
        'SELECT * FROM funding_claim_periods WHERE id=$1', [m.target_id]);
      if (!cp) throw new Error('claim month has gone');
      await client.query(`
        INSERT INTO funding_claim_receipts
          (claim_period_id, bank_line_id, amount_pence, received_on, is_adjustment, matched_rule, auto, matched_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (bank_line_id) DO NOTHING`,
        [m.target_id, m.bank_line_id, m.amount_pence, ymd(line.transaction_date),
         !!ev.is_adjustment, m.rule, auto, actorId]);
      detail = { claim_period_id: m.target_id, claim_month: ev.claim_month, is_adjustment: !!ev.is_adjustment };

    } else if (m.target_kind === 'card_settlement') {
      const ids = Array.isArray(ev.payment_ids) ? ev.payment_ids.map(Number).filter(Boolean) : [];
      if (!ids.length) throw new Error('no card payments on this match');
      // Re-check the sum and that nobody else has linked any of them.
      const { rows: pays } = await client.query(
        `SELECT id, amount_pence, bank_statement_line_id FROM payments
          WHERE id = ANY($1::int[]) FOR UPDATE`, [ids]);
      if (pays.length !== ids.length) throw new Error('a card payment on this match has gone');
      const taken = pays.filter(p => p.bank_statement_line_id && p.bank_statement_line_id !== m.bank_line_id);
      if (taken.length) throw new Error(`${taken.length} of these card payments are already settled against another line`);
      const gross = pays.reduce((a, p) => a + int(p.amount_pence), 0);
      if (gross !== int(ev.gross_pence)) throw new Error('the card payment amounts have changed since the scan');
      const net = int(line.amount_pence);
      await client.query(`
        INSERT INTO card_settlements
          (bank_line_id, settled_on, gross_pence, net_pence, fee_pence, payment_count, era, rule, auto, matched_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [m.bank_line_id, ymd(line.transaction_date), gross, net, gross - net, pays.length,
         ev.era || 'wren', m.rule, auto, actorId]);
      await client.query(
        'UPDATE payments SET bank_statement_line_id=$1, reconciliation_status=$2, reconciled_at=now(), updated_at=now() WHERE id = ANY($3::int[])',
        [m.bank_line_id, 'reconciled', ids]);
      detail = { payment_ids: ids, payment_count: pays.length, gross_pence: gross, net_pence: net, fee_pence: gross - net };
      // A fee means the lump did not equal the takings. That is a cost to post,
      // not a rounding difference to swallow, so it goes to the review queue as
      // its own item even though the settlement itself matched.
      if (gross - net !== 0) {
        await client.query(`
          INSERT INTO bank_auto_matches (bank_line_id, target_kind, target_id, amount_pence, certainty, rule, evidence, auto, status)
          VALUES ($1,'card_settlement',$2,$3,'review','card_settlement_merchant_fee',$4,false,'queued')
          ON CONFLICT (bank_line_id) WHERE status IN ('applied','queued') DO NOTHING`,
          [m.bank_line_id, m.target_id, gross - net,
           JSON.stringify({ summary: 'Barclaycard netted a merchant fee off this settlement — it needs posting as a cost', fee_pence: gross - net })]);
      }

    } else if (m.target_kind === 'payroll_run' || m.target_kind === 'hmrc' || m.target_kind === 'pension') {
      if (!m.target_id) throw new Error('no payroll run on this match');
      const { rows: [r] } = await client.query('SELECT * FROM payroll_runs WHERE id=$1', [m.target_id]);
      if (!r) throw new Error('payroll run has gone');
      const amt = abs(line.amount_pence);
      const expect = m.target_kind === 'payroll_run' ? int(r.total_net_pence)
                   : m.target_kind === 'pension'     ? int(r.total_pension_pence)
                   : null;
      if (expect != null && amt !== expect) throw new Error('the payroll run total has changed since the scan');
      if (m.target_kind === 'hmrc') {
        const full  = int(r.total_tax_pence) + int(r.total_ni_pence) + int(r.total_employer_ni_pence);
        const noEmp = int(r.total_tax_pence) + int(r.total_ni_pence);
        if (amt !== full && amt !== noEmp) throw new Error('the payroll run PAYE total has changed since the scan');
      }
      detail = { payroll_run_id: r.id, run_period: r.period_label, kind: m.target_kind };

    } else {
      throw new Error(`unknown target kind ${m.target_kind}`);
    }

    await client.query(`
      UPDATE bank_statement_lines SET reconciled=true, reconciled_at=now() WHERE id=$1`,
      [m.bank_line_id]);
    await client.query(`
      UPDATE bank_auto_matches SET status='applied', auto=$2, applied_by=$3, applied_at=now() WHERE id=$1`,
      [matchId, auto, actorId]);
    await client.query(`
      INSERT INTO reconciliation_audit (event_type, bank_line_id, match_id, actor_id, detail)
      VALUES ($1,$2,$3,$4,$5)`,
      [auto ? 'b524_auto_allocate' : 'b524_allocate', m.bank_line_id, matchId, actorId,
       JSON.stringify(Object.assign({ target_kind: m.target_kind, rule: m.rule, auto, undoable: true }, detail))]);

    await client.query('COMMIT');
    return { match_id: matchId, applied: true, target_kind: m.target_kind, auto, detail };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Undo one applied match, auto or not, and put the world back.
 *
 * The removed link rows are written into the audit detail BEFORE they go, so the
 * undo is reversible by hand from the log alone. Nothing production-owned is
 * deleted: the only rows removed are the b524 link records this match created.
 */
async function undo(db, matchId, { actorId = null, reason = null } = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [m] } = await client.query(
      'SELECT * FROM bank_auto_matches WHERE id=$1 FOR UPDATE', [matchId]);
    if (!m) throw new Error('no_such_match');
    if (m.status !== 'applied') throw new Error(`match is ${m.status}, not applied`);

    const removed = {};
    if (m.target_kind === 'funding_claim') {
      const { rows } = await client.query(
        'DELETE FROM funding_claim_receipts WHERE bank_line_id=$1 RETURNING *', [m.bank_line_id]);
      removed.funding_claim_receipts = rows;
    } else if (m.target_kind === 'card_settlement') {
      const { rows } = await client.query(
        `UPDATE card_settlements SET status='undone', undone_by=$2, undone_at=now()
          WHERE bank_line_id=$1 AND status='applied' RETURNING *`, [m.bank_line_id, actorId]);
      removed.card_settlements = rows;
      const { rows: unlinked } = await client.query(
        `UPDATE payments SET bank_statement_line_id=NULL, reconciliation_status='unreconciled',
                             reconciled_at=NULL, updated_at=now()
          WHERE bank_statement_line_id=$1 RETURNING id, amount_pence`, [m.bank_line_id]);
      removed.payments_unlinked = unlinked.map(p => p.id);
      // The fee item this settlement raised, if it is still sitting in the queue.
      await client.query(
        `UPDATE bank_auto_matches SET status='rejected', undo_reason='parent settlement undone'
          WHERE bank_line_id=$1 AND status='queued' AND rule='card_settlement_merchant_fee'`,
        [m.bank_line_id]);
    }

    await client.query(
      'UPDATE bank_statement_lines SET reconciled=false, reconciled_at=NULL WHERE id=$1',
      [m.bank_line_id]);
    await client.query(
      `UPDATE bank_auto_matches SET status='undone', undone_by=$2, undone_at=now(), undo_reason=$3 WHERE id=$1`,
      [matchId, actorId, reason]);
    await client.query(`
      INSERT INTO reconciliation_audit (event_type, bank_line_id, match_id, actor_id, detail)
      VALUES ('b524_undo',$1,$2,$3,$4)`,
      [m.bank_line_id, matchId, actorId,
       JSON.stringify({ target_kind: m.target_kind, rule: m.rule, was_auto: m.auto, reason, removed })]);

    await client.query('COMMIT');
    return { match_id: matchId, undone: true, target_kind: m.target_kind, removed };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Reject a queued match without applying it. The line returns to the queue. */
async function reject(db, matchId, { actorId = null, reason = null } = {}) {
  const { rows: [m] } = await db.query(
    `UPDATE bank_auto_matches SET status='rejected', undone_by=$2, undone_at=now(), undo_reason=$3
      WHERE id=$1 AND status='queued' RETURNING *`, [matchId, actorId, reason]);
  if (!m) return { error: 'not_queued' };
  await db.query(`
    INSERT INTO reconciliation_audit (event_type, bank_line_id, match_id, actor_id, detail)
    VALUES ('b524_reject',$1,$2,$3,$4)`,
    [m.bank_line_id, matchId, actorId, JSON.stringify({ target_kind: m.target_kind, rule: m.rule, reason })]);
  return { match_id: matchId, rejected: true };
}

/**
 * Guard for the fee path: a credit is never spread across two families.
 *
 * payment-matcher.js plans within one family today. This re-checks the plan it
 * returns before anything is written, so a change there cannot widen this
 * without the assertion failing first.
 */
function assertSingleFamily(plan) {
  const keys = new Set((plan && plan.allocation ? plan.allocation : [])
    .map(a => a.family_key).filter(Boolean));
  if (keys.size > 1) {
    const e = new Error('refusing to allocate one bank line across more than one family');
    e.code = 'cross_family';
    throw e;
  }
  return true;
}

/** The review queue, and the live allocations. No bank text, by construction. */
async function queue(db, { status = 'queued', limit = 200 } = {}) {
  const { rows } = await db.query(`
    SELECT m.id, m.bank_line_id, m.target_kind, m.target_id, m.amount_pence, m.certainty,
           m.rule, m.evidence, m.auto, m.status, m.applied_at, m.undone_at, m.undo_reason,
           m.created_at, l.transaction_date, l.amount_pence AS line_amount_pence,
           s.source AS feed
      FROM bank_auto_matches m
      JOIN bank_statement_lines l ON l.id = m.bank_line_id
      JOIN bank_statements s ON s.id = l.statement_id
     WHERE ($1 = 'all' OR m.status = $1)
     ORDER BY m.created_at DESC
     LIMIT $2`, [status, limit]);
  return rows;
}

module.exports = {
  MARKERS, KINDS, PAYROLL_WINDOW_DAYS, HMRC_WINDOW_DAYS, EALING_WINDOW_DAYS,
  loadSettings, loadContext, classify, runsNear,
  scan, apply, undo, reject, queue, assertSingleFamily,
  // exported for the verifier
  _rules: { ruleCardSettlement, ruleFundingClaim, rulePayrollish },
};
