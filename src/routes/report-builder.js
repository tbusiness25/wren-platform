'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b342 — custom reports (Roost → Operations → Reports). See src/lib/report-builder.js for the model.
//
//   GET    /meta          subjects, fields grouped for the checkboxes, rooms, and whether this person can see pay
//   POST   /run           { definition }            → the table, the sentence at the top, the counts
//   POST   /export        { definition }            → the same rows as a CSV download (same columns, same order)
//   GET    /saved         the saved definitions (shared with every manager)
//   POST   /saved         { name, definition, id? } → create, or update by id
//   DELETE /saved/:id     remove a saved DEFINITION (never any data — a definition holds no rows)
//
// WHO CAN REACH IT
//   Roost only (req._portal === 'admin'; authenticate() already demands an admin-audience token, so a parent or EY
//   token cannot get here) and manager level. server-unified.js also lists the prefix in ROOST_ONLY_PREFIXES, which puts
//   the Roost person allowlist in front of it. Pay fields are gated by canViewSalaries() exactly as everywhere else.
//
// WHAT IT WILL NOT DO (Toby, 2026-09-21)
//   This screen shows real names and contact details by design, so: every run and every export is audited (the field
//   KEYS, the filters and the row COUNT — never a value), there is no AI summarisation of the rows, and nothing leaves
//   except as the download the manager asked for. It writes no file, sends no email, calls no model.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { canViewSalaries } = require('../lib/capabilities');
const { recordAudit } = require('../utils/audit');
const FC = require('../lib/family-contacts');
const RB = require('../lib/report-builder');
const { shouldAnonymise } = require('../lib/pii-anon-mode');
const { anonymiseReportBuilderResult } = require('../lib/anonymise');

const router = express.Router();
router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner'];
router.use((req, res, next) => {
  if (req._portal !== 'admin') return res.status(403).json({ error: 'roost_only' });
  const held = authenticate.rolesHeldBy(req.user && req.user.role);
  if (!held.some(r => MANAGER_ROLES.includes(r))) return res.status(403).json({ error: 'Forbidden' });
  next();
});
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.use(express.json({ limit: '32kb' }));

const problem = (res, e) => {
  if (e instanceof RB.ReportError) return res.status(e.status).json({ error: e.error, code: e.code || undefined });
  if (e && (e.code === '42P01' || e.code === '42703' || e.code === 'B342_NOT_MIGRATED')) return res.status(503).json({ error: 'not_ready' });
  console.error('[report-builder]', e && e.message);   // message only — a query error can quote a value
  return res.status(500).json({ error: 'Internal error' });
};

// The tables and columns the children queries lean on. Without the migration the answer is "not ready", not a 500.
async function ready(db) {
  const { rows } = await db.query(`SELECT to_regclass('custom_reports') IS NOT NULL AS ok`);
  if (!rows[0].ok) return false;
  const f = await FC.features(db);
  return !!(f.slot && f.emergency);
}

function slug(name) {
  return String(name || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'report';
}
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });

// What goes in the audit trail: the shape of the question and the size of the answer. Never a row.
const auditMeta = (def, r, extra) => Object.assign({
  subject: def.subject, fields: def.fields, who: def.who, room_id: def.room_id || null,
  missing: def.missing || null, rows: r.matched, population: r.population,
}, extra || {});

// ── GET /meta ────────────────────────────────────────────────────────────────
router.get('/meta', async (req, res) => {
  try {
    const db = getPool();
    if (!(await ready(db))) return res.status(503).json({ error: 'not_ready' });
    const canPay = await canViewSalaries(req.user);
    const { rows: rooms } = await db.query('SELECT id, name FROM rooms ORDER BY id');
    res.json({ subjects: RB.catalogue(canPay), rooms, can_pay: canPay, max_rows: RB.MAX_ROWS });
  } catch (e) { problem(res, e); }
});

// ── POST /run ────────────────────────────────────────────────────────────────
router.post('/run', async (req, res) => {
  try {
    const db = getPool();
    if (!(await ready(db))) return res.status(503).json({ error: 'not_ready' });
    const canPay = await canViewSalaries(req.user);
    const { def } = RB.normaliseDefinition(req.body && req.body.definition, { canPay });
    const r = await RB.runReport(db, def);
    recordAudit({ req, action: 'run', entity_type: 'custom_report', entity_id: (req.body && req.body.saved_id) ? String(req.body.saved_id) : 'adhoc',
      meta: auditMeta(def, r) });
    res.json(Object.assign(r, { definition: def, max_rows: RB.MAX_ROWS }));
  } catch (e) { problem(res, e); }
});

