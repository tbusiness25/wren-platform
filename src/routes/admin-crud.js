'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Admin generic table editor (Roost) — "edit everything from admin" (Toby, 2026-08-03).
// Lets a manager list + inline-edit + sort an ALLOW-LISTED set of tables/columns so
// the HR portal isn't needed for routine edits. DELIBERATELY NOT a raw SQL surface:
//   • Only tables in ALLOW are reachable; only columns in that table's allow-list are
//     writable; every column name is re-checked against information_schema at runtime
//     (so a typo/drift can't build bad SQL, and identifiers are never interpolated
//     from user input — only from validated allow-list membership).
//   • pin_hash / password / token / secret columns are NEVER in an allow-list and are
//     additionally hard-blocked. Values are always bound parameters.
//   • Manager-only; every write is audited.
// Mounted at /api/admin-crud.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
const MGT = ['manager', 'admin', 'headteacher', 'business_manager'];
router.use((req, res, next) =>
  hasRole(req.user, MGT) ? next() : res.status(403).json({ error: 'Manager access required' }));

// Columns that must NEVER be writable regardless of any allow-list.
const FORBIDDEN = /(pin_hash|password|passwd|secret|token|salt|hash|otp|mfa)/i;

// Allow-list: table → { label, editable[], (optional) readonly[] shown but not editable }.
// `id` is always shown, never editable. Sorting is allowed on any shown column.
const ALLOW = {
  staff: {
    label: 'Staff',
    readonly: ['id'],
    editable: ['first_name', 'last_name', 'email', 'phone', 'role', 'room_id', 'job_title',
      'contract_type', 'employment_type', 'contracted_hours', 'hours_per_week', 'hourly_rate',
      'annual_salary', 'start_date', 'contract_start', 'contract_end', 'is_active',
      'is_dsl', 'is_deputy_dsl', 'is_first_aider', 'is_send_lead', 'payroll_reference', 'photo_url',
      'profile_summary'],
  },
  rooms: { label: 'Rooms', readonly: ['id'], editable: ['name', 'capacity', 'ratio_children_per_staff'] },
  waiting_list: {
    label: 'Waiting list', readonly: ['id', 'created_at'],
    editable: ['notes', 'private_notes', 'how_heard', 'existing_family', 'flexible_start',
      'flexible_parttime', 'list_duration_months', 'auto_action', 'priority_score', 'status'],
  },
  tag_definitions: { label: 'Tags', readonly: ['id'], editable: ['name', 'colour', 'description'] },
  menu_items: { label: 'Menu items', readonly: ['id'], editable: ['name', 'description', 'allergens', 'category'] },
  fee_items: { label: 'Fee items', readonly: ['id'], editable: ['name', 'price_pence', 'statutory_category', 'unit', 'active'] },
};

// Actual columns present on a table right now (guards against schema drift so we
// never build SQL from a column the DB doesn't have).
async function liveColumns(db, table) {
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='ladn' AND table_name=$1`, [table]);
  return new Set(rows.map(r => r.column_name));
}

function cfg(table) { return Object.prototype.hasOwnProperty.call(ALLOW, table) ? ALLOW[table] : null; }

// GET /api/admin-crud/tables — what's editable
router.get('/tables', (req, res) => {
  res.json(Object.entries(ALLOW).map(([k, v]) => ({ table: k, label: v.label })));
});

// GET /api/admin-crud/:table?sort=col&dir=asc&limit=&offset=
router.get('/:table', async (req, res) => {
  const table = req.params.table;
  const c = cfg(table);
  if (!c) return res.status(404).json({ error: 'Unknown table' });
  try {
    const db = getPool();
    const live = await liveColumns(db, table);
    const shown = [...(c.readonly || []), ...c.editable].filter(col => live.has(col) && !FORBIDDEN.test(col));
    if (!shown.includes('id') && live.has('id')) shown.unshift('id');

    // Sort column must be one of the shown (validated) columns; direction ∈ asc/desc.
    let sort = shown.includes(req.query.sort) ? req.query.sort : (shown.includes('id') ? 'id' : shown[0]);
    const dir = String(req.query.dir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';
    const limit  = Math.min(Math.max(parseInt(req.query.limit, 10) || 500, 1), 2000);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const cols = shown.map(col => `"${col}"`).join(', ');   // identifiers are allow-list-validated, not user text
    const { rows } = await db.query(
      `SELECT ${cols} FROM ladn."${table}" ORDER BY "${sort}" ${dir} NULLS LAST LIMIT $1 OFFSET $2`, [limit, offset]);
    res.json({
      table, label: c.label,
      columns: shown.map(col => ({ name: col, editable: c.editable.includes(col) && !FORBIDDEN.test(col) })),
      rows,
    });
  } catch (e) { console.error('[admin-crud] list:', e.message); res.status(500).json({ error: e.message }); }
});

// PATCH /api/admin-crud/:table/:id  body: { column, value }  (single-field inline edit)
router.patch('/:table/:id', async (req, res) => {
  const table = req.params.table;
  const id = parseInt(req.params.id, 10);
  const { column, value } = req.body || {};
  const c = cfg(table);
  if (!c) return res.status(404).json({ error: 'Unknown table' });
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
  if (!c.editable.includes(column) || FORBIDDEN.test(column || '')) {
    return res.status(403).json({ error: `Column not editable: ${column}` });
  }
  try {
    const db = getPool();
    const live = await liveColumns(db, table);
    if (!live.has(column)) return res.status(400).json({ error: `Column does not exist: ${column}` });

    // The owner record (staff id=1, Toby) must not be mutated via the generic editor —
    // this blocks changing his role/is_active/email etc. here and honours CLAUDE.md Rule 1
    // (pin_hash is separately FORBIDDEN + never allow-listed). (L1 fix)
    if (table === 'staff' && id === 1) {
      return res.status(403).json({ error: 'The owner record cannot be edited here.' });
    }

    // Normalise empty string → NULL so numeric/bool/date columns clear cleanly.
    const v = (value === '' || value === undefined) ? null : value;
    const { rows } = await db.query(
      `UPDATE ladn."${table}" SET "${column}" = $1 WHERE id = $2 RETURNING id`, [v, id]);
    if (!rows.length) return res.status(404).json({ error: 'Row not found' });

    await recordAudit({ req, action: 'update', entity_type: `admin_crud:${table}`, entity_id: id,
      meta: { column } });   // value intentionally NOT logged (may be personal data)
    res.json({ ok: true, id, column });
  } catch (e) { console.error('[admin-crud] patch:', e.message); res.status(400).json({ error: e.message }); }
});

module.exports = router;
