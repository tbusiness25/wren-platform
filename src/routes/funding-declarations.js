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
const { notify } = require('../services/notification-dispatcher');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// Reminder audit table (idempotent; runs once at module load, after requires).
(async () => {
  try {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS funding_declaration_reminders (
        child_id int NOT NULL,
        term_id int NOT NULL,
        sent_at timestamptz NOT NULL DEFAULT NOW(),
        sent_by int NOT NULL,
        PRIMARY KEY (child_id, term_id)
      )`);
  } catch (e) {
    console.error('[funding-declarations] reminder table init error:', e.message);
  }
})();

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

// ── GET /:childId/prefill — everything Wren already knows, so the family only fills the gaps ──
// Toby, 2026-09-23: "fill in all of the fields already on the parental declaration form in their
// app and then just send them a message saying there are some fields missing."
//
// Child-guarded exactly like every other route here, so a parent only ever sees their own child's
// details. It returns the family's OWN data back to them — their address, their NI number, the code
// they gave us — which is theirs to see. It does NOT return a partner's NI unless we hold it against
// this child, and it never invents a value: a field we do not hold comes back absent, so the form
// shows it empty and required.
router.get('/:childId/prefill', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const childId = parseInt(req.params.childId, 10);
    const { rows: [c] } = await db.query(
      `SELECT first_name, last_name, preferred_name, to_char(date_of_birth,'YYYY-MM-DD') AS dob,
              concat_ws(', ', NULLIF(btrim(address_line1),''), NULLIF(btrim(address_line2),''), NULLIF(btrim(town),'')) AS address_line1,
              postcode, parent_1_name
         FROM children WHERE id = $1`, [childId]);
    if (!c) return res.status(404).json({ error: 'Not found' });

    const { rows: [f] } = await db.query(
      `SELECT cf.thirty_hour_code, cf.carer_ni_number, cf.funding_type, cf.stretched_funding,
              cf.universal_hours_week, cf.extended_hours_week,
              to_char(cf.thirty_hour_code_expiry,'YYYY-MM-DD') AS code_end,
              to_char(cf.carer_dob,'YYYY-MM-DD') AS carer_dob, cf.partner_name, cf.partner_ni_number, cf.la_reference
         FROM child_funding cf
         JOIN funding_terms t ON t.id = cf.term_id
        WHERE cf.child_id = $1
        ORDER BY (t.is_current IS TRUE) DESC, t.start_date DESC LIMIT 1`, [childId]);

    const hoursHere = f ? (Number(f.universal_hours_week || 0) + Number(f.extended_hours_week || 0)) : null;
    const ENTITLEMENT = {
      universal: 'Universal 15 hours (3-4 year old)',
      extended: 'Working parent entitlement (code required)',
      // 2026-10-15: working-parent 2-year-olds and under-2s hold an 11-digit HMRC code — that is the working-parent
      // entitlement, not the LA-reference (disadvantaged) route. under_2 was missing, so 8 forms had no entitlement.
      '2yr_working': 'Working parent entitlement (code required)',
      under_2: 'Working parent entitlement (code required)',
      '2yr_disadvantaged': '2-year-old (LA reference)',
    };

    // only keys we actually hold — an absent key leaves the field empty on the form
    const out = { child: {}, parent: {}, entitlement: {} };
    const put = (sec, k, v) => { if (v !== null && v !== undefined && String(v).trim() !== '') out[sec][k] = v; };
    put('child', 'legal_name', `${c.first_name || ''} ${c.last_name || ''}`.trim());
    put('child', 'dob', c.dob);
    put('child', 'address', c.address_line1);
    put('child', 'postcode', c.postcode);
    put('parent', 'parent_name', c.parent_1_name);
    // b491 review (item 4): staff callers other than managers get the mask, never the number
    // (this route answered any staff token, so a practitioner could read any family's NI here).
    const _niFull = req.isParent || ['manager', 'deputy_manager', 'admin', 'owner'].includes(req.user && req.user.role);
    const _ni = f && f.carer_ni_number ? String(f.carer_ni_number).replace(/\s+/g, '').toUpperCase() : null;
    put('parent', 'parent_ni', _ni ? (_niFull ? f.carer_ni_number : `•• •• •• ${_ni.slice(-3, -1)} ${_ni.slice(-1)}`) : null);
    // 2026-10-15 (Toby: "make sure all of the portal info is now in their funding declaration"): the parent DOB,
    // partner and LA reference Wren now holds from the council's September export / EyLog — same NI mask rule.
    if (f) {
      put('parent', 'parent_dob', f.carer_dob);
      put('parent', 'partner_name', f.partner_name);
      const _pni = f.partner_ni_number ? String(f.partner_ni_number).replace(/\s+/g, '').toUpperCase() : null;
      put('parent', 'partner_ni', _pni ? (_niFull ? f.partner_ni_number : `•• •• •• ${_pni.slice(-3, -1)} ${_pni.slice(-1)}`) : null);
    }
    if (f) {
      put('entitlement', 'entitlement_type', ENTITLEMENT[f.funding_type]);
      put('entitlement', 'hmrc_code', f.thirty_hour_code);
      put('entitlement', 'code_end', f.code_end);
      put('entitlement', 'la_reference', f.la_reference);
      if (hoursHere) put('entitlement', 'hours_here', hoursHere);
      put('entitlement', 'stretched', f.stretched_funding ? 'Stretched' : 'Term-time');
    }
    // what the family still has to supply — the message to them says "some fields are missing"
    const REQUIRED = { child: ['legal_name','dob','address','postcode'],
                       parent: ['parent_name','parent_dob','parent_ni'],
                       entitlement: ['entitlement_type','hours_here','stretched','hours_elsewhere'] };
    const missing = [];
    for (const [sec, keys] of Object.entries(REQUIRED))
      for (const k of keys) if (out[sec][k] === undefined) missing.push(`${sec}.${k}`);
    res.json({ prefill: out, missing, filled: Object.values(out).reduce((n, o) => n + Object.keys(o).length, 0) });
  } catch (e) {
    console.error('[funding-declarations] prefill:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /:childId/sign ───────────────────────────────────────────────────────
// ── POST /:childId/remind — send reminder to parents (manager only) ──
router.post('/:childId/remind', childGuard, async (req, res) => {
  // Only managers can trigger reminders
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const childId = parseInt(req.params.childId);
  try {
    const db = getPool();
    // Determine term (current if not provided)
    let termId = null;
    const { rows: tRows } = await db.query(
      `SELECT id FROM funding_terms
       ORDER BY (is_current IS TRUE) DESC, (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC LIMIT 1`
    );
    if (tRows.length) termId = tRows[0].id;
    if (!termId) return res.status(400).json({ error: 'No funding term configured' });

    // Insert or update reminder record
    await db.query(
      `INSERT INTO funding_declaration_reminders (child_id, term_id, sent_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (child_id, term_id) DO UPDATE SET sent_at=NOW(), sent_by=$3`,
      [childId, termId, req.user.id]
    );

    // Fetch child name for the parent-facing message
    const { rows: cRows } = await db.query(
      `SELECT first_name, last_name FROM children WHERE id=$1`, [childId]
    );
    const childName = cRows.length ? `${cRows[0].first_name} ${cRows[0].last_name}` : `Child #${childId}`;

    // In-app notification to the PARENT (house rule: parents get Wren-portal
    // notifications, never direct email). recipient_id = child_id, as in attendance.js.
    await db.query(
      `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, priority)
       VALUES ('parent', $1, 'funding', $2, $3, 'high')`,
      [childId, 'Funding declaration needed',
       `Please sign ${childName}'s funding declaration in the Funding section of the parent portal — the nursery needs it to claim your funded hours from Ealing Council.`]
    ).catch(() => {});
    res.json({ ok: true, child_id: childId, term_id: termId });
  } catch (e) {
    console.error('[funding-declarations] remind error:', e.message);
    res.status(500).json({ error: e.message });
  }
});
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
  // 2026-10-13 (Toby): Parent/Carer 1's date of birth and NI number are mandatory — the same rule as
  // /welcome/declaration (src/lib/funding-declaration.js validateParentIdentity).
  const idErr = require('../lib/funding-declaration').validateParentIdentity(payload);
  if (idErr) return res.status(400).json({ error: idErr.error });
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
    // parentsapp-20261023: this path copied nothing onto Wren's records (only /welcome/declaration did). Same step as there: the
    // parent's NI / DOB (and code facts) into EMPTY allocation columns, and NI / DOB onto the parent record. Never fails the signing.
    try { await require('../lib/funding-declaration').fillEmptyColumns(db, { childId: parseInt(req.params.childId, 10), termId: term, payload }); }
    catch (fe) { console.error('[funding-declarations] fill failed (signed OK):', fe.message); }
    res.status(201).json({ ok: true, id: rows[0].id, signed_at: rows[0].signed_at, sha256: sha });
    // Alert managers that a funding declaration has been signed (fire-and-forget).
    try {
      const { rows: [c] } = await db.query(
        'SELECT first_name, last_name FROM children WHERE id=$1', [req.params.childId]);
      const childName = c ? `${c.first_name} ${c.last_name}` : `Child #${req.params.childId}`;
      const { rows: [t2] } = await db.query('SELECT name FROM funding_terms WHERE id=$1', [term]);
      notify('funding_declaration_signed', 'all-managers', null,
        `Funding declaration signed — ${childName}`,
        `${String(signed_name).slice(0, 100)} signed the parental declaration for ${childName} (${t2 ? t2.name : 'term ' + term}). Ready to review for the funding claim.`,
        { priority: 'high', relatedTable: 'funding_declarations', relatedId: rows[0].id, link: '/funding.html' });
    } catch (ne) {
      console.error('[funding-declarations] notify error (sign saved OK):', ne.message);
    }
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
    // login-20261023: the signed payload carries the parent's NI number and income details. Staff
    // need the leadership tier or above (Toby: room leaders see all parent information; the team
    // and apprentices do not) — before, any staff token could print any family's declaration.
    if (!req.isParent && !['manager', 'deputy_manager', 'admin', 'owner', 'room_leader'].includes(req.user && req.user.role)
        && Number(req.user && req.user.id) !== 1) return res.status(403).send('Forbidden');
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
Record sha256: ${esc(d.sha256)} · IP: ${esc(d.ip)} · Your Nursery, 123 Example Lane, London AB1 2CD.</div>
<button class="noprint" onclick="window.print()" style="margin-top:20px">Print</button>
</body></html>`);
  } catch (e) {
    console.error('[funding-declarations] print error:', e.message);
    res.status(500).send('Error');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MANAGER TRACKING (Roost) — appended 2026-07-16 (build 75, parental declaration)
// Per-term view of who's been sent the form, who's returned it (electronic or
// paper), declaration status, and the LA application/payment state.
// ─────────────────────────────────────────────────────────────────────────────
function managerOnly(req, res, next) {
  if (req.isParent || !['manager', 'deputy_manager', 'admin'].includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager access only' });
  }
  next();
}

// ── GET /manager/terms — term list for the tracker selector ───────────────────
router.get('/manager/terms', managerOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, name, is_current, start_date, end_date FROM funding_terms
       WHERE NOT is_archived
       ORDER BY (is_current IS TRUE) DESC, start_date DESC`);
    res.json({ terms: rows });
  } catch (e) {
    console.error('[funding-declarations] manager/terms error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /manager/tracker?term_id=N — per-child declaration tracking ───────────
router.get('/manager/tracker', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    // Resolve term (explicit ?term_id, else current/most-relevant).
    let termId = req.query.term_id ? parseInt(req.query.term_id) : null;
    if (!termId) {
      const { rows: t } = await db.query(
        `SELECT id FROM funding_terms
         ORDER BY (is_current IS TRUE) DESC, (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC LIMIT 1`);
      if (!t.length) return res.json({ term: null, summary: null, rows: [] });
      termId = t[0].id;
    }
    const { rows: [term] } = await db.query(
      `SELECT id, name, is_current, start_date, end_date FROM funding_terms WHERE id=$1`, [termId]);
    if (!term) return res.status(404).json({ error: 'Term not found' });

    // Per-child rows: funded children this term, joined to reminder + latest
    // signed electronic declaration + the paper-declaration flags on child_funding.
    const { rows } = await db.query(
      `SELECT c.id AS child_id, c.first_name, c.last_name,
              cf.funding_type,
              (COALESCE(cf.universal_hours_week,0) + COALESCE(cf.extended_hours_week,0)) AS hours_week,
              cf.declaration_signed      AS paper_signed,
              cf.declaration_method,
              cf.declaration_signed_date,
              r.sent_at,
              d.id AS decl_id, d.status AS decl_status, d.signed_name, d.signed_at, d.pdf_doc_id
       FROM child_funding cf
       JOIN children c ON c.id = cf.child_id
       LEFT JOIN funding_declaration_reminders r
              ON r.child_id = cf.child_id AND r.term_id = cf.term_id
       LEFT JOIN LATERAL (
         SELECT id, status, signed_name, signed_at, (to_jsonb(fd)->>'pdf_document_id') AS pdf_doc_id
         FROM funding_declarations fd
         WHERE fd.child_id = cf.child_id AND fd.term_id = cf.term_id AND fd.status = 'signed'
         ORDER BY fd.signed_at DESC LIMIT 1
       ) d ON true
       WHERE cf.term_id = $1 AND COALESCE(cf.funding_type,'none') <> 'none'
       ORDER BY c.first_name, c.last_name`, [termId]);

    const returned = rows.filter(r => r.decl_status === 'signed' || r.paper_signed).length;
    const sent = rows.filter(r => r.sent_at).length;

    // LA application/payment state for the term (most recent submission).
    const { rows: sub } = await db.query(
      `SELECT status, submitted_at, submission_reference, total_children, total_value
       FROM funding_submissions WHERE term_id=$1
       ORDER BY COALESCE(submitted_at, created_at) DESC LIMIT 1`, [termId]);

    // b343 — a family with no allocation for the term (a new family, or one claiming for the first time) can sign in the app. Their
    // declaration is stored and its PDF filed, but no allocation is made from a family's own answer (hours drive invoices), so they
    // are listed here for the office to allocate. Names are fine: this is the manager-only Roost tracker.
    const { rows: unallocated } = await db.query(
      `SELECT c.id AS child_id, c.first_name, c.last_name, d.id AS decl_id, d.signed_name, d.signed_at,
              (to_jsonb(d)->>'pdf_document_id') AS pdf_doc_id
         FROM funding_declarations d JOIN children c ON c.id = d.child_id
        WHERE d.term_id = $1 AND d.status = 'signed'
          AND NOT EXISTS (SELECT 1 FROM child_funding cf WHERE cf.child_id = d.child_id AND cf.term_id = d.term_id
                            AND COALESCE(cf.funding_type,'none') <> 'none')
        ORDER BY d.signed_at DESC`, [termId]);

    res.json({
      term,
      unallocated,
      summary: {
        unallocated: unallocated.length,
        funded: rows.length,
        sent,
        returned,
        outstanding: rows.length - returned,
        electronic: rows.filter(r => r.decl_status === 'signed').length,
        paper: rows.filter(r => r.paper_signed && r.decl_status !== 'signed').length,
        la_submission: sub.length ? sub[0] : null,
      },
      rows,
    });
  } catch (e) {
    console.error('[funding-declarations] manager/tracker error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /manager/send-form — send/re-send the form for a child + term ────────
// (term-aware companion to POST /:childId/remind, which only targets the current
// term. NB: path deliberately avoids '/manager/remind', which would be shadowed
// by the earlier '/:childId/remind' route.)
router.post('/manager/send-form', managerOnly, async (req, res) => {
  const childId = parseInt(req.body && req.body.child_id);
  let termId = req.body && req.body.term_id ? parseInt(req.body.term_id) : null;
  if (!childId) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    if (!termId) {
      const { rows: t } = await db.query(
        `SELECT id FROM funding_terms
         ORDER BY (is_current IS TRUE) DESC, (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC LIMIT 1`);
      if (!t.length) return res.status(400).json({ error: 'No funding term configured' });
      termId = t[0].id;
    }
    await db.query(
      `INSERT INTO funding_declaration_reminders (child_id, term_id, sent_by)
       VALUES ($1,$2,$3)
       ON CONFLICT (child_id, term_id) DO UPDATE SET sent_at=NOW(), sent_by=$3`,
      [childId, termId, req.user.id]);
    const { rows: cRows } = await db.query(
      `SELECT first_name, last_name FROM children WHERE id=$1`, [childId]);
    const childName = cRows.length ? `${cRows[0].first_name} ${cRows[0].last_name}` : `Child #${childId}`;
    await db.query(
      `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, priority)
       VALUES ('parent', $1, 'funding', $2, $3, 'high')`,
      [childId, 'Funding declaration needed',
       `Please complete ${childName}'s funding declaration in the parent portal — the nursery needs it to claim your funded hours from Ealing Council.`]
    ).catch(() => {});
    res.json({ ok: true, child_id: childId, term_id: termId });
  } catch (e) {
    console.error('[funding-declarations] manager/remind error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /:id/pdf — the signed answers as a PDF, filed against the child (b343) ──────────────────────────────
// Generated the first time it is asked for if the declaration has none yet (every declaration signed before b343, and any whose
// PDF failed to file), then served from the child's documents. Manager-only: it carries National Insurance numbers.
router.get('/:id/pdf', managerOnly, async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
    const db = getPool();
    const FD = require('../lib/funding-declaration');
    const r = await FD.fileDeclarationPdf(db, id);
    if (!r.ok) return res.status(r.error === 'declaration not found' ? 404 : 500).json({ error: r.error });
    const { rows: [doc] } = await db.query(`SELECT stored_path, filename FROM person_documents WHERE id = $1 AND deleted = false`, [r.docId]);
    if (!doc || !doc.stored_path || !require('fs').existsSync(doc.stored_path)) return res.status(404).json({ error: 'File not on disk' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${String(doc.filename || 'funding-declaration.pdf').replace(/["\\]/g, '')}"`);
    require('fs').createReadStream(doc.stored_path).pipe(res);
  } catch (e) {
    console.error('[funding-declarations] pdf error:', e.message);
    res.status(500).json({ error: 'Could not produce the PDF' });
  }
});

module.exports = router;
