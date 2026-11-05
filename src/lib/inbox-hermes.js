'use strict';
/**
 * inbox-hermes.js — b364 (2026-09-29)
 *
 * The per-email intelligence. Toby, 2026-09-24: "Hermes would send notifications
 * when it receives them, and give context, a suggested reply, and options, and
 * explain its reasoning."
 *
 * ── THE DIVISION OF LABOUR, WHICH IS THE WHOLE DESIGN ───────────────────────
 * This file is b311's discipline applied to email: SQL decides, the model only
 * phrases.
 *
 *   facts()  is SQL. It resolves the sender to a family / supplier / member of
 *            staff / enquiry, and for an invoice query it reads the invoice
 *            number, what it was for, the funded hours the funding line states,
 *            what has been paid and what is outstanding. Every number in a card
 *            comes from here.
 *
 *   card()   hands those facts to the local model and asks it for prose: what
 *            this email is about, a draft reply, and one or two lines of
 *            reasoning. The model is never asked for a number, a balance, a date
 *            or a name it was not given, and a card whose model call failed still
 *            carries its facts and says the drafting was unavailable.
 *
 * A card is therefore two things with different standing, stored in two columns.
 * `facts` is true. `context`/`suggested_reply`/`reasoning` are a draft ABOUT
 * something true. The screen labels them differently for that reason.
 *
 * ── NOTHING HERE SENDS ANYTHING ─────────────────────────────────────────────
 * There is no mail transport in this module: no gmail-sender require, no
 * sendEmail, no SMTP. A suggested reply is a row. It becomes an email only when
 * a person presses send in the comms hub, which is the one send path in Wren and
 * which logs into inbox_reply_log. scripts/b364-verify.js greps for this.
 *
 * ── LOCAL MODELS ONLY ───────────────────────────────────────────────────────
 * Every model call goes through src/lib/sovereign-model.js, whose host parser
 * refuses anything that is not a private / Tailscale / loopback IP literal,
 * re-checked before each request. Email content cannot leave the building by any
 * path in this file.
 */

const sovereign = require('./sovereign-model');
const ai = require('./ai-models');
const sections = require('./inbox-sections');
// b487 (2026-10-12): the EY inbox's safeguarding filter needs to know which
// emails are a safeguarding case BEFORE a card has necessarily been
// generated, so the pattern lives in its own small module rather than only
// inside this file's keyword list.
const { SAFEGUARD_RE } = require('./safeguarding-keywords');

const P = n => (n == null ? null : Number(n));
const money = pence => (pence == null ? null : `£${(Number(pence) / 100).toFixed(2)}`);

/**
 * A DATE column, as a plain YYYY-MM-DD string.
 *
 * pg hands a DATE back as a JS Date at LOCAL midnight, and String() on that is
 * "Thu Oct 01 2026 00:00:00 GMT+0000 (Coordinated Universal Time)". Two things go
 * wrong if that reaches the prompt: the model spends tokens on a timezone nobody
 * asked about, and it has repeatedly quoted one back at a parent. And `.slice(0,10)`
 * in the browser — which is what every other Wren screen does to a date — turns it
 * into "Thu Oct 0". So every date is normalised HERE, once, at the point it leaves SQL.
 * (See the pg DATE → ymd() trap this project has hit before.)
 */
