'use strict';
// Finance Payroll — payroll runs, finalisation, export (Sage/Xero/BrightPay/HMRC RTI).
// Mounted at /api/finance/payroll

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { requireSalaryView } = require('../lib/capabilities');

router.use(authenticate);

// PROMPT 35 (2026-06-30): payroll is pay/salary data → manager-only (deputy excluded).
// Was a static manager/deputy/admin role check; now gated on view_staff_salaries
// (manager + business_manager + headteacher + capability override; deputy denied).
router.use(requireSalaryView);

// ── GET /api/finance/payroll/runs ────────────────────────────────────────────
router.get('/runs', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT pr.*,
             COUNT(pl.id) AS line_count
      FROM payroll_runs pr
      LEFT JOIN payroll_staff_lines pl ON pl.run_id = pr.id
      GROUP BY pr.id
      ORDER BY pr.period_year DESC, pr.period_month DESC
      LIMIT 24
    `);
    res.json({ runs: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/payroll/runs/:id ────────────────────────────────────────
router.get('/runs/:id', async (req, res) => {
  const db = getPool();
  try {
    const { rows: [run] } = await db.query('SELECT * FROM payroll_runs WHERE id=$1', [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const { rows: lines } = await db.query(
      'SELECT * FROM payroll_staff_lines WHERE run_id=$1 ORDER BY staff_name', [run.id]
    );
    res.json({ run, lines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/payroll/runs ───────────────────────────────────────────
// Create a new payroll run from wages data.
router.post('/runs', async (req, res) => {
  const db = getPool();
  const { year, month } = req.body;
  if (!year || !month) return res.status(400).json({ error: 'year and month required' });

  try {
    const periodFrom = new Date(parseInt(year), parseInt(month) - 1, 1);
    const periodTo   = new Date(parseInt(year), parseInt(month), 0);
    const label      = periodFrom.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const { rows: [existing] } = await db.query(
      'SELECT id FROM payroll_runs WHERE period_year=$1 AND period_month=$2',
      [parseInt(year), parseInt(month)]
    );
    if (existing) return res.status(409).json({ error: `Payroll run already exists for ${label}` });

    // Pull wages data
    const { rows: staffRows } = await db.query(`
      SELECT s.id AS staff_id, s.name AS staff_name, s.role,
             s.hourly_rate_pence, s.contract_type,
             COALESCE(SUM(EXTRACT(EPOCH FROM (ce.clock_out - ce.clock_in))/3600), 0) AS hours_worked
      FROM staff s
      LEFT JOIN staff_clock_events ce
             ON ce.staff_id = s.id
            AND ce.clock_in >= $1 AND ce.clock_in < $2
            AND ce.clock_out IS NOT NULL
      WHERE s.status = 'active'
      GROUP BY s.id, s.name, s.role, s.hourly_rate_pence, s.contract_type
    `, [periodFrom.toISOString(), new Date(parseInt(year), parseInt(month), 1).toISOString()]);

    const { rows: [run] } = await db.query(`
      INSERT INTO payroll_runs (period_label, period_year, period_month, period_from, period_to, status, staff_count)
      VALUES ($1,$2,$3,$4,$5,'draft',$6)
      RETURNING id
    `, [label, parseInt(year), parseInt(month),
        periodFrom.toISOString().split('T')[0], periodTo.toISOString().split('T')[0],
        staffRows.length]);

    let totalGross = 0, totalTax = 0, totalNI = 0, totalPension = 0, totalNet = 0;

    for (const s of staffRows) {
      const hrs      = parseFloat(s.hours_worked) || 0;
      const rate     = parseInt(s.hourly_rate_pence) || 0;
      const gross    = s.contract_type === 'salaried' ? rate * 163 : Math.round(hrs * rate);
      const monthly  = Math.round(12570 / 12 * 100);
      const taxable  = Math.max(0, gross - monthly);
      const tax      = Math.round(taxable * 0.20);
      const ni       = Math.round(Math.max(0, gross - 102300) * 0.08);
      const pension  = Math.round(gross * 0.03);
      const net      = gross - tax - ni - pension;

      totalGross += gross; totalTax += tax; totalNI += ni; totalPension += pension; totalNet += net;

      await db.query(`
        INSERT INTO payroll_staff_lines
          (run_id, staff_id, staff_name, contract_type, hours_worked, hourly_rate_pence,
           gross_pence, tax_pence, ni_pence, pension_pence, net_pence)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      `, [run.id, s.staff_id, s.staff_name, s.contract_type || 'hourly',
          hrs, rate, gross, tax, ni, pension, net]);
    }

    await db.query(`
      UPDATE payroll_runs SET total_gross_pence=$1, total_tax_pence=$2, total_ni_pence=$3,
        total_net_pence=$4 WHERE id=$5
    `, [totalGross, totalTax, totalNI, totalNet, run.id]);

    recordAudit({ req, action: 'create', entity_type: 'payroll_run', entity_id: run.id,
      meta: { year, month, staff: staffRows.length } });

    res.json({ ok: true, run_id: run.id, staff_count: staffRows.length, total_gross_pence: totalGross });
  } catch (e) {
    console.error('[finance-payroll] create run error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/payroll/runs/:id/finalise ──────────────────────────────
router.post('/runs/:id/finalise', async (req, res) => {
  const db = getPool();
  try {
    await db.query(
      `UPDATE payroll_runs SET status='finalised', finalised_by=$1, finalised_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [req.user.id, req.params.id]
    );
    recordAudit({ req, action: 'finalise', entity_type: 'payroll_run', entity_id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/payroll/runs/:id/export?format= ─────────────────────────
// Formats: csv (generic), sage, xero, brightpay, hmrc_rti
router.get('/runs/:id/export', async (req, res) => {
  const db = getPool();
  const format = req.query.format || 'csv';

  try {
    const { rows: [run] }  = await db.query('SELECT * FROM payroll_runs WHERE id=$1', [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const { rows: lines } = await db.query(
      'SELECT * FROM payroll_staff_lines WHERE run_id=$1 ORDER BY staff_name', [run.id]
    );

    const fmt = (p) => ((p || 0) / 100).toFixed(2);
    let content = '';
    let contentType = 'text/csv';
    let filename = `payroll-${run.period_year}-${String(run.period_month).padStart(2,'0')}`;

    if (format === 'sage') {
      filename += '-sage.csv';
      content = 'Employee Name,Period,Gross Pay,Tax,NI,Net Pay\n';
      lines.forEach(l => {
        content += `"${l.staff_name}","${run.period_label}","${fmt(l.gross_pence)}","${fmt(l.tax_pence)}","${fmt(l.ni_pence)}","${fmt(l.net_pence)}"\n`;
      });
    } else if (format === 'xero') {
      filename += '-xero.csv';
      content = 'Employee Name,Pay Period End Date,Earnings,Tax,Employee NI,Pension,Net Pay\n';
      lines.forEach(l => {
        content += `"${l.staff_name}","${run.period_to}","${fmt(l.gross_pence)}","${fmt(l.tax_pence)}","${fmt(l.ni_pence)}","${fmt(l.pension_pence)}","${fmt(l.net_pence)}"\n`;
      });
    } else if (format === 'brightpay') {
      filename += '-brightpay.csv';
      content = 'Name,Gross,PAYE,NI Employee,NI Employer,Pension,Net\n';
      lines.forEach(l => {
        const erNI = Math.round(Math.max(0, l.gross_pence - 102300) * 0.138); // 13.8% ER NI
        content += `"${l.staff_name}","${fmt(l.gross_pence)}","${fmt(l.tax_pence)}","${fmt(l.ni_pence)}","${fmt(erNI)}","${fmt(l.pension_pence)}","${fmt(l.net_pence)}"\n`;
      });
    } else if (format === 'hmrc_rti') {
      // Basic FPS (Full Payment Submission) summary — NOT a valid HMRC submission
      // Recommend using dedicated payroll software for actual RTI
      filename += '-hmrc-rti-summary.csv';
      content = `# HMRC RTI Summary — ${run.period_label}\n`;
      content += `# NOTE: Use dedicated payroll software (BrightPay, Sage, Xero) for actual RTI submission\n`;
      content += 'Employee Name,NI Number (required),Tax Code,Gross Taxable,PAYE,Employee NI,Net Pay\n';
      lines.forEach(l => {
        content += `"${l.staff_name}","REQUIRED","1257L","${fmt(l.gross_pence)}","${fmt(l.tax_pence)}","${fmt(l.ni_pence)}","${fmt(l.net_pence)}"\n`;
      });
    } else {
      // Generic CSV
      filename += '.csv';
      content = 'Name,Contract,Hours,Gross (£),Tax (£),NI (£),Pension (£),Net (£)\n';
      lines.forEach(l => {
        content += `"${l.staff_name}","${l.contract_type}","${(l.hours_worked||0).toFixed(2)}","${fmt(l.gross_pence)}","${fmt(l.tax_pence)}","${fmt(l.ni_pence)}","${fmt(l.pension_pence)}","${fmt(l.net_pence)}"\n`;
      });
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
