'use strict';
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const PDFDoc = require('pdfkit');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { runAllChecks, loadChecks } = require('../security/runner');

// ── All security endpoints require auth ──────────────────────────────────────
router.use(authenticate);

// GET /api/security/checks — list all checks with their latest result
router.get('/checks', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT
        sc.check_key, sc.category, sc.title, sc.description, sc.frequency_hours, sc.enabled,
        scr.ran_at, scr.status, scr.finding, scr.remediation, scr.duration_ms
      FROM security_checks sc
      LEFT JOIN LATERAL (
        SELECT ran_at, status, finding, remediation, duration_ms
        FROM security_check_results
        WHERE check_key = sc.check_key
        ORDER BY ran_at DESC LIMIT 1
      ) scr ON true
      ORDER BY sc.category, sc.title
    `);
    res.json(rows);
  } catch (e) {
    console.error('[security] checks:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/security/results/:key — history for a single check
router.get('/results/:key', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id, check_key, ran_at, status, finding, remediation, evidence_json, duration_ms
      FROM security_check_results
      WHERE check_key = $1
      ORDER BY ran_at DESC LIMIT 20
    `, [req.params.key]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/security/run-checks — trigger all checks immediately (manager only)
router.post('/run-checks', (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
}, async (req, res) => {
  try {
    const triggeredBy = req.user?.name || req.user?.email || 'admin';
    const result = await runAllChecks(triggeredBy);
    res.json(result);
  } catch (e) {
    console.error('[security] run-checks:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/security/generate-test-token — creates an external test token (Flow B)
router.post('/generate-test-token', async (req, res) => {
  try {
    const db = getPool();
    const token = crypto.randomBytes(16).toString('hex'); // 32 hex chars
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 min
    await db.query(`
      INSERT INTO external_test_tokens (token, expires_at)
      VALUES ($1, $2)
    `, [token, expiresAt]);
    res.json({ token, expires_at: expiresAt.toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/security/external-test-status/:token — poll for result
router.get('/external-test-status/:token', async (req, res) => {
  try {
    const db = getPool();
    const { rows: [row] } = await db.query(
      'SELECT token, created_at, expires_at, used_at, result_json FROM external_test_tokens WHERE token=$1',
      [req.params.token]
    );
    if (!row) return res.status(404).json({ error: 'Token not found' });
    res.json({
      token: row.token,
      created_at: row.created_at,
      expires_at: row.expires_at,
      expired: new Date(row.expires_at) < new Date(),
      used: !!row.used_at,
      used_at: row.used_at,
      result: row.result_json,
    });
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/security/summary — category-level rollup
router.get('/summary', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sc.category,
             count(*) AS total,
             count(*) FILTER (WHERE scr.status='pass') AS pass_count,
             count(*) FILTER (WHERE scr.status='warn') AS warn_count,
             count(*) FILTER (WHERE scr.status='fail') AS fail_count,
             count(*) FILTER (WHERE scr.status='error') AS error_count,
             count(*) FILTER (WHERE scr.status IS NULL) AS pending_count,
             max(scr.ran_at) AS last_run
      FROM security_checks sc
      LEFT JOIN LATERAL (
        SELECT status, ran_at
        FROM security_check_results
        WHERE check_key = sc.check_key
        ORDER BY ran_at DESC LIMIT 1
      ) scr ON true
      WHERE sc.enabled = true
      GROUP BY sc.category
      ORDER BY sc.category
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── PDF report ────────────────────────────────────────────────────────────────
router.get('/pdf-report', async (req, res) => {
  try {
    const db = getPool();

    const { rows: checks } = await db.query(`
      SELECT
        sc.check_key, sc.category, sc.title, sc.description, sc.enabled,
        scr.ran_at, scr.status, scr.finding, scr.remediation, scr.evidence_json
      FROM security_checks sc
      LEFT JOIN LATERAL (
        SELECT ran_at, status, finding, remediation, evidence_json
        FROM security_check_results
        WHERE check_key = sc.check_key
        ORDER BY ran_at DESC LIMIT 1
      ) scr ON true
      WHERE sc.enabled = true
      ORDER BY sc.category, sc.title
    `);

    const { rows: [settings] } = await db.query(
      "SELECT value FROM settings WHERE key='setting_name' LIMIT 1"
    ).catch(() => ({ rows: [{ value: 'Your Setting' }] }));

    const settingName = settings?.value || 'Your Setting';

    const counts = { pass: 0, warn: 0, fail: 0, error: 0, pending: 0 };
    for (const c of checks) {
      if (!c.status) counts.pending++;
      else counts[c.status] = (counts[c.status] || 0) + 1;
    }

    const overall = counts.fail > 0 ? 'FAIL' : counts.warn > 0 ? 'WARN' : 'PASS';
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const version = process.env.WREN_VERSION || '1.x';

    // Build PDF
    const doc = new PDFDoc({ size: 'A4', margins: { top: 60, bottom: 60, left: 60, right: 60 }, autoFirstPage: false });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="wren-security-report-${now.toISOString().slice(0,10)}.pdf"`);
    doc.pipe(res);

    // Status colour helper
    const statusColour = (s) => ({ pass: '#16a34a', warn: '#f59e0b', fail: '#dc2626', error: '#6b7280' }[s] || '#6b7280');
    const statusLabel = (s) => ({ pass: '✓ PASS', warn: '⚠ WARN', fail: '✗ FAIL', error: '? ERROR' }[s] || '— PENDING');

    const footer = (d) => {
      d.fontSize(8).fillColor('#6b7280')
        .text(`Generated by Wren v${version} on ${dateStr} for ${settingName}. Self-check report — automated, no human Wren involvement.`, 60, d.page.height - 50, { align: 'center', width: d.page.width - 120 });
    };

    // ── PAGE 1: Cover ─────────────────────────────────────────────────────────
    doc.addPage();
    doc.rect(0, 0, doc.page.width, 180).fill('#0f172a');
    doc.fillColor('#4a9abf').fontSize(28).font('Helvetica-Bold')
      .text('Wren', 60, 60);
    doc.fillColor('#f1f5f9').fontSize(20)
      .text('Security Posture Report', 60, 95);
    doc.fillColor('#94a3b8').fontSize(11)
      .text(settingName, 60, 125)
      .text(dateStr, 60, 143);

    // Overall status badge
    const badgeCol = statusColour(overall.toLowerCase());
    doc.rect(doc.page.width - 140, 60, 80, 80).fill(badgeCol);
    doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold')
      .text(overall, doc.page.width - 140, 88, { width: 80, align: 'center' });

    // Summary counts
    doc.fillColor('#0f172a').fontSize(11).font('Helvetica')
      .text(`Software version: Wren v${version}`, 60, 205)
      .text(`Report generated: ${now.toLocaleString('en-GB')}`, 60, 222)
      .text(`Checks run: ${checks.length}`, 60, 239);

    const row = [
      { label: 'Passing', count: counts.pass, col: '#16a34a' },
      { label: 'Warnings', count: counts.warn, col: '#f59e0b' },
      { label: 'Failures', count: counts.fail, col: '#dc2626' },
      { label: 'Errors/Pending', count: counts.error + counts.pending, col: '#6b7280' },
    ];
    let bx = 60;
    for (const { label, count, col } of row) {
      doc.rect(bx, 270, 100, 60).fill(col);
      doc.fillColor('#ffffff').fontSize(24).font('Helvetica-Bold').text(String(count), bx, 280, { width: 100, align: 'center' });
      doc.fillColor('#ffffff').fontSize(9).font('Helvetica').text(label, bx, 307, { width: 100, align: 'center' });
      bx += 110;
    }

    // Self-host statement
    doc.rect(60, 355, doc.page.width - 120, 70).fill('#e0f2fe');
    doc.fillColor('#0c4a6e').fontSize(10).font('Helvetica').text(
      `This report describes the security posture of the Wren installation at ${settingName} as observed by automated self-checks running on the setting's own hardware. No data left the premises in the production of this report.`,
      75, 368, { width: doc.page.width - 150 }
    );

    footer(doc);

    // ── PAGE 2: Category summary ──────────────────────────────────────────────
    doc.addPage();
    doc.fillColor('#0f172a').fontSize(18).font('Helvetica-Bold').text('Summary by Category', 60, 60);

    const categories = [...new Set(checks.map(c => c.category))].sort();
    let y = 100;

    for (const cat of categories) {
      const catChecks = checks.filter(c => c.category === cat);
      const worstStatus = catChecks.reduce((w, c) => {
        const order = { fail: 0, error: 1, warn: 2, pass: 3 };
        if ((order[c.status] ?? 4) < (order[w] ?? 4)) return c.status;
        return w;
      }, 'pass');

      doc.rect(60, y, doc.page.width - 120, 40).fill(worstStatus ? statusColour(worstStatus) + '22' : '#f8f9fa');
      doc.rect(60, y, 6, 40).fill(statusColour(worstStatus || 'pass'));
      doc.fillColor('#0f172a').fontSize(12).font('Helvetica-Bold').text(cat.toUpperCase(), 76, y + 6);
      doc.fontSize(9).font('Helvetica').fillColor('#4a4a4a').text(
        catChecks.map(c => `${statusLabel(c.status)} ${c.title}`).join('  ·  '),
        76, y + 22, { width: doc.page.width - 160 }
      );
      y += 50;
    }

    footer(doc);

    // ── PAGES 3+: Per-category detail ────────────────────────────────────────
    for (const cat of categories) {
      const catChecks = checks.filter(c => c.category === cat);
      doc.addPage();
      doc.rect(0, 0, doc.page.width, 50).fill('#0f172a');
      doc.fillColor('#f1f5f9').fontSize(16).font('Helvetica-Bold')
        .text(cat.toUpperCase() + ' CHECKS', 60, 15);

      y = 70;
      for (const c of catChecks) {
        // Check needs space — add page if not enough
        if (y > doc.page.height - 180) {
          footer(doc);
          doc.addPage();
          y = 60;
        }

        const col = statusColour(c.status || 'pending');
        doc.rect(60, y, doc.page.width - 120, 28).fill(col + '22');
        doc.rect(60, y, 4, 28).fill(col);
        doc.fillColor(col).fontSize(9).font('Helvetica-Bold').text(statusLabel(c.status || '—'), 72, y + 5);
        doc.fillColor('#0f172a').fontSize(11).font('Helvetica-Bold').text(c.title, 130, y + 6);
        if (c.ran_at) {
          doc.fillColor('#6b7280').fontSize(8).font('Helvetica')
            .text(`Last run: ${new Date(c.ran_at).toLocaleString('en-GB')}`, doc.page.width - 180, y + 9);
        }
        y += 34;

        if (c.finding) {
          doc.fillColor('#1e293b').fontSize(9).font('Helvetica').text('Finding: ' + c.finding, 76, y, { width: doc.page.width - 156 });
          y += doc.heightOfString('Finding: ' + c.finding, { width: doc.page.width - 156, fontSize: 9 }) + 6;
        }

        if (c.remediation && (c.status === 'fail' || c.status === 'warn')) {
          doc.fillColor('#b45309').fontSize(9).font('Helvetica').text('How to fix: ' + c.remediation, 76, y, { width: doc.page.width - 156 });
          y += doc.heightOfString(c.remediation, { width: doc.page.width - 156, fontSize: 9 }) + 14;
        } else {
          y += 8;
        }

        doc.rect(60, y, doc.page.width - 120, 0.5).fill('#e5e7eb');
        y += 10;
      }

      footer(doc);
    }

    doc.end();
  } catch (e) {
    console.error('[security] pdf-report:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'PDF generation failed: ' + e.message });
  }
});

module.exports = router;
