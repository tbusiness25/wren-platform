'use strict';
/**
 * finance-calendar.js — b346 collector. The company's tax and filing deadlines.
 *
 * ── WHEN A CARD APPEARS, AND WHEN IT GOES RED ───────────────────────────────
 * A card appears at OUR OWN internal date (statutory date minus a lead time) and
 * not before — a board that lists next April's tax return in September is a wall.
 * From then until the statutory date is close it is AMBER. It goes RED when the
 * statutory date is within 7 days or has passed, because that is what rag.js says
 * about every statutory deadline on this board: the colour is decided THERE, from
 * facts this file states, and nowhere in this file. (Toby's brief said "red at the
 * statutory one"; rag.js turns red 7 days ahead of it and stays red after. The
 * house rule wins so this board never colours two statutory cards two ways.)
 *
 * Internal-only jobs (bank reconciliation, Xero catch-up, payroll cut-off) have no
 * statutory date and so are never red — a missed internal date is amber, and stays
 * amber, however late.
 *
 * ── HOW A CARD CLEARS ───────────────────────────────────────────────────────
 * The calendar is the record, the board only reflects it. Marking an occurrence
 * done (with a note of what was filed) or not-applicable makes this collector stop
 * reporting it, and the refresh closes the card. It closes as an AUTOMATIC close
 * (resolved_by NULL), so reopening in the calendar brings the card back at once
 * rather than after the 7-day "a human's decision holds" grace in index.js.
 *
 * ── SAFE WHERE THE MIGRATION HAS NOT RUN ────────────────────────────────────
 * scripts/attention-refresh.js runs on the HOST at 06:45 against production, out of
 * the working tree — so a collector added here reaches prod the next morning even
 * though b346 is a dev-only build. On a database without the b346 tables this
 * returns ok:false ("I could not look"), which by rule 2 in index.js resolves
 * nothing and creates nothing. It is inert until Toby applies the migration.
 *
 * No amounts, no child, parent or staff name — dates, rule names and who is blocked.
 */

const { getPool } = require('../../db/pool');
const { classify } = require('./rag');
const store = require('../../lib/finance-calendar-store');
const cal = require('../../lib/finance-calendar');

const SOURCE = 'finance_calendar';
const CAL_URL = '/admin/finance-hmrc/calendar';
const PARTY_WORD = { toby: 'you', accountant: 'the accountant', bank: 'the bank', hmrc: 'HMRC' };

/**
 * The colour and the sentence for one OPEN occurrence — used by this collector AND by
 * the calendar screen, so the two can never disagree.
 */
function ragOf(occ) {
  // "Waiting on a decision only you can make" is a fact about an item whose own date HAS arrived. For one that is still
  // upcoming nothing is waiting on anybody yet, and saying so put an amber edge and that sentence on every job 19 days out.
  const toby = occ.blocked_on === 'toby' && occ.phase !== 'upcoming';
  if (occ.marker) return { rag: 'green', why: 'A date to know, not a job.' };

  if (occ.statutory) {
    const s = classify({ statutory: true, dueDate: occ.statutory });
    if (s.rag === 'red') return { rag: 'red', why: s.why };
    const i = classify({ dueDate: occ.internal || occ.statutory, blockedOnToby: toby });
    return { rag: i.rag, why: `${i.why} That is our own date — the statutory one is ${cal.niceDate(occ.statutory)}.` };
  }
  const i = classify({ dueDate: occ.internal, blockedOnToby: toby });
  return { rag: i.rag, why: i.why };
}

async function collect() {
  const db = getPool();
  if (!(await store.hasTables(db))) {
    return { ok: false, items: [], note: 'b346 migration not applied on this database — finance-calendar collector idle' };
  }

  const c = await store.loadCalendar(db);
  const items = [];

  for (const occ of c.occurrences) {
    if (occ.marker || occ.status !== 'open') continue;
    const first = occ.internal || occ.statutory;
    if (c.today < first) continue;               // not yet — a card appears AT the internal date

    const r = ragOf(occ);
    const rule = cal.describeRule(occ.rule);
    const party = PARTY_WORD[occ.blocked_on] || 'you';
    items.push({
      source: SOURCE,
      source_key: occ.key,
      title: `${occ.title} — ${occ.label}`,
      detail: `${occ.statutory ? `Statutory date ${cal.niceDate(occ.statutory)}; our own date ${cal.niceDate(occ.internal)}.` : `Our own date ${cal.niceDate(occ.internal)} (no statutory date).`} `
            + `Waiting on ${party}. ${occ.verify ? 'Confirm this date against the Pensions Regulator’s letter. ' : ''}`
            + `Mark it done in Finance → HMRC & Deadlines with a note of what was filed${rule && rule.evidence ? ` and where the evidence is (${rule.evidence})` : ''}. Wren files nothing and contacts nobody.`,
      why: r.why,
      rag: r.rag,
      category: 'finance',
      due_date: occ.statutory || occ.internal,
      blocked_on: occ.blocked_on === 'toby' ? 'toby' : 'external',
      effort_minutes: occ.effort_minutes,
      action_url: CAL_URL,
      evidence: { rule: occ.rule, period: occ.period, statutory: occ.statutory, internal: occ.internal, party: occ.blocked_on, verify: occ.verify },
      sort_hint: occ.statutory ? 2 : 3,
    });
  }

  // Deadlines that cannot be calculated yet — ONE card, not one per rule.
  if (c.schedule.needs.length) {
    const keys = [...new Set(c.schedule.needs.flatMap(n => n.keys))];
    const words = [...new Set(c.schedule.needs.flatMap(n => n.missing))];
    const k = classify({ blockedOnToby: true });
    items.push({
      source: SOURCE,
      source_key: 'company-dates-missing',
      title: `${c.schedule.needs.length} deadline${c.schedule.needs.length === 1 ? '' : 's'} cannot be calculated — ${words.length} company date${words.length === 1 ? ' is' : 's are'} missing`,
      detail: `Wren computes tax and filing dates from facts only you hold, and will not guess them. Missing: ${words.join('; ')}. `
            + 'Enter them under Finance → HMRC & Deadlines → Company dates.',
      why: k.why,
      rag: k.rag,
      category: 'finance',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 10,
      action_url: CAL_URL,
      evidence: { missing: keys, rules: c.schedule.needs.map(n => n.rule) },
      sort_hint: 1,
    });
  }

  return { ok: true, items };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect, ragOf };
