'use strict';
// Finance Invoices — full invoice management (generate, send, CRUD).
// Mounted at /api/finance/invoices

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { notify }   = require('../services/notification-dispatcher');
// b225 — one discount engine, shared by the legacy DfE generator below and the
// itemised one further down, so a bulk run and a regenerated draft cannot reach
// different answers for the same child.
const DISC = require('../lib/invoice-discounts');
// b490 — a manager-set per-child, per-period price override, read by both billing
// engines (see priceOverrideLateralSql's doc comment).
const PO = require('../lib/price-overrides');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const XS = require('../lib/extra-sessions');   // 2026-10-21 — one-off extra sessions onto the next invoice

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

async function nextInvoiceNumber(db, year) {
  const { rows } = await db.query(`
    INSERT INTO invoice_number_seq (prefix, year, next_val)
    VALUES ('INV', $1, 2)
    ON CONFLICT (prefix, year) DO UPDATE SET next_val = invoice_number_seq.next_val + 1
    RETURNING next_val - 1 AS num
  `, [year]);
  return `INV-${year}-${String(rows[0].num).padStart(4, '0')}`;
}

// ── GET /api/finance/invoices ─────────────────────────────────────────────────
// Full filter params: year, month, child_id, child_name, payment_mode, invoice_number,
// date_from, date_to, amount_min, amount_max, status, sent, limit, offset
router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const {
      year, month, child_id, child_name, payment_mode, invoice_number,
      date_from, date_to, amount_min, amount_max, status, sent,
      limit = 100, offset = 0,
    } = req.query;

    const params = [];
    let where = 'WHERE 1=1';

    const add = (clause, val) => { params.push(val); where += ` AND ${clause.replace('?', `$${params.length}`)}`; };

    if (year)           add('i.period_year = ?',          parseInt(year));
    if (month)          add('i.period_month = ?',         parseInt(month));
    if (child_id)       add('i.child_id = ?',             parseInt(child_id));
    if (child_name)     add('(c.first_name || \' \' || c.last_name) ILIKE ?', `%${child_name}%`);
    if (payment_mode)   add('i.payment_method = ?',       payment_mode);
    if (invoice_number) add('i.invoice_number ILIKE ?',   `%${invoice_number}%`);
    if (date_from)      add('i.issued_on >= ?',           date_from);
    if (date_to)        add('i.issued_on <= ?',           date_to);
    if (amount_min)     add('i.amount_pence >= ?',        parseInt(amount_min) * 100);
    if (amount_max)     add('i.amount_pence <= ?',        parseInt(amount_max) * 100);
    if (status)         add('i.status = ?',               status);
    if (sent === 'true')  add('i.sent_at IS NOT NULL',    null);
    if (sent === 'false') add('i.sent_at IS NULL',        null);

    // Fix for null parameter trick
    const paramsCleaned = params.filter(p => p !== null);
    let whereClean = where;
    // Rebuild without null params (for IS NOT NULL / IS NULL clauses)
    const paramsClean2 = [];
    let pIdx = 0;
    whereClean = where.replace(/\$(\d+)/g, (match, n) => {
      if (params[parseInt(n) - 1] === null) return '';
      paramsClean2.push(params[parseInt(n) - 1]);
      return `$${paramsClean2.length}`;
    });
    // Simpler approach: just use all params as-is (null params will cause issues)
    // Actually just use the original params array
    const finalParams = params.filter(p => p !== null);

    // Rebuild query cleanly
    const conditions = [];
    const qp = [];

    if (year)           { qp.push(parseInt(year));          conditions.push(`i.period_year = $${qp.length}`); }
    if (month)          { qp.push(parseInt(month));         conditions.push(`i.period_month = $${qp.length}`); }
    if (child_id)       { qp.push(parseInt(child_id));      conditions.push(`i.child_id = $${qp.length}`); }
    if (child_name)     { qp.push(`%${child_name}%`);       conditions.push(`(c.first_name || ' ' || c.last_name) ILIKE $${qp.length}`); }
    if (payment_mode)   { qp.push(payment_mode);            conditions.push(`i.payment_method = $${qp.length}`); }
    if (invoice_number) { qp.push(`%${invoice_number}%`);   conditions.push(`i.invoice_number ILIKE $${qp.length}`); }
    if (date_from)      { qp.push(date_from);               conditions.push(`i.issued_on >= $${qp.length}`); }
    if (date_to)        { qp.push(date_to);                 conditions.push(`i.issued_on <= $${qp.length}`); }
    if (amount_min)     { qp.push(parseInt(amount_min)*100); conditions.push(`i.amount_pence >= $${qp.length}`); }
    if (amount_max)     { qp.push(parseInt(amount_max)*100); conditions.push(`i.amount_pence <= $${qp.length}`); }
    if (status)         { qp.push(status);                  conditions.push(`i.status = $${qp.length}`); }
    if (sent === 'true') conditions.push('i.sent_at IS NOT NULL');
    if (sent === 'false') conditions.push('i.sent_at IS NULL');

    const whereStr = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
    qp.push(parseInt(limit), parseInt(offset));
    const limitClause = `LIMIT $${qp.length - 1} OFFSET $${qp.length}`;

    const { rows } = await db.query(`
      SELECT i.id, i.invoice_number, i.child_id, i.period_year, i.period_month, i.period_label,
             i.amount_pence, i.funding_deduction_pence, i.status,
             i.issued_on, i.due_on, i.paid_on, i.sent_at,
             i.payment_method, i.bill_payer_email, i.notes, i.room_id,
             i.line_items, i.tfc_reference,
             -- b401: the child money tab needs to tell the one opening-balance snapshot row
             -- (source 'opening-balance') apart from a real invoice.
             COALESCE(i.source, '') AS source,
             c.first_name || ' ' || c.last_name AS child_name,
             r.name AS room_name,
             (SELECT COALESCE(SUM(p.amount_pence), 0)
              FROM payments p WHERE p.invoice_id = i.id AND p.status = 'succeeded') AS paid_pence,
             -- 2026-10-28 (Toby: "anywhere I can check the invoice got sent out and parents
             -- received them"): opened in the parents app (the invoice itself, or its alert),
             -- and a bounce that came back to a mailbox Wren reads.
             i.parent_viewed_at,
             (SELECT MIN(n.read_at) FROM notifications n
               WHERE n.related_table = 'invoices' AND n.related_id = i.id AND n.recipient_type = 'parent') AS alert_opened_at,
             (i.sent_at IS NOT NULL AND EXISTS (
               SELECT 1 FROM comms_email_queue q
                WHERE q.direction = 'in' AND COALESCE(q.received_at, q.sent_at) > i.sent_at
                  AND (q.from_email ILIKE 'mailer-daemon%' OR q.from_email ILIKE 'postmaster%'
                       OR q.subject ILIKE '%delivery status notification%' OR q.subject ILIKE '%undeliver%'
                       OR q.subject ILIKE '%not delivered%' OR q.subject ILIKE '%delivery has failed%')
                  AND NULLIF(lower(btrim(COALESCE(i.bill_payer_email, c.primary_contact_email))), '') IS NOT NULL
                  AND position(lower(btrim(COALESCE(i.bill_payer_email, c.primary_contact_email)))
                               in lower(COALESCE(q.body_text, '') || ' ' || COALESCE(q.snippet, ''))) > 0)) AS bounced
      FROM invoices i
      JOIN children c ON c.id = i.child_id
      LEFT JOIN rooms r ON r.id = i.room_id
      ${whereStr}
      ORDER BY i.period_year DESC, i.period_month DESC, c.first_name, c.last_name
      ${limitClause}
    `, qp);

    const today = new Date();
    rows.forEach(r => {
      r.balance_pence = Math.max(0, parseInt(r.amount_pence) - parseInt(r.paid_pence || 0));
      r.days_overdue  = (r.due_on && r.status === 'overdue')
        ? Math.max(0, Math.floor((today - new Date(r.due_on)) / 86400000)) : 0;
    });

    // b401 (2026-10-06) — the child money tab needs "still owed", the same rule
    // invoice-outstanding.js's outstandingSql() uses (credit notes + payment_allocations +
    // unallocated linked payments), not the naive balance_pence above. Only computed when
    // child_id is given — unqualified/search_path, like the prior-balance query above, so it
    // still works on demo schemas that have no payment_allocations table.
    if (child_id && rows.length) {
      const ids = rows.map(r => r.id);
      const outstanding = await db.query(`
        SELECT i.id, (i.amount_pence
            + COALESCE((SELECT SUM(cn.amount_pence) FROM invoices cn
                         WHERE cn.credit_note_for_id = i.id AND cn.status = 'credit_note'), 0)
            - COALESCE((SELECT SUM(a.amount_pence) FROM payment_allocations a WHERE a.invoice_id = i.id), 0)
            - COALESCE((SELECT SUM(p.amount_pence) FROM payments p
                         WHERE p.invoice_id = i.id AND p.status = 'succeeded'
                           AND NOT EXISTS (SELECT 1 FROM payment_allocations a2 WHERE a2.payment_id = p.id)), 0)
          )::int AS outstanding_pence
        FROM invoices i WHERE i.id = ANY($1::int[])`, [ids])
        .catch(() => db.query(`
          SELECT i.id, (i.amount_pence
              - COALESCE((SELECT SUM(p.amount_pence) FROM payments p
                           WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0)
            )::int AS outstanding_pence
          FROM invoices i WHERE i.id = ANY($1::int[])`, [ids]));
      const byId = new Map(outstanding.rows.map(r => [r.id, parseInt(r.outstanding_pence, 10) || 0]));
      rows.forEach(r => { r.outstanding_pence = byId.has(r.id) ? byId.get(r.id) : r.balance_pence; });
    }

    res.json({ invoices: rows, count: rows.length });
  } catch (e) {
    console.error('[finance-invoices] list error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Price overrides (b490, 2026-10-12) ───────────────────────────────────────
// "Change this child's price for a month" — EyMan/EyLog's answer to a room move
// or a one-off agreed rate that the catalogue's age-band day rates can't state.
// Read by both billing engines via src/lib/price-overrides.js; never mutates a
// fee_items row, so every OTHER child on that band is completely unaffected.
// Registered ahead of GET /:id below — '/price-overrides' would otherwise be
// swallowed as :id='price-overrides' by that earlier, more general route.

// GET /api/finance/invoices/price-overrides?child_id=NN — accountant may view
// (covered by the existing GET-only accountant gate upstream).
router.get('/price-overrides', async (req, res) => {
  const db = getPool();
  const childId = parseInt(req.query.child_id, 10);
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  try {
    const { rows } = await db.query(
      `SELECT o.*, s.first_name || ' ' || s.last_name AS created_by_name
         FROM child_price_overrides o
         LEFT JOIN staff s ON s.id = o.created_by
        WHERE o.child_id = $1
        ORDER BY o.from_date DESC`, [childId]);
    res.json({ overrides: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/finance/invoices/price-overrides
// Body: { child_id, from_date, to_date, unit='day', price_pence, reason }
router.post('/price-overrides', async (req, res) => {
  const db = getPool();
  const { child_id, from_date, to_date, unit = 'day', price_pence, reason } = req.body || {};
  const childId = parseInt(child_id, 10);
  const pricePence = parseInt(price_pence, 10);
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  if (unit !== 'day') return res.status(400).json({ error: "Only unit:'day' overrides are priced today" });
  if (!Number.isFinite(pricePence) || pricePence < 0) return res.status(400).json({ error: 'price_pence must be a whole, non-negative number of pence' });
  if (!from_date || !to_date || String(to_date) < String(from_date)) {
    return res.status(400).json({ error: 'from_date and to_date required, with to_date on or after from_date' });
  }
  // release-money2 review G5: an invoice prices a whole month at one day rate, so an override
  // from 29 Jan billed ALL of January at the new rate. Until sessions are pro-rated, a price
  // change covers whole billing months.
  {
    const f = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(from_date)), t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(to_date));
    const lastDay = t ? new Date(Date.UTC(+t[1], +t[2], 0)).getUTCDate() : 0;
    if (!f || !t || f[3] !== '01' || +t[3] !== lastDay) {
      return res.status(400).json({ error: 'A price change covers whole billing months: from the 1st to the last day of a month.' });
    }
  }
  try {
    const { rows: [child] } = await db.query('SELECT id FROM children WHERE id=$1', [childId]);
    if (!child) return res.status(404).json({ error: 'Child not found' });
    const { rows: [row] } = await db.query(
      `INSERT INTO child_price_overrides (child_id, unit, price_pence, from_date, to_date, reason, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [childId, unit, pricePence, from_date, to_date, reason || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'child_price_override', entity_id: row.id,
      meta: { child_id: childId, price_pence: pricePence, from_date, to_date, reason: reason || null } });
    // b535 — the save says what it has just made wrong. Appended after the write, never
    // in place of it: staleForChild never throws, so the override is saved either way.
    res.json({ ok: true, override: row, stale_invoices: await PRICING.staleForChild(db, childId) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/finance/invoices/price-overrides/:id/deactivate — kept, not deleted
// (same convention as discounts.active): the history of what a child was
// charged and why stays on the record.
router.post('/price-overrides/:id/deactivate', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [row] } = await db.query(
      `UPDATE child_price_overrides
          SET active = false, deactivated_by = $1, deactivated_at = NOW(), updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [req.user.id, req.params.id]);
    if (!row) return res.status(404).json({ error: 'Override not found' });
    recordAudit({ req, action: 'deactivate', entity_type: 'child_price_override', entity_id: row.id,
      meta: { child_id: row.child_id } });
    res.json({ ok: true, override: row, stale_invoices: await PRICING.staleForChild(db, row.child_id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── b535 (2026-10-29) — OUT OF DATE INVOICES ─────────────────────────────────
// "Wren notices, like EyLog." Every invoice Wren raised for a billing month that is
// still live, whose stored figures no longer match what the generator would produce
// today, with a machine-made reason derived from the line items.
//
// Read-only. It prices, compares and reports — it changes nothing and sends nothing.
//
// Registered AHEAD of GET /:id below for the same reason '/price-overrides' is:
// '/stale' would otherwise be swallowed as :id='stale' and come back as a 500 from
// pg trying to cast it to an integer.
//
//   GET /stale?from=YYYY-MM[&to=YYYY-MM][&child_id=NN][&limit=NN]
//
// `from` defaults to the current calendar month, so the default answer is "the bills
// that are still in play", not the whole history.
const PRICING = require('../lib/invoice-pricing');

router.get('/stale', async (req, res) => {
  const db = getPool();
  try {
    const childId = req.query.child_id ? parseInt(req.query.child_id, 10) : null;
    const out = await PRICING.staleScan(db, {
      from: req.query.from,
      to: req.query.to,
      childIds: Number.isInteger(childId) ? [childId] : null,
      limit: req.query.limit,
    });
    res.json(Object.assign({ ok: true }, out));
  } catch (e) {
    console.error('[finance-invoices] stale scan error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /stale/count — the chip. Same scan, counts only, no line items: a filter chip
// must not ship every line of every invoice just to render a number.
router.get('/stale/count', async (req, res) => {
  const db = getPool();
  try {
    const out = await PRICING.staleScan(db, { from: req.query.from, to: req.query.to, limit: req.query.limit });
    res.json({ ok: true, count: out.count, scanned: out.scanned, from: out.from,
               total_diff_pence: out.total_diff_pence, unpriceable: out.unpriceable, ms: out.ms });
  } catch (e) {
    console.error('[finance-invoices] stale count error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/invoices/:id ─────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [inv] } = await db.query(`
      SELECT i.*,
             c.first_name || ' ' || c.last_name AS child_name,
             c.date_of_birth, c.room AS child_room,
             r.name AS room_name,
             (SELECT json_agg(json_build_object(
               'id', p.id, 'amount_pence', p.amount_pence, 'status', p.status,
               'payment_method', p.payment_method, 'created_at', p.created_at,
               'description', p.description, 'receipt_email_sent', p.receipt_email_sent
             ) ORDER BY p.created_at DESC)
              FROM payments p WHERE p.invoice_id = i.id
             ) AS payment_history,
             -- b490 — whether THIS invoice already has a reissue replacement, so the
             -- UI can show "Already reissued as X" instead of offering the button again
             -- (reissueGuard enforces the same rule server-side; this is just the label).
             (SELECT json_build_object('id', ri.id, 'invoice_number', ri.invoice_number)
                FROM invoices ri WHERE ri.reissued_from_id = i.id AND ri.status <> 'written_off'
                LIMIT 1) AS reissued_as
      FROM invoices i
      JOIN children c ON c.id = i.child_id
      LEFT JOIN rooms r ON r.id = i.room_id
      WHERE i.id = $1
    `, [req.params.id]);

    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    res.json(inv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DfE Jan 2026: five required invoice categories ───────────────────────────
const DFE_CATEGORIES = {
  FUNDED:      'funded_entitlement_hours',
  PAID_HOURS:  'additional_private_paid_hours',
  FOOD:        'food',
  CONSUMABLES: 'non_food_consumables',
  ACTIVITIES:  'activities',
};

// Standard DfE term-time funded weeks per year (universal/extended entitlement is
// delivered over 38 weeks; stretched billing spreads these across more weeks).
const FUNDED_WEEKS_PER_YEAR = 38;

// Count funded term weekdays (Mon–Fri, excluding holiday_dates) that fall in a given
// calendar month, across all supplied funding_terms date ranges. Returns whole weekdays;
// divide by 5 for funded weeks. Used by the "term-time actuals" billing mode so a month
// with no funded term weeks deducts £0 and a full term month deducts the full weeks.
// 2026-09-24 — how many of the child's booked weekdays actually fall in this calendar
// month. Only used by the 'actual_sessions' spread mode; equally-spread billing deliberately
// ignores it, because the whole point of 52/12 is that a 4-Monday month and a 5-Monday month
// cost a family the same.
/** node-postgres hands a DATE back as a JS Date, so String(d).slice(0,10) gives
 *  "Thu Oct 16" and every date comparison below silently fails. Normalise to YYYY-MM-DD. */
function isoDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  return String(v).slice(0, 10);
}

// The consumables band follows the entitlement, not the birthday — see the note at the
// charge itself. under_2 is absent on purpose: there is no under-2 consumables rate.
/** Hours a week the child is actually here: booked days x the length of their session.
 *  Falls back to a 10-hour day (08:00-18:00, the 'day' session type) when no times are
 *  recorded — six children have no session on their booking, and defaulting to zero would
 *  silently wipe their consumables charge instead of just leaving it unrefined. */
function attendedHoursPerWeek(child) {
  const days = (child.booked_days || 0);
  if (!days) return 0;
  let hoursPerDay = 10;
  if (child.start_time && child.finish_time) {
    const [sh, sm] = String(child.start_time).split(':').map(Number);
    const [fh, fm] = String(child.finish_time).split(':').map(Number);
    const h = (fh * 60 + fm - sh * 60 - sm) / 60;
    if (h > 0) hoursPerDay = h;
  }
  return days * hoursPerDay;
}

const MEAL_BAND_BY_ENTITLEMENT = {
  '2yr_working': '2yo', '2yr_disadvantaged': '2yo', 'two_year': '2yo',
  extended: '3_4yo', universal: '3_4yo',
};

function countBookedSessionsInMonth(year, month /* 1-12 */, child, { ignoreDates = false } = {}) {
  const pattern = [child.mon, child.tue, child.wed, child.thu, child.fri];
  if (!pattern.some(Boolean)) return 0;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // A child who starts or leaves part-way through the month is only here for part of it.
  const startsOn = ignoreDates ? null : isoDate(child.start_date);
  const leavesOn = ignoreDates ? null : isoDate(child.leave_date);
  let n = 0;
  for (let d = 1; d <= last; d++) {
    const dow = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (dow < 1 || dow > 5 || !pattern[dow - 1]) continue;
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (startsOn && iso < startsOn) continue;
    if (leavesOn && iso > leavesOn) continue;   // the leave date is their last day
    n++;
  }
  return n;
}

/** Is this a part month for the child -- do they start or leave inside it? */
function isPartMonth(year, month, child) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const last  = `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
  const sd = isoDate(child.start_date);
  const ld = isoDate(child.leave_date);
  return Boolean((sd && sd > first && sd <= last) || (ld && ld >= first && ld < last));
}

function fundedWeekdaysInMonth(year, month /* 1-12 */, terms = []) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= daysInMonth; d++) {
    const dt  = new Date(Date.UTC(year, month - 1, d));
    const dow = dt.getUTCDay();            // 0 Sun … 6 Sat
    if (dow === 0 || dow === 6) continue;  // weekdays only
    const iso = dt.toISOString().slice(0, 10);
    const inTerm = terms.some(t => {
      if (!t.start_date || !t.end_date) return false;
      const s = new Date(t.start_date), e = new Date(t.end_date);
      if (dt < s || dt > e) return false;
      const hols = Array.isArray(t.holiday_dates) ? t.holiday_dates
                 : (t.holiday_dates && Array.isArray(t.holiday_dates.dates) ? t.holiday_dates.dates : []);
      return !hols.map(String).includes(iso);
    });
    if (inTerm) count++;
  }
  return count;
}

// Build itemised line items for a child's monthly invoice.
// Model: gross childcare (booked care at the room rate) as a positive line, then SEPARATE
// negative funding-deduction lines for the universal / extended / 2-year entitlements, then
// extras (meals). Funding is deducted per the child's billing mode:
//   • 'stretched'     — entitlement equalised over `stretch_weeks`; same deduction every month.
//   • 'term_actuals'  — entitlement deducted only for funded term weeks in the invoice month.
// `credits` (optional) = approved parent_account_credits rows applied as negative lines.
// Returns { lineItems, fundingDeductionPence, chargeablePence, appliedCreditIds }
function buildDfeLineItems({ child, year, month, monthLabel, term, allTerms = [], credits = [],
                             discounts = [], meal = null, consumablesOptedOut = false, extras = [] }) {
  const lineItems = [];
  // 'equally_spread' (EyMan's 52/12, what nearly every family here is on) or
  // 'actual_sessions' (price the sessions that really fall in this month -- what you want
  // for a mid-month starter, a room move, or additional sessions).
  // 2026-09-25 — a child who starts or leaves mid-month is billed for the sessions they
  // actually have, whatever their usual mode. Equally-spread exists so a 4-Monday month and a
  // 5-Monday month cost the same; it was never meant to charge a full twelfth of a year to a
  // family whose child left on the 16th.
  const partMonth = isPartMonth(year, month, child);
  const spreadMode = partMonth ? 'actual_sessions' : (child.spread_mode || 'equally_spread');
  const sessionsInMonth = countBookedSessionsInMonth(year, month, child);
  // The same month if they were here throughout — the denominator for pro-rating funding.
  const fullMonthSessions = countBookedSessionsInMonth(year, month, child, { ignoreDates: true });
  const partMonthFraction = (partMonth && fullMonthSessions > 0)
    ? sessionsInMonth / fullMonthSessions : 1;
  let fundingDeductionPence = 0;   // total funding value deducted (parent-facing)
  let chargeablePence = 0;
  const appliedCreditIds = [];
  const discountLines = [];

  // Gross monthly childcare fee.
  //
  // 2026-09-24 — this used to be the ROOM's flat monthly fee (Baby Room £1,300, Pre-school
  // £980) charged to every child alike, whether they came two days a week or five. EyMan
  // prices the child's actual booked days at the day rate for their age band and spreads the
  // year evenly over twelve months -- every active child's "Invoice Calculation Factor" in
  // EyMan is 52.00/12.00. Checked against EyMan's own October drafts: a full-time Baby Room
  // child is 5 x £105 x 52/12 = £2,275.00 to the penny, and a two-day child £910.00. The flat
  // room fee was billing roughly half, and on funded children it left a gross so small that
  // the funding deduction wiped the invoice to £0.
  const dayRatePence = child.day_rate_pence || 0;
  const bookedDays   = child.booked_days || 0;
  const weeklyPence  = dayRatePence * bookedDays;
  // b490 — the room a child is actually billed under is the one on the BOOKING active
  // for this period (child.booking_room_name), not children.room: that text field is a
  // leftover from before child_bookings existed and does not move when a room change is
  // booked, so a child moved to Pre-school on the 21st still showed "Baby Room" here.
  const roomLabel = child.booking_room_name || child.room_name || child.room || 'nursery place';
  // EQUALLY SPREAD (EyMan's 52/12). Actual-sessions billing is a separate mode -- see
  // spreadMode below -- because a child changing room or starting mid-month needs the real
  // sessions, not an even twelfth.
  const grossPence = (spreadMode === 'actual_sessions')
    ? Math.round(dayRatePence * sessionsInMonth)
    : Math.round(weeklyPence * 52 / 12);
  if (grossPence > 0) {
    // b490 — a manager-set price override for this child/period replaces the band rate
    // (see child_price_overrides); the line says so, so a parent is never left guessing
    // why their day rate differs from the catalogue.
    const overrideNote = child.price_override_reason
      ? ` Price changed for ${monthLabel} — ${child.price_override_reason}.`
      : (child.price_override_id ? ` Price changed for ${monthLabel}.` : '');
    const basisNote = (spreadMode === 'actual_sessions')
      ? `${sessionsInMonth} session(s) in ${monthLabel} at £${(dayRatePence / 100).toFixed(2)}/day.${overrideNote}`
      : `${bookedDays} day(s)/week at £${(dayRatePence / 100).toFixed(2)}/day = £${(weeklyPence / 100).toFixed(2)}/week, spread evenly over the year (x52/12).${overrideNote}`;
    lineItems.push({
      label:      `Childcare — ${roomLabel} (${monthLabel})`,
      category:   DFE_CATEGORIES.PAID_HOURS,
      is_funded:  false,
      quantity:   (spreadMode === 'actual_sessions') ? sessionsInMonth : bookedDays,
      unit_label: (spreadMode === 'actual_sessions') ? 'sessions' : 'days/week',
      unit_pence: dayRatePence,
      amount_pence: grossPence,
      note:       basisNote,
      price_overridden: !!child.price_override_id,
    });
  }

  // Funded weekly hours — prefer the child_funding term allocation, else the child flags.
  // b532 (Toby, 28 Oct: "child 127 doesn't get funding") — an allocation whose funding type is
  // 'none' funds nothing, whatever hours it still carries. It took £997.36 a month off a bill.
  const noFunding   = child.funding_type === 'none';
  const cfUniversal = noFunding ? 0 : (child.universal_hours_week != null) ? parseFloat(child.universal_hours_week) : null;
  const cfExtended  = noFunding ? 0 : (child.extended_hours_week  != null) ? parseFloat(child.extended_hours_week)  : null;
  const universalHrsWk = (cfUniversal != null) ? cfUniversal
                       : ((child.funded_hours_30 || child.funded_hours_15) ? 15 : 0);
  const extendedHrsWk  = (cfExtended != null) ? cfExtended
                       : (child.funded_hours_30 ? 15 : 0);
  const twoYrHrsWk     = (!noFunding && !universalHrsWk && !extendedHrsWk && child.two_year_funded) ? 15 : 0;

  // Billing mode + stretch period (per child; child_funding.stretched_funding as a fallback)
  const mode = child.funding_billing_mode
             || (child.stretched_funding === false ? 'term_actuals' : 'stretched')
             || 'stretched';
  const stretchWeeks = parseInt(child.stretch_weeks) || 52;

  // Use real LA rate from funding_terms, fall back to DfE floor
  const rateUniversal = term ? parseFloat(term.rate_3yr_universal || 5.94) : 5.94;
  const rateExtended  = term ? parseFloat(term.rate_3yr_extended  || 5.94) : 5.94;
  const rate2yr       = term ? parseFloat(term.rate_2yr_working_parents || 8.96) : 8.96;

  // Funded hours applicable to THIS month, with a plain-English "how this is calculated" note.
  const fundedForMonth = (hrsWk) => {
    if (hrsWk <= 0) return { hours: 0, note: '' };
    if (mode === 'term_actuals') {
      const weekdays = fundedWeekdaysInMonth(year, month, allTerms);
      const weeks = weekdays / 5;
      const hours = hrsWk * weeks;
      const note = weeks > 0
        ? `Term-time actuals: ${hrsWk} funded hrs/wk × ${weeks.toFixed(1)} funded week(s) in ${monthLabel} (${weekdays} term weekday(s)).`
        : `Term-time actuals: no funded term weeks fall in ${monthLabel}, so no funding is deducted this month.`;
      return { hours, note };
    }
    // stretched: annual entitlement spread evenly across the year.
    //
    // 2026-09-24 — what the EyMan import stores in universal_hours_week is ALREADY the
    // year-round weekly equivalent (30 term-time hours stretched = 30 x 38/52 = 21.92), which
    // is what eylog_hours_basis='stretched' records. Multiplying it by 38 again stretched a
    // figure that had been stretched once, so the deduction came out of a different year to
    // the fee. A value still on a term-time basis does get the 38-week treatment.
    const alreadyYearRound = (child.eylog_hours_basis === 'stretched');
    const annualHours  = alreadyYearRound ? hrsWk * 52 : hrsWk * FUNDED_WEEKS_PER_YEAR;
    const monthlyHours = annualHours / 12;
    const equivWeekly  = annualHours / stretchWeeks;
    const note = alreadyYearRound
      ? `Stretched entitlement: ${hrsWk} hrs/wk year-round (${annualHours.toFixed(0)} hrs/yr), billed evenly as ${monthlyHours.toFixed(1)} hrs/month.`
      : `Stretched over ${stretchWeeks} weeks: ${hrsWk} term-time hrs/wk (${FUNDED_WEEKS_PER_YEAR} funded wks/yr = ${annualHours} hrs) ≈ ${equivWeekly.toFixed(2)} hrs/wk year-round, billed evenly as ${monthlyHours.toFixed(1)} hrs/month.`;
    return { hours: monthlyHours, note };
  };

  const pushDeduction = (hrsWk, rate, bandLabel) => {
    if (hrsWk <= 0) return;
    // 2026-09-25 (Toby, on child 126) — fees are pro-rated in a part month, funding is NOT.
    // The entitlement is claimed against the child for the month, not against the days they
    // happened to attend, so a child leaving on the 16th still brings the whole month's
    // funding with them. Pro-rating it was charging the family for funding we do receive.
    // 2026-09-29 (Toby, child 126 again, with EyLog's working as the reference) — REVERSES the
    // 25 Sep rule above. EyLog removes the weekly funded hours (21.92) from each week the child
    // is booked, so every week still charges its unfunded hours (30 booked - 21.92 = 8.08 hrs,
    // £78.38 a week for child 126). Deducting a whole month's funding against half a month's
    // sessions wiped out the unfunded hours entirely and billed consumables only (£66.52).
    // In a part month the deduction is now the weekly funded hours x the weeks attended
    // (sessions attended / booked days a week). Full months are unchanged.
    const full = fundedForMonth(hrsWk);
    let hours = full.hours;
    let note = full.note;
    if (partMonthFraction < 1 && mode !== 'term_actuals' && child.booked_days > 0) {
      const alreadyYearRound = (child.eylog_hours_basis === 'stretched');
      const weeklyYearRound = alreadyYearRound ? hrsWk : hrsWk * FUNDED_WEEKS_PER_YEAR / 52;
      const weeksAttended = sessionsInMonth / child.booked_days;
      hours = weeklyYearRound * weeksAttended;
      note = `${weeklyYearRound.toFixed(2)} funded hrs/wk x ${weeksAttended.toFixed(2)} week(s) attended in ${monthLabel} (${sessionsInMonth} session(s)).`;
    }
    const pence = Math.round(hours * rate * 100);
    fundingDeductionPence += pence;
    lineItems.push({
      label:       `Government funding — ${bandLabel}`,
      category:    DFE_CATEGORIES.FUNDED,
      is_funded:   true,
      is_deduction: true,
      billing_mode: mode,
      quantity:    Number(hours.toFixed(2)),
      unit_label:  'hours',
      unit_pence:  -Math.round(rate * 100),
      amount_pence: -pence,
      note:        note ? `${note} Funded rate £${rate.toFixed(2)}/hr.` : '',
    });
  };

  // 2026-09-23 — the deduction used to price both hour buckets at the 3-4 year old rates,
  // because it read the HOURS columns and never the entitlement. An under-2 was therefore
  // credited £5.94/hr against the £12.56 the LA actually pays, and a two-year-old £5.94
  // against £8.96 — so those families were overcharged, every month.
  // The entitlement is what the LA pays against, so that is what prices it. Under-2 and
  // two-year-old places are always the working entitlement (Toby, 2026-09-23), so ALL their
  // funded hours go at their own rate; only 3-4 splits into universal and extended.
  // 2026-09-28 (Toby, confirmed against EyLog) — funded hours are deducted at OUR hourly rate,
  // not the LA's. A funded hour costs the family nothing; what they pay on top is the
  // consumables charge, which is billed separately below. Deducting at the LA rate instead
  // left the difference between our rate and theirs inside the fee AND then added consumables
  // on top, charging the same gap twice — that was the whole of the three-to-four-year-old
  // over-billing. Verified: child 92 reconciles to EyLog within 1p on this model.
  const hoursPerDay = attendedHoursPerWeek(child) && child.booked_days
    ? attendedHoursPerWeek(child) / child.booked_days : 10;
  // b490 — the CATALOGUE day rate, never the band's own price override: funding is
  // priced against what an hour of this room's care costs as a standing fact, not
  // against a one-off figure one family's bill was corrected to. Using the override
  // here would move the family's funding deduction every time their price did, when
  // the whole point of a price override is that ONLY the childcare line changes.
  const nurseryHourly = (child.catalogue_day_rate_pence ? child.catalogue_day_rate_pence / 100 : 0) / (hoursPerDay || 10);
  const FR = require('../lib/funding-rate');
  const entitlement = child.funding_type || null;
  // Fall back to the LA rate only when we have no day rate to price the child's own hours with.
  const deductAt = nurseryHourly > 0
    ? nurseryHourly
    : (FR.rateFor(term, entitlement) || rateUniversal);
  const label = entitlement === 'under_2' ? 'under-2 funded hours'
              : (entitlement === '2yr_working' || entitlement === '2yr_disadvantaged' || entitlement === 'two_year')
                ? '2-year-old funded hours'
                : 'funded hours (15/30 hours)';
  pushDeduction((universalHrsWk || 0) + (extendedHrsWk || 0) + (twoYrHrsWk || 0), deductAt, label);

  // NOTE (2026-09-28): the standing EyLog discounts are applied by the existing b225 discount
  // engine (DISC.applicableDiscounts -> discountLines), which already reads child_discounts.
  // A second application here double-counted them — each of the four children came out exactly
  // one discount too cheap. One place, one version: the engine owns it.

  // Funding can never exceed the childcare charged (a parent is never paid). If it would,
  // cap it with a positive adjustment line so the line items still sum exactly to the total.
  if (fundingDeductionPence > grossPence && grossPence >= 0) {
    const capPence = fundingDeductionPence - grossPence;
    lineItems.push({
      label:      'Funding adjustment — capped to childcare charged',
      category:   DFE_CATEGORIES.FUNDED,
      is_funded:  true,
      quantity:   1,
      unit_label: 'adjustment',
      unit_pence: capPence,
      amount_pence: capPence,
      note:       'Funded hours cover the full childcare charged this period, so the funding deduction is capped here — nothing further is payable for childcare.',
    });
  }

  // Net childcare after funding (floored at £0)
  chargeablePence += Math.max(0, grossPence - fundingDeductionPence);

  if (grossPence === 0 && fundingDeductionPence === 0) {
    // No room fee configured and no funding — flag for review
    lineItems.push({
      label:      `${monthLabel} childcare`,
      category:   DFE_CATEGORIES.PAID_HOURS,
      is_funded:  false,
      quantity:   1,
      unit_label: 'month',
      unit_pence: 0,
      amount_pence: 0,
      needs_review: true,
    });
  }

  // Consumables fee — 2026-09-17. The EyLog formula, the same arithmetic the
  // itemised generator uses, so the Finance button and the Fee Schedule button
  // cannot disagree: funded hours a week × the weekly rate for the child's age ÷
  // the 21.92-hour basis, averaged over 52 weeks / 12 months. Voluntary — skipped
  // for a child with an approved opt-out. This replaced a flat £60 a MONTH taken
  // from funding_terms.consumables_charge, which was only ever a placeholder.
  // 2026-09-25 (Toby) — ON for funded two- and three-year-olds, at EyMan's rates. Under-2s
  // carry no rate, so they are charged nothing. The band comes from the FUNDING RECORD, the
  // same source the day rate uses, so a child cannot be on the two-year-old fee and the
  // three-year-old consumables in the same month.
  // Parents see a monthly consumables charge and no working — deliberately (Toby, 2026-09-17),
  // and the whole thing is being revisited with the April fee changes.
  const weeklyFundedHrs = (universalHrsWk || 0) + (extendedHrsWk || 0) + (twoYrHrsWk || 0);
  if (meal && meal.enabled && weeklyFundedHrs > 0 && !consumablesOptedOut) {
    const band = MEAL_BAND_BY_ENTITLEMENT[child.funding_type] || IB.ageBandFromDob(child.date_of_birth);
    const ratePounds = band === '2yo' ? meal.rate2 : band === '3_4yo' ? meal.rate34 : 0;
    if (ratePounds > 0 && meal.basis > 0) {
      // 2026-09-25 (Toby) — the charge scales with the funded hours the child can actually
      // USE, not the hours they are entitled to on paper. A child in two days a week cannot
      // consume 21.92 funded hours, so charging them the full rate is not fair and is not what
      // EyMan did: two days x 10 hours = 20 hrs, 20/21.92 x £15.35 = £14.00 a week = £60.69 a
      // month, which is EyMan's figure for those children to the penny. A child claiming only
      // the universal 15 hours is already handled, because their entitlement is 10.96 not 21.92.
      const fundedHrsUsed = Math.min(weeklyFundedHrs, attendedHoursPerWeek(child));
      const weeklyPounds = fundedHrsUsed * ratePounds / meal.basis;
      // Part month: the weeks actually attended, same as the funding above (2026-09-29).
      const partWeeks = (partMonthFraction < 1 && child.booked_days > 0)
        ? sessionsInMonth / child.booked_days : null;
      const foodPence = Math.round(weeklyPounds * (partWeeks != null ? partWeeks : 52 / 12) * 100);
      chargeablePence += foodPence;
      lineItems.push({
        label:      'Consumables fee',
        category:   DFE_CATEGORIES.FOOD,
        is_funded:  false,
        quantity:   1,
        unit_label: 'month',
        unit_pence: foodPence,
        amount_pence: foodPence,
        // Parents see the weekly charge only — no working (Toby, 2026-09-17).
        note: `£${weeklyPounds.toFixed(2)} a week.`,
      });
    }
  }

  // ── b225: discounts ────────────────────────────────────────────────────────
  // Here, and not earlier: the lines above are what a discount is a percentage
  // OF. A 'fees_only' discount reads the childcare line together with the
  // funding lines, so its base is the care actually being charged for and the
  // government's contribution is never discounted. Meals sit outside that base.
  //
  // Before the credits below, because the two are different things: a discount
  // reduces what is owed, a credit is money the family already holds and is
  // spent against whatever is left after the reduction.
  if (discounts.length) {
    const built = DISC.buildDiscountLines({ lineItems, discounts, periodLabel: monthLabel });
    for (const dl of built.lines) { lineItems.push(dl); discountLines.push(dl); }
    chargeablePence -= built.total_pence;
  }

  // 2026-10-21 — one-off extra sessions (src/lib/extra-sessions.js). After the discounts, so a
  // standing discount is never taken off a session the family asked for on top; before the
  // credits, so money already on account is spent against it like anything else owed.
  const extraSessionIds = [];
  for (const xl of XS.extraSessionLines(extras)) {
    lineItems.push(xl);
    chargeablePence += xl.amount_pence;
    extraSessionIds.push(xl.child_fee_item_id);
  }

  // Account credits (e.g. £50 study-reward) — applied as a negative deduction line.
  // Only reduces what the parent pays; capped so the invoice never goes below £0.
  let creditsRemaining = chargeablePence;
  for (const cr of credits) {
    if (creditsRemaining <= 0) break;
    const applyPence = Math.min(parseInt(cr.amount_pence) || 0, creditsRemaining);
    if (applyPence <= 0) continue;
    creditsRemaining -= applyPence;
    chargeablePence  -= applyPence;
    appliedCreditIds.push(cr.id);
    lineItems.push({
      label:      cr.reason || 'Account credit',
      category:   'account_credit',
      is_funded:  false,
      is_credit:  true,
      credit_id:  cr.id,
      quantity:   1,
      unit_label: 'credit',
      unit_pence: -applyPence,
      amount_pence: -applyPence,
    });
  }

  return { lineItems, fundingDeductionPence, chargeablePence, appliedCreditIds, discountLines, extraSessionIds };
}

// b490 — the child-fetch for a legacy (buildDfeLineItems) billing run, shared by
// POST /generate, previewMonthlyBilling (the income forecast) and the reissue
// helper below, so a third hand-copy of the fee_items/booking lookup cannot drift
// from the other two. Binds $1=currentTermId, $2=year, $3=month; callers append
// their own extra WHERE clauses (child_ids, room_ids) starting at $4.
const LEGACY_CHILD_SELECT = `
    SELECT c.id, c.first_name, c.last_name, c.room, c.date_of_birth,
           c.start_date, c.leave_date,
           c.funding_hours_15, c.funding_hours_30,
           c.funded_hours, c.funded_hours_15, c.funded_hours_30,
           c.two_year_funded, c.funded_hours_type, c.two_year_funding_type,
           c.primary_contact_email,
           c.funding_billing_mode, c.stretch_weeks,
           cf.universal_hours_week, cf.extended_hours_week, cf.total_hours_week,
           cf.stretched_funding, cf.funding_type, cf.eylog_hours_basis,
           r.id AS room_id, r.name AS room_name,
           r.monthly_fee_pence,
           -- 2026-09-24 — the booking pattern and the day rate for the child's age band.
           -- These are what EyMan prices from. The flat room fee above is kept only so an
           -- invoice raised before today still renders.
           b.mon, b.tue, b.wed, b.thu, b.fri, b.start_time, b.finish_time,
           (b.mon::int + b.tue::int + b.wed::int + b.thu::int + b.fri::int) AS booked_days,
           -- b490 — the ROOM on that same booking, not the stale children.room text, for
           -- the "Childcare — <room>" line label. children.room never moves when a child
           -- is rebooked into a different room; the booking's own room_id does.
           br.name AS booking_room_name,
           br.id AS booking_room_id,
           COALESCE(ov.price_pence, fi.price_pence) AS day_rate_pence,
           -- b490 — the UN-overridden catalogue rate, kept alongside day_rate_pence
           -- above specifically for the funding-deduction hourly rate (see its own
           -- comment, below): that must never move just because a price override did.
           fi.price_pence AS catalogue_day_rate_pence,
           ov.id AS price_override_id, ov.reason AS price_override_reason,
           -- 2026-09-28 — the standing per-child discount EyLog applied and the importer
           -- never carried across. Four children have one; on three of them it accounted
           -- for the whole difference against EyLog, to the penny.
           COALESCE(cd.discount_pence, 0) AS standing_discount_pence
      FROM children c
      LEFT JOIN rooms r ON r.name = c.room
      LEFT JOIN child_funding cf ON cf.child_id = c.id AND cf.term_id = $1
      LEFT JOIN LATERAL (
        SELECT bb.mon, bb.tue, bb.wed, bb.thu, bb.fri, bb.start_time, bb.finish_time, bb.room_id
          FROM child_bookings bb
         WHERE bb.child_id = c.id AND bb.is_active
         -- b535 review (2026-10-29) — a pattern that starts AFTER the billed month must not
         -- price it: "3 days from 1 December" re-priced October and November too, so the
         -- Billing changes panel's "Effective from" was not honoured. Prefer the latest
         -- pattern that has started by the month's last day; fall back to the latest of all
         -- only when none has, so a bill never drops to nothing because of this ordering.
         -- No-op on 29 Oct data: 0 active bookings start in the future (prod and dev).
         ORDER BY (bb.start_date <= (make_date($2::int, $3::int, 1) + interval '1 month' - interval '1 day')::date) DESC,
                  bb.start_date DESC LIMIT 1) b ON true
      LEFT JOIN rooms br ON br.id = b.room_id
      LEFT JOIN LATERAL (
        SELECT d.value::int AS discount_pence
          FROM child_discounts x JOIN discounts d ON d.id = x.discount_id
         WHERE x.child_id = c.id AND d.active AND d.kind = 'fixed_pence'
           AND x.start_date <= make_date($2::int, $3::int, 1)
           AND (x.end_date IS NULL OR x.end_date >= make_date($2::int, $3::int, 1))
         ORDER BY x.start_date DESC LIMIT 1) cd ON true
      LEFT JOIN LATERAL (
        SELECT price_pence FROM fee_items
         WHERE unit = 'day' AND price_pence IS NOT NULL AND active
           -- 2026-09-24 — the band follows the FUNDING RECORD (Toby), not the child's age on
           -- the day. Pricing off age made a child's day rate jump £105 -> £97 the month they
           -- turned two, mid-way through a term whose funding says otherwise, and no EyMan
           -- invoice moves like that. Date of birth is the fallback only for a child who has
           -- no allocation to follow.
           AND age_band = CASE cf.funding_type
             WHEN 'under_2'           THEN 'under_2'
             WHEN '2yr_working'       THEN '2yo'
             WHEN '2yr_disadvantaged' THEN '2yo'
             WHEN 'two_year'          THEN '2yo'
             WHEN 'extended'          THEN '3_4yo'
             WHEN 'universal'         THEN '3_4yo'
             ELSE CASE
               WHEN age(make_date($2::int, $3::int, 1), c.date_of_birth) < interval '2 years' THEN 'under_2'
               WHEN age(make_date($2::int, $3::int, 1), c.date_of_birth) < interval '3 years' THEN '2yo'
               ELSE '3_4yo' END END
         ORDER BY id LIMIT 1) fi ON true
      ${PO.priceOverrideLateralSql()}
     WHERE c.status = 'active' AND COALESCE(c.is_demo, false) = false`;

// 2026-10-29 — a legacy run's fee band follows the same rule as the itemised engine
// (computeItemisedForChild, 2026-10-01): the child's age on the 1st of the billing month
// under the week-after-the-birthday rule (IB.ageBandOn), then the room floor
// (settings.room_min_fee_band, Toby: "pre-school fees 97 not 105"). The SQL above still
// picks a band from the funding record (the 2026-09-24 rule); this replaces it, for the
// childcare line and the catalogue rate the funding deduction is priced at. A price
// override still wins for the childcare line. Found when November billed children 90 and
// 93 (two, in Pre-school) the under-2 £105 a day and child 94 (now three) the 2-year £97.
async function applyFeeBandRule(db, children, year, month) {
  const IBX = require('../services/itemised-billing');
  const monthStartIso = `${year}-${String(month).padStart(2, '0')}-01`;
  const [{ rows: fees }, { rows: rf }] = await Promise.all([
    db.query(`SELECT DISTINCT ON (age_band) age_band, price_pence FROM fee_items
               WHERE unit = 'day' AND price_pence IS NOT NULL AND active ORDER BY age_band, id`),
    db.query(`SELECT value FROM settings WHERE key = 'room_min_fee_band'`),
  ]);
  const dayRate = Object.fromEntries(fees.map(f => [f.age_band, Number(f.price_pence)]));
  let floors = {};
  try { floors = rf.length ? (JSON.parse(rf[0].value || '{}') || {}) : {}; } catch (_) { floors = {}; }
  const ORDER = ['under_2', '2yo', '3_4yo'];
  for (const c of children) {
    let band = c.date_of_birth ? IBX.ageBandOn(c.date_of_birth, monthStartIso) : null;
    if (!band) continue; // no date of birth: keep the funding-record band the SQL chose
    const floor = floors[String(c.booking_room_id || c.room_id)];
    if (floor && ORDER.indexOf(band) < ORDER.indexOf(floor)) band = floor;
    if (dayRate[band] == null) continue;
    c.fee_band = band;
    c.catalogue_day_rate_pence = dayRate[band];
    if (!c.price_override_id) c.day_rate_pence = dayRate[band];
  }
  return children;
}

// ── POST /api/finance/invoices/generate ──────────────────────────────────────
// Generate DfE-compliant invoices for a period.
// Body: { year, month, child_ids?, room_ids?, preview }
router.post('/generate', async (req, res) => {
  const db = getPool();
  const { year, month, child_ids, room_ids, preview = false } = req.body;

  if (!year || !month) return res.status(400).json({ error: 'year and month required' });

  try {
    // Fetch current funding term for LA rates
    const { rows: [term] } = await db.query(
      `SELECT * FROM funding_terms WHERE is_current = true ORDER BY start_date DESC LIMIT 1`
    );

    // All funding terms (date ranges) — used by 'term_actuals' billing to work out which
    // months contain funded term weeks.
    const { rows: allTerms } = await db.query(
      `SELECT id, start_date, end_date, holiday_dates FROM funding_terms ORDER BY start_date`
    );
    const currentTermId = term ? term.id : null;

    // 2026-09-17 — the consumables fee (EyLog formula) and who has opted out of it,
    // read once for the whole run. Rates are pounds a week for meal_charge_hours_basis hours.
    const { rows: mealRows } = await db.query(
      `SELECT key, value FROM settings WHERE key IN
        ('meal_charge_2yo_weekly_pence','meal_charge_3_4yo_weekly_pence','meal_charge_hours_basis','invoice_due_day','consumables_enabled')`);
    const ms = Object.fromEntries(mealRows.map(r => [r.key, r.value]));
    const meal = {
      rate2:  (parseFloat(ms.meal_charge_2yo_weekly_pence)   || 0) / 100,
      rate34: (parseFloat(ms.meal_charge_3_4yo_weekly_pence) || 0) / 100,
      basis:  parseFloat(ms.meal_charge_hours_basis) || 21.92,
      enabled: String(ms.consumables_enabled || '').toLowerCase() === 'true',
    };
    const dueDayOfMonth = parseInt(ms.invoice_due_day, 10) || 15;
    const { rows: ooRows } = await db.query(
      `SELECT o.child_id FROM child_fee_optouts o JOIN fee_items f ON f.id = o.fee_item_id
        WHERE o.opted_out = true AND o.status = 'approved'
          AND f.formula ILIKE '%weekly_funded_hours%'`);
    const consumablesOptOuts = new Set(ooRows.map(r => Number(r.child_id)));

    // Fetch children to generate for. LEFT JOIN the child's current-term funding allocation
    // for precise per-band hours + the per-child billing mode / stretch period.
    let childQuery = LEGACY_CHILD_SELECT;
    const qp = [currentTermId, year, month];   // $1 term, $2/$3 the billing month for the age band
    if (child_ids?.length) {
      qp.push(child_ids);
      childQuery += ` AND c.id = ANY($${qp.length}::int[])`;
    }
    if (room_ids?.length) {
      qp.push(room_ids);
      childQuery += ` AND r.id = ANY($${qp.length}::int[])`;
    }
    const { rows: children } = await db.query(childQuery, qp);
    await applyFeeBandRule(db, children, year, month);

    const monthLabel = new Date(year, month - 1, 1)
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    // The billing month as dates, for the discount date-overlap test.
    const periodFromIso = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
    const periodToIso   = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);

    const previews = [];
    const generated = [];

    for (const child of children) {
      // Skip if invoice already exists for this period
      // 2026-09-25 — a child who left before this month started, or has not started yet, is
      // not billed at all. Without this the equally-spread path charged a full twelfth of the
      // year to a child who left in September, because 52/12 does not look at the calendar.
      const monthFirst = `${year}-${String(month).padStart(2, '0')}-01`;
      const monthLast  = `${year}-${String(month).padStart(2, '0')}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;
      const leftOn  = isoDate(child.leave_date);
      const startOn = isoDate(child.start_date);
      if ((leftOn && leftOn < monthFirst) || (startOn && startOn > monthLast)) continue;

      // 2026-09-28 — a written-off invoice and its CREDIT NOTE both have to be ignored here.
      // Only written_off was excluded, so after crediting an invoice the credit note itself
      // blocked the replacement from being generated — you could cancel a bill but never
      // reissue it.
      const { rows: existing } = await db.query(
        `SELECT id FROM invoices
          WHERE child_id=$1 AND period_year=$2 AND period_month=$3
            AND status NOT IN ('written_off','credit_note')`,
        [child.id, year, month]
      );
      // 2026-09-25 — a real run still skips a child who already has an invoice for the period.
      // A PREVIEW shows them, flagged: the point of a preview is to see what the run would
      // produce, and silently dropping two thirds of the nursery made the preview look like
      // the generator was broken when it was only being careful.
      if (existing.length && !preview) continue;
      const alreadyInvoiced = existing.length > 0;

      // Approved, not-yet-applied account credits for this child's bill payer.
      const billEmail = (child.primary_contact_email || '').toLowerCase().trim();
      let credits = [];
      if (billEmail) {
        const { rows: crRows } = await db.query(
          `SELECT id, amount_pence, reason FROM parent_account_credits
           WHERE lower(parent_email)=$1 AND status='approved' AND applied_invoice_id IS NULL
           ORDER BY earned_at ASC`,
          [billEmail]
        );
        credits = crRows;
      }

      // b225 — discounts live for any part of this billing month. Overlap, not
      // containment: a discount granted on the 3rd applies to that month.
      const discounts = await DISC.applicableDiscounts(db, child.id, periodFromIso, periodToIso);
      const extras = await XS.extrasForInvoice(db, child.id, periodToIso);

      const { lineItems, fundingDeductionPence, chargeablePence, appliedCreditIds, discountLines, extraSessionIds } =
        buildDfeLineItems({ child, year, month, monthLabel, term, allTerms, credits, discounts,
                            meal, consumablesOptedOut: consumablesOptOuts.has(Number(child.id)), extras });

      const issued = new Date(year, month - 1, 1);
      const due    = new Date(year, month - 1, dueDayOfMonth);   // settings.invoice_due_day (the terms say the 1st)

      previews.push({
        child_id:   child.id,
        child_name: `${child.first_name} ${child.last_name}`,
        room:       child.booking_room_name || child.room_name || child.room,
        amount_pence:            chargeablePence,
        funding_deduction_pence: fundingDeductionPence,
        discount_pence:          discountLines.reduce((s, li) => s - li.amount_pence, 0),
        discount_lines:          discountLines,
        credit_applied_pence:    lineItems.filter(li => li.is_credit).reduce((s, li) => s - li.amount_pence, 0),
        line_items:  lineItems,
        issued_on:   issued.toISOString().split('T')[0],
        due_on:      due.toISOString().split('T')[0],
        email:       child.primary_contact_email,
        dfe_compliant: true,
        already_invoiced: alreadyInvoiced,
      });

      if (!preview) {
        const invNum = await nextInvoiceNumber(db, year);
        const { rows: [inv] } = await db.query(`
          INSERT INTO invoices (child_id, bill_payer_email, amount_pence, status,
                                issued_on, due_on, invoice_number, period_year, period_month,
                                period_label, room_id, funding_deduction_pence, line_items, updated_at)
          VALUES ($1,$2,$3,'sent',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,NOW())
          RETURNING id, invoice_number
        `, [
          child.id, child.primary_contact_email, chargeablePence,
          issued.toISOString().split('T')[0], due.toISOString().split('T')[0],
          invNum, year, month, monthLabel,
          child.room_id, fundingDeductionPence, JSON.stringify(lineItems),
        ]);
        // b225 — the audit trail for what was taken off, written against the
        // invoice it was taken off. Append-only.
        if (discountLines.length) await DISC.recordDiscountLines(db, inv.id, discountLines);
        await XS.markInvoiced(db, extraSessionIds, inv.id);
        // Mark applied credits against this new invoice.
        if (appliedCreditIds.length) {
          await db.query(
            `UPDATE parent_account_credits
             SET status='applied', applied_invoice_id=$1, updated_at=NOW()
             WHERE id = ANY($2::int[]) AND status='approved' AND applied_invoice_id IS NULL`,
            [inv.id, appliedCreditIds]
          );
        }
        generated.push({ ...previews.at(-1), id: inv.id, invoice_number: inv.invoice_number });
      }
    }

    if (!preview) {
      recordAudit({ req, action: 'bulk_create', entity_type: 'invoice',
        meta: { year, month, count: generated.length, dfe_compliant: true } });
    }

    res.json({
      preview,
      count:    preview ? previews.length : generated.length,
      invoices: preview ? previews : generated,
      skipped:  children.length - previews.length,
    });
  } catch (e) {
    console.error('[finance-invoices] generate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/invoices/send ──────────────────────────────────────────
// Bulk send invoices by email. Body: { invoice_ids: [] }
// POST /send — email a batch of invoices to their bill payers.
//
// 2026-09-28 — this used to set sent_at and sent_by and NOTHING ELSE. No email left the
// building. A manager pressing "send" marked the whole month as sent while every parent waited
// for a bill that was never coming, and the invoices were then locked as though they had gone.
// It now runs each one through the same path as the single-invoice send: PDF attached, bank
// details, family payment reference, TFC reference, resend guard. A parent notification is
// raised alongside so it appears in the app as well.
router.post('/send', async (req, res) => {
  const db = getPool();
  const { invoice_ids, resend, message } = req.body || {};
  if (!invoice_ids?.length) return res.status(400).json({ error: 'invoice_ids required' });

  const sent = [], failed = [];
  for (const id of invoice_ids) {
    const r = await emailOneInvoice(db, id, { resend, message, userId: req.user.id });
    if (r.ok) {
      sent.push({ id, to: r.sent_to, invoice_number: r.invoice_number });
      // 2026-10-06 — credit the family already holds goes onto the bill. invpdf-20261028: now
      // done inside emailOneInvoice, before the PDF is drawn.
      // In-app notification for the parent. Best-effort: a failure here must never make a
      // successfully emailed invoice look unsent.
      try {
        const { rows: [inv] } = await db.query(
          `SELECT i.child_id, i.amount_pence, i.period_label, i.due_on,
                  p.id AS access_id
             FROM invoices i
             LEFT JOIN parent_portal_access p ON p.child_id = i.child_id AND p.is_active
            WHERE i.id = $1`, [id]);
        if (inv?.access_id) {
          await db.query(
            `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link,
                                        related_table, related_id, priority)
             VALUES ('parent', $1, 'invoice', $2, $3, '/invoices', 'invoices', $4, 'normal')`,
            // 2026-10-06: a parent's bell is read by CHILD id (notifications.js recipientClause —
            // parent JWTs carry the child), not by parent_portal_access.id. Keying it by the
            // access id put 6 of the 28 Sep invoice bells on another child's id and 30 nowhere.
            [inv.child_id,
             `Your ${inv.period_label || 'latest'} invoice`,
             // invpdf-20261028 — what there is to PAY (account balance), not the bill's face value.
             (r.due_pence === 0
               ? `Nothing to pay${r.credit_pence ? ` — £${(r.credit_pence / 100).toFixed(2)} credit left on your account` : ''}.`
               : `£${(((r.due_pence != null ? r.due_pence : inv.amount_pence) || 0) / 100).toFixed(2)} to pay${inv.due_on ? ', due ' + new Date(inv.due_on).toLocaleDateString('en-GB') : ''}.`)
             + ` It is in the app under Invoices, and a copy is in your email.`,
             id]);
        }
      } catch (e) { console.error('[finance-invoices] parent notification failed for', id, e.message); }
    } else {
      failed.push({ id, code: r.code, error: r.error });
    }
  }

  recordAudit({ req, action: 'bulk_send', entity_type: 'invoice',
    meta: { requested: invoice_ids.length, sent: sent.length, failed: failed.length } });

  res.json({ ok: failed.length === 0, sent: sent.length, failed: failed.length, sent_detail: sent, failures: failed });
});

// ── PUT /api/finance/invoices/:id ─────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const db = getPool();
  const { status, notes, due_on, amount_pence, payment_method } = req.body;
  try {
    const { rows: [old] } = await db.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!old) return res.status(404).json({ error: 'Not found' });

    // b216 — an invoice a family has already been sent is immutable. Its status
    // still moves (paid, overdue, written off) and notes can still be added,
    // but the MONEY on it cannot change: the parent is holding a PDF that says
    // otherwise. Corrections go on a credit note — POST /:id/credit-note.
    if (amount_pence !== undefined && (old.sent_at || old.locked_at) &&
        parseInt(amount_pence, 10) !== old.amount_pence) {
      return res.status(409).json({
        error: 'This invoice has been sent, so its amount cannot be changed. Raise a credit note instead.',
        code: 'invoice_locked',
        sent_at: old.sent_at, credit_note_endpoint: `/api/finance/invoices/${old.id}/credit-note`,
      });
    }

    const updates = [];
    const vals    = [];
    const set = (col, val) => { vals.push(val); updates.push(`${col}=$${vals.length}`); };

    if (status        !== undefined) set('status',         status);
    if (notes         !== undefined) set('notes',          notes);
    if (due_on        !== undefined) set('due_on',         due_on);
    if (amount_pence  !== undefined) set('amount_pence',   parseInt(amount_pence));
    if (payment_method !== undefined) set('payment_method', payment_method);
    updates.push('updated_at=NOW()');

    if (!updates.length) return res.json({ ok: true });

    vals.push(req.params.id);
    await db.query(`UPDATE invoices SET ${updates.join(',')} WHERE id=$${vals.length}`, vals);

    recordAudit({ req, action: 'update', entity_type: 'invoice', entity_id: parseInt(req.params.id),
      diff: { old: { status: old.status }, new: { status } } });

    // Payment notifications
    if (status === 'paid' && old.status !== 'paid') {
      const amt = old.amount_pence ? `£${(old.amount_pence / 100).toFixed(2)}` : '';
      notify('payment_received', 'all-managers', null,
        `Invoice paid: ${old.invoice_number || '#' + old.id}`,
        `${amt} received${old.bill_payer_email ? ' from ' + old.bill_payer_email : ''}.`,
        { relatedTable: 'invoices', relatedId: parseInt(req.params.id) }
      );
    }
    if (status === 'overdue' && old.status !== 'overdue') {
      const amt = old.amount_pence ? `£${(old.amount_pence / 100).toFixed(2)}` : '';
      notify('payment_overdue', 'all-managers', null,
        `Invoice overdue: ${old.invoice_number || '#' + old.id}`,
        `${amt} due${old.due_on ? ' on ' + new Date(old.due_on).toLocaleDateString('en-GB') : ''}.`,
        { relatedTable: 'invoices', relatedId: parseInt(req.params.id) }
      );
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/invoices/:id/write-off ──────────────────────────────────
router.post('/:id/write-off', async (req, res) => {
  const db = getPool();
  try {
    const { notes } = req.body;
    await db.query(
      `UPDATE invoices SET status='written_off', notes=COALESCE($1, notes), updated_at=NOW() WHERE id=$2`,
      [notes, req.params.id]
    );
    recordAudit({ req, action: 'write_off', entity_type: 'invoice', entity_id: parseInt(req.params.id),
      meta: { notes } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/invoices/:id/credit-note ────────────────────────────────
// 2026-09-28 — a credit note belongs to the PERIOD OF THE INVOICE IT CREDITS, not the month
// it happens to be raised in. Crediting an October invoice on 28 September filed the credit
// under September, so October's total still showed the money as owed and the two never met.
//
// b397 (2026-10-05) — pulled out of the route below so the new Payments tab's "Add credit
// note" (src/routes/finance-payments.js) can raise one against a named invoice without a
// second copy of this SQL. Behaviour is unchanged.
async function createCreditNote(db, invoiceId, amountPence, notes) {
  let { rows: [orig] } = await db.query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
  if (!orig) { const e = new Error('Invoice not found'); e.code = 'not_found'; throw e; }
  const asked = orig;
  const creditAmount = Math.abs(parseInt(amountPence, 10) || orig.amount_pence);
  const now = new Date();
  const { outstandingSql } = require('../lib/invoice-outstanding');

  // 2026-10-09 (child 183: a £299 September discount credited against the EyLog September
  // bill, while the family's EyLog balance sat on BF-183) — two rules so the bills and the
  // family balance always agree:
  //  1. For a child whose EyLog balance came across as an opening balance, EyLog-era bills are
  //     HISTORY (src/lib/family-ledger.js) — their effect is inside the opening balance. A
  //     credit against one goes onto the opening-balance bill (BF-<child>) if that is still owed;
  //     otherwise the whole credit is held on account.
  //  2. Only what is still owed on the bill is credited against it. Anything beyond that is
  //     held on account (a 'credit-note-excess' credit) and taken off the next bill when it is
  //     sent (applyUnallocatedCredit) — never left as a negative bill nobody's next bill sees.
  const eylogEra = orig.status === 'brought_forward' || (orig.source || '') === 'eylog-import-b205' || !!orig.eylog_ref;
  let target = orig;
  if (eylogEra) {
    const { rows: [bf] } = await db.query(
      `SELECT i.* FROM opening_balances o JOIN invoices i ON i.id = o.invoice_id WHERE o.child_id = $1`, [orig.child_id]).catch(() => ({ rows: [] }));
    const { rows: [ob] } = await db.query(`SELECT 1 FROM opening_balances WHERE child_id = $1`, [orig.child_id]).catch(() => ({ rows: [] }));
    if (bf) target = bf; else if (ob) target = null;   // opening balance was a credit (or zero): all on account
  }
  let owed = 0;
  if (target) {
    const { rows: [o] } = await db.query(`SELECT ${outstandingSql('i')} AS owed FROM invoices i WHERE i.id = $1`, [target.id]);
    owed = Math.max(0, Number(o && o.owed) || 0);
  }
  const onBill = target ? Math.min(creditAmount, owed) : 0;
  const excess = creditAmount - onBill;
  const label = notes || `Credit note for ${asked.invoice_number || asked.id}`;

  let credit = null;
  if (onBill > 0 || (target && excess === 0)) {
    const invNum = await nextInvoiceNumber(db, now.getFullYear());
    ({ rows: [credit] } = await db.query(`
      INSERT INTO invoices (child_id, bill_payer_email, amount_pence, status,
                            issued_on, period_year, period_month, period_label, invoice_number,
                            credit_note_for_id, notes, line_items, updated_at)
      VALUES ($1,$2,$3,'credit_note',CURRENT_DATE,$4,$5,
              to_char(make_date($4,$5,1),'FMMonth YYYY'),$6,$7,$8,
              '[{"label":"Credit note","amount_pence":-1}]'::jsonb, NOW())
      RETURNING id, invoice_number
    `, [asked.child_id, asked.bill_payer_email, -(onBill || creditAmount),
        asked.period_year || now.getFullYear(), asked.period_month || (now.getMonth() + 1), invNum, target.id, label]));
    if (onBill >= owed && owed > 0) {
      await db.query(`UPDATE invoices SET status = 'paid', paid_on = COALESCE(paid_on, CURRENT_DATE), updated_at = NOW()
                       WHERE id = $1 AND status IN ('sent', 'overdue')`, [target.id]);
    }
  }
  let onAccount = null;
  if (excess > 0) {
    ({ rows: [onAccount] } = await db.query(`
      INSERT INTO payments (child_id, bill_payer_email, amount_pence, currency, payment_method, status,
                            description, paid_on, source, created_at, updated_at)
      VALUES ($1, $2, $3, 'gbp', 'credit', 'succeeded', $4, CURRENT_DATE, 'credit-note-excess', NOW(), NOW())
      RETURNING id`,
      [asked.child_id, asked.bill_payer_email, excess,
       `Credit on account — ${label}${credit ? ' (the rest of ' + credit.invoice_number + ')' : ''}`]));
  }
  return { id: credit ? credit.id : null, invoice_number: credit ? credit.invoice_number : null,
           credited_on_bill_pence: onBill, on_account_pence: excess, on_account_payment_id: onAccount ? onAccount.id : null,
           credited_invoice_id: target ? target.id : null, redirected_from_eylog_bill: target !== orig || (eylogEra && !target) };
}

router.post('/:id/credit-note', async (req, res) => {
  const db = getPool();
  try {
    const { amount_pence, notes } = req.body;
    const credit = await createCreditNote(db, req.params.id, amount_pence, notes);

    recordAudit({ req, action: 'create', entity_type: 'invoice', entity_id: credit.id,
      meta: { type: 'credit_note', for_invoice: parseInt(req.params.id, 10) } });

    res.json({ ok: true, id: credit.id, invoice_number: credit.invoice_number });
  } catch (e) {
    res.status(e.code === 'not_found' ? 404 : 500).json({ error: e.message });
  }
});

// ── POST /api/finance/invoices/manual-payment ─────────────────────────────────
// Record a manual cash / bank-transfer payment against an invoice.
router.post('/manual-payment', async (req, res) => {
  const db = getPool();
  const { invoice_id, amount_pence, payment_method, reference, notes } = req.body;
  if (!invoice_id || !amount_pence) return res.status(400).json({ error: 'invoice_id and amount_pence required' });

  try {
    const { rows: [inv] } = await db.query('SELECT * FROM invoices WHERE id=$1', [invoice_id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const { rows: [pmt] } = await db.query(`
      INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence,
                            payment_method, status, description, cash_reference, manual_notes,
                            reconciliation_status, updated_at)
      VALUES ($1,$2,$3,$4,$5,'succeeded',$6,$7,$8,'reconciled',NOW())
      RETURNING id
    `, [invoice_id, inv.child_id, inv.bill_payer_email, parseInt(amount_pence),
        payment_method || 'manual',
        `Manual payment — ${payment_method || 'cash'} — ${inv.invoice_number || `INV #${invoice_id}`}`,
        reference, notes]);

    // Check if fully paid
    const { rows: [totals] } = await db.query(
      'SELECT COALESCE(SUM(amount_pence),0) AS total_paid FROM payments WHERE invoice_id=$1 AND status=$2',
      [invoice_id, 'succeeded']
    );
    if (parseInt(totals.total_paid) >= parseInt(inv.amount_pence)) {
      await db.query(
        `UPDATE invoices SET status='paid', paid_on=CURRENT_DATE, payment_method=$1, updated_at=NOW() WHERE id=$2`,
        [payment_method || 'manual', invoice_id]
      );
    }

    recordAudit({ req, action: 'create', entity_type: 'payment', entity_id: pmt.id,
      meta: { type: 'manual', invoice_id, method: payment_method } });

    res.json({ ok: true, payment_id: pmt.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/invoices/:id/applicable-credits ──────────────────────────
// Approved, not-yet-applied account credits matching this invoice's bill payer.
router.get('/:id/applicable-credits', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [inv] } = await db.query(
      'SELECT id, bill_payer_email FROM invoices WHERE id=$1', [req.params.id]
    );
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const email = (inv.bill_payer_email || '').toLowerCase().trim();
    if (!email) return res.json({ credits: [] });
    const { rows } = await db.query(
      `SELECT id, amount_pence, reason, earned_at, child_name
       FROM parent_account_credits
       WHERE lower(parent_email)=$1 AND status='approved' AND applied_invoice_id IS NULL
       ORDER BY earned_at ASC`,
      [email]
    );
    res.json({ credits: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/invoices/:id/apply-credit ───────────────────────────────
// Apply an approved account credit to an existing invoice: reduces amount_pence
// (never below 0), appends a negative credit line item, and marks the credit applied.
// Body: { credit_id }
router.post('/:id/apply-credit', async (req, res) => {
  const db = getPool();
  const { credit_id } = req.body;
  if (!credit_id) return res.status(400).json({ error: 'credit_id required' });
  try {
    const { rows: [inv] } = await db.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.status === 'paid' || inv.status === 'written_off') {
      return res.status(409).json({ error: `Cannot apply credit to a ${inv.status} invoice` });
    }

    const { rows: [cr] } = await db.query(
      `SELECT * FROM parent_account_credits
       WHERE id=$1 AND status='approved' AND applied_invoice_id IS NULL`,
      [credit_id]
    );
    if (!cr) return res.status(409).json({ error: 'Credit not found, not approved, or already applied' });

    // Guard: credit's parent must match this invoice's bill payer.
    if ((cr.parent_email || '').toLowerCase().trim() !== (inv.bill_payer_email || '').toLowerCase().trim()) {
      return res.status(403).json({ error: 'Credit belongs to a different bill payer' });
    }

    const applyPence = Math.min(parseInt(cr.amount_pence) || 0, parseInt(inv.amount_pence) || 0);
    const newAmount  = Math.max(0, parseInt(inv.amount_pence) - applyPence);

    const lineItems = Array.isArray(inv.line_items) ? inv.line_items : [];
    lineItems.push({
      label:       cr.reason || 'Account credit',
      category:    'account_credit',
      is_funded:   false,
      is_credit:   true,
      credit_id:   cr.id,
      quantity:    1,
      unit_label:  'credit',
      unit_pence:  -applyPence,
      amount_pence: -applyPence,
    });

    await db.query(
      `UPDATE invoices SET amount_pence=$1, line_items=$2::jsonb, updated_at=NOW() WHERE id=$3`,
      [newAmount, JSON.stringify(lineItems), inv.id]
    );
    await db.query(
      `UPDATE parent_account_credits
       SET status='applied', applied_invoice_id=$1, updated_at=NOW()
       WHERE id=$2 AND status='approved' AND applied_invoice_id IS NULL`,
      [inv.id, cr.id]
    );

    recordAudit({ req, action: 'apply_credit', entity_type: 'invoice', entity_id: inv.id,
      meta: { credit_id: cr.id, applied_pence: applyPence, new_amount_pence: newAmount } });

    res.json({ ok: true, applied_pence: applyPence, new_amount_pence: newAmount });
  } catch (e) {
    console.error('[finance-invoices] apply-credit error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// b114 — ITEMISED invoice generator (statutory itemisation, Jan 2026).
// Adds the fee_items-driven itemised layer INTO this existing machinery: same
// ladn.invoices table, same line_items JSONB (now carrying fee_item_id +
// statutory_category + funded_hours_at_zero), same nextInvoiceNumber sequence.
// Funded hours are emitted as £0 lines; consumables come from fee_items minus
// approved opt-outs. buildItemisedLines() is shared with the calculator so the
// numbers can never drift.
// Body: { year, month, child_ids?, room_ids?, weeks?, preview }
// ════════════════════════════════════════════════════════════════════════════
const IB = require('../services/itemised-billing');

// pg returns DATE columns as JS Date objects — String(dateObj) gives
// Date.prototype.toString() ("Tue Jan 06 2026...", NOT ISO), so .slice(0,10)
// against a 'YYYY-MM-DD' string always mismatches. Only routes that JSON-serialize
// the Date first (JSON.stringify calls .toJSON()→ISO) are safe with plain String().
const dateOnlyISO = d => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

// Funded/private day split from a child's active bookings for a given date.
function daySplitFromBookings(bookings, iso) {
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
  const active = bookings.filter(b =>
    (!b.start_date || dateOnlyISO(b.start_date) <= iso) &&
    (!b.end_date   || dateOnlyISO(b.end_date) >= iso));
  let funded = 0, priv = 0;
  for (const d of DAYS) {
    const isFunded  = active.some(b => b[d] && b.funded === true);
    const isPrivate = active.some(b => b[d] && b.funded === false);
    if (isFunded) funded++; else if (isPrivate) priv++;
  }
  return { fundedDays: funded, privateDays: priv, daysPerWeek: funded + priv };
}

// b216 — everything a generation run needs that is the SAME for every child.
//
// Pulled out of POST /generate-itemised so that regenerating one draft goes
// through exactly the same code as generating the whole month. Two paths that
// both "recalculate the invoice" would drift apart within a term, and the one
// that drifted would be the one a parent is looking at.
async function loadItemisedContext(db, { year, month, weeks } = {}) {
  const { rows: [term] } = await db.query(
    `SELECT * FROM funding_terms WHERE is_current=true ORDER BY start_date DESC LIMIT 1`);
  const { rows: feeItems } = await db.query(`SELECT * FROM fee_items ORDER BY id`);
  // The numbers Toby reviews each April (meal rates, the averaging factor,
  // closure days) are settings, not constants. Read once per run.
  const { rows: setRows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN
      ('invoice_calculation_factor','meal_charge_2yo_weekly_pence','meal_charge_hours_basis',
       'meal_charge_3_4yo_weekly_pence','nursery_closure_dates','invoice_due_day',
       'invoice_reconcile_on_final')`);
  const setting = Object.fromEntries(setRows.map(r => [r.key, r.value]));
  const averaging = IB.parseAveragingRule(setting.invoice_calculation_factor);
  const formulaVars = IB.mealFormulaVars(setting);
  let closureDates = [];
  try { const c = JSON.parse(setting.nursery_closure_dates || '[]'); if (Array.isArray(c)) closureDates = c; }
  catch (_) { closureDates = []; }   // a malformed setting must not invent closures
  const { rows: rateRows } = await db.query(
    `SELECT age_band, pence_per_hour FROM funding_rates ORDER BY updated_at DESC`);
  const ratesMap = {};
  for (const r of rateRows) if (!(r.age_band in ratesMap)) ratesMap[r.age_band] = Number(r.pence_per_hour);

  return {
    term, feeItems, setting, averaging, formulaVars, closureDates,
    currentTermId: term ? term.id : null,
    dueDay: parseInt(setting.invoice_due_day, 10) || 15,
    reconcileOnFinal: String(setting.invoice_reconcile_on_final || 'true') !== 'false',
    rateForBand: b => (b === '3_4yo' ? (ratesMap['3yo'] || ratesMap['3_4yo'] || 0) : (ratesMap[b] || 0)),
    year, month,
    monthLabel: new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    onDateIso: new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10),
    billWeeks: Number(weeks) || (averaging.weeks / averaging.months),
  };
}

// One child, one month — the whole calculation, returned but never written.
// The caller decides whether it becomes a preview, a new invoice or a
// regenerated draft.
async function computeItemisedForChild(db, ctx, child) {
  const { year, month, feeItems, averaging, formulaVars, closureDates,
          monthLabel, onDateIso, billWeeks, dueDay, reconcileOnFinal, rateForBand } = ctx;

  const weeklyFundedHours = Number(child.total_hours_week
    || ((Number(child.universal_hours_week) || 0) + (Number(child.extended_hours_week) || 0)) || 0);

  const { rows: bookings } = await db.query(
    `SELECT mon,tue,wed,thu,fri,funded,start_date,end_date,room_id,is_active FROM child_bookings
     WHERE child_id=$1 AND is_active=true`, [child.id]);
  const splitOnFirst = daySplitFromBookings(bookings, onDateIso);

  const { rows: ooRows } = await db.query(
    `SELECT fee_item_id FROM child_fee_optouts WHERE child_id=$1 AND opted_out=true AND status='approved'`,
    [child.id]);
  const optedOut = ooRows.map(r => Number(r.fee_item_id));

  // Which basis this month gets, and why.
  //
  // The default is the 52/12 average: same amount every month. It is replaced by
  // the sessions actually delivered when the average would misstate the month —
  // the child started or left part-way through it, or the booking pattern gave
  // them more (or fewer) sessions than an averaged month holds. This supersedes
  // the earlier day-count proration, which handled leavers only and did it on
  // calendar days rather than on sessions.
  const basis = IB.monthBillingBasis({
    bookings, year, month,
    startDate: child.start_date, leaveDate: child.leave_date,
    closureDates, weeks: averaging.weeks, months: averaging.months,
  });
  const onSessions = basis.kind === 'actual_sessions';

  // The weekly pattern, read on the 1st of the month — except when the child's
  // booking does not start until part-way through it, where the 1st reports
  // "no days" and would zero the whole invoice. monthBillingBasis() finds the
  // first date the pattern IS live, so fall back to that.
  const split = splitOnFirst.daysPerWeek > 0 ? splitOnFirst : {
    daysPerWeek: basis.pattern_days_per_week,
    fundedDays: basis.pattern_funded_days,
    privateDays: basis.pattern_private_days,
  };

  // 2026-10-01 — the band is the child's age band on the 1st of THIS month under the
  // week-after-the-birthday rule (IB.ageBandOn), not their age on 1 September held for the
  // whole year. A month containing the change is priced at both bands and split by booked
  // sessions either side of the Monday after the birthday (IB.splitByBandChange).
  const monthStartIso = `${year}-${String(month).padStart(2, '0')}-01`;
  if (child.date_of_birth) child.age_band = IB.ageBandOn(child.date_of_birth, monthStartIso) || child.age_band;
  // 2026-10-01 — a room can set the youngest rate it bills at (settings.room_min_fee_band,
  // e.g. {"2":"2yo"}): Toby, "even though they are under two they started straight in the
  // pre-school, so … pre-school fees 97 not 105". A child under 2 in Pre-school pays the
  // Pre-school (2-year-old) rate; an older child is never moved to a dearer band by this.
  const BAND_ORDER = ['under_2', '2yo', '3_4yo'];
  let roomFloor = null;
  try {
    const { rows: rf } = await db.query(`SELECT value FROM settings WHERE key = 'room_min_fee_band'`);
    roomFloor = rf.length ? (JSON.parse(rf[0].value || '{}') || {})[String(child.room_id)] || null : null;
  } catch (_) { roomFloor = null; }
  const floorBand = b => (roomFloor && BAND_ORDER.indexOf(b) > -1 && BAND_ORDER.indexOf(b) < BAND_ORDER.indexOf(roomFloor)) ? roomFloor : b;
  child.age_band = floorBand(child.age_band);
  // b490 — same per-child, per-period price override the legacy generator's SQL reads
  // (src/lib/price-overrides.js), so /regenerate and /generate-itemised cannot show a
  // different day rate than a fresh bulk run for the same child/month.
  const dayRateOverride = await PO.activeDayRateOverride(db, child.id, year, month);
  const priceAt = band => IB.buildItemisedLines({
    ageBand: band, weeklyFundedHours,
    daysPerWeek: split.daysPerWeek, fundedDaysPerWeek: split.fundedDays, privateDaysPerWeek: split.privateDays,
    weeks: billWeeks, feeItems, fundingRatePence: rateForBand(band),
    optedOutItemIds: optedOut, periodLabel: monthLabel, onDateIso,
    sessionBasis: onSessions ? basis : null,
    formulaVars, dayRateOverride,
  });
  let result = priceAt(child.age_band);
  const bandChangeRaw = child.date_of_birth ? IB.bandChangeInMonth(child.date_of_birth, year, month) : null;
  const bandChange = bandChangeRaw ? { ...bandChangeRaw, before: floorBand(bandChangeRaw.before), after: floorBand(bandChangeRaw.after) } : null;
  if (bandChange && bandChange.after && bandChange.after !== bandChange.before) {
    const dayBefore = new Date(bandChange.effective_iso + 'T00:00:00Z');
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const leaveIso = IB.toIso(child.leave_date), startIso = IB.toIso(child.start_date);
    const beforeTo = dayBefore.toISOString().slice(0, 10);
    const sBefore = IB.sessionDaysInMonth(bookings, year, month, { closureDates,
      notBefore: startIso, notAfter: leaveIso && leaveIso < beforeTo ? leaveIso : beforeTo }).total_sessions;
    const sAfter = IB.sessionDaysInMonth(bookings, year, month, { closureDates,
      notBefore: startIso && startIso > bandChange.effective_iso ? startIso : bandChange.effective_iso,
      notAfter: leaveIso }).total_sessions;
    result = IB.splitByBandChange(result, priceAt(bandChange.after), bandChange, sBefore, sAfter);
  }

  // The FINAL invoice squares the year: averaging over-bills some months and
  // under-bills others on purpose, and the way out is the last chance to put
  // that right. Added as its own line so the family sees the correction rather
  // than a total that moved for no stated reason.
  let reconcileLine = null;
  if (reconcileOnFinal && child.leave_date) {
    const leaveIso = dateOnlyISO(child.leave_date);
    if (leaveIso >= basis.month_start && leaveIso <= basis.month_end) {
      reconcileLine = await buildFinalReconciliation(db, {
        child, year, month, bookings, closureDates, averaging, feeItems, basis,
      });
      if (reconcileLine) {
        result.lines.push(reconcileLine);
        result.total_pence += reconcileLine.amount_pence;
        const cat = reconcileLine.statutory_category;
        if (result.groups[cat]) {
          result.groups[cat].lines.push(reconcileLine);
          result.groups[cat].subtotal_pence += reconcileLine.amount_pence;
        }
      }
    }
  }

  // ── b225: discounts ────────────────────────────────────────────────────────
  // Last, so the base is every charge this month actually carries — including a
  // leaver's final reconciliation line. On this engine funded hours are already
  // £0 lines, so a 'fees_only' discount can only ever reach the paid-hours side
  // of the invoice; there is no funded money here for it to touch.
  const discounts = await DISC.applicableDiscounts(db, child.id, basis.month_start, basis.month_end);
  const discountLines = [];
  if (discounts.length) {
    const built = DISC.buildDiscountLines({
      lineItems: result.lines, discounts, periodLabel: monthLabel,
    });
    for (const dl of built.lines) {
      result.lines.push(dl);
      result.total_pence += dl.amount_pence;      // negative
      discountLines.push(dl);
    }
    if (discountLines.length) {
      // Its own group, appended after the five statutory ones. A discount is not
      // a thing being charged for, so putting it inside a statutory category
      // would corrupt that category's subtotal — but leaving it out of `groups`
      // entirely drops it off the invoice-run preview, which renders groups.
      result.groups[DISC.DISCOUNT_CATEGORY] = {
        key: DISC.DISCOUNT_CATEGORY,
        label: 'Discounts',
        lines: discountLines,
        subtotal_pence: discountLines.reduce((sum, l) => sum + l.amount_pence, 0),
      };
    }
  }

  const issued = new Date(year, month - 1, 1), due = new Date(year, month - 1, dueDay);
  return {
    child_id: child.id, child_name: `${child.first_name} ${child.last_name}`,
    age_band: child.age_band, weekly_funded_hours: weeklyFundedHours,
    days_per_week: split.daysPerWeek, funded_days: split.fundedDays, private_days: split.privateDays,
    amount_pence: result.total_pence, line_items: result.lines, groups: result.groups,
    discount_lines: discountLines,
    discount_pence: discountLines.reduce((sum, l) => sum - l.amount_pence, 0),
    funded_hours_delivered: result.funded_hours_delivered,
    // b299 — catalogue rows that were NOT charged and why (a formula scaled by
    // funded hours is refused). Carried out to the run preview so a suppressed
    // charge is visible rather than a silently smaller total.
    suppressed_items: result.suppressed || [],
    per_funded_hour_equivalent_label: result.per_funded_hour_equivalent_label,
    issued_on: issued.toISOString().slice(0, 10), due_on: due.toISOString().slice(0, 10),
    email: child.primary_contact_email, dfe_compliant: true, itemised: true,
    prorated_leaver: basis.partial_month, leave_date: child.leave_date || null,
    billing_basis: reconcileLine ? 'final_reconciliation' : result.billing_basis,
    basis_detail: { ...result.basis_detail, averaging,
                    reconciliation: reconcileLine ? reconcileLine.rule : null },
    basis_reason: basis.reason,
  };
}

// The child row shape computeItemisedForChild expects, for ONE child. The age
// band is derived in SQL so no date of birth leaves the server.
const ITEMISED_CHILD_SELECT = `
  SELECT c.id, c.first_name, c.last_name, c.primary_contact_email, c.room_id, c.leave_date,
         c.start_date, c.date_of_birth,
         (CASE WHEN c.date_of_birth > DATE '${IB.AGE_BAND_REFERENCE}'::date - INTERVAL '2 years' THEN 'under_2'
               WHEN c.date_of_birth > DATE '${IB.AGE_BAND_REFERENCE}'::date - INTERVAL '3 years' THEN '2yo'
               ELSE '3_4yo' END) AS age_band,
         cf.universal_hours_week, cf.extended_hours_week, cf.total_hours_week
    FROM children c
    LEFT JOIN child_funding cf ON cf.child_id = c.id AND cf.term_id = $2
   WHERE c.id = $1`;

// b216 — the leaving invoice's year-end line.
//
// Averaging bills the same amount every month, which means most months are
// slightly wrong on purpose. The final invoice is the last chance to make them
// right in aggregate, so this compares what the averaged months CHARGED for
// against what was actually delivered over the same window.
//
// Deliberately narrow: only invoices Wren itself averaged (billing_basis =
// 'monthly_average') count. An invoice imported from EyLog carries no record of
// the sessions it was built from, so including it would mean reconciling against
// a number nobody can check. A child whose whole history is imported therefore
// gets no adjustment line at all, which is the honest outcome — not a £0 one.
//
// Returns a line item, or null when there is nothing to correct.
async function buildFinalReconciliation(db, { child, year, month, bookings, closureDates,
                                              averaging, feeItems, basis }) {
  // Window: the twelve months ending with the month before the final one, cut
  // short at the child's start date when they were here for less than a year.
  const endY = month === 1 ? year - 1 : year;
  const endM = month === 1 ? 12 : month - 1;
  let startY = endY, startM = endM - 11;
  while (startM < 1) { startM += 12; startY -= 1; }
  const startIso = child.start_date ? dateOnlyISO(child.start_date) : null;
  if (startIso) {
    const sY = parseInt(startIso.slice(0, 4), 10), sM = parseInt(startIso.slice(5, 7), 10);
    if (sY > startY || (sY === startY && sM > startM)) { startY = sY; startM = sM; }
  }

  const { rows: averaged } = await db.query(
    `SELECT period_year, period_month, line_items
       FROM invoices
      WHERE child_id = $1
        AND billing_basis = 'monthly_average'
        AND status <> 'written_off'
        AND (period_year * 12 + period_month) BETWEEN $2 AND $3
      ORDER BY period_year, period_month`,
    [child.id, startY * 12 + startM, endY * 12 + endM]);
  if (!averaged.length) return null;

  // Sessions CHARGED for on those invoices — the day-rate line's own quantity.
  // Funded sessions never reach a charge, so they are not part of the promise
  // that averaging evens out.
  const chargedOn = li => li && !li.is_funded && !li.is_credit
    && li.statutory_category === 'additional_paid_hours'
    && (li.unit_label === 'day' || li.unit_label === 'session');
  let billedSessions = 0;
  for (const inv of averaged) {
    const lines = Array.isArray(inv.line_items) ? inv.line_items : [];
    for (const li of lines) if (chargedOn(li)) billedSessions += Number(li.quantity) || 0;
  }

  // Sessions actually delivered across exactly those months.
  let deliveredSessions = 0;
  for (const inv of averaged) {
    const s = IB.sessionDaysInMonth(bookings, inv.period_year, inv.period_month,
      { closureDates, notBefore: child.start_date, notAfter: child.leave_date });
    deliveredSessions += s.private_sessions;
  }

  const dayRateItem = feeItems.find(it =>
    it.statutory_category === 'additional_paid_hours' && it.unit === 'day' &&
    it.optoutable === false && (!it.age_band || it.age_band === child.age_band) && it.active !== false);
  if (!dayRateItem || !dayRateItem.price_pence) return null;

  const first = averaged[0], last = averaged[averaged.length - 1];
  const label = m => new Date(m.period_year, m.period_month - 1, 1)
    .toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

  return IB.yearEndReconciliation({
    billedSessions, deliveredSessions,
    dayRatePence: Number(dayRateItem.price_pence),
    windowLabel: `${label(first)} – ${label(last)}`,
    windowFrom: `${first.period_year}-${String(first.period_month).padStart(2, '0')}-01`,
    windowTo: basis.month_start,
  });
}

// 2026-10-09 (Toby: "fix the itemised generator") — this route priced EVERY booked day at
// the private day rate, because the itemised engine only treats a day as funded when its
// child_bookings row says funded, and none do. Funded families came out ~£1,000 a month too
// high: its October preview was £58,431 against the £41,586 actually issued. It was also what
// Invoices & Payments → Generate called. One place, one version: it now runs the SAME
// generator as POST /generate — gross childcare less funded hours at our hourly rate
// (buildDfeLineItems, EyLog-verified, what raised October: preview £41,509 vs £41,586) — with
// this route's own default of preview:true kept. The old engine stays reachable at
// /generate-itemised-legacy for comparison only.
router.post('/generate-itemised', (req, res, next) => {
  req.body = Object.assign({}, req.body || {});
  if (req.body.preview === undefined) req.body.preview = true;
  req.url = '/generate';
  return router.handle(req, res, next);
});

router.post('/generate-itemised-legacy', async (req, res) => {
  const db = getPool();
  const { year, month, child_ids, room_ids, weeks, preview = true } = req.body || {};
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });
  if (child_ids != null && !Array.isArray(child_ids)) return res.status(400).json({ error: 'child_ids must be an array' });
  if (room_ids != null && !Array.isArray(room_ids)) return res.status(400).json({ error: 'room_ids must be an array' });
  try {
    const ctx = await loadItemisedContext(db, { year, month, weeks });
    const { currentTermId, monthLabel } = ctx;

    // Children + derived age band (band derived in SQL; no DOB leaves the server).
    let q = `
      SELECT c.id, c.first_name, c.last_name, c.primary_contact_email, c.room_id, c.leave_date,
             c.start_date, c.date_of_birth,
             (CASE WHEN c.date_of_birth > DATE '${IB.AGE_BAND_REFERENCE}'::date - INTERVAL '2 years' THEN 'under_2'
                   WHEN c.date_of_birth > DATE '${IB.AGE_BAND_REFERENCE}'::date - INTERVAL '3 years' THEN '2yo'
                   ELSE '3_4yo' END) AS age_band,
             cf.universal_hours_week, cf.extended_hours_week, cf.total_hours_week
      FROM children c
      LEFT JOIN child_funding cf ON cf.child_id=c.id AND cf.term_id=$1
      WHERE c.status='active' AND COALESCE(c.is_demo, false) = false`;
    const qp = [currentTermId];
    if (child_ids?.length) { qp.push(child_ids); q += ` AND c.id = ANY($${qp.length}::int[])`; }
    if (room_ids?.length)  { qp.push(room_ids);  q += ` AND c.room_id = ANY($${qp.length}::int[])`; }
    const { rows: children } = await db.query(q, qp);

    const previews = [], generated = [];
    for (const child of children) {
      const rec = await computeItemisedForChild(db, ctx, child);
      previews.push(rec);

      if (!preview) {
        // Skip if a non-written-off invoice already exists for this period.
        const { rows: existing } = await db.query(
          'SELECT id FROM invoices WHERE child_id=$1 AND period_year=$2 AND period_month=$3 AND status != $4',
          [child.id, year, month, 'written_off']);
        if (existing.length) { rec.skipped = 'exists'; continue; }
        const invNum = await nextInvoiceNumber(db, year);
        const fundingDeductionPence = 0; // funded hours are £0 lines, not a deduction off a gross fee
        const { rows: [inv] } = await db.query(`
          INSERT INTO invoices (child_id, bill_payer_email, amount_pence, status, issued_on, due_on,
                                invoice_number, period_year, period_month, period_label, room_id,
                                funding_deduction_pence, line_items, billing_basis, basis_detail, updated_at)
          VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14::jsonb,NOW())
          RETURNING id, invoice_number`,
          [child.id, child.primary_contact_email, rec.amount_pence,
           rec.issued_on, rec.due_on, invNum, year, month, monthLabel, child.room_id,
           fundingDeductionPence, JSON.stringify(rec.line_items),
           rec.billing_basis, JSON.stringify(rec.basis_detail)]);
        if (rec.discount_lines && rec.discount_lines.length) {
          await DISC.recordDiscountLines(db, inv.id, rec.discount_lines);
        }
        generated.push({ ...rec, id: inv.id, invoice_number: inv.invoice_number });
      }
    }
    if (!preview) recordAudit({ req, action: 'bulk_create', entity_type: 'invoice',
      meta: { year, month, count: generated.length, itemised: true } });

    res.json({ preview, itemised: true, count: preview ? previews.length : generated.length,
      invoices: preview ? previews : generated });
  } catch (e) {
    console.error('[finance-invoices] generate-itemised error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// ── GET /api/finance/invoices/:id/statement ──────────────────────────────────
// b202: the invoice as EyMan lays it out — line items with the funded hours as a £0.00
// row, a running account balance, and the sample-week working that explains where the
// monthly hours came from. Read-only and derived: it re-presents what the generator
// already stored, so the total here always equals invoices.amount_pence.
//
// Registered after GET /:id on purpose — Express matches '/:id' on a single path segment,
// so '/123/statement' never falls through to it.
const { buildStatement } = require('../lib/eyman-invoice-model');

// Age band -> the fee_items code holding that band's day rate (EyMan report 73 bands:
// under 2 / under 3 / under 5).
const DAY_RATE_CODE = { under_2: 'day_under2', '2yo': 'day_2yo', '3_4yo': 'day_3_4yo' };

function ageBandAt(dob, onDate) {
  if (!dob) return null;
  const b = new Date(dob), d = new Date(onDate);
  if (isNaN(b) || isNaN(d)) return null;
  let age = d.getFullYear() - b.getFullYear();
  const before = (d.getMonth() < b.getMonth())
              || (d.getMonth() === b.getMonth() && d.getDate() < b.getDate());
  if (before) age--;
  return age < 2 ? 'under_2' : (age < 3 ? '2yo' : '3_4yo');
}

// b216 — one loader, used by the statement JSON, the PDF and the emailer, so a
// parent's PDF cannot disagree with the screen the office is looking at.
// Returns null when the invoice does not exist.
// ── 2026-10-01: the invoice told as three steps — the week, the year, the month ──
// Toby: "show it as how it would be … then at the end do that monthly division by 12".
// Built from the invoice's OWN stored line items, so it always lands on the bill:
//   1. your child's normal week   — each line's weekly amount (funded hours shown as free)
//   2. over the year              — weekly × averaging weeks (52)
//   3. the same each month        — yearly ÷ averaging months (12) = this invoice
// Part months (actual sessions) and months where the rate changed are explained as the
// lines they are, without the ×52/÷12 story. EyLog-imported invoices get no breakdown:
// they keep the layout they were issued with.
function _weekdaysBooked(booking, year, month) {
  if (!booking || !year || !month) return null;
  const cols = [null, 'mon', 'tue', 'wed', 'thu', 'fri', null];
  let n = 0;
  const days = new Date(year, month, 0).getDate();
  for (let d = 1; d <= days; d++) { const c = cols[new Date(year, month - 1, d).getDay()]; if (c && booking[c]) n++; }
  return n;
}
function buildBreakdown(inv, rule, booking) {
  if (/^eylog|card-test/.test(String(inv.source || '')) || inv.status === 'credit_note') return null;
  const lines = Array.isArray(inv.line_items) ? inv.line_items.filter(l => l && (l.label || l.item)) : [];
  const total = Number(inv.amount_pence);
  if (!lines.length || !(total > 0)) return null;
  const w = Number(rule && rule.weeks) || 52, m = Number(rule && rule.months) || 12;
  const sessions = _weekdaysBooked(booking, inv.period_year, inv.period_month);
  const money = p => '£' + (Math.abs(p) / 100).toFixed(2);
  const r2 = n => Math.round(n * 100) / 100;
  const nice = n => (n % 1 ? n.toFixed(2) : String(n));
  const labelOf = l => String(l.label || l.item).replace(/\s+—\s+\d+(\.\d+)?\s+private day\(s\)\/wk$/, '');
  const unitOf = l => String(l.unit_label || '').toLowerCase();
  const isFunded = l => l.is_funded === true || /funded/.test(String(l.category || '')) || l.funded_hours_at_zero;
  const isDiscount = l => l.is_discount === true || /discount/.test(String(l.category || '')) || unitOf(l) === '%';
  const bandChange = inv.basis_detail && inv.basis_detail.band_change;
  const actual = inv.billing_basis === 'actual_sessions' || bandChange || lines.some(l => unitOf(l) === 'sessions');
  if (actual) {
    return { kind: 'lines', total_pence: total, sessions_this_month: sessions,
             lines: lines.map(l => ({ label: labelOf(l), amount_pence: Math.round(Number(l.amount_pence) || 0), free: isFunded(l) })),
             reason: bandChange
               ? `The rate changed part-way through the month (from ${bandChange.effective_iso}), so this month is worked out on the days either side of it.`
               : 'This month is worked out on the sessions booked in it, so it isn’t spread evenly over the year.' };
  }
  // Step 1 lines: the recurring week. Step 3 extras: anything charged once this month.
  const week = [], extras = [];
  for (const l of lines) {
    const amt = Math.round(Number(l.amount_pence) || 0), unit = Math.round(Number(l.unit_pence) || 0);
    const qty = Number(l.quantity) || 0, u = unitOf(l);
    if (isFunded(l)) {
      const hrs = u.startsWith('hour') ? r2(qty * m / w) : null;
      const term = hrs != null ? qty * m / 38 : null;
      const spread = term != null && Math.abs(term - Math.round(term)) < 0.05 && Math.round(term) > 0
        ? ` (${Math.round(term)} hrs × 38 weeks, spread over ${w})` : '';
      week.push({ kind: 'funded', label: 'Funded hours (free)',
        detail: hrs != null ? `${nice(hrs)} hrs a week${spread}` + (unit ? ` × ${money(unit)}` : '') : null,
        weekly_pence: Math.round(amt * m / w) });
    } else if (isDiscount(l)) {
      week.push({ kind: 'discount', label: labelOf(l), detail: u === '%' && qty ? `${nice(qty)}% off` : null,
                  weekly_pence: Math.round(amt * m / w) });
    } else if (u === 'days/week' || u === 'sessions/week') {
      week.push({ kind: 'fee', label: labelOf(l), detail: `${nice(qty)} day${qty === 1 ? '' : 's'} a week × ${money(unit)}`,
                  weekly_pence: Math.round(qty * unit) });
    } else if (u === 'day' || u === 'days') {
      const perWeek = r2(qty * m / w);
      const exact = Math.abs(perWeek * 2 - Math.round(perWeek * 2)) < 0.02;
      week.push({ kind: 'fee', label: labelOf(l), detail: `${nice(perWeek)} day${perWeek === 1 ? '' : 's'} a week × ${money(unit)}`,
                  weekly_pence: exact && unit ? Math.round(perWeek * unit) : Math.round(amt * m / w) });
    } else if (u === 'month' || u === 'week' || u === 'weeks') {
      week.push({ kind: /food|meal/.test(String(l.category || '')) ? 'food' : 'fee', label: labelOf(l), detail: null,
                  weekly_pence: Math.round(amt * m / w) });
    } else {
      extras.push({ label: labelOf(l), amount_pence: amt });
    }
  }
  const weekly = week.reduce((t, x) => t + x.weekly_pence, 0);
  const annual = weekly * w;
  const spread = Math.round(annual / m);
  const extrasTotal = extras.reduce((t, x) => t + x.amount_pence, 0);
  const rounding = total - spread - extrasTotal;
  // More than a few pence out means the lines aren't a plain weekly pattern: tell it as lines.
  if (!week.length || weekly <= 0 || Math.abs(rounding) > 50) {
    return { kind: 'lines', total_pence: total, sessions_this_month: sessions, reason: null,
             lines: lines.map(l => ({ label: labelOf(l), amount_pence: Math.round(Number(l.amount_pence) || 0), free: isFunded(l) })) };
  }
  // The FYI: how many booked days fall in each month this year, so the parent sees why a
  // month-by-month bill would jump about. Weekdays only; bank holidays still count (we charge them).
  let fewest = null, most = null;
  if (sessions != null) {
    const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    for (let mm = 1; mm <= 12; mm++) {
      const n = _weekdaysBooked(booking, inv.period_year, mm);
      if (!fewest || n < fewest.n) fewest = { month: MONTHS[mm - 1], n };
      if (!most || n > most.n) most = { month: MONTHS[mm - 1], n };
    }
  }
  return { kind: 'average', weeks: w, months: m, week, weekly_total_pence: weekly,
           annual_pence: annual, spread_pence: spread, extras, rounding_pence: rounding,
           monthly_pence: total, sessions_this_month: sessions, fewest, most };
}

async function loadStatement(db, invoiceId) {
    const { rows: [inv] } = await db.query(`
      SELECT i.*, c.eylog_ref, c.date_of_birth, c.room AS child_room,
             -- b325 — the family's payment reference, and this child's Tax-Free
             -- Childcare one. Preferring the value STAMPED on the invoice means a
             -- bill that has already gone out keeps quoting the reference the
             -- parent was actually given, even if the family is re-issued one.
             COALESCE(i.family_payment_ref, fpr.payment_ref) AS family_payment_ref,
             NULLIF(btrim(c.tfc_payment_reference), '')      AS tfc_payment_reference,
             c.first_name || ' ' || c.last_name AS child_name,
             COALESCE(NULLIF(c.parent_1_name,''), NULLIF(c.parent_2_name,'')) AS bill_payer_name,
             -- b299: EyLog addresses the bill to BOTH parents. Wren holds two
             -- names against one family address, so both names carry it.
             NULLIF(c.parent_1_name,'')  AS parent_1_name,
             NULLIF(c.parent_2_name,'')  AS parent_2_name,
             NULLIF(c.parent_1_email,'') AS parent_1_email,
             NULLIF(c.parent_2_email,'') AS parent_2_email,
             NULLIF(c.address_line1,'')  AS family_address,
             NULLIF(c.postcode,'')       AS family_postcode,
             r.name AS room_name
        FROM invoices i
        JOIN children c ON c.id = i.child_id
        LEFT JOIN rooms r ON r.id = i.room_id
        LEFT JOIN family_payment_refs fpr
               ON fpr.family_key = NULLIF(lower(btrim(c.primary_contact_email)), '')
              AND fpr.retired_at IS NULL
       WHERE i.id = $1`, [invoiceId]);
    if (!inv) return null;

    const periodStart = (inv.period_year && inv.period_month)
      ? new Date(Date.UTC(inv.period_year, inv.period_month - 1, 1))
      : (inv.issued_on ? new Date(inv.issued_on) : new Date());

    const [{ rows: bookings }, { rows: funding }, { rows: fees }, { rows: payments },
           { rows: prior }, { rows: settings }] = await Promise.all([
      db.query(`SELECT mon, tue, wed, thu, fri, room_id FROM child_bookings
                 WHERE child_id = $1 AND is_active
                   AND start_date <= $2 AND (end_date IS NULL OR end_date >= $2)
                 ORDER BY start_date DESC LIMIT 1`, [inv.child_id, periodStart]),
      db.query(`SELECT cf.universal_hours_week, cf.extended_hours_week, cf.stretched_funding
                  FROM child_funding cf
                  JOIN funding_terms t ON t.id = cf.term_id
                 WHERE cf.child_id = $1 AND $2::date BETWEEN t.start_date AND t.end_date
                 ORDER BY t.start_date DESC LIMIT 1`, [inv.child_id, periodStart]),
      db.query(`SELECT code, price_pence FROM fee_items
                 WHERE active AND price_pence IS NOT NULL AND effective_from <= $1
                   AND (effective_to IS NULL OR effective_to >= $1)`, [periodStart]),
      db.query(`SELECT id, amount_pence, status, payment_method, description, created_at
                  FROM payments WHERE invoice_id = $1 ORDER BY created_at`, [inv.id]),
      // Everything still owed on invoices raised BEFORE this one — EyMan's
      // "Account balance prior to <date>" line.
      // 2026-09-28 — `i.amount_pence > 0` is doing real work here. The EyLog import filed 104
      // payments-on-account and deposits into ladn.invoices as NEGATIVE invoices (-£47,682
      // across 40 children). Summing them as though they were invoices made 19 of the 33
      // October bills show a credit, one of them -£10,573. They are payments, not invoices;
      // the payments table is where a credit belongs, and an invoice is never negative.
      // 2026-09-29 — a 2026-09-28 change netted ALL unallocated payments off this balance to
      // surface child 191's £210. Reverted: legacy EyLog imports leave 263 payments (£208k)
      // unallocated and some over-allocated, so it printed false credits of up to £14,300 on 23
      // October statements. Credit on account needs its own reviewed source, not this sum.
      // 2026-10-06: by the one "still owed" rule (src/lib/invoice-outstanding.js), and never
      // drafts — a draft has not been sent, so nothing on it is overdue. EyLog-era bills are
      // 'brought_forward' since the cutover: their balance lives in the brought-forward row.
      // Unqualified on purpose: demo editions reach this route through their own search_path,
      // and the demo schemas have no payment_allocations — they fall back to linked payments.
      ((priorArgs) => db.query(`SELECT COALESCE(SUM(GREATEST(i.amount_pence
                     + COALESCE((SELECT SUM(cn.amount_pence) FROM invoices cn
                                  WHERE cn.credit_note_for_id = i.id AND cn.status = 'credit_note'), 0)
                     - COALESCE((SELECT SUM(a.amount_pence) FROM payment_allocations a WHERE a.invoice_id = i.id), 0)
                     - COALESCE((SELECT SUM(p.amount_pence) FROM payments p
                                  WHERE p.invoice_id = i.id AND p.status = 'succeeded'
                                    AND NOT EXISTS (SELECT 1 FROM payment_allocations a2 WHERE a2.payment_id = p.id)), 0),
                     0)), 0) AS balance_pence
                  FROM invoices i
                 WHERE i.child_id = $1 AND i.id <> $2
                   AND i.amount_pence > 0
                   AND i.status IN ('sent','overdue')
                   AND (i.issued_on IS NULL OR i.issued_on <= $3)`, priorArgs)
        .catch(() => db.query(`SELECT COALESCE(SUM(GREATEST(i.amount_pence
                     - COALESCE((SELECT SUM(p.amount_pence) FROM payments p
                                  WHERE p.invoice_id = i.id AND p.status = 'succeeded'), 0), 0)), 0) AS balance_pence
                  FROM invoices i
                 WHERE i.child_id = $1 AND i.id <> $2 AND i.amount_pence > 0
                   AND i.status IN ('sent','overdue')
                   AND (i.issued_on IS NULL OR i.issued_on <= $3)`, priorArgs)))([inv.child_id, inv.id, inv.issued_on || periodStart]),
      db.query(`SELECT key, value FROM settings
                 WHERE key IN ('invoice_calculation_factor','invoice_session_hours',
                               'invoice_session_start')`),
    ]);

    const setting = Object.fromEntries(settings.map(s => [s.key, s.value]));
    const band = ageBandAt(inv.date_of_birth, periodStart);
    const dayRate = band
      ? (fees.find(f => f.code === DAY_RATE_CODE[band]) || {}).price_pence || null
      : null;

    const booking = bookings[0]
      ? { ...bookings[0], session_hours: parseFloat(setting.invoice_session_hours) || 10 }
      : null;

    // b299 — the address block. One family address, both parents' names against
    // it, in EyLog's order. A parent with no name at all is dropped rather than
    // printed as an empty line.
    const addressLines = [inv.family_address, inv.family_postcode].filter(Boolean);
    const parents = [
      { name: inv.parent_1_name, email: inv.parent_1_email, address: addressLines },
      { name: inv.parent_2_name, email: inv.parent_2_email, address: addressLines },
    ].filter(p => p.name);

    const statement = buildStatement({
      invoice: inv,
      child: { id: inv.child_id, eylog_ref: inv.eylog_ref, room_name: inv.room_name || inv.child_room },
      booking,
      funding: funding[0] || null,
      dayRatePence: dayRate,
      payments,
      priorBalancePence: parseInt(prior[0]?.balance_pence, 10) || 0,
      factorSetting: setting.invoice_calculation_factor,
      sessionHours: parseFloat(setting.invoice_session_hours) || 10,
      sessionStart: setting.invoice_session_start || '08:00',
      parents,
    });

    // b216 — the averaging rule travels with the invoice so it can explain
    // itself long after the settings have moved on. Prefer what was stored at
    // generation time; fall back to today's setting for older rows.
    const stored = inv.basis_detail && inv.basis_detail.averaging;
    const rule = stored && stored.weeks
      ? { weeks: Number(stored.weeks), months: Number(stored.months) }
      : IB.parseAveragingRule(setting.invoice_calculation_factor);
    const averagingExplanation = inv.billing_basis === 'actual_sessions'
      ? `This month was billed on the sessions actually delivered rather than the yearly average`
        + `${inv.basis_detail && inv.basis_detail.reason ? ' — ' + inv.basis_detail.reason : ''}.`
      : `Fees are averaged over the year: your weekly fee x ${rule.weeks} weeks / ${rule.months} months, `
        + `so the amount is the same every month.`;

    // b225 — the audit trail alongside the derived statement. The line items are
    // what the invoice IS; these rows are the record of what was taken off and
    // what it was taken off, written at generation time.
    let discountRecords = [];
    try { discountRecords = await DISC.invoiceDiscountLines(db, inv.id); }
    catch (e) { console.error('[finance-invoices] discount records:', e.message); }

    // invpdf-20261028 — the latest bill's totals come from the child's account ledger:
    // balance before it (owed OR in credit), payments since, and one Total due that includes
    // arrears. See src/lib/invoice-account.js.
    await require('../lib/invoice-account').applyAccountTotals(db, statement, inv);

    return {
      ...statement,
      // b325 — what a parent needs in order to pay this bill in a way that finds
      // its own way back to their account. Carried on the statement so the screen,
      // the PDF and the email cannot disagree about it.
      family_payment_ref: inv.family_payment_ref || null,
      tfc_payment_reference: inv.tfc_payment_reference || null,
      discount_records: discountRecords,
      child_name: inv.child_name,
      bill_payer_name: inv.bill_payer_name || null,
      age_band: band,
      billing_basis: inv.billing_basis || null,
      basis_detail: inv.basis_detail || {},
      averaging_rule: rule,
      averaging_explanation: averagingExplanation,
      breakdown: buildBreakdown(inv, rule, booking),
      imported: !!inv.eylog_ref,
      locked: !!(inv.locked_at || inv.sent_at) || inv.status !== 'draft' || !!inv.eylog_ref,
      status: inv.status,
      sent_at: inv.sent_at || null,
    };
}

router.get('/:id/statement', async (req, res) => {
  const db = getPool();
  try {
    const statement = await loadStatement(db, req.params.id);
    if (!statement) return res.status(404).json({ error: 'Invoice not found' });
    res.json(statement);
  } catch (e) {
    console.error('[finance-invoices] statement error:', e.message);
    res.status(500).json({ error: e.message });
  }
});


// ═══ b216 — PDF, send, regenerate, edit ═══════════════════════════════════════
//
// The lifecycle these four routes enforce:
//
//   draft  --regenerate/edit-->  draft  --email-->  SENT (immutable)
//                                                     |
//                                                     +--> credit note for any correction
//
// "Immutable once sent" is the whole point. A parent who has a PDF in their
// inbox is holding a document that has to keep meaning what it said, so after
// the send the only way to change the money is a credit note.

const { renderInvoicePdf, invoiceFilename } = require('../lib/invoice-pdf');
const gmail = require('../lib/gmail-sender');

/** The nursery's own details for the letterhead, from ladn.settings. */
async function invoiceBranding(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN
      ('invoice_nursery_name','invoice_nursery_address','invoice_nursery_phone',
       'invoice_nursery_email','invoice_payment_terms','invoice_footer_note',
       'invoice_company_registration','invoice_ofsted_registration',
       'payment_bank_name','payment_bank_account_name','payment_bank_sort_code',
       'payment_bank_account_number')`);
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  return {
    name: s.invoice_nursery_name || 'Your Nursery',
    address: s.invoice_nursery_address || '',
    phone: s.invoice_nursery_phone || '',
    email: s.invoice_nursery_email || '',
    payment_terms: s.invoice_payment_terms || '',
    // b299 — free text, entered once in Settings and printed on every invoice
    // exactly as typed: line breaks kept, URLs made clickable. Nothing here is
    // trimmed or reflowed, because the EyLog footer it replaces is a set of
    // instructions and two group links that stop working if they are reflowed.
    footer_note: s.invoice_footer_note || '',
    // A UK invoice carries these, and Ofsted registration is what tells a parent
    // claiming funding that the setting is one they are allowed to claim at.
    company_registration: s.invoice_company_registration || '',
    ofsted_registration: s.invoice_ofsted_registration || '',
    // b325 — the account to pay into. Blank until a manager fills it in on
    // Finance → Reconcile → Matching; the "How to pay" block simply does not
    // draw rather than printing an empty sort code on a bill.
    bank: {
      name:           s.payment_bank_name || '',
      account_name:   s.payment_bank_account_name || '',
      sort_code:      s.payment_bank_sort_code || '',
      account_number: s.payment_bank_account_number || '',
    },
  };
}

/** Statement + branding -> a PDF buffer, the one path both download and email use. */
async function invoicePdfBuffer(db, invoiceId) {
  const statement = await loadStatement(db, invoiceId);
  if (!statement) return null;
  const branding = await invoiceBranding(db);
  const buffer = await renderInvoicePdf(statement, branding);
  return { statement, branding, buffer, filename: invoiceFilename(statement) };
}

// ── GET /api/finance/invoices/:id/pdf ────────────────────────────────────────
// The invoice as a PDF. ?download=1 forces a save rather than an inline view.
router.get('/:id/pdf', async (req, res) => {
  const db = getPool();
  try {
    const out = await invoicePdfBuffer(db, req.params.id);
    if (!out) return res.status(404).json({ error: 'Invoice not found' });

    await db.query('UPDATE invoices SET pdf_generated_at=NOW() WHERE id=$1', [req.params.id]);
    recordAudit({ req, action: 'pdf', entity_type: 'invoice', entity_id: parseInt(req.params.id, 10),
      meta: { invoice_number: out.statement.invoice_number } });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', out.buffer.length);
    res.setHeader('Content-Disposition',
      `${req.query.download ? 'attachment' : 'inline'}; filename="${out.filename}"`);
    // A bill is not something to serve from a shared cache.
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(out.buffer);
  } catch (e) {
    console.error('[finance-invoices] pdf error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/invoices/:id/email ─────────────────────────────────────
// Email ONE invoice to its bill payer with the PDF attached, and lock it.
// Distinct from the existing bulk POST /send, which only stamps sent_at.
// Body: { to?, message?, resend? }
// 2026-09-28 — extracted from POST /:id/email so the BULK send can use the very same path.
// POST /send used to stamp sent_at and email nobody, so 'send invoices' marked a whole
// month as sent while every parent waited for an email that was never coming.
async function emailOneInvoice(db, invoiceId, { to, message, resend, userId } = {}) {
  try {
    // invpdf-20261028 — credit the family already holds goes onto the bill BEFORE the PDF is
    // drawn. It used to run after the email had gone (in POST /send), so a family in credit
    // was sent a PDF asking for the full amount.
    try { await require('../lib/invoice-outstanding').applyUnallocatedCredit(db, invoiceId); }
    catch (e) { console.error('[finance-invoices] credit apply failed for', invoiceId, e.message); }
    // accounts-20261028: then the whole family account, EyLog-style (split payments, the rest
    // as credit), so the bill's paid/owed matches the tally on the PDF.
    try {
      const { rows: [ci] } = await db.query('SELECT child_id FROM invoices WHERE id=$1', [invoiceId]);
      if (ci) await require('../lib/account-allocate').allocateAccount(db, ci.child_id);
    } catch (e) { console.error('[finance-invoices] account allocate failed for', invoiceId, e.message); }
    const out = await invoicePdfBuffer(db, invoiceId);
    if (!out) return { ok: false, code: 'not_found', error: 'Invoice not found' };
    const st = out.statement;

    // Sending twice is nearly always a mis-click, and the second copy lands in a
    // parent's inbox looking like a second bill. Allowed, but only on purpose.
    if (st.sent_at && !resend) {
      return { ok: false, code: 'already_sent', error: `Already sent on ${new Date(st.sent_at).toLocaleDateString('en-GB')}.` };
    }

    // b532 — an invoice raised before the family had an email (child 188's backdated bills)
    // goes to the billing email the child has NOW, and the invoice is stamped with it.
    let recipient = (to || st.bill_payer_email || '').trim();
    if (!recipient) {
      const { rows: [c] } = await db.query(
        `SELECT NULLIF(btrim(c.primary_contact_email), '') AS e FROM invoices i JOIN children c ON c.id = i.child_id WHERE i.id = $1`, [invoiceId]);
      recipient = (c && c.e) || '';
      if (recipient) await db.query(`UPDATE invoices SET bill_payer_email = $2 WHERE id = $1 AND bill_payer_email IS NULL`, [invoiceId, recipient]);
    }
    if (!recipient) return { ok: false, code: 'no_email', error: 'No bill payer email on this invoice' };
    if (!gmail.isConfigured()) {
      return { ok: false, code: 'mail_unconfigured', error: 'Email is not configured on this server' };
    }

    const pounds = p => '£' + ((p || 0) / 100).toFixed(2);
    const due = st.dates.due_date
      ? new Date(st.dates.due_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
      : null;
    const subject = `${out.branding.name} — invoice ${st.invoice_number}${st.period_label ? ' for ' + st.period_label : ''}`;
    const intro = message ? `<p>${String(message).replace(/[<>]/g, '')}</p>` : '';

    // b325 — the reference goes in the EMAIL as well as the PDF. A parent paying
    // from their phone reads the email and never opens the attachment, and a
    // payment sent without the reference is one somebody reconciles by hand.
    const bank = out.branding.bank || {};
    const bankRows = [
      ['Account name', bank.account_name || out.branding.name],
      ['Sort code', bank.sort_code],
      ['Account number', bank.account_number],
    ].filter(r => r[1]);
    // 2026-09-28 — a button, because a parent reading this on a phone should not have to find
    // the portal themselves. Table-based and inline-styled: Outlook ignores everything else.
    const portal = process.env.PARENT_PORTAL_INVOICES_URL || 'https://parents.example-nursery.co.uk/welcome/payments';
    const payButtonHtml = `
      <table cellpadding="0" cellspacing="0" style="margin:22px 0"><tr>
        <td style="background:#e07820;border-radius:16px">
          <a href="${portal}" style="display:inline-block;padding:13px 26px;font-family:sans-serif;
             font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none">View and pay this invoice</a>
        </td></tr></table>
      <p style="font-family:sans-serif;font-size:12px;color:#6b7f8f;margin:-10px 0 0">
        Or go to ${portal.replace(/^https?:\/\//, '')} and sign in with this email address.</p>`;

    const howToPayHtml = st.family_payment_ref || bankRows.length ? `
      <p style="margin-top:18px"><strong>How to pay</strong></p>
      ${st.family_payment_ref ? `<p style="font-family:sans-serif;font-size:14px">
        Please quote <strong style="font-size:17px;letter-spacing:1px">${st.family_payment_ref}</strong>
        with every payment. It is the same reference for every child in your family and it does not change.</p>` : ''}
      ${bankRows.length ? `<table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
        ${bankRows.map(r => `<tr><td>${r[0]}</td><td><strong>${r[1]}</strong></td></tr>`).join('')}
      </table>` : ''}
      ${st.tfc_payment_reference ? `<p style="font-size:13px;color:#555">
        If you pay through Tax-Free Childcare, HMRC sends your childcare reference
        (${st.tfc_payment_reference}) with the payment — there is nothing else for you to do.</p>` : ''}` : '';
    const howToPayText = st.family_payment_ref || bankRows.length ? [
      '', 'How to pay',
      st.family_payment_ref
        ? `Please quote ${st.family_payment_ref} with every payment — the same reference for every child in your family.`
        : '',
      ...bankRows.map(r => `${r[0]}: ${r[1]}`),
    ].filter(Boolean).join('\n') : '';
    const html = `
      <p>Hello${st.bill_payer_name ? ' ' + st.bill_payer_name : ''},</p>
      ${intro}
      <p>Your invoice for <strong>${st.child_name || 'your child'}</strong>${st.period_label ? ' — ' + st.period_label : ''}
         is attached as a PDF.</p>
      <table cellpadding="6" style="border-collapse:collapse;font-family:sans-serif;font-size:14px">
        <tr><td>Invoice</td><td><strong>${st.invoice_number}</strong></td></tr>
        <tr><td>Total</td><td><strong>${pounds(st.totals.invoice_total_pence)}</strong></td></tr>
        ${st.totals.prior_balance_pence > 0 ? `<tr><td>Overdue from earlier invoices</td><td><strong>${pounds(st.totals.prior_balance_pence)}</strong></td></tr>` : ''}
        ${st.totals.prior_balance_pence < 0 ? `<tr><td>Credit on your account</td><td><strong style="color:#15803d">${pounds(-st.totals.prior_balance_pence)}</strong></td></tr>` : ''}
        <tr><td>Amount due</td><td><strong>${pounds(st.totals.total_due_pence)}</strong></td></tr>
        ${st.totals.credit_remaining_pence > 0 ? `<tr><td>Credit left on your account</td><td><strong style="color:#15803d">${pounds(st.totals.credit_remaining_pence)}</strong> — nothing to pay this month</td></tr>` : ''}
        ${due ? `<tr><td>Due by</td><td>${due}</td></tr>` : ''}
      </table>
      ${(st.totals.total_due_pence || 0) > 0 ? payButtonHtml : ''}
      ${howToPayHtml}
      <p style="font-size:13px;color:#555">${out.branding.footer_note || ''}</p>
      <p style="font-size:13px;color:#555">${out.branding.payment_terms || ''}</p>
      <p style="font-size:13px;color:#555">${out.branding.name}${out.branding.phone ? ' · ' + out.branding.phone : ''}</p>`;
    const text = [
      `Hello${st.bill_payer_name ? ' ' + st.bill_payer_name : ''},`, '',
      // 2026-10-29 — the office's note went into the HTML part only; plain-text readers missed it.
      ...(message ? [String(message), ''] : []),
      ...((st.totals.total_due_pence || 0) > 0
        ? [`View and pay this invoice: ${portal}`, ''] : []),
      `Your invoice for ${st.child_name || 'your child'}${st.period_label ? ' — ' + st.period_label : ''} is attached.`,
      `Invoice ${st.invoice_number}`,
      `Total ${pounds(st.totals.invoice_total_pence)} · amount due ${pounds(st.totals.total_due_pence)}`,
      st.totals.prior_balance_pence > 0 ? `Includes ${pounds(st.totals.prior_balance_pence)} overdue from earlier invoices.` : '',
      st.totals.credit_remaining_pence > 0 ? `Credit left on your account: ${pounds(st.totals.credit_remaining_pence)} — nothing to pay this month.` : '',
      due ? `Due by ${due}` : '',
      howToPayText, '',
      out.branding.payment_terms || '', out.branding.name,
    ].filter(Boolean).join('\n');

    await gmail.sendViaGmail({
      to: recipient, subject, html, text, fromName: out.branding.name,
      attachments: [{ filename: out.filename, content: out.buffer, contentType: 'application/pdf' }],
    });

    // Sent means locked. A draft becomes 'sent'; a status the office has already
    // moved on (paid, overdue, written off) is left alone.
    await db.query(
      `UPDATE invoices
          SET sent_at = NOW(), sent_by = $1, locked_at = COALESCE(locked_at, NOW()),
              status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
              -- b325 — stamp the reference the parent was actually shown. Only
              -- ever fills a blank: a re-send must not rewrite history.
              family_payment_ref = COALESCE(family_payment_ref, $3),
              updated_at = NOW()
        WHERE id = $2`,
      [userId, invoiceId, st.family_payment_ref || null]);

    recordAudit({ req: { user: { id: userId } }, action: 'send', entity_type: 'invoice', entity_id: parseInt(invoiceId, 10),
      meta: { invoice_number: st.invoice_number, resend: !!resend } });

    return { ok: true, sent_to: recipient, invoice_number: st.invoice_number, locked: true,
             due_pence: st.totals.total_due_pence, credit_pence: st.totals.credit_remaining_pence || 0 };
  } catch (e) {
    console.error('[finance-invoices] email error:', e.message);
    return { ok: false, code: 'error', error: e.message };
  }
}

// POST /:id/email — one invoice, by hand.
router.post('/:id/email', async (req, res) => {
  const r = await emailOneInvoice(getPool(), req.params.id, { ...(req.body || {}), userId: req.user.id });
  if (r.ok) return res.json(r);
  const status = r.code === 'not_found' ? 404 : r.code === 'already_sent' ? 409
               : r.code === 'no_email' ? 400 : r.code === 'mail_unconfigured' ? 503 : 500;
  res.status(status).json(r);
});

// ── POST /api/finance/invoices/:id/regenerate ────────────────────────────────
// Recalculate an invoice the family has NOT yet seen, from today's bookings, funding,
// fee items, discounts, price overrides and extra sessions.
//
// b535 (2026-10-29) — this used to price with computeItemisedForChild while POST
// /generate and the b490 reissue priced with buildDfeLineItems. Two engines, so
// "recalculate this invoice" and "raise this invoice" could disagree by a four-figure
// sum on a funded child (the b490 G3 note: £2,101.99 with no funding deduction against
// £1,602.92). The comment above used to claim they were the same code path; they were
// not. It now goes through src/lib/invoice-pricing.js priceInvoiceToday, which is also
// what the out-of-date check and both reissue routes use — one pricing answer, whichever
// button is pressed. The legacy engine was chosen because it is the one that raised every
// invoice a family has actually been sent.
//
// Carrying the extra sessions is no longer done here either: priceInvoiceToday passes
// fromInvoiceId, so computeLegacyInvoiceForChild picks up the rows already on this
// invoice plus any uninvoiced ones dated in its month, exactly as /generate does.
router.post('/:id/regenerate', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [inv] } = await db.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    // 2026-09-28 — the test is whether the FAMILY HAS SEEN IT, not the status word. The
    // generator writes status='sent' the moment it creates an invoice, long before anything is
    // emailed, so requiring status='draft' meant a freshly generated invoice could never be
    // recalculated — the one moment you most want to. sent_at/locked_at are the real gate.
    if (inv.sent_at || inv.locked_at) {
      return res.status(409).json({
        error: 'This invoice has already been sent to the family — raise a credit note instead.',
        code: 'invoice_locked', sent_at: inv.sent_at,
      });
    }
    if (inv.status === 'paid' || inv.status === 'credit_note' || inv.status === 'written_off') {
      return res.status(409).json({
        error: `A ${inv.status.replace('_',' ')} invoice cannot be regenerated.`, code: 'invoice_locked',
      });
    }
    if (!inv.period_year || !inv.period_month) {
      return res.status(400).json({ error: 'This invoice has no billing period, so it cannot be recalculated' });
    }
    // An invoice that came out of EyLog is a historic record, not a Wren draft.
    // Wren cannot reproduce EyMan's arithmetic, so recalculating one would quietly
    // replace what the family was actually billed with a modern approximation —
    // and the migration's whole value is that those figures are the originals.
    if (inv.eylog_ref) {
      return res.status(409).json({
        error: 'This invoice was imported from EyLog. Its figures are the historic record and are not recalculated.',
        code: 'imported_invoice', eylog_ref: inv.eylog_ref,
      });
    }

    const today = await PRICING.priceInvoiceToday(db, inv);
    if (!today) {
      return res.status(409).json({
        error: 'This child cannot be billed for this period today (left, not started, or no longer active).' });
    }
    // The shape the UPDATE below already expected, filled from the one pricing answer.
    const rec = {
      amount_pence: today.amount_pence,
      line_items: today.line_items,
      billing_basis: 'dfe_legacy',
      basis_detail: { engine: 'buildDfeLineItems', regenerated_by_b535: true,
                      funding_deduction_pence: today.funding_deduction_pence, room: today.room },
      basis_reason: 'Recalculated with the same generator that raises the monthly run.',
      due_on: today.due_on,
      discount_lines: today.discount_lines,
    };
    const xsLines = (today.line_items || []).filter(l => l.is_extra_session);

    await db.query(
      `INSERT INTO invoice_edits (invoice_id, edited_by, action, reason,
                                  before_total_pence, after_total_pence, before_lines, after_lines)
       VALUES ($1,$2,'regenerate',$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [inv.id, req.user.id, req.body?.reason || null, inv.amount_pence, rec.amount_pence,
       JSON.stringify(inv.line_items || []), JSON.stringify(rec.line_items)]);

    await db.query(
      `UPDATE invoices
          SET amount_pence = $1, line_items = $2::jsonb, billing_basis = $3, basis_detail = $4::jsonb,
              due_on = $5, regenerated_at = NOW(), regenerated_by = $6, updated_at = NOW()
        WHERE id = $7`,
      [rec.amount_pence, JSON.stringify(rec.line_items), rec.billing_basis,
       JSON.stringify(rec.basis_detail), rec.due_on, req.user.id, inv.id]);

    // b225 — unconditional: a discount REMOVED since the invoice was generated
    // has to supersede its old row too, and that case passes an empty array.
    await DISC.recordDiscountLines(db, inv.id, rec.discount_lines || []);
    await XS.markInvoiced(db, xsLines.map(l => l.child_fee_item_id), inv.id);
    // b535 — the credits this re-pricing spent are stamped against this invoice, the
    // same way POST /generate stamps them. A credit the smaller bill no longer needs
    // stays 'approved' and is available for the next one.
    if ((today.applied_credit_ids || []).length) {
      await db.query(
        `UPDATE parent_account_credits SET status='applied', applied_invoice_id=$1, updated_at=NOW()
          WHERE id = ANY($2::int[])
            AND ((status='approved' AND applied_invoice_id IS NULL) OR applied_invoice_id = $1)`,
        [inv.id, today.applied_credit_ids]);
    }

    recordAudit({ req, action: 'regenerate', entity_type: 'invoice', entity_id: inv.id,
      meta: { before_pence: inv.amount_pence, after_pence: rec.amount_pence, basis: rec.billing_basis } });

    res.json({ ok: true, invoice_id: inv.id,
      before_pence: inv.amount_pence, after_pence: rec.amount_pence,
      changed: inv.amount_pence !== rec.amount_pence,
      billing_basis: rec.billing_basis, basis_reason: rec.basis_reason,
      funding_deduction_pence: today.funding_deduction_pence,
      line_items: rec.line_items });
  } catch (e) {
    console.error('[finance-invoices] regenerate error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// b490 — recompute what ONE child's invoice for ONE month would be TODAY, using the
// same engine as a bulk /generate run (LEGACY_CHILD_SELECT + buildDfeLineItems), so a
// reissued invoice is never a third version of "what this child's bill looks like."
// Picks up today's bookings (room moves included), today's fee_items and any active
// price override for the period. Returns null if the child cannot be billed for this
// period at all (left, not yet started, or no longer active).
// b535 — `carryCreditsFromInvoiceId`: also load the account credits already applied to
// THAT invoice, so re-pricing it keeps its credit line. Opt-in; passed by /regenerate,
// both reissue routes and the out-of-date check. Without it, re-pricing an invoice that
// carried a £50 credit silently drops the line (the bill goes UP by £50) and leaves the
// credit row pointing at an invoice that no longer shows it.
// b535 review — `pendingStores` (default true): false prices ONLY what this invoice
// already holds — no uninvoiced extra session, no unspent account credit. Those reach
// the next invoice by themselves, so "put the difference on the next invoice" must not
// carry them as well, or the next bill charges (or credits) them twice.
async function computeLegacyInvoiceForChild(db, { childId, year, month, fromInvoiceId = null,
                                                  carryCreditsFromInvoiceId = null,
                                                  pendingStores = true }) {
  const { rows: [term] } = await db.query(
    `SELECT * FROM funding_terms WHERE is_current = true ORDER BY start_date DESC LIMIT 1`);
  const { rows: allTerms } = await db.query(
    `SELECT id, start_date, end_date, holiday_dates FROM funding_terms ORDER BY start_date`);
  const currentTermId = term ? term.id : null;
  const { rows: mealRows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN
      ('meal_charge_2yo_weekly_pence','meal_charge_3_4yo_weekly_pence','meal_charge_hours_basis','invoice_due_day','consumables_enabled')`);
  const ms = Object.fromEntries(mealRows.map(r => [r.key, r.value]));
  const meal = {
    rate2:  (parseFloat(ms.meal_charge_2yo_weekly_pence)   || 0) / 100,
    rate34: (parseFloat(ms.meal_charge_3_4yo_weekly_pence) || 0) / 100,
    basis:  parseFloat(ms.meal_charge_hours_basis) || 21.92,
    enabled: String(ms.consumables_enabled || '').toLowerCase() === 'true',
  };
  const dueDayOfMonth = parseInt(ms.invoice_due_day, 10) || 15;
  const { rows: ooRows } = await db.query(
    `SELECT o.child_id FROM child_fee_optouts o JOIN fee_items f ON f.id = o.fee_item_id
      WHERE o.opted_out = true AND o.status = 'approved' AND f.formula ILIKE '%weekly_funded_hours%'
        AND o.child_id = $1`, [childId]);
  const consumablesOptedOut = ooRows.length > 0;

  const { rows: [child] } = await db.query(
    `${LEGACY_CHILD_SELECT} AND c.id = $4`, [currentTermId, year, month, childId]);
  if (!child) return null;
  await applyFeeBandRule(db, [child], year, month);

  const monthLabel = new Date(year, month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const periodFromIso = new Date(Date.UTC(year, month - 1, 1)).toISOString().slice(0, 10);
  const periodToIso   = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  const billEmail = (child.primary_contact_email || '').toLowerCase().trim();
  let credits = [];
  if (billEmail) {
    const { rows: crRows } = await db.query(
      `SELECT id, amount_pence, reason FROM parent_account_credits
       WHERE lower(parent_email)=$1
         AND (($3::boolean AND status='approved' AND applied_invoice_id IS NULL)
              OR ($2::int IS NOT NULL AND status='applied' AND applied_invoice_id = $2::int))
       ORDER BY earned_at ASC`, [billEmail, carryCreditsFromInvoiceId, pendingStores !== false]);
    credits = crRows;
  }
  const discounts = await DISC.applicableDiscounts(db, child.id, periodFromIso, periodToIso);
  // 2026-10-21 — a reissue keeps the extra sessions the old invoice carried.
  let extras = await XS.extrasForInvoice(db, child.id, periodToIso, { fromInvoiceId });
  if (pendingStores === false) {
    const own = fromInvoiceId
      ? (await db.query('SELECT id FROM child_fee_items WHERE invoice_id = $1', [fromInvoiceId])).rows.map(r => r.id)
      : [];
    extras = extras.filter(x => own.includes(x.id));
  }
  const { lineItems, fundingDeductionPence, chargeablePence, appliedCreditIds, discountLines, extraSessionIds } =
    buildDfeLineItems({ child, year, month, monthLabel, term, allTerms, credits, discounts,
                        meal, consumablesOptedOut, extras });
  const issued = new Date(year, month - 1, 1);
  const due    = new Date(year, month - 1, dueDayOfMonth);
  return {
    child, monthLabel, lineItems, fundingDeductionPence, chargeablePence, appliedCreditIds, discountLines, extraSessionIds,
    issued_on: issued.toISOString().split('T')[0],
    due_on: due.toISOString().split('T')[0],
    room: child.booking_room_name || child.room_name || child.room,
  };
}

// Shared eligibility check for reissue preview + commit.
async function reissueGuard(db, invoiceId) {
  const { rows: [inv] } = await db.query('SELECT * FROM invoices WHERE id=$1', [invoiceId]);
  if (!inv) return { inv: null };
  if (inv.eylog_ref) {
    return { inv, refusal: { status: 409, body: {
      error: 'This invoice was imported from EyLog. Its figures are the historic record and are not reissued.',
      code: 'imported_invoice', eylog_ref: inv.eylog_ref } } };
  }
  if (!['sent', 'overdue', 'paid'].includes(inv.status)) {
    return { inv, refusal: { status: 409, body: {
      error: `A ${inv.status.replace('_', ' ')} invoice cannot be reissued — it hasn't been sent, or is already a credit note / written off.`,
      code: 'invoice_not_reissuable' } } };
  }
  if (!inv.period_year || !inv.period_month) {
    return { inv, refusal: { status: 400, body: { error: 'This invoice has no billing period, so it cannot be reissued' } } };
  }
  const { rows: [already] } = await db.query(
    `SELECT id, invoice_number FROM invoices WHERE reissued_from_id = $1 AND status <> 'written_off'`, [invoiceId]);
  if (already) {
    return { inv, refusal: { status: 409, body: {
      error: `Already reissued as ${already.invoice_number}.`, code: 'already_reissued', replacement_id: already.id } } };
  }
  return { inv };
}

// POST /api/finance/invoices/:id/reissue/preview — compute only, writes nothing.
router.post('/:id/reissue/preview', async (req, res) => {
  const db = getPool();
  try {
    const { inv, refusal } = await reissueGuard(db, req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (refusal) return res.status(refusal.status).json(refusal.body);

    // b535 — carryCreditsFromInvoiceId: the account credits the OLD bill spent follow it
    // onto the replacement, so the preview shows the figure the commit will write and the
    // family does not have a credit quietly taken back off them.
    const draft = await computeLegacyInvoiceForChild(db, { childId: inv.child_id, year: inv.period_year, month: inv.period_month, fromInvoiceId: inv.id, carryCreditsFromInvoiceId: inv.id });
    if (!draft) return res.status(409).json({ error: 'This child cannot be billed for this period today (left, not started, or no longer active).' });
    const creditedPence = await creditNotesAgainst(db, inv.id);

    res.json({
      old: {
        id: inv.id, invoice_number: inv.invoice_number, amount_pence: inv.amount_pence,
        status: inv.status, line_items: inv.line_items, period_label: inv.period_label,
        credited_pence: -creditedPence,
      },
      new: {
        amount_pence: draft.chargeablePence, line_items: draft.lineItems, room: draft.room,
        funding_deduction_pence: draft.fundingDeductionPence,
        issued_on: draft.issued_on, due_on: draft.due_on,
      },
      // review G1: against what the old bill is worth NOW — a credit note already raised
      // against it (the child-90 hand fix) has already given the family that money back.
      difference_pence: draft.chargeablePence - (inv.amount_pence + creditedPence),
    });
  } catch (e) {
    console.error('[finance-invoices] reissue preview error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Sum (negative, pence) of the credit notes already raised against an invoice.
async function creditNotesAgainst(db, invoiceId) {
  const { rows: [r] } = await db.query(
    `SELECT COALESCE(SUM(amount_pence), 0)::int AS cn FROM invoices
      WHERE credit_note_for_id = $1 AND status = 'credit_note'`, [invoiceId]);
  return Number(r.cn) || 0;
}

// POST /api/finance/invoices/:id/reissue — credit the old invoice in full, raise a
// replacement for the same period from today's bookings/prices/overrides. The
// replacement is created exactly as POST /generate creates one (status 'sent', sent_at
// NULL: billed, not yet emailed) — the manager emails it from the normal send flow.
// Body: { reason? }
//
// release-money2 review:
//  G1  credit what is LEFT of the old bill (amount + credit notes already against it), not
//      its face value. Crediting the face value of a bill that already carried a £173.33
//      credit note pushed the same £173.33 onto the account a second time.
//  G2  one transaction with the old invoice row locked: a double-click raised two
//      replacements and credited the old bill twice (the second £1,776.25 went on account).
//      A crash part-way no longer leaves payments moved but the old bill uncredited.
//  G3  the replacement is 'sent' (unsent) like every generated invoice, not 'draft': as a draft
//      the family's balance dropped by the whole old bill until someone sent it (child-90
//      shape: £1,776.25 → £0.00 owed), and the draft offered Regenerate…, which re-prices with
//      the itemised engine (£2,101.99, no funding deduction) instead of £1,602.92.
router.post('/:id/reissue', async (req, res) => {
  const db = getPool();
  const client = await db.connect();
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
    const { inv: old, refusal } = await reissueGuard(client, req.params.id);
    if (!old) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }
    if (refusal) { await client.query('ROLLBACK'); return res.status(refusal.status).json(refusal.body); }

    // b535 — same carry as the preview above, so the two cannot disagree.
    const draft = await computeLegacyInvoiceForChild(client, { childId: old.child_id, year: old.period_year, month: old.period_month, fromInvoiceId: old.id, carryCreditsFromInvoiceId: old.id });
    if (!draft) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This child cannot be billed for this period today (left, not started, or no longer active).' });
    }

    const reason = (req.body && req.body.reason) || `Reissued — ${old.invoice_number}`;
    const creditedPence = await creditNotesAgainst(client, old.id);   // negative or 0

    // 1) Move whichever payment representation the old invoice holds (direct
    //    payments.invoice_id, or payment_allocations rows) onto the NEW invoice's id
    //    BEFORE crediting the old one — never both for the same payment (see
    //    src/lib/invoice-outstanding.js), and never leave a moved payment stranded as
    //    a stray "credit on account" once createCreditNote sees the old bill as unpaid.
    const newInvNum = await nextInvoiceNumber(client, new Date().getFullYear());
    const { rows: [created] } = await client.query(`
      INSERT INTO invoices (child_id, bill_payer_email, amount_pence, status,
                            issued_on, due_on, invoice_number, period_year, period_month,
                            period_label, room_id, funding_deduction_pence, line_items,
                            source, reissued_from_id, updated_at)
      VALUES ($1,$2,$3,'sent',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'reissue',$13,NOW())
      RETURNING id, invoice_number
    `, [
      old.child_id, draft.child.primary_contact_email, draft.chargeablePence,
      draft.issued_on, draft.due_on, newInvNum, old.period_year, old.period_month,
      old.period_label, draft.child.room_id, draft.fundingDeductionPence,
      JSON.stringify(draft.lineItems), old.id,
    ]);

    // review G4: move payments only up to the replacement's amount. Moving all of a £1,776.25
    // payment onto a £1,602.92 replacement left it over-allocated by £173.33, money that
    // applyUnallocatedCredit can never put on the next bill. What does not fit stays on the
    // old bill (an allocation is split if it has to be), so the credit note below turns it
    // into an ordinary 'credit-note-excess' credit on the account.
    let room = Math.max(0, Number(draft.chargeablePence) || 0);
    let allocMoved = 0, paymentsMoved = 0;
    const { rows: oldAllocs } = await client.query(
      `SELECT * FROM payment_allocations WHERE invoice_id = $1 ORDER BY id`, [old.id]);
    for (const a of oldAllocs) {
      if (room <= 0) break;
      const amt = Number(a.amount_pence) || 0;
      if (amt <= room) {
        await client.query(`UPDATE payment_allocations SET invoice_id = $1 WHERE id = $2`, [created.id, a.id]);
        room -= amt;
      } else {
        await client.query(`UPDATE payment_allocations SET amount_pence = $1 WHERE id = $2`, [amt - room, a.id]);
        await client.query(`
          INSERT INTO payment_allocations (payment_id, invoice_id, child_id, amount_pence, allocated_on, source, reference,
                                           period_year, period_month, period_source)
          SELECT payment_id, $1, child_id, $2, allocated_on, source, reference, period_year, period_month, period_source
            FROM payment_allocations WHERE id = $3`, [created.id, room, a.id]);
        room = 0;
      }
      allocMoved++;
    }
    // payments recorded straight against the old bill with no allocation (bank Reconcile, deposits)
    const { rows: direct } = await client.query(
      `SELECT p.id, p.amount_pence FROM payments p WHERE p.invoice_id = $1 AND p.status = 'succeeded'
          AND NOT EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = p.id) ORDER BY p.id`, [old.id]);
    for (const p of direct) {
      if (Number(p.amount_pence) > room) continue;
      await client.query(`UPDATE payments SET invoice_id = $1, updated_at = NOW() WHERE id = $2`, [created.id, p.id]);
      room -= Number(p.amount_pence); paymentsMoved++;
    }
    // a payment whose allocations now sit on the replacement points at it too
    const { rowCount: relinked } = await client.query(
      `UPDATE payments p SET invoice_id = $1, updated_at = NOW()
        WHERE p.invoice_id = $2 AND EXISTS (SELECT 1 FROM payment_allocations a WHERE a.payment_id = p.id AND a.invoice_id = $1)`,
      [created.id, old.id]);
    paymentsMoved += relinked;
    const { rows: [ro] } = await client.query(`SELECT ${require('../lib/invoice-outstanding').outstandingSql('i')} AS owed FROM invoices i WHERE i.id = $1`, [created.id]);
    if (Number(ro.owed) <= 0 && Number(draft.chargeablePence) > 0) {
      await client.query(`UPDATE invoices SET status = 'paid', paid_on = COALESCE(paid_on, CURRENT_DATE), updated_at = NOW() WHERE id = $1`, [created.id]);
    }

    // 2) NOW credit what is left of the old invoice — with its payments already moved,
    //    "what's still owed" on it is exactly that, so the credit note zeroes it rather
    //    than spilling the difference onto the account.
    const creditPence = Number(old.amount_pence) + creditedPence;
    const credit = creditPence > 0
      ? await createCreditNote(client, old.id, creditPence, reason)
      : { id: null, invoice_number: null, on_account_pence: 0 };

    if (draft.discountLines.length) await DISC.recordDiscountLines(client, created.id, draft.discountLines);
    await XS.markInvoiced(client, draft.extraSessionIds, created.id);
    if (draft.appliedCreditIds.length) {
      // b535 — a credit already applied to the OLD invoice is re-pointed at the
      // replacement. The old bill has just been credited in full, so leaving the credit
      // row attached to it would show the family a credit line on a bill that no longer
      // exists and no credit on the one that does.
      await client.query(
        `UPDATE parent_account_credits SET status='applied', applied_invoice_id=$1, updated_at=NOW()
          WHERE id = ANY($2::int[])
            AND ((status='approved' AND applied_invoice_id IS NULL) OR applied_invoice_id = $3::int)`,
        [created.id, draft.appliedCreditIds, old.id]);
    }
    await client.query('COMMIT');
    committed = true;

    recordAudit({ req, action: 'reissue', entity_type: 'invoice', entity_id: old.id,
      meta: { replacement_id: created.id, replacement_invoice_number: created.invoice_number,
              credit_note_id: credit.id, old_amount_pence: old.amount_pence, already_credited_pence: -creditedPence,
              credited_pence: Math.max(0, creditPence), new_amount_pence: draft.chargeablePence,
              payments_moved: paymentsMoved, allocations_moved: allocMoved, reason } });
    recordAudit({ req, action: 'create', entity_type: 'invoice', entity_id: created.id,
      meta: { type: 'reissue_replacement', reissued_from_id: old.id, amount_pence: draft.chargeablePence } });

    res.json({
      ok: true,
      old_invoice_id: old.id,
      credit_note_id: credit.id, credit_note_invoice_number: credit.invoice_number,
      replacement_id: created.id, replacement_invoice_number: created.invoice_number,
      replacement_amount_pence: draft.chargeablePence,
      payments_moved: paymentsMoved, allocations_moved: allocMoved,
    });
  } catch (e) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    console.error('[finance-invoices] reissue error:', e.message);
    res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'This invoice has just been reissued.' : e.message });
  } finally {
    client.release();
  }
});

// ── PUT /api/finance/invoices/:id/line-items ─────────────────────────────────
// Hand-edit the lines on a DRAFT before it goes out. The total is recomputed
// from the lines rather than accepted from the client, so a stored invoice can
// never disagree with its own breakdown.
// Body: { line_items: [{ label, description?, quantity?, unit_label?, unit_pence?,
//                        amount_pence, statutory_category? }], reason? }
router.put('/:id/line-items', async (req, res) => {
  const db = getPool();
  const { line_items, reason } = req.body || {};
  if (!Array.isArray(line_items)) return res.status(400).json({ error: 'line_items array required' });
  if (line_items.length > 100) return res.status(400).json({ error: 'Too many lines (max 100)' });
  try {
    const { rows: [inv] } = await db.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    if (inv.sent_at || inv.locked_at || inv.status !== 'draft') {
      return res.status(409).json({
        error: 'This invoice has been sent, so its lines cannot be edited. Raise a credit note instead.',
        code: 'invoice_locked', sent_at: inv.sent_at,
        credit_note_endpoint: `/api/finance/invoices/${inv.id}/credit-note`,
      });
    }
    if (inv.eylog_ref) {
      return res.status(409).json({
        error: 'This invoice was imported from EyLog. Its lines are the historic record and cannot be edited.',
        code: 'imported_invoice', eylog_ref: inv.eylog_ref,
      });
    }

    // Money is integer pence, and a line that cannot state its amount as one is
    // rejected rather than rounded into existence.
    const clean = [];
    for (const [i, li] of line_items.entries()) {
      const amt = Number(li.amount_pence);
      if (!Number.isFinite(amt) || Math.round(amt) !== amt) {
        return res.status(400).json({ error: `Line ${i + 1}: amount_pence must be a whole number of pence` });
      }
      const label = String(li.label || '').trim();
      if (!label) return res.status(400).json({ error: `Line ${i + 1}: label required` });
      const qty = li.quantity == null ? null : Number(li.quantity);
      clean.push({
        label,
        description: li.description ? String(li.description).slice(0, 300) : undefined,
        category: li.statutory_category || li.category || 'additional_paid_hours',
        statutory_category: li.statutory_category || li.category || 'additional_paid_hours',
        quantity: Number.isFinite(qty) ? qty : undefined,
        unit_label: li.unit_label || undefined,
        unit_pence: Number.isFinite(Number(li.unit_pence)) ? Math.round(Number(li.unit_pence)) : undefined,
        amount_pence: amt,
        is_funded: !!li.is_funded,
        // b225 — keep a discount a discount through a hand-edit. Without this it
        // comes back as a plain credit and the statement stops labelling it.
        is_discount: !!li.is_discount,
        is_credit: amt < 0 && !li.is_discount,
        funded_hours_at_zero: !!li.is_funded && amt === 0,
        note: li.note ? String(li.note).slice(0, 500) : undefined,
        basis: 'manual',
        edited_by: req.user.id,
      });
    }
    const total = clean.reduce((sum, li) => sum + li.amount_pence, 0);
    if (total < 0) return res.status(400).json({ error: 'An invoice cannot total less than £0. Use a credit note.' });

    await db.query(
      `INSERT INTO invoice_edits (invoice_id, edited_by, action, reason,
                                  before_total_pence, after_total_pence, before_lines, after_lines)
       VALUES ($1,$2,'edit_lines',$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [inv.id, req.user.id, reason || null, inv.amount_pence, total,
       JSON.stringify(inv.line_items || []), JSON.stringify(clean)]);

    await db.query(
      `UPDATE invoices
          SET line_items = $1::jsonb, amount_pence = $2, billing_basis = 'manual',
              basis_detail = COALESCE(basis_detail,'{}'::jsonb) || $3::jsonb, updated_at = NOW()
        WHERE id = $4`,
      [JSON.stringify(clean), total,
       JSON.stringify({ hand_edited: true, edited_at: new Date().toISOString(), edited_by: req.user.id }),
       inv.id]);

    recordAudit({ req, action: 'edit_lines', entity_type: 'invoice', entity_id: inv.id,
      meta: { before_pence: inv.amount_pence, after_pence: total, lines: clean.length, reason: reason || null } });

    res.json({ ok: true, invoice_id: inv.id, amount_pence: total, line_items: clean });
  } catch (e) {
    console.error('[finance-invoices] line-items error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/invoices/:id/edits ──────────────────────────────────────
// What was changed on this invoice before it went out, and by whom.
router.get('/:id/edits', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT e.id, e.action, e.reason, e.edited_at, e.before_total_pence, e.after_total_pence,
              s.first_name || ' ' || s.last_name AS edited_by_name
         FROM invoice_edits e
         LEFT JOIN staff s ON s.id = e.edited_by
        WHERE e.invoice_id = $1
        ORDER BY e.edited_at DESC`, [req.params.id]);
    res.json({ edits: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// b299 — the statement loader and the letterhead, exposed for scripts/b299-verify.js.
// Attached to the exported router rather than replacing module.exports, so the
// mount in server-unified.js is untouched. Nothing in the app reads these.
module.exports.__loadStatement = loadStatement;
module.exports.__invoiceBranding = invoiceBranding;
module.exports.__buildBreakdown = buildBreakdown;
// b397 — reused by src/routes/finance-payments.js so "Add credit note" raises the
// one real credit note, not a second copy of its SQL.
module.exports.createCreditNote = createCreditNote;
// b535 — the ONE pricing answer, for src/lib/invoice-pricing.js. That module lazily
// requires this one (a top-level require either way would be a cycle), so the export
// has to live on the router object like the three above rather than in a module.exports
// rewrite — the mount in server-unified.js must not move.
module.exports.computeLegacyInvoiceForChild = computeLegacyInvoiceForChild;

// ════════════════════════════════════════════════════════════════════════════
// b535 — POST /api/finance/invoices/:id/carry-forward
//
// "Put the difference on the next invoice" — the EyLog way, and the right answer
// for a small correction on a bill the family has already seen and maybe paid.
// Nothing is credited, nothing is reissued, nothing is emailed; the difference is
// placed in whichever store the NEXT monthly run already reads:
//
//   • the family is owed money  -> an approved ladn.parent_account_credits row.
//     buildDfeLineItems' credits loop applies it as a negative line on the next bill.
//   • the family owes more      -> a dated one-off ladn.child_fee_items row, source
//     'staff-extra-session', start_date on the 1st of the next billing month.
//     src/lib/extra-sessions.js extrasForInvoice picks it up and stamps invoice_id,
//     so it is billed exactly once.
//
// No new money store is invented, on purpose. ladn.invoice_change_carries records only
// THAT a carry happened — one row per invoice (unique index), which is both the
// "exactly once" guarantee and what tells the out-of-date check to stop reporting the
// old invoice: the money has been dealt with and the bill is deliberately left alone.
//
// Body: { reason? }
// ════════════════════════════════════════════════════════════════════════════
router.post('/:id/carry-forward', async (req, res) => {
  const db = getPool();
  const client = await db.connect();
  let committed = false;
  try {
    if (!await PRICING.hasCarryTable(client)) {
      return res.status(503).json({ error: 'not_ready',
        message: 'Carrying a difference needs migrations/2026-10-29-b535-invoice-change-carries.sql.' });
    }
    await client.query('BEGIN');
    const { rows: [inv] } = await client.query(
      'SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [req.params.id]);
    if (!inv) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Invoice not found' }); }
    if (!inv.period_year || !inv.period_month) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'This invoice has no billing period, so nothing can be carried from it' });
    }
    if (inv.status === 'credit_note' || inv.status === 'written_off') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `A ${inv.status.replace('_', ' ')} cannot have a difference carried from it.`,
                                    code: 'invoice_not_carryable' });
    }
    const { rows: [already] } = await client.query(
      'SELECT id, diff_pence, direction, target_period FROM invoice_change_carries WHERE invoice_id = $1', [inv.id]);
    if (already) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'The difference on this invoice has already been carried to the next one.',
                                    code: 'already_carried', carry: already });
    }

    // An EyLog invoice is the historic record — it is never regenerated and never
    // reissued, but a difference CAN be carried off it, because that changes nothing
    // about the old bill. That is the only action this build offers on an import.
    //
    // b535 review — priced WITHOUT the pending stores. An uninvoiced extra session dated
    // in this month, or an approved credit not yet spent, is picked up by the next
    // /generate on its own (extrasForInvoice takes every uninvoiced row up to the period
    // end). Carrying it too billed it twice — and carrying October then November in one
    // bulk run carried October's correction twice, because November's re-price saw the
    // row October's carry had just made.
    const today = await PRICING.priceInvoiceToday(client, inv, { pendingStores: false });
    if (!today) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'This child cannot be priced for this period today (left, not started, or no longer active).' });
    }
    const diff = Number(today.amount_pence) - (Number(inv.amount_pence) || 0);
    if (diff === 0) {
      await client.query('ROLLBACK');
      const full = await PRICING.priceInvoiceToday(client, inv);
      const waiting = full ? Number(full.amount_pence) - Number(today.amount_pence) : 0;
      return res.status(400).json({
        error: waiting
          ? 'Nothing to carry: the difference is an extra session or account credit that is already waiting, and it goes on the next invoice by itself.'
          : 'This invoice already matches today\'s figures — there is nothing to carry.',
        code: waiting ? 'already_waiting' : 'no_difference', waiting_pence: waiting });
    }
    const r = PRICING.changeReason(Array.isArray(inv.line_items) ? inv.line_items : [], today.line_items);
    const nextP = PRICING.nextBillingMonth(inv.period_year, inv.period_month);
    const targetPeriod = PRICING.monthKey(nextP.year, nextP.month);
    const targetFirst = `${targetPeriod}-01`;
    const periodLabel = inv.period_label
      || new Date(inv.period_year, inv.period_month - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const reason = (req.body && String(req.body.reason || '').trim().slice(0, 300))
      || `${periodLabel} correction — ${r.reason || 'recalculated'} (${inv.invoice_number || '#' + inv.id})`;

    let creditId = null, feeItemId = null, direction;
    if (diff < 0) {
      direction = 'credit';
      const email = String(inv.bill_payer_email || '').toLowerCase().trim();
      if (!email) {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'This invoice has no bill payer on it, so a credit cannot be put on the account.',
                                      code: 'no_bill_payer' });
      }
      // reward_key carries the invoice id: parent_account_credits has a UNIQUE index on
      // (lower(parent_email), reward_key) for live statuses, so the database itself refuses
      // a second credit for the same invoice even if this route is somehow called twice.
      const { rows: [cr] } = await client.query(`
        INSERT INTO parent_account_credits
          (parent_email, reward_key, amount_pence, reason, status, reviewed_by, reviewed_at, review_notes)
        VALUES ($1, $2, $3, $4, 'approved', $5, NOW(), 'b535 carry-forward')
        RETURNING id`,
        [email, `billing_carry_inv_${inv.id}`, Math.abs(diff), reason, String(req.user.id)]);
      creditId = cr.id;
    } else {
      direction = 'charge';
      const { rows: [fi] } = await client.query(`
        INSERT INTO child_fee_items
          (child_id, fee_item_id, item_name, quantity, price_pence, frequency, start_date, end_date, source, raw)
        VALUES ($1, NULL, $2, 1, $3, 'one-off', $4, $4, 'staff-extra-session', $5::jsonb)
        RETURNING id`,
        [inv.child_id, `Correction for ${periodLabel}`, diff, targetFirst,
         JSON.stringify({ b535_carry_forward: true, carry_from_invoice_id: inv.id,
                          reason_codes: r.codes, added_by: req.user.id,
                          line_note: `Correction to the ${periodLabel} invoice (${r.reason || 'recalculated'}).` })]);
      feeItemId = fi.id;
    }

    const { rows: [carry] } = await client.query(`
      INSERT INTO invoice_change_carries
        (invoice_id, child_id, diff_pence, direction, credit_id, child_fee_item_id,
         target_period, reason, reason_codes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10)
      RETURNING *`,
      [inv.id, inv.child_id, diff, direction, creditId, feeItemId, targetPeriod, reason,
       r.codes.length ? r.codes : ['recalculated'], req.user.id]);

    await client.query('COMMIT');
    committed = true;

    recordAudit({ req, action: 'carry_forward', entity_type: 'invoice', entity_id: inv.id,
      meta: { diff_pence: diff, direction, target_period: targetPeriod, credit_id: creditId,
              child_fee_item_id: feeItemId, old_pence: inv.amount_pence,
              new_pence: today.amount_pence, reason_codes: r.codes } });

    res.json({
      ok: true, invoice_id: inv.id, carry,
      diff_pence: diff, direction, target_period: targetPeriod,
      credit_id: creditId, child_fee_item_id: feeItemId,
      message: direction === 'credit'
        ? `${(Math.abs(diff) / 100).toFixed(2)} put on the family's account — it comes off their next invoice. Nothing has been emailed.`
        : `${(diff / 100).toFixed(2)} added to the ${targetPeriod} invoice as a correction line. Nothing has been emailed.`,
    });
  } catch (e) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') {
      return res.status(409).json({ error: 'The difference on this invoice has just been carried.', code: 'already_carried' });
    }
    console.error('[finance-invoices] carry-forward error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET /api/finance/invoices/:id/carry — what was carried off this invoice, if anything.
router.get('/:id/carry', async (req, res) => {
  const db = getPool();
  try {
    if (!await PRICING.hasCarryTable(db)) return res.json({ carry: null, not_ready: true });
    const { rows } = await db.query(
      'SELECT * FROM invoice_change_carries WHERE invoice_id = $1', [req.params.id]);
    res.json({ carry: rows[0] || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 2026-11-03 — the Fee Modeller (src/routes/fee-sandbox.js) prices every child through
// this same engine, so its "current" column is the figure a real invoice run produces and
// its "new" column changes nothing but the day rates. Attached to the router object, like
// the exports above, so the mount in server-unified.js does not move. Read-only use.
module.exports.__feeEngine = { LEGACY_CHILD_SELECT, applyFeeBandRule, buildDfeLineItems, DFE_CATEGORIES };
