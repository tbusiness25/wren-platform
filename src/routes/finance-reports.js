'use strict';
/**
 * finance-reports.js — b227 (2026-08-25)
 *
 * The finance report pack. Five reports, each of them a READ:
 *
 *   GET /api/finance/reports/income        income by month and room, gross/discount/net
 *   GET /api/finance/reports/aged-debtors  current / 30 / 60 / 90+ from the invoice ledger
 *   GET /api/finance/reports/funding       funded hours claimed vs billed, per term
 *   GET /api/finance/reports/payments      payments by method and month, incl. unallocated
 *   GET /api/finance/reports/chase-list    who to chase, how much, how overdue
 *
 * Every one takes ?format=csv for the same figures as a spreadsheet. Nothing here
 * writes to invoices, payments or allocations, and nothing here calls Xero.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Manager role AND the admin (Roost) portal, both checked server-side, exactly as
 * src/routes/finance-intel.js does. The role check ALONE is not enough: a manager
 * signing in on the EY portal holds a token with audience 'learning', and that
 * token passes requireRole('manager') on every shared route. These reports name
 * families and what they owe. That belongs on one portal, so the portal is checked.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const reports = require('../lib/finance-reports');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// ── the guard ────────────────────────────────────────────────────────────────
// Same shape and same wording as finance-intel.js. req._portal is set by the
// hostname dispatcher in editions/ladn/server-unified.js; a request with no portal
// is refused rather than defaulted, because failing open on a finance route is not
// a trade-off worth making.
function managerAdminOnly(req, res, next) {
  const portal = req._portal || null;
  if (portal !== 'admin') {
    return res.status(403).json({
      error: 'forbidden_portal',
      message: 'Finance reports are available on the Roost (admin) portal only.',
    });
  }
  // b480: 'accountant' added — safe only because the accountant-scope gate in
  // server-unified.js has already restricted that role to GET requests on a
  // short allowlist (this router's paths included) before this ever runs.
  if (!req.user || !hasRole(req.user, ['manager', 'admin', 'accountant'])) {
    return res.status(403).json({
      error: 'forbidden_role',
      message: 'Manager access only — these figures name families and what they owe.',
    });
  }
  next();
}

const guard = [authenticate, managerAdminOnly];

const intParam = (v, def, min, max) => {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
};
const boolParam = v => v === '1' || v === 'true' || v === 'yes';

// The standing rule, carried on every payload so it cannot be read without it.
const ADVISORY = 'Reports are read-only. Nothing in this module writes an invoice, a payment or an allocation, '
               + 'and nothing here chases, emails or charges anybody. Aged debtors are computed from Wren\'s own '
               + 'ledger, never from the Xero API.';

const FILENAME = {
  income: 'wren-income-summary',
  'income-by-period': 'wren-income-by-invoice-period',
  'aged-debtors': 'wren-aged-debtors',
  funding: 'wren-funding-reconciliation',
  payments: 'wren-payments-received',
  'chase-list': 'wren-debtor-chase-list',
};

/**
 * One handler shape for all five. JSON by default; ?format=csv sends the same
 * numbers as a spreadsheet, with the caveats appended as trailing rows so saving
 * the file cannot separate the figures from what qualifies them.
 */
function serve(name, handler) {
  return async (req, res) => {
    try {
      const data = await handler(getPool(), req);
      if ((req.query.format || '').toLowerCase() === 'csv') {
        const csv = reports.toCsv(name, data);
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition',
          `attachment; filename="${FILENAME[name]}-${stamp}.csv"`);
        res.setHeader('Cache-Control', 'no-store');
        // BOM: without it Excel opens a UTF-8 CSV as Windows-1252 and every £
        // becomes "Â£". The report is about money; the currency symbol has to survive.
        return res.send('﻿' + csv);
      }
      return res.json({ ...data, advisory: ADVISORY });
    } catch (e) {
      console.error(`finance-reports/${name}:`, e.message);
      return res.status(500).json({ error: 'report_failed', message: e.message });
    }
  };
}