function ymd(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string') return v.slice(0, 10);
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── what kind of email is this? ─────────────────────────────────────────────
// Keyword detection, not a model call, because the KIND decides which SQL runs
// and a model must not be able to send the fact-gathering down the wrong path.
const CASE_PATTERNS = [
  // b487 (2026-10-12): checked FIRST, so a safeguarding phrase never gets
  // mis-sorted into 'absence' or 'complaint' before this one gets a look —
  // the EY inbox's permission filter (src/lib/ey-inbox-permissions.js) hides
  // anything with this case_kind from everyone except the DSL/deputy DSL and
  // managers, so it has to win the match, not just place.
  ['safeguarding',   SAFEGUARD_RE],
  ['invoice_query',  /\b(invoice|invoiced|bill|billed|billing|statement|balance|overpaid|underpaid|over-?charge|charged|payment|paid|direct debit|fees?|refund|credit note)\b/i],
  ['funding_query',  /\b(funded|funding|free hours|15 hours|30 hours|thirty hours|entitlement|eligibility code|declaration|stretch)\b/i],
  ['absence',        /\b(off (sick|today)|not (be )?coming|absent|absence|holiday|poorly|temperature|chicken ?pox|hand,? foot)\b/i],
  ['collection',     /\b(collect|pick(ing)? up|late (pick|collect)|drop ?off|different (person|adult))\b/i],
  ['place_enquiry',  /\b(place|availability|spaces?|waiting list|show ?round|viewing|visit|tour|register(ing)? (my|our)|start(ing)? in)\b/i],
  ['complaint',      /\b(complain|complaint|unhappy|disappointed|unacceptable|escalate)\b/i],
  ['training',       /\b(apprentice|off[- ]the[- ]job|otj|functional skills|awarding|assessor|e[- ]?portfolio|course|training|cpd|webinar)\b/i],
  ['invoice_supplier', /\b(purchase order|remittance|account is overdue|statement of account|delivery|order (number|no))\b/i],
];

function caseKind(email) {
  const hay = `${email.subject || ''}\n${email.body_text || email.snippet || ''}`;
  for (const [kind, re] of CASE_PATTERNS) if (re.test(hay)) return kind;
  return 'general';
}

// ── the facts ───────────────────────────────────────────────────────────────

/** The term that covers today, by funding_terms.is_current then by date. */
async function currentTerm(db) {
  try {
    const { rows } = await db.query(
      `SELECT id, name, start_date, end_date FROM funding_terms
        WHERE is_current = true ORDER BY start_date DESC LIMIT 1`);
    if (rows.length) return rows[0];
  } catch (_) {}
  try {
    const { rows } = await db.query(
      `SELECT id, name, start_date, end_date FROM funding_terms
        WHERE CURRENT_DATE BETWEEN start_date AND end_date
        ORDER BY start_date DESC LIMIT 1`);
    return rows[0] || null;
  } catch (_) { return null; }
}

/** Every child this address is a parent, contact or bill payer for. */
async function childrenForEmail(db, email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return [];
  const { rows } = await db.query(`
    SELECT DISTINCT c.id, c.first_name, c.last_name, c.room_id, r.name AS room_name,
           c.is_active, c.start_date, c.leave_date
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
     WHERE lower(c.parent_1_email) = $1
        OR lower(c.parent_2_email) = $1
        OR lower(c.primary_contact_email) = $1
        OR c.id IN (SELECT child_id FROM invoices WHERE lower(bill_payer_email) = $1 AND child_id IS NOT NULL)
     ORDER BY c.id`, [e]);
  return rows;
}

/**
 * The invoice facts. The thing the brief says to get right first: "Four parents
 * replied about October invoices on 2026-09-28."
 *
 * Deliberately the LAST FOUR invoices per child rather than "the current month":
 * a parent querying October may be querying it because of what happened in
 * September, and an answer that can only see one month is the answer that gets
 * the nursery into an argument. Amounts are read from the row, never recomputed —
 * a card must agree with the invoice the family is holding.
 */
async function invoiceFacts(db, childIds, billPayer) {
  if (!childIds.length) return { invoices: [], payments: [], outstanding_pence: 0 };
  const { rows: invoices } = await db.query(`
    SELECT i.id, i.child_id, i.invoice_number, i.reference, i.period_label,
           i.period_year, i.period_month, i.status, i.issued_on, i.due_on, i.paid_on,
           i.gross_amount_pence, i.funding_reduction_pence, i.funding_deduction_pence,
           i.discount_pence, i.holiday_reduction_pence, i.amount_pence,
           i.billing_basis, i.eylog_invoice_type, i.source,
           (SELECT COALESCE(SUM(p.amount_pence), 0) FROM payments p WHERE p.invoice_id = i.id) AS paid_pence,
           jsonb_array_length(COALESCE(i.line_items, '[]'::jsonb)) AS line_count
      FROM invoices i
     WHERE i.child_id = ANY($1::int[])
     ORDER BY i.child_id, COALESCE(i.issued_on, i.created_at::date) DESC, i.id DESC`, [childIds]);

  // Four per child, in one pass, so a family with three children does not come
  // back with forty rows the model then has to be trusted to read correctly.
  const perChild = new Map();
  const kept = [];
  for (const inv of invoices) {
    const n = perChild.get(inv.child_id) || 0;
    if (n >= 4) continue;
    perChild.set(inv.child_id, n + 1);
    kept.push({
      id: inv.id, child_id: inv.child_id,
      number: inv.invoice_number || inv.reference || `#${inv.id}`,
      period: inv.period_label || (inv.period_year && inv.period_month
        ? `${inv.period_year}-${String(inv.period_month).padStart(2, '0')}` : null),
      status: inv.status,
      issued_on: ymd(inv.issued_on), due_on: ymd(inv.due_on), paid_on: ymd(inv.paid_on),
      gross: money(inv.gross_amount_pence),
      funding_deducted: money(inv.funding_reduction_pence != null
        ? inv.funding_reduction_pence : inv.funding_deduction_pence),
      discount: money(inv.discount_pence),
      holiday_reduction: money(inv.holiday_reduction_pence),
      total: money(inv.amount_pence),
      paid: money(inv.paid_pence),
      outstanding: money(Math.max(0, Number(inv.amount_pence || 0) - Number(inv.paid_pence || 0))),
      basis: inv.billing_basis || inv.eylog_invoice_type || inv.source || null,
      line_count: P(inv.line_count),
    });
  }

  const outstanding = kept.reduce((s, i) => {
    if (i.status === 'paid' || i.paid_on) return s;
    const t = Number(String(i.total || '£0').replace(/[^0-9.-]/g, '')) * 100;
    const p = Number(String(i.paid || '£0').replace(/[^0-9.-]/g, '')) * 100;
    return s + Math.max(0, t - p);
  }, 0);

  let payments = [];
  if (billPayer) {
    const { rows } = await db.query(`
      SELECT id, invoice_id, child_id, amount_pence, payment_method, status,
             COALESCE(paid_on, created_at::date) AS on_date
        FROM payments
       WHERE lower(bill_payer_email) = $1 OR child_id = ANY($2::int[])
       ORDER BY COALESCE(paid_on, created_at::date) DESC, id DESC LIMIT 6`,
      [String(billPayer).toLowerCase(), childIds]);
    payments = rows.map(p => ({
      id: p.id, invoice_id: p.invoice_id, child_id: p.child_id,
      amount: money(p.amount_pence), method: p.payment_method, status: p.status, on: ymd(p.on_date),
    }));
  }
  return { invoices: kept, payments, outstanding_pence: Math.round(outstanding) };
}

/** The funding line, as the funding line states it — not as a calculation. */
async function fundingFacts(db, childIds, term) {
  if (!childIds.length || !term) return [];
  const { rows } = await db.query(`
    SELECT cf.child_id, cf.funding_type, cf.stretched_funding, cf.declaration_signed,
           cf.universal_hours_week, cf.extended_hours_week, cf.total_hours_week,
           cf.funded_hours_week, cf.termtime_hours_week, cf.attended_hours_week,
           cf.weeks_in_term, cf.stretch_weeks, cf.total_hours_term,
           cf.funded_pence, cf.parent_paid_pence
      FROM child_funding cf
     WHERE cf.child_id = ANY($1::int[]) AND cf.term_id = $2
     ORDER BY cf.child_id`, [childIds, term.id]);
  return rows.map(f => ({
    child_id: f.child_id,
    type: f.funding_type,
    stretched: f.stretched_funding === true,
    declaration_signed: f.declaration_signed === true,
    funded_hours_week: P(f.funded_hours_week != null ? f.funded_hours_week : f.total_hours_week),
    universal_hours_week: P(f.universal_hours_week),
    extended_hours_week: P(f.extended_hours_week),
    attended_hours_week: P(f.attended_hours_week),
    weeks_in_term: P(f.weeks_in_term != null ? f.weeks_in_term : f.stretch_weeks),
    total_hours_term: P(f.total_hours_term),
    funded_value: money(f.funded_pence),
  }));
}

/**
 * Everything the card is allowed to assert. SQL only.
 * @returns {Promise<object>} a plain object, safe to store as jsonb
 */
async function facts(db, email) {
  const kind = caseKind(email);
  const out = {
    case_kind: kind,
    from_domain: String(email.from_email || '').split('@').pop() || null,
    mailbox: email.mailbox || null,
    addressed_to: email.addressed_to || null,
    section: email.section || null,
    received_at: email.received_at,
    has_attachments: email.has_attachments === true,
    thread_message_count: 1,
    sender: { known: false },
    children: [], invoices: [], payments: [], funding: [],
    supplier: null, staff: null, enquiry: null,
    term: null, outstanding: null,
    history: null,
  };

  // How much of this conversation we have already seen. A thread with six
  // messages behind it is a different situation from a first contact, and it is
  // the one fact the model most often gets wrong without being told.
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE direction = 'out')::int AS ours,
              min(received_at) AS first_at
         FROM comms_email_queue WHERE thread_id = $1 AND thread_id IS NOT NULL`,
      [email.thread_id]);
    if (rows[0] && rows[0].n) {
      out.thread_message_count = rows[0].n;
      out.thread_replies_sent = rows[0].ours;
      out.thread_started_at = rows[0].first_at;
    }
  } catch (_) {}

  // Have we corresponded with this address before, and did we answer?
  try {
    const { rows } = await db.query(`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE status = 'sent')::int AS answered,
             max(received_at) AS last_at
        FROM comms_email_queue
       WHERE lower(from_email) = lower($1) AND direction = 'in'`, [email.from_email]);
    if (rows[0]) out.history = { emails_from_them: rows[0].total, we_replied: rows[0].answered, last_at: rows[0].last_at };
  } catch (_) {}

  const known = await sections.knownSender(db, email.from_email);
  if (known) out.sender = { known: true, kind: known.known_kind, ref: known.known_ref, note: known.reason };

  const term = await currentTerm(db);
  if (term) out.term = { id: term.id, name: term.name, start: ymd(term.start_date), end: ymd(term.end_date) };

  const isFamily = known && ['parent', 'bill_payer'].includes(known.known_kind);
  if (isFamily || out.section === 'parents') {
    const kids = await childrenForEmail(db, email.from_email);
    out.children = kids.map(c => ({
      id: c.id, first_name: c.first_name, room: c.room_name || null,
      on_roll: c.is_active === true, start_date: ymd(c.start_date), leave_date: ymd(c.leave_date),
    }));
    const ids = kids.map(c => c.id);
    if (ids.length && ['invoice_query', 'funding_query', 'general', 'complaint'].includes(kind)) {
      const inv = await invoiceFacts(db, ids, email.from_email);
      out.invoices = inv.invoices;
      out.payments = inv.payments;
      out.outstanding = money(inv.outstanding_pence);
      out.funding = await fundingFacts(db, ids, term);
    }
  }

  if (known && known.known_kind === 'supplier') {
    try {
      const { rows } = await db.query(
        `SELECT id, name, category, org_type, what_for, account_ref, status,
                last_contact_month, continuity_critical
           FROM suppliers WHERE id = $1`, [known.known_ref]);
      out.supplier = rows[0] || null;
    } catch (_) {}
  }

  if (known && known.known_kind === 'staff') {
    try {
      const { rows } = await db.query(
        `SELECT id, first_name, role, job_title FROM staff WHERE id = $1`, [known.known_ref]);
      out.staff = rows[0] || null;
    } catch (_) {
      try {
        const { rows } = await db.query(`SELECT id, first_name, role FROM staff WHERE id=$1`, [known.known_ref]);
        out.staff = rows[0] || null;
      } catch (_2) {}
    }
  }

  if (known && known.known_kind === 'enquirer') {
    try {
      const { rows } = await db.query(`
        SELECT id, child_first_name, child_dob, room_needed, preferred_room,
               preferred_start_date, start_date_requested, source, stage, status,
               ai_score, created_at, replied_at
          FROM enquiries WHERE id = $1`, [known.known_ref]);
      out.enquiry = rows[0] || null;
      if (out.enquiry) {
        out.enquiry.child_dob = ymd(out.enquiry.child_dob);
        out.enquiry.preferred_start_date = ymd(out.enquiry.preferred_start_date);
        out.enquiry.start_date_requested = ymd(out.enquiry.start_date_requested);
      }
    } catch (_) {}
  }

  return out;
}

// ── the model half ──────────────────────────────────────────────────────────

/**
 * Up to two of our own previously SENT replies, as examples of how Toby writes.
 * The brief: "a suggested reply (draft, in Toby's voice; learn from sent mail if
 * the store allows)". The store does allow it — comms_email_queue keeps the sent
 * body — so this is the "if".
 *
 * Same sender first, then the same section, and only from the SAME mailbox the
 * email arrived on, so a confidential mailbox's phrasing never leaks into a
 * shared-mailbox draft. Trimmed hard: this is a style sample, not a knowledge
 * source, and 300 characters is plenty to pick up a greeting and a sign-off.
 * Switch it off with settings inbox_voice_examples = false.
 */
async function voiceExamples(db, email) {
  try {
    const { rows: s } = await db.query(`SELECT value FROM settings WHERE key='inbox_voice_examples'`);
    if (s.length && String(s[0].value).toLowerCase() === 'false') return [];
  } catch (_) {}
  const take = rows => rows.map(r => String(r.body || '').replace(/\s+/g, ' ').trim().slice(0, 300)).filter(Boolean);
  try {
    const { rows } = await db.query(`
      SELECT COALESCE(draft_text, body_text, suggested_draft) AS body
        FROM comms_email_queue
       WHERE status = 'sent' AND mailbox IS NOT DISTINCT FROM $1
         AND (lower(from_email) = lower($2) OR lower(to_email) = lower($2))
         AND COALESCE(draft_text, body_text, suggested_draft) IS NOT NULL
       ORDER BY sent_at DESC NULLS LAST LIMIT 2`, [email.mailbox, email.from_email]);
    if (rows.length) return take(rows);
  } catch (_) {}
  try {
    const { rows } = await db.query(`
      SELECT COALESCE(draft_text, body_text, suggested_draft) AS body
        FROM comms_email_queue
       WHERE status = 'sent' AND mailbox IS NOT DISTINCT FROM $1 AND section IS NOT DISTINCT FROM $2
         AND COALESCE(draft_text, body_text, suggested_draft) IS NOT NULL
       ORDER BY sent_at DESC NULLS LAST LIMIT 2`, [email.mailbox, email.section]);
    return take(rows);
  } catch (_) { return []; }
}

/** The four options every card offers. Fixed, because the UI wires to them. */
function optionsFor(email, f) {
  const opts = [
    { key: 'reply',    label: 'Reply',                  hint: 'Open the draft, edit it, send it from ' + (email.mailbox || 'this mailbox') + '.' },
    { key: 'task',     label: 'Give it to someone',     hint: 'Creates an Action Plan task with a deadline; they get a notification.' },
    { key: 'handled',  label: 'Mark handled',           hint: 'No reply needed — it leaves the needs-reply list.' },
    { key: 'snooze',   label: 'Snooze',                 hint: 'Hide it until a date you choose.' },
  ];
  if (f.case_kind === 'invoice_query' && f.invoices && f.invoices.length) {
    opts[0].hint = `Draft already quotes invoice ${f.invoices[0].number}.`;
  }
  return opts;
}

function factsForPrompt(f) {
  const L = [];
  L.push(`What kind of email this looks like: ${f.case_kind}`);
  L.push(`Sender: ${f.sender.known ? `on file as ${f.sender.kind}` : 'not on file'} (domain ${f.from_domain || 'unknown'})`);
  if (f.addressed_to) L.push(`Addressed to: ${f.addressed_to}`);
  if (f.thread_message_count > 1) {
    L.push(`This is message ${f.thread_message_count} in the thread; we have sent ${f.thread_replies_sent || 0} of them.`);
  } else {
    L.push('This is the first message in its thread.');
  }
  if (f.history) L.push(`We have ${f.history.emails_from_them} email(s) from this address on record and replied to ${f.history.we_replied}.`);
  if (f.term) L.push(`Current funding term: ${f.term.name} (${f.term.start} to ${f.term.end}).`);
  for (const c of f.children || []) {
    L.push(`Child on the roll: ${c.first_name}, ${c.room || 'room not set'}${c.on_roll ? '' : ' (not currently active)'}.`);
  }
  for (const fn of f.funding || []) {
    L.push(`Funding line for child ${fn.child_id}: ${fn.type || 'type not set'}, `
      + `${fn.funded_hours_week != null ? fn.funded_hours_week + ' funded hours a week' : 'hours not stated'}`
      + `${fn.weeks_in_term ? ', over ' + fn.weeks_in_term + ' weeks this term' : ''}`
      + `${fn.stretched ? ', stretched' : ''}`
      + `${fn.declaration_signed ? ', declaration signed' : ', declaration NOT signed'}.`);
  }
  for (const i of f.invoices || []) {
    L.push(`Invoice ${i.number} (child ${i.child_id}${i.period ? ', ' + i.period : ''}): `
      + `gross ${i.gross || 'not stated'}, funding deducted ${i.funding_deducted || '£0.00'}, `
      + `total ${i.total || 'not stated'}, paid ${i.paid || '£0.00'}, outstanding ${i.outstanding || '£0.00'}, `
      + `status ${i.status || 'unknown'}${i.due_on ? ', due ' + i.due_on : ''}${i.paid_on ? ', paid on ' + i.paid_on : ''}.`);
  }
  for (const p of f.payments || []) {
    L.push(`Payment ${p.amount} on ${p.on} by ${p.method || 'unknown method'} (status ${p.status || 'unknown'})${p.invoice_id ? ', against invoice id ' + p.invoice_id : ', unallocated'}.`);
  }
  if (f.outstanding) L.push(`Total outstanding across the invoices listed: ${f.outstanding}.`);
  if (f.supplier) L.push(`Supplier on file: ${f.supplier.name}${f.supplier.category ? ' (' + f.supplier.category + ')' : ''}${f.supplier.account_ref ? ', account ' + f.supplier.account_ref : ''}${f.supplier.what_for ? ' — ' + f.supplier.what_for : ''}.`);
  if (f.staff) L.push(`Member of staff on file: ${f.staff.first_name}, ${f.staff.job_title || f.staff.role}.`);
  if (f.enquiry) {
    L.push(`Enquiry on file: ${f.enquiry.child_first_name || 'child'}, room wanted ${f.enquiry.room_needed || f.enquiry.preferred_room || 'not stated'}, `
      + `wants to start ${f.enquiry.preferred_start_date || f.enquiry.start_date_requested || 'date not stated'}, stage ${f.enquiry.stage || f.enquiry.status || 'new'}, `
      + `${f.enquiry.replied_at ? 'we have replied' : 'NOT yet replied to'}.`);
  }
  if (!f.invoices.length && f.case_kind === 'invoice_query') {
    L.push('NOTE: this looks like an invoice query but Wren found no invoice for this sender. Do not invent one — ask which invoice they mean.');
  }
  return L.join('\n');
}

function cardPrompt(email, f, examples, opts = {}) {
  const body = String(email.body_text || email.snippet || '').replace(/\s+/g, ' ').slice(0, 2500);
  const ex = examples.length
    ? `\nHOW THIS NURSERY WRITES (previous replies actually sent from this mailbox — copy the tone, not the content):\n`
      + examples.map((e, i) => `Example ${i + 1}: ${e}`).join('\n')
    : '';
  const intro = `You are Hermes, the inbox assistant for Nursery Manager, manager and owner of Your Nursery, a small nursery in Ealing, West London. An email has arrived. Toby will read what you write, edit it if he wants, and decide whether to send it. You never send anything.

