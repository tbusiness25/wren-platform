'use strict';
// Finance Wages — staff hours and wages from clock-in + rota data.
// Mounted at /api/finance/wages

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const managerGuard = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerGuard);

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

// ── GET /api/finance/wages/export?year=&month=&format=csv ────────────────────
router.get('/export', async (req, res) => {
  const { year, month, format = 'csv' } = req.query;
  const now = new Date();
  const y = parseInt(year || now.getFullYear());
  const m = parseInt(month || now.getMonth() + 1);

  try {
    // Re-use the summary logic inline
    const db = getPool();
    const periodFrom = new Date(y, m - 1, 1);
    const { rows } = await db.query(`
      SELECT s.name, s.role, s.hourly_rate_pence, s.contract_type,
             COALESCE(SUM(EXTRACT(EPOCH FROM (ce.clock_out - ce.clock_in))/3600), 0) AS hours_worked
      FROM staff s
      LEFT JOIN staff_clock_events ce
             ON ce.staff_id = s.id
            AND ce.clock_in >= $1 AND ce.clock_in < $2
            AND ce.clock_out IS NOT NULL
      WHERE s.status = 'active'
      GROUP BY s.id, s.name, s.role, s.hourly_rate_pence, s.contract_type
      ORDER BY s.name
    `, [periodFrom.toISOString(), new Date(y, m, 1).toISOString()]);

    const label = periodFrom.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    const header = 'Name,Role,Contract,Hourly Rate (£),Hours Worked,Gross Pay (£)\n';
    const csvLines = rows.map(r => {
      const hrs = parseFloat(r.hours_worked) || 0;
      const rate = parseInt(r.hourly_rate_pence) / 100;
      const gross = r.contract_type === 'salaried' ? (rate * 163).toFixed(2) : (hrs * rate).toFixed(2);
      return `"${r.name}","${r.role}","${r.contract_type || 'hourly'}","${rate.toFixed(2)}","${hrs.toFixed(2)}","${gross}"`;
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="wages-${y}-${String(m).padStart(2,'0')}.csv"`);
    res.send(header + csvLines);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
