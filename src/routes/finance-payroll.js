'use strict';
// Finance Payroll — payroll runs, finalisation, export (Sage/Xero/BrightPay/HMRC RTI).
// Mounted at /api/finance/payroll

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { requireSalaryView } = require('../lib/capabilities');
const engine       = require('../lib/payroll-engine');   // b228 — shared payroll maths

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
//
// b228 (2026-08-25) — FIXED. This route was 500-ing on every call:
//   "column ce.clock_in does not exist"
// It selected s.name, s.hourly_rate_pence and s.status from ladn.staff (none of
// which exist — they are first_name/last_name, hourly_rate and is_active) and
// joined staff_clock_events ON ce.clock_in/ce.clock_out (that table records
// event_time + event_type, one row per event). So no payroll run could ever be
// created from this endpoint, by anyone.
//
// The maths now lives in src/lib/payroll-engine.js and is shared with the
// Staff → Payroll screen, so the two can never drift apart. The PAYE estimate
// constants there are deliberately identical to the ones this route used.
// Body still accepts {year, month}; {from, to} is also honoured now.
router.post('/runs', async (req, res) => {
  const db = getPool();
  const { year, month, from, to } = req.body;
  if (!from && (!year || !month)) return res.status(400).json({ error: 'year and month (or from and to) required' });

  try {
    const computed = await engine.computeRun(db, { year, month, from, to });
    const run = await engine.saveRun(db, computed, { generated_by: req.user.id });

    recordAudit({ req, action: 'create', entity_type: 'payroll_run', entity_id: run.id,
      meta: { from: computed.period.from, to: computed.period.to,
              staff: computed.totals.staff_count, warnings: computed.totals.warning_lines } });

    res.json({ ok: true, run_id: run.id, staff_count: computed.totals.staff_count,
      total_gross_pence: computed.totals.gross_pence,
      warning_lines: computed.totals.warning_lines });
  } catch (e) {
    if (e.status === 409) return res.status(409).json({ error: e.message });
    console.error('[finance-payroll] create run error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/finance/payroll/runs/:id/finalise ──────────────────────────────
router.post('/runs/:id/finalise', async (req, res) => {
  const db = getPool();
  try {
    // b228: this used to fire a blind UPDATE — a missing id reported success, and
    // a finalised run could be "finalised" again. Finalising is what locks the
    // figures, so it has to be able to say no.
    const { rows: [run] } = await db.query('SELECT id, period_label, status FROM payroll_runs WHERE id=$1', [req.params.id]);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (run.status === 'finalised') {
      return res.status(409).json({ error: `${run.period_label} has already been finalised.` });
    }
    await db.query(
      `UPDATE payroll_runs SET status='finalised', finalised_by=$1, finalised_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [req.user.id, run.id]
    );
    recordAudit({ req, action: 'finalise', entity_type: 'payroll_run', entity_id: run.id });
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
