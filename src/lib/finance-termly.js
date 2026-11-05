'use strict';
/**
 * finance-termly.js — b346 (2026-09-21)
 *
 * The termly money report: for a chosen funding term, against the SAME months a
 * year earlier — what came in, where it went, what rose, and whether a rise is a
 * problem or just more children.
 *
 * ── THE RULE THAT SHAPES THE FILE: ONLY OVER RECONCILED DATA ────────────────
 * A confident wrong number is worse than no number. So before this file computes
 * anything, every month in the window has to pass three independent checks:
 *
 *   1. XERO HAS IT.        A P&L period exists for the month and is not partial
 *                          (Xero was last updated AFTER the month ended).
 *   2. SOMEBODY SAID SO.   The bank-reconciliation job on the calendar has been
 *                          marked done "reconciled through" a date on or after the
 *                          month's end. Wren cannot see this for itself: Xero's
 *                          BankTransactions endpoint only returns transactions that
 *                          are ALREADY reconciled (b226), so Wren's bank table is
 *                          structurally blind to "money that is in the bank and not
 *                          yet reconciled". Nothing in the data can prove a month is
 *                          reconciled; a person has to say it, and be recorded saying it.
 *   3. NOTHING IS KNOWN  No bank line in Wren for the month is unreconciled
 *      TO BE OUTSTANDING. (neither `reconciled` nor `xero_is_reconciled`).
 *
 * A window that fails any check produces the WARNING and NO NUMBER: what is
 * missing, month by month, and the unreconciled lines' count and total — never a
 * total that looks like an answer. If the current term passes and last year's does
 * not, this term's figures are shown and the comparison is withheld, with the
 * reason at the top.
 *
 * ── SOURCES (each named on the response) ────────────────────────────────────
 *   Fees invoiced   Wren invoices, SERVICE-month basis — b227's incomeSummary, so
 *                   this report and the Income summary can never disagree.
 *   Fees collected  Wren payments by paid-on month — b227's paymentsReceived.
 *   Funding claimed EyMan monthly funding report (eyman_monthly_funding): amount and
 *                   used hours. A month with no rows is MISSING, never £0.
 *   Other income    Xero income accounts that are not the fee/funding account.
 *   Spend           Xero P&L accounts, by month (finance-facts pnlPeriods) — the
 *                   accountant's own categories. Bank lines are a CONTROL here, not
 *                   a spend source: Wren holds a few dozen, Xero holds the year.
 *   Per child       spend ÷ child-months (distinct children invoiced per service month).
 *   Per funded hour spend ÷ funded hours (used_hours in the funding report).
 *
 * ── MONEY ───────────────────────────────────────────────────────────────────
 * Pence, integers, end to end. Divisions round SYMMETRICALLY (half away from zero)
 * so a loss and an equal gain round to the same size. Percentages are integer
 * tenths of a percent; shares are integer basis points. Nothing is a float that is
 * shown as money, and a loss is never worded as a gain: the sign words are chosen
 * from the integer, and a change too small to show as ±0.1% is printed "<0.1%", with
 * its sign, never "0%".
 *
 * ── PAY ─────────────────────────────────────────────────────────────────────
 * Staff-cost lines are REMOVED — from the rows, the totals, the shares and the net —
 * for anyone without canViewSalaries. Removing only the line would leave the wage
 * bill recoverable by subtracting the other rows from the total.
 *
 * MANAGER-ONLY. Never reachable from the EY, Parents or HR portals.
 */

const facts = require('./finance-facts');
const reports = require('./finance-reports');
const store = require('./finance-calendar-store');

// ── numbers, in pence ────────────────────────────────────────────────────────
const num = v => (v == null ? 0 : Number(v) || 0);
/** Round half AWAY from zero. Math.round(-2.5) is -2, which would make a loss round smaller than the same gain. */
const sround = x => (x < 0 ? -Math.round(-x) : Math.round(x));
const commas = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** £1,234.56 — from integer pence, no float arithmetic. Negative gets a real minus sign. */
function fmtMoney(p) {
  if (p == null) return '—';
  const a = Math.abs(Math.trunc(p));
  return `${p < 0 ? '−' : ''}£${commas(Math.floor(a / 100))}.${String(a % 100).padStart(2, '0')}`;
}
/** Integer tenths of a percent → "12.3%". A non-zero change that rounds to 0.0 prints "<0.1%" with its sign. */
function fmtPctX10(x10, delta, { signed = true } = {}) {
  if (x10 == null) return '—';
  if (x10 === 0 && delta) return `${delta < 0 ? '−' : '+'}<0.1%`;
  const a = Math.abs(x10);
  const body = `${Math.floor(a / 10)}.${a % 10}%`;
  return x10 < 0 ? `−${body}` : (signed && x10 > 0 ? `+${body}` : body);
}
const bpToX10 = bp => (bp == null ? null : sround(bp / 10));

