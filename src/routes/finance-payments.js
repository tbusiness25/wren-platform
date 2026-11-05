'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b397 (2026-10-05, DEV ONLY — wren_dev / wren-ladn-dev:3015).
//
// Toby, reconciling: "there is no easy way to add payments." This is that path —
// the manual, office-keyed side of recording money in, for the new Roost page
// Invoices & Payments (editions/admin/public/money.html / public/js/wren-money.js).
//
// Mounted at /api/finance/payments, alongside the existing /api/finance/invoices.
// This file does NOT replace payments-admin.js (gateway settings, bank-line
// assign) or payment-matching.js (the b325 certainty-first bank-statement
// matcher) — those stay the automatic/bank-fed path. This is what the office
// types in by hand: cash in an envelope, a BACS line they can already see
// cleared, a cheque. The allocation RULE is not reinvented here — oldest-first
// is src/services/payment-matcher.js planAllocation(), the exact function the
// bank matcher itself calls. A chosen-invoice payment and an on-account credit
// are the two cases planAllocation was never asked to do (it always scans the
// whole family), so those get a small, explicit local helper each. Nothing here
// changes how a balance is computed — src/lib/family-ledger.js still owns that,
// untouched.
// ─────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const PM = require('../services/payment-matcher');   // FAMILY_KEY_SQL, planAllocation, ymd
const AP = require('../lib/allocation-period');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const managerGuard = (req, res, next) => {
  // b480: 'accountant' added — safe only because the accountant-scope gate in
  // server-unified.js has already restricted that role to GET requests on a
  // short allowlist (this router's paths included) before this ever runs.
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'accountant'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

const pence = (v) => Math.round(Number(v) || 0);
const FAMILY_KEY_SQL = PM.FAMILY_KEY_SQL('c');

/**
 * Allocate to exactly ONE named invoice (up to its outstanding balance); anything
 * left over becomes family credit — the same remainder rule planAllocation uses.
 * A separate function rather than teaching planAllocation a "just this one
 * invoice" mode: that function's job is "oldest first across the family", and
 * "pay THIS bill" is a different, explicit choice the office is making.
 */
async function planAllocationToInvoice(db, { invoiceId, amountPence }) {
  const { rows: [inv] } = await db.query(`
    SELECT i.id, i.invoice_number, i.child_id, i.issued_on, i.due_on, i.amount_pence,
           i.amount_pence - COALESCE((SELECT SUM(p.amount_pence) FROM payments p
             WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0) AS outstanding_pence,
           c.first_name || ' ' || c.last_name AS child_name
      FROM invoices i JOIN children c ON c.id = i.child_id
     WHERE i.id = $1`, [invoiceId]);
  if (!inv) { const e = new Error('Invoice not found'); e.code = 'not_found'; throw e; }
  const outstanding = pence(inv.outstanding_pence);
  const take = Math.max(0, Math.min(pence(amountPence), outstanding));
  const allocation = take > 0 ? [{
    invoice_id: inv.id, invoice_number: inv.invoice_number, child_id: inv.child_id,
    child_name: inv.child_name, issued_on: PM.ymd(inv.issued_on), due_on: PM.ymd(inv.due_on),
    invoice_total_pence: pence(inv.amount_pence), outstanding_pence: outstanding,
    allocate_pence: take, settles: take === outstanding,
  }] : [];
  return {
    allocation, allocated_pence: take, credit_pence: pence(amountPence) - take,
    open_invoice_count: outstanding > 0 ? 1 : 0,
  };
}

const opSql = { eq: '=', gt: '>', lt: '<' };

// ── GET /api/finance/payments — EyMan's Payments tab list ─────────────────────
// Filters: year, month, q (child / payment no. / reference), payment_mode, status,
// locked (true|false — a payment not sourced here is immutable), amount_op/amount_val,
// balance_op/balance_val (the unallocated remainder), date_from/date_to.
router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const {
      year, month, q, payment_mode, status, locked, child_id, child_ids,
      amount_op, amount_val, balance_op, balance_val,
      date_from, date_to, limit = 50, offset = 0,
    } = req.query;

    const qp = [];
    const where = ['1=1'];
    // child_ids (comma-separated) is how the Families tab asks for a whole family's
    // payments — a family can be several siblings' child_ids at once.
    const idList = (child_ids ? String(child_ids).split(',') : child_id ? [child_id] : [])
      .map(v => parseInt(v, 10)).filter(Number.isInteger);
    if (idList.length) { qp.push(idList); where.push(`p.child_id = ANY($${qp.length}::int[])`); }
    if (year)  { qp.push(parseInt(year, 10));  where.push(`EXTRACT(year FROM COALESCE(p.paid_on, p.created_at::date)) = $${qp.length}`); }
    if (month) { qp.push(parseInt(month, 10)); where.push(`EXTRACT(month FROM COALESCE(p.paid_on, p.created_at::date)) = $${qp.length}`); }
    if (date_from) { qp.push(date_from); where.push(`COALESCE(p.paid_on, p.created_at::date) >= $${qp.length}`); }
    if (date_to)   { qp.push(date_to);   where.push(`COALESCE(p.paid_on, p.created_at::date) <= $${qp.length}`); }
    if (payment_mode) { qp.push(payment_mode); where.push(`p.payment_method = $${qp.length}`); }
    if (status)        { qp.push(status); where.push(`p.status = $${qp.length}`); }
    if (q) {
      qp.push(`%${q}%`);
      where.push(`(c.first_name || ' ' || c.last_name ILIKE $${qp.length}
                   OR p.cash_reference ILIKE $${qp.length}
                   OR COALESCE(p.eylog_payment_no, 'W'||p.id::text) ILIKE $${qp.length})`);
    }
    if (amount_op && opSql[amount_op] && amount_val !== undefined) {
      qp.push(Math.round(parseFloat(amount_val) * 100));
      where.push(`p.amount_pence ${opSql[amount_op]} $${qp.length}`);
    }

    qp.push(parseInt(limit, 10) || 50, parseInt(offset, 10) || 0);
    const { rows } = await db.query(`
      SELECT p.id, p.child_id, p.amount_pence, p.payment_method, p.status, p.source,
             p.paid_on, p.created_at, p.cash_reference, p.manual_notes, p.invoice_id,
             COALESCE(p.eylog_payment_no, 'W'||p.id::text) AS payment_no,
             c.first_name || ' ' || c.last_name AS child_name,
             (p.source IS DISTINCT FROM 'manual') AS locked,
             COALESCE((SELECT SUM(a.amount_pence) FROM payment_allocations a
                        WHERE a.payment_id = p.id), 0) AS allocated_pence
        FROM payments p LEFT JOIN children c ON c.id = p.child_id
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(p.paid_on, p.created_at::date) DESC, p.id DESC
       LIMIT $${qp.length - 1} OFFSET $${qp.length}`, qp);

    let out = rows.map(r => ({ ...r, balance_pence: pence(r.amount_pence) - pence(r.allocated_pence) }));
    if (balance_op && opSql[balance_op] && balance_val !== undefined) {
      const bv = Math.round(parseFloat(balance_val) * 100);
      out = out.filter(r => balance_op === 'eq' ? r.balance_pence === bv
                           : balance_op === 'gt' ? r.balance_pence > bv : r.balance_pence < bv);
    }
    if (locked === 'true')  out = out.filter(r => r.locked);
    if (locked === 'false') out = out.filter(r => !r.locked);

    res.json({ payments: out, count: out.length });
  } catch (e) {
    console.error('[finance-payments] list:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/payments/:id — one payment + its allocation table ────────
// ── 2026-10-09 (Toby's accountant brother: "one point of entry… click and see who has
// outstanding — there's too much data there"; and EyMan's Income Forecast, but better) ──────

// GET /api/finance/payments/outstanding — every family that owes, one line each, from the
// family statement ledger (the same balance parents see), plus the families in credit.
router.get('/outstanding', async (req, res) => {
  const db = getPool();
  try {
    const { familyLedger } = require('../lib/family-ledger');
    const { outstandingSql } = require('../lib/invoice-outstanding');
    const { rows: kids } = await db.query(`
      SELECT c.id, COALESCE(NULLIF(c.preferred_name,''), c.first_name) AS first_name, c.last_name, c.is_active,
             ${FAMILY_KEY_SQL} AS family_key
        FROM children c
       -- b484 port (2026-10-12): a demo child (children.is_demo) is never on Who owes or in its totals.
       WHERE COALESCE(c.is_demo, false) = false
         AND (c.is_active
          OR EXISTS (SELECT 1 FROM invoices i WHERE i.child_id = c.id AND i.status IN ('sent','overdue'))
          OR EXISTS (SELECT 1 FROM opening_balances o WHERE o.child_id = c.id))`);
    const fams = new Map();
    for (const k of kids) {
      const key = k.family_key || ('child:' + k.id);
      if (!fams.has(key)) fams.set(key, []);
      fams.get(key).push(k);
    }
    const owing = [], inCredit = [];
    for (const members of fams.values()) {
      const ids = members.map(m => m.id);
      const led = await familyLedger(db, ids);
      const bal = Number(led.balance_pence) || 0;
      if (!bal) continue;
      const label = members.map(m => `${m.first_name || ''} ${m.last_name || ''}`.trim()).join(' & ');
      const fam = { child_ids: ids, label, active: members.some(m => m.is_active), balance_pence: bal };
      if (bal > 0) {
        const { rows: bills } = await db.query(`
          SELECT i.id, i.invoice_number, i.period_label, i.due_on, i.status, ${outstandingSql('i')} AS left_pence
            FROM invoices i
           WHERE i.child_id = ANY($1::int[]) AND i.status IN ('sent','overdue')
           ORDER BY i.due_on NULLS LAST, i.id`, [ids]);
        fam.bills = bills.filter(b => Number(b.left_pence) > 0)
          .map(b => ({ id: b.id, number: b.invoice_number, period: b.period_label, due_on: b.due_on, left_pence: Number(b.left_pence) }));
        const oldest = fam.bills.find(b => b.due_on);
        fam.oldest_due = oldest ? oldest.due_on : null;
        fam.days_overdue = oldest ? Math.max(0, Math.floor((Date.now() - new Date(oldest.due_on).getTime()) / 864e5)) : 0;
      }
      const { rows: [lp] } = await db.query(`
        SELECT paid_on, amount_pence, payment_method FROM payments
         WHERE child_id = ANY($1::int[]) AND status = 'succeeded'
           AND COALESCE(source,'') NOT IN ('eylog-import-b205','opening-balance','credit-note-excess')
           AND eylog_payment_no IS NULL
         ORDER BY paid_on DESC NULLS LAST, id DESC LIMIT 1`, [ids]);
      fam.last_payment = lp ? { on: lp.paid_on, pence: Number(lp.amount_pence), method: lp.payment_method } : null;
      (bal > 0 ? owing : inCredit).push(fam);
    }
    owing.sort((a, b) => b.balance_pence - a.balance_pence);
    inCredit.sort((a, b) => a.balance_pence - b.balance_pence);
    res.json({
      owing, in_credit: inCredit,
      totals: { owing_pence: owing.reduce((t, f) => t + f.balance_pence, 0), families_owing: owing.length,
                in_credit_pence: -inCredit.reduce((t, f) => t + f.balance_pence, 0), families_in_credit: inCredit.length },
    });
  } catch (e) { console.error('[finance-payments] outstanding:', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/finance/payments/income-forecast?from=YYYY-MM&to=YYYY-MM&by=children|rooms|products|categories
// Each month is the preview of the SAME generator that raised October's invoices
// (POST /api/finance/invoices/generate, preview:true — £41,509 vs £41,586 actually issued),
// so the forecast is what Wren would bill, split into what parents pay and what the council
// funds. Not the itemised Fee Schedule generator, which does not deduct funding.
const _fcCache = new Map();   // month → { at, invoices }
function _previewMonth(req, year, month) {
  const key = `${year}-${month}`;
  const hit = _fcCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return Promise.resolve(hit.invoices);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ year, month, preview: true });
    const r = require('http').request({
      host: '127.0.0.1', port: process.env.PORT || 3000, method: 'POST', path: '/api/finance/invoices/generate',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
                 authorization: req.headers.authorization || '', host: req.headers.host || '',
                 'x-wren-device': req.headers['x-wren-device'] || '', 'x-forwarded-for': '127.0.0.1' },
    }, (resp) => {
      let data = ''; resp.on('data', d => { data += d; });
      resp.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (resp.statusCode !== 200) return reject(new Error(j.error || ('generate preview HTTP ' + resp.statusCode)));
          const invoices = j.invoices || [];
          _fcCache.set(key, { at: Date.now(), invoices });
          resolve(invoices);
        } catch (e) { reject(e); }
      });
    });
    r.on('error', reject); r.write(body); r.end();
  });
}
const _MONTHS_RE = /\s*\((January|February|March|April|May|June|July|August|September|October|November|December) \d{4}\)/g;
router.get('/income-forecast', async (req, res) => {
  const parse = (v, d) => { const m = /^(\d{4})-(\d{1,2})$/.exec(String(v || '')); return m ? [+m[1], +m[2]] : d; };
  const now = new Date();
  let [fy, fm] = parse(req.query.from, [now.getFullYear(), now.getMonth() + 1]);
  const [ty, tm] = parse(req.query.to, [fy + (fm + 5 > 12 ? 1 : 0), ((fm + 5 - 1) % 12) + 1]);
  const by = ['children', 'rooms', 'products', 'categories'].includes(req.query.by) ? req.query.by : 'children';
  const months = [];
  for (let y = fy, m = fm; (y < ty || (y === ty && m <= tm)) && months.length < 12; m === 12 ? (y++, m = 1) : m++) months.push([y, m]);
  if (!months.length) return res.status(400).json({ error: 'from must be on or before to' });
  try {
    const rows = new Map();   // key → { label, sub, months: { 'YYYY-MM': { income, funding } } }
    const add = (key, label, sub, mk, income, funding) => {
      if (!rows.has(key)) rows.set(key, { key, label, sub, months: {} });
      const r = rows.get(key).months; r[mk] = r[mk] || { income: 0, funding: 0 };
      r[mk].income += income; r[mk].funding += funding;
    };
    const totals = {};
    for (const [y, m] of months) {
      const mk = `${y}-${String(m).padStart(2, '0')}`;
      const invs = await _previewMonth(req, y, m);
      totals[mk] = { income: 0, funding: 0, children: invs.length };
      for (const x of invs) {
        const funding = Math.abs(Number(x.funding_deduction_pence) || 0);
        const income = Number(x.amount_pence) || 0;        // what the family pays
        totals[mk].income += income; totals[mk].funding += funding;
        if (by === 'children') add('c' + x.child_id, x.child_name || ('Child ' + x.child_id), x.room || '', mk, income, funding);
        else if (by === 'rooms') add('r' + (x.room || '—'), x.room || 'No room', '', mk, income, funding);
        else {
          for (const l of x.line_items || []) {
            const amt = Number(l.amount_pence) || 0;
            const isFunding = !!(l.is_funded || l.is_deduction) && /fund/i.test(l.label || l.description || '');
            const key = by === 'products'
              ? ((l.is_discount || l.discount_id) ? 'Discounts' : String(l.label || l.description || 'Other').replace(_MONTHS_RE, '').replace(/ — child \d+ — .*$/, '').trim())
              : (l.statutory_category || l.category || 'Other');
            if (isFunding) add('p' + key, key, 'funding', mk, 0, Math.abs(amt));
            else add('p' + key, key, '', mk, amt, 0);
          }
        }
      }
    }
    res.json({ by, months: months.map(([y, m]) => `${y}-${String(m).padStart(2, '0')}`), rows: [...rows.values()], totals,
               source: 'Preview of the monthly invoice run (the generator October was issued with). Nothing is saved.' });
  } catch (e) { console.error('[finance-payments] income-forecast:', e.message); res.status(500).json({ error: e.message }); }
});

