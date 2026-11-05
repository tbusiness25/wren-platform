'use strict';
/**
 * finance-termly-report.js (route) — b346 (2026-09-21)
 *
 * Finance → HMRC & Deadlines → Termly report: what we took, where it went, and what
 * rose against the same months last year — over RECONCILED months only.
 *
 *   GET /api/finance/termly-report/terms          the funding terms, newest first, and which are finished
 *   GET /api/finance/termly-report?term_id=N      the report for one term
 *
 * A READ. There is deliberately no endpoint here that writes, syncs, files or posts
 * anything, and nothing here calls Xero: it reads what src/lib/xero-reports.js has
 * already synced. When a period is not reconciled it returns the WARNING and no
 * figures (see src/lib/finance-termly.js for exactly what "reconciled" means and why
 * Wren cannot decide it for itself).
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Manager role AND the admin (Roost) portal, both enforced here — an EY manager token
 * carries aud='learning' and would otherwise pass requireRole('manager') — the same
 * guard as finance-intel.js. Staff pay is a SECOND gate on top (canViewSalaries): for
 * anyone without it every staff-cost line is removed from the rows, the totals, the
 * shares and the net, so pay cannot be recovered by subtraction.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { canViewSalaries } = require('../lib/capabilities');
const termly = require('../lib/finance-termly');
const store = require('../lib/finance-calendar-store');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

function managerAdminOnly(req, res, next) {
  if ((req._portal || null) !== 'admin') {
    return res.status(403).json({ error: 'forbidden_portal', message: 'The termly money report is available on the Roost (admin) portal only.' });
  }
  // b480: 'accountant' added — safe only because the accountant-scope gate in
  // server-unified.js has already restricted that role to GET requests on a
  // short allowlist (this router's paths included) before this ever runs.
  // Staff pay is a second, independent gate below (canViewSalaries / attachPayVisibility).
  if (!req.user || !hasRole(req.user, ['manager', 'admin', 'accountant'])) {
    return res.status(403).json({ error: 'forbidden_role', message: 'Manager access only — these figures are commercially sensitive.' });
  }
  next();
}
async function attachPayVisibility(req, _res, next) {
  try { req._canSeePay = await canViewSalaries(req.user); } catch { req._canSeePay = false; }   // fail closed
  next();
}
const guard = [authenticate, managerAdminOnly, attachPayVisibility];

const ADVISORY = 'Read-only. Nothing here books, pays, files or changes a figure, and nothing calls Xero. '
               + 'A month that is not reconciled produces a warning, never an estimate.';

router.get('/terms', guard, async (req, res) => {
  try {
    const today = store.londonToday();
    const terms = await termly.listTerms(getPool(), { today });
    const finished = terms.filter(t => t.finished);
    res.json({
      ok: true, today,
      default_term_id: finished.length ? finished[0].id : (terms[0] && terms[0].id) || null,
      terms: terms.map(t => ({ id: t.id, name: t.name, start: t.start, end: t.end, season: t.season, finished: t.finished,
                               months: t.months.length, prior_term_id: t.prior_term_id })),
      advisory: ADVISORY,
    });
  } catch (e) {
    console.error('[finance-termly-report] terms:', e.message);
    res.status(500).json({ error: 'terms_failed', message: e.message });
  }
});

router.get('/', guard, async (req, res) => {
  try {
    const termId = parseInt(req.query.term_id, 10);
    if (!Number.isFinite(termId)) return res.status(400).json({ error: 'term_required', message: 'term_id is required.' });
    const out = await termly.termlyReport(getPool(), { termId, canPay: !!req._canSeePay });
    if (!out.ok) return res.status(404).json(out);
    res.json(Object.assign({}, out, { advisory: ADVISORY }));
  } catch (e) {
    console.error('[finance-termly-report]', e.message);
    res.status(500).json({ error: 'report_failed', message: e.message });
  }
});

module.exports = router;
