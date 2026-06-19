'use strict';

const express = require('express');
const router  = express.Router();
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const AdmZip  = require('adm-zip');
const { getPool }     = require('../db/pool');
const authenticate    = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { validate, parseXML } = require('../lib/ctf-25/validator');
const { parseCTF }    = require('../lib/ctf-25/parser');
const { buildCTF, buildFilename } = require('../lib/ctf-25/builder');

const UPLOAD_DIR = '/app/uploads/ctf';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ── Auth ──────────────────────────────────────────────────────────────────────
router.use(authenticate);

const managerOnly = (req, res, next) => {
  if (!['manager','deputy_manager','admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerOnly);

// ── DB schema init ────────────────────────────────────────────────────────────
async function initSchema() {
  const db = getPool();

  // CTF-specific columns on children
  const childCols = [
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS gender          VARCHAR(1)",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS service_child   BOOLEAN DEFAULT FALSE",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS nationality     TEXT",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS country_of_birth TEXT",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS ethnicity_code  TEXT",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS first_language_code TEXT",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS preferred_surname   TEXT",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS preferred_forename  TEXT",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS nc_year         TEXT",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS sen_status      VARCHAR(1)",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS ctf_source_lea  TEXT",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS ctf_source_estab TEXT",
    "ALTER TABLE ladn.children ADD COLUMN IF NOT EXISTS ctf_source_school_name TEXT",
  ];
  for (const sql of childCols) {
    await db.query(sql).catch(e => {
      if (!e.message.includes('already exists')) console.error('[ctf schema]', e.message);
    });
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS ladn.ctf_sen_history (
      id          SERIAL PRIMARY KEY,
      child_id    INTEGER NOT NULL,
      stage_type  TEXT NOT NULL,
      stage_start_date DATE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ladn.ctf_fsm_history (
      id              SERIAL PRIMARY KEY,
      child_id        INTEGER NOT NULL,
      fsm_start_date  DATE,
      fsm_end_date    DATE,
      fsm_eligible    BOOLEAN NOT NULL DEFAULT FALSE,
      fsm_uk_born     BOOLEAN,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ladn.ctf_school_history (
      id              SERIAL PRIMARY KEY,
      child_id        INTEGER NOT NULL,
      lea             TEXT,
      estab           TEXT,
      school_name     TEXT,
      entry_date      DATE,
      leaving_date    DATE,
      leaving_reason  TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ladn.ctf_assessment_results (
      id               SERIAL PRIMARY KEY,
      child_id         INTEGER NOT NULL,
      stage            TEXT,
      subject_code     TEXT NOT NULL,
      result_status    TEXT,
      result_qualifier TEXT,
      method           TEXT,
      season           TEXT,
      year             INTEGER,
      result_mark      TEXT,
      result_grade     TEXT,
      result_type      TEXT,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    )`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS ladn.ctf_exports (
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
    )`);

  // Index on UPN for fast idempotency lookup
  await db.query(`CREATE INDEX IF NOT EXISTS children_upn_idx ON ladn.children(upn)
    WHERE upn IS NOT NULL`).catch(() => {});
}

initSchema().catch(e => console.error('[ctf] schema init failed:', e.message));

// ── Multer for CTF uploads ─────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(UPLOAD_DIR, req.params.id || 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, 'source' + path.extname(file.originalname).toLowerCase()),
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(xml|zip)$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('Only XML or ZIP files accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

// ── Helper: resolve XML from file path (handles .zip) ────────────────────────
function resolveXML(filePath) {
  if (/\.zip$/i.test(filePath)) {
    const zip = new AdmZip(filePath);
    const entry = zip.getEntries().find(e => /\.xml$/i.test(e.entryName));
    if (!entry) throw new Error('ZIP contains no XML file');
    return zip.readAsText(entry);
  }
  return fs.readFileSync(filePath, 'utf8');
}

// ── Helper: sanitise child ID list (no PII in logs) ──────────────────────────
function safeIds(ids) { return Array.isArray(ids) ? ids.map(Number).filter(Boolean) : []; }

// ═══════════════════════════════════════════════════════════════════════════════
//  IMPORT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/ctf/import/jobs — create a new import job
router.post('/import/jobs', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO ladn.import_jobs (source_kind, target_entity, uploaded_by)
       VALUES ('ctf_25', 'children', $1) RETURNING id`,
      [req.user.id]);
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ctf/import/jobs/:id/upload — upload XML or ZIP
router.post('/import/jobs/:id/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File exceeds 50 MB' });
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    try {
      await getPool().query(
        `UPDATE ladn.import_jobs
         SET file_path=$1, status='uploaded', uploaded_at=NOW(), updated_at=NOW()
         WHERE id=$2`,
        [req.file.path, req.params.id]);
      res.json({ ok: true, size: req.file.size, name: req.file.originalname });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// POST /api/ctf/import/jobs/:id/validate — structural + schema validation
router.post('/import/jobs/:id/validate', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM ladn.import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (!job.file_path || !fs.existsSync(job.file_path)) {
      return res.status(400).json({ error: 'No file uploaded yet' });
    }

    let xmlText;
    try { xmlText = resolveXML(job.file_path); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const { valid, errors } = validate(xmlText);
    const doc = valid ? parseXML(xmlText) : null;
    const pupilCount = doc?.CTfile?.Pupils?.Pupil?.length ?? 0;

    await db.query(
      `UPDATE ladn.import_jobs
       SET status=$1, row_count_total=$2, error_log_json=$3, updated_at=NOW()
       WHERE id=$4`,
      [valid ? 'validated' : 'preview', pupilCount, JSON.stringify({ errors }), job.id]);

    res.json({ valid, errors, pupil_count: pupilCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ctf/import/jobs/:id/dry-run — show what would be created/updated
router.post('/import/jobs/:id/dry-run', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM ladn.import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (!job.file_path || !fs.existsSync(job.file_path)) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let xmlText;
    try { xmlText = resolveXML(job.file_path); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const { valid, errors } = validate(xmlText);
    if (!valid) return res.status(422).json({ error: 'XML validation failed', errors });

    const { pupils } = parseCTF(parseXML(xmlText));
    const preview = await buildDryRun(db, pupils);
    res.json({ dry_run: true, pupils: preview, total: pupils.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/ctf/import/jobs/:id/commit — run the actual import
router.post('/import/jobs/:id/commit', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM ladn.import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.status === 'committed') {
      return res.status(409).json({ error: 'Already committed — create a new import job' });
    }
    if (!job.file_path || !fs.existsSync(job.file_path)) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    let xmlText;
    try { xmlText = resolveXML(job.file_path); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    const { valid, errors } = validate(xmlText);
    if (!valid) return res.status(422).json({ error: 'XML validation failed', errors });

    const { header, pupils } = parseCTF(parseXML(xmlText));
    const client = await db.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await runImport(client, pupils, header);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      await db.query(
        `UPDATE ladn.import_jobs SET status='failed', updated_at=NOW() WHERE id=$1`, [job.id]);
      throw err;
    } finally { client.release(); }

    const imported = result.created + result.updated;
    await db.query(
      `UPDATE ladn.import_jobs
       SET status='committed', row_count_imported=$1, row_count_total=$2,
           error_log_json=$3, updated_at=NOW()
       WHERE id=$4`,
      [imported, pupils.length, JSON.stringify({ errors: result.errors }), job.id]);

    recordAudit({ req, action: 'ctf_import', entity_type: 'children', entity_id: job.id,
      meta: { created: result.created, updated: result.updated,
              skipped: result.skipped, total: pupils.length,
              source_school: header.source_school_name } });

    res.json({ committed: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ctf/import/jobs/:id — status
router.get('/import/jobs/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT id, source_kind, status, row_count_total, row_count_imported, uploaded_at, updated_at, error_log_json FROM ladn.import_jobs WHERE id=$1',
      [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  EXPORT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/ctf/export/generate — generate CTF XML for given child IDs
router.post('/export/generate', async (req, res) => {
  const { child_ids, dest_lea, dest_estab, dest_school_name, qualifier } = req.body;
  const ids = safeIds(child_ids);
  if (!ids.length) return res.status(400).json({ error: 'child_ids required' });

  try {
    const db = getPool();

    // Fetch school settings for source info
    const { rows: settings } = await db.query(
      `SELECT value FROM ladn.settings WHERE key IN ('school_lea','school_estab','school_name') LIMIT 10`
    ).catch(() => ({ rows: [] }));
    const settingsMap = Object.fromEntries(settings.map(r => [r.key, r.value]));

    const sourceSchool = {
      lea:          settingsMap.school_lea   || '000',
      estab:        settingsMap.school_estab || '0000',
      name:         settingsMap.school_name  || 'Wren School',
      academicYear: currentAcademicYear(),
    };
    const destSchool = (dest_lea || dest_estab || dest_school_name)
      ? { lea: dest_lea, estab: dest_estab, name: dest_school_name }
      : null;

    // Fetch children
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rows: children } = await db.query(
      `SELECT * FROM ladn.children WHERE id IN (${placeholders})`, ids);
    if (!children.length) return res.status(404).json({ error: 'No children found' });

    // Augment each child with history tables
    for (const child of children) {
      const [senH, senP, fsmH, assR, schH] = await Promise.all([
        db.query('SELECT * FROM ladn.ctf_sen_history WHERE child_id=$1 ORDER BY stage_start_date', [child.id]),
        db.query('SELECT * FROM ladn.sen_register WHERE child_id=$1 AND is_active=true LIMIT 10', [child.id]),
        db.query('SELECT * FROM ladn.ctf_fsm_history WHERE child_id=$1 ORDER BY fsm_start_date', [child.id]),
        db.query('SELECT * FROM ladn.ctf_assessment_results WHERE child_id=$1 ORDER BY year, subject_code', [child.id]),
        db.query('SELECT * FROM ladn.ctf_school_history WHERE child_id=$1 ORDER BY entry_date', [child.id]),
      ]);
      child._senHistory      = senH.rows;
      child._senProvisions   = senP.rows.map(r => ({ sen_type: r.primary_need, rank: 1 }));
      child._fsmHistory      = fsmH.rows;
      child._assessmentResults = assR.rows;
      child._schoolHistory   = schH.rows;
    }

    const xml = buildCTF({ sourceSchool, destSchool, qualifier: qualifier || 'partial',
                           supplierID: 'Wren', pupils: children });

    // Validate before we let it out
    const { valid, errors: valErrors } = validate(xml);
    if (!valid) {
      return res.status(422).json({ error: 'Generated XML failed validation (Wren bug — report this)', errors: valErrors });
    }

    const filename = buildFilename(sourceSchool.lea, sourceSchool.estab, dest_lea, dest_estab);

    // Audit log
    const { rows: [exp] } = await db.query(
      `INSERT INTO ladn.ctf_exports
         (exported_by, child_ids, child_count, qualifier, dest_lea, dest_estab, dest_school_name, filename, xml_size_bytes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.user.id, ids, ids.length, qualifier || 'partial',
       dest_lea || null, dest_estab || null, dest_school_name || null,
       filename, Buffer.byteLength(xml, 'utf8')]);

    recordAudit({ req, action: 'ctf_export', entity_type: 'children', entity_id: exp.id,
      meta: { child_count: ids.length } });

    res.json({ export_id: exp.id, filename, xml_size: Buffer.byteLength(xml, 'utf8'),
               child_count: children.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ctf/export/:id/download — stream the XML
router.get('/export/:id/download', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM ladn.ctf_exports WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Export not found' });
    const exp = rows[0];

    const ids = safeIds(exp.child_ids);
    if (!ids.length) return res.status(400).json({ error: 'No children in this export' });

    const { rows: settings } = await db.query(
      `SELECT key, value FROM ladn.settings WHERE key IN ('school_lea','school_estab','school_name')`
    ).catch(() => ({ rows: [] }));
    const settingsMap = Object.fromEntries(settings.map(r => [r.key, r.value]));

    const sourceSchool = {
      lea:          settingsMap.school_lea   || '000',
      estab:        settingsMap.school_estab || '0000',
      name:         settingsMap.school_name  || 'Wren School',
      academicYear: currentAcademicYear(),
    };
    const destSchool = (exp.dest_lea || exp.dest_estab)
      ? { lea: exp.dest_lea, estab: exp.dest_estab, name: exp.dest_school_name }
      : null;

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    const { rows: children } = await db.query(
      `SELECT * FROM ladn.children WHERE id IN (${placeholders})`, ids);

    for (const child of children) {
      const [senH, senP, fsmH, assR, schH] = await Promise.all([
        db.query('SELECT * FROM ladn.ctf_sen_history WHERE child_id=$1 ORDER BY stage_start_date', [child.id]),
        db.query('SELECT * FROM ladn.sen_register WHERE child_id=$1 AND is_active=true LIMIT 10', [child.id]),
        db.query('SELECT * FROM ladn.ctf_fsm_history WHERE child_id=$1 ORDER BY fsm_start_date', [child.id]),
        db.query('SELECT * FROM ladn.ctf_assessment_results WHERE child_id=$1 ORDER BY year, subject_code', [child.id]),
        db.query('SELECT * FROM ladn.ctf_school_history WHERE child_id=$1 ORDER BY entry_date', [child.id]),
      ]);
      child._senHistory      = senH.rows;
      child._senProvisions   = senP.rows.map(r => ({ sen_type: r.primary_need, rank: 1 }));
      child._fsmHistory      = fsmH.rows;
      child._assessmentResults = assR.rows;
      child._schoolHistory   = schH.rows;
    }

    const xml = buildCTF({ sourceSchool, destSchool, qualifier: exp.qualifier || 'partial',
                           supplierID: 'Wren', pupils: children });

    const fn = exp.filename || buildFilename(sourceSchool.lea, sourceSchool.estab, exp.dest_lea, exp.dest_estab);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fn}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(xml);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/ctf/export/history — list recent exports
router.get('/export/history', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, exported_at, child_count, qualifier, dest_school_name, filename
       FROM ladn.ctf_exports ORDER BY exported_at DESC LIMIT 50`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  IMPORT LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

async function buildDryRun(db, pupils) {
  return Promise.all(pupils.map(async p => {
    const existing = await findExistingChild(db, p);
    return {
      upn:          p.upn,
      upn_is_temp:  p.upn_is_temp,
      name:         `${p.forename} ${p.surname}`,
      dob:          p.dob,
      action:       existing ? 'update' : 'create',
      service_child: p.service_child,
      sen_status:   p.sen_status,
      sen_history_count:       p.sen_history.length,
      fsm_history_count:       p.fsm_history.length,
      assessment_results_count: p.assessment_results.length,
      school_history_count:    p.school_history.length,
    };
  }));
}

async function findExistingChild(db, p) {
  // Primary key: UPN (if not TEMP)
  if (p.upn && !p.upn_is_temp) {
    const { rows } = await db.query(
      'SELECT id FROM ladn.children WHERE upn=$1', [p.upn]);
    if (rows.length) return rows[0];
  }
  // Fallback: name + DOB
  if (p.surname && p.forename && p.dob) {
    const { rows } = await db.query(
      `SELECT id FROM ladn.children
       WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND date_of_birth=$3`,
      [p.forename, p.surname, p.dob]);
    if (rows.length) return rows[0];
  }
  return null;
}

async function runImport(client, pupils, header) {
  let created = 0, updated = 0, skipped = 0;
  const errors = [];

  for (const p of pupils) {
    try {
      const existing = await findExistingChild(client, p);
      let childId;

      if (existing) {
        childId = existing.id;
        await client.query(
          `UPDATE ladn.children SET
             first_name          = COALESCE(NULLIF($1,''), first_name),
             last_name           = COALESCE(NULLIF($2,''), last_name),
             date_of_birth       = COALESCE($3, date_of_birth),
             gender              = COALESCE(NULLIF($4,''), gender),
             upn                 = COALESCE(NULLIF($5,''), upn),
             nc_year             = COALESCE(NULLIF($6,''), nc_year),
             ethnicity_code      = COALESCE(NULLIF($7,''), ethnicity_code),
             first_language_code = COALESCE(NULLIF($8,''), first_language_code),
             nationality         = COALESCE(NULLIF($9,''), nationality),
             country_of_birth    = COALESCE(NULLIF($10,''), country_of_birth),
             looked_after        = COALESCE($11, looked_after),
             service_child       = COALESCE($12, service_child),
             sen_status          = COALESCE(NULLIF($13,''), sen_status),
             preferred_surname   = COALESCE(NULLIF($14,''), preferred_surname),
             preferred_forename  = COALESCE(NULLIF($15,''), preferred_forename),
             ctf_source_lea      = $16,
             ctf_source_estab    = $17,
             ctf_source_school_name = $18,
             updated_at          = NOW()
           WHERE id = $19`,
          [p.forename, p.surname, p.dob, p.gender, p.upn, p.nc_year,
           p.ethnicity_code, p.first_language_code, p.nationality, p.country_of_birth,
           p.in_care, p.service_child, p.sen_status,
           p.preferred_forename, p.preferred_surname,
           header.source_lea, header.source_estab, header.source_school_name,
           childId]);
        updated++;
      } else {
        // Insert contact info from first parental contact
        const pc = p.contacts.find(c => c.parental_responsibility) || p.contacts[0] || {};
        const { rows: [newChild] } = await client.query(
          `INSERT INTO ladn.children
             (first_name, last_name, date_of_birth, gender, upn, nc_year,
              ethnicity_code, first_language_code, nationality, country_of_birth,
              looked_after, service_child, sen_status,
              preferred_surname, preferred_forename,
              parent_1_name, parent_1_email, parent_1_phone,
              address_line1, postcode,
              ctf_source_lea, ctf_source_estab, ctf_source_school_name,
              is_active, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                   $16,$17,$18,$19,$20,$21,$22,$23,true,NOW(),NOW())
           RETURNING id`,
          [p.forename, p.surname, p.dob, p.gender || 'U', p.upn, p.nc_year,
           p.ethnicity_code, p.first_language_code, p.nationality, p.country_of_birth,
           p.in_care || false, p.service_child || false, p.sen_status,
           p.preferred_surname, p.preferred_forename,
           pc.surname && pc.forename ? `${pc.forename} ${pc.surname}` : null,
           pc.email, pc.phones?.[0]?.number || null,
           pc.address_line1, pc.postcode,
           header.source_lea, header.source_estab, header.source_school_name]);
        childId = newChild.id;
        created++;
      }

      // Import SEN history (append only, avoid duplicates)
      for (const s of p.sen_history) {
        if (!s.stage_type || !s.start_date) continue;
        await client.query(
          `INSERT INTO ladn.ctf_sen_history (child_id, stage_type, stage_start_date)
           SELECT $1,$2,$3
           WHERE NOT EXISTS (
             SELECT 1 FROM ladn.ctf_sen_history
             WHERE child_id=$1 AND stage_type=$2 AND stage_start_date=$3)`,
          [childId, s.stage_type, s.start_date]);
      }

      // Import FSM history
      for (const f of p.fsm_history) {
        if (!f.start_date) continue;
        await client.query(
          `INSERT INTO ladn.ctf_fsm_history (child_id, fsm_start_date, fsm_end_date, fsm_eligible, fsm_uk_born)
           SELECT $1,$2,$3,$4,$5
           WHERE NOT EXISTS (
             SELECT 1 FROM ladn.ctf_fsm_history
             WHERE child_id=$1 AND fsm_start_date=$2)`,
          [childId, f.start_date, f.end_date || null, f.eligible, f.uk_born]);
      }

      // Import school history
      for (const s of p.school_history) {
        if (!s.school_name && !s.estab) continue;
        await client.query(
          `INSERT INTO ladn.ctf_school_history
             (child_id, lea, estab, school_name, entry_date, leaving_date, leaving_reason)
           SELECT $1,$2,$3,$4,$5,$6,$7
           WHERE NOT EXISTS (
             SELECT 1 FROM ladn.ctf_school_history
             WHERE child_id=$1 AND COALESCE(estab,'')=COALESCE($3,'')
               AND COALESCE(school_name,'')=COALESCE($4,''))`,
          [childId, s.lea, s.estab, s.school_name, s.entry_date, s.leaving_date, s.leaving_reason]);
      }

      // Import assessment results (replace by subject+year)
      for (const a of p.assessment_results) {
        if (!a.subject_code) continue;
        await client.query(
          `INSERT INTO ladn.ctf_assessment_results
             (child_id, stage, subject_code, result_status, result_qualifier,
              method, season, year, result_mark, result_grade, result_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT DO NOTHING`,
          [childId, a.stage, a.subject_code, a.result_status, a.result_qualifier,
           a.method, a.season, a.year, a.result_mark, a.result_grade, a.result_type]);
      }

    } catch (err) {
      errors.push({ upn: p.upn, name: `${p.forename} ${p.surname}`, error: err.message });
      skipped++;
    }
  }

  return { created, updated, skipped, total: pupils.length, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  CHILDREN LIST (for export UI)
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/children', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, first_name, last_name, date_of_birth, upn, year_group, nc_year,
              service_child, sen_status, looked_after, is_active
       FROM ladn.children WHERE is_active=true ORDER BY last_name, first_name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Utility ───────────────────────────────────────────────────────────────────
function currentAcademicYear() {
  const now = new Date();
  const y = now.getFullYear();
  return now.getMonth() >= 7 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

module.exports = router;
