'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b423 (2026-10-08, DEV ONLY — wren_dev / wren-ladn-dev:3015). Editable EyLog opening
// balance, per child. The money rule lives in src/lib/opening-balance.js; this is just
// the HTTP edge for it, mirroring the manager-only gate finance-payments.js (b397) uses.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { setOpeningBalance, getOpeningBalance } = require('../lib/opening-balance');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
router.use((req, res, next) => {
  // b480 (dev, 12 Oct — never ported until now): 'accountant' belongs here. The
  // accountant-scope gate in editions/ladn/server-unified.js has ALREADY restricted
  // that role to GET/HEAD on a short finance allow-list before this middleware ever
  // runs, and /finance/opening-balance is on it (src/lib/accountant-gate.js:
  // ACCOUNTANT_ALLOWED_PATHS). So without this line the accountant is allow-listed
  // by the outer gate and then refused here — a 403 on a route written for him.
  // The PUT below is unreachable for that role: the outer gate rejects the verb.
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'accountant'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

// ── GET /api/finance/opening-balance/:childId — current value + change history ────────
router.get('/:childId', async (req, res) => {
  try {
    const data = await getOpeningBalance(getPool(), req.params.childId);
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/finance/opening-balance/:childId — set/correct it ────────────────────────
// Body: { balance_pence, reason, preview?, override? }. +ve = owed, -ve = in credit, 0 = none.
// preview:true runs the same change in a rolled-back transaction and returns the family's
// real before/after ledger balance — nothing is saved, no reason required, no audit written.
router.put('/:childId', async (req, res) => {
  const { balance_pence, reason, preview, override } = req.body || {};
  if (balance_pence === undefined || balance_pence === null || !Number.isFinite(Number(balance_pence))) {
    return res.status(400).json({ error: 'balance_pence required' });
  }
  if (!preview && (!reason || !String(reason).trim())) {
    return res.status(400).json({ error: 'reason required' });
  }
  try {
    const result = await setOpeningBalance(getPool(), req.params.childId, balance_pence,
      { reason: reason ? String(reason).trim() : null, req, preview: !!preview, override: !!override });
    if (!preview && !result.no_op) {
      recordAudit({ req, action: 'update', entity_type: 'opening_balance', entity_id: parseInt(req.params.childId, 10),
        diff: { old: { balance_pence: result.old_pence }, new: { balance_pence: result.new_pence } },
        meta: { reason: String(reason).trim() } });
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    const status = e.code === 'not_found' ? 404 : (e.code === 'needs_override' || e.code === 'locked_funds') ? 409 : e.code === 'bad_request' ? 400 : 500;
    res.status(status).json({ error: e.message, code: e.code, can_override: e.can_override || undefined, pre: e.pre || undefined });
  }
});

module.exports = router;
