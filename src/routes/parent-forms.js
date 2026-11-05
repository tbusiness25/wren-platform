'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b343 — forms a parent signs in the app.
//
//   formsRouter   mounted at /welcome/forms/api
//     GET  /prompt      how many things are waiting (the home-screen card). Counts only.
//     GET  /state       the list: what is waiting, the funding declaration if one is owed, and what has been signed
//     GET  /item/:id    one form, exactly as the parent would be shown it, with the sentence beside the tick
//     POST /sign        { request_id, typed_name, agreed:true } — one append-only row, or a plain refusal
//
//   staffRouter   mounted at /api/parent-forms   (staff: any signed-in member of staff; parents are refused)
//     GET  /child/:childId   who signed what for this child, and what is still waiting — NO form content
//     GET  /outstanding      manager-level: every unsigned form, oldest first, for the office to chase
//
// Both sit under paths the parents identity gate already covers (/welcome/<x>/api/…). Handlers read the answer with
// parentEmailOf(req) and never a header; a body child_id is NEVER believed — ownership is re-read from
// parent_portal_access on every call (src/lib/parent-forms.js).
//
// It never blocks anything. A parent with an unsigned form can still open the diary, the journey and an invoice: nothing
// in the app looks at this router's answer except the card and the Forms screen.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const { getPool } = require('../db/pool');
const { parentEmailOf } = require('../lib/parent-identity');
const { recordAudit } = require('../utils/audit');
const F = require('../lib/parent-forms');

const parentsOnly = (req, res, next) => (req._portal === 'parents' ? next() : next('router'));
const noStore = (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); };

const formsRouter = express.Router();
formsRouter.use(parentsOnly, noStore, express.json({ limit: '16kb' }));

const notReady = e => e && (e.code === '42P01' || e.code === '42703');       // undefined_table / undefined_column: migration not run

formsRouter.get('/prompt', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const l = await F.listFor(getPool(), email);
    res.json({ count: l.count, forms: l.waiting.length, declarations: l.declarations.length, href: '/welcome/forms' });
  } catch (e) { console.error('[parent-forms] prompt:', e.message); res.json({ count: 0, forms: 0, declarations: 0, href: '/welcome/forms' }); }
});

// b502 — the persistent "To do" banner on the home screen: the details THIS family still has to supply, each linking to the screen that fixes it.
// Parent-to-do items only (never an internal "us" item), for the parent's OWN children only (ownership re-read from parent_portal_access).
// Gated by the same parents identity gate as every /welcome/forms/api route; it only reads, and never blocks anything.
formsRouter.get('/outstanding', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const db = getPool();
    const ids = await F.ownedChildIds(db, email);
    const items = await require('../lib/outstanding').forFamily(db, ids);
    const PAGE = { declaration: '/welcome/declaration', details: '/welcome/details', consents: '/welcome/consents', forms: '/welcome/forms' };
    const out = items.map(i => ({ child_id: i.child_id, child_name: i.child_name, code: i.code, label: i.label,
      href: (PAGE[i.page] || '/welcome/forms') + (i.page === 'declaration' ? `?child=${i.child_id}` : '') }));
    let deadline = null;
    try {
      const { rows } = await db.query(`SELECT min(deadline)::text AS d FROM detail_campaigns WHERE status='running' AND deadline >= (now() AT TIME ZONE 'Europe/London')::date`);
      deadline = rows[0] && rows[0].d || null;
    } catch (_) { /* campaigns not migrated */ }
    res.json({ count: out.length, items: out, deadline });
  } catch (e) { console.error('[parent-forms] outstanding:', e.message); res.json({ count: 0, items: [], deadline: null }); }
});

