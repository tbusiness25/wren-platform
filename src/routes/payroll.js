'use strict';
// ============================================================================
// b228 — Staff → Payroll (2026-08-25).  Mounted at /api/payroll
//
// Toby's ask, verbatim: "I should just click - staff - payroll - generate. I
// choose dates." This is the API behind that screen.
//
// WHY THIS EXISTS ALONGSIDE /api/finance/payroll
// -----------------------------------------------------------------------------
// src/routes/finance-payroll.js puts requireSalaryView on the WHOLE router, so a
// deputy manager gets a 403 on every single endpoint including the hours. That
// is right for a finance screen and wrong for a staffing one: a deputy is
// supposed to see hours and work patterns, just not pay (see the capability
// notes in src/lib/capabilities.js). Rather than loosen an existing gate, this
// router role-gates entry and then MASKS the money per-field for anyone without
// view_staff_salaries. Both routers compute through src/lib/payroll-engine.js,
// so there is one set of payroll maths, not two.
// ============================================================================

const express      = require('express');
const router       = express.Router();
const PDFDoc       = require('pdfkit');            // same lib routes/rota.js uses
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { canViewSalaries, requireSalaryView } = require('../lib/capabilities');
const engine = require('../lib/payroll-engine');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// Payroll is a staffing screen: managers and deputies get in. Practitioners do
// not — colleagues' hours are not general-staff information.
const STAFF_ADMIN_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher', 'business_manager'];
function requireStaffAdmin(req, res, next) {
  if (Number(req.user?.id) === 1) return next();
  if (hasRole(req.user, STAFF_ADMIN_ROLES)) return next();
  return res.status(403).json({ error: 'forbidden_role',
    message: 'Payroll is available to managers and deputy managers.' });
}
router.use(requireStaffAdmin);

// Every money field on a run or a line. Blanked (not deleted — the screen needs
// to know a column exists but is withheld) for anyone without view_staff_salaries.
const MONEY_FIELDS = [
  'gross_pence', 'tax_pence', 'ni_pence', 'employer_ni_pence', 'pension_pence',
  'net_pence', 'hourly_rate_pence', 'total_gross_pence', 'total_tax_pence',
  'total_ni_pence', 'total_pension_pence', 'total_net_pence', 'annual_salary', 'tax_code',
];
function maskMoney(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  for (const f of MONEY_FIELDS) if (f in obj) obj[f] = null;
  obj.pay_hidden = true;
  return obj;
}

/** Resolve whether this request may see pay, once per request. */
async function payVisibility(req) {
  const ok = await canViewSalaries(req.user);
  return { canSeePay: ok };
}