// GET /api/finance/payments/accountant-pack?from=YYYY-MM-DD&to=YYYY-MM-DD&names=0|1
// 2026-10-09 (Toby's accountant: "Can I get access to the raw data tables? That way I can
// verify what I'm seeing is correct.") The raw finance rows for a period, exactly as stored,
// as one Excel workbook with a README sheet. Families are shown by their payment reference
// (LA-…) unless names=1; bank narratives (which carry payers' names) are hidden likewise.
// Manager-only (router guard) and audited.
router.get('/accountant-pack', async (req, res) => {
  const db = getPool();
  const isoOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  const from = isoOk(req.query.from) ? req.query.from : '2026-09-26';
  const to = isoOk(req.query.to) ? req.query.to : new Date().toISOString().slice(0, 10);
  const names = req.query.names === '1';
  try {
    const XLSX = require('xlsx');
    const { familyLedger } = require('../lib/family-ledger');
    const { outstandingSql } = require('../lib/invoice-outstanding');
    const gbp = (p) => p == null ? null : Math.round(Number(p)) / 100;
    const d = (v) => v ? new Date(v).toISOString().slice(0, 10) : null;
    // b484 port (2026-10-12): demo children (children.is_demo) are test fixtures, never money —
    // every sheet below leaves their rows out.
    const notDemo = (col) => `NOT EXISTS (SELECT 1 FROM children dc WHERE dc.id = ${col} AND COALESCE(dc.is_demo, false))`;
    // child → family reference (and names only if asked)
    const { rows: kids } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, ${FAMILY_KEY_SQL} AS family_key, r.payment_ref
        FROM children c LEFT JOIN family_payment_refs r ON r.family_key = ${FAMILY_KEY_SQL}
       WHERE COALESCE(c.is_demo, false) = false`);
    const kid = new Map(kids.map(k => [Number(k.id), k]));
    const who = (cid) => { const k = kid.get(Number(cid)); if (!k) return { child_id: cid, family_ref: null };
      return names ? { child_id: k.id, family_ref: k.payment_ref || null, child: `${k.first_name || ''} ${k.last_name || ''}`.trim() }
                   : { child_id: k.id, family_ref: k.payment_ref || null }; };

    const { rows: inv } = await db.query(`
      SELECT i.*, ${outstandingSql('i')} AS still_owed_pence FROM invoices i
       WHERE ((i.issued_on BETWEEN $1 AND $2) OR (make_date(i.period_year, i.period_month, 1) BETWEEN date_trunc('month', $1::date) AND $2::date))
         AND ${notDemo('i.child_id')}
       ORDER BY i.issued_on, i.id`, [from, to]);
    const invoices = inv.map(i => ({ invoice_id: i.id, number: i.invoice_number, ...who(i.child_id), period: i.period_label,
      issued_on: d(i.issued_on), due_on: d(i.due_on), status: i.status, type: i.status === 'credit_note' ? 'credit note' : 'invoice',
      credits_invoice_id: i.credit_note_for_id || null, amount_gbp: gbp(i.amount_pence), gross_gbp: gbp(i.gross_amount_pence),
      funding_deducted_gbp: gbp(i.funding_deduction_pence), discount_gbp: gbp(i.discount_pence),
      still_owed_gbp: i.status === 'credit_note' ? null : gbp(i.still_owed_pence), paid_on: d(i.paid_on), source: i.source || 'wren', eylog_ref: i.eylog_ref || null }));
    const lines = [];
    for (const i of inv) for (const l of (Array.isArray(i.line_items) ? i.line_items : [])) {
      lines.push({ invoice_id: i.id, number: i.invoice_number, ...who(i.child_id), label: String(l.label || l.description || '').replace(/ — child \d+ — /, ' — '),
        category: l.statutory_category || l.category || null, quantity: l.quantity ?? null, unit: l.unit_label || null,
        unit_gbp: gbp(l.unit_pence), amount_gbp: gbp(l.amount_pence), funded: !!l.is_funded, deduction: !!l.is_deduction });
    }
    const { rows: pay } = await db.query(`
      SELECT * FROM payments WHERE COALESCE(paid_on, created_at::date) BETWEEN $1 AND $2 AND ${notDemo('payments.child_id')}
       ORDER BY COALESCE(paid_on, created_at::date), id`, [from, to]);
    const payments = pay.map(p => ({ payment_id: p.id, ...who(p.child_id), paid_on: d(p.paid_on), amount_gbp: gbp(p.amount_pence),
      method: p.payment_method, status: p.status, source: p.source || null, linked_invoice_id: p.invoice_id || null,
      bank_line_id: p.bank_statement_line_id || null, reconciled_at: d(p.reconciled_at), is_deposit: !!p.is_deposit,
      eylog_payment_no: p.eylog_payment_no || null, note: names ? (p.description || null) : (p.description && /credit|deposit|discount|funding/i.test(p.description) ? p.description.replace(/\(the rest of [^)]*\)/, '').trim() : null) }));
    const { rows: alloc } = await db.query(`
      SELECT a.* FROM payment_allocations a LEFT JOIN payments p ON p.id = a.payment_id
       WHERE (a.allocated_on BETWEEN $1 AND $2 OR COALESCE(p.paid_on, p.created_at::date) BETWEEN $1 AND $2)
         AND ${notDemo('a.child_id')} ORDER BY a.id`, [from, to]);
    const allocations = alloc.map(a => ({ allocation_id: a.id, payment_id: a.payment_id, invoice_id: a.invoice_id, ...who(a.child_id),
      amount_gbp: gbp(a.amount_pence), allocated_on: d(a.allocated_on), source: a.source || null }));
    const { rows: bank } = await db.query(`
      SELECT l.*, s.source AS feed, s.account_name,
             (SELECT string_agg(p.id::text, ' ') FROM payments p WHERE p.bank_statement_line_id = l.id) AS payment_ids
        FROM bank_statement_lines l JOIN bank_statements s ON s.id = l.statement_id
       WHERE l.transaction_date BETWEEN $1 AND $2 ORDER BY l.transaction_date, l.id`, [from, to]);
    const banklines = bank.map(b => ({ line_id: b.id, date: d(b.transaction_date), amount_gbp: gbp(b.amount_pence), running_balance_gbp: gbp(b.balance_pence),
      feed: b.feed, account: b.account_name || null, matched_payment_ids: b.payment_ids || null, reconciled: !!b.reconciled,
      set_aside_reason: b.excluded_reason || null, description: names ? (b.description || null) : '(hidden — tick "include names")',
      reference: names ? (b.reference || null) : null }));
    const { rows: ob } = await db.query(`SELECT * FROM opening_balances WHERE ${notDemo('opening_balances.child_id')} ORDER BY child_id`);
    const opening = ob.map(o => ({ ...who(o.child_id), as_of: d(o.as_of), balance_gbp: gbp(o.balance_pence), meaning: Number(o.balance_pence) > 0 ? 'owed' : Number(o.balance_pence) < 0 ? 'in credit' : 'nil',
      source: o.source, bf_invoice_id: o.invoice_id || null, credit_payment_id: o.payment_id || null }));
    const { rows: fund } = await db.query(`
      SELECT cf.child_id, ft.name AS term, ft.start_date, ft.end_date, cf.funding_type, cf.universal_hours_week, cf.extended_hours_week,
             cf.total_hours_week, cf.stretched_funding, cf.eylog_hours_basis
        FROM child_funding cf JOIN funding_terms ft ON ft.id = cf.term_id
       WHERE ft.end_date >= $1 AND ft.start_date <= $2 AND ${notDemo('cf.child_id')} ORDER BY ft.start_date, cf.child_id`, [from, to]);
    const funding = fund.map(f => ({ ...who(f.child_id), term: f.term, term_start: d(f.start_date), term_end: d(f.end_date), type: f.funding_type,
      universal_hrs_wk: f.universal_hours_week, extended_hrs_wk: f.extended_hours_week, total_hrs_wk: f.total_hours_week,
      stretched: !!f.stretched_funding, hours_basis: f.eylog_hours_basis || null }));
    // family balances (the same ledger the parents app and Roost show)
    const fams = new Map();
    for (const k of kids) { const key = k.family_key || ('child:' + k.id); if (!fams.has(key)) fams.set(key, []); fams.get(key).push(k); }
    const balances = [];
    for (const members of fams.values()) {
      const led = await familyLedger(db, members.map(m => m.id));
      const bal = Number(led.balance_pence) || 0;
      if (!bal && !(led.transactions || []).length) continue;
      balances.push({ family_ref: members[0].payment_ref || null, child_ids: members.map(m => m.id).join(' '),
        ...(names ? { children: members.map(m => `${m.first_name || ''} ${m.last_name || ''}`.trim()).join(' & ') } : {}),
        balance_gbp: gbp(bal), meaning: bal > 0 ? 'owes' : bal < 0 ? 'in credit' : 'settled', deposit_held_gbp: gbp(led.deposit_pence) });
    }
    balances.sort((a, b) => b.balance_gbp - a.balance_gbp);

    // b481 port (release-money2 review) — Nathan: "which forecast is the golden source?" and raw
    // session data. Both come from the SAME preview of the monthly invoice run that Invoices &
    // Payments → Income forecast shows (_previewMonth above, same cache), so the CHECK row equals
    // that tab's Total for the same months by construction — not a second calculation.
    const fcN = Math.min(12, Math.max(1, parseInt(req.query.fc_months, 10) || 3));
    const fcMonths = [];
    for (let k = 1; k <= fcN; k++) { const dd = new Date(); dd.setDate(1); dd.setMonth(dd.getMonth() + k); fcMonths.push([dd.getFullYear(), dd.getMonth() + 1]); }
    const ym = ([y, m]) => `${y}-${String(m).padStart(2, '0')}`;
    const forecast = [];
    const billedRate = new Map();
    let fcNet = 0, fcFunding = 0;
    for (const mon of fcMonths) {
      const prev = await _previewMonth(req, mon[0], mon[1]);
      let mNet = 0, mFund = 0, mGross = 0, mCons = 0;
      for (const x of prev) {
        const lines = Array.isArray(x.line_items) ? x.line_items : [];
        const paid = lines.filter(l => l.category === 'additional_private_paid_hours' && !l.is_deduction && !l.is_credit && !l.is_discount);
        const gross = paid.reduce((t, l) => t + (Number(l.amount_pence) || 0), 0);
        const cons = lines.filter(l => ['food', 'non_food_consumables'].includes(l.category) && !l.is_deduction)
          .reduce((t, l) => t + (Number(l.amount_pence) || 0), 0);
        const fund = Math.abs(Number(x.funding_deduction_pence) || 0);
        const net = Number(x.amount_pence) || 0;
        if (!billedRate.has(Number(x.child_id)) && paid[0]) billedRate.set(Number(x.child_id), { pence: paid[0].unit_pence, changed: !!paid[0].price_overridden });
        forecast.push({ month: ym(mon), ...who(x.child_id), room: x.room || null, gross_fees_gbp: gbp(gross), funding_deducted_gbp: gbp(-fund),
          consumables_gbp: gbp(cons), other_adjustments_gbp: gbp(net - gross + fund - cons), parents_pay_gbp: gbp(net),
          already_invoiced: !!x.already_invoiced });
        mNet += net; mFund += fund; mGross += gross; mCons += cons;
      }
      forecast.push({ month: ym(mon), family_ref: 'MONTH TOTAL', child_id: null, room: null, gross_fees_gbp: gbp(mGross), funding_deducted_gbp: gbp(-mFund),
        consumables_gbp: gbp(mCons), other_adjustments_gbp: gbp(mNet - mGross + mFund - mCons), parents_pay_gbp: gbp(mNet), already_invoiced: null });
      fcNet += mNet; fcFunding += mFund;
    }
    forecast.push({ month: `${ym(fcMonths[0])} to ${ym(fcMonths[fcMonths.length - 1])}`, family_ref: 'CHECK',
      child_id: null, room: 'must equal Invoices & Payments → Income forecast, same From/To: Total (parents pay only); funding = its "funded" total',
      gross_fees_gbp: null, funding_deducted_gbp: gbp(-fcFunding), consumables_gbp: null, other_adjustments_gbp: null, parents_pay_gbp: gbp(fcNet), already_invoiced: null });
    const { rows: sess } = await db.query(`
      SELECT c.id AS child_id, br.name AS room, b.mon, b.tue, b.wed, b.thu, b.fri, b.start_time, b.finish_time,
             b.start_date, b.end_date, cf.funding_type, cf.universal_hours_week, cf.extended_hours_week, cf.total_hours_week
        FROM children c
        JOIN LATERAL (SELECT * FROM child_bookings bb WHERE bb.child_id = c.id AND bb.is_active
                       ORDER BY bb.start_date DESC LIMIT 1) b ON true
        LEFT JOIN rooms br ON br.id = b.room_id
        LEFT JOIN funding_terms ft ON ft.is_current
        LEFT JOIN child_funding cf ON cf.child_id = c.id AND cf.term_id = ft.id
       WHERE c.status = 'active' AND COALESCE(c.is_demo, false) = false
       ORDER BY br.name NULLS LAST, c.id`);
    const sessions = sess.map(r => {
      const days = ['mon', 'tue', 'wed', 'thu', 'fri'].filter(dk => r[dk]);
      const br = billedRate.get(Number(r.child_id));
      return { ...who(r.child_id), room: r.room || null, days: days.join(' '), days_per_week: days.length,
        session: (r.start_time && r.finish_time) ? `${String(r.start_time).slice(0, 5)}-${String(r.finish_time).slice(0, 5)}` : null,
        booking_start: d(r.start_date), booking_end: d(r.end_date),
        billed_day_rate_gbp: br ? gbp(br.pence) : null, price_changed: br ? br.changed : null,
        funding_type: r.funding_type || null, universal_hrs_wk: r.universal_hours_week, extended_hrs_wk: r.extended_hours_week,
        total_hrs_wk: r.total_hours_week };
    });

    const readme = [
      ['Wren — accountant data pack'], [`Period: ${from} to ${to}`], [`Generated: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC by staff #${req.user && req.user.id}`],
      [names ? 'Names INCLUDED.' : 'Names hidden: families are shown by payment reference (family_ref, e.g. LA-…) and child_id. Bank narratives are hidden.'], [],
      ['These are the raw rows as stored in Wren — nothing recalculated except the two derived columns marked *.'], [],
      ['Sheet', 'What it is'],
      ['Family balances', 'Current balance per family (* from the family ledger — the same figure parents see). Positive = owes, negative = in credit.'],
      ['Invoices', 'Every invoice and credit note issued in the period (or for a month in the period). still_owed_gbp* = amount + credit notes against it − allocated payments − linked unallocated payments.'],
      ['Invoice lines', 'The line items on those invoices: childcare, funding deductions (negative, funded=TRUE), consumables, discounts.'],
      ['Payments', 'Every payment row dated in the period, incl. opening-balance credits (source opening-balance) and credit held on account (credit-note-excess).'],
      ['Allocations', 'How payments were split across invoices (a payment counts through its allocations if it has any, otherwise through linked_invoice_id).'],
      ['Bank lines', 'Bank statement lines in the period (TrueLayer = live Barclays feed; xero = copies from Xero, set aside). matched_payment_ids links to Payments.'],
      ['Opening balances', 'EyLog closing balance per child, taken as Wren\'s opening balance at the 26 Sep 2026 cutover (BF bill if owed, credit payment if in credit).'],
      ['Funding', 'Funded-hours allocations for terms overlapping the period.'],
      ['Sessions & bookings', 'Each child on roll now: room and days/session times from their live booking, funded hours this term, and the day rate the invoice run bills them at (price_changed = a manager price override).'],
      ['Forecast breakdown', `What the monthly invoice run would bill, per child, for ${fcMonths.map(ym).join(', ')}: gross fees, funding deducted, consumables, other adjustments (discounts/credits), parents pay. The CHECK row must equal Invoices & Payments → Income forecast for the same From/To ("Parents pay only" Total; the funding figure is its "funded" total).`], [],
      ['Money is in pounds (GBP). Dates are YYYY-MM-DD. IDs link the sheets together.'],
      ['Demo/test children (Wren test fixtures) are left out of every sheet.'],
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(readme), 'How to read this');
    for (const [name, rows] of [['Family balances', balances], ['Invoices', invoices], ['Invoice lines', lines], ['Payments', payments],
                                ['Allocations', allocations], ['Bank lines', banklines], ['Opening balances', opening], ['Funding', funding],
                                ['Sessions & bookings', sessions], ['Forecast breakdown', forecast]]) {
      XLSX.utils.book_append_sheet(wb, rows.length ? XLSX.utils.json_to_sheet(rows) : XLSX.utils.aoa_to_sheet([['(no rows in this period)']]), name);
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    recordAudit({ req, action: 'export', entity_type: 'finance', entity_id: null,
      meta: { type: 'accountant_pack', from, to, names, counts: { invoices: invoices.length, payments: payments.length, bank: banklines.length } } });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="wren-accountant-pack-${from}-to-${to}${names ? '-with-names' : ''}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) { console.error('[finance-payments] accountant-pack:', e.message); res.status(500).json({ error: e.message }); }
});

router.get('/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [p] } = await db.query(`
      SELECT p.*, c.first_name || ' ' || c.last_name AS child_name,
             COALESCE(p.eylog_payment_no, 'W'||p.id::text) AS payment_no,
             (p.source IS DISTINCT FROM 'manual') AS locked
        FROM payments p LEFT JOIN children c ON c.id = p.child_id
       WHERE p.id = $1`, [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    const { rows: allocations } = await db.query(`
      SELECT a.id, a.invoice_id, a.amount_pence, a.allocated_on,
             i.invoice_number, i.issued_on AS invoice_date
        FROM payment_allocations a LEFT JOIN invoices i ON i.id = a.invoice_id
       WHERE a.payment_id = $1 ORDER BY a.id`, [req.params.id]);
    res.json({ ...p, allocations });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/finance/payments/manual — record money in, by hand ─────────────
// Body: { child_id, date, mode, amount_pence, reference, notes, apply_to, invoice_id }
// apply_to: 'oldest' (default — the family's oldest unpaid invoice first, then
// credit) | 'invoice' (pay this one bill) | 'account' (straight to credit, no
// invoice touched). Mode 'Deposit' always behaves like 'oldest': "we don't hold
// onto these" (src/lib/deposits.js) — LADN has no separate deposit account for a
// child already on roll, so a deposit is simply a payment the moment it lands.
router.post('/manual', async (req, res) => {
  const db = getPool();
  const { child_id, date, mode, amount_pence, reference, notes } = req.body || {};
  let { apply_to = 'oldest', invoice_id = null } = req.body || {};

  const childId = parseInt(child_id, 10);
  const amt = pence(amount_pence);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'child_id required' });
  if (!(amt > 0)) return res.status(400).json({ error: 'amount_pence must be greater than 0' });
  if (!['oldest', 'invoice', 'account', 'balance'].includes(apply_to)) {
    return res.status(400).json({ error: 'apply_to must be oldest, invoice, account or balance' });
  }
  if (apply_to === 'invoice' && !invoice_id) {
    return res.status(400).json({ error: 'invoice_id required when apply_to is "invoice"' });
  }
  if (String(mode || '').toLowerCase() === 'deposit') apply_to = apply_to === 'account' ? 'account' : 'oldest';

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const { rows: [child] } = await client.query(
      `SELECT id, ${FAMILY_KEY_SQL} AS family_key FROM children c WHERE c.id = $1 FOR UPDATE`, [childId]);
    if (!child) throw Object.assign(new Error('Child not found'), { code: 'not_found' });

    let plan;
    if (apply_to === 'account') {
      plan = { allocation: [], allocated_pence: 0, credit_pence: amt, open_invoice_count: 0 };
    } else if (apply_to === 'balance') {
      // release-money2 review F3 (b492 "Record balance payment…"): allocate EXACTLY as the
      // parents' one-card "Pay balance" does — the same family (children sharing an active
      // parent login, the set Roost's family view and the parents app show), demo children out,
      // the family's on-account credit put onto its bills first, then oldest-first by
      // outstandingSql (credit notes and allocations counted). planAllocation() above counts
      // neither: £1,580 against bills of £480(after a £20 credit note)/£500/£300/£300 went
      // £500/£500/£300/£280 — the first bill over-allocated £20, the last left £20 open at £0.
      const IO = require('../lib/invoice-outstanding');
      const S = require('../db/connection').schema();
      const { rows: [f] } = await client.query(
        `SELECT array_agg(DISTINCT b.child_id) AS ids
           FROM parent_portal_access a
           JOIN parent_portal_access b ON lower(b.email) = lower(a.email) AND b.is_active AND b.child_id IS NOT NULL
          WHERE a.child_id = $1 AND a.is_active`, [childId]);
      const famIds = Array.from(new Set([childId, ...((f && f.ids) || []).map(Number)]));
      for (const inv of await IO.familyOpenInvoices(client, famIds, S)) {
        await IO.applyUnallocatedCredit(client, inv.id, S);
      }
      const open = await IO.familyOpenInvoices(client, famIds, S);
      if (open.length) {
        await client.query(`SELECT id FROM invoices WHERE id = ANY($1::int[]) FOR UPDATE`, [open.map(i => i.id)]);
      }
      let remaining = amt;
      const allocation = [];
      for (const inv of await IO.familyOpenInvoices(client, famIds, S)) {
        if (remaining <= 0) break;
        const owed = Number(inv.outstanding_pence) || 0;
        if (owed <= 0) continue;
        const take = Math.min(remaining, owed);
        allocation.push({ invoice_id: inv.id, invoice_number: inv.invoice_number, child_id: inv.child_id,
                          outstanding_pence: owed, allocate_pence: take, settles: take === owed });
        remaining -= take;
      }
      plan = { allocation, allocated_pence: amt - remaining, credit_pence: remaining, open_invoice_count: open.length };
    } else if (apply_to === 'invoice') {
      const invId = parseInt(invoice_id, 10);
      const { rows: [inv] } = await client.query('SELECT child_id FROM invoices WHERE id = $1', [invId]);
      if (!inv) throw Object.assign(new Error('Invoice not found'), { code: 'not_found' });
      plan = await planAllocationToInvoice(client, { invoiceId: invId, amountPence: amt });
    } else {
      plan = await PM.planAllocation(client, {
        familyKey: child.family_key, childId: null, amountPence: amt, onDate: date,
      });
    }

    const { rows: [fam] } = await client.query(
      `SELECT payment_ref FROM family_payment_refs WHERE family_key = $1 AND retired_at IS NULL LIMIT 1`,
      [child.family_key]);

    const paidOn = date || new Date().toISOString().slice(0, 10);
    const { rows: [pmt] } = await client.query(`
      INSERT INTO payments
        (invoice_id, child_id, amount_pence, payment_method, status, description,
         cash_reference, manual_notes, reconciliation_status, paid_on, source,
         family_payment_ref, updated_at)
      VALUES ($1,$2,$3,$4,'succeeded',$5,$6,$7,'reconciled',$8,'manual',$9,NOW())
      RETURNING id`,
      [plan.allocation[0]?.invoice_id || null, childId, amt, mode || 'manual',
       notes || `Manual payment — ${mode || 'cash'}`, reference || null, notes || null,
       paidOn, fam ? fam.payment_ref : null]);

    for (const a of plan.allocation) {
      const per = await AP.periodOfInvoiceId(client, a.invoice_id);
      await client.query(`
        INSERT INTO payment_allocations
          (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference,
           period_year, period_month, period_source)
        VALUES ($1,$2,$3,$4,$5,'b397-manual',$6,$7,$8,$9)`,
        [pmt.id, a.invoice_id, a.child_id, a.allocate_pence, paidOn, reference || null,
         per.year, per.month, per.source]);
      if (a.settles) {
        await client.query(
          `UPDATE invoices SET status = 'paid', paid_on = $1, updated_at = NOW()
            WHERE id = $2 AND status IN ('sent', 'overdue')`, [paidOn, a.invoice_id]);
      }
    }

    // 2026-10-06 review: whatever is not allocated stays on THE PAYMENT as unallocated
    // money (EyMan's "Balance" column on a payment). The family statement already counts
    // the whole payment, so the family is in credit by exactly that much. It must NOT also
    // become a parent_account_credits row: POST /generate takes those off the next invoice,
    // and the family would be credited twice.
    const creditId = null;

    // Kept so Undo can find exactly what this payment created, without a second
    // table to track the link — the one free jsonb column every payment already has.
    await client.query(
      `UPDATE payments SET match_evidence = $2::jsonb WHERE id = $1`,
      [pmt.id, JSON.stringify({ apply_to, manual_credit_id: creditId, planned: plan.allocation })]);

    await client.query('COMMIT');

    recordAudit({ req, action: 'create', entity_type: 'payment', entity_id: pmt.id,
      meta: { type: 'manual', child_id: childId, apply_to, amount_pence: amt,
              allocated_pence: plan.allocated_pence, credit_pence: plan.credit_pence } });

    // 2026-10-06 — the family sees it arrive (in-app bell only, never email).
    require('../lib/parent-payment-notice').notifyPaymentReceived(
      db, childId, amt, { onDate: paidOn, kind: /deposit/i.test(String(req.body && req.body.mode || '')) ? 'deposit' : 'payment' }).catch(() => {});
    res.json({ ok: true, payment_id: pmt.id, allocation: plan.allocation,
               allocated_pence: plan.allocated_pence, credit_pence: plan.credit_pence });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[finance-payments] manual:', e.message);
    res.status(e.code === 'not_found' ? 404 : 500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ── PUT /api/finance/payments/:id — edit a manual payment ─────────────────────
// Only the office's own entries can be corrected: date, mode, reference, notes.
// The AMOUNT cannot be changed here — it was already allocated when it was
// recorded, so a different figure means Undo and re-enter, not an edit.
router.put('/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [p] } = await db.query('SELECT * FROM payments WHERE id = $1', [req.params.id]);
    if (!p) return res.status(404).json({ error: 'Payment not found' });
    if (p.source !== 'manual') {
      return res.status(409).json({ error: 'Only a manually-entered payment can be edited here.', code: 'not_manual' });
    }
    if (p.status === 'reversed') {
      return res.status(409).json({ error: 'This payment has been undone.', code: 'reversed' });
    }
    const { date, mode, reference, notes } = req.body || {};
    const sets = ['updated_at = NOW()']; const vals = [];
    if (date !== undefined)      { vals.push(date);      sets.push(`paid_on = $${vals.length}`); }
    if (mode !== undefined)      { vals.push(mode);      sets.push(`payment_method = $${vals.length}`); }
    if (reference !== undefined) { vals.push(reference); sets.push(`cash_reference = $${vals.length}`); }
    if (notes !== undefined)     { vals.push(notes);     sets.push(`manual_notes = $${vals.length}`); }
    vals.push(req.params.id);
    await db.query(`UPDATE payments SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
    recordAudit({ req, action: 'update', entity_type: 'payment', entity_id: parseInt(req.params.id, 10),
      meta: { fields: Object.keys(req.body || {}) } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/finance/payments/:id/reverse — undo, never delete ───────────────
router.post('/:id/reverse', async (req, res) => {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [p] } = await client.query(
      'SELECT * FROM payments WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!p) throw Object.assign(new Error('Payment not found'), { code: 'not_found' });
    if (p.source !== 'manual') throw Object.assign(new Error('Only a manually-entered payment can be undone here.'), { code: 'not_manual' });
    if (p.status === 'reversed') throw Object.assign(new Error('Already undone.'), { code: 'reversed' });

    const { rows: allocs } = await client.query(
      'SELECT invoice_id, amount_pence FROM payment_allocations WHERE payment_id = $1', [p.id]);
    const invoiceIds = [...new Set(allocs.map(a => a.invoice_id).filter(Boolean))];
    await client.query('DELETE FROM payment_allocations WHERE payment_id = $1', [p.id]);

    for (const invId of invoiceIds) {
      const { rows: [inv] } = await client.query('SELECT status, due_on FROM invoices WHERE id = $1', [invId]);
      if (!inv || inv.status !== 'paid') continue;
      const { rows: [sum] } = await client.query(
        `SELECT COALESCE(SUM(amount_pence), 0) AS paid FROM payments
          WHERE invoice_id = $1 AND status = 'succeeded' AND id <> $2`, [invId, p.id]);
      const { rows: [amt] } = await client.query('SELECT amount_pence FROM invoices WHERE id = $1', [invId]);
      if (pence(sum.paid) < pence(amt.amount_pence)) {
        const overdue = inv.due_on && new Date(inv.due_on) < new Date();
        await client.query(
          `UPDATE invoices SET status = $2, paid_on = NULL, updated_at = NOW() WHERE id = $1`,
          [invId, overdue ? 'overdue' : 'sent']);
      }
    }

    // The on-account credit this payment created, if it is still sitting untouched.
    const ev = p.match_evidence || {};
    if (ev.manual_credit_id) {
      await client.query(
        `DELETE FROM parent_account_credits WHERE id = $1 AND status = 'approved' AND applied_invoice_id IS NULL`,
        [ev.manual_credit_id]);
    }

    await client.query(
      `UPDATE payments SET status = 'reversed', updated_at = NOW() WHERE id = $1`, [p.id]);
    await client.query('COMMIT');

    recordAudit({ req, action: 'update', entity_type: 'payment', entity_id: p.id,
      meta: { type: 'manual_reverse', invoices_touched: invoiceIds } });

    res.json({ ok: true, invoices_touched: invoiceIds });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(e.code === 'not_found' ? 404 : e.code ? 409 : 500).json({ error: e.message, code: e.code });
  } finally {
    client.release();
  }
});

// ── POST /api/finance/payments/credit-note — a family-level credit note ───────
// Body: { child_id, invoice_id?, amount_pence, reason }. With invoice_id, this
// IS the existing POST /api/finance/invoices/:id/credit-note — call it instead
// of writing a second version of that money rule. Without one, the credit is
// not against any bill yet, so it is money the family holds on account, the
// same shape generate-itemised already reads back (parent_account_credits).
router.post('/credit-note', async (req, res) => {
  const db = getPool();
  const { child_id, invoice_id, amount_pence, reason } = req.body || {};
  const amt = pence(amount_pence);
  if (!(amt > 0)) return res.status(400).json({ error: 'amount_pence must be greater than 0' });
  try {
    if (invoice_id) {
      const { createCreditNote } = require('./finance-invoices');
      const r = await createCreditNote(db, invoice_id, amt, reason);
      recordAudit({ req, action: 'create', entity_type: 'invoice', entity_id: r.id,
        meta: { type: 'credit_note', for_invoice: invoice_id, via: 'money-payments-tab' } });
      return res.json({ ok: true, ...r });
    }
    const childId = parseInt(child_id, 10);
    if (!Number.isInteger(childId)) return res.status(400).json({ error: 'child_id or invoice_id required' });
    // 2026-10-06 review: a credit note with no invoice is still a CREDIT NOTE row in
    // invoices (status 'credit_note', negative, credit_note_for_id NULL), so the family
    // statement (src/lib/family-ledger.js) shows it at once, the same as every other
    // credit note. parent_account_credits is only read by POST /generate, never by the
    // itemised generator October was raised with, so a credit parked there could vanish.
    const { rows: [child] } = await db.query(
      `SELECT id, ${FAMILY_KEY_SQL} AS family_key FROM children c WHERE c.id = $1`, [childId]);
    if (!child) return res.status(404).json({ error: 'Child not found' });
    const now = new Date();
    const { rows: [num] } = await db.query(
      `SELECT 'CN-' || to_char(NOW(),'YYYY') || '-' || lpad((COUNT(*) + 1)::text, 4, '0') AS n
         FROM invoices WHERE status = 'credit_note' AND credit_note_for_id IS NULL
          AND invoice_number LIKE 'CN-' || to_char(NOW(),'YYYY') || '-%'`);
    const { rows: [cn] } = await db.query(`
      INSERT INTO invoices (child_id, bill_payer_email, amount_pence, status, issued_on,
                            period_year, period_month, period_label, invoice_number, notes, line_items, updated_at)
      VALUES ($1, $2, $3, 'credit_note', CURRENT_DATE, $4, $5, to_char(make_date($4,$5,1),'FMMonth YYYY'),
              $6, $7, $8::jsonb, NOW())
      RETURNING id, invoice_number`,
      [childId, child.family_key, -amt, now.getFullYear(), now.getMonth() + 1, num.n,
       reason || 'Credit note',
       JSON.stringify([{ label: reason || 'Credit note', amount_pence: -amt }])]);
    recordAudit({ req, action: 'create', entity_type: 'invoice', entity_id: cn.id,
      meta: { type: 'credit_note', standalone: true, child_id: childId, amount_pence: amt } });
    res.json({ ok: true, id: cn.id, invoice_number: cn.invoice_number });
  } catch (e) {
    console.error('[finance-payments] credit-note:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
