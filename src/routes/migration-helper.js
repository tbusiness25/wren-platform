'use strict';
// Migration Helper — one-screen import wizard for schools switching FROM EYworks/Famly/any CSV.
// Mounted at /api/migration in admin server.

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

// Parse a simple CSV into [{col: val, ...}] using first row as header
function parseCSV(raw) {
  if (!raw) return [];
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase().replace(/\s+/g, '_'));
  return lines.slice(1).map(line => {
    const cols = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c => c.replace(/^"|"$/g, '').trim());
    return Object.fromEntries(headers.map((h, i) => [h, cols[i] || '']));
  });
}

function inferDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d) ? null : d.toISOString().split('T')[0];
}

function inferPence(val) {
  if (!val) return 0;
  const n = parseFloat(String(val).replace(/[£,\s]/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100);
}

// ── POST /api/migration/upload ────────────────────────────────────────────────
// Upload CSV files for inspection. Returns a job_id and preview counts.
router.post('/upload', async (req, res) => {
  const db = getPool();
  const { source_system, children_csv, invoices_csv, payments_csv } = req.body;

  try {
    const children = parseCSV(children_csv);
    const invoices = parseCSV(invoices_csv);
    const payments = parseCSV(payments_csv);

    const { rows: [job] } = await db.query(`
      INSERT INTO migration_jobs
        (source_system, status, children_csv, invoices_csv, payments_csv,
         children_count, invoices_count, payments_count, created_by)
      VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8)
      RETURNING id
    `, [source_system || 'generic_csv',
        children_csv || '', invoices_csv || '', payments_csv || '',
        children.length, invoices.length, payments.length, req.user.id]);

    // Return a preview (first 5 of each)
    res.json({
      job_id:    job.id,
      children:  { count: children.length, sample: children.slice(0, 5) },
      invoices:  { count: invoices.length,  sample: invoices.slice(0, 5) },
      payments:  { count: payments.length,  sample: payments.slice(0, 5) },
      children_fields: children[0] ? Object.keys(children[0]) : [],
      invoice_fields:  invoices[0] ? Object.keys(invoices[0]) : [],
      payment_fields:  payments[0] ? Object.keys(payments[0]) : [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/migration/jobs ───────────────────────────────────────────────────
router.get('/jobs', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      'SELECT id, source_system, status, children_count, invoices_count, payments_count, created_at, imported_at, error FROM migration_jobs ORDER BY created_at DESC LIMIT 20'
    );
    res.json({ jobs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/migration/jobs/:id/import ──────────────────────────────────────
// Actually import the data from a job.
// Body: { field_map: { children: {csv_col: wren_col}, invoices: {...}, payments: {...} } }
router.post('/jobs/:id/import', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [job] } = await db.query(
      'SELECT * FROM migration_jobs WHERE id=$1', [req.params.id]
    );
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'complete') return res.status(409).json({ error: 'Already imported' });

    await db.query('UPDATE migration_jobs SET status=$1 WHERE id=$2', ['processing', job.id]);

    const { field_map = {} } = req.body;

    const children = parseCSV(job.children_csv);
    const invoices = parseCSV(job.invoices_csv);
    const payments = parseCSV(job.payments_csv);

    const errors = [];
    let childImported = 0, invImported = 0, pmtImported = 0;

    // Helper: map CSV field to wren field
    const m = (obj, map, key) => obj[map[key] || key] || obj[key] || '';

    // ── Import children ────────────────────────────────────────────────────────
    for (const row of children) {
      try {
        const cm   = field_map.children || {};
        const fname = m(row, cm, 'first_name') || m(row, cm, 'firstname') || row.name?.split(' ')[0] || '';
        const lname = m(row, cm, 'last_name')  || m(row, cm, 'lastname')  || row.name?.split(' ').slice(1).join(' ') || '';
        if (!fname && !lname) continue;

        const dob   = inferDate(m(row, cm, 'date_of_birth') || m(row, cm, 'dob'));
        const room  = m(row, cm, 'room') || m(row, cm, 'room_name') || '';
        const email = m(row, cm, 'email') || m(row, cm, 'parent_email') || m(row, cm, 'primary_contact_email') || '';
        const status = (m(row, cm, 'status') || 'active').toLowerCase().includes('leav') ? 'inactive' : 'active';

        await db.query(`
          INSERT INTO children (first_name, last_name, date_of_birth, room, primary_contact_email, status)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT DO NOTHING
        `, [fname, lname, dob, room, email, status]);
        childImported++;
      } catch (e) {
        errors.push(`Child row: ${e.message}`);
      }
    }

    // ── Import invoices ────────────────────────────────────────────────────────
    for (const row of invoices) {
      try {
        const im = field_map.invoices || {};
        const childName = m(row, im, 'child_name') || m(row, im, 'child') || '';
        const amount    = inferPence(m(row, im, 'amount') || m(row, im, 'total'));
        if (!childName || !amount) continue;

        // Look up child
        const [fn, ...ln] = childName.trim().split(' ');
        const { rows: [child] } = await db.query(
          `SELECT id FROM children WHERE lower(first_name)=$1 AND lower(last_name)=$2 LIMIT 1`,
          [fn.toLowerCase(), (ln.join(' ') || fn).toLowerCase()]
        ).catch(() => ({ rows: [] }));

        const status   = (m(row, im, 'status') || 'sent').toLowerCase();
        const issuedOn = inferDate(m(row, im, 'issued_on') || m(row, im, 'invoice_date') || m(row, im, 'date'));
        const dueOn    = inferDate(m(row, im, 'due_on') || m(row, im, 'due_date'));
        const email    = m(row, im, 'email') || m(row, im, 'bill_payer_email') || '';
        const ref      = m(row, im, 'reference') || m(row, im, 'invoice_number') || m(row, im, 'invoice_no') || '';

        await db.query(`
          INSERT INTO invoices (child_id, bill_payer_email, amount_pence, status,
                                issued_on, due_on, invoice_number, notes)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT DO NOTHING
        `, [child?.id || null, email, amount, status, issuedOn, dueOn, ref,
            'Imported from migration']);
        invImported++;
      } catch (e) {
        errors.push(`Invoice row: ${e.message}`);
      }
    }

    // ── Import payments ────────────────────────────────────────────────────────
    for (const row of payments) {
      try {
        const pm = field_map.payments || {};
        const amount = inferPence(m(row, pm, 'amount') || m(row, pm, 'payment_amount'));
        if (!amount) continue;

        const method    = (m(row, pm, 'payment_method') || m(row, pm, 'method') || 'manual').toLowerCase();
        const createdAt = inferDate(m(row, pm, 'date') || m(row, pm, 'payment_date') || m(row, pm, 'created_at'));
        const email     = m(row, pm, 'email') || m(row, pm, 'bill_payer_email') || '';
        const ref       = m(row, pm, 'reference') || m(row, pm, 'invoice_number') || '';

        // Try to match to an invoice by reference
        let invoiceId = null;
        if (ref) {
          const { rows: [inv] } = await db.query(
            `SELECT id FROM invoices WHERE invoice_number = $1 OR reference = $1 LIMIT 1`, [ref]
          ).catch(() => ({ rows: [] }));
          invoiceId = inv?.id || null;
        }

        await db.query(`
          INSERT INTO payments (invoice_id, bill_payer_email, amount_pence, payment_method,
                                status, description, reconciliation_status, created_at, updated_at)
          VALUES ($1,$2,$3,$4,'succeeded',$5,'reconciled',$6,NOW())
          ON CONFLICT DO NOTHING
        `, [invoiceId, email, amount, method,
            `Imported payment${ref ? ` — ${ref}` : ''}`,
            createdAt ? new Date(createdAt).toISOString() : new Date().toISOString()]);
        pmtImported++;
      } catch (e) {
        errors.push(`Payment row: ${e.message}`);
      }
    }

    await db.query(`
      UPDATE migration_jobs
      SET status='complete', imported_at=NOW(),
          children_count=$1, invoices_count=$2, payments_count=$3,
          error=$4
      WHERE id=$5
    `, [childImported, invImported, pmtImported,
        errors.length ? errors.slice(0, 20).join('; ') : null, job.id]);

    recordAudit({ req, action: 'import', entity_type: 'migration_job', entity_id: job.id,
      meta: { children: childImported, invoices: invImported, payments: pmtImported } });

    res.json({
      ok: true,
      imported: { children: childImported, invoices: invImported, payments: pmtImported },
      errors:   errors.slice(0, 20),
    });
  } catch (e) {
    await getPool().query(
      'UPDATE migration_jobs SET status=$1, error=$2 WHERE id=$3', ['failed', e.message, req.params.id]
    ).catch(() => {});
    console.error('[migration] import error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
