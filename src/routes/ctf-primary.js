'use strict';
// Schema-agnostic CTF route — relies on pool search_path (demo_primary)
// Does NOT use explicit  prefix — tables resolved via search_path
const express    = require('express');
const router     = express.Router();
const { getPool }    = require('../db/pool');
const authenticate   = require('../middleware/auth');
const { validate, parseXML } = require('../lib/ctf-25/validator');
const { parseCTF }   = require('../lib/ctf-25/parser');
const { buildCTF, buildFilename } = require('../lib/ctf-25/builder');

router.use(authenticate);

// ── Schema init (creates tables if missing in current search_path schema) ────
async function initSchema() {
  const db = getPool();
  const childCols = [
    'ALTER TABLE children ADD COLUMN IF NOT EXISTS upn TEXT',
    'ALTER TABLE children ADD COLUMN IF NOT EXISTS gender VARCHAR(1)',
    'ALTER TABLE children ADD COLUMN IF NOT EXISTS nationality TEXT',
    'ALTER TABLE children ADD COLUMN IF NOT EXISTS ethnicity_code TEXT',
    'ALTER TABLE children ADD COLUMN IF NOT EXISTS first_language_code TEXT',
    'ALTER TABLE children ADD COLUMN IF NOT EXISTS nc_year TEXT',
    'ALTER TABLE children ADD COLUMN IF NOT EXISTS ctf_source_lea TEXT',
    'ALTER TABLE children ADD COLUMN IF NOT EXISTS ctf_source_estab TEXT',
    'ALTER TABLE children ADD COLUMN IF NOT EXISTS ctf_source_school_name TEXT',
  ];
  for (const sql of childCols) {
    await db.query(sql).catch(() => {});
  }
  await db.query(`
    CREATE TABLE IF NOT EXISTS ctf_exports (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      exported_by     INTEGER,
      exported_at     TIMESTAMPTZ DEFAULT NOW(),
      child_ids       INTEGER[],
      child_count     INTEGER,
      qualifier       TEXT DEFAULT 'partial',
      dest_lea        TEXT,
      dest_estab      TEXT,
      dest_school_name TEXT,
      filename        TEXT,
      xml_size_bytes  INTEGER
    )`).catch(() => {});
  await db.query(`
    CREATE TABLE IF NOT EXISTS ctf_import_jobs (
      id          SERIAL PRIMARY KEY,
      status      TEXT DEFAULT 'pending',
      source_text TEXT,
      row_count_total INTEGER,
      row_count_imported INTEGER,
      error_log_json JSONB,
      created_by  INTEGER,
      created_at  TIMESTAMPTZ DEFAULT NOW(),
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    )`).catch(() => {});
}
initSchema().catch(e => console.error('[ctf-primary] schema init:', e.message));

function currentAcademicYear() {
  const n = new Date();
  return n.getMonth() >= 7 ? `${n.getFullYear()}/${n.getFullYear()+1}` : `${n.getFullYear()-1}/${n.getFullYear()}`;
}
function safeIds(ids) { return Array.isArray(ids) ? ids.map(Number).filter(Boolean) : []; }

