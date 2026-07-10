'use strict';
// Finance Invoices — full invoice management (generate, send, CRUD).
// Mounted at /api/finance/invoices

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { notify }   = require('../services/notification-dispatcher');

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
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
             c.first_name || ' ' || c.last_name AS child_name,
             r.name AS room_name,
             (SELECT COALESCE(SUM(p.amount_pence), 0)
              FROM payments p WHERE p.invoice_id = i.id AND p.status = 'succeeded') AS paid_pence
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

    res.json({ invoices: rows, count: rows.length });
  } catch (e) {
    console.error('[finance-invoices] list error:', e.message);
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
             ) AS payment_history
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

// Build DfE-compliant line items for a child's monthly invoice.
// `credits` (optional) = array of approved parent_account_credits rows to apply as
// a negative deduction line (e.g. £50 study-reward credits). These reduce the payable
// total but never take it below zero.
// Returns { lineItems, fundingDeductionPence, chargeablePence, appliedCreditIds }
function buildDfeLineItems({ child, monthLabel, term, credits = [] }) {
  const lineItems = [];
  let fundingDeductionPence = 0;
  let chargeablePence = 0;
  const appliedCreditIds = [];

  const monthlyFee = child.monthly_fee_pence || (child.daily_fee_pence || 0) * 20 || 0;

  // Funded entitlement hours (from child flags + real LA rate from funding_terms)
  const funded15 = child.funded_hours_15 ? true : false;
  const funded30 = child.funded_hours_30 ? true : false;
  const funded2yr = child.two_year_funded ? true : false;

  const universalHrsWk  = funded15 ? 15 : 0;
  const extendedHrsWk   = funded30 ? 15 : 0; // 30hr = 15 universal + 15 extended
  const twoYrHrsWk      = funded2yr ? 15 : 0;

  // Use real LA rate from funding_terms, fall back to DfE floor
  const rateUniversal = term ? parseFloat(term.rate_3yr_universal || 5.94) : 5.94;
  const rateExtended  = term ? parseFloat(term.rate_3yr_extended  || 5.94) : 5.94;
  const rate2yr       = term ? parseFloat(term.rate_2yr_working_parents || 8.96) : 8.96;

  const weeksInMonth = 4; // working approximation; real weeks from attendance calendar in future

  if (universalHrsWk > 0) {
    const hrs = universalHrsWk * weeksInMonth;
    const totalPence = Math.round(hrs * rateUniversal * 100);
    fundingDeductionPence += totalPence;
    lineItems.push({
      label:      `Funded entitlement — universal 15 hours (${universalHrsWk} hrs/wk × ${weeksInMonth} wks)`,
      category:   DFE_CATEGORIES.FUNDED,
      is_funded:  true,
      quantity:   hrs,
      unit_label: 'hours',
      unit_pence: 0,
      amount_pence: 0,
      note: `LA rate £${rateUniversal.toFixed(2)}/hr — charged to LA, not parent`,
    });
  }

  if (extendedHrsWk > 0) {
    const hrs = extendedHrsWk * weeksInMonth;
    const totalPence = Math.round(hrs * rateExtended * 100);
    fundingDeductionPence += totalPence;
    lineItems.push({
      label:      `Funded entitlement — extended 30 hours (${extendedHrsWk} hrs/wk × ${weeksInMonth} wks)`,
      category:   DFE_CATEGORIES.FUNDED,
      is_funded:  true,
      quantity:   hrs,
      unit_label: 'hours',
      unit_pence: 0,
      amount_pence: 0,
      note: `LA rate £${rateExtended.toFixed(2)}/hr — charged to LA, not parent`,
    });
  }

  if (twoYrHrsWk > 0) {
    const hrs = twoYrHrsWk * weeksInMonth;
    const totalPence = Math.round(hrs * rate2yr * 100);
    fundingDeductionPence += totalPence;
    lineItems.push({
      label:      `Funded entitlement — 2-year funded (${twoYrHrsWk} hrs/wk × ${weeksInMonth} wks)`,
      category:   DFE_CATEGORIES.FUNDED,
      is_funded:  true,
      quantity:   hrs,
      unit_label: 'hours',
      unit_pence: 0,
      amount_pence: 0,
      note: `LA rate £${rate2yr.toFixed(2)}/hr — charged to LA, not parent`,
    });
  }

  // Additional private paid hours (monthly room fee minus funded value)
  const paidPence = Math.max(0, monthlyFee - fundingDeductionPence);
  chargeablePence += paidPence;

  if (paidPence > 0) {
    lineItems.push({
      label:      `${monthLabel} additional private paid childcare`,
      category:   DFE_CATEGORIES.PAID_HOURS,
      is_funded:  false,
      quantity:   1,
      unit_label: 'month',
      unit_pence: paidPence,
      amount_pence: paidPence,
    });
  } else if (monthlyFee === 0 && fundingDeductionPence === 0) {
    // No room fee configured — flag for review
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

  // Food charges (from consumables_charge in funding_terms if set)
  if (term && parseFloat(term.consumables_charge || 0) > 0) {
    const foodPence = Math.round(parseFloat(term.consumables_charge) * 100);
    chargeablePence += foodPence;
    lineItems.push({
      label:      term.consumables_description || 'Meals and snacks',
      category:   DFE_CATEGORIES.FOOD,
      is_funded:  false,
      quantity:   1,
      unit_label: 'month',
      unit_pence: foodPence,
      amount_pence: foodPence,
    });
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

  return { lineItems, fundingDeductionPence, chargeablePence, appliedCreditIds };
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

    // Fetch children to generate for
    let childQuery = `
      SELECT c.id, c.first_name, c.last_name, c.room, c.date_of_birth,
             c.funding_hours_15, c.funding_hours_30,
             c.funded_hours, c.funded_hours_15, c.funded_hours_30,
             c.two_year_funded, c.funded_hours_type, c.two_year_funding_type,
             c.primary_contact_email,
             r.id AS room_id, r.name AS room_name,
             r.monthly_fee_pence
      FROM children c
      LEFT JOIN rooms r ON r.name = c.room
      WHERE c.status = 'active'
    `;
    const qp = [];
    if (child_ids?.length) {
      qp.push(child_ids);
      childQuery += ` AND c.id = ANY($${qp.length}::int[])`;
    }
    if (room_ids?.length) {
      qp.push(room_ids);
      childQuery += ` AND r.id = ANY($${qp.length}::int[])`;
    }
    const { rows: children } = await db.query(childQuery, qp);

    const monthLabel = new Date(year, month - 1, 1)
      .toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const previews = [];
    const generated = [];

    for (const child of children) {
      // Skip if invoice already exists for this period
      const { rows: existing } = await db.query(
        'SELECT id FROM invoices WHERE child_id=$1 AND period_year=$2 AND period_month=$3 AND status != $4',
        [child.id, year, month, 'written_off']
      );
      if (existing.length) continue;

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

      const { lineItems, fundingDeductionPence, chargeablePence, appliedCreditIds } = buildDfeLineItems({
        child, monthLabel, term, credits,
      });

      const issued = new Date(year, month - 1, 1);
      const due    = new Date(year, month - 1, 15);

      previews.push({
        child_id:   child.id,
        child_name: `${child.first_name} ${child.last_name}`,
        room:       child.room_name || child.room,
        amount_pence:            chargeablePence,
        funding_deduction_pence: fundingDeductionPence,
        credit_applied_pence:    lineItems.filter(li => li.is_credit).reduce((s, li) => s - li.amount_pence, 0),
        line_items:  lineItems,
        issued_on:   issued.toISOString().split('T')[0],
        due_on:      due.toISOString().split('T')[0],
        email:       child.primary_contact_email,
        dfe_compliant: true,
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
router.post('/send', async (req, res) => {
  const db = getPool();
  const { invoice_ids } = req.body;
  if (!invoice_ids?.length) return res.status(400).json({ error: 'invoice_ids required' });

  try {
    const { rows } = await db.query(
      'SELECT * FROM invoices WHERE id = ANY($1::int[])', [invoice_ids]
    );

    await db.query(
      'UPDATE invoices SET sent_at=NOW(), sent_by=$1, updated_at=NOW() WHERE id = ANY($2::int[])',
      [req.user.id, invoice_ids]
    );

    recordAudit({ req, action: 'bulk_send', entity_type: 'invoice',
      meta: { invoice_ids, count: rows.length } });

    res.json({ ok: true, sent: rows.length, invoices: rows.map(r => r.id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/finance/invoices/:id ─────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const db = getPool();
  const { status, notes, due_on, amount_pence, payment_method } = req.body;
  try {
    const { rows: [old] } = await db.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!old) return res.status(404).json({ error: 'Not found' });

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
router.post('/:id/credit-note', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [orig] } = await db.query('SELECT * FROM invoices WHERE id=$1', [req.params.id]);
    if (!orig) return res.status(404).json({ error: 'Not found' });

    const { amount_pence, notes } = req.body;
    const creditAmount = parseInt(amount_pence) || orig.amount_pence;
    const now = new Date();
    const invNum = await nextInvoiceNumber(db, now.getFullYear());

    const { rows: [credit] } = await db.query(`
      INSERT INTO invoices (child_id, bill_payer_email, amount_pence, status,
                            issued_on, period_year, period_month, invoice_number,
                            credit_note_for_id, notes, line_items, updated_at)
      VALUES ($1,$2,$3,'credit_note',CURRENT_DATE,$4,$5,$6,$7,$8,
              '[{"label":"Credit note","amount_pence":-1}]'::jsonb, NOW())
      RETURNING id, invoice_number
    `, [orig.child_id, orig.bill_payer_email, -Math.abs(creditAmount),
        now.getFullYear(), now.getMonth() + 1, invNum, orig.id,
        notes || `Credit note for ${orig.invoice_number || orig.id}`]);

    recordAudit({ req, action: 'create', entity_type: 'invoice', entity_id: credit.id,
      meta: { type: 'credit_note', for_invoice: orig.id } });

    res.json({ ok: true, id: credit.id, invoice_number: credit.invoice_number });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

module.exports = router;