// ── GET /api/payroll/context ────────────────────────────────────────────────
// Everything the screen needs to render before anything is generated: the
// default date range (previous whole calendar month), the saved templates, and
// whether this person may see money.
router.get('/context', async (req, res) => {
  const db = getPool();
  try {
    const { canSeePay } = await payVisibility(req);
    const def = engine.lastWholeMonth();
    const { rows: templates } = await db.query(
      'SELECT * FROM payroll_templates ORDER BY is_default DESC, lower(name)'
    ).catch(() => ({ rows: [] }));
    const { rows: [counts] } = await db.query(`
      SELECT COUNT(*)::int AS active_staff,
             COUNT(*) FILTER (WHERE hourly_rate IS NULL AND annual_salary IS NULL)::int AS no_rate
      FROM staff WHERE is_active = true AND COALESCE(is_demo, false) = false`);
    const { rows: [pat] } = await db.query(`
      SELECT COUNT(DISTINCT staff_id)::int AS with_pattern FROM staff_work_patterns`);
    const { rows: [clock] } = await db.query(
      'SELECT COUNT(*)::int AS n FROM staff_shifts WHERE NOT EXISTS (SELECT 1 FROM staff ds WHERE ds.id = staff_shifts.staff_id AND COALESCE(ds.is_demo, false))').catch(() => ({ rows: [{ n: 0 }] }));

    res.json({
      can_see_pay: canSeePay,
      default_period: def,
      templates,
      roles: (await db.query(
        "SELECT DISTINCT role FROM staff WHERE is_active AND COALESCE(is_demo, false) = false AND role IS NOT NULL ORDER BY role")).rows.map(r => r.role),
      coverage: {
        active_staff: counts.active_staff,
        with_work_pattern: pat.with_pattern,
        without_work_pattern: Math.max(0, counts.active_staff - pat.with_pattern),
        without_pay_rate: counts.no_rate,
        clock_records: clock.n,
      },
    });
  } catch (e) {
    console.error('[payroll] context:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payroll/preview?from=&to=&template_id= ─────────────────────────
// What Generate WOULD produce, without saving. Lets Toby see the warnings before
// a run exists.
router.get('/preview', async (req, res) => {
  const db = getPool();
  try {
    const { canSeePay } = await payVisibility(req);
    const template = await loadTemplate(db, req.query.template_id);
    const computed = await engine.computeRun(db, {
      from: req.query.from, to: req.query.to,
      shape: req.query.shape || (template && template.period_shape),
      template,
    });
    if (!canSeePay) { computed.lines.forEach(maskMoney); maskMoney(computed.totals); }
    res.json(computed);
  } catch (e) {
    console.error('[payroll] preview:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ── POST /api/payroll/generate ──────────────────────────────────────────────
// The button. {from, to, template_id?, shape?}
router.post('/generate', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const template = await loadTemplate(db, req.body.template_id);
    const computed = await engine.computeRun(db, {
      from: req.body.from, to: req.body.to,
      shape: req.body.shape || (template && template.period_shape),
      template,
    });
    const run = await engine.saveRun(db, computed, {
      template_id: template ? template.id : null,
      generated_by: req.user.id,
    });
    recordAudit({ req, action: 'create', entity_type: 'payroll_run', entity_id: run.id,
      meta: { from: computed.period.from, to: computed.period.to,
              staff: computed.totals.staff_count, warnings: computed.totals.warning_lines } });
    res.json({ ok: true, run_id: run.id, run,
      staff_count: computed.totals.staff_count,
      warning_lines: computed.totals.warning_lines,
      blocking_lines: computed.totals.blocking_lines });
  } catch (e) {
    if (e.status === 409) {
      return res.status(409).json({ error: 'run_exists', message: e.message, existing_run_id: e.existing_run_id });
    }
    console.error('[payroll] generate:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payroll/runs ───────────────────────────────────────────────────
router.get('/runs', async (req, res) => {
  const db = getPool();
  try {
    const { canSeePay } = await payVisibility(req);
    const { rows } = await db.query(`
      SELECT pr.*,
             COUNT(pl.id)::int AS line_count,
             COALESCE(SUM(pl.hours_worked), 0)::numeric AS total_hours,
             COUNT(pl.id) FILTER (WHERE jsonb_array_length(COALESCE(pl.warnings,'[]'::jsonb)) > 0)::int AS warning_lines,
             s.first_name || ' ' || s.last_name AS finalised_by_name
      FROM payroll_runs pr
      LEFT JOIN payroll_staff_lines pl ON pl.run_id = pr.id
      LEFT JOIN staff s ON s.id = pr.finalised_by
      GROUP BY pr.id, s.first_name, s.last_name
      ORDER BY pr.period_from DESC NULLS LAST, pr.id DESC
      LIMIT 48
    `);
    if (!canSeePay) rows.forEach(maskMoney);
    res.json({ runs: rows, can_see_pay: canSeePay });
  } catch (e) {
    console.error('[payroll] runs:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payroll/runs/:id ───────────────────────────────────────────────
router.get('/runs/:id', async (req, res) => {
  const db = getPool();
  try {
    const { canSeePay } = await payVisibility(req);
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found', message: 'That payroll run does not exist.' });

    const { rows: lines } = await db.query(
      'SELECT * FROM payroll_staff_lines WHERE run_id=$1 ORDER BY staff_name', [run.id]);
    lines.forEach(l => { l.warnings = l.warnings || []; });

    if (!canSeePay) { lines.forEach(maskMoney); maskMoney(run); }
    res.json({
      run, lines, can_see_pay: canSeePay,
      locked: run.status === 'finalised',
      data_quality: runDataQuality(lines),
    });
  } catch (e) {
    console.error('[payroll] run detail:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── PATCH /api/payroll/runs/:id/lines/:lineId ───────────────────────────────
// Hours and rate are editable on a DRAFT run; the pay is re-priced from them so
// an edited line can never disagree with its own arithmetic. A finalised run is
// locked — that is the whole point of finalising it.
router.patch('/runs/:id/lines/:lineId', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    if (run.status === 'finalised') {
      return res.status(409).json({ error: 'run_locked',
        message: `${run.period_label} was finalised on ${new Date(run.finalised_at).toLocaleDateString('en-GB')} and can no longer be edited.` });
    }
    const { rows: [line] } = await db.query(
      'SELECT * FROM payroll_staff_lines WHERE id=$1 AND run_id=$2', [req.params.lineId, run.id]);
    if (!line) return res.status(404).json({ error: 'line_not_found' });

    if (req.body.hours_worked != null) line.hours_worked = Number(req.body.hours_worked);
    if (req.body.hourly_rate_pence != null) line.hourly_rate_pence = Math.round(Number(req.body.hourly_rate_pence));
    if (req.body.gross_pence != null && line.pay_basis === 'salaried') line.gross_pence = Math.round(Number(req.body.gross_pence));
    const notes = req.body.notes != null ? String(req.body.notes) : line.notes;

    const period = engine.resolvePeriod({ from: engine._internal.ymd(run.period_from), to: engine._internal.ymd(run.period_to) });
    const priced = engine.repriceLine(line, period);

    const { rows: [updated] } = await db.query(`
      UPDATE payroll_staff_lines
         SET hours_worked=$1, hourly_rate_pence=$2, gross_pence=$3, tax_pence=$4,
             ni_pence=$5, pension_pence=$6, net_pence=$7, notes=$8,
             employer_ni_pence=$9, edited=true, updated_at=NOW()
       WHERE id=$10 RETURNING *`,
      [line.hours_worked, line.hourly_rate_pence, priced.gross_pence, priced.tax_pence,
       priced.ni_pence, priced.pension_pence, priced.net_pence, notes,
       // b301: keep employer NI in step with gross, so Finance's staff-cost figure
       // reflects the edit rather than the generated figure.
       priced.employer_ni_pence, line.id]);

    const totals = await engine.recalcRun(db, run.id);
    recordAudit({ req, action: 'update', entity_type: 'payroll_staff_line', entity_id: line.id,
      meta: { run_id: run.id, staff_id: line.staff_id, hours: line.hours_worked } });
    res.json({ ok: true, line: updated, totals });
  } catch (e) {
    console.error('[payroll] patch line:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/payroll/runs/:id/finalise ─────────────────────────────────────
router.post('/runs/:id/finalise', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    if (run.status === 'finalised') {
      return res.status(409).json({ error: 'already_finalised',
        message: `${run.period_label} was already finalised.` });
    }
    const { rows: [blocked] } = await db.query(`
      SELECT COUNT(*)::int AS n FROM payroll_staff_lines
       WHERE run_id=$1 AND jsonb_path_exists(COALESCE(warnings,'[]'::jsonb),
             '$[*] ? (@.code == "no_pay_rate" || @.code == "no_hours_source")')`, [run.id]);
    if (blocked.n > 0 && !req.body.force) {
      return res.status(409).json({ error: 'unresolved_warnings', blocking_lines: blocked.n,
        message: `${blocked.n} line${blocked.n === 1 ? '' : 's'} still have no pay rate or no hours source. Fix them, or finalise anyway to lock the run as it stands.` });
    }
    await db.query(
      `UPDATE payroll_runs SET status='finalised', finalised_by=$1, finalised_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [req.user.id, run.id]);
    recordAudit({ req, action: 'finalise', entity_type: 'payroll_run', entity_id: run.id,
      meta: { forced: !!req.body.force, blocking_lines: blocked.n } });
    res.json({ ok: true, locked: true });
  } catch (e) {
    console.error('[payroll] finalise:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payroll/runs/:id/export.csv?format= ────────────────────────────
// format: wren (default, everything incl. the hours provenance) | sage | xero |
// brightpay. The accountant gets a file that opens in Excel; the caveats ride
// along in a header block so they cannot be left behind on the screen.
router.get('/runs/:id/export.csv', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    const { rows: lines } = await db.query(
      'SELECT * FROM payroll_staff_lines WHERE run_id=$1 ORDER BY staff_name', [run.id]);

    const fmt = p => ((Number(p) || 0) / 100).toFixed(2);
    const hrs = h => (Number(h) || 0).toFixed(2);
    const esc = v => { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const format = (req.query.format || 'wren').toLowerCase();
    const out = [];

    // Sage/Xero/BrightPay are fixed-column import formats: there is nowhere to
    // put "no rate on file", and writing 0.00 into a Gross Pay column is how
    // somebody gets paid nothing by accident. Those lines are LEFT OUT of the
    // accounting-package files and the count is returned in a header; the Wren
    // format keeps every line and marks them MISSING, so nothing is hidden.
    const payable = lines.filter(l => l.pay_basis !== 'unknown');
    const excluded = lines.length - payable.length;
    if (format !== 'wren') res.set('X-Wren-Export-Excluded', String(excluded));

    if (format === 'sage') {
      out.push(['Employee Name', 'Employee Ref', 'Period', 'Hours', 'Gross Pay', 'Tax', 'NI', 'Net Pay'].map(esc).join(','));
      payable.forEach(l => out.push([l.staff_name, l.staff_id, run.period_label, hrs(l.hours_worked),
        fmt(l.gross_pence), fmt(l.tax_pence), fmt(l.ni_pence), fmt(l.net_pence)].map(esc).join(',')));
    } else if (format === 'xero') {
      out.push(['Employee Name', 'Pay Period End Date', 'Hours', 'Earnings', 'Tax', 'Employee NI', 'Pension', 'Net Pay'].map(esc).join(','));
      payable.forEach(l => out.push([l.staff_name, engine._internal.ymd(run.period_to), hrs(l.hours_worked),
        fmt(l.gross_pence), fmt(l.tax_pence), fmt(l.ni_pence), fmt(l.pension_pence), fmt(l.net_pence)].map(esc).join(',')));
    } else if (format === 'brightpay') {
      out.push(['Name', 'Hours', 'Gross', 'PAYE', 'NI Employee', 'NI Employer', 'Pension', 'Net'].map(esc).join(','));
      payable.forEach(l => {
        const erNI = Math.round(Math.max(0, (Number(l.gross_pence) || 0) - engine.PAYE.ni_primary_threshold_monthly_pence) * engine.PAYE.ni_employer_rate);
        out.push([l.staff_name, hrs(l.hours_worked), fmt(l.gross_pence), fmt(l.tax_pence),
          fmt(l.ni_pence), fmt(erNI), fmt(l.pension_pence), fmt(l.net_pence)].map(esc).join(','));
      });
    } else {
      // Quoted: these caveats contain commas, and an unquoted one splits across
      // two cells the moment Excel opens the file.
      [
        `# Wren payroll — ${run.period_label} (${engine._internal.ymd(run.period_from)} to ${engine._internal.ymd(run.period_to)})`,
        `# Status: ${run.status}. Generated ${new Date(run.created_at).toLocaleString('en-GB')}.`,
        '# Hours source is stated per line. INFERRED means Wren calculated the hours from the rota or the work pattern — there are no clock-in records for this setting.',
        '# MISSING means no hourly rate and no annual salary is on file for that person. It is not a zero — do not pay it as one.',
        '# Tax, NI and pension are basic-rate estimates. Use payroll software for the real figures and for the HMRC RTI submission.',
      ].forEach(c => out.push(esc(c)));
      out.push(['Name', 'Role', 'Pay basis', 'Contracted hours', 'Paid hours', 'Absence deducted (h)',
        'TOIL (h)', 'Hours source', 'Measured or inferred', 'Hourly rate (£)', 'Gross (£)',
        'Tax (£)', 'NI (£)', 'Pension (£)', 'Net (£)', 'Warnings'].map(esc).join(','));
      lines.forEach(l => out.push([
        l.staff_name, l.role || '', l.pay_basis || '',
        hrs(l.contracted_hours), hrs(l.hours_worked), hrs(l.absence_hours), hrs(l.toil_hours),
        engine.sourceLabel(l.hours_source), l.hours_inferred ? 'INFERRED' : 'measured',
        // No rate → no gross → no deductions. 0.00 in a Tax column reads as
        // "nothing was deducted"; MISSING says "we could not work this out".
        ...(l.pay_basis === 'unknown'
          ? ['MISSING', 'MISSING', 'MISSING', 'MISSING', 'MISSING', 'MISSING']
          : [fmt(l.hourly_rate_pence), fmt(l.gross_pence), fmt(l.tax_pence),
             fmt(l.ni_pence), fmt(l.pension_pence), fmt(l.net_pence)]),
        (l.warnings || []).map(w => w.message).join(' | '),
      ].map(esc).join(',')));
      const sum = k => lines.reduce((a, l) => a + (Number(l[k]) || 0), 0);
      out.push(['TOTAL', '', '', hrs(sum('contracted_hours')), hrs(sum('hours_worked')),
        hrs(sum('absence_hours')), hrs(sum('toil_hours')), '', '', '',
        fmt(sum('gross_pence')), fmt(sum('tax_pence')), fmt(sum('ni_pence')),
        fmt(sum('pension_pence')), fmt(sum('net_pence')), ''].map(esc).join(','));
    }

    const filename = `payroll-${engine._internal.ymd(run.period_from)}-to-${engine._internal.ymd(run.period_to)}${format === 'wren' ? '' : '-' + format}.csv`;
    recordAudit({ req, action: 'download', entity_type: 'payroll_run', entity_id: run.id, meta: { format } });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"` });
    res.send('﻿' + out.join('\r\n'));   // BOM so Excel reads the £ signs
  } catch (e) {
    console.error('[payroll] export csv:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── GET /api/payroll/runs/:id/export.pdf ────────────────────────────────────
// The printable summary Toby hands to the accountant. Same pdfkit pattern as
// routes/rota.js payroll.pdf.
router.get('/runs/:id/export.pdf', requireSalaryView, async (req, res) => {
  const db = getPool();
  try {
    const run = await loadRun(db, req.params.id);
    if (!run) return res.status(404).json({ error: 'not_found' });
    const { rows: lines } = await db.query(
      'SELECT * FROM payroll_staff_lines WHERE run_id=$1 ORDER BY staff_name', [run.id]);

    const doc = new PDFDoc({ size: 'A4', layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const done = new Promise((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject);
    });

    const money = p => '£' + ((Number(p) || 0) / 100).toFixed(2);
    const hrs = h => (Number(h) || 0).toFixed(2);

    doc.fontSize(17).fillColor('#0f172a').text('Your Nursery — Payroll');
    doc.moveDown(0.15).fontSize(10).fillColor('#475569').text(
      `${run.period_label}  ·  ${engine._internal.ymd(run.period_from)} to ${engine._internal.ymd(run.period_to)}  ·  ${run.status.toUpperCase()}` +
      `   (printed ${new Date().toLocaleString('en-GB')})`);
    doc.moveDown(0.5);

    const inferred = lines.filter(l => l.hours_inferred).length;
    if (inferred) {
      doc.fontSize(8.5).fillColor('#b45309').text(
        `HOURS ARE INFERRED on ${inferred} of ${lines.length} lines. There are no clock-in records for this period — ` +
        'Wren calculated these hours from the published rota and the contracted work patterns. Check them before paying.',
        { width: 740 });
      doc.moveDown(0.4);
    }

    const x0 = 40;
    const widths = [140, 66, 58, 58, 62, 70, 62, 58, 62, 70];
    const header = ['Staff', 'Source', 'Contract h', 'Paid h', 'Rate', 'Gross', 'Tax', 'NI', 'Pension', 'Net'];
    let y = doc.y;
    const drawRow = (cells, opts = {}) => {
      let x = x0;
      doc.fontSize(opts.head ? 8.5 : 8.6)
         .fillColor(opts.head ? '#334155' : (opts.total ? '#0f172a' : (opts.warn ? '#b45309' : '#1e293b')))
         .font(opts.head || opts.total ? 'Helvetica-Bold' : 'Helvetica');
      cells.forEach((c, i) => {
        doc.text(String(c == null ? '' : c), x + 3, y + 3, { width: widths[i] - 6, align: i === 0 ? 'left' : 'right' });
        x += widths[i];
      });
      y += 17;
      doc.moveTo(x0, y).lineTo(x0 + widths.reduce((a, b) => a + b, 0), y)
         .strokeColor('#e2e8f0').lineWidth(0.5).stroke();
    };
    drawRow(header, { head: true });
    for (const l of lines) {
      if (y > 500) {
        doc.addPage({ layout: 'landscape', margins: { top: 40, bottom: 40, left: 40, right: 40 } });
        y = 40; drawRow(header, { head: true });
      }
      const missing = l.pay_basis === 'unknown';
      drawRow([
        l.staff_name,
        (l.hours_inferred ? '~' : '') + String(l.hours_source || '—').replace(/_/g, ' '),
        hrs(l.contracted_hours), hrs(l.hours_worked),
        missing ? 'MISSING' : money(l.hourly_rate_pence),
        missing ? 'MISSING' : money(l.gross_pence),
        missing ? 'MISSING' : money(l.tax_pence),
        missing ? 'MISSING' : money(l.ni_pence),
        missing ? 'MISSING' : money(l.pension_pence),
        missing ? 'MISSING' : money(l.net_pence),
      ], { warn: missing || (l.warnings || []).length > 0 });
    }
    const sum = k => lines.reduce((a, l) => a + (Number(l[k]) || 0), 0);
    drawRow(['TOTAL', '', hrs(sum('contracted_hours')), hrs(sum('hours_worked')), '',
      money(sum('gross_pence')), money(sum('tax_pence')), money(sum('ni_pence')),
      money(sum('pension_pence')), money(sum('net_pence'))], { total: true });

    doc.font('Helvetica').fontSize(7.6).fillColor('#64748b').text(
      'A "~" before the source means the hours are INFERRED, not measured — staff_shifts holds no clock-in records for this setting. ' +
      'Tax, NI and pension are basic-rate estimates only: no tax-code arithmetic, no NI category letters, no student loan, no salary sacrifice. ' +
      'Use BrightPay, Sage or Xero Payroll for the figures you actually pay and for the HMRC RTI submission. ' +
      'MISSING means no hourly rate and no annual salary is on file for that person — it is not a zero.',
      x0, y + 10, { width: widths.reduce((a, b) => a + b, 0) });

    doc.end();
    const buf = await done;
    recordAudit({ req, action: 'download', entity_type: 'payroll_run', entity_id: run.id, meta: { format: 'pdf' } });
    res.set({ 'Content-Type': 'application/pdf', 'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="payroll-${engine._internal.ymd(run.period_from)}-to-${engine._internal.ymd(run.period_to)}.pdf"` });
    res.send(buf);
  } catch (e) {
    console.error('[payroll] export pdf:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ── Templates ───────────────────────────────────────────────────────────────
// "Payroll templates" = a saved run configuration. Generate can start from one
// instead of Toby re-picking the same options every month.
router.get('/templates', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM payroll_templates ORDER BY is_default DESC, lower(name)');
    res.json({ templates: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/templates', requireSalaryView, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Template needs a name' });
  try {
    if (b.is_default) await db.query('UPDATE payroll_templates SET is_default=false WHERE is_default');
    const { rows: [t] } = await db.query(`
      INSERT INTO payroll_templates
        (name, period_shape, include_roles, exclude_staff_ids, deduct_absence, pay_toil,
         include_inactive, is_default, notes, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [String(b.name).trim(), b.period_shape || 'monthly',
       JSON.stringify(b.include_roles || []), JSON.stringify(b.exclude_staff_ids || []),
       b.deduct_absence !== false, !!b.pay_toil, !!b.include_inactive, !!b.is_default,
       b.notes || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'payroll_template', entity_id: t.id, meta: { name: t.name } });
    res.json({ ok: true, template: t });
  } catch (e) {
    if (String(e.message).includes('payroll_templates_name_uq')) {
      return res.status(409).json({ error: 'duplicate_name', message: 'A template with that name already exists.' });
    }
    res.status(500).json({ error: e.message });
  }
});

router.patch('/templates/:id', requireSalaryView, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  try {
    if (b.is_default) await db.query('UPDATE payroll_templates SET is_default=false WHERE is_default');
    const { rows: [t] } = await db.query(`
      UPDATE payroll_templates SET
        name              = COALESCE($1, name),
        period_shape      = COALESCE($2, period_shape),
        include_roles     = COALESCE($3::jsonb, include_roles),
        exclude_staff_ids = COALESCE($4::jsonb, exclude_staff_ids),
        deduct_absence    = COALESCE($5, deduct_absence),
        pay_toil          = COALESCE($6, pay_toil),
        include_inactive  = COALESCE($7, include_inactive),
        is_default        = COALESCE($8, is_default),
        notes             = COALESCE($9, notes),
        updated_at        = NOW()
      WHERE id=$10 RETURNING *`,
      [b.name || null, b.period_shape || null,
       b.include_roles ? JSON.stringify(b.include_roles) : null,
       b.exclude_staff_ids ? JSON.stringify(b.exclude_staff_ids) : null,
       b.deduct_absence == null ? null : !!b.deduct_absence,
       b.pay_toil == null ? null : !!b.pay_toil,
       b.include_inactive == null ? null : !!b.include_inactive,
       b.is_default == null ? null : !!b.is_default,
       b.notes == null ? null : b.notes, req.params.id]);
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, template: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── helpers ─────────────────────────────────────────────────────────────────
async function loadRun(db, id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return null;
  const { rows: [run] } = await db.query('SELECT * FROM payroll_runs WHERE id=$1', [n]);
  return run || null;
}

async function loadTemplate(db, id) {
  if (!id) return null;
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return null;
  const { rows: [t] } = await db.query('SELECT * FROM payroll_templates WHERE id=$1', [n])
    .catch(() => ({ rows: [] }));
  return t || null;
}

/** Rebuild the run-level caveats from the warnings stored on its lines. */
function runDataQuality(lines) {
  const q = [];
  const byCode = {};
  lines.forEach(l => (l.warnings || []).forEach(w => {
    (byCode[w.code] = byCode[w.code] || []).push(l.staff_name);
  }));
  if (byCode.no_hours_source) {
    q.push({ level: 'bad', issue: `${byCode.no_hours_source.length} staff have no hours source`,
      detail: 'No clock-in record, no rota and no work pattern: ' + byCode.no_hours_source.join(', ') + '. These are not zero-hours lines — Wren has no data for them.' });
  }
  if (byCode.no_pay_rate) {
    q.push({ level: 'bad', issue: `${byCode.no_pay_rate.length} staff have no pay rate on file`,
      detail: byCode.no_pay_rate.join(', ') + '. Add an hourly rate or annual salary on the staff record, then regenerate.' });
  }
  if (byCode.no_work_pattern) {
    q.push({ level: 'warn', issue: `${byCode.no_work_pattern.length} staff have no work pattern`,
      detail: byCode.no_work_pattern.join(', ') + '.' });
  }
  if (byCode.partial_rota) {
    q.push({ level: 'warn', issue: `${byCode.partial_rota.length} staff had only a partial rota`,
      detail: 'The published rota did not cover the whole period, so the work pattern was used: ' + byCode.partial_rota.join(', ') + '.' });
  }
  const inferred = lines.filter(l => l.hours_inferred).length;
  if (inferred) {
    q.push({ level: 'warn', issue: `${inferred} of ${lines.length} lines have INFERRED hours`,
      detail: 'staff_shifts holds no clock-in records, so these hours were calculated from the rota or the work pattern. They are not a measurement.' });
  }
  q.push({ level: 'info', issue: 'Tax, NI and pension are estimates',
    detail: 'Basic-rate PAYE only. Use BrightPay, Sage or Xero Payroll for the real figures and the RTI submission.' });
  return q;
}

// ── b363 (2026-09-29) — the payroll details importer ────────────────────────
// Mounted here rather than as its own /api prefix so it inherits this segment's
// portal rules as written: 'payroll' is already on PARENT_DENY, HR_DENY,
// OFFSITE_CHILD and FINANCE_SET in editions/ladn/server-unified.js, and a new
// top-level prefix would have had to be added to all four correctly.
//
// It sits BELOW this router's requireStaffAdmin (so a practitioner never reaches
// it) and adds requireSalaryView of its own (so a deputy manager does not
// either) — the one place the deputy's hours-not-pay split is tighter here than
// on the rest of the screen. Mounted last: every route above is a literal path,
// so nothing of theirs is shadowed. See src/routes/payroll-import.js.
// try/catch, the same shape server-unified.js uses for its own optional mounts:
// prod is a BAKED image, so a hotfix that copies this file without its new
// sibling would otherwise take the whole Payroll screen down rather than just
// the importer. A missing importer must cost the importer only.
try {
  router.use('/import', require('./payroll-import'));
} catch (e) {
  console.error('mount payroll-import:', e.message);
}

module.exports = router;
