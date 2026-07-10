'use strict';
// Finance Wages — staff hours and wages from clock-in + rota data.
// Mounted at /api/finance/wages

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireSalaryView } = require('../lib/capabilities');

router.use(authenticate);

// PROMPT 35 (2026-06-30): wages are pay/salary data → manager-only (deputy excluded).
// Was a static manager/deputy/admin role check; now gated on view_staff_salaries
// (manager + business_manager + headteacher + capability override; deputy denied).
router.use(requireSalaryView);

function penceToGBP(p) { return ((p || 0) / 100).toFixed(2); }

// ── GET /api/finance/wages/summary?year=&month= ───────────────────────────────
router.get('/summary', async (req, res) => {
  const db  = getPool();
  const now = new Date();
  const year  = parseInt(req.query.year  || now.getFullYear());
  const month = parseInt(req.query.month || now.getMonth() + 1);

  const periodFrom = new Date(year, month - 1, 1);
  const periodTo   = new Date(year, month, 0);      // last day of month

  try {
    // Hours from clock-in events
    const { rows: clockRows } = await db.query(`
      SELECT s.id AS staff_id,
             s.name AS staff_name,
             s.role,
             s.hourly_rate_pence,
             s.contract_type,
             COALESCE(SUM(EXTRACT(EPOCH FROM (ce.clock_out - ce.clock_in))/3600), 0) AS hours_worked,
             COUNT(ce.id) FILTER (WHERE ce.clock_out IS NOT NULL)                    AS complete_shifts
      FROM staff s
      LEFT JOIN staff_clock_events ce
             ON ce.staff_id = s.id
            AND ce.clock_in >= $1
            AND ce.clock_in < $2
            AND ce.clock_out IS NOT NULL
      WHERE s.status = 'active'
      GROUP BY s.id, s.name, s.role, s.hourly_rate_pence, s.contract_type
      ORDER BY s.name
    `, [periodFrom.toISOString(), new Date(year, month, 1).toISOString()]);

    // Absence data for this period
    const { rows: absenceRows } = await db.query(`
      SELECT ar.staff_id,
             SUM(ar.days) AS sick_days,
             SUM(ar.days) FILTER (WHERE ar.type = 'holiday') AS holiday_days
      FROM absence_requests ar
      WHERE ar.status = 'approved'
        AND ar.start_date >= $1 AND ar.start_date <= $2
      GROUP BY ar.staff_id
    `, [periodFrom.toISOString().split('T')[0], periodTo.toISOString().split('T')[0]])
      .catch(() => ({ rows: [] }));

    const absenceMap = Object.fromEntries(absenceRows.map(r => [r.staff_id, r]));

    const staffLines = clockRows.map(s => {
      const hoursWorked = parseFloat(s.hours_worked) || 0;
      const hourlyRate  = parseInt(s.hourly_rate_pence) || 0;
      const absence     = absenceMap[s.staff_id] || {};
      const sickHours   = parseFloat(absence.sick_days || 0) * 7.5;
      const holidayHours = parseFloat(absence.holiday_days || 0) * 7.5;

      let grossPence = 0;
      if (s.contract_type === 'salaried') {
        grossPence = hourlyRate * 163; // ~37.5h/wk × 4.33wk = 162.5h
      } else {
        grossPence = Math.round(hoursWorked * hourlyRate);
      }

      // Rough PAYE/NI estimate (basic rate taxpayer)
      const monthlyAllowance = Math.round(12570 / 12 * 100); // £1047.50 personal allowance/mo
      const taxablePence = Math.max(0, grossPence - monthlyAllowance);
      const taxPence     = Math.round(taxablePence * 0.20);
      const niPence      = Math.round(Math.max(0, grossPence - 102300) * 0.08); // basic NI
      const pensionPence = Math.round(grossPence * 0.03); // 3% employee contribution
      const netPence     = grossPence - taxPence - niPence - pensionPence;

      return {
        staff_id:       s.staff_id,
        staff_name:     s.staff_name,
        role:           s.role,
        contract_type:  s.contract_type || 'hourly',
        hourly_rate_pence: hourlyRate,
        hours_worked:   Math.round(hoursWorked * 100) / 100,
        sick_hours:     Math.round(sickHours * 100) / 100,
        holiday_hours:  Math.round(holidayHours * 100) / 100,
        complete_shifts: parseInt(s.complete_shifts),
        gross_pence:    grossPence,
        tax_pence:      taxPence,
        ni_pence:       niPence,
        pension_pence:  pensionPence,
        net_pence:      netPence,
      };
    });

    const totals = staffLines.reduce((acc, s) => {
      acc.total_hours   += s.hours_worked;
      acc.gross_pence   += s.gross_pence;
      acc.tax_pence     += s.tax_pence;
      acc.ni_pence      += s.ni_pence;
      acc.pension_pence += s.pension_pence;
      acc.net_pence     += s.net_pence;
      return acc;
    }, { total_hours: 0, gross_pence: 0, tax_pence: 0, ni_pence: 0, pension_pence: 0, net_pence: 0 });

    const monthLabel = periodFrom.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    res.json({
      period: { year, month, label: monthLabel, from: periodFrom.toISOString().split('T')[0], to: periodTo.toISOString().split('T')[0] },
      staff:  staffLines,
      totals,
    });
  } catch (e) {
    console.error('[finance-wages] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/finance/wages/export?year=&month=&format=csv|full ───────────────
// format=csv : basic summary (default)
// format=full: full payroll map — all columns incl. employer costs + absence
router.get('/export', async (req, res) => {
  const { year, month, format = 'csv' } = req.query;
  const now = new Date();
  const y = parseInt(year || now.getFullYear());
  const m = parseInt(month || now.getMonth() + 1);

  try {
    const db = getPool();
    const periodFrom = new Date(y, m - 1, 1);
    const periodTo   = new Date(y, m, 0);
    const label      = periodFrom.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

    const { rows: staffRows } = await db.query(`
      SELECT s.id AS staff_id, s.name AS staff_name, s.role, s.hourly_rate_pence, s.contract_type,
             s.hours_per_week,
             COALESCE(SUM(EXTRACT(EPOCH FROM (ce.clock_out - ce.clock_in))/3600), 0) AS hours_worked,
             COUNT(ce.id) FILTER (WHERE ce.clock_out IS NOT NULL) AS complete_shifts
      FROM staff s
      LEFT JOIN staff_clock_events ce
             ON ce.staff_id = s.id
            AND ce.clock_in >= $1 AND ce.clock_in < $2
            AND ce.clock_out IS NOT NULL
      WHERE s.status = 'active'
      GROUP BY s.id, s.name, s.role, s.hourly_rate_pence, s.contract_type, s.hours_per_week
      ORDER BY s.name
    `, [periodFrom.toISOString(), new Date(y, m, 1).toISOString()]);

    const { rows: absRows } = await db.query(`
      SELECT ar.staff_id,
             SUM(ar.days) FILTER (WHERE ar.type = 'sick')    AS sick_days,
             SUM(ar.days) FILTER (WHERE ar.type = 'holiday') AS holiday_days
      FROM absence_requests ar
      WHERE ar.status = 'approved'
        AND ar.start_date >= $1 AND ar.start_date <= $2
      GROUP BY ar.staff_id
    `, [periodFrom.toISOString().split('T')[0], periodTo.toISOString().split('T')[0]])
      .catch(() => ({ rows: [] }));

    const absMap = Object.fromEntries(absRows.map(r => [r.staff_id, r]));
    const fmt = p => ((p || 0) / 100).toFixed(2);

    const lines = staffRows.map(s => {
      const hrs       = parseFloat(s.hours_worked) || 0;
      const rate      = parseInt(s.hourly_rate_pence) || 0;
      const abs       = absMap[s.staff_id] || {};
      const sickDays  = parseFloat(abs.sick_days  || 0);
      const holDays   = parseFloat(abs.holiday_days || 0);
      const sickHrs   = sickDays * 7.5;
      const holHrs    = holDays * 7.5;

      const grossPence = s.contract_type === 'salaried' ? rate * 163 : Math.round(hrs * rate);
      const monthlyAllow = Math.round(12570 / 12 * 100);
      const taxablePence = Math.max(0, grossPence - monthlyAllow);
      const taxPence     = Math.round(taxablePence * 0.20);
      const eeNIPence    = Math.round(Math.max(0, grossPence - 102300) * 0.08);
      const erNIPence    = Math.round(Math.max(0, grossPence - 102300) * 0.138);
      const eePensionP   = Math.round(grossPence * 0.03);
      const erPensionP   = Math.round(grossPence * 0.03);
      const netPence     = grossPence - taxPence - eeNIPence - eePensionP;
      const totalCost    = grossPence + erNIPence + erPensionP;

      return { s, hrs, rate, sickDays, holDays, sickHrs, holHrs,
               grossPence, taxPence, eeNIPence, erNIPence, eePensionP, erPensionP, netPence, totalCost,
               shifts: parseInt(s.complete_shifts) || 0 };
    });

    const filename = `payroll-full-report-${y}-${String(m).padStart(2, '0')}`;
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);

    if (format === 'full') {
      const totals = lines.reduce((acc, l) => ({
        hrs:      acc.hrs      + l.hrs,
        gross:    acc.gross    + l.grossPence,
        tax:      acc.tax      + l.taxPence,
        eeNI:     acc.eeNI    + l.eeNIPence,
        erNI:     acc.erNI    + l.erNIPence,
        eePen:    acc.eePen   + l.eePensionP,
        erPen:    acc.erPen   + l.erPensionP,
        net:      acc.net      + l.netPence,
        cost:     acc.cost     + l.totalCost,
      }), { hrs: 0, gross: 0, tax: 0, eeNI: 0, erNI: 0, eePen: 0, erPen: 0, net: 0, cost: 0 });

      const cols = [
        'Name','Role','Contract','Rate (£/hr)','Contracted hrs/wk',
        'Hours Worked','Shifts','Sick Days','Sick Hours','Holiday Days','Holiday Hours',
        'Gross Pay (£)','PAYE Tax (£)','EE NI (£)','ER NI (£)','EE Pension (£)','ER Pension (£)',
        'Net Pay (£)','Total Employer Cost (£)',
      ];
      const rows = lines.map(l => [
        l.s.staff_name, l.s.role, l.s.contract_type || 'hourly',
        fmt(l.rate), l.s.hours_per_week || '',
        l.hrs.toFixed(2), l.shifts,
        l.sickDays.toFixed(1), l.sickHrs.toFixed(1),
        l.holDays.toFixed(1), l.holHrs.toFixed(1),
        fmt(l.grossPence), fmt(l.taxPence), fmt(l.eeNIPence), fmt(l.erNIPence),
        fmt(l.eePensionP), fmt(l.erPensionP), fmt(l.netPence), fmt(l.totalCost),
      ].map(v => `"${v}"`).join(','));

      const totalRow = [
        '"TOTAL"','','','','',
        `"${totals.hrs.toFixed(2)}"`, '',
        '','','','',
        `"${fmt(totals.gross)}"`, `"${fmt(totals.tax)}"`, `"${fmt(totals.eeNI)}"`,
        `"${fmt(totals.erNI)}"`, `"${fmt(totals.eePen)}"`, `"${fmt(totals.erPen)}"`,
        `"${fmt(totals.net)}"`, `"${fmt(totals.cost)}"`,
      ].join(',');

      const meta = [`# Your Nursery — Full Payroll Report`,
                    `# Period: ${label}`,
                    `# NOTE: PAYE/NI/pension are estimates. Use BrightPay/Sage/Xero for RTI.`,
                    `# Generated: ${new Date().toLocaleDateString('en-GB')}`, ''];
      res.send(meta.join('\n') + cols.map(c => `"${c}"`).join(',') + '\n' + rows.join('\n') + '\n' + totalRow + '\n');
    } else {
      // Basic CSV (backwards-compatible)
      const header = 'Name,Role,Contract,Hourly Rate (£),Hours Worked,Gross Pay (£),Tax (£),NI (£),Pension (£),Net Pay (£)\n';
      const csvLines = lines.map(l =>
        [l.s.staff_name, l.s.role, l.s.contract_type || 'hourly',
         fmt(l.rate), l.hrs.toFixed(2), fmt(l.grossPence),
         fmt(l.taxPence), fmt(l.eeNIPence), fmt(l.eePensionP), fmt(l.netPence)]
          .map(v => `"${v}"`).join(',')
      ).join('\n');
      res.send(header + csvLines + '\n');
    }
  } catch (e) {
    console.error('[finance-wages] export error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
