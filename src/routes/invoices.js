const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const N8N_BASE = process.env.N8N_URL || 'http://n8n:5678';

// GET /api/invoices/summary — for cockpit card
router.get('/summary', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [totals] } = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ('sent','overdue') THEN amount_pence ELSE 0 END), 0) AS outstanding_pence,
         COUNT(CASE WHEN status = 'overdue' THEN 1 END) AS overdue_count
       FROM invoices`
    );
    const { rows: overdue } = await db.query(
      `SELECT i.id, i.amount_pence, i.due_on, i.bill_payer_email,
              c.first_name || ' ' || c.last_name AS child_name
       FROM invoices i
       LEFT JOIN children c ON c.id = i.child_id
       WHERE i.status = 'overdue'
       ORDER BY i.due_on ASC LIMIT 3`
    );
    const today = new Date();
    overdue.forEach(r => {
      r.days_overdue = r.due_on ? Math.max(0, Math.floor((today - new Date(r.due_on)) / 86400000)) : 0;
    });
    res.json({
      outstanding_pence: parseInt(totals.outstanding_pence),
      overdue_count: parseInt(totals.overdue_count),
      overdue,
    });
  } catch (err) {
    console.error('invoices summary error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/invoices
router.get('/', async (req, res) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  try {
    const { status } = req.query;
    let q = `SELECT i.*, c.first_name || ' ' || c.last_name AS child_name
             FROM invoices i LEFT JOIN children c ON c.id = i.child_id WHERE 1=1`;
    const params = [];
    if (status) { params.push(status); q += ` AND i.status = $${params.length}`; }
    q += ' ORDER BY i.due_on ASC NULLS LAST, i.created_at DESC';
    const { rows } = await db.query(q, params);
    const today = new Date();
    rows.forEach(r => {
      r.days_overdue = (r.due_on && r.status === 'overdue')
        ? Math.max(0, Math.floor((today - new Date(r.due_on)) / 86400000))
        : 0;
    });
    res.json(rows);
  } catch (err) {
    console.error('invoices GET error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// POST /api/invoices/:id/send-reminder
router.post('/:id/send-reminder', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [inv] } = await db.query('SELECT * FROM invoices WHERE id = $1', [req.params.id]);
    if (!inv) return res.status(404).json({ error: 'Not found' });

    try {
      await fetch(`${N8N_BASE}/webhook/invoice-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invoice_id: inv.id,
          child_id: inv.child_id,
          amount_pence: inv.amount_pence,
          bill_payer_email: inv.bill_payer_email,
          due_on: inv.due_on,
        }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {} // n8n webhook may not exist yet — best effort

    res.json({ ok: true, invoice_id: inv.id });
  } catch (err) {
    console.error('invoice reminder error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /bulk-print — combined printable HTML of filtered invoices
router.get('/bulk-print', async (req, res) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  const { month, child_id } = req.query; // month = YYYY-MM
  const db = getPool();
  try {
    let q = `SELECT i.*, c.first_name || ' ' || c.last_name AS child_name, c.date_of_birth
             FROM invoices i LEFT JOIN children c ON c.id = i.child_id WHERE 1=1`;
    const params = [];
    if (month) { params.push(month); q += ` AND TO_CHAR(i.due_on, 'YYYY-MM') = $${params.length}`; }
    if (child_id) { params.push(child_id); q += ` AND i.child_id = $${params.length}`; }
    q += ' ORDER BY i.due_on ASC NULLS LAST, i.created_at DESC';
    const { rows } = await db.query(q, params);

    const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const fmtMoney = p => '£' + ((p || 0) / 100).toLocaleString('en-GB', {minimumFractionDigits:2, maximumFractionDigits:2});
    const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) : '—';
    const title = `Invoices ${month||''} ${child_id?'(filtered)':''}`.trim();

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:900px;margin:20px auto;padding:20px;background:#f8fafc}
h1{font-size:22px;margin-bottom:6px;color:#0f172a}
.meta{font-size:13px;color:#64748b;margin-bottom:20px}
.invoice{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin-bottom:12px;page-break-inside:avoid}
.invoice-header{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px}
.invoice-title{font-weight:600;font-size:16px;color:#0f172a}
.invoice-amount{font-size:20px;font-weight:700;color:#0f172a}
.field{display:grid;grid-template-columns:140px 1fr;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9;font-size:14px}
.field:last-child{border:none}
.field-label{color:#64748b;font-weight:500}
.field-value{color:#0f172a}
.status-draft{color:#64748b}.status-sent{color:#4a9abf}.status-paid{color:#22c55e}.status-overdue{color:#ef4444}.status-written_off{color:#94a3b8}
.total-row{display:flex;justify-content:space-between;padding:16px;background:#f8fafc;border-radius:8px;margin-top:20px;font-weight:700;font-size:18px}
@media print{body{background:#fff;margin:0}}
</style>
</head><body>
<h1>${esc(title)}</h1>
<div class="meta">Generated ${new Date().toLocaleString('en-GB')} | ${rows.length} invoice(s)</div>
${rows.length === 0 ? '<p style="color:#64748b">No invoices found for the selected filters.</p>' :
  rows.map((inv, i) => `<div class="invoice">
  <div class="invoice-header">
    <div class="invoice-title">#${inv.id} — ${esc(inv.child_name || 'Unknown child')}</div>
    <div class="invoice-amount">${fmtMoney(inv.amount_pence)}</div>
  </div>
  <div class="field"><span class="field-label">Child</span><span class="field-value">${esc(inv.child_name || '—')}</span></div>
  <div class="field"><span class="field-label">Bill payer</span><span class="field-value">${esc(inv.bill_payer_email || '—')}</span></div>
  <div class="field"><span class="field-label">Due date</span><span class="field-value">${fmtDate(inv.due_on)}</span></div>
  <div class="field"><span class="field-label">Status</span><span class="field-value status-${inv.status}">${esc((inv.status||'draft').replace('_', ' ').toUpperCase())}</span></div>
  ${inv.description ? `<div class="field"><span class="field-label">Description</span><span class="field-value">${esc(inv.description)}</span></div>` : ''}
  ${inv.xero_invoice_id ? `<div class="field"><span class="field-label">Xero ID</span><span class="field-value">${esc(inv.xero_invoice_id)}</span></div>` : ''}
</div>`).join('')}
${rows.length > 0 ? `<div class="total-row"><span>Total</span><span>${fmtMoney(rows.reduce((sum, inv) => sum + (inv.amount_pence || 0), 0))}</span></div>` : ''}
</body></html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="invoices-${month||'all'}.html"`);
    res.send(html);
  } catch (err) {
    console.error('invoices bulk-print error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

module.exports = router;
