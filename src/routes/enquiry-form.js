// ─────────────────────────────────────────────────────────────────────────────
// Customisable enquiry form (Admin → Settings → Enquiry Form).
// One router, mounted ONCE before the auth gate:
//   GET  /api/enquiry-form/public   — UNAUTH: enabled fields for the website form
//   GET  /api/enquiry-form          — manager: all fields (for the editor)
//   POST /api/enquiry-form          — manager: add a custom field
//   PUT  /api/enquiry-form/reorder  — manager: bulk re-order
//   PUT  /api/enquiry-form/:id      — manager: edit / toggle / require a field
//   DELETE /api/enquiry-form/:id    — manager: delete a NON-core field
// Append-only: the public website form reads /public and renders from it, so
// staff can add/remove/reorder fields and set required/optional/off with no code.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(express.json({ limit: '32kb' }));

const FIELD_TYPES = ['text', 'email', 'tel', 'date', 'textarea', 'select', 'multiselect', 'checkbox'];
const MGR = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);

// Manager gate used only on the admin methods (public GET stays open).
function manager(req, res, next) {
  authenticate(req, res, () => {
    if (!MGR.has(req.user?.role)) return res.status(403).json({ error: 'Manager access required' });
    next();
  });
}

function rowOut(r) {
  return {
    id: r.id, field_key: r.field_key, label: r.label, field_type: r.field_type,
    options: r.options || [], placeholder: r.placeholder, help_text: r.help_text,
    required: r.required, enabled: r.enabled, is_core: r.is_core, sort_order: r.sort_order,
  };
}

// ── PUBLIC: the live form definition for the website ─────────────────────────
router.get('/api/enquiry-form/public', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM enquiry_form_fields WHERE enabled = true ORDER BY sort_order, id`);
    res.json({ fields: rows.map(rowOut) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: full list ─────────────────────────────────────────────────────────
router.get('/api/enquiry-form', manager, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM enquiry_form_fields ORDER BY sort_order, id`);
    res.json({ fields: rows.map(rowOut) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: add a custom field ────────────────────────────────────────────────
router.post('/api/enquiry-form', manager, async (req, res) => {
  const b = req.body || {};
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Label is required' });
  const type = FIELD_TYPES.includes(b.field_type) ? b.field_type : 'text';
  // derive a stable custom key; custom fields land in enquiries.notes-appended data,
  // so prefix to avoid ever colliding with a real column.
  let key = String(b.field_key || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
  if (!key) key = 'field';
  if (!/^custom_/.test(key)) key = 'custom_' + key;
  const options = Array.isArray(b.options) ? b.options.map(String).slice(0, 40) : [];
  try {
    const db = getPool();
    const { rows: mx } = await db.query(`SELECT COALESCE(MAX(sort_order),100)+10 n FROM enquiry_form_fields`);
    const { rows } = await db.query(
      `INSERT INTO enquiry_form_fields (field_key,label,field_type,options,placeholder,help_text,required,enabled,is_core,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,true),false,$9)
       ON CONFLICT (field_key) DO UPDATE SET label=EXCLUDED.label RETURNING *`,
      [key, label, type, JSON.stringify(options), b.placeholder || null, b.help_text || null,
       !!b.required, b.enabled, mx[0].n]);
    res.status(201).json(rowOut(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: reorder (array of ids in the new order) ───────────────────────────
router.put('/api/enquiry-form/reorder', manager, async (req, res) => {
  const order = Array.isArray(req.body?.order) ? req.body.order : null;
  if (!order) return res.status(400).json({ error: 'order[] required' });
  try {
    const db = getPool();
    for (let i = 0; i < order.length; i++) {
      await db.query(`UPDATE enquiry_form_fields SET sort_order=$1, updated_at=now() WHERE id=$2`,
        [(i + 1) * 10, parseInt(order[i], 10)]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: edit / toggle / require ───────────────────────────────────────────
router.put('/api/enquiry-form/:id', manager, async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = [];
  const push = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
  if (b.label !== undefined) push('label', String(b.label).trim());
  if (b.field_type !== undefined && FIELD_TYPES.includes(b.field_type)) push('field_type', b.field_type);
  if (b.options !== undefined) push('options', JSON.stringify(Array.isArray(b.options) ? b.options.map(String).slice(0, 40) : []));
  if (b.placeholder !== undefined) push('placeholder', b.placeholder || null);
  if (b.help_text !== undefined) push('help_text', b.help_text || null);
  if (b.required !== undefined) push('required', !!b.required);
  if (b.enabled !== undefined) push('enabled', !!b.enabled);
  if (!sets.length) return res.status(400).json({ error: 'no changes' });
  sets.push('updated_at=now()');
  vals.push(parseInt(req.params.id, 10));
  try {
    const { rows } = await getPool().query(
      `UPDATE enquiry_form_fields SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rowOut(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN: delete (non-core only; core fields can be disabled, not removed) ──
router.delete('/api/enquiry-form/:id', manager, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT is_core FROM enquiry_form_fields WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].is_core) return res.status(400).json({ error: 'Core fields cannot be deleted — disable it instead.' });
    await db.query(`DELETE FROM enquiry_form_fields WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
