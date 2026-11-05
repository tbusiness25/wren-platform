'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b325 — Finance → Reconcile → Matching.
// Mounted at /api/finance/payment-matching
//
// The family payment references, the children's Tax-Free Childcare references,
// the proposal queue a manager approves in bulk, and the payer memory.
//
// Manager-gated as a whole, the same guard finance-reconcile.js uses. Nothing
// here calls Xero: the bank feed is read from ladn.bank_statement_lines, which
// the existing Xero SYNC fills, and payments are recorded against WREN invoices.
// ─────────────────────────────────────────────────────────────────────────────

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const PR = require('../lib/payment-references');
const M  = require('../services/payment-matcher');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
router.use((req, res, next) => {
  // b480: 'accountant' added — safe only because the accountant-scope gate in
  // server-unified.js has already restricted that role to GET requests on a
  // short allowlist (this router's paths included) before this ever runs.
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'accountant'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

const idList = (v) => (Array.isArray(v) ? v : [])
  .map(n => parseInt(n, 10)).filter(Number.isInteger);

// ── Families and their references ────────────────────────────────────────────

// GET /families — every billing family, its reference, its children, its TFC refs.
router.get('/families', async (req, res) => {
  const db = getPool();
  try {
    const families = await M.listFamilies(db, { includeLeavers: req.query.leavers === '1' });
    res.json({
      families,
      without_ref: families.filter(f => !f.payment_ref).length,
      with_siblings: families.filter(f => Number(f.child_count) > 1).length,
    });
  } catch (e) {
    console.error('[b325] families:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /families/ensure-refs — give every family without one a reference.
// Idempotent: a family that already has one keeps it.
router.post('/families/ensure-refs', async (req, res) => {
  const db = getPool();
  try {
    const out = await M.ensureAllFamilyRefs(db, req.user?.id || null);
    recordAudit({ req, action: 'create', entity_type: 'family_payment_ref',
      meta: { feature: 'b325-ensure-refs', ...out } });
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[b325] ensure-refs:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /families/ref — one family. Body: { family_key }.
// The key is an email address, so it travels in the body and never in a path.
router.post('/families/ref', async (req, res) => {
  const db = getPool();
  const key = String(req.body?.family_key || '').toLowerCase().trim();
  if (!key) return res.status(400).json({ error: 'family_key required' });
  try {
    const out = await M.ensureFamilyRef(db, key, req.user?.id || null);
    if (out.created) {
      recordAudit({ req, action: 'create', entity_type: 'family_payment_ref',
        meta: { feature: 'b325-family-ref', payment_ref: out.payment_ref } });
    }
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('[b325] family ref:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── A child's Tax-Free Childcare reference ───────────────────────────────────

// PUT /children/:id/tfc-reference — Body: { tfc_reference }.
// WARN, NEVER BLOCK on the letters. A reference that is not four letters and five
// digits is refused (it is not a TFC reference at all); a reference whose letters
// disagree with our spelling of the name is SAVED, with the warning recorded
// against the child so the office can see why it looked odd.
router.put('/children/:id/tfc-reference', async (req, res) => {
  const db = getPool();
  const childId = parseInt(req.params.id, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  const raw = req.body?.tfc_reference;
  try {
    const { rows: [child] } = await db.query(
      'SELECT id, first_name, last_name FROM children WHERE id=$1', [childId]);
    if (!child) return res.status(404).json({ error: 'Child not found' });

    // Clearing it is allowed and is not an error.
    if (raw === null || String(raw ?? '').trim() === '') {
      await db.query(`UPDATE children
                         SET tfc_payment_reference=NULL, tfc_reference_warning=NULL,
                             tfc_reference_set_at=NULL, tfc_reference_source=NULL,
                             updated_at=now()
                       WHERE id=$1`, [childId]);
      recordAudit({ req, action: 'update', entity_type: 'child', entity_id: childId,
        meta: { feature: 'b325-tfc-reference', cleared: true } });
      return res.json({ ok: true, tfc_reference: null, warning: null });
    }

    const check = PR.checkTfcRef(raw, child.first_name, child.last_name);
    if (!check.ref) return res.status(400).json({ error: check.warning, code: 'bad_shape' });

    try {
      await db.query(`UPDATE children
                         SET tfc_payment_reference=$2, tfc_reference_warning=$3,
                             tfc_reference_set_at=now(), tfc_reference_source='office',
                             updated_at=now()
                       WHERE id=$1`, [childId, check.ref, check.warning]);
    } catch (e) {
      if (e.code === '23505') {
        return res.status(409).json({
          error: 'Another child already has this Tax-Free Childcare reference. '
               + 'HMRC issues one per child, so one of the two is wrong.',
          code: 'duplicate_tfc_reference' });
      }
      throw e;
    }
    // The reference itself is logged; the child's name is not.
    recordAudit({ req, action: 'update', entity_type: 'child', entity_id: childId,
      meta: { feature: 'b325-tfc-reference', warned: !check.ok } });
    res.json({ ok: true, tfc_reference: check.ref, warning: check.warning });
  } catch (e) {
    console.error('[b325] tfc-reference:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── The queue ────────────────────────────────────────────────────────────────

// POST /scan — the dry run. Writes proposals, moves no money unless auto-apply is
// switched on AND the match is one of the two certain kinds.
router.post('/scan', async (req, res) => {
  const db = getPool();
  try {
    const auto = await M.autoApplyEnabled(db);
    const out = await M.scanLines(db, {
      statementId: req.body?.statement_id ? parseInt(req.body.statement_id, 10) : null,
      limit: req.body?.limit,
      autoApply: auto,
      actorId: req.user?.id || null,
    });
    recordAudit({ req, action: 'run', entity_type: 'payment_match_proposal',
      meta: { feature: 'b325-scan', auto_apply: auto,
              scanned: out.scanned, proposed: out.proposed, applied: out.applied } });
    res.json({ ok: true, auto_apply: auto, ...out });
  } catch (e) {
    console.error('[b325] scan:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /proposals?status=pending — what the review screen shows.
router.get('/proposals', async (req, res) => {
  const db = getPool();
  const status = ['pending', 'applied', 'rejected', 'superseded', 'failed']
    .includes(req.query.status) ? req.query.status : 'pending';
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.bank_line_id, p.kind, p.certainty, p.family_key, p.child_id,
             p.amount_pence, p.allocation, p.evidence, p.status, p.auto_applied,
             p.created_at, p.decided_at, p.decided_reason,
             to_char(l.transaction_date, 'YYYY-MM-DD') AS transaction_date,
             l.description, l.reference AS line_reference, l.payee_name,
             f.payment_ref                                   AS family_payment_ref,
             c.first_name || ' ' || c.last_name              AS child_name,
             (SELECT string_agg(ch.first_name || ' ' || ch.last_name, ', ' ORDER BY ch.id)
                FROM children ch
               WHERE ${M.FAMILY_KEY_SQL('ch')} = p.family_key AND ch.status='active')
                                                             AS family_children
        FROM payment_match_proposals p
        LEFT JOIN bank_statement_lines l ON l.id = p.bank_line_id
        LEFT JOIN family_payment_refs f  ON f.family_key = p.family_key AND f.retired_at IS NULL
        LEFT JOIN children c             ON c.id = p.child_id
       WHERE p.status = $1
       ORDER BY p.certainty = 'certain' DESC, p.created_at DESC, p.id DESC
       LIMIT $2`, [status, limit]);
    res.json({
      status, proposals: rows,
      certain: rows.filter(r => r.certainty === 'certain').length,
      proposed: rows.filter(r => r.certainty !== 'certain').length,
    });
  } catch (e) {
    console.error('[b325] proposals:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /unmatched — credit lines we could not resolve at all.
router.get('/unmatched', async (req, res) => {
  const db = getPool();
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  try {
    const { rows } = await db.query(`
      SELECT l.id, to_char(l.transaction_date,'YYYY-MM-DD') AS transaction_date,
             l.description, l.reference, l.payee_name, l.amount_pence
        FROM bank_statement_lines l
       WHERE l.reconciled = false AND l.amount_pence > 0 AND l.excluded_reason IS NULL
         AND NOT EXISTS (SELECT 1 FROM payment_match_proposals p
                          WHERE p.bank_line_id = l.id AND p.status = 'pending')
       ORDER BY l.transaction_date DESC, l.id DESC
       LIMIT $1`, [limit]);
    res.json({ lines: rows });
  } catch (e) {
    console.error('[b325] unmatched:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /apply — bulk approve. Body: { ids: [...] }.
// Each proposal applies in its OWN transaction: one that has gone stale must not
// roll back the twenty beside it that were fine.
router.post('/apply', async (req, res) => {
  const db = getPool();
  const ids = idList(req.body?.ids);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const applied = [], failed = [];
  for (const id of ids) {
    try {
      const r = await M.applyProposal(db, id, { actorId: req.user?.id || null });
      applied.push(r);
    } catch (e) {
      failed.push({ proposal_id: id, error: e.message });
    }
  }
  recordAudit({ req, action: 'update', entity_type: 'payment_match_proposal',
    meta: { feature: 'b325-apply', requested: ids.length,
            applied: applied.length, failed: failed.length } });
  res.json({ ok: failed.length === 0, applied, failed,
             applied_count: applied.length, failed_count: failed.length });
});

// POST /reject — Body: { ids: [...], reason? }. The lines return to the queue.
router.post('/reject', async (req, res) => {
  const db = getPool();
  const ids = idList(req.body?.ids);
  if (!ids.length) return res.status(400).json({ error: 'ids required' });
  const reason = String(req.body?.reason || '').slice(0, 500) || null;
  const done = [], failed = [];
  for (const id of ids) {
    try { done.push(await M.rejectProposal(db, id, { actorId: req.user?.id || null, reason })); }
    catch (e) { failed.push({ proposal_id: id, error: e.message }); }
  }
  recordAudit({ req, action: 'update', entity_type: 'payment_match_proposal',
    meta: { feature: 'b325-reject', rejected: done.length, failed: failed.length } });
  res.json({ ok: failed.length === 0, rejected: done, failed });
});

// ── Manual assignment, and the payer memory it can leave behind ──────────────

// POST /assign — a manager says who a line belongs to.
// Body: { bank_line_id, family_key?, child_id?, remember_payer?, apply? }
//
// `remember_payer` is what makes match kind 3 exist at all: the next transaction
// from the same payer becomes a PROPOSAL rather than another unmatched line. It
// is never inferred — a manager has to tick it.
router.post('/assign', async (req, res) => {
  const db = getPool();
  const lineId = parseInt(req.body?.bank_line_id, 10);
  if (!Number.isInteger(lineId)) return res.status(400).json({ error: 'bank_line_id required' });
  let familyKey = String(req.body?.family_key || '').toLowerCase().trim() || null;
  const childId = req.body?.child_id ? parseInt(req.body.child_id, 10) : null;
  try {
    const { rows: [line] } = await db.query(
      'SELECT * FROM bank_statement_lines WHERE id=$1', [lineId]);
    if (!line) return res.status(404).json({ error: 'Bank line not found' });
    if (line.reconciled) return res.status(409).json({ error: 'That line is already reconciled' });

    if (childId) {
      const { rows: [c] } = await db.query(
        `SELECT ${M.FAMILY_KEY_SQL('c')} AS family_key FROM children c WHERE c.id=$1`, [childId]);
      if (!c) return res.status(404).json({ error: 'Child not found' });
      if (!c.family_key) {
        return res.status(409).json({
          error: 'That child has no bill payer email, so they are not in a billing family yet.' });
      }
      familyKey = c.family_key;
    }
    if (!familyKey) return res.status(400).json({ error: 'family_key or child_id required' });

    const plan = await M.planAllocation(db, {
      familyKey, childId, amountPence: line.amount_pence, onDate: line.transaction_date });

    const payerKey = req.body?.remember_payer
      ? PR.payerKey(line.payee_name, line.description) : null;
    let payerLinkId = null;
    if (req.body?.remember_payer) {
      if (!payerKey) {
        return res.status(400).json({
          error: 'There is no payer name on this line to remember — it would match everything.',
          code: 'no_payer_name' });
      }
      const { rows } = await db.query(`
        INSERT INTO payment_payer_links (payer_key, payer_label, family_key, confirmed_by)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (payer_key) WHERE revoked_at IS NULL DO NOTHING
        RETURNING id`, [payerKey, line.payee_name || line.description || null,
                        familyKey, req.user?.id || null]);
      if (rows.length) payerLinkId = rows[0].id;
      else {
        // Already remembered — possibly for a DIFFERENT family. Say so rather
        // than silently re-pointing somebody else's payments.
        const { rows: [have] } = await db.query(
          `SELECT id, family_key FROM payment_payer_links
            WHERE payer_key=$1 AND revoked_at IS NULL`, [payerKey]);
        if (have && have.family_key !== familyKey) {
          return res.status(409).json({
            error: 'That payer is already remembered for a different family. '
                 + 'Revoke the existing link first if it has genuinely changed.',
            code: 'payer_already_linked' });
        }
        payerLinkId = have ? have.id : null;
      }
    }

    // Supersede any pending proposal on this line — the manager's answer wins.
    await db.query(`
      UPDATE payment_match_proposals
         SET status='superseded', decided_by=$2, decided_at=now(),
             decided_reason='replaced by a manual assignment'
       WHERE bank_line_id=$1 AND status='pending'`, [lineId, req.user?.id || null]);

    const { rows: [prop] } = await db.query(`
      INSERT INTO payment_match_proposals
        (bank_line_id, kind, certainty, family_key, child_id, amount_pence, allocation, evidence)
      VALUES ($1,$2,'proposed',$3,$4,$5,$6::jsonb,$7::jsonb)
      RETURNING id`,
      [lineId, M.KIND.MANUAL, familyKey, childId, Math.round(line.amount_pence),
       JSON.stringify(plan.allocation),
       JSON.stringify({ assigned_by_manager: true, payer_key: payerKey,
                        payer_link_id: payerLinkId,
                        credit_pence: plan.credit_pence,
                        allocated_pence: plan.allocated_pence,
                        line_description: line.description || null })]);

    // `apply:false` leaves it in the queue alongside the rest.
    let applied = null;
    if (req.body?.apply !== false) {
      applied = await M.applyProposal(db, prop.id, { actorId: req.user?.id || null });
    }
    recordAudit({ req, action: 'update', entity_type: 'bank_statement_line', entity_id: lineId,
      meta: { feature: 'b325-assign', proposal_id: prop.id,
              remembered_payer: !!payerLinkId, applied: !!applied } });
    res.json({ ok: true, proposal_id: prop.id, plan, applied,
               remembered_payer: !!payerLinkId });
  } catch (e) {
    console.error('[b325] assign:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /payers — the memory, so it can be read and pruned.
router.get('/payers', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT l.id, l.payer_key, l.payer_label, l.family_key, l.times_used,
             l.confirmed_at, l.last_used_at, l.revoked_at,
             (SELECT string_agg(c.first_name || ' ' || c.last_name, ', ' ORDER BY c.id)
                FROM children c
               WHERE ${M.FAMILY_KEY_SQL('c')} = l.family_key AND c.status='active') AS children
        FROM payment_payer_links l
       ORDER BY l.revoked_at NULLS FIRST, l.confirmed_at DESC
       LIMIT 500`);
    res.json({ payers: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /payers/:id/revoke — stop proposing this payer for this family.
router.post('/payers/:id/revoke', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const { rows } = await db.query(`
      UPDATE payment_payer_links SET revoked_at=now(), revoked_by=$2
       WHERE id=$1 AND revoked_at IS NULL RETURNING id`, [id, req.user?.id || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or already revoked' });
    recordAudit({ req, action: 'delete', entity_type: 'payment_payer_link', entity_id: id,
      meta: { feature: 'b325-revoke-payer' } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Settings: auto-apply, and the bank details printed on every invoice ──────

const SETTING_KEYS = ['payment_match_auto_apply', 'payment_bank_name',
                      'payment_bank_account_name', 'payment_bank_sort_code',
                      'payment_bank_account_number'];

router.get('/settings', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [SETTING_KEYS]);
    const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json({
      auto_apply: await M.autoApplyEnabled(db),
      // Said out loud on the screen so nobody has to read this file to find out.
      auto_apply_kinds: [...M.AUTO_APPLY_KINDS],
      bank: {
        name:           s.payment_bank_name || '',
        account_name:   s.payment_bank_account_name || '',
        sort_code:      s.payment_bank_sort_code || '',
        account_number: s.payment_bank_account_number || '',
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings', async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const writes = [];
  if ('auto_apply' in b) {
    writes.push(['payment_match_auto_apply',
      (b.auto_apply === true || b.auto_apply === '1' || b.auto_apply === 'on') ? '1' : '0']);
  }
  const bank = b.bank || {};
  const map = { name: 'payment_bank_name', account_name: 'payment_bank_account_name',
                sort_code: 'payment_bank_sort_code', account_number: 'payment_bank_account_number' };
  for (const [k, key] of Object.entries(map)) {
    if (k in bank) writes.push([key, String(bank[k] ?? '').slice(0, 120).trim()]);
  }
  if (!writes.length) return res.status(400).json({ error: 'nothing to update' });
  try {
    for (const [key, value] of writes) {
      await db.query(`
        INSERT INTO settings (key, value, updated_by, updated_at)
        VALUES ($1,$2,$3,now())
        ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,
               updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [key, value, req.user?.id || null]);
    }
    // The account number is not written to the audit trail — only which keys moved.
    recordAudit({ req, action: 'update', entity_type: 'setting',
      meta: { feature: 'b325-settings', keys: writes.map(w => w[0]) } });
    res.json({ ok: true, updated: writes.map(w => w[0]) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