THE EMAIL
From: ${email.from_name || ''} <${email.from_email || ''}>
Subject: ${email.subject || '(no subject)'}
Received: ${email.received_at || 'unknown'}
Body: ${body}

WHAT WREN KNOWS (these are facts read out of the nursery's own records — every number, date and name you use MUST come from here or from the email above; if a fact you want is not listed, say you do not have it rather than guessing):
${factsForPrompt(f)}
${ex}`;

  // b486 (2026-10-12): "summaries only" mode — Toby's drafting-optional setting.
  // Skips point 2 of the usual prompt entirely (no reply asked for, none generated)
  // so a mailbox running in this mode is not paying Ascent time for a draft nobody
  // will see — the point of the setting, not just a UI label on top of the same work.
  if (opts.summaryOnly) {
    return `${intro}

Write:
1. "context" — 2 to 4 short sentences: who this is, what they are asking, and the relevant facts from the list above, quoted exactly (invoice number, amount, funded hours, dates). This is what Toby reads before he reads the email.
2. "reasoning" — one or two sentences on what, if anything, needs a decision.
3. "confidence" — 0 to 1, how sure you are the context above is complete and correct.
4. "needs_human" — true if this should not be answered from a template: a complaint, a safeguarding worry, anything about a child's wellbeing, anything legal or contractual.

Reply with a single JSON object and nothing else:
{"context":"...","reasoning":"...","confidence":0.0,"needs_human":false}`;
  }

  return `${intro}

Write:
1. "context" — 2 to 4 short sentences: who this is, what they are asking, and the relevant facts from the list above, quoted exactly (invoice number, amount, funded hours, dates). This is what Toby reads before he reads the email.
2. "suggested_reply" — a complete reply he could send as-is. UK English. Warm but brief, the way a nursery manager writes to somebody he knows. No placeholders in square brackets, no "Dear Sir/Madam", no invented figures. If the facts do not answer their question, write a reply that asks the one thing needed. Sign off "Your Nursery".
3. "reasoning" — one or two sentences on WHY you suggested that reply, naming which fact drove it.
4. "confidence" — 0 to 1, how sure you are the reply is right to send without editing.
5. "needs_human" — true if this should not be answered from a template: a complaint, a safeguarding worry, anything about a child's wellbeing, anything legal or contractual.

Reply with a single JSON object and nothing else:
{"context":"...","suggested_reply":"...","reasoning":"...","confidence":0.0,"needs_human":false}`;
}

/**
 * Build (or rebuild) the card for one email and store it.
 *
 * On a model failure the row is still written, with `unavailable` set and no
 * draft. That is the brief's "Ascent unreachable → drafts say 'unavailable'",
 * and it matters that the row exists: the facts are the useful half and they
 * were gathered without the model.
 *
 * @param {object} db
 * @param {object} email  a comms_email_queue row
 * @param {object} [opts] { staffId, force }
 */
async function card(db, email, opts = {}) {
  const started = Date.now();
  const f = await facts(db, email);
  const options = optionsFor(email, f);
  let context = null, reply = null, reasoning = null, unavailable = null;
  let model = null, host = null;

  const summaryOnly = !!opts.summaryOnly;
  try {
    const probe = await sovereign.assertSovereign();
    model = probe.model; host = probe.host;
    const examples = await voiceExamples(db, email);
    const out = await sovereign.generateJSON({
      prompt: cardPrompt(email, f, examples, { summaryOnly }),
      temperature: 0.2,
      numPredict: summaryOnly ? 400 : 900,
      long: true,
      timeoutMs: opts.timeoutMs || await cardTimeoutMs(db),
    });
    if (out.ok) {
      const v = out.value || {};
      context   = String(v.context || '').trim().slice(0, 2000) || null;
      reply     = summaryOnly ? null : (String(v.suggested_reply || '').trim().slice(0, 6000) || null);
      reasoning = String(v.reasoning || '').trim().slice(0, 1000) || null;
      f.model_confidence = Number.isFinite(Number(v.confidence)) ? Number(v.confidence) : null;
      f.needs_human = v.needs_human === true;
      if (f.needs_human) {
        options.unshift({ key: 'read_first', label: 'Read this one yourself',
          hint: 'Hermes flagged it as not answerable from a draft.' });
      }
      if (!summaryOnly && !reply) unavailable = 'The local model answered but produced no draft.';
    } else {
      unavailable = `The local model could not produce a card (${out.error}).`;
    }
  } catch (e) {
    unavailable = /unreachable/.test(e.message)
      ? 'Drafting is unavailable — the Ascent (the nursery\'s own AI box) is not reachable. The facts below were read straight out of Wren and are unaffected.'
      : `Drafting is unavailable — ${e.message}`;
  }

  const { rows } = await db.query(`
    INSERT INTO inbox_intel_cards
      (email_id, facts, context, suggested_reply, reasoning, options, case_kind,
       child_id, supplier_id, staff_id, model, host, unavailable, duration_ms,
       generated_at, generated_for)
    VALUES ($1,$2::jsonb,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,now(),$15)
    ON CONFLICT (email_id) DO UPDATE SET
      facts = EXCLUDED.facts, context = EXCLUDED.context,
      suggested_reply = EXCLUDED.suggested_reply, reasoning = EXCLUDED.reasoning,
      options = EXCLUDED.options, case_kind = EXCLUDED.case_kind,
      child_id = EXCLUDED.child_id, supplier_id = EXCLUDED.supplier_id,
      staff_id = EXCLUDED.staff_id, model = EXCLUDED.model, host = EXCLUDED.host,
      unavailable = EXCLUDED.unavailable, duration_ms = EXCLUDED.duration_ms,
      generated_at = now(), generated_for = EXCLUDED.generated_for
    RETURNING *`,
    [email.id, JSON.stringify(f), context, reply, reasoning, JSON.stringify(options),
     f.case_kind,
     (f.children[0] && f.children[0].id) || null,
     (f.supplier && f.supplier.id) || null,
     (f.staff && f.staff.id) || null,
     model, host, unavailable, Date.now() - started, opts.staffId || null]);
  return rows[0];
}

/** The stored card, or null. */
async function getCard(db, emailId) {
  const { rows } = await db.query(`SELECT * FROM inbox_intel_cards WHERE email_id = $1`, [emailId]);
  return rows[0] || null;
}

// ── b486 (2026-10-12): drafting optional, and failed drafts get retried ───────
// Toby: "add a button to resync and draft, or maybe drafts can be optional." Three
// small pieces, all on top of card() above — nothing here changes what card() asks
// the model, except the summaryOnly branch already threaded into cardPrompt/card.

/**
 * How long to wait for one card() model call, in ms. Settings `inbox_card_timeout_s`
 * (30–900) wins when set; else the old env var B364_CARD_TIMEOUT_MS; else 300s
 * (was a 180s hard default — raised because the 8–12 Oct timeouts this build
 * exists to fix were mostly the Ascent needing longer than 180s under load, not a
 * dead model).
 */
async function cardTimeoutMs(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='inbox_card_timeout_s'`);
    const n = parseInt(rows[0]?.value, 10);
    if (Number.isFinite(n) && n >= 30 && n <= 900) return n * 1000;
  } catch (_) {}
  const envMs = parseInt(process.env.B364_CARD_TIMEOUT_MS, 10);
  if (Number.isFinite(envMs) && envMs > 0) return envMs;
  return 300000;
}

