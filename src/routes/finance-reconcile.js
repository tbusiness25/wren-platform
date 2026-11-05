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
const PR           = require('../lib/payment-references');
const { applyDepositToAccount } = require('../lib/deposits');
const { tryAdvanceToRegistered } = require('../lib/enquiry-stage');
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

// ── CSV date parsing ─────────────────────────────────────────────────────────
// UK bank exports are DD/MM/YYYY. `new Date('19/08/2026')` is Invalid Date (the row
// is silently skipped) and `new Date('05/08/2026')` is 8 MAY, not 5 August — so an
// import would drop two thirds of a statement and silently transpose the rest.
// Parse to a 'YYYY-MM-DD' string directly and never build a Date, which also dodges
// the toISOString()-in-BST off-by-one-day. Returns null if it cannot be read.
function parseStatementDate(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  const pad = (n) => String(n).padStart(2, '0');
  // 31/02 is well-formed but not a real day. Postgres would reject it and the
  // per-row catch would file it as a duplicate, so check the calendar here.
  const real = (y, mo, d) => {
    const dt = new Date(+y, +mo - 1, +d);
    return dt.getFullYear() === +y && dt.getMonth() === +mo - 1 && dt.getDate() === +d
      ? `${y}-${pad(mo)}-${pad(d)}` : null;
  };

  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);            // ISO / YYYY-MM-DD
  if (m) return real(m[1], m[2], m[3]);

  m = v.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);  // DD/MM/YYYY (UK)
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = String(2000 + parseInt(y, 10));
    return real(y, mo, d);
  }

  m = v.match(/^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{2,4})$/);   // 19 Aug 2026
  if (m) {
    const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mi < 0) return null;
    let y = m[3]; if (y.length === 2) y = String(2000 + parseInt(y, 10));
    return real(y, mi + 1, m[1]);
  }
  return null;
}

