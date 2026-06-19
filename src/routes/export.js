'use strict';
const express  = require('express');
const router   = express.Router();
const PDFDoc   = require('pdfkit');
const { getPool }   = require('../db/pool');
const authenticate  = require('../middleware/auth');
const { renderEntityToPDF } = require('../../shared/pdf-renderer');

router.use(authenticate);

const VALID_ENTITIES = new Set([
  'module_record', 'observation', 'supervision', 'incident', 'daily_diary_day'
]);

// ─── Data fetchers ────────────────────────────────────────────────────────────

async function fetchModuleRecord(id, db) {
  const { rows: [rec] } = await db.query(`
    SELECT mr.*, m.name AS module_name, m.fields, m.icon, m.slug
    FROM module_records mr
    JOIN modules m ON m.id = mr.module_id
    WHERE mr.id = $1 AND mr.is_deleted = false
  `, [id]);
  if (!rec) return null;

  const { rows: uploads } = await db.query(
    'SELECT id, field_key, filename, storage_path, mime_type FROM module_uploads WHERE record_id = $1',
    [id]
  );
  rec._uploads = uploads;

  if (rec.entity_type === 'child' && rec.entity_id) {
    const { rows: [c] } = await db.query(
      'SELECT first_name, last_name FROM children WHERE id = $1', [rec.entity_id]
    );
    if (c) rec._entity_name = `${c.first_name} ${c.last_name}`;
  } else if (rec.entity_type === 'staff' && rec.entity_id) {
    const { rows: [s] } = await db.query(
      'SELECT first_name, last_name FROM staff WHERE id = $1', [rec.entity_id]
    );
    if (s) rec._entity_name = `${s.first_name} ${s.last_name}`;
  }

  if (rec.submitted_by) {
    const { rows: [sub] } = await db.query(
      'SELECT first_name, last_name FROM staff WHERE id = $1', [rec.submitted_by]
    );
    if (sub) rec._submitted_by_name = `${sub.first_name} ${sub.last_name}`;
  }
  return rec;
}

async function fetchObservation(id, db) {
  const { rows: [obs] } = await db.query(`
    SELECT o.*,
      c.first_name || ' ' || c.last_name AS child_name,
      r.name AS room_name,
      s.first_name || ' ' || s.last_name AS staff_name
    FROM observations o
    JOIN children c ON c.id = o.child_id
    LEFT JOIN rooms r ON r.id = c.room_id
    LEFT JOIN staff s ON s.id = o.staff_id
    WHERE o.id = $1
  `, [id]);
  return obs || null;
}

async function fetchSupervision(id, db) {
  const { rows: [sv] } = await db.query(`
    SELECT sv.*,
      st.first_name || ' ' || st.last_name AS staff_name,
      st.role AS staff_role,
      s2.first_name || ' ' || s2.last_name AS supervisor_name
    FROM supervisions sv
    JOIN staff st ON st.id = sv.staff_id
    LEFT JOIN staff s2 ON s2.id = sv.supervisor_id
    WHERE sv.id = $1
  `, [id]);
  if (!sv) return null;
  const { rows: targets } = await db.query(
    'SELECT * FROM supervision_targets WHERE supervision_id = $1 ORDER BY id', [id]
  );
  sv._targets = targets;
  return sv;
}

async function fetchIncident(id, db) {
  const { rows: [inc] } = await db.query(`
    SELECT i.*,
      c.first_name || ' ' || c.last_name AS child_name,
      r.name AS room_name,
      s.first_name || ' ' || s.last_name AS reporter_name
    FROM incidents i
    JOIN children c ON c.id = i.child_id
    LEFT JOIN rooms r ON r.id = c.room_id
    LEFT JOIN staff s ON s.id = i.reported_by
    WHERE i.id = $1
  `, [id]);
  return inc || null;
}

async function fetchDailyDiaryDay(id, db) {
  const { rows: [dd] } = await db.query(`
    SELECT d.*,
      c.first_name || ' ' || c.last_name AS child_name
    FROM daily_diary d
    JOIN children c ON c.id = d.child_id
    WHERE d.id = $1
  `, [id]);
  return dd || null;
}