// ── months ───────────────────────────────────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ymIdx = ym => { const [y, m] = ym.split('-').map(Number); return y * 12 + (m - 1); };
const idxYm = i => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
const shiftMonth = (ym, d) => idxYm(ymIdx(ym) + d);
const monthLabel = ym => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} ${y}`; };
const monthEnd = ym => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };
function monthsBetween(startIso, endIso) {
  const out = [];
  for (let i = ymIdx(startIso.slice(0, 7)); i <= ymIdx(endIso.slice(0, 7)); i++) out.push(idxYm(i));
  return out;
}

// ── terms ────────────────────────────────────────────────────────────────────
const seasonOf = startIso => { const m = +startIso.slice(5, 7); return m >= 9 ? 'Autumn' : m <= 3 ? 'Spring' : 'Summer'; };

/**
 * funding_terms carries duplicates (the b325 finding: two rows for the same dates,
 * one `is_current`). They are folded on their start-month + end-month, preferring the
 * `is_current` row, then a name that is not the "Funding:" variant, then the lowest id.
 * The report never depends on WHICH duplicate is picked: it works on the calendar
 * months the term covers, not on the row.
 */
function dedupeTerms(rows) {
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.start_date.slice(0, 7)}|${r.end_date.slice(0, 7)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const rank = r => [r.is_current ? 0 : 1, /^funding:/i.test(r.name || '') ? 1 : 0, r.id];
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < 3; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]; return 0; });
    const t = g[0];
    out.push({ id: t.id, name: t.name, start: t.start_date, end: t.end_date, season: seasonOf(t.start_date),
               year: +t.start_date.slice(0, 4), alias_ids: g.slice(1).map(x => x.id) });
  }
  return out.sort((a, b) => (a.start < b.start ? 1 : -1));
}

async function listTerms(db, { today = store.londonToday() } = {}) {
  const { rows } = await db.query(`
    SELECT id, name, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date,
           COALESCE(is_current,false) AS is_current
      FROM funding_terms
     WHERE start_date IS NOT NULL AND end_date IS NOT NULL AND end_date > start_date`);
  const terms = dedupeTerms(rows);
  for (const t of terms) {
    t.finished = t.end < today;
    t.months = monthsBetween(t.start, t.end);
    const prior = terms.find(p => p.season === t.season && p.year === t.year - 1);
    t.prior_term_id = prior ? prior.id : null;
  }
  return terms;
}

// ── the comparison, and the sentences that state its arithmetic ──────────────
/** What a change is, in words, from the integer alone. */
const moved = d => (d > 0 ? 'rose' : d < 0 ? 'fell' : 'was unchanged');

/**
 * The net result and its comparison, worded from the SIGN of the integers. Never
 * rounds a loss into a gain: "deficit" is chosen when the integer is below zero, and
 * a deficit that got smaller is "narrowed" and still called a deficit.
 */
function netSentence(cur, prior) {
  const word = p => (p > 0 ? `a surplus of ${fmtMoney(p)}` : p < 0 ? `a deficit of ${fmtMoney(-p)}` : 'break-even (£0.00)');
  let s = `This term: ${word(cur)}.`;
  if (prior == null) return s;
  s += ` Same months last year: ${word(prior)}.`;
  const d = cur - prior;
  if (cur >= 0 && prior >= 0) {
    s += d === 0 ? ' No change.' : d > 0 ? ` The surplus grew by ${fmtMoney(d)}.` : ` The surplus shrank by ${fmtMoney(-d)}.`;
  } else if (cur < 0 && prior < 0) {
    s += d === 0 ? ' No change.' : d < 0 ? ` The deficit deepened by ${fmtMoney(-d)}.` : ` The deficit narrowed by ${fmtMoney(d)} — it is still a deficit.`;
  } else if (cur < 0) {
    s += ` It swung from a surplus to a deficit: ${fmtMoney(prior)} down to −${fmtMoney(-cur).replace('−', '')}, a fall of ${fmtMoney(prior - cur)}.`;
  } else {
    s += ` It moved from a deficit to a surplus: −${fmtMoney(-prior).replace('−', '')} up to ${fmtMoney(cur)}, a gain of ${fmtMoney(cur - prior)}.`;
  }
  return s;
}

/**
 * One mover in plain language, arithmetic stated. `per child` is what separates
 * "costs are up" from "there are more children", so the verdict is drawn from the
 * SIGN of both changes, not from a judgement about size.
 */
function moverSentence(r, ctx) {
  const c = r.current, p = r.prior;
  let s = `${r.category} ${moved(r.delta_pence)} by ${fmtMoney(Math.abs(r.delta_pence))}: ${fmtMoney(p.pence)} → ${fmtMoney(c.pence)}`;

  // A NET CREDIT on either side — money came back into the account (a refund, a reversal, a reclassification in
  // Xero). Xero's monthly balances produce these, and reading one as spend is the confident wrong story this report
  // exists to avoid: "rose from −£4,473 to £3,975" is not "a real cost increase", and last year was not "nothing
  // spent". Say what it is, give the arithmetic, and send the reader to the account. No % is offered: a percentage
  // of a negative base means nothing.
  if (p.pence < 0 || c.pence < 0) {
    const check = ' Check the account in Xero before treating this as a change in cost.';
    const what = 'money came back into the account — a refund, a reversal or a reclassification';
    if (p.pence < 0 && c.pence < 0) {
      return `${s}. Both years are net CREDITS (${what}): ${fmtMoney(-p.pence)} last year and ${fmtMoney(-c.pence)} this term. Nothing here is spend.${check}`;
    }
    if (p.pence < 0) {
      return `${s}. In the same months last year this account was a net CREDIT of ${fmtMoney(-p.pence)} (${what}), so no percentage is meaningful. `
           + `This term it carries ${fmtMoney(c.pence)} of net spend; the ${fmtMoney(Math.abs(r.delta_pence))} difference is that spend plus last year’s credit not repeating.${check}`;
    }
    return `${s}. This term the account is a net CREDIT of ${fmtMoney(-c.pence)} (${what}), against ${fmtMoney(p.pence)} spent in the same months last year, `
         + `so no percentage is meaningful. The ${r.delta_pence < 0 ? 'fall' : 'change'} is mostly that credit, not less spending.${check}`;
  }

  s += r.delta_pct_x10 == null ? ' (nothing spent in the same months last year).' : ` (${fmtPctX10(r.delta_pct_x10, r.delta_pence)}).`;
  if (c.share_bp != null && p.share_bp != null) {
    s += ` It now takes ${fmtPctX10(bpToX10(c.share_bp), 0, { signed: false })} of income (was ${fmtPctX10(bpToX10(p.share_bp), 0, { signed: false })}).`;
  }
  if (c.per_child_month_pence != null && p.per_child_month_pence != null) {
    const dpc = c.per_child_month_pence - p.per_child_month_pence;
    s += ` Children billed: ${ctx.prior.child_months} → ${ctx.current.child_months} child-months; per child per month it went ${fmtMoney(p.per_child_month_pence)} → ${fmtMoney(c.per_child_month_pence)}.`;
    if (r.delta_pence > 0) {
      s += dpc > 0 ? ' Per child it ALSO rose, so this is a real cost increase and not just more children.'
                   : ' Per child it did not rise, so the increase is explained by having more children.';
    } else if (r.delta_pence < 0) {
      s += dpc < 0 ? ' Per child it also fell.'
                   : ' Per child it did not fall — the total is lower only because there were fewer children.';
    }
  }
  if (c.per_funded_hour_pence != null && p.per_funded_hour_pence != null) {
    s += ` Per funded hour: ${fmtMoney(p.per_funded_hour_pence)} → ${fmtMoney(c.per_funded_hour_pence)}.`;
  }
  return s;
}

const FEES_FUNDING_RX = /^sales$|fee|funding|tuition|childcare|early years|\bla\b/i;

// ── the report ───────────────────────────────────────────────────────────────
/**
 * @param {object} db
 * @param {{termId:number|string, canPay?:boolean, today?:string}} opts
 */
async function termlyReport(db, { termId, canPay = false, today = store.londonToday() } = {}) {
  const terms = await listTerms(db, { today });
  const term = terms.find(t => String(t.id) === String(termId) || t.alias_ids.map(String).includes(String(termId)));
  if (!term) return { ok: false, error: 'unknown_term', message: 'That term is not in the funding terms.' };

  const cur = term.months;
  const prior = cur.map(m => shiftMonth(m, -12));
  const all = [...new Set([...prior, ...cur])].sort();
  const lo = `${all[0]}-01`, hi = monthEnd(all[all.length - 1]);
  const loIdx = ymIdx(all[0]), hiIdx = ymIdx(all[all.length - 1]);

  const [periodsList, attested, bank, income, pays, funding, kids] = await Promise.all([
    facts.pnlPeriods(db, { limit: 240 }),
    store.attestedThrough(db),
    db.query(`
      SELECT to_char(transaction_date,'YYYY-MM') AS m,
             count(*)::int AS lines,
             count(*) FILTER (WHERE NOT COALESCE(reconciled,false) AND NOT COALESCE(xero_is_reconciled,false))::int AS unrec,
             COALESCE(SUM(-amount_pence) FILTER (WHERE NOT COALESCE(reconciled,false) AND NOT COALESCE(xero_is_reconciled,false) AND amount_pence < 0),0)::bigint AS unrec_out,
             COALESCE(SUM(amount_pence)  FILTER (WHERE NOT COALESCE(reconciled,false) AND NOT COALESCE(xero_is_reconciled,false) AND amount_pence > 0),0)::bigint AS unrec_in
        FROM bank_statement_lines
       WHERE transaction_date >= $1 AND transaction_date <= $2
       GROUP BY 1`, [lo, hi]),
    reports.incomeSummary(db, { months: 180, basis: 'service' }),
    reports.paymentsReceived(db, { months: 180 }),
    db.query(`
      SELECT to_char(as_of_month,'YYYY-MM') AS m, count(*)::int AS n,
             COALESCE(SUM(amount_pence),0)::bigint AS amount_pence,
             COALESCE(ROUND(SUM(used_hours) * 100),0)::bigint AS hours_x100
        FROM eyman_monthly_funding
       WHERE as_of_month >= $1 AND as_of_month <= $2
       GROUP BY 1`, [lo, hi]),
    db.query(`
      WITH ${reports.SERVICE_MONTH_CTE}
      SELECT s_year AS y, s_month AS m, count(DISTINCT child_id)::int AS children
        FROM inv
       WHERE status NOT IN ('cancelled','void','draft') AND amount_pence > 0
         AND child_id IS NOT NULL AND s_year IS NOT NULL AND s_month IS NOT NULL
         AND (s_year * 12 + s_month - 1) BETWEEN $1 AND $2
       GROUP BY 1, 2`, [loIdx, hiIdx]),
  ]);

  const periodBy = new Map(periodsList.map(p => [p.month, p]));
  const bankBy = new Map(bank.rows.map(r => [r.m, r]));
  const incomeBy = new Map(income.months.map(m => [m.month, m]));
  const paysBy = new Map(pays.months.map(m => [m.month, m]));
  const fundBy = new Map(funding.rows.map(r => [r.m, r]));
  const kidsBy = new Map(kids.rows.map(r => [`${r.y}-${String(r.m).padStart(2, '0')}`, r.children]));

  // ── the three checks, month by month ───────────────────────────────────────
  const status = {};
  for (const m of all) {
    const problems = [];
    const end = monthEnd(m);
    const p = periodBy.get(m);
    const b = bankBy.get(m) || { lines: 0, unrec: 0, unrec_out: 0, unrec_in: 0 };
    if (!(end < today)) problems.push({ code: 'not_finished', text: `${monthLabel(m)} has not finished.` });
    if (!p) problems.push({ code: 'no_xero', text: `Xero has no profit-and-loss for ${monthLabel(m)} — nothing has synced for it.` });
    else if (p.partial) problems.push({ code: 'xero_partial', text: `Xero’s figures for ${monthLabel(m)} are incomplete: ${p.partial}.` });
    // Short on purpose: when nobody has recorded a reconciliation at all, the response says so ONCE (reconciliation.reconciled_through
    // is null and the screen states it in a sentence), and repeating a paragraph against every month buries the reasons that differ.
    if (!attested.through) problems.push({ code: 'not_attested', text: 'Not covered by any recorded bank reconciliation.' });
    else if (attested.through < end) problems.push({ code: 'not_attested', text: `Bank reconciliation is only recorded through ${attested.through}, before the end of ${monthLabel(m)}.` });
    if (b.unrec > 0) problems.push({ code: 'unreconciled_lines', text: `${b.unrec} bank line${b.unrec === 1 ? '' : 's'} in ${monthLabel(m)} ${b.unrec === 1 ? 'is' : 'are'} still unreconciled — ${fmtMoney(num(b.unrec_out))} out, ${fmtMoney(num(b.unrec_in))} in.` });
    status[m] = {
      month: m, label: monthLabel(m), ok: problems.length === 0, problems,
      xero: p ? { present: true, partial: p.partial || null, source: p.source } : { present: false },
      attested: !!attested.through && attested.through >= end,
      bank_lines: b.lines, unreconciled_lines: b.unrec, unreconciled_out_pence: num(b.unrec_out), unreconciled_in_pence: num(b.unrec_in),
    };
  }
  const windowOk = ms => ms.every(m => status[m].ok);
  const curOk = windowOk(cur), priorOk = windowOk(prior);

  // ── the warning, when there is one ─────────────────────────────────────────
  const missing = [];
  for (const [name, ms] of [['this term', cur], ['the same months last year', prior]]) {
    for (const m of ms) if (!status[m].ok) missing.push({ window: name === 'this term' ? 'current' : 'prior', month: m, label: status[m].label, reasons: status[m].problems.map(x => x.text) });
  }
  const unrec = { lines: 0, out_pence: 0, in_pence: 0 };
  for (const m of all) { unrec.lines += status[m].unreconciled_lines; unrec.out_pence += status[m].unreconciled_out_pence; unrec.in_pence += status[m].unreconciled_in_pence; }
  let warning = null;
  if (!curOk || !priorOk) {
    const badCur = cur.filter(m => !status[m].ok).length, badPrior = prior.filter(m => !status[m].ok).length;
    warning = {
      level: curOk ? 'comparison_withheld' : 'no_figures',
      headline: !curOk
        ? `This term is not reconciled, so there is no figure to show — ${badCur} of ${cur.length} month${cur.length === 1 ? '' : 's'} ${badCur === 1 ? 'is' : 'are'} not ready.`
        : `This term’s figures are shown, but the comparison is withheld — ${badPrior} of ${prior.length} month${prior.length === 1 ? '' : 's'} last year ${badPrior === 1 ? 'is' : 'are'} not ready.`,
      detail: 'Wren only reports over months where Xero has the whole month, somebody has recorded the bank accounts as reconciled through the month’s end, '
            + 'and no bank line in Wren is known to be unreconciled. Anything else would be a confident number that might be wrong.',
      missing,
      unreconciled_bank: unrec,
      how_to_fix: 'Reconcile in Xero, then record “bank accounts reconciled through <date>” — the button below, or the Deadlines tab.',
    };
  }

  const out = {
    ok: true,
    term: { id: term.id, name: term.name, start: term.start, end: term.end, season: term.season, finished: term.finished, alias_ids: term.alias_ids },
    prior_term: (() => { const t = terms.find(x => x.id === term.prior_term_id); return t ? { id: t.id, name: t.name, start: t.start, end: t.end } : null; })(),
    windows: { current: cur.map(m => ({ month: m, label: monthLabel(m) })), prior: prior.map(m => ({ month: m, label: monthLabel(m) })),
               basis: 'Compared like for like: the same calendar months, exactly twelve months earlier.' },
    pay_visible: !!canPay,
    reconciliation: {
      reconciled_through: attested.through, recorded_by: attested.by, recorded_at: attested.at, note: attested.note,
      current_ok: curOk, prior_ok: priorOk, months: all.map(m => status[m]),
    },
    warning,
    income: null, spend: null, volumes: null, net: null, movers: [],
    hidden: { staff_costs: !canPay },
    generated_at: new Date().toISOString(),
  };
  if (!curOk) return out;                              // the warning, not a number

  // ── figures for one window ─────────────────────────────────────────────────
  function figures(months) {
    const f = {
      months, fees_invoiced_pence: 0, fees_collected_pence: 0, funding_claimed_pence: 0, funding_missing: [],
      xero_income_pence: 0, other_income_pence: 0, xero_sales_pence: 0, income_accounts: {},
      child_months: 0, children_by_month: {}, funded_hours_x100: 0, spend: new Map(), invoices: 0, sources: new Set(),
    };
    for (const m of months) {
      const inc = incomeBy.get(m); if (inc) { f.fees_invoiced_pence += inc.net_pence; f.invoices += inc.invoices; }
      const pay = paysBy.get(m); if (pay) f.fees_collected_pence += pay.received_pence;
      const fu = fundBy.get(m); if (fu) { f.funding_claimed_pence += num(fu.amount_pence); f.funded_hours_x100 += num(fu.hours_x100); } else f.funding_missing.push(m);
      const k = kidsBy.get(m) || 0; f.children_by_month[m] = k; f.child_months += k;
      const p = periodBy.get(m); f.sources.add(p.source);
      for (const l of p.lines) {
        if (l.kind === 'revenue') {
          f.xero_income_pence += l.amount_pence;
          f.income_accounts[l.account] = (f.income_accounts[l.account] || 0) + l.amount_pence;
          if (FEES_FUNDING_RX.test(l.account)) f.xero_sales_pence += l.amount_pence; else f.other_income_pence += l.amount_pence;
        } else {
          const e = f.spend.get(l.account) || { kind: l.kind, pence: 0 };
          e.pence += l.amount_pence; f.spend.set(l.account, e);
        }
      }
    }
    if (f.funding_missing.length) f.funding_claimed_pence = null;
    f.wren_income_pence = (f.funding_claimed_pence == null) ? null : f.fees_invoiced_pence + f.funding_claimed_pence + f.other_income_pence;
    return f;
  }
  const F = figures(cur);
  const P = priorOk ? figures(prior) : null;

  const show = kind => canPay || kind !== 'staff';            // staff cost is removed, not blanked
  const cell = (pence, fig) => ({
    pence,
    share_bp: fig.xero_income_pence > 0 ? sround(pence * 10000 / fig.xero_income_pence) : null,
    per_child_month_pence: fig.child_months > 0 ? sround(pence / fig.child_months) : null,
    per_funded_hour_pence: fig.funded_hours_x100 > 0 ? sround(pence * 100 / fig.funded_hours_x100) : null,
  });

  const accounts = new Set([...F.spend.keys(), ...(P ? P.spend.keys() : [])]);
  const rows = [];
  for (const a of accounts) {
    const kind = (F.spend.get(a) || (P && P.spend.get(a))).kind;
    if (!show(kind)) continue;
    const c = cell((F.spend.get(a) || { pence: 0 }).pence, F);
    const pr = P ? cell((P.spend.get(a) || { pence: 0 }).pence, P) : null;
    const delta = pr ? c.pence - pr.pence : null;
    rows.push({
      category: a, kind, current: c, prior: pr, delta_pence: delta,
      // 'prior' | 'current' | 'both' — a net CREDIT (negative spend) on that side. Shown on the row and worded in the mover.
      credit: (pr && pr.pence < 0 && c.pence < 0) ? 'both' : (pr && pr.pence < 0) ? 'prior' : (c.pence < 0 ? 'current' : null),
      delta_pct_x10: pr && pr.pence > 0 ? sround(delta * 1000 / pr.pence) : null,
      share_change_bp: pr && c.share_bp != null && pr.share_bp != null ? c.share_bp - pr.share_bp : null,
    });
  }
  // Sorted by the size of the change, biggest first — never alphabetically. With no
  // comparison available there is no change to sort by, so it falls back to size.
  rows.sort((a, b) => P ? (Math.abs(b.delta_pence) - Math.abs(a.delta_pence)) || (a.category < b.category ? -1 : 1)
                        : (b.current.pence - a.current.pence) || (a.category < b.category ? -1 : 1));

  const sum = (fig, kinds) => [...fig.spend.entries()].filter(([, e]) => kinds.includes(e.kind) && show(e.kind)).reduce((s, [, e]) => s + e.pence, 0);
  const kindsOp = ['staff', 'other'];
  const totals = fig => ({
    operating_pence: sum(fig, kindsOp), non_operating_pence: sum(fig, ['non_operating']), tax_pence: sum(fig, ['tax']),
  });
  const Tc = totals(F), Tp = P ? totals(P) : null;
  const opCell = (t, fig) => cell(t.operating_pence, fig);

  out.income = {
    basis: 'Fees invoiced and funding claimed come from Wren’s own ledger; other income and every share of income come from Xero.',
    current: incomeBlock(F), prior: P ? incomeBlock(P) : null,
    xero_sales_note: 'Xero books fees and funding together under its sales account, by invoice date; Wren counts the month the care was delivered. The difference is timing, and it is shown, not hidden.',
    other_accounts: Object.keys(F.income_accounts).filter(a => !FEES_FUNDING_RX.test(a)),
  };
  function incomeBlock(fig) {
    return {
      fees_invoiced_pence: fig.fees_invoiced_pence, invoices: fig.invoices,
      funding_claimed_pence: fig.funding_claimed_pence,
      funding_missing_months: fig.funding_missing.map(monthLabel),
      other_income_pence: fig.other_income_pence,
      wren_income_pence: fig.wren_income_pence,
      fees_collected_pence: fig.fees_collected_pence,
      xero_income_pence: fig.xero_income_pence, xero_sales_pence: fig.xero_sales_pence,
      wren_vs_xero_pence: fig.wren_income_pence == null ? null : fig.wren_income_pence - fig.xero_income_pence,
    };
  }
  out.spend = {
    rows,
    totals: { current: Object.assign({}, Tc, { operating: opCell(Tc, F) }), prior: Tp ? Object.assign({}, Tp, { operating: opCell(Tp, P) }) : null },
    note: canPay ? null : 'Staff costs are not shown for your role, and every total and share on this page excludes them.',
    basis: 'Xero profit-and-loss accounts, summed over the months of the term. Below-the-line items (depreciation, interest, corporation tax) are listed but are not in the operating total and are never offered as things to cut.',
    sources: [...F.sources].map(facts.sourceLabel),
  };
  out.volumes = {
    current: { child_months: F.child_months, children_by_month: F.children_by_month, funded_hours_x100: F.funded_hours_x100 },
    prior: P ? { child_months: P.child_months, children_by_month: P.children_by_month, funded_hours_x100: P.funded_hours_x100 } : null,
    child_months_note: 'A child-month is one child invoiced for one service month. Per-child figures divide by it.',
    funded_hours_note: 'Funded hours are the hours the EyMan funding report says were used; per-funded-hour figures divide by them.',
  };

  if (canPay) {
    const netC = F.xero_income_pence - Tc.operating_pence - Tc.non_operating_pence;
    const netP = P ? P.xero_income_pence - Tp.operating_pence - Tp.non_operating_pence : null;
    out.net = { current_pence: netC, prior_pence: netP, sentence: netSentence(netC, netP),
                basis: 'Xero income less operating and non-operating costs; corporation tax is not deducted.' };
  } else {
    out.net = { current_pence: null, prior_pence: null, sentence: null,
                withheld: 'The result includes staff costs, which are not shown for your role.' };
  }

  if (P) {
    const ctx = { current: { child_months: F.child_months }, prior: { child_months: P.child_months } };
    out.movers = rows
      .filter(r => (r.kind === 'staff' || r.kind === 'other') && r.delta_pence !== 0)
      .slice(0, 3)
      .map(r => ({ category: r.category, kind: r.kind, delta_pence: r.delta_pence, delta_pct_x10: r.delta_pct_x10,
                   sentence: moverSentence(r, ctx),
                   arithmetic: { prior_pence: r.prior.pence, current_pence: r.current.pence, delta_pence: r.delta_pence } }));
  }
  return out;
}

module.exports = {
  termlyReport, listTerms,
  // pure helpers, exported for scripts/b346-verify.js
  dedupeTerms, monthsBetween, shiftMonth, monthEnd, monthLabel, seasonOf, sround, fmtMoney, fmtPctX10, netSentence, moverSentence, FEES_FUNDING_RX,
};