formsRouter.get('/state', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const l = await F.listFor(getPool(), email);
    res.json({ count: l.count, waiting: l.waiting, declarations: l.declarations, signed: l.signed });
  } catch (e) { console.error('[parent-forms] state:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

formsRouter.get('/item/:id', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'That form was not found.' });
  try {
    const r = await F.openForm(getPool(), email, id);
    if (!r.ok) return res.status(r.status).json({ error: r.error, reason: r.reason, signed: r.signed || undefined });
    res.json({ form: r.form });
  } catch (e) { console.error('[parent-forms] item:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

formsRouter.post('/sign', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const b = req.body || {};
  const requestId = parseInt(b.request_id, 10);
  if (!Number.isInteger(requestId)) return res.status(400).json({ error: 'Which form? Please go back to the list and open it again.', reason: 'no_form' });
  try {
    const r = await F.sign(getPool(), {
      email, requestId, typedName: b.typed_name, agreed: b.agreed === true,
      ip: req.headers['cf-connecting-ip'] || req.ip, userAgent: req.headers['user-agent'],
    });
    if (!r.ok) return res.status(r.status).json({ error: r.error, reason: r.reason, signed: r.signed || undefined });
    // ids and the kind only — never the typed name, never what was shown
    await recordAudit({ req, action: 'create', entity_type: 'parent_form_signature', entity_id: r.id, actor_type: 'parent', actor_email: email,
      meta: { child_id: r.child_id, kind: r.kind, source_id: r.source_id } });
    const left = await F.listFor(getPool(), email);
    res.status(201).json({ ok: true, signed_at: r.signed_at, remaining: left.count });
  } catch (e) {
    if (notReady(e)) return res.status(503).json({ error: 'not_ready' });
    console.error('[parent-forms] sign:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// staff — /api/parent-forms
// ═════════════════════════════════════════════════════════════════════════════
const staffRouter = express.Router();
const authenticate = require('../middleware/auth');
staffRouter.use(authenticate, noStore);
staffRouter.use((req, res, next) => (req.user && req.user.role === 'parent' ? res.status(403).json({ error: 'Staff only' }) : next()));

const MANAGERS = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager', 'owner'];

staffRouter.get('/child/:childId', async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  try {
    // rows are made for the child on demand, so "waiting" is true from the moment a form exists, not the moment a parent opens the app
    try { await F.ensureRequests(getPool(), [childId]); } catch (_) { /* migration not run: nothing to show */ }
    res.json({ items: await F.statusForChild(getPool(), childId) });
  } catch (e) {
    if (notReady(e)) return res.json({ items: {} });
    console.error('[parent-forms] child status:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

staffRouter.get('/outstanding', async (req, res) => {
  if (!MANAGERS.includes(req.user && req.user.role)) return res.status(403).json({ error: 'Manager access only' });
  try {
    const { rows } = await getPool().query(
      `SELECT r.id, r.child_id, r.form_kind, r.first_seen_at, r.nudge_count, c.first_name, c.last_name, c.preferred_name,
              (SELECT count(*) FROM parent_portal_access pa WHERE pa.child_id = r.child_id AND pa.is_active = true)::int AS can_sign_in
         FROM parent_form_requests r JOIN children c ON c.id = r.child_id
        WHERE r.superseded_at IS NULL AND COALESCE(c.is_active, true) = true
          AND NOT EXISTS (SELECT 1 FROM parent_form_signatures s WHERE s.request_id = r.id)
        ORDER BY r.first_seen_at ASC, r.id ASC LIMIT 500`);
    res.json({
      total: rows.length,
      forms: rows.map(r => ({ id: r.id, child_id: r.child_id, child_name: [r.preferred_name || r.first_name, r.last_name].filter(Boolean).join(' '),
        kind: r.form_kind, kind_label: F.KINDS[r.form_kind].label, waiting_since: r.first_seen_at, nudges: r.nudge_count, can_sign_in: r.can_sign_in > 0 })),
    });
  } catch (e) {
    if (notReady(e)) return res.json({ total: 0, forms: [] });
    console.error('[parent-forms] outstanding:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = { formsRouter, staffRouter };