// ── GET /history ──────────────────────────────────────────────────────────────
router.get('/history', async (req, res) => {
  try {
    const db = getPool();
    const { rows: exports } = await db.query(
      `SELECT id, exported_at, child_count, qualifier, dest_school_name, filename
       FROM ctf_exports ORDER BY exported_at DESC LIMIT 20`
    ).catch(() => ({ rows: [] }));
    const { rows: imports } = await db.query(
      `SELECT id, status, row_count_total, row_count_imported, created_at
       FROM ctf_import_jobs ORDER BY created_at DESC LIMIT 20`
    ).catch(() => ({ rows: [] }));
    res.json({ exports, imports });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /import — accepts XML string in body.xml ────────────────────────────
router.post('/import', async (req, res) => {
  const xmlText = req.body?.xml || req.body?.data;
  if (!xmlText) return res.status(400).json({ error: 'xml field required in request body' });
  try {
    const db = getPool();
    const { valid, errors } = validate(xmlText);
    if (!valid) return res.status(422).json({ error: 'XML validation failed', errors });

    const { pupils } = parseCTF(parseXML(xmlText));
    let created = 0, updated = 0, skipped = 0;

    for (const p of pupils) {
      if (!p.legal_surname && !p.legal_forename) { skipped++; continue; }
      const dob = p.dob || null;
      const { rowCount } = await db.query(`
        UPDATE children SET
          last_name=$1, first_name=$2, date_of_birth=$3,
          gender=$4, ethnicity_code=$5, first_language_code=$6,
          nc_year=$7, ctf_source_lea=$8, ctf_source_estab=$9,
          ctf_source_school_name=$10, upn=$11, updated_at=NOW()
        WHERE upn=$11 AND upn IS NOT NULL
      `, [p.legal_surname, p.legal_forename, dob, p.gender||null,
          p.ethnicity_code||null, p.first_language_code||null,
          p.nc_year||null, p.source_lea||null, p.source_estab||null,
          p.source_school_name||null, p.upn||null]);

      if (rowCount > 0) { updated++; }
      else if (p.upn || (p.legal_forename && p.legal_surname)) {
        await db.query(`
          INSERT INTO children
            (first_name, last_name, date_of_birth, gender,
             ethnicity_code, first_language_code, nc_year,
             ctf_source_lea, ctf_source_estab, ctf_source_school_name,
             upn, is_active, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,NOW(),NOW())
          ON CONFLICT DO NOTHING
        `, [p.legal_forename, p.legal_surname, dob, p.gender||null,
            p.ethnicity_code||null, p.first_language_code||null,
            p.nc_year||null, p.source_lea||null, p.source_estab||null,
            p.source_school_name||null, p.upn||null]);
        created++;
      } else { skipped++; }
    }

    await db.query(`
      INSERT INTO ctf_import_jobs
        (status, row_count_total, row_count_imported, created_by, created_at, updated_at)
      VALUES ('committed',$1,$2,$3,NOW(),NOW())
    `, [pupils.length, created + updated, req.user.id]).catch(() => {});

    res.json({ ok: true, created, updated, skipped, total: pupils.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /export — export children to CTF XML ─────────────────────────────────
router.get('/export', async (req, res) => {
  const { year_group, type } = req.query;
  try {
    const db = getPool();
    let sql = `SELECT * FROM children WHERE is_active=true`;
    const params = [];
    if (year_group) { sql += ` AND year_group=$${params.length+1}`; params.push(year_group); }
    const { rows: children } = await db.query(sql, params);
    if (!children.length) return res.status(404).json({ error: 'No children found' });

    const { rows: settings } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('school_lea','school_estab','school_name')`
    ).catch(() => ({ rows: [] }));
    const sm = Object.fromEntries(settings.map(r => [r.key, r.value]));
    const sourceSchool = {
      lea: sm.school_lea || '000',
      estab: sm.school_estab || '0000',
      name: sm.school_name || 'Wren Primary School',
      academicYear: currentAcademicYear(),
    };

    const xml = buildCTF({ sourceSchool, destSchool: null,
      qualifier: 'partial', supplierID: 'Wren', pupils: children });

    await db.query(`
      INSERT INTO ctf_exports
        (exported_by, child_ids, child_count, qualifier, filename, xml_size_bytes)
      VALUES ($1,$2,$3,'partial',$4,$5)
    `, [req.user.id, children.map(c=>c.id), children.length,
        buildFilename(sourceSchool.lea, sourceSchool.estab),
        Buffer.byteLength(xml,'utf8')]).catch(() => {});

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Content-Disposition', `attachment; filename="${buildFilename(sourceSchool.lea, sourceSchool.estab)}"`);
    res.send(xml);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