async function fetchEntity(entityType, id, db) {
  switch (entityType) {
    case 'module_record':   return fetchModuleRecord(id, db);
    case 'observation':     return fetchObservation(id, db);
    case 'supervision':     return fetchSupervision(id, db);
    case 'incident':        return fetchIncident(id, db);
    case 'daily_diary_day': return fetchDailyDiaryDay(id, db);
    default:                return null;
  }
}

// ─── Parent access guard ──────────────────────────────────────────────────────
// Parents (role=parent) may only export module_records for their child.

function parentCanAccess(entityType, data, childId) {
  if (entityType !== 'module_record') return false;
  if (!data) return false;
  if (data.entity_type === 'child' && parseInt(data.entity_id) === parseInt(childId)) return true;
  const rel = typeof data.related_ids === 'string'
    ? (() => { try { return JSON.parse(data.related_ids); } catch { return {}; } })()
    : (data.related_ids || {});
  return Array.isArray(rel.child) && rel.child.some(i => parseInt(i) === parseInt(childId));
}

// ─── PDF builder helper ───────────────────────────────────────────────────────
// Awaits callback (which may be async) before calling doc.end()

async function buildPDF(callback) {
  return new Promise(async (resolve, reject) => {
    const doc    = new PDFDoc({ size: 'A4', margins: { top: 50, bottom: 50, left: 50, right: 50 }, autoFirstPage: false });
    const chunks = [];
    doc.on('data',  c => chunks.push(c));
    doc.on('end',   () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try {
      await callback(doc);
    } catch (e) {
      reject(e);
      return;
    }
    doc.end();
  });
}

// ─── GET /pdf/:entity/:id ─────────────────────────────────────────────────────

router.get('/pdf/:entity/:id', async (req, res) => {
  const { entity } = req.params;
  const id = parseInt(req.params.id);

  if (!VALID_ENTITIES.has(entity)) {
    return res.status(400).json({ error: 'Invalid entity type' });
  }
  if (!id) return res.status(400).json({ error: 'Invalid id' });

  try {
    const db   = getPool();
    const data = await fetchEntity(entity, id, db);
    if (!data) return res.status(404).json({ error: 'Record not found' });

    if (req.user.role === 'parent') {
      if (!parentCanAccess(entity, data, req.user.child_id)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const dateStr  = new Date().toISOString().slice(0, 10);
    const filename = `${entity.replace(/_/g, '-')}-${id}-${dateStr}.pdf`;

    const buf = await buildPDF(doc => {
      doc.addPage();
      renderEntityToPDF(doc, entity, data);
    });

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      buf.length,
    });
    res.send(buf);
  } catch (e) {
    console.error('export pdf:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// ─── POST /pdf/bulk ───────────────────────────────────────────────────────────

router.post('/pdf/bulk', async (req, res) => {
  const { entity, ids } = req.body;

  if (!VALID_ENTITIES.has(entity)) {
    return res.status(400).json({ error: 'Invalid entity type' });
  }
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ error: 'ids array required' });
  }
  if (ids.length > 30) {
    return res.status(400).json({ error: 'Maximum 30 records per bulk export' });
  }

  try {
    const db = getPool();
    let count = 0;

    const buf = await buildPDF(async doc => {
      for (const rawId of ids) {
        const id = parseInt(rawId);
        if (!id) continue;
        const data = await fetchEntity(entity, id, db);
        if (!data) continue;

        if (req.user.role === 'parent') {
          if (!parentCanAccess(entity, data, req.user.child_id)) continue;
        }

        doc.addPage();
        renderEntityToPDF(doc, entity, data);
        count++;
      }
      if (count === 0) {
        doc.addPage();
        doc.fontSize(11).fillColor('#64748b')
           .text('No records found or accessible.', { align: 'center' });
      }
    });

    const dateStr  = new Date().toISOString().slice(0, 10);
    const filename = `bulk-${entity.replace(/_/g, '-')}-${dateStr}.pdf`;

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length':      buf.length,
    });
    res.send(buf);
  } catch (e) {
    console.error('export pdf bulk:', e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

module.exports = router;