// ── GET /income ──────────────────────────────────────────────────────────────
// ?months=13  ?basis=service|issued  ?include_drafts=1
router.get('/income', guard, serve('income', (db, req) => reports.incomeSummary(db, {
  months: intParam(req.query.months, 13, 1, 120),
  basis: req.query.basis === 'issued' ? 'issued' : 'service',
  includeDrafts: boolParam(req.query.include_drafts),
})));

// ── GET /income-by-period ────────────────────────────────────────────────────
// b365 — money received, counted in the month of the INVOICE it pays.
// ?months=13
router.get('/income-by-period', guard, serve('income-by-period', (db, req) =>
  reports.incomeByInvoicePeriod(db, {
    months: intParam(req.query.months, 13, 1, 120),
  })));

// ── GET /aged-debtors ────────────────────────────────────────────────────────
// ?as_at=YYYY-MM-DD  ?include_drafts=1  ?limit=500
router.get('/aged-debtors', guard, serve('aged-debtors', (db, req) => reports.agedDebtors(db, {
  asAt: req.query.as_at || null,
  includeDrafts: boolParam(req.query.include_drafts),
  limit: intParam(req.query.limit, 500, 1, 5000),
})));

// ── GET /funding ─────────────────────────────────────────────────────────────
// ?term_id=N  ?limit=500
router.get('/funding', guard, serve('funding', (db, req) => reports.fundingReconciliation(db, {
  termId: req.query.term_id || null,
  limit: intParam(req.query.limit, 500, 1, 2000),
})));

// ── GET /payments ────────────────────────────────────────────────────────────
// ?months=13
router.get('/payments', guard, serve('payments', (db, req) => reports.paymentsReceived(db, {
  months: intParam(req.query.months, 13, 1, 120),
})));

// ── GET /chase-list ──────────────────────────────────────────────────────────
// ?min_pence=1  ?limit=200  ?as_at=YYYY-MM-DD
router.get('/chase-list', guard, serve('chase-list', (db, req) => reports.chaseList(db, {
  minPence: intParam(req.query.min_pence, 1, 1, 100000000),
  limit: intParam(req.query.limit, 200, 1, 2000),
  asAt: req.query.as_at || null,
})));

// ── GET / ────────────────────────────────────────────────────────────────────
// What is in the pack, for the screen to build itself from.
router.get('/', guard, (req, res) => {
  res.json({
    reports: [
      { key: 'income', path: '/api/finance/reports/income', title: 'Income summary',
        blurb: 'By month and by room, split gross / discount / net and billable / funded. Partial months are '
             + 'flagged and kept out of the averages.' },
      { key: 'income-by-period', path: '/api/finance/reports/income-by-period', title: 'Income by invoice period',
        blurb: 'Money received, counted in the month of the invoice it pays rather than the day the bank moved. '
             + 'An October invoice settled on 28 September is October income. Money matched to no invoice is '
             + 'listed separately, on account, with the date it arrived.' },
      { key: 'aged-debtors', path: '/api/finance/reports/aged-debtors', title: 'Aged debtors',
        blurb: 'Current / 30 / 60 / 90+, per family, from the invoice ledger. The weekly one.' },
      { key: 'funding', path: '/api/finance/reports/funding', title: 'Funding reconciliation',
        blurb: 'Funded hours claimed against funded hours billed, per child. Reports the b202 stretched-hours '
             + 'gap; does not change it.' },
      { key: 'payments', path: '/api/finance/reports/payments', title: 'Payments received',
        blurb: 'By method and by month, including money received that is matched to no invoice.' },
      { key: 'chase-list', path: '/api/finance/reports/chase-list', title: 'Debtor chase list',
        blurb: 'Who to chase, how much, how overdue, when they were last contacted.' },
    ],
    advisory: ADVISORY,
  });
});

module.exports = router;
