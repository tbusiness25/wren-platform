// login-20261023 — a family's fees, READ-ONLY, for Toby's leadership tier on the EY tablet.
//
// Toby: leadership (the senior team) "would be able to see all of the parent and child
// information … but no finances [payroll, costs]", and the deputy "can see parents' invoices and stuff".
// Roost is for the full-access tier only, so this is the one place they see a family's bills.
//
//   GET /api/family-invoices/:childId
//     → the same picture the PARENT app shows that family (editions/ladn/server-unified.js §1/§1c):
//       balance and deposit (src/lib/family-ledger.js), each bill with what is left to pay, the
//       statement lines, and this term's funding. No office notes, no bill-payer email, no
//       payment details, no actions — nothing here can send, change or chase anything.
//
// Who: room_leader and the manager tiers (and Toby). Not practitioners or apprentices.
// Where: EY and Roost only — refused on HR (staff self-service) and Parents (they have their own).
// On EY it is child data, so it is on-site only like the rest (CHILD_DATA_SEGMENTS).
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');
const { familyLedger, familyChildIds } = require('../lib/family-ledger');

const ALLOWED_ROLES = ['room_leader', 'manager', 'deputy_manager', 'admin', 'owner'];

function schema() {
  try { return require('../db/connection').schema() || process.env.PG_SCHEMA || 'ladn'; }
  catch (_) { return process.env.PG_SCHEMA || 'ladn'; }
}

router.use(authenticate);
router.use((req, res, next) => {
  const portal = req._portal || 'learning';
  if (portal !== 'learning' && portal !== 'admin') return res.status(404).json({ error: 'Not found' });
  if (req.isParent || !(ALLOWED_ROLES.includes(req.user && req.user.role) || Number(req.user && req.user.id) === 1)) {
    return res.status(403).json({ error: 'fees_not_for_this_role', message: 'Family fees are for the leadership team and managers.' });
  }
  next();
});

router.get('/:childId', async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId) || childId <= 0) return res.status(400).json({ error: 'bad child id' });
  const db = getPool();
  const S = schema();
  try {
    const { rows: [kid] } = await db.query('SELECT id FROM children WHERE id = $1', [childId]);
    if (!kid) return res.status(404).json({ error: 'Not found' });

    const ids = await familyChildIds(db, childId, { schema: S });
    const { rows: children } = await db.query(
      'SELECT id, COALESCE(preferred_name, first_name) AS first_name, is_active FROM children WHERE id = ANY($1::int[]) ORDER BY id', [ids]);

    // Bills — the parent app's own query (no drafts, no notes, what is left to pay).
    const { rows: invoices } = await db.query(`
      SELECT i.id, i.child_id, i.invoice_number, i.period_label, i.period_year, i.period_month,
             i.amount_pence, i.funding_deduction_pence, i.status, i.issued_on, i.due_on, i.paid_on,
             GREATEST(${require('../lib/invoice-outstanding').outstandingSql('i', S)}, 0)::int AS outstanding_pence
        FROM invoices i
       WHERE i.child_id = ANY($1::int[]) AND COALESCE(i.status, '') <> 'draft'
       ORDER BY COALESCE(i.issued_on, i.created_at::date) DESC, i.id DESC
       LIMIT 60`, [ids]);

    let funding = [];
    try {
      ({ rows: funding } = await db.query(`
        SELECT cf.child_id, cf.funding_type, cf.total_hours_week, cf.stretched_funding, ft.name AS term_name
          FROM child_funding cf JOIN funding_terms ft ON ft.id = cf.term_id AND ft.is_current = true
         WHERE cf.child_id = ANY($1::int[])`, [ids]));
    } catch (_) { /* edition without funding tables */ }

    const led = await familyLedger(db, ids, { schema: S });
    res.set('Cache-Control', 'no-store');
    res.json({
      child_ids: ids,
      children,
      balance_pence: Number(led.balance_pence) || 0,
      deposit_pence: Number(led.deposit_pence) || 0,
      transactions: (led.transactions || []).slice(0, 60),
      opening: led.opening || [],
      invoices,
      funding,
    });
  } catch (e) {
    console.error('[family-invoices]', e.message);
    res.status(500).json({ error: 'Could not load the family’s fees' });
  }
});

module.exports = router;