/**
 * The 3-way drafting setting, as settings.inbox_hermes_autocards (b364, existing)
 * + settings.inbox_hermes_summary_only (new) combine: 'off' | 'summary_only' | 'full'.
 * Default is 'full' — unchanged from before this build unless Toby changes it.
 */
async function draftMode(db) {
  let autocards = true, summaryOnly = false;
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('inbox_hermes_autocards','inbox_hermes_summary_only')`);
    for (const r of rows) {
      if (r.key === 'inbox_hermes_autocards') autocards = String(r.value).toLowerCase() !== 'false';
      if (r.key === 'inbox_hermes_summary_only') summaryOnly = String(r.value).toLowerCase() === 'true';
    }
  } catch (_) {}
  return autocards ? (summaryOnly ? 'summary_only' : 'full') : 'off';
}

/** +10 min, +1 h, +6 h, then give up (null = stop retrying automatically). */
function backoffMinutesFor(attempts) {
  const BACKOFF_MIN = [10, 60, 360];
  return BACKOFF_MIN[attempts - 1] || null;
}

/**
 * Run (or re-run) the card for one email and, exactly like the oneoff
 * scripts/oneoff/inbox-redraft.js catch-up script this reuses the rule from, fill
 * comms_email_queue.summary/suggested_draft ONLY where they are empty and nobody
 * has written a draft (draft_text) — a person's own words are never overwritten.
 * On failure, bumps draft_attempts and schedules draft_next_retry_at per
 * backoffMinutesFor() so the poller's retry sweep (see retryFailedDrafts) picks it
 * up automatically. Used by: the b364 poller step, the "Draft replies" button job,
 * the automatic retry sweep, and the per-email manual Retry button.
 *
 * @param {object} db
 * @param {object} row  a comms_email_queue row (SELECT * — needs suggested_draft/draft_text/summary)
 * @param {object} [opts] { staffId, summaryOnly }
 */
async function attemptDraft(db, row, opts = {}) {
  const summaryOnly = !!opts.summaryOnly;
  const prevHadDraft = !!String(row.suggested_draft || '').trim() || !!String(row.draft_text || '').trim();

  // b486b (2026-10-12, D1): claim the row before calling the model. The poll's
  // own first-draft step (b364Step) and the automatic retry sweep both end up
  // here unattended — without a claim, an email the sweep is still mid-attempt
  // on (up to 2×cardTimeoutMs, because card() retries once, can easily outlast
  // the 8-minute poll interval that starts the next one) could get drafted
  // twice. 15-minute staleness window so a crashed/SIGKILLed attempt can't wedge
  // the row forever (well above any realistic card()/generateJSON timeout).
  //
  // opts.force (the "Draft replies" job and the per-email Retry button — both a
  // human explicitly asking for this email right now) skips the check instead of
  // waiting out someone else's claim. Both are documented elsewhere to pick up
  // immediately after a crash (inbox-draft-job.js's file header: "pressing the
  // button again just picks up where it left off") — a claim in this window is
  // never from a still-alive concurrent call of THEIRS (the job and the route are
  // both one-at-a-time), only ever from either (a) a dead process's abandoned
  // attempt, which is exactly what a manual retry exists to recover from, or (b)
  // the automatic sweep/poll genuinely mid-attempt on the same row right now — a
  // rare coincidence whose cost is one duplicate model call, far cheaper than
  // blocking a human's explicit retry for up to 15 minutes.
  if (!opts.force) {
    const claim = await db.query(
      `UPDATE comms_email_queue SET draft_claimed_at = now()
        WHERE id=$1 AND (draft_claimed_at IS NULL OR draft_claimed_at < now() - interval '15 minutes')
      RETURNING id`, [row.id]);
    if (!claim.rows.length) {
      return { ok: false, skipped: 'in_progress', reason: 'Another draft attempt is already running for this email' };
    }
  } else {
    await db.query(`UPDATE comms_email_queue SET draft_claimed_at = now() WHERE id=$1`, [row.id]);
  }

  let c = null;
  try { c = await card(db, row, { staffId: opts.staffId || null, summaryOnly }); }
  catch (e) { c = { unavailable: e.message }; }

  const ok = !!(c && !c.unavailable && (summaryOnly ? c.context : c.suggested_reply));

  if (ok) {
    let summaryFilled = false, draftFilled = false;
    if (c.context) {
      const r = await db.query(
        `UPDATE comms_email_queue SET summary=$1 WHERE id=$2 AND coalesce(summary,'')=''`,
        [c.context, row.id]);
      summaryFilled = r.rowCount > 0;
    }
    if (!summaryOnly && c.suggested_reply) {
      const r2 = await db.query(
        `UPDATE comms_email_queue SET suggested_draft=$1
           WHERE id=$2 AND coalesce(suggested_draft,'')='' AND coalesce(draft_text,'')=''`,
        [c.suggested_reply, row.id]);
      draftFilled = r2.rowCount > 0;
    }
    await db.query(
      `UPDATE comms_email_queue
          SET draft_status='ok', draft_attempts=0, draft_next_retry_at=NULL,
              draft_last_attempt_at=now(), draft_claimed_at=NULL
        WHERE id=$1`, [row.id]);
    return { ok: true, summaryFilled, draftFilled, draftKeptExisting: prevHadDraft && !draftFilled, card: c };
  }

  const { rows } = await db.query(
    `UPDATE comms_email_queue
        SET draft_attempts = COALESCE(draft_attempts,0) + 1,
            draft_last_attempt_at = now(), draft_status = 'failed', draft_claimed_at = NULL
      WHERE id=$1 RETURNING draft_attempts`, [row.id]);
  const attempts = rows[0] ? rows[0].draft_attempts : 1;
  const delayMin = backoffMinutesFor(attempts);
  await db.query(`UPDATE comms_email_queue SET draft_next_retry_at = $2 WHERE id=$1`,
    [row.id, delayMin ? new Date(Date.now() + delayMin * 60000) : null]);
  return { ok: false, attempts, gaveUp: !delayMin, reason: (c && c.unavailable) || 'card generation failed', card: c };
}

/**
 * Sweeps comms_email_queue for drafts whose retry time has come, and retries them.
 * Called from the existing 8-minute poll cycle (gmail-inbox-poller.js pollInbox) —
 * no second interval. 'off' mode skips the sweep entirely; 'summary_only' retries
 * with the lighter prompt, matching what a NEW email would get right now.
 */
async function retryFailedDrafts(db, opts = {}) {
  const limit = Math.min(50, Math.max(1, opts.limit || 10));
  const mode = await draftMode(db);
  if (mode === 'off') return { checked: 0, succeeded: 0, failed_again: 0, gave_up: 0, skipped: 0, mode };
  const { rows } = await db.query(`
    SELECT * FROM comms_email_queue
     WHERE draft_status='failed' AND draft_next_retry_at IS NOT NULL AND draft_next_retry_at <= now()
       AND direction='in' AND coalesce(status,'') NOT IN ('sent','ignored')
     ORDER BY draft_next_retry_at ASC LIMIT $1`, [limit]);
  const out = { checked: rows.length, succeeded: 0, failed_again: 0, gave_up: 0, skipped: 0, mode };
  for (const row of rows) {
    try {
      const r = await attemptDraft(db, row, { summaryOnly: mode === 'summary_only' });
      // b486b (2026-10-12, D1): r.skipped means another in-flight attempt already
      // claimed this row (see attemptDraft) — nothing was attempted here, so it is
      // neither a success nor a failure. Counted separately so the sweep's own log
      // line doesn't misreport a healthy skip as a failed draft attempt.
      if (r.ok) out.succeeded++;
      else if (r.skipped) out.skipped++;
      else if (r.gaveUp) out.gave_up++;
      else out.failed_again++;
    } catch (_) { out.failed_again++; }
  }
  return out;
}

// ── summaries ───────────────────────────────────────────────────────────────

async function summarise(db, { scope, ref, from, to, emails, staffId }) {
  const started = Date.now();
  const key = [scope, String(ref), from ? new Date(from).toISOString() : null, to ? new Date(to).toISOString() : null];
  try {
    const { rows } = await db.query(
      `SELECT * FROM inbox_summaries
        WHERE scope=$1 AND scope_ref=$2 AND window_from IS NOT DISTINCT FROM $3
          AND window_to IS NOT DISTINCT FROM $4
          AND generated_at > now() - interval '6 hours' AND unavailable IS NULL
        ORDER BY generated_at DESC LIMIT 1`, key);
    if (rows.length) return Object.assign(rows[0], { cached: true });
  } catch (_) {}

  if (!emails.length) {
    return { scope, scope_ref: String(ref), email_count: 0, summary: null,
             unavailable: 'Nothing to summarise in that window.', cached: false };
  }

  const lines = emails.map((e, i) =>
    `${i + 1}. ${e.received_at ? String(e.received_at).slice(0, 16) : '?'} — from ${e.from_name || e.from_email || 'unknown'}`
    + `${e.section ? ` [${e.section}]` : ''}: ${String(e.subject || '(no subject)').slice(0, 140)}`
    + `\n   ${String(e.summary || e.snippet || e.body_text || '').replace(/\s+/g, ' ').slice(0, 300)}`).join('\n');

  const prompt = scope === 'thread'
    ? `Summarise this email conversation for the manager of Your Nursery. Say what was asked, what was answered, and what is still outstanding. Be specific about anything that needs a decision or a date. Do not invent anything that is not below.

${lines}

Reply with a single JSON object: {"summary":"...","outstanding":"the one thing still to do, or null"}`
    : `Summarise this week's email in one section of the manager's inbox at Your Nursery. Group what repeats, name what needs a reply, and say what can be ignored. Do not invent anything that is not below.

Section: ${ref}
${lines}

Reply with a single JSON object: {"summary":"...","outstanding":"the one thing still to do, or null"}`;

  let summary = null, unavailable = null, model = null, host = null;
  try {
    const probe = await sovereign.assertSovereign();
    model = probe.model; host = probe.host;
    const out = await sovereign.generateJSON({
      prompt, temperature: 0.2, numPredict: 700, long: true,
      timeoutMs: parseInt(process.env.B364_SUMMARY_TIMEOUT_MS || '180000', 10),
    });
    if (out.ok) {
      summary = String(out.value.summary || '').trim().slice(0, 4000) || null;
      if (out.value.outstanding && String(out.value.outstanding).toLowerCase() !== 'null') {
        summary = `${summary}\n\nStill outstanding: ${String(out.value.outstanding).slice(0, 500)}`;
      }
      if (!summary) unavailable = 'The local model produced no summary.';
    } else unavailable = `The local model could not summarise this (${out.error}).`;
  } catch (e) {
    unavailable = /unreachable/.test(e.message)
      ? 'Summaries are unavailable — the Ascent is not reachable. Email content is never sent to a cloud model, so there is nothing to fall back to.'
      : `Summaries are unavailable — ${e.message}`;
  }

  try {
    const { rows } = await db.query(`
      INSERT INTO inbox_summaries
        (scope, scope_ref, window_from, window_to, email_count, summary, unavailable,
         model, host, duration_ms, generated_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (scope, scope_ref, window_from, window_to) DO UPDATE SET
        email_count = EXCLUDED.email_count, summary = EXCLUDED.summary,
        unavailable = EXCLUDED.unavailable, model = EXCLUDED.model, host = EXCLUDED.host,
        duration_ms = EXCLUDED.duration_ms, generated_at = now(),
        generated_by = EXCLUDED.generated_by
      RETURNING *`,
      [scope, String(ref), from || null, to || null, emails.length, summary, unavailable,
       model, host, Date.now() - started, staffId || null]);
    return Object.assign(rows[0], { cached: false });
  } catch (_) {
    return { scope, scope_ref: String(ref), email_count: emails.length, summary, unavailable, cached: false };
  }
}

// ── "what have I missed" ────────────────────────────────────────────────────

/** The window this person's panel covers, and the stamps behind it. */
async function seenWindow(db, staffId) {
  let maxDays = 14;
  try {
    const { rows } = await db.query(`SELECT value FROM settings WHERE key='inbox_missed_max_days'`);
    const n = parseInt(rows[0]?.value, 10);
    if (Number.isFinite(n) && n > 0) maxDays = Math.min(90, n);
  } catch (_) {}
  const floor = new Date(Date.now() - maxDays * 86400000);

  let row = null;
  try {
    const { rows } = await db.query(`SELECT * FROM inbox_last_seen WHERE staff_id = $1`, [staffId]);
    row = rows[0] || null;
  } catch (_) {}

  // The window runs from previous_seen_at when there is one, so opening the
  // Cockpit twice in a minute does not blank the panel the second time.
  const raw = row ? (row.previous_seen_at || row.last_seen_at) : null;
  const since = raw && new Date(raw) > floor ? new Date(raw) : floor;
  return {
    since,
    first_ever: !row,
    clamped: !!(raw && new Date(raw) <= floor),
    max_days: maxDays,
    last_seen_at: row ? row.last_seen_at : null,
  };
}

/**
 * Everything that changed since this person last looked.
 *
 * @param {object} db
 * @param {number} staffId
 * @param {string[]} mailboxes  the mailboxes this person may read — the email
 *   half is filtered by it, exactly as every other b364 read is.
 * @param {Date} [sinceOverride] for the test harness: an injectable "last login",
 *   which is what makes "shows exactly what changed since a set time" checkable
 *   without editing anybody's stamp.
 */
async function missed(db, staffId, mailboxes, sinceOverride) {
  const win = await seenWindow(db, staffId);
  const since = sinceOverride ? new Date(sinceOverride) : win.since;

  const out = {
    since: since.toISOString(),
    first_ever: win.first_ever,
    clamped_to_days: win.clamped ? win.max_days : null,
    injected: !!sinceOverride,
    emails: { total: 0, by_section: [], items: [] },
    tasks: { created: [], completed: [] },
    invoices_paid: [],
    signals: [],
  };

  if (mailboxes && mailboxes.length) {
    try {
      const { rows } = await db.query(`
        SELECT COALESCE(section, 'other') AS section, count(*)::int AS n,
               count(*) FILTER (WHERE action_state = 'needs_reply')::int AS needs_reply
          FROM comms_email_queue
         WHERE direction = 'in' AND mailbox = ANY($1) AND received_at >= $2
         GROUP BY 1 ORDER BY 2 DESC`, [mailboxes, since]);
      out.emails.by_section = rows;
      out.emails.total = rows.reduce((s, r) => s + r.n, 0);
    } catch (_) {}
    try {
      const { rows } = await db.query(`
        SELECT eq.id, eq.section, eq.section_source, eq.mailbox, eq.addressed_to,
               eq.from_name, eq.from_email, eq.subject, eq.received_at, eq.action_state,
               eq.importance, eq.has_attachments,
               COALESCE(NULLIF(c.context, ''), NULLIF(eq.summary, ''), left(eq.snippet, 220)) AS gist,
               (c.email_id IS NOT NULL) AS has_card,
               (c.suggested_reply IS NOT NULL) AS has_draft
          FROM comms_email_queue eq
          LEFT JOIN inbox_intel_cards c ON c.email_id = eq.id
         WHERE eq.direction = 'in' AND eq.mailbox = ANY($1) AND eq.received_at >= $2
         ORDER BY eq.received_at DESC LIMIT 40`, [mailboxes, since]);
      out.emails.items = rows.map(r => Object.assign(r, {
        gist: r.gist ? String(r.gist).replace(/\s+/g, ' ').slice(0, 220) : null,
      }));
    } catch (_) {}
  }

  try {
    const { rows } = await db.query(`
      SELECT t.id, t.title, t.status, t.due_date, t.created_at, t.priority,
             t.linked_to, t.linked_id, t.description,
             s.first_name AS created_by_name
        FROM tasks t LEFT JOIN staff s ON s.id = t.created_by
       WHERE t.created_at >= $1 ORDER BY t.created_at DESC LIMIT 20`, [since]);
    out.tasks.created = rows;
  } catch (_) {}
  try {
    const { rows } = await db.query(`
      SELECT t.id, t.title, t.completed_at, t.completion_note,
             s.first_name AS owner_name
        FROM tasks t LEFT JOIN staff s ON s.id = t.owner_staff_id
       WHERE t.completed_at >= $1 ORDER BY t.completed_at DESC LIMIT 20`, [since]);
    out.tasks.completed = rows;
  } catch (_) {}

  try {
    const { rows } = await db.query(`
      SELECT i.id, i.invoice_number, i.reference, i.child_id, i.period_label,
             i.amount_pence, i.paid_on
        FROM invoices i
       WHERE i.paid_on IS NOT NULL AND i.paid_on >= $1::date
       ORDER BY i.paid_on DESC, i.id DESC LIMIT 25`, [since]);
    out.invoices_paid = rows.map(r => ({
      id: r.id, number: r.invoice_number || r.reference || `#${r.id}`,
      child_id: r.child_id, period: r.period_label, amount: money(r.amount_pence), paid_on: ymd(r.paid_on),
    }));
  } catch (_) {}

  try {
    const { rows } = await db.query(`
      SELECT id, signal_key, fired_at, COALESCE(NULLIF(sent_text,''), headline) AS said, link, cleared_at
        FROM signal_events WHERE fired_at >= $1 ORDER BY fired_at DESC LIMIT 20`, [since]);
    out.signals = rows;
  } catch (_) {}

  out.nothing_missed = out.emails.total === 0 && !out.tasks.created.length
    && !out.tasks.completed.length && !out.invoices_paid.length && !out.signals.length;
  return out;
}

/** Stamp this person as having read the panel. Keeps the stamp it moved from. */
async function markSeen(db, staffId) {
  const { rows } = await db.query(`
    INSERT INTO inbox_last_seen (staff_id, last_seen_at, previous_seen_at, seen_count, updated_at)
    VALUES ($1, now(), NULL, 1, now())
    ON CONFLICT (staff_id) DO UPDATE SET
      previous_seen_at = inbox_last_seen.last_seen_at,
      last_seen_at = now(),
      seen_count = inbox_last_seen.seen_count + 1,
      updated_at = now()
    RETURNING staff_id, last_seen_at, previous_seen_at, seen_count`, [staffId]);
  return rows[0];
}

module.exports = {
  caseKind, currentTerm, childrenForEmail, invoiceFacts, fundingFacts,
  facts, factsForPrompt, cardPrompt, voiceExamples, optionsFor,
  card, getCard, summarise, seenWindow, missed, markSeen, money, ymd,
  // b486 — drafting optional + failed-draft retry
  cardTimeoutMs, draftMode, backoffMinutesFor, attemptDraft, retryFailedDrafts,
};
