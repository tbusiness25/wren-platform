// FEEE parental declaration (build 75a, 2026-07-09).
// Parents (or staff on their behalf) sign the England free-entitlement
// declaration; the signed payload snapshot is stored immutably in
// ladn.funding_declarations with sha256 + ip + UA, and older signed rows for
// the same child+term are marked superseded. Typed full name = electronic
// signature (Electronic Communications Act 2000).
'use strict';
const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { getPool } = require('../db/pool');

// Dual auth: staff tokens (integer id) OR parent tokens (aud=parents, child_id).
router.use((req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    req.isParent = req.user.aud === 'parents' || req.user.role === 'parent';
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Parents may only touch their own child; staff may touch any.
function childGuard(req, res, next) {
  if (!req.isParent) return next();
  const cid = parseInt(req.params.childId);
  if (parseInt(req.user.child_id) !== cid) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ── GET /template — the declaration structure ─────────────────────────────────
router.get('/template', (req, res) => {
  res.json({
    version: '2026-27-v1',
    sections: [
      {
        key: 'child', title: 'Child details',
        fields: [
          { key: 'legal_name', label: 'Child\'s full legal name', type: 'text', required: true },
          { key: 'dob', label: 'Date of birth', type: 'date', required: true },
          { key: 'address', label: 'Home address', type: 'textarea', required: true },
          { key: 'postcode', label: 'Postcode', type: 'text', required: true },
        ],
      },
      {
        key: 'parent', title: 'Parent / carer details',
        fields: [
          { key: 'parent_name', label: 'Parent/carer full name', type: 'text', required: true },
          { key: 'parent_dob', label: 'Parent/carer date of birth', type: 'date', required: true },
          { key: 'parent_ni', label: 'National Insurance number', type: 'text', required: true },
          { key: 'partner_name', label: 'Partner\'s full name (if claiming working-parent entitlement)', type: 'text', required: false },
          { key: 'partner_ni', label: 'Partner\'s NI number', type: 'text', required: false },
        ],
      },
      {
        key: 'entitlement', title: 'Entitlement claimed',
        fields: [
          { key: 'entitlement_type', label: 'Entitlement', type: 'select', required: true,
            options: ['Universal 15 hours (3-4 year old)', 'Working parent entitlement (code required)', '2-year-old (LA reference)'] },
          { key: 'hmrc_code', label: '11-digit childcare code (working-parent entitlement)', type: 'text', required: false },
          { key: 'code_start', label: 'Code start date', type: 'date', required: false },
          { key: 'code_end', label: 'Code end date / grace period end', type: 'date', required: false },
          { key: 'la_reference', label: '2-year-old LA reference (if applicable)', type: 'text', required: false },
          { key: 'hours_here', label: 'Funded hours per week AT THIS SETTING', type: 'number', required: true },
          { key: 'stretched', label: 'Term-time (38 weeks) or stretched?', type: 'select', required: true, options: ['Term-time', 'Stretched'] },
          { key: 'hours_elsewhere', label: 'Funded hours per week at any OTHER setting (0 if none)', type: 'number', required: true },
          { key: 'other_setting_name', label: 'Other setting name (if any)', type: 'text', required: false },
        ],
      },
      {
        key: 'declarations', title: 'Declarations',
        fields: [
          { key: 'accurate', label: 'The information I have given is true and accurate.', type: 'checkbox', required: true },
          { key: 'notify_changes', label: 'I will notify the setting of any change in my circumstances.', type: 'checkbox', required: true },
          { key: 'claim_consent', label: 'I authorise Your Nursery to claim funding from Ealing Council on my behalf.', type: 'checkbox', required: true },
          { key: 'data_sharing', label: 'I understand my data is shared with the local authority and DfE/ESFA for funding and audit (UK GDPR — legal obligation / public task).', type: 'checkbox', required: true },
          { key: 'extras_understood', label: 'I understand consumables/extras are charged separately and itemised.', type: 'checkbox', required: true },
        ],
      },
      {
        key: 'signature', title: 'Signature',
        note: 'Typing your full name below acts as your electronic signature (Electronic Communications Act 2000).',
        fields: [{ key: 'signed_name', label: 'Full name', type: 'text', required: true }],
      },
    ],
  });
});

// ── POST /:childId/sign ───────────────────────────────────────────────────────
router.post('/:childId/sign', childGuard, async (req, res) => {
  const { payload, signed_name, term_id } = req.body || {};
  if (!payload || typeof payload !== 'object' || !signed_name) {
    return res.status(400).json({ error: 'payload and signed_name required' });
  }
  const required = ['accurate', 'notify_changes', 'claim_consent', 'data_sharing', 'extras_understood'];
  const decls = payload.declarations || {};
  if (!required.every(k => decls[k] === true)) {
    return res.status(400).json({ error: 'All declaration checkboxes must be ticked' });
  }
  try {
    const db = getPool();
    // term_id is NOT NULL in the live table — default to the current funding term.
    let term = term_id || null;
    if (!term) {
      const { rows: t } = await db.query(
        `SELECT id FROM funding_terms
         ORDER BY (is_current IS TRUE) DESC, (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC LIMIT 1`);
      if (!t.length) return res.status(400).json({ error: 'No funding term configured — ask the nursery' });
      term = t[0].id;
    }
    const snapshot = JSON.stringify({ payload, signed_name, child_id: parseInt(req.params.childId), term_id: term });
    const sha = crypto.createHash('sha256').update(snapshot).digest('hex');
    await db.query(
      `UPDATE funding_declarations SET status='superseded'
       WHERE child_id=$1 AND status='signed' AND term_id=$2`,
      [req.params.childId, term]);
    const { rows } = await db.query(
      `INSERT INTO funding_declarations (child_id, term_id, payload, signed_name, signed_at, ip, user_agent, sha256, status)
       VALUES ($1,$2,$3,$4,now(),$5,$6,$7,'signed') RETURNING id, signed_at`,
      [req.params.childId, term, JSON.stringify(payload), String(signed_name).slice(0, 200),
       req.ip, String(req.headers['user-agent'] || '').slice(0, 300), sha]);
    res.status(201).json({ ok: true, id: rows[0].id, signed_at: rows[0].signed_at, sha256: sha });
  } catch (e) {
    console.error('[funding-declarations] sign error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:childId/status ──────────────────────────────────────────────────────
router.get('/:childId/status', childGuard, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, status, signed_name, signed_at, term_id FROM funding_declarations
       WHERE child_id=$1 ORDER BY (status='signed') DESC, created_at DESC LIMIT 1`,
      [req.params.childId]);
    if (!rows.length) return res.json({ status: 'none' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id/print — standalone print view of a signed snapshot ───────────────
router.get('/:id/print', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT d.*, c.first_name, c.last_name FROM funding_declarations d
       LEFT JOIN children c ON c.id = d.child_id WHERE d.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).send('Not found');
    const d = rows[0];
    if (req.isParent && parseInt(req.user.child_id) !== d.child_id) return res.status(403).send('Forbidden');
    const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const p = typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload;
    const section = (title, obj) => obj ? `<h2>${esc(title)}</h2><table>${Object.entries(obj)
      .map(([k, v]) => `<tr><td class="k">${esc(k.replace(/_/g, ' '))}</td><td>${v === true ? '✓ agreed' : esc(v)}</td></tr>`).join('')}</table>` : '';
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>FEEE Declaration — ${esc(d.first_name)} ${esc(d.last_name)}</title>
<style>body{font-family:Georgia,serif;max-width:720px;margin:32px auto;color:#111;padding:0 16px}
h1{font-size:1.3rem}h2{font-size:1rem;margin:18px 0 6px;border-bottom:1px solid #999;padding-bottom:2px}
table{width:100%;border-collapse:collapse;font-size:.9rem}td{padding:4px 8px;border-bottom:1px solid #eee;vertical-align:top}
td.k{width:40%;color:#555;text-transform:capitalize}.sig{margin-top:28px;border-top:1px solid #111;padding-top:8px}
.legal{margin-top:24px;font-size:.75rem;color:#555}@media print{.noprint{display:none}}</style></head><body>
<h1>Free Early Education Entitlement — Parental Declaration</h1>
<p>Child: <b>${esc(d.first_name)} ${esc(d.last_name)}</b> · Status: <b>${esc(d.status)}</b> · Signed: <b>${d.signed_at ? new Date(d.signed_at).toLocaleString('en-GB') : '—'}</b></p>
${section('Child details', p.child)}${section('Parent / carer', p.parent)}${section('Entitlement claimed', p.entitlement)}${section('Declarations', p.declarations)}
<div class="sig">Signed (typed name as electronic signature): <b>${esc(d.signed_name)}</b></div>
<div class="legal">This typed-name signature constitutes an electronic signature under the Electronic Communications Act 2000.
Record sha256: ${esc(d.sha256)} · IP: ${esc(d.ip)} · Your Nursery, 1A Example Lane, London W13 9LU.</div>
<button class="noprint" onclick="window.print()" style="margin-top:20px">Print</button>
</body></html>`);
  } catch (e) {
    console.error('[funding-declarations] print error:', e.message);
    res.status(500).send('Error');
  }
});

module.exports = router;
