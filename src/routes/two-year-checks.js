'use strict';
/*
 * Statutory EYFS "Progress check at age two" (2-year progress check).
 *
 * Data lives in module_records under the existing Module-Builder module
 * "EYFS 2-Year Progress Check" (id below) — the preferred additive approach:
 * no new table, reuses the module's field schema for validation and the generic
 * admin module surfaces. This thin router adds the two things the generic module
 * engine does NOT provide for this statutory record:
 *   1. key-children scoping — manager/deputy see ALL; a practitioner sees only
 *      the checks for children where they are the key person.
 *   2. a printable PDF (reusing the pdfkit path used by parent reports).
 *
 * Additive only. Mounted on all portals in server-unified.js; role gating here.
 */
const express = require('express');
const router = express.Router();
const PDFDoc = require('pdfkit');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const MODULE_SLUG = 'assess-eyfs-2yr-progress-check';
let _moduleIdCache = null;

// Manager-level roles see every child's check; everyone else is scoped to their
// own key children (children.key_person_id = staff id).
const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);
const isManager = u => !!(u && MANAGER_ROLES.has(u.role));

router.use(authenticate);

async function moduleId(db) {
  if (_moduleIdCache) return _moduleIdCache;
  const { rows } = await db.query('SELECT id FROM modules WHERE slug=$1', [MODULE_SLUG]);
  if (!rows.length) throw new Error('2-year-check module not found (slug ' + MODULE_SLUG + ')');
  _moduleIdCache = rows[0].id;
  return _moduleIdCache;
}

async function moduleFields(db) {
  const id = await moduleId(db);
  const { rows } = await db.query('SELECT fields FROM modules WHERE id=$1', [id]);
  const f = rows[0] && rows[0].fields;
  return Array.isArray(f) ? f : [];
}

// Required-field validation against the module schema. Signature is captured
// implicitly (practitioner = submitted_by) so it is not required here.
function validate(fields, data) {
  const errors = [];
  for (const f of fields) {
    if (f.type === 'timestamp_auto' || f.type === 'signature') continue;
    const v = data[f.key];
    const present = v !== undefined && v !== null && v !== '';
    if (f.required && !present) errors.push((f.label || f.key) + ' is required');
  }
  return errors;
}

async function canAccessChild(db, user, childId) {
  if (isManager(user)) return true;
  const { rows } = await db.query(
    'SELECT 1 FROM children WHERE id=$1 AND key_person_id=$2', [childId, user.id]);
  return rows.length > 0;
}