// ── Confidence scoring ─────────────────────────────────────────────────────
function scoreMatch(line, invoice, payment) {
  let score   = 0;
  const reasons = [];
  const desc  = (line.description || '').toLowerCase();
  const ref   = (line.reference   || '').toLowerCase();
  const payee = (line.payee_name  || '').toLowerCase(); // b171: Xero contact name, now its own column
  const combined = `${desc} ${ref} ${payee}`;

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

  // 2026-10-05: who the line says it is from. line._who is resolved once per line in
  // runReconciliation (resolveWho): a TFC childcare reference names a CHILD (the one a
  // parent saved, or failing that HMRC's letters — first initial + first three of the
  // surname, TJON12345 for Nursery Manager), a family payment reference (LA-XXXX) names a
  // FAMILY. A line that names someone is not scored against anybody else's invoice.
  const who = line._who;
  if (who && invoice) {
    if (who.childIds.has(invoice.child_id)) {
      if (who.kind === 'tfc_ref_saved')   { score += 45; reasons.push('tfc_ref_saved'); }
      else if (who.kind === 'family_ref') { score += 45; reasons.push('family_ref'); }
      else                                { score += 35; reasons.push('tfc_name_code'); }
    } else {
      score -= 60; reasons.push('names_someone_else');
    }
  } else if (combined.includes('tfc') || combined.includes('tax-free') || combined.includes('tax free')) {
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

// ── Who does a line say it is from? (2026-10-05) ──────────────────────────────
// Loaded once per run. Children by saved TFC reference, by HMRC's four letters, and
// by family; family payment references (LA-XXXX) to the children of that family.
async function loadWhoContext(db) {
  const [{ rows: kids }, { rows: refs }] = await Promise.all([
    db.query(`SELECT id, first_name, last_name, preferred_name, status,
                     upper(btrim(tfc_payment_reference)) AS tfc_ref,
                     NULLIF(lower(btrim(primary_contact_email)), '') AS family_key
                FROM children`),
    db.query(`SELECT family_key, payment_ref FROM family_payment_refs WHERE retired_at IS NULL`)
      .catch(() => ({ rows: [] })),
  ]);
  const bySaved = new Map(), byLetters = new Map(), byFamily = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const k of kids) {
    if (k.tfc_ref) bySaved.set(k.tfc_ref, k.id);
    if (k.status === 'active') {
      const codes = new Set([...PR.expectedTfcLetters(k.first_name, k.last_name),
                             ...PR.expectedTfcLetters(k.preferred_name, k.last_name)]);
      for (const c of codes) push(byLetters, c, k.id);
    }
    if (k.family_key) push(byFamily, k.family_key, k.id);
  }
  const byRef = new Map(refs.map(r => [r.payment_ref, byFamily.get(r.family_key) || []]));
  return { bySaved, byLetters, byRef };
}

function resolveWho(line, ctx) {
  if (!ctx) return null;
  const narrative = [line.description, line.reference, line.payee_name, line.line_item_desc].filter(Boolean).join(' ');
  const tfc = PR.findTfcRefsInText(narrative);
  const saved = [...new Set(tfc.map(r => ctx.bySaved.get(r)).filter(Boolean))];
  if (saved.length === 1) return { kind: 'tfc_ref_saved', childIds: new Set(saved), tfc_ref: tfc[0] };
  if (tfc.length && !saved.length) {
    const ids = [...new Set(tfc.flatMap(r => ctx.byLetters.get(r.slice(0, 4)) || []))];
    if (ids.length) return { kind: 'tfc_name_code', childIds: new Set(ids), tfc_ref: tfc[0] };
  }
  const fam = PR.findRefsInText(narrative).map(h => ctx.byRef.get(h.ref)).filter(a => a && a.length);
  if (fam.length === 1) return { kind: 'family_ref', childIds: new Set(fam[0]) };
  return null;   // nothing, or more than one answer — scored the old way
}

// A manager just confirmed that this line paid this child's invoice. If the line
// quotes a TFC reference, the child has none saved, the letters fit the child's
// name and no other child holds it, keep it — the next payment then matches on the
// saved reference instead of the letters. Never overwrites a reference a parent set.
async function learnTfcRef(db, bankLineId, childId) {
  if (!bankLineId || !childId) return null;
  const { rows: [l] } = await db.query(
    `SELECT description, reference, payee_name, line_item_desc FROM bank_statement_lines WHERE id=$1`, [bankLineId]);
  if (!l) return null;
  const refs = PR.findTfcRefsInText([l.description, l.reference, l.payee_name, l.line_item_desc].filter(Boolean).join(' '));
  if (refs.length !== 1) return null;
  const { rows: [c] } = await db.query(
    `SELECT first_name, last_name, preferred_name, tfc_payment_reference FROM children WHERE id=$1`, [childId]);
  if (!c || String(c.tfc_payment_reference || '').trim()) return null;
  const fits = new Set([...PR.expectedTfcLetters(c.first_name, c.last_name),
                        ...PR.expectedTfcLetters(c.preferred_name, c.last_name)]);
  if (!fits.has(refs[0].slice(0, 4))) return null;
  const { rowCount } = await db.query(
    `UPDATE children SET tfc_payment_reference=$2, tfc_reference_source='bank-reconcile', tfc_reference_set_at=NOW()
      WHERE id=$1 AND NULLIF(btrim(tfc_payment_reference),'') IS NULL
        AND NOT EXISTS (SELECT 1 FROM children o WHERE o.id<>$1 AND upper(btrim(o.tfc_payment_reference))=$2)`,
    [childId, refs[0]]);
  return rowCount ? refs[0] : null;
}

// A payout from a card/DD provider is the SUM of payments already recorded in Wren
// (card payments land via Opayo/Stripe, direct debits via GoCardless). Matching it to
// an invoice records the money twice: on 5 Oct an Opayo payout was confirmed as one
// family's bank transfer and credited them £1,247.82 they never paid. Never suggested.
// Barclaycard merchant settlements arrive as BCARD followed straight by the merchant number.
const PROVIDER_PAYOUT_RE = /\bBCARD\d|\b(BARCLAYCARD|OPAYO|ELAVON|SAGE\s?PAY|WORLDPAY|STRIPE|GOCARDLESS|GO\s?CARDLESS|MERCHANT\s+SERVICES|CARD\s+SETTLEMENT)\b/i;
const looksLikeProviderPayout = (l) =>
  PROVIDER_PAYOUT_RE.test([l.description, l.reference, l.payee_name, l.line_item_desc].filter(Boolean).join(' '));

// ── Reconciliation run ────────────────────────────────────────────────────────
async function runReconciliation(db, statementId = null) {
  const autoThresholdSetting = await getDecryptedSetting('reconcile_auto_threshold').catch(() => null);
  const autoThreshold = parseInt(autoThresholdSetting) || 95;

  // Fetch unreconciled credit lines (only credits = income)
  let lineQuery = `
    SELECT l.*, s.account_name
    FROM bank_statement_lines l
    JOIN bank_statements s ON s.id = l.statement_id
    WHERE l.reconciled = false AND l.amount_pence > 0 AND l.excluded_reason IS NULL
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

  // 2026-10-05: who each line names, and the pairs a manager has already rejected —
  // re-running used to put a rejected suggestion straight back in front of them.
  const whoCtx = await loadWhoContext(db).catch(e => { console.error('[reconcile] who ctx:', e.message); return null; });
  const { rows: rejectedRows } = await db.query(
    `SELECT bank_line_id, invoice_id FROM reconciliation_matches WHERE status='rejected' AND invoice_id IS NOT NULL`);
  const rejected = new Set(rejectedRows.map(r => `${r.bank_line_id}:${r.invoice_id}`));

  let matched = 0, autoConfirmed = 0, queued = 0;

  for (const line of lines) {
    let bestScore = 0, bestInvoice = null, bestPayment = null, bestReasons = [];
    if (looksLikeProviderPayout(line)) continue;
    line._who = resolveWho(line, whoCtx);

    // Score against each open invoice
    for (const inv of openInvoices) {
      if (rejected.has(`${line.id}:${inv.id}`)) continue;
      const { score, reasons } = scoreMatch(line, inv, null);
      if (score > bestScore) {
        bestScore = score; bestInvoice = inv; bestPayment = null; bestReasons = reasons;
      }
    }

    // Score against each open payment that has a linked invoice
    for (const pmt of openPayments) {
      const inv = pmt._invoice;
      if (inv && rejected.has(`${line.id}:${inv.id}`)) continue;
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
      -- A better ENGINE suggestion replaces a weaker pending one (2026-10-05: lines
      -- suggested before TFC/family references counted kept their old guess).
      -- A manager's own pick (match_type 'manual') is never overwritten.
      ON CONFLICT (bank_line_id) WHERE status='pending' DO UPDATE SET
        payment_id = EXCLUDED.payment_id, invoice_id = EXCLUDED.invoice_id,
        match_type = EXCLUDED.match_type, confidence_score = EXCLUDED.confidence_score,
        match_reasons = EXCLUDED.match_reasons
      WHERE reconciliation_matches.match_type IN ('suggested','auto')
        AND EXCLUDED.confidence_score > reconciliation_matches.confidence_score
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
          // paid_on is the date the money moved, which is the statement line's date —
          // NOT created_at, which is when this row happened to be written. Every
          // finance screen orders on paid_on; a payment created without it sorts to
          // the bottom and looks like it never happened (2026-09-04).
          await db.query(`
            INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence,
                                  payment_method, status, description, bank_statement_line_id,
                                  reconciliation_status, confidence_score, paid_on, source, updated_at)
            VALUES ($1,$2,$3,$4,'bank_transfer','succeeded',$5,$6,'reconciled',$7,$8,'bank-reconcile',NOW())
          `, [bestInvoice.id, bestInvoice.child_id, bestInvoice.bill_payer_email,
              Math.abs(line.amount_pence), `Bank transfer: ${line.description}`,
              line.id, bestScore, line.transaction_date]);
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
    const splitCsv = line => line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
    // 2026-10-01 — read the columns by their HEADER, not their position. A Barclays download is
    // "Number,Date,Account,Amount,Subcategory,Memo" (the money is column 4, the payer's text is
    // Memo), so the positional reader below rejected every row. Other banks split money into
    // "Paid in"/"Paid out" or "Money in"/"Money out". With no recognisable header, fall back to
    // the original Date,Description,Amount,Balance[,Reference] order.
    let col = null;
    if (isHeader) {
      const h = splitCsv(lines[0]).map(x => x.toLowerCase());
      const find = (...names) => h.findIndex(x => names.some(n => x === n || x.startsWith(n)));
      col = {
        date: find('date', 'transaction date', 'posting date'),
        desc: find('memo', 'description', 'narrative', 'details', 'transaction description', 'payee'),
        amount: find('amount', 'value'),
        paidIn: find('paid in', 'money in', 'credit', 'credits'),
        paidOut: find('paid out', 'money out', 'debit', 'debits'),
        balance: find('balance'),
        ref: find('reference', 'subcategory', 'type'),
      };
      if (col.date < 0 || col.desc < 0 || (col.amount < 0 && col.paidIn < 0)) col = null;
    }

    const parsed = [];
    let totalCredits = 0, totalDebits = 0, skippedDates = 0;

    for (const line of dataLines) {
      // Support comma and tab separated; handle quoted fields
      const cols = splitCsv(line);
      if (cols.length < 3) continue;

      let dateStr, description, amountStr, balanceStr, refStr;
      if (col) {
        dateStr = cols[col.date]; description = cols[col.desc] || '';
        if (col.amount >= 0) amountStr = cols[col.amount] || '';
        else {
          const inn = parseFloat(String(cols[col.paidIn] || '').replace(/[£,\s]/g, '')) || 0;
          const out = col.paidOut >= 0 ? (parseFloat(String(cols[col.paidOut] || '').replace(/[£,\s]/g, '')) || 0) : 0;
          amountStr = String(inn - Math.abs(out));
        }
        balanceStr = col.balance >= 0 ? cols[col.balance] : '';
        refStr = col.ref >= 0 ? cols[col.ref] : null;
      } else {
        [dateStr, description, amountStr, balanceStr, refStr] = cols;
      }
      if (!amountStr) continue;
      const txYmd = parseStatementDate(dateStr);
      if (!txYmd) { skippedDates++; continue; }

      const amount = parseFloat(amountStr.replace(/[£,\s]/g, ''));
      if (isNaN(amount)) continue;

      const amountPence = Math.round(amount * 100);
      if (amountPence > 0) totalCredits += amountPence;
      else totalDebits += Math.abs(amountPence);

      const balance = balanceStr ? parseFloat(balanceStr.replace(/[£,\s]/g, '')) * 100 : null;
      const provId = crypto.createHash('md5').update(`${dateStr}:${description}:${amountStr}`).digest('hex');

      parsed.push({
        transaction_date: txYmd,
        description,
        amount_pence:  amountPence,
        balance_pence: balance ? Math.round(balance) : null,
        provider_id:   provId,
        reference:     refStr || null,
      });
    }

    if (!parsed.length) return res.status(400).json({ error: 'No valid rows parsed from CSV' });

    // Determine period
    // 'YYYY-MM-DD' sorts correctly as a string; no Date round-trip, no timezone shift.
    const ymds = parsed.map(r => r.transaction_date).sort();
    const minDate = ymds[0], maxDate = ymds[ymds.length - 1];

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

    res.json({ ok: true, statement_id: stmt.id, lines_parsed: parsed.length,
               lines_inserted: inserted, rows_skipped_bad_date: skippedDates });
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
             l.reference AS line_reference, l.payee_name, l.payee_contact_id,
             l.line_item_desc, l.category AS line_category, l.xero_url, l.xero_is_reconciled,
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

// ── GET /api/finance/reconcile/unmatched-lines ────────────────────────────────
// b171 (2026-07-28): the "queue" for the Reconcile UI. Unlike /matches (which
// only shows lines that scored >=30 and got a suggestion row), this returns
// EVERY unreconciled credit line across all statements — including ones the
// engine found no suggestion for at all — with whatever pending suggestion
// (if any) LEFT JOINed on. Without this, lines under the suggestion threshold
// were invisible to the queue and could never be manually cleared.
// b294 (2026-09-09): ?from= / ?to= narrow the queue to a date window. Toby needed
// the incoming payments for 5 Aug – 8 Sep to type into EyLog and the screen had no
// way to ask for them: 214 lines, ordered by date, and nothing else. The window is
// applied in SQL so the LIMIT below counts lines IN the window rather than the most
// recent 200 overall, and `total_matching` is returned separately so a truncated
// list can say so instead of quietly looking complete.
router.get('/unmatched-lines', async (req, res) => {
  const db = getPool();
  try {
    const { from, to } = parseWindow(req.query);
    const params = [];
    let window = '';
    if (from) { params.push(from); window += ` AND l.transaction_date >= $${params.length}`; }
    if (to)   { params.push(to);   window += ` AND l.transaction_date <= $${params.length}`; }
    const { rows } = await db.query(`
      SELECT l.id AS line_id, l.transaction_date, l.description, l.amount_pence,
             l.reference, l.payee_name, l.payee_contact_id, l.line_item_desc,
             l.category AS line_category, l.xero_url, l.xero_is_reconciled,
             s.account_name, s.source, s.id AS statement_id,
             m.id AS match_id, m.status AS match_status, m.confidence_score,
             m.match_type, m.match_reasons,
             i.id AS invoice_id, i.invoice_number, i.amount_pence AS invoice_amount,
             i.due_on, i.bill_payer_email,
             c.first_name || ' ' || c.last_name AS child_name
      FROM bank_statement_lines l
      JOIN bank_statements s ON s.id = l.statement_id
      LEFT JOIN reconciliation_matches m ON m.bank_line_id = l.id AND m.status = 'pending'
      LEFT JOIN invoices i ON i.id = m.invoice_id
      LEFT JOIN children c ON c.id = i.child_id
      WHERE l.reconciled = false AND l.amount_pence > 0 AND l.excluded_reason IS NULL${window}
      ORDER BY l.transaction_date DESC
      LIMIT 200
    `, params);
    const { rows: [tot] } = await db.query(`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(l.amount_pence),0)::bigint AS pence
        FROM bank_statement_lines l
       WHERE l.reconciled = false AND l.amount_pence > 0 AND l.excluded_reason IS NULL${window}
    `, params);
    // 2026-10-05: how many lines a manager has taken out of the queue (refunds, not
    // fees, duplicates) — the screen links to them so a removal can be undone.
    const { rows: [rem] } = await db.query(
      `SELECT COUNT(*)::int AS n FROM bank_statement_lines WHERE excluded_by IS NOT NULL AND amount_pence > 0`)
      .catch(() => ({ rows: [{ n: 0 }] }));
    for (const r of rows) r.looks_provider_payout = looksLikeProviderPayout(r);
    res.json({
      lines: rows,
      summary: {
        total: rows.length,
        total_matching: tot.n,
        truncated: tot.n > rows.length,
        total_pence: Number(tot.pence),
        from: from || null,
        to: to || null,
        with_suggestion: rows.filter(r => r.match_id).length,
        no_suggestion: rows.filter(r => !r.match_id).length,
        removed: rem.n,
      },
    });
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
      // 2026-10-05: the invoice is marked paid AFTER the payment is written, and only
      // if the payments now cover it. It used to be marked paid first, whatever the
      // amount — a part payment then dropped the invoice out of the matcher (which
      // only looks at sent/overdue), so the rest could never be matched to it.
      const markPaidIfCovered = () => db.query(`
        UPDATE invoices i SET status='paid', paid_on=$1, updated_at=NOW()
         WHERE i.id=$2 AND i.status != 'paid'
           AND (SELECT COALESCE(SUM(p.amount_pence),0) FROM payments p
                 WHERE p.invoice_id=i.id AND p.status='succeeded') >= i.amount_pence`,
        [match.transaction_date, match.invoice_id]);
      if (match.payment_id) {
        await db.query(
          `UPDATE payments SET reconciliation_status='reconciled', bank_statement_line_id=$1 WHERE id=$2`,
          [match.bank_line_id, match.payment_id]
        );
      } else {
        // Same rule as the auto path: paid_on is the statement line's date. Without
        // it the payment lands with a NULL date and every finance list, which now
        // orders on COALESCE(paid_on, created_at), buries it (2026-09-04).
        await db.query(`
          INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence,
                                payment_method, status, description, bank_statement_line_id,
                                reconciliation_status, paid_on, source, updated_at)
          VALUES ($1,$2,$3,$4,'bank_transfer','succeeded',$5,$6,'reconciled',$7,'bank-reconcile',NOW())
        `, [match.invoice_id, match.child_id, match.bill_payer_email,
            Math.abs(match.line_amount), `Reconciled bank transfer`, match.bank_line_id,
            match.transaction_date]);
        // 2026-10-06 — the family sees it arrive (in-app bell only, never email).
        await require('../lib/parent-payment-notice').notifyPaymentReceived(
          db, match.child_id, match.line_amount, { onDate: match.transaction_date }).catch(() => {});
      }
      await markPaidIfCovered();
    }

    await db.query(`
      INSERT INTO reconciliation_audit (event_type, bank_line_id, payment_id, invoice_id, match_id, actor_id)
      VALUES ('manual_match',$1,$2,$3,$4,$5)
    `, [match.bank_line_id, match.payment_id, match.invoice_id, match.id, req.user.id]);

    recordAudit({ req, action: 'confirm', entity_type: 'reconciliation_match', entity_id: match.id });
    const learnt = await learnTfcRef(db, match.bank_line_id, match.child_id).catch(() => null);
    // 2026-10-28: remember this payer for this family, and put the money on the account.
    const BA = require('../lib/bank-autopilot');
    const payerLearnt = await BA.learnPayer(db, match.bank_line_id, match.child_id, req.user.id).catch(() => null);
    BA.allocateSoon(db, match.child_id);
    res.json({ ok: true, tfc_reference_saved: !!learnt, payer_remembered: !!payerLearnt });
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

// ── POST /api/finance/reconcile/lines/:id/manual-match ────────────────────────
// Manager picks a specific invoice for a bank line (whether or not the engine
// already suggested one). Creates/replaces the line's *pending* suggestion —
// still requires an explicit Confirm afterwards, same as an auto-suggested
// match, so a bad manual pick can be corrected before anything is written to
// invoices/payments.
router.post('/lines/:id/manual-match', async (req, res) => {
  const db = getPool();
  const lineId = parseInt(req.params.id);
  const { invoice_id } = req.body || {};
  try {
    if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

    const { rows: [line] } = await db.query('SELECT * FROM bank_statement_lines WHERE id=$1', [lineId]);
    if (!line) return res.status(404).json({ error: 'Bank line not found' });
    if (line.reconciled) return res.status(400).json({ error: 'Line is already reconciled' });

    const { rows: [inv] } = await db.query(`
      SELECT i.id, i.invoice_number, i.amount_pence, i.status,
             c.first_name || ' ' || c.last_name AS child_name
      FROM invoices i JOIN children c ON c.id = i.child_id WHERE i.id = $1
    `, [invoice_id]);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    // Supersede any existing pending suggestion for this line, then insert the
    // manual one as the new pending suggestion (idempotent thanks to the
    // partial unique index on (bank_line_id) WHERE status='pending').
    await db.query(`UPDATE reconciliation_matches SET status='superseded' WHERE bank_line_id=$1 AND status='pending'`, [lineId]);

    const { rows: [match] } = await db.query(`
      INSERT INTO reconciliation_matches (bank_line_id, invoice_id, match_type, confidence_score, match_reasons, status)
      VALUES ($1,$2,'manual',100,'["manual_override"]'::jsonb,'pending')
      ON CONFLICT (bank_line_id) WHERE status='pending' DO UPDATE SET
        invoice_id = EXCLUDED.invoice_id, match_type = 'manual',
        confidence_score = 100, match_reasons = '["manual_override"]'::jsonb
      RETURNING id
    `, [lineId, invoice_id]);

    await db.query(`
      INSERT INTO reconciliation_audit (event_type, bank_line_id, invoice_id, match_id, actor_id, confidence, detail)
      VALUES ('manual_match_proposed',$1,$2,$3,$4,100,$5::jsonb)
    `, [lineId, invoice_id, match.id, req.user.id, JSON.stringify({ invoice_number: inv.invoice_number })]);

    recordAudit({ req, action: 'manual_match', entity_type: 'reconciliation_match', entity_id: match.id });
    res.json({ ok: true, match_id: match.id, invoice_number: inv.invoice_number, child_name: inv.child_name });
  } catch (e) {
    console.error('[finance-reconcile] manual-match error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/reconcile/lines/:id/split ────────────────────────────────
// Allocate one bank line across multiple invoices (e.g. one bank transfer
// covering two siblings' fees). Each allocation becomes its own payment +
// confirmed match; the bank line is reconciled once any (even partial)
// allocations are recorded — full-invoice-amount allocations mark that
// invoice paid, partial ones just record the payment (no partial-paid status
// exists on invoices in this schema).
router.post('/lines/:id/split', async (req, res) => {
  const db = getPool();
  const lineId = parseInt(req.params.id);
  const { allocations } = req.body || {};
  try {
    if (!Array.isArray(allocations) || !allocations.length) {
      return res.status(400).json({ error: 'allocations[] required' });
    }
    const { rows: [line] } = await db.query('SELECT * FROM bank_statement_lines WHERE id=$1', [lineId]);
    if (!line) return res.status(404).json({ error: 'Bank line not found' });
    if (line.reconciled) return res.status(400).json({ error: 'Line is already reconciled' });
    if (line.amount_pence <= 0) return res.status(400).json({ error: 'Only credit lines can be split-matched' });

    const totalAlloc = allocations.reduce((s, a) => s + (parseInt(a.amount_pence) || 0), 0);
    if (totalAlloc <= 0) return res.status(400).json({ error: 'Allocations must total more than £0' });
    if (totalAlloc > line.amount_pence) {
      return res.status(400).json({ error: `Allocations total more than the bank line (£${(totalAlloc/100).toFixed(2)} vs £${(line.amount_pence/100).toFixed(2)})` });
    }

    const created = [];
    for (const a of allocations) {
      const invoiceId = parseInt(a.invoice_id);
      const amt = parseInt(a.amount_pence);
      if (!invoiceId || !amt || amt <= 0) continue;

      const { rows: [inv] } = await db.query(
        'SELECT id, child_id, bill_payer_email, amount_pence FROM invoices WHERE id=$1', [invoiceId]
      );
      if (!inv) continue;

      const { rows: [pmt] } = await db.query(`
        INSERT INTO payments (invoice_id, child_id, bill_payer_email, amount_pence, payment_method,
                              status, description, bank_statement_line_id, reconciliation_status,
                              confidence_score, paid_on, source, updated_at)
        VALUES ($1,$2,$3,$4,'bank_transfer','succeeded',$5,$6,'reconciled',100,$7,'bank-reconcile',NOW())
        RETURNING id
      `, [invoiceId, inv.child_id, inv.bill_payer_email, amt,
          `Split allocation from bank line #${lineId}`, lineId, line.transaction_date]);   // 2026-10-06: paid_on + source were missing
      await require('../lib/parent-payment-notice').notifyPaymentReceived(
        db, inv.child_id, amt, { onDate: line.transaction_date }).catch(() => {});

      const { rows: [match] } = await db.query(`
        INSERT INTO reconciliation_matches (bank_line_id, payment_id, invoice_id, match_type,
                                            confidence_score, match_reasons, status, confirmed_by, confirmed_at)
        VALUES ($1,$2,$3,'split',100,'["manual_split"]'::jsonb,'confirmed',$4,NOW())
        RETURNING id
      `, [lineId, pmt.id, invoiceId, req.user.id]);

      const { rows: [paidAgg] } = await db.query(
        `SELECT COALESCE(SUM(amount_pence),0) AS paid FROM payments WHERE invoice_id=$1 AND status='succeeded'`,
        [invoiceId]
      );
      if (parseInt(paidAgg.paid, 10) >= inv.amount_pence) {
        await db.query(
          `UPDATE invoices SET status='paid', paid_on=$1, updated_at=NOW() WHERE id=$2 AND status != 'paid'`,
          [line.transaction_date, invoiceId]
        );
      }

      await db.query(`
        INSERT INTO reconciliation_audit (event_type, bank_line_id, payment_id, invoice_id, match_id, actor_id, confidence, detail)
        VALUES ('split_match',$1,$2,$3,$4,$5,100,$6::jsonb)
      `, [lineId, pmt.id, invoiceId, match.id, req.user.id, JSON.stringify({ amount_pence: amt })]);

      created.push({ invoice_id: invoiceId, payment_id: pmt.id, match_id: match.id, amount_pence: amt });
    }

    if (!created.length) return res.status(400).json({ error: 'No valid allocations processed' });

    await db.query(`UPDATE reconciliation_matches SET status='superseded' WHERE bank_line_id=$1 AND status='pending'`, [lineId]);
    await db.query(`UPDATE bank_statement_lines SET reconciled=true, reconciled_at=NOW() WHERE id=$1`, [lineId]);
    await db.query(`
      UPDATE bank_statements
      SET reconciled_count = (SELECT COUNT(*) FROM bank_statement_lines WHERE statement_id=$1 AND reconciled=true)
      WHERE id=$1
    `, [line.statement_id]);

    recordAudit({ req, action: 'split_match', entity_type: 'bank_statement_line', entity_id: lineId,
      meta: { allocations: created.length, total_pence: totalAlloc } });

    // 2026-10-28: a split line is still one payer — put each family's money on its account.
    try {
      const { rows: kids } = await db.query(
        `SELECT DISTINCT child_id FROM payments WHERE bank_statement_line_id = $1 AND child_id IS NOT NULL`, [lineId]);
      const BA = require('../lib/bank-autopilot');
      for (const k of kids) BA.allocateSoon(db, k.child_id);
    } catch (_) { /* allocation is re-run by the 15-minute sweep anyway */ }

    res.json({ ok: true, allocations: created });
  } catch (e) {
    console.error('[finance-reconcile] split error:', e.message);
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
             to_char(p.paid_on, 'YYYY-MM-DD') AS paid_on_ymd,
             i.invoice_number, i.period_label,
             c.first_name || ' ' || c.last_name AS child_name
      FROM payments p
      LEFT JOIN invoices i ON i.id = p.invoice_id
      LEFT JOIN children c ON c.id = p.child_id
      ${where}
      ORDER BY COALESCE(p.paid_on, p.created_at::date) DESC, p.id DESC
      LIMIT $${qp.length - 1} OFFSET $${qp.length}
    `, qp);
    res.json({ payments: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 2026-10-05: take a line out of the queue (refunds, not fees, duplicates) ──
// Toby, reconciling: "some are refunds etc, so allow option to remove." The line is
// set aside, not deleted — excluded_by marks it as a person's decision, and only
// those can be put back (the Xero-copy set-asides stay set aside: restoring one
// would double-count a Barclays payment).
const REMOVE_REASONS = {
  refund:    'Refund',
  not_fees:  'Not a fee payment',
  duplicate: 'Duplicate of another line',
  transfer:  'Transfer between our own accounts',
  payout:    'Card / Direct Debit payout — those payments are already recorded',
  other:     'Other',
};
router.post('/lines/:id/remove', async (req, res) => {
  const db = getPool();
  const lineId = parseInt(req.params.id);
  const code = String(req.body?.reason || '');
  const note = String(req.body?.note || '').trim().slice(0, 300);
  if (!REMOVE_REASONS[code]) return res.status(400).json({ error: 'Pick a reason' });
  if (code === 'other' && !note) return res.status(400).json({ error: 'Say what it is' });
  try {
    const { rows: [line] } = await db.query('SELECT id, reconciled, excluded_reason FROM bank_statement_lines WHERE id=$1', [lineId]);
    if (!line) return res.status(404).json({ error: 'Bank line not found' });
    if (line.reconciled) return res.status(400).json({ error: 'That line is already matched — unmatch it first' });
    if (line.excluded_reason) return res.status(400).json({ error: 'Already out of the queue' });
    const reason = REMOVE_REASONS[code] + (note ? ` — ${note}` : '');
    await db.query(`UPDATE bank_statement_lines SET excluded_reason=$2, excluded_by=$3, excluded_at=NOW() WHERE id=$1`,
      [lineId, reason, req.user.id]);
    await db.query(`UPDATE reconciliation_matches SET status='superseded' WHERE bank_line_id=$1 AND status='pending'`, [lineId]);
    await db.query(`INSERT INTO reconciliation_audit (event_type, bank_line_id, actor_id, detail) VALUES ('line_removed',$1,$2,$3::jsonb)`,
      [lineId, req.user.id, JSON.stringify({ reason: code, note })]);
    recordAudit({ req, action: 'remove', entity_type: 'bank_statement_line', entity_id: lineId, meta: { reason: code } });
    res.json({ ok: true });
  } catch (e) {
    console.error('[finance-reconcile] remove error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/removed-lines', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT l.id AS line_id, l.transaction_date, l.description, l.amount_pence, l.reference, l.payee_name,
             l.excluded_reason, l.excluded_at, s.first_name AS removed_by
        FROM bank_statement_lines l LEFT JOIN staff s ON s.id = l.excluded_by
       WHERE l.excluded_by IS NOT NULL AND l.amount_pence > 0
       ORDER BY l.excluded_at DESC LIMIT 200`);
    res.json({ lines: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lines/:id/restore', async (req, res) => {
  const db = getPool();
  const lineId = parseInt(req.params.id);
  try {
    const { rowCount } = await db.query(
      `UPDATE bank_statement_lines SET excluded_reason=NULL, excluded_by=NULL, excluded_at=NULL
        WHERE id=$1 AND excluded_by IS NOT NULL AND reconciled=false`, [lineId]);
    if (!rowCount) return res.status(400).json({ error: 'Only a line a person removed can be put back' });
    await db.query(`INSERT INTO reconciliation_audit (event_type, bank_line_id, actor_id) VALUES ('line_restored',$1,$2)`, [lineId, req.user.id]);
    recordAudit({ req, action: 'restore', entity_type: 'bank_statement_line', entity_id: lineId });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 2026-10-05: what has been matched lately, and Undo ───────────────────────
// Two of the first day's confirmations were wrong (a card payout taken as one family's
// transfer; one transfer for twins put on one twin) and had to be unpicked by hand.
// Undo reverses what the match WROTE — the payment it created is marked 'reversed'
// (never deleted), a pre-existing payment it linked goes back to unreconciled, a
// deposit it recorded is marked waived, an invoice it marked paid goes back to sent
// if what is left no longer covers it — and puts the line back in the queue. The pair
// is recorded as rejected, so matching does not suggest it again.
router.get('/recent-matches', async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days) || 14, 1), 90);
  try {
    const { rows } = await getPool().query(`
      SELECT l.id AS line_id, l.transaction_date, l.description, l.amount_pence, l.reconciled_at,
             (SELECT json_agg(json_build_object('child', c.first_name || ' ' || c.last_name,
                                                'invoice', i.invoice_number, 'amount_pence', p.amount_pence)
                              ORDER BY p.id)
                FROM payments p LEFT JOIN children c ON c.id = p.child_id LEFT JOIN invoices i ON i.id = p.invoice_id
               WHERE p.bank_statement_line_id = l.id AND p.status = 'succeeded') AS payments,
             (SELECT json_agg(json_build_object('who', COALESCE(c.first_name || ' ' || c.last_name,
                                                 w.child_first_name || ' ' || w.child_last_name), 'amount_pence', d.amount_pence))
                FROM child_deposits d LEFT JOIN children c ON c.id = d.child_id LEFT JOIN waiting_list w ON w.id = d.waiting_list_id
               WHERE d.bank_line_id = l.id AND d.status IN ('paid','credited')) AS deposits
        FROM bank_statement_lines l
       WHERE l.reconciled AND l.amount_pence > 0 AND l.reconciled_at > NOW() - ($1 || ' days')::interval
       ORDER BY l.reconciled_at DESC LIMIT 200`, [String(days)]);
    res.json({ lines: rows, days });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lines/:id/unmatch', async (req, res) => {
  const db = getPool();
  const lineId = parseInt(req.params.id);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [line] } = await client.query(
      'SELECT id, reconciled, statement_id FROM bank_statement_lines WHERE id=$1 FOR UPDATE', [lineId]);
    if (!line) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Bank line not found' }); }
    if (!line.reconciled) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'That line is not matched' }); }

    const { rows: created } = await client.query(`
      UPDATE payments SET status='reversed', reconciliation_status='reversed', updated_at=NOW(),
             reconciliation_note = COALESCE(reconciliation_note || ' · ', '') || 'match undone ' || to_char(NOW(),'YYYY-MM-DD')
       WHERE bank_statement_line_id=$1 AND source='bank-reconcile' AND status='succeeded'
       RETURNING invoice_id`, [lineId]);
    const { rows: linked } = await client.query(`
      UPDATE payments SET reconciliation_status='unreconciled', bank_statement_line_id=NULL
       WHERE bank_statement_line_id=$1 AND COALESCE(source,'') <> 'bank-reconcile' AND status='succeeded'
       RETURNING invoice_id`, [lineId]);
    const { rows: deps } = await client.query(`
      UPDATE child_deposits SET status='waived', notes = COALESCE(notes || ' · ', '') || 'recorded from Reconcile in error — undone'
       WHERE bank_line_id=$1 AND status IN ('paid','credited') RETURNING waiting_list_id, amount_pence`, [lineId]);
    for (const d of deps) {
      if (d.waiting_list_id) await client.query(`
        UPDATE waiting_list SET deposit_amount_pence = GREATEST(COALESCE(deposit_amount_pence,0) - $2, 0),
               deposit_paid = GREATEST(COALESCE(deposit_amount_pence,0) - $2, 0) > 0 WHERE id=$1`, [d.waiting_list_id, d.amount_pence]);
    }
    const invIds = [...new Set([...created, ...linked].map(r => r.invoice_id).filter(Boolean))];
    if (invIds.length) await client.query(`
      UPDATE invoices i SET status='sent', paid_on=NULL, updated_at=NOW()
       WHERE i.id = ANY($1::int[]) AND i.status='paid'
         AND (SELECT COALESCE(SUM(p.amount_pence),0) FROM payments p WHERE p.invoice_id=i.id AND p.status='succeeded') < i.amount_pence`,
      [invIds]);
    await client.query(`UPDATE reconciliation_matches SET status='rejected', rejected_reason='match undone'
                         WHERE bank_line_id=$1 AND status='confirmed'`, [lineId]);
    await client.query(`UPDATE bank_statement_lines SET reconciled=false, reconciled_at=NULL WHERE id=$1`, [lineId]);
    await client.query(`
      UPDATE bank_statements SET reconciled_count = (SELECT COUNT(*) FROM bank_statement_lines WHERE statement_id=$1 AND reconciled=true)
       WHERE id=$1`, [line.statement_id]);
    await client.query(`INSERT INTO reconciliation_audit (event_type, bank_line_id, actor_id, detail) VALUES ('match_undone',$1,$2,$3::jsonb)`,
      [lineId, req.user.id, JSON.stringify({ payments_reversed: created.length, payments_unlinked: linked.length, deposits_waived: deps.length, invoices: invIds })]);
    await client.query('COMMIT');
    recordAudit({ req, action: 'unmatch', entity_type: 'bank_statement_line', entity_id: lineId });
    res.json({ ok: true, payments_reversed: created.length, deposits_waived: deps.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[finance-reconcile] unmatch error:', e.message);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── 2026-10-05: a payment that is a DEPOSIT ──────────────────────────────────
// "One of the payments was for a child on the waiting list — allow these to be
// added as a deposit." The deposit lands in child_deposits (the one deposit ledger)
// against the waiting-list entry, or against a child already on roll. It is held,
// not income against an invoice, so no payment row and no invoice is touched.
router.get('/deposit-candidates', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json({ candidates: [] });
  const like = `%${q.toLowerCase()}%`;
  try {
    const db = getPool();
    const [{ rows: wl }, { rows: kids }, { rows: enq }] = await Promise.all([
      db.query(`SELECT id, child_first_name || ' ' || child_last_name AS name, room_needed AS room,
                       to_char(expected_start_date,'YYYY-MM-DD') AS start, status, deposit_paid
                  FROM waiting_list
                 WHERE archived_at IS NULL AND merged_into_id IS NULL
                   AND lower(child_first_name || ' ' || child_last_name || ' ' || COALESCE(parent_name,'')) LIKE $1
                 ORDER BY expected_start_date NULLS LAST LIMIT 10`, [like]),
      // 2026-10-06: 'pending' too — a child who has registered but not started yet is
      // exactly who pays a deposit. Only 'active' was searched, so they were invisible.
      db.query(`SELECT c.id, c.first_name || ' ' || c.last_name AS name, r.name AS room,
                       to_char(c.start_date,'YYYY-MM-DD') AS start, c.status
                  FROM children c LEFT JOIN rooms r ON r.id = c.room_id
                 WHERE c.status IN ('active','pending') AND lower(c.first_name || ' ' || c.last_name) LIKE $1
                 ORDER BY c.last_name LIMIT 10`, [like]),
      // 2026-10-06: families still on the admissions PIPELINE with no waiting-list entry
      // ("offer accepted" on the pipeline is not the same as being on the waiting list).
      // Picking one creates their waiting-list entry from the enquiry (see /deposit).
      db.query(`SELECT e.id, e.child_first_name || ' ' || e.child_last_name AS name, e.stage,
                       COALESCE(e.preferred_room, e.room_needed) AS room,
                       to_char(COALESCE(e.preferred_start_date, e.start_date_requested),'YYYY-MM-DD') AS start
                  FROM enquiries e
                 WHERE e.stage NOT IN ('lost','declined','registered')
                   AND NOT EXISTS (SELECT 1 FROM waiting_list w WHERE w.enquiry_id = e.id)
                   AND lower(COALESCE(e.child_first_name,'') || ' ' || COALESCE(e.child_last_name,'') || ' ' || COALESCE(e.parent_name,'')) LIKE $1
                 ORDER BY e.updated_at DESC NULLS LAST LIMIT 10`, [like]).catch(() => ({ rows: [] })),
    ]).then(r => r);
    res.json({ candidates: [
      ...wl.map(w => ({ kind: 'waiting_list', ...w })),
      ...kids.map(k => ({ kind: 'child', ...k })),
      ...enq.map(e => ({ kind: 'enquiry', ...e })),
    ] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/lines/:id/deposit', async (req, res) => {
  const db = getPool();
  const lineId = parseInt(req.params.id);
  let wlId = parseInt(req.body?.waiting_list_id) || null;
  const childId = parseInt(req.body?.child_id) || null;
  const enquiryId = parseInt(req.body?.enquiry_id) || null;
  if ([wlId, childId, enquiryId].filter(Boolean).length !== 1) return res.status(400).json({ error: 'Pick one family' });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (enquiryId) {
      // A pipeline family with no waiting-list entry: make the entry from the enquiry,
      // the same row "Convert to waiting list" would make (and the same family_key
      // conflict rule, so no duplicate), but leave the pipeline stage where it is —
      // an accepted offer must not slide back to "on waiting list".
      const { rows: [w] } = await client.query(`
        INSERT INTO waiting_list (child_first_name, child_last_name, child_dob, room_needed,
          expected_start_date, parent_name, parent_email, parent_phone, source, notes, enquiry_id, family_key, status, offer_status)
        SELECT e.child_first_name, e.child_last_name, e.child_dob, COALESCE(e.preferred_room, e.room_needed),
               COALESCE(e.preferred_start_date, e.start_date_requested), e.parent_name, e.parent_email, e.parent_phone,
               e.source, e.notes, e.id, wl_family_key(e.child_first_name::text, e.child_last_name::text, e.parent_email::text),
               'waiting', CASE WHEN e.stage = 'offer_accepted' THEN 'accepted' END
          FROM enquiries e WHERE e.id = $1
        ON CONFLICT (family_key) WHERE family_key IS NOT NULL AND merged_into_id IS NULL
        DO UPDATE SET enquiry_id = COALESCE(waiting_list.enquiry_id, EXCLUDED.enquiry_id)
        RETURNING id`, [enquiryId]);
      if (!w) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Enquiry not found' }); }
      wlId = w.id;
    }
    const { rows: [line] } = await client.query(
      'SELECT id, amount_pence, transaction_date, reconciled, excluded_reason, statement_id FROM bank_statement_lines WHERE id=$1 FOR UPDATE', [lineId]);
    if (!line) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Bank line not found' }); }
    if (line.reconciled || line.excluded_reason) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'That line is no longer in the queue' }); }
    if (line.amount_pence <= 0) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Only money in can be a deposit' }); }
    if (wlId) {
      const { rows: [w] } = await client.query('SELECT id FROM waiting_list WHERE id=$1', [wlId]);
      if (!w) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Waiting-list entry not found' }); }
    } else {
      const { rows: [c] } = await client.query('SELECT id FROM children WHERE id=$1', [childId]);
      if (!c) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Child not found' }); }
    }
    const { rows: [dep] } = await client.query(`
      INSERT INTO child_deposits (child_id, waiting_list_id, bank_line_id, amount_pence, status, paid_date, notes, created_by)
      VALUES ($1,$2,$3,$4,'paid',$5,$6,$7) RETURNING id`,
      [childId, wlId, lineId, line.amount_pence, line.transaction_date,
       'Deposit received by bank transfer — recorded from Reconcile', req.user.id]);
    if (wlId) {
      await client.query(
        `UPDATE waiting_list SET deposit_paid=true,
                deposit_amount_pence = COALESCE(deposit_amount_pence,0) + $2 WHERE id=$1`, [wlId, line.amount_pence]);
    } else {
      // 2026-10-05 (Toby): "we don't hold onto these" — a child on roll gets the deposit
      // straight onto their account as a payment. A waiting-list deposit waits for the
      // child record and is applied when they start (enquiries.js / onboarding.js).
      await applyDepositToAccount(client, dep.id, { onDate: line.transaction_date, source: 'bank-reconcile', bankLineId: lineId });
    }
    await client.query(`UPDATE reconciliation_matches SET status='superseded' WHERE bank_line_id=$1 AND status='pending'`, [lineId]);
    await client.query(`UPDATE bank_statement_lines SET reconciled=true, reconciled_at=NOW() WHERE id=$1`, [lineId]);
    await client.query(`
      UPDATE bank_statements SET reconciled_count = (SELECT COUNT(*) FROM bank_statement_lines WHERE statement_id=$1 AND reconciled=true)
       WHERE id=$1`, [line.statement_id]);
    await client.query(`INSERT INTO reconciliation_audit (event_type, bank_line_id, actor_id, detail) VALUES ('deposit_recorded',$1,$2,$3::jsonb)`,
      [lineId, req.user.id, JSON.stringify({ deposit_id: dep.id, waiting_list_id: wlId, child_id: childId })]);
    await client.query('COMMIT');
    recordAudit({ req, action: 'deposit', entity_type: 'bank_statement_line', entity_id: lineId, meta: { deposit_id: dep.id } });
    // b428 — a deposit settled here is one half of "Registration forms &
    // deposits received"; the other routes that can mark a deposit paid
    // already call tryAdvanceToRegistered, this one didn't. Resolve the
    // enquiry from whichever of waiting_list/child we were given.
    try {
      let advanceEnquiryId = enquiryId;
      if (!advanceEnquiryId && wlId) {
        const { rows: [w] } = await db.query('SELECT enquiry_id FROM waiting_list WHERE id=$1', [wlId]);
        advanceEnquiryId = w && w.enquiry_id;
      } else if (!advanceEnquiryId && childId) {
        const { rows: [c] } = await db.query('SELECT enquiry_id FROM children WHERE id=$1', [childId]);
        advanceEnquiryId = c && c.enquiry_id;
      }
      if (advanceEnquiryId) await tryAdvanceToRegistered(db, advanceEnquiryId, { req, reason: 'deposit reconciled from bank statement' });
    } catch (e) { console.error('[finance-reconcile] tryAdvanceToRegistered failed:', e.message); }
    res.json({ ok: true, deposit_id: dep.id });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[finance-reconcile] deposit error:', e.message);
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
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

// ── b294 (2026-09-09): the date window, and the export that goes with it ─────
// Toby needed "the incoming payments for 5 Aug – 8 Sep" so he could type them
// into EyLog, and the Reconcile screen offered neither a filter nor a download.
//
// Dates arrive as YYYY-MM-DD from the two <input type="date"> fields. They are
// validated as text and never turned into a Date — parseStatementDate at the top
// of this file exists because new Date('05/08/2026') is 8 MAY, and the same trap
// would apply here. Anything unparseable is ignored rather than guessed at, so a
// malformed query returns the unfiltered queue instead of an empty one that
// looks like "nothing to reconcile".
function parseWindow(q) {
  const clean = v => {
    const s = String(v || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    const probe = new Date(Date.UTC(y, m - 1, d));
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return null;
    return s;
  };
  let from = clean(q.from), to = clean(q.to);
  if (from && to && from > to) { const t = from; from = to; to = t; }   // swapped by hand
  return { from, to };
}

// ── GET /api/finance/reconcile/export.csv?from=&to=&scope=unreconciled|all ───
// The same shape scripts/export-unreconciled-credits.js already produces —
// Date, Payee, Description, Reference, Amount GBP, Reconciled in Wren — because
// that is the shape Toby has already been retyping from. `scope=all` includes
// lines already reconciled in Wren (which is what "the incoming payments for
// this window" actually means when the point is to key them into EyLog);
// `scope=unreconciled` matches exactly what the queue on screen is showing.
//
// Manager-gated by the router-wide guard above. Served as an attachment with
// no-store, streamed from the query and never written to disk.
router.get('/export.csv', async (req, res) => {
  const db = getPool();
  try {
    const { from, to } = parseWindow(req.query);
    const scope = req.query.scope === 'all' ? 'all' : 'unreconciled';
    const params = [];
    let where = 'l.amount_pence > 0';
    if (scope === 'unreconciled') where += ' AND l.reconciled = false';
    if (from) { params.push(from); where += ` AND l.transaction_date >= $${params.length}`; }
    if (to)   { params.push(to);   where += ` AND l.transaction_date <= $${params.length}`; }
    const { rows } = await db.query(`
      SELECT l.transaction_date, COALESCE(l.payee_name,'') AS payee,
             COALESCE(l.description,'') AS description, COALESCE(l.reference,'') AS reference,
             (l.amount_pence/100.0)::numeric(12,2) AS amount_gbp,
             CASE WHEN l.reconciled THEN 'yes' ELSE 'no' END AS reconciled
        FROM bank_statement_lines l
       WHERE ${where}
       ORDER BY l.transaction_date, l.id`, params);

    const esc = v => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const ymd = v => {
      if (!v) return '';
      if (v instanceof Date) {
        const p = n => String(n).padStart(2, '0');
        return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
      }
      return String(v).slice(0, 10);
    };
    const lines = ['Date,Payee,Description,Reference,Amount GBP,Reconciled in Wren'];
    for (const r of rows) {
      lines.push([ymd(r.transaction_date), r.payee, r.description, r.reference,
                  r.amount_gbp, r.reconciled].map(esc).join(','));
    }
    const name = `payments-in-${from || 'start'}-to-${to || 'today'}.csv`;
    recordAudit({ req, action: 'export', entity_type: 'bank_statement_line',
      meta: { feature: 'reconcile-export', rows: rows.length, from, to, scope } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send('\ufeff' + lines.join('\r\n') + '\r\n');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
// Exported so the matcher can be driven from a script or a job without going
// through the HTTP route (which needs a manager JWT). The router is still the
// module's default export; this only hangs a function off it.
module.exports.runReconciliation = runReconciliation;