// ── POST /export ─────────────────────────────────────────────────────────────
// b402: anon mode. ?anon=1 (or { anon: true } in the body) always wins; absent
// either way, the `pii_anon_exports_default` setting decides (off for LADN).
// See src/lib/pii-anon-mode.js / src/lib/anonymise.js.
router.post('/export', async (req, res) => {
  try {
    const db = getPool();
    if (!(await ready(db))) return res.status(503).json({ error: 'not_ready' });
    const canPay = await canViewSalaries(req.user);
    const { def } = RB.normaliseDefinition(req.body && req.body.definition, { canPay });
    const r = await RB.runReport(db, def);
    const anon = await shouldAnonymise(req);
    const out = anon ? anonymiseReportBuilderResult(def.subject, r) : r;
    recordAudit({ req, action: 'export', entity_type: 'custom_report', entity_id: (req.body && req.body.saved_id) ? String(req.body.saved_id) : 'adhoc',
      meta: auditMeta(def, r, { format: 'csv', anonymised: anon }) });
    const name = slug(req.body && req.body.name) + (anon ? '-anon' : '') + '-' + today() + '.csv';
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"`, 'X-Content-Type-Options': 'nosniff' });
    res.send(RB.toCsv(out.columns, out.rows));
  } catch (e) { problem(res, e); }
});

// ── saved definitions ────────────────────────────────────────────────────────
router.get('/saved', async (req, res) => {
  try {
    const db = getPool();
    if (!(await ready(db))) return res.status(503).json({ error: 'not_ready' });
    const canPay = await canViewSalaries(req.user);
    const { rows } = await db.query(
      `SELECT id, name, subject, definition, created_by_name, updated_at FROM custom_reports ORDER BY lower(name)`);
    res.json({ saved: rows.map(r => {
      // Someone who cannot see pay opens a report a colleague saved WITH pay columns: the columns are dropped and they are told.
      try {
        const { def, hidden } = RB.normaliseDefinition(r.definition, { canPay, stripPay: true });
        return { id: r.id, name: r.name, subject: r.subject, definition: def, hidden, by: r.created_by_name, updated_at: r.updated_at };
      } catch (e) {
        return { id: r.id, name: r.name, subject: r.subject, definition: null, broken: true, hidden: [], by: r.created_by_name, updated_at: r.updated_at };
      }
    }) });
  } catch (e) { problem(res, e); }
});

router.post('/saved', async (req, res) => {
  try {
    const db = getPool();
    if (!(await ready(db))) return res.status(503).json({ error: 'not_ready' });
    const name = String((req.body && req.body.name) || '').trim();
    if (!name) return res.status(400).json({ error: 'Please give the report a name.' });
    if (name.length > 80) return res.status(400).json({ error: 'That name is too long (80 characters at most).' });
    const canPay = await canViewSalaries(req.user);
    const { def } = RB.normaliseDefinition(req.body && req.body.definition, { canPay });
    const who = req.user && req.user.id != null ? Number(req.user.id) : null;
    const byName = (req.user && req.user.name) ? String(req.user.name).slice(0, 80) : null;
    const id = req.body && req.body.id != null ? parseInt(req.body.id, 10) : null;
    let row;
    if (id) {
      const r = await db.query(
        `UPDATE custom_reports SET name=$2, subject=$3, definition=$4::jsonb, updated_by=$5, updated_at=now() WHERE id=$1 RETURNING id, name`,
        [id, name, def.subject, JSON.stringify(def), who]);
      if (!r.rows.length) return res.status(404).json({ error: 'That report no longer exists.' });
      row = r.rows[0];
    } else {
      const r = await db.query(
        `INSERT INTO custom_reports (name, subject, definition, created_by, created_by_name, updated_by)
         VALUES ($1,$2,$3::jsonb,$4,$5,$4) RETURNING id, name`, [name, def.subject, JSON.stringify(def), who, byName]);
      row = r.rows[0];
    }
    recordAudit({ req, action: id ? 'update' : 'create', entity_type: 'custom_report_definition', entity_id: String(row.id),
      meta: { name: row.name, subject: def.subject, fields: def.fields, who: def.who, missing: def.missing || null } });
    res.status(id ? 200 : 201).json({ ok: true, id: row.id, name: row.name });
  } catch (e) {
    if (e && e.code === '23505') return res.status(409).json({ error: 'A saved report with that name already exists. Choose another name, or open it and save over it.' });
    problem(res, e);
  }
});

router.delete('/saved/:id', async (req, res) => {
  try {
    const db = getPool();
    if (!(await ready(db))) return res.status(503).json({ error: 'not_ready' });
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
    const r = await db.query('DELETE FROM custom_reports WHERE id = $1 RETURNING name', [id]);   // a definition only — it holds no data
    if (!r.rows.length) return res.status(404).json({ error: 'That report no longer exists.' });
    recordAudit({ req, action: 'delete', entity_type: 'custom_report_definition', entity_id: String(id), meta: { name: r.rows[0].name } });
    res.json({ ok: true });
  } catch (e) { problem(res, e); }
});

module.exports = router;