// GET /schema — the module field definitions, for building the form.
router.get('/schema', async (req, res) => {
  try {
    const db = getPool();
    const id = await moduleId(db);
    const { rows } = await db.query(
      'SELECT id, name, description, icon, fields FROM modules WHERE id=$1', [id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET / — overview list. Manager: all. Practitioner: own key children.
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const id = await moduleId(db);
    const params = [id];
    let scope = '';
    if (!isManager(req.user)) { params.push(req.user.id); scope = ' AND c.key_person_id=$2'; }
    const { rows } = await db.query(`
      SELECT mr.id, mr.entity_id AS child_id, mr.data, mr.submitted_at, mr.updated_at,
             c.first_name AS child_first, c.last_name AS child_last,
             s.first_name || ' ' || s.last_name AS practitioner_name
      FROM module_records mr
      JOIN children c ON c.id = mr.entity_id
      LEFT JOIN staff s ON s.id = mr.submitted_by
      WHERE mr.module_id=$1 AND mr.entity_type='child' AND mr.is_deleted=false${scope}
      ORDER BY mr.submitted_at DESC
      LIMIT 300`, params);
    res.json({ checks: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId — checks for one child (role-scoped).
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const childId = parseInt(req.params.childId, 10);
    if (!childId) return res.status(400).json({ error: 'bad child id' });
    if (!(await canAccessChild(db, req.user, childId)))
      return res.status(403).json({ error: 'This child is not one of your key children' });
    const id = await moduleId(db);
    const { rows } = await db.query(`
      SELECT mr.id, mr.data, mr.submitted_by, mr.submitted_at, mr.updated_at,
             s.first_name || ' ' || s.last_name AS practitioner_name
      FROM module_records mr
      LEFT JOIN staff s ON s.id = mr.submitted_by
      WHERE mr.module_id=$1 AND mr.entity_type='child' AND mr.entity_id=$2 AND mr.is_deleted=false
      ORDER BY mr.submitted_at DESC`, [id, childId]);
    const { rows: crows } = await db.query(
      'SELECT id, first_name, last_name, date_of_birth, key_person_id FROM children WHERE id=$1', [childId]);
    res.json({ child: crows[0] || null, can_edit: true, checks: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId — create a check for a child.
router.post('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const childId = parseInt(req.params.childId, 10);
    if (!childId) return res.status(400).json({ error: 'bad child id' });
    if (!(await canAccessChild(db, req.user, childId)))
      return res.status(403).json({ error: 'This child is not one of your key children' });
    const fields = await moduleFields(db);
    const data = req.body.data || {};
    const errs = validate(fields, data);
    if (errs.length) return res.status(422).json({ errors: errs });
    const id = await moduleId(db);
    const portal = (req.user && req.user.portal) || req.query.portal || 'ey';
    const { rows } = await db.query(`
      INSERT INTO module_records
        (module_id, entity_type, entity_id, data, submitted_by, submitted_portal)
      VALUES ($1,'child',$2,$3,$4,$5)
      RETURNING *`, [id, childId, JSON.stringify(data), req.user.id, portal]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Load one record + the owning child (for access checks / rendering).
async function loadRecord(db, recordId) {
  const id = await moduleId(db);
  const { rows } = await db.query(`
    SELECT mr.*, c.key_person_id, c.first_name AS child_first, c.last_name AS child_last,
           c.date_of_birth AS child_dob,
           s.first_name || ' ' || s.last_name AS practitioner_name
    FROM module_records mr
    JOIN children c ON c.id = mr.entity_id
    LEFT JOIN staff s ON s.id = mr.submitted_by
    WHERE mr.id=$1 AND mr.module_id=$2 AND mr.is_deleted=false`, [recordId, id]);
  return rows[0] || null;
}

// GET /:id — one check.
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const rec = await loadRecord(db, parseInt(req.params.id, 10));
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (!isManager(req.user) && rec.key_person_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    res.json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — update a check.
router.put('/:id', async (req, res) => {
  try {
    const db = getPool();
    const rec = await loadRecord(db, parseInt(req.params.id, 10));
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (!isManager(req.user) && rec.key_person_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });
    const fields = await moduleFields(db);
    const data = req.body.data || rec.data || {};
    const errs = validate(fields, data);
    if (errs.length) return res.status(422).json({ errors: errs });
    const { rows } = await db.query(
      'UPDATE module_records SET data=$1, updated_by=$2, updated_at=NOW() WHERE id=$3 RETURNING *',
      [JSON.stringify(data), req.user.id, rec.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const BAND_LABEL = { /* pass-through, radios already store the label */ };
function fieldLabel(fields, key) {
  const f = fields.find(x => x.key === key);
  return f ? f.label : key;
}

// GET /:id/pdf — printable statutory check (reuses the parent-reports pdfkit path).
router.get('/:id/pdf', async (req, res) => {
  try {
    const db = getPool();
    const rec = await loadRecord(db, parseInt(req.params.id, 10));
    if (!rec) return res.status(404).json({ error: 'Not found' });
    if (!isManager(req.user) && rec.key_person_id !== req.user.id)
      return res.status(403).json({ error: 'Forbidden' });

    const fields = await moduleFields(db);
    const data = (typeof rec.data === 'string') ? JSON.parse(rec.data) : (rec.data || {});
    const childName = ((rec.child_first || '') + ' ' + (rec.child_last || '')).trim() || 'Child';

    const pdfBuf = await new Promise((resolve, reject) => {
      const doc = new PDFDoc({ size: 'A4', margin: 56 });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(17).font('Helvetica-Bold')
        .text('Your Nursery', { align: 'center' });
      doc.fontSize(10).font('Helvetica')
        .text('1A Example Lane, Ealing, W13 9LU', { align: 'center' });
      doc.moveDown(0.6);
      doc.fontSize(14).font('Helvetica-Bold')
        .text('Progress Check at Age Two', { align: 'center' });
      doc.fontSize(12).font('Helvetica')
        .text(childName, { align: 'center' });
      doc.moveDown(0.3);
      const meta = [];
      if (data.check_date) meta.push('Check date: ' + data.check_date);
      if (data.age_months) meta.push('Age: ' + data.age_months + ' months');
      if (rec.practitioner_name) meta.push('Practitioner: ' + rec.practitioner_name);
      doc.fontSize(9).fillColor('#555')
        .text(meta.join('   •   '), { align: 'center' });
      doc.fillColor('#000').moveDown(1);

      const band = k => data[k] ? '   [' + data[k] + ']' : '';
      const section = (heading, body) => {
        if (body === undefined || body === null || body === '') return;
        doc.fontSize(11).font('Helvetica-Bold').text(heading);
        doc.moveDown(0.15);
        doc.fontSize(10.5).font('Helvetica').text(String(body), { lineGap: 3 });
        doc.moveDown(0.7);
      };

      section('Communication & Language' + band('cl_band'), data.communication_language);
      section('Physical Development' + band('pd_band'), data.physical_development);
      section('Personal, Social & Emotional Development' + band('psed_band'), data.pse_development);

      doc.fontSize(11).font('Helvetica-Bold')
        .text('Any significant gaps / emerging SEN?  ' + (data.significant_gaps ? 'Yes' : 'No'));
      doc.moveDown(0.7);

      section('Next steps & targeted support', data.next_steps);
      section('How parents / carers can support at home', data.support_at_home);

      doc.moveDown(0.5);
      doc.fontSize(9).fillColor('#555')
        .text('Shared with parents/carers: ' + (data.shared_with_parents ? 'Yes' : 'Not yet'));
      doc.text('This is the statutory EYFS progress check at age two (DfE).');
      doc.end();
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${childName.replace(/[^a-z0-9]+/gi, '-')}-2-year-check.pdf"`,
    });
    res.send(pdfBuf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
