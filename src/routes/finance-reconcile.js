'use strict';
// Finance Reconciliation — bank statement upload, matching engine, manual confirm.
// Mounted at /api/finance/reconcile

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { getDecryptedSetting } = require('../lib/payment-settings');
const crypto       = require('crypto');

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

// ── Confidence scoring ────────────────────────────────────────────────────────
function scoreMatch(line, invoice, payment) {
  let score   = 0;
  const reasons = [];
  const desc  = (line.description || '').toLowerCase();
  const ref   = (line.reference   || '').toLowerCase();
  const combined = `${desc} ${ref}`;

  const lineAmt = Math.abs(parseInt(line.amount_pence));
  const targetAmt = parseInt(payment?.amount_pence || invoice?.amount_pence || 0);

  if (lineAmt === targetAmt) {
    score += 50; reasons.push('exact_amount');
  } else if (Math.abs(lineAmt - targetAmt) <= 100) {
    score += 30; reasons.push('near_amount_1');
  } else if (Math.abs(lineAmt - targetAmt) <= 500) {
    score += 15; reasons.push('near_amount_5');
  }

  // Name matching
  if (invoice?.child_name) {
    const nameParts = invoice.child_name.toLowerCase().split(' ');
    const surname = nameParts.at(-1);
    if (surname && combined.includes(surname)) {
      score += 25; reasons.push('surname_match');
    } else {
      const anyPart = nameParts.some(p => p.length > 3 && combined.includes(p));
      if (anyPart) { score += 10; reasons.push('partial_name'); }
    }
  }

  if (invoice?.bill_payer_email) {
    const emailUser = invoice.bill_payer_email.split('@')[0].toLowerCase();
    if (combined.includes(emailUser)) {
      score += 15; reasons.push('email_user_match');
    }
  }

  // Reference / invoice number
  if (invoice?.invoice_number) {
    const invRef = (invoice.invoice_number || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const lineRef = combined.replace(/[^a-z0-9]/g, '');
    if (lineRef.includes(invRef)) {
      score += 20; reasons.push('invoice_ref_match');
    }
  }

  // TFC detection
  if (combined.includes('tfc') || combined.includes('tax-free') || combined.includes('tax free')) {
    score += 10; reasons.push('tfc_reference');
  }

  // Date proximity (invoice due vs statement line date)
  if (invoice?.due_on && line.transaction_date) {
    const daysDiff = Math.abs((new Date(line.transaction_date) - new Date(invoice.due_on)) / 86400000);
    if (daysDiff <= 7)  { score += 10; reasons.push('date_7d'); }
    else if (daysDiff <= 30) { score += 5; reasons.push('date_30d'); }
  }

  return { score: Math.min(100, score), reasons };
}

// ── Reconciliation run ────────────────────────────────────────────────────────
async function runReconciliation(db, statementId = null) {
  const autoThresholdSetting = await getDecryptedSetting('reconcile_auto_threshold').catch(() => null);
  const autoThreshold = parseInt(autoThresholdSetting) || 95;

  // Fetch unreconciled credit lines (only credits = income)
  let lineQuery = `
    SELECT l.*, s.account_name
    FROM bank_statement_lines l
    JOIN bank_statements s ON s.id = l.statement_id
    WHERE l.reconciled = false AND l.amount_pence > 0
  `;
  const lp = [];
  if (statementId) { lp.push(statementId); lineQuery += ` AND l.statement_id = $${lp.length}`; }
  lineQuery += ' ORDER BY l.transaction_date DESC LIMIT 500';

  const { rows: lines } = await db.query(lineQuery, lp);
  if (!lines.length) return { matched: 0, auto_confirmed: 0, queued: 0 };

  // Fetch open invoices with related child info
  const { rows: openInvoices } = await db.query(`
    SELECT i.id, i.invoice_number, i.amount_pence, i.child_id, i.bill_payer_email,
           i.due_on, i.status, i.tfc_reference,
           c.first_name || ' ' || c.last_name AS child_name
    FROM invoices i
    JOIN children c ON c.id = i.child_id
    WHERE i.status IN ('sent','overdue')
      AND i.amount_pence > 0
    LIMIT 1000
  `);

  // Fetch unmatched payments
  const { rows: openPayments } = await db.query(`
    SELECT p.id, p.amount_pence, p.invoice_id, p.bill_payer_email, p.description
    FROM payments p
    WHERE p.reconciliation_status IN ('unreconciled','pending')
      AND p.status = 'succeeded'
    LIMIT 500
  `);

  // Build payment → invoice map
  const invById = Object.fromEntries(openInvoices.map(i => [i.id, i]));
  openPayments.forEach(p => { if (p.invoice_id) p._invoice = invById[p.invoice_id]; });

  let matched = 0, autoConfirmed = 0, queued = 0;

  for (const line of lines) {
    let bestScore = 0, bestInvoice = null, bestPayment = null, bestReasons = [];

    // Score against each open invoice
    for (const inv of openInvoices) {
      const { score, reasons } = scoreMatch(line, inv, null);
      if (score > bestScore) {
        bestScore = score; bestInvoice = inv; bestPayment = null; bestReasons = reasons;
      }
    }

    // Score against each open payment that has a linked invoice
    for (const pmt of openPayments) {
      const inv = pmt._invoice;
      const { score, reasons } = scoreMatch(line, inv, pmt);
      if (score > bestScore) {
        bestScore = score; bestInvoice = inv; bestPayment = pmt; bestReasons = reasons;
      }
    }

    if (bestScore < 30) continue; // not worth even suggesting

    matched++;
    const matchType = bestScore >= autoThreshold ? 'auto' : 'suggested';

    // Insert or update reconciliation_matches
    const { rows: [match] } = await db.query(`
      INSERT INTO reconciliation_matches
        (bank_line_id, payment_id, invoice_id, match_type, confidence_score, match_reasons, status)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'pending')
      ON CONFLICT DO NOTHING
      RETURNING id
    `, [
      line.id,
      bestPayment?.id || null,
      bestInvoice?.id || null,
      matchType,
      bestScore,
      JSON.stringify(bestReasons),
    ]);

    // Log
    await db.query(`
      INSERT INTO reconciliation_audit (event_type, bank_line_id, payment_id, invoice_id, confidence, detail)
      VALUES ($1,$2,$3,$4,$5,$6::jsonb)
    `, [matchType === 'auto' ? 'auto_match' : 'suggested_match',
        line.id, bestPayment?.id || null, bestInvoice?.id || null,
        bestScore, JSON.stringify({ reasons: bestReasons, line_desc: line.description })]);

    if (matchType === 'auto' && match?.id) {
      autoConfirmed++;
      // Auto-confirm
      await db.query(
        `UPDATE reconciliation_matches SET status='confirmed', confirmed_at=NOW() WHERE id=$1`,
        [match.id]
      );
      await db.query(`UPDATE bank_statement_lines SET reconciled=true, reconciled_at=NOW() WHERE id=$1`, [line.id]);

      if (bestInvoice) {
        await db.query(
          `UPDATE invoices SET status='paid', paid_on=$1, updated_at=NOW() WHERE id=$2 AND status != 'paid'`,
          [line.transaction_date, bestInvoice.id]
        );
        if (bestPayment) {
          await db.query(
            `UPDATE payments SET reconciliation_status='reconciled', bank_statement_line_id=$1 WHERE id=$2`,
            [line.id, bestPayment.id]
          );
        } else {
          // Create a payment record for this bank line
          await db.query(`
            INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence,
                                  payment_method, status, description, bank_statement_line_id,
                                  reconciliation_status, confidence_score, updated_at)
            VALUES ($1,$2,$3,$4,'bank_transfer','succeeded',$5,$6,'reconciled',$7,NOW())
          `, [bestInvoice.id, bestInvoice.child_id, bestInvoice.bill_payer_email,
              Math.abs(line.amount_pence), `Bank transfer: ${line.description}`,
              line.id, bestScore]);
        }
      }
    } else {
      queued++;
    }
  }

  // Update statement stats
  if (statementId) {
    await db.query(`
      UPDATE bank_statements
      SET reconciled_count = (SELECT COUNT(*) FROM bank_statement_lines WHERE statement_id=$1 AND reconciled=true)
      WHERE id=$1
    `, [statementId]);
  }

  return { matched, auto_confirmed: autoConfirmed, queued };
}

// ── GET /api/finance/reconcile/bank-statements ───────────────────────────────
router.get('/bank-statements', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT s.*,
             (SELECT COUNT(*) FROM bank_statement_lines WHERE statement_id=s.id) AS total_lines,
             (SELECT COUNT(*) FROM bank_statement_lines WHERE statement_id=s.id AND reconciled=true) AS reconciled_lines
      FROM bank_statements s
      ORDER BY s.created_at DESC
      LIMIT 50
    `);
    res.json({ statements: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/reconcile/bank-statements ───────────────────────────────
// Upload a CSV bank statement. Body: { csv_data, account_name, account_number, sort_code }
router.post('/bank-statements', async (req, res) => {
  const db = getPool();
  try {
    const { csv_data, account_name, account_number, sort_code } = req.body;
    if (!csv_data) return res.status(400).json({ error: 'csv_data required' });

    // Parse CSV (simple: Date,Description,Amount,Balance)
    const lines = csv_data.split('\n').map(l => l.trim()).filter(Boolean);
    const header = lines[0].toLowerCase();
    const isHeader = header.includes('date') || header.includes('description');
    const dataLines = isHeader ? lines.slice(1) : lines;

    const parsed = [];
    let totalCredits = 0, totalDebits = 0;

    for (const line of dataLines) {
      // Support comma and tab separated; handle quoted fields
      const cols = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
      if (cols.length < 3) continue;

      const [dateStr, description, amountStr, balanceStr] = cols;
      const txDate = new Date(dateStr);
      if (isNaN(txDate)) continue;

      const amount = parseFloat(amountStr.replace(/[£,\s]/g, ''));
      if (isNaN(amount)) continue;

      const amountPence = Math.round(amount * 100);
      if (amountPence > 0) totalCredits += amountPence;
      else totalDebits += Math.abs(amountPence);

      const balance = balanceStr ? parseFloat(balanceStr.replace(/[£,\s]/g, '')) * 100 : null;
      const provId = crypto.createHash('md5').update(`${dateStr}:${description}:${amountStr}`).digest('hex');

      parsed.push({
        transaction_date: txDate.toISOString().split('T')[0],
        description,
        amount_pence:  amountPence,
        balance_pence: balance ? Math.round(balance) : null,
        provider_id:   provId,
        reference:     cols[4] || null,
      });
    }

    if (!parsed.length) return res.status(400).json({ error: 'No valid rows parsed from CSV' });

    // Determine period
    const dates = parsed.map(r => new Date(r.transaction_date)).filter(d => !isNaN(d));
    const minDate = new Date(Math.min(...dates)).toISOString().split('T')[0];
    const maxDate = new Date(Math.max(...dates)).toISOString().split('T')[0];

    const { rows: [stmt] } = await db.query(`
      INSERT INTO bank_statements
        (source, account_name, account_number, sort_code, period_from, period_to,
         total_credits_pence, total_debits_pence, line_count, uploaded_by)
      VALUES ('csv',$1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING id
    `, [account_name || 'Unknown', account_number || null, sort_code || null,
        minDate, maxDate, totalCredits, totalDebits, parsed.length, req.user.id]);

    let inserted = 0;
    for (const row of parsed) {
      try {
        await db.query(`
          INSERT INTO bank_statement_lines
            (statement_id, transaction_date, description, amount_pence, balance_pence, provider_id, reference)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
          ON CONFLICT (statement_id, provider_id) DO NOTHING
        `, [stmt.id, row.transaction_date, row.description, row.amount_pence,
            row.balance_pence, row.provider_id, row.reference]);
        inserted++;
      } catch { /* skip duplicate */ }
    }

    recordAudit({ req, action: 'create', entity_type: 'bank_statement', entity_id: stmt.id,
      meta: { lines: inserted, account_name } });

    // Kick off reconciliation in background
    setImmediate(() => runReconciliation(db, stmt.id).catch(e => console.error('[reconcile] bg error:', e.message)));

    res.json({ ok: true, statement_id: stmt.id, lines_parsed: parsed.length, lines_inserted: inserted });
  } catch (e) {
    console.error('[finance-reconcile] upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/reconcile/bank-statements/:id/lines ─────────────────────
router.get('/bank-statements/:id/lines', async (req, res) => {
  const db = getPool();
  try {
    const { reconciled } = req.query;
    let q = 'SELECT l.*, m.confidence_score, m.status AS match_status, m.id AS match_id FROM bank_statement_lines l LEFT JOIN reconciliation_matches m ON m.bank_line_id = l.id AND m.status != $1 WHERE l.statement_id = $2';
    const qp = ['rejected', parseInt(req.params.id)];
    if (reconciled === 'false') { q += ' AND l.reconciled = false'; }
    if (reconciled === 'true')  { q += ' AND l.reconciled = true'; }
    q += ' ORDER BY l.transaction_date DESC';
    const { rows } = await db.query(q, qp);
    res.json({ lines: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/reconcile/matches ───────────────────────────────────────
// Pending matches for manual review
router.get('/matches', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT m.*,
             l.transaction_date, l.description AS line_desc, l.amount_pence AS line_amount,
             l.reference AS line_reference,
             i.invoice_number, i.amount_pence AS invoice_amount,
             i.bill_payer_email, i.due_on,
             c.first_name || ' ' || c.last_name AS child_name
      FROM reconciliation_matches m
      JOIN bank_statement_lines l ON l.id = m.bank_line_id
      LEFT JOIN invoices i ON i.id = m.invoice_id
      LEFT JOIN children c ON c.id = i.child_id
      WHERE m.status = 'pending'
      ORDER BY m.confidence_score DESC, m.created_at
      LIMIT 100
    `);
    res.json({ matches: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/reconcile/matches/:id/confirm ──────────────────────────
router.post('/matches/:id/confirm', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [match] } = await db.query(`
      SELECT m.*, l.amount_pence AS line_amount, l.transaction_date,
             i.child_id, i.amount_pence AS invoice_amount, i.bill_payer_email
      FROM reconciliation_matches m
      JOIN bank_statement_lines l ON l.id = m.bank_line_id
      LEFT JOIN invoices i ON i.id = m.invoice_id
      WHERE m.id = $1
    `, [req.params.id]);

    if (!match) return res.status(404).json({ error: 'Match not found' });

    await db.query(`
      UPDATE reconciliation_matches SET status='confirmed', confirmed_by=$1, confirmed_at=NOW() WHERE id=$2
    `, [req.user.id, match.id]);

    await db.query(`UPDATE bank_statement_lines SET reconciled=true, reconciled_at=NOW() WHERE id=$1`, [match.bank_line_id]);

    if (match.invoice_id) {
      await db.query(
        `UPDATE invoices SET status='paid', paid_on=$1, updated_at=NOW() WHERE id=$2 AND status != 'paid'`,
        [match.transaction_date, match.invoice_id]
      );
      if (match.payment_id) {
        await db.query(
          `UPDATE payments SET reconciliation_status='reconciled', bank_statement_line_id=$1 WHERE id=$2`,
          [match.bank_line_id, match.payment_id]
        );
      } else {
        await db.query(`
          INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence,
                                payment_method, status, description, bank_statement_line_id,
                                reconciliation_status, updated_at)
          VALUES ($1,$2,$3,$4,'bank_transfer','succeeded',$5,$6,'reconciled',NOW())
        `, [match.invoice_id, match.child_id, match.bill_payer_email,
            Math.abs(match.line_amount), `Reconciled bank transfer`, match.bank_line_id]);
      }
    }

    await db.query(`
      INSERT INTO reconciliation_audit (event_type, bank_line_id, payment_id, invoice_id, match_id, actor_id)
      VALUES ('manual_match',$1,$2,$3,$4,$5)
    `, [match.bank_line_id, match.payment_id, match.invoice_id, match.id, req.user.id]);

    recordAudit({ req, action: 'confirm', entity_type: 'reconciliation_match', entity_id: match.id });
    res.json({ ok: true });
  } catch (e) {
    console.error('[finance-reconcile] confirm error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/reconcile/matches/:id/reject ───────────────────────────
router.post('/matches/:id/reject', async (req, res) => {
  const db = getPool();
  try {
    const { reason } = req.body;
    await db.query(
      `UPDATE reconciliation_matches SET status='rejected', rejected_reason=$1 WHERE id=$2`,
      [reason, req.params.id]
    );
    await db.query(`
      INSERT INTO reconciliation_audit (event_type, match_id, actor_id, detail)
      VALUES ('rejected',$1,$2,$3::jsonb)
    `, [req.params.id, req.user.id, JSON.stringify({ reason })]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/reconcile/run ──────────────────────────────────────────
// Manually trigger a full reconciliation run.
router.post('/run', async (req, res) => {
  const db = getPool();
  res.json({ ok: true, message: 'Reconciliation started' });
  setImmediate(() =>
    runReconciliation(db, req.body?.statement_id || null)
      .catch(e => console.error('[reconcile] run error:', e.message))
  );
});

// ── GET /api/finance/reconcile/payments ──────────────────────────────────────
// Payments list with reconciliation status
router.get('/payments', async (req, res) => {
  const db = getPool();
  try {
    const { status = '', limit = 50, offset = 0 } = req.query;
    const qp = [parseInt(limit), parseInt(offset)];
    let where = 'WHERE p.status = \'succeeded\'';
    if (status) { qp.unshift(status); where += ` AND p.reconciliation_status = $${qp.length - 1}`; }

    const { rows } = await db.query(`
      SELECT p.id, p.amount_pence, p.payment_method, p.reconciliation_status,
             p.created_at, p.description, p.cash_reference,
             i.invoice_number, i.period_label,
             c.first_name || ' ' || c.last_name AS child_name
      FROM payments p
      LEFT JOIN invoices i ON i.id = p.invoice_id
      LEFT JOIN children c ON c.id = p.child_id
      ${where}
      ORDER BY p.created_at DESC
      LIMIT $${qp.length - 1} OFFSET $${qp.length}
    `, qp);
    res.json({ payments: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── TFC ─────────────────────────────────────────────────────────────────────
router.get('/tfc', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT t.*, c.first_name || ' ' || c.last_name AS child_name,
             i.invoice_number, i.amount_pence AS invoice_amount
      FROM tfc_payments t
      LEFT JOIN children c ON c.id = t.child_id
      LEFT JOIN invoices i ON i.id = t.invoice_id
      ORDER BY t.created_at DESC LIMIT 100
    `);
    res.json({ tfc_payments: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/tfc', async (req, res) => {
  const db = getPool();
  const { child_id, tfc_reference, expected_pence, invoice_id, notes } = req.body;
  try {
    const { rows: [t] } = await db.query(`
      INSERT INTO tfc_payments (child_id, tfc_reference, expected_pence, invoice_id, notes)
      VALUES ($1,$2,$3,$4,$5) RETURNING id
    `, [child_id, tfc_reference, expected_pence, invoice_id, notes]);
    res.json({ ok: true, id: t.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
