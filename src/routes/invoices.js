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

module.exports = router;
