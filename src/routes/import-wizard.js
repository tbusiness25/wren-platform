'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');

const IMPORT_DIR = '/app/uploads/imports';

// ── Auth ──────────────────────────────────────────────────────────────────────
router.use(authenticate);

const managerOnly = (req, res, next) => {
  // Include school leadership roles so headteachers / business managers can run
  // imports on school editions (their instances have no 'manager'/'admin' role).
  if (!['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};
router.use(managerOnly);

// ── DB schema init ────────────────────────────────────────────────────────────
async function initSchema() {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS import_jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      source_kind VARCHAR(32) NOT NULL DEFAULT 'csv',
      uploaded_by INTEGER,
      uploaded_at TIMESTAMPTZ,
      file_path TEXT,
      target_entity VARCHAR(64),
      mapping_json JSONB,
      status VARCHAR(32) DEFAULT 'draft',
      row_count_total INTEGER DEFAULT 0,
      row_count_imported INTEGER DEFAULT 0,
      error_log_json JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS import_templates (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      source_kind VARCHAR(32) DEFAULT 'csv',
      target_entity VARCHAR(64),
      mapping_json JSONB NOT NULL,
      version INTEGER DEFAULT 1,
      is_builtin BOOLEAN DEFAULT FALSE,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}
initSchema().catch(err => console.error('[import-wizard] schema init failed:', err.message));

// ── CSV parser ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuote) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { field += c; }
    } else {
      if (c === '"') { inQuote = true; }
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\r' && next === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
      else if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; }
      else { field += c; }
    }
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  // Filter out fully-empty rows
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

// ── Encoding reader ───────────────────────────────────────────────────────────
function readCSVFile(filePath, encoding = 'utf-8') {
  const encMap = { 'utf-8': 'utf8', 'win-1252': 'latin1', 'iso-8859-1': 'latin1', 'cp1252': 'latin1' };
  let text = fs.readFileSync(filePath, encMap[encoding] || 'utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // strip BOM
  return text;
}

// ── Entity schemas ────────────────────────────────────────────────────────────
const ENTITY_SCHEMAS = {
  children: {
    label: 'Children',
    description: 'Import child records with parent contact details',
    fields: [
      { key: 'first_name',     label: 'First Name',       required: true,  type: 'string' },
      { key: 'last_name',      label: 'Last Name',        required: true,  type: 'string' },
      { key: 'date_of_birth',  label: 'Date of Birth',    required: true,  type: 'date' },
      { key: 'room_name',      label: 'Room Name',        required: false, type: 'string', hint: 'Must match an existing room' },
      { key: 'allergies',      label: 'Allergies',        required: false, type: 'string' },
      { key: 'medical_notes',  label: 'Medical Notes',    required: false, type: 'string' },
      { key: 'start_date',     label: 'Start Date',       required: false, type: 'date' },
      { key: 'parent_1_name',  label: 'Parent 1 Name',    required: false, type: 'string' },
      { key: 'parent_1_email', label: 'Parent 1 Email',   required: false, type: 'email' },
      { key: 'parent_1_phone', label: 'Parent 1 Phone',   required: false, type: 'string' },
    ]
  },
  staff: {
    label: 'Staff',
    description: 'Import staff member records',
    fields: [
      { key: 'first_name',       label: 'First Name',       required: true,  type: 'string' },
      { key: 'last_name',        label: 'Last Name',        required: true,  type: 'string' },
      { key: 'role',             label: 'Role',             required: true,  type: 'enum',
        values: ['manager','deputy_manager','room_leader','practitioner','admin'] },
      { key: 'email',            label: 'Email',            required: true,  type: 'email' },
      { key: 'pin',              label: 'PIN (4 digits)',    required: false, type: 'pin' },
      { key: 'phone',            label: 'Phone',            required: false, type: 'string' },
      { key: 'employment_type',  label: 'Employment Type',  required: false, type: 'enum',
        values: ['permanent','temporary','part_time','bank'] },
    ]
  },
  parents: {
    label: 'Parents',
    description: 'Update parent contact details on existing child records',
    fields: [
      { key: 'child_first_name',  label: "Child's First Name",  required: true,  type: 'string' },
      { key: 'child_last_name',   label: "Child's Last Name",   required: true,  type: 'string' },
      { key: 'parent_1_name',     label: 'Parent 1 Full Name',  required: false, type: 'string' },
      { key: 'parent_1_email',    label: 'Parent 1 Email',      required: false, type: 'email' },
      { key: 'parent_1_phone',    label: 'Parent 1 Phone',      required: false, type: 'string' },
      { key: 'parent_2_name',     label: 'Parent 2 Full Name',  required: false, type: 'string' },
      { key: 'parent_2_email',    label: 'Parent 2 Email',      required: false, type: 'email' },
      { key: 'parent_2_phone',    label: 'Parent 2 Phone',      required: false, type: 'string' },
    ]
  },
  attendance: {
    label: 'Attendance',
    description: 'Import attendance records linked to existing children',
    fields: [
      { key: 'child_first_name', label: "Child's First Name", required: true,  type: 'string' },
      { key: 'child_last_name',  label: "Child's Last Name",  required: true,  type: 'string' },
      { key: 'date',             label: 'Date',               required: true,  type: 'date' },
      { key: 'session',          label: 'Session',            required: false, type: 'string',
        hint: 'full_day / morning / afternoon' },
      { key: 'absent',           label: 'Absent?',            required: false, type: 'boolean' },
      { key: 'absence_reason',   label: 'Absence Reason',     required: false, type: 'string' },
    ]
  },
  observations: {
    label: 'Observations',
    description: 'Import observation records linked to existing children',
    fields: [
      { key: 'child_first_name',   label: "Child's First Name",  required: true,  type: 'string' },
      { key: 'child_last_name',    label: "Child's Last Name",   required: true,  type: 'string' },
      { key: 'observation_text',   label: 'Observation Text',    required: true,  type: 'string' },
      { key: 'title',              label: 'Title',               required: false, type: 'string' },
      { key: 'observation_type',   label: 'Observation Type',    required: false, type: 'enum',
        values: ['learning_story','milestone','note','2year_check','assessment'] },
      { key: 'date',               label: 'Date',                required: false, type: 'date' },
    ]
  },
  funding: {
    label: 'Funding',
    description: 'Update funded hours on existing child records',
    fields: [
      { key: 'child_first_name',  label: "Child's First Name",  required: true,  type: 'string' },
      { key: 'child_last_name',   label: "Child's Last Name",   required: true,  type: 'string' },
      { key: 'funded_hours',      label: 'Funded Hours/Week',   required: true,  type: 'number' },
      { key: 'funded_hours_type', label: 'Funding Type',        required: false, type: 'string',
        hint: '15h_universal / 30h_extended / 2yr_funded' },
      { key: 'thirty_hour_code',  label: '30-Hour Code',        required: false, type: 'string' },
    ]
  }
};

// ── Date parser ───────────────────────────────────────────────────────────────
function parseDate(value) {
  if (!value || !String(value).trim()) return null;
  const v = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    if (!isNaN(new Date(v))) return v;
  }
  const dmy = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy) {
    const iso = `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
    if (!isNaN(new Date(iso))) return iso;
  }
  return null;
}

function parseBoolean(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  if (['true','yes','1','y'].includes(v)) return true;
  if (['false','no','0','n'].includes(v)) return false;
  return null;
}

// ── Apply mapping ─────────────────────────────────────────────────────────────
function applyMapping(sourceRow, headers, mapping) {
  const mapped = {};
  for (const [targetField, sourceCol] of Object.entries(mapping)) {
    if (!sourceCol) continue;
    const colIdx = headers.findIndex(h =>
      h.toLowerCase().trim() === String(sourceCol).toLowerCase().trim()
    );
    if (colIdx !== -1) mapped[targetField] = sourceRow[colIdx] || '';
  }
  return mapped;
}

// ── Row validator ─────────────────────────────────────────────────────────────
function validateRow(row, schema, rowNum) {
  const errors = [];
  for (const field of schema.fields) {
    const value = String(row[field.key] || '').trim();
    if (field.required && !value) {
      errors.push({ row: rowNum, field: field.key, error: `Required: "${field.label}" is missing`, value: '' });
      continue;
    }
    if (!value) continue;
    if (field.type === 'date' && !parseDate(value)) {
      errors.push({ row: rowNum, field: field.key,
        error: `Invalid date in "${field.label}" — use DD/MM/YYYY or YYYY-MM-DD`, value });
    } else if (field.type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      errors.push({ row: rowNum, field: field.key, error: `Invalid email in "${field.label}"`, value });
    } else if (field.type === 'enum' && !field.values.includes(value.toLowerCase())) {
      errors.push({ row: rowNum, field: field.key,
        error: `"${field.label}" must be one of: ${field.values.join(', ')}`, value });
    } else if (field.type === 'pin' && !/^\d{4}$/.test(value)) {
      errors.push({ row: rowNum, field: field.key,
        error: `"${field.label}" must be exactly 4 digits`, value });
    } else if (field.type === 'number' && isNaN(parseFloat(value))) {
      errors.push({ row: rowNum, field: field.key, error: `"${field.label}" must be a number`, value });
    } else if (field.type === 'boolean' && parseBoolean(value) === null) {
      errors.push({ row: rowNum, field: field.key,
        error: `"${field.label}" must be yes/no or true/false`, value });
    }
  }
  return errors;
}

// ── Import executor (runs inside a transaction) ───────────────────────────────
async function runImport(client, job, dataRows, headers) {
  const mapping = job.mapping_json;
  const entity = job.target_entity;
  const schema = ENTITY_SCHEMAS[entity];
  if (!schema) throw new Error(`Unknown entity: ${entity}`);

  let created = 0, updated = 0, skipped = 0;
  const errors = [];

  for (let i = 0; i < dataRows.length; i++) {
    const rowNum = i + 2; // 1-based, row 1 is header
    const row = applyMapping(dataRows[i], headers, mapping);
    const rowErrors = validateRow(row, schema, rowNum);
    if (rowErrors.length) { errors.push(...rowErrors); skipped++; continue; }

    try {
      if (entity === 'children') {
        const dob = parseDate(row.date_of_birth);
        let roomId = null;
        if (row.room_name && row.room_name.trim()) {
          const { rows: r } = await client.query(
            'SELECT id FROM rooms WHERE lower(name)=lower($1)', [row.room_name]);
          roomId = r[0]?.id ?? null;
        }
        const { rows: ex } = await client.query(
          'SELECT id FROM children WHERE first_name=$1 AND last_name=$2 AND date_of_birth=$3',
          [row.first_name, row.last_name, dob]);
        if (ex.length) {
          await client.query(
            `UPDATE children SET
               room_id=COALESCE($1,room_id),
               allergies=COALESCE(NULLIF($2,''),allergies),
               medical_notes=COALESCE(NULLIF($3,''),medical_notes),
               parent_1_name=COALESCE(NULLIF($4,''),parent_1_name),
               parent_1_email=COALESCE(NULLIF($5,''),parent_1_email),
               parent_1_phone=COALESCE(NULLIF($6,''),parent_1_phone),
               updated_at=NOW()
             WHERE id=$7`,
            [roomId, row.allergies||null, row.medical_notes||null,
             row.parent_1_name||null, row.parent_1_email||null, row.parent_1_phone||null,
             ex[0].id]);
          updated++;
        } else {
          await client.query(
            `INSERT INTO children
               (first_name, last_name, date_of_birth, room_id, allergies, medical_notes,
                start_date, parent_1_name, parent_1_email, parent_1_phone, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)`,
            [row.first_name, row.last_name, dob, roomId,
             row.allergies||null, row.medical_notes||null,
             row.start_date ? parseDate(row.start_date) : null,
             row.parent_1_name||null, row.parent_1_email||null, row.parent_1_phone||null]);
          created++;
        }

      } else if (entity === 'staff') {
        // ABSOLUTE RULE: never touch id=1 (Toby Jones) — see CLAUDE.md
        const { rows: ex } = await client.query(
          'SELECT id FROM staff WHERE lower(email)=lower($1) AND id != 1',
          [row.email || '___no_match___']);
        if (ex.length) {
          await client.query(
            `UPDATE staff SET
               first_name=COALESCE(NULLIF($1,''),first_name),
               last_name=COALESCE(NULLIF($2,''),last_name),
               role=COALESCE(NULLIF($3,''),role),
               phone=COALESCE(NULLIF($4,''),phone),
               updated_at=NOW()
             WHERE id=$5`,
            [row.first_name, row.last_name, row.role||null, row.phone||null, ex[0].id]);
          updated++;
        } else {
          const pinHash = row.pin ? await bcrypt.hash(row.pin, 10) : await bcrypt.hash('0000', 10);
          await client.query(
            `INSERT INTO staff (first_name, last_name, role, email, pin_hash, phone, employment_type, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,true)
             ON CONFLICT (email) DO NOTHING`,
            [row.first_name, row.last_name, row.role, row.email,
             pinHash, row.phone||null, row.employment_type||'permanent']);
          created++;
        }

      } else if (entity === 'parents') {
        const { rows: ch } = await client.query(
          'SELECT id FROM children WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND is_active=true',
          [row.child_first_name, row.child_last_name]);
        if (!ch.length) {
          errors.push({ row: rowNum, field: 'child_first_name',
            error: `Child "${row.child_first_name} ${row.child_last_name}" not found`, value: '' });
          skipped++; continue;
        }
        await client.query(
          `UPDATE children SET
             parent_1_name=COALESCE(NULLIF($1,''),parent_1_name),
             parent_1_email=COALESCE(NULLIF($2,''),parent_1_email),
             parent_1_phone=COALESCE(NULLIF($3,''),parent_1_phone),
             parent_2_name=COALESCE(NULLIF($4,''),parent_2_name),
             parent_2_email=COALESCE(NULLIF($5,''),parent_2_email),
             parent_2_phone=COALESCE(NULLIF($6,''),parent_2_phone),
             updated_at=NOW()
           WHERE id=$7`,
          [row.parent_1_name||null, row.parent_1_email||null, row.parent_1_phone||null,
           row.parent_2_name||null, row.parent_2_email||null, row.parent_2_phone||null,
           ch[0].id]);
        updated++;

      } else if (entity === 'attendance') {
        const date = parseDate(row.date);
        const { rows: ch } = await client.query(
          'SELECT id FROM children WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND is_active=true',
          [row.child_first_name, row.child_last_name]);
        if (!ch.length) {
          errors.push({ row: rowNum, field: 'child_first_name',
            error: `Child "${row.child_first_name} ${row.child_last_name}" not found`, value: '' });
          skipped++; continue;
        }
        const session = row.session && row.session.trim() ? row.session.trim() : 'full_day';
        const absent = row.absent ? (parseBoolean(row.absent) || false) : false;
        await client.query(
          `INSERT INTO attendance (child_id, date, session, absent, absence_reason)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (child_id, date, session) DO UPDATE
             SET absent=EXCLUDED.absent, absence_reason=EXCLUDED.absence_reason`,
          [ch[0].id, date, session, absent, row.absence_reason||null]);
        created++;

      } else if (entity === 'observations') {
        const { rows: ch } = await client.query(
          'SELECT id FROM children WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND is_active=true',
          [row.child_first_name, row.child_last_name]);
        if (!ch.length) {
          errors.push({ row: rowNum, field: 'child_first_name',
            error: `Child "${row.child_first_name} ${row.child_last_name}" not found`, value: '' });
          skipped++; continue;
        }
        const validTypes = ['learning_story','milestone','note','2year_check','assessment'];
        const obsType = row.observation_type && validTypes.includes(row.observation_type.toLowerCase())
          ? row.observation_type.toLowerCase() : 'note';
        const createdAt = row.date ? parseDate(row.date) : null;
        await client.query(
          `INSERT INTO observations (child_id, title, observation_text, observation_type, created_at)
           VALUES ($1,$2,$3,$4,COALESCE($5::date,NOW()))`,
          [ch[0].id, row.title||null, row.observation_text, obsType, createdAt]);
        created++;

      } else if (entity === 'funding') {
        const { rows: ch } = await client.query(
          'SELECT id FROM children WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND is_active=true',
          [row.child_first_name, row.child_last_name]);
        if (!ch.length) {
          errors.push({ row: rowNum, field: 'child_first_name',
            error: `Child "${row.child_first_name} ${row.child_last_name}" not found`, value: '' });
          skipped++; continue;
        }
        await client.query(
          `UPDATE children SET
             funded_hours=$1,
             funded_hours_type=COALESCE(NULLIF($2,''),funded_hours_type),
             thirty_hour_code=COALESCE(NULLIF($3,''),thirty_hour_code),
             updated_at=NOW()
           WHERE id=$4`,
          [parseFloat(row.funded_hours)||0, row.funded_hours_type||null,
           row.thirty_hour_code||null, ch[0].id]);
        updated++;
      }
    } catch (err) {
      errors.push({ row: rowNum, field: '', error: err.message, value: '' });
      skipped++;
    }
  }

  return { created, updated, skipped, total: dataRows.length, errors };
}

// ── File cleanup cron (7-day retention) ───────────────────────────────────────
fs.mkdirSync(IMPORT_DIR, { recursive: true });

function cleanupOldImports() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  try {
    for (const entry of fs.readdirSync(IMPORT_DIR)) {
      const dir = path.join(IMPORT_DIR, entry);
      try {
        const stat = fs.statSync(dir);
        if (stat.isDirectory() && stat.mtimeMs < cutoff) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (_) {}
    }
  } catch (_) {}
}
setInterval(cleanupOldImports, 24 * 60 * 60 * 1000);
cleanupOldImports();

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(IMPORT_DIR, req.params.id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, 'source.csv')
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(csv|txt)$/i.test(file.originalname)) {
      const err = new Error('Only CSV files are accepted');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

// ── GET /schemas ──────────────────────────────────────────────────────────────
router.get('/schemas', (req, res) => res.json(ENTITY_SCHEMAS));

// ── POST /jobs ────────────────────────────────────────────────────────────────
router.post('/jobs', async (req, res) => {
  const { source_kind = 'csv', target_entity } = req.body;
  try {
    const { rows } = await getPool().query(
      `INSERT INTO import_jobs (source_kind, target_entity, uploaded_by)
       VALUES ($1,$2,$3) RETURNING id`,
      [source_kind, target_entity || null, req.user.id]);
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /jobs/:id/upload ─────────────────────────────────────────────────────
router.post('/jobs/:id/upload', (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File exceeds 50 MB limit' });
      return res.status(err.status || 400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    try {
      await getPool().query(
        `UPDATE import_jobs
         SET file_path=$1, status='uploaded', uploaded_at=NOW(), updated_at=NOW()
         WHERE id=$2`,
        [req.file.path, req.params.id]);
      res.json({ ok: true, size: req.file.size, name: req.file.originalname });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// ── GET /jobs/:id/preview ─────────────────────────────────────────────────────
router.get('/jobs/:id/preview', async (req, res) => {
  const { encoding = 'utf-8' } = req.query;
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (!job.file_path || !fs.existsSync(job.file_path)) {
      return res.status(400).json({ error: 'No file uploaded yet' });
    }
    const text = readCSVFile(job.file_path, encoding);
    const all = parseCSV(text);
    if (all.length < 1) return res.status(400).json({ error: 'CSV appears empty' });
    const headers = all[0].map(h => h.trim());
    const preview = all.slice(1, 21);
    res.json({ headers, preview, total_rows: Math.max(0, all.length - 1) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /jobs/:id/mapping ────────────────────────────────────────────────────
router.post('/jobs/:id/mapping', async (req, res) => {
  const { mapping, target_entity } = req.body;
  if (!mapping) return res.status(400).json({ error: 'mapping required' });
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT id FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const setEntity = target_entity ? ', target_entity=$3' : '';
    const params = target_entity
      ? [JSON.stringify(mapping), req.params.id, target_entity]
      : [JSON.stringify(mapping), req.params.id];
    await db.query(
      `UPDATE import_jobs SET mapping_json=$1, status='mapped', updated_at=NOW()${setEntity} WHERE id=$2`,
      params);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /jobs/:id/validate ───────────────────────────────────────────────────
router.post('/jobs/:id/validate', async (req, res) => {
  const { encoding = 'utf-8' } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (!job.file_path || !fs.existsSync(job.file_path)) return res.status(400).json({ error: 'No file uploaded' });
    if (!job.mapping_json) return res.status(400).json({ error: 'No mapping saved' });
    const schema = ENTITY_SCHEMAS[job.target_entity];
    if (!schema) return res.status(400).json({ error: `Unknown entity: ${job.target_entity}` });

    const text = readCSVFile(job.file_path, encoding);
    const all = parseCSV(text);
    const headers = all[0].map(h => h.trim());
    const dataRows = all.slice(1);

    const errors = [];
    for (let i = 0; i < dataRows.length; i++) {
      const row = applyMapping(dataRows[i], headers, job.mapping_json);
      errors.push(...validateRow(row, schema, i + 2));
    }

    const valid = errors.length === 0;
    await db.query(
      `UPDATE import_jobs SET status=$1, row_count_total=$2, error_log_json=$3, updated_at=NOW() WHERE id=$4`,
      [valid ? 'validated' : 'preview', dataRows.length, JSON.stringify({ errors }), job.id]);
    res.json({ valid, errors, total: dataRows.length, error_count: errors.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /jobs/:id/dry-run ────────────────────────────────────────────────────
router.post('/jobs/:id/dry-run', async (req, res) => {
  const { encoding = 'utf-8' } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (!job.file_path || !fs.existsSync(job.file_path)) return res.status(400).json({ error: 'No file uploaded' });
    if (!job.mapping_json) return res.status(400).json({ error: 'No mapping saved' });

    const text = readCSVFile(job.file_path, encoding);
    const all = parseCSV(text);
    const headers = all[0].map(h => h.trim());
    const dataRows = all.slice(1);

    const client = await db.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await runImport(client, job, dataRows, headers);
      await client.query('ROLLBACK'); // always rollback — this is a dry run
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally {
      client.release();
    }

    await db.query(
      `UPDATE import_jobs SET row_count_total=$1, updated_at=NOW() WHERE id=$2`,
      [dataRows.length, job.id]);
    res.json({ dry_run: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /jobs/:id/commit ─────────────────────────────────────────────────────
router.post('/jobs/:id/commit', async (req, res) => {
  const { encoding = 'utf-8' } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.status === 'committed') {
      return res.status(409).json({ error: 'Already committed — start a new import to import again' });
    }
    if (!job.file_path || !fs.existsSync(job.file_path)) return res.status(400).json({ error: 'No file uploaded' });
    if (!job.mapping_json) return res.status(400).json({ error: 'No mapping saved' });

    const text = readCSVFile(job.file_path, encoding);
    const all = parseCSV(text);
    const headers = all[0].map(h => h.trim());
    const dataRows = all.slice(1);

    const client = await db.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await runImport(client, job, dataRows, headers);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      await db.query(
        `UPDATE import_jobs SET status='failed', updated_at=NOW() WHERE id=$1`, [job.id]);
      throw err;
    } finally {
      client.release();
    }

    const imported = result.created + result.updated;
    await db.query(
      `UPDATE import_jobs
       SET status='committed', row_count_imported=$1, error_log_json=$2, updated_at=NOW()
       WHERE id=$3`,
      [imported, JSON.stringify({ errors: result.errors }), job.id]);

    recordAudit({
      req, action: 'import', entity_type: job.target_entity, entity_id: job.id,
      meta: { source_kind: job.source_kind, created: result.created,
              updated: result.updated, skipped: result.skipped, total: result.total }
    });

    res.json({ committed: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /jobs/:id/errors.csv ──────────────────────────────────────────────────
router.get('/jobs/:id/errors.csv', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT error_log_json FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const errors = rows[0].error_log_json?.errors || [];
    const esc = s => String(s||'').replace(/"/g, '""');
    const csv = [
      'Row,Field,Error,Value',
      ...errors.map(e => `${e.row},"${esc(e.field)}","${esc(e.error)}","${esc(e.value)}"`)
    ].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="import-errors-${req.params.id}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /templates ────────────────────────────────────────────────────────────
router.get('/templates', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM import_templates ORDER BY is_builtin DESC, created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /templates ───────────────────────────────────────────────────────────
router.post('/templates', async (req, res) => {
  const { name, source_kind = 'csv', target_entity, mapping } = req.body;
  if (!name || !mapping) return res.status(400).json({ error: 'name and mapping required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO import_templates (name, source_kind, target_entity, mapping_json, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [name, source_kind, target_entity||null, JSON.stringify(mapping), req.user.id]);
    res.json({ id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Tapestry & BrightHR importers ────────────────────────────────────────────
const { importBundle: tapestryImportBundle, previewBundle, TEMPLATE: TAPESTRY_TEMPLATE, summarise: tapSummarise } = require('../lib/importers/tapestry');
const { importEmployees, importAbsences, TEMPLATE: BRIGHTHR_TEMPLATE, parseCSVtoObjects } = require('../lib/importers/brighthr');
const fs2 = require('fs');

// Multer for ZIP uploads
const zipStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(IMPORT_DIR, req.params.id);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, 'bundle.zip'),
});
const uploadZip = multer({
  storage: zipStorage,
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(zip)$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('Only ZIP files accepted'), { status: 400 }));
    }
    cb(null, true);
  }
});

// Multer for BrightHR CSVs (stores to a named sub-path)
function makeBrightHRUpload(filename) {
  return multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        const dir = path.join(IMPORT_DIR, req.params.id);
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
        cb(null, dir);
      },
      filename: (req, file, cb) => cb(null, filename),
    }),
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      if (!/\.(csv|txt)$/i.test(file.originalname)) {
        return cb(Object.assign(new Error('Only CSV files accepted'), { status: 400 }));
      }
      cb(null, true);
    },
  });
}

// ── Template seeding (runs once on startup) ───────────────────────────────────
async function seedBuiltinTemplates() {
  const db = getPool();
  const templates = [TAPESTRY_TEMPLATE, BRIGHTHR_TEMPLATE];
  for (const tpl of templates) {
    try {
      await db.query(
        `INSERT INTO import_templates (name, source_kind, target_entity, mapping_json, version, is_builtin)
         VALUES ($1,$2,$3,$4,$5,true)
         ON CONFLICT DO NOTHING`,
        [tpl.name, tpl.source_kind, tpl.target_entity, JSON.stringify(tpl.mapping), tpl.version]);
    } catch (err) {
      // ON CONFLICT DO NOTHING can still throw if unique index is on name — ignore
      if (!err.message.includes('duplicate')) {
        console.error('[import-wizard] template seed error:', err.message);
      }
    }
  }
}
// Seed after schema init has had time to run
setTimeout(seedBuiltinTemplates, 3000);

// ════════════════════════════════════════════════════════════════════════════════
// TAPESTRY BUNDLE ROUTES
// ════════════════════════════════════════════════════════════════════════════════

// POST /tapestry/jobs — create a new Tapestry import job
router.post('/tapestry/jobs', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO import_jobs (source_kind, target_entity, uploaded_by)
       VALUES ('tapestry','bundle',$1) RETURNING id`,
      [req.user.id]);
    res.json({ id: rows[0].id, source: 'tapestry' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /tapestry/:id/upload — upload ZIP bundle
router.post('/tapestry/:id/upload', (req, res) => {
  uploadZip.single('file')(req, res, async (err) => {
    if (err) return res.status(err.status || 400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    try {
      await getPool().query(
        `UPDATE import_jobs SET file_path=$1, status='uploaded', uploaded_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [req.file.path, req.params.id]);
      res.json({ ok: true, size: req.file.size });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// GET /tapestry/:id/preview — extract ZIP, return counts
router.get('/tapestry/:id/preview', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (!job.file_path || !fs.existsSync(job.file_path)) {
      return res.status(400).json({ error: 'No file uploaded yet' });
    }
    const buf = fs.readFileSync(job.file_path);
    const preview = previewBundle(buf);
    res.json(preview);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /tapestry/:id/dry-run
router.post('/tapestry/:id/dry-run', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (!job.file_path || !fs.existsSync(job.file_path)) return res.status(400).json({ error: 'No file uploaded' });

    const buf   = fs.readFileSync(job.file_path);
    const AdmZip = require('adm-zip');
    const { extractZip } = require('../lib/importers/tapestry');
    const files = extractZip(buf);

    const client = await db.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await tapestryImportBundle(client, files);
      await client.query('ROLLBACK');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally { client.release(); }

    res.json({ dry_run: true, ...tapSummarise(result), detail: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /tapestry/:id/commit
router.post('/tapestry/:id/commit', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.status === 'committed') return res.status(409).json({ error: 'Already committed' });
    if (!job.file_path || !fs.existsSync(job.file_path)) return res.status(400).json({ error: 'No file uploaded' });

    const buf   = fs.readFileSync(job.file_path);
    const { extractZip } = require('../lib/importers/tapestry');
    const files = extractZip(buf);

    const client = await db.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await tapestryImportBundle(client, files);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      await db.query(`UPDATE import_jobs SET status='failed', updated_at=NOW() WHERE id=$1`, [job.id]);
      throw err;
    } finally { client.release(); }

    const summary = tapSummarise(result);
    await db.query(
      `UPDATE import_jobs SET status='committed', row_count_imported=$1, error_log_json=$2, updated_at=NOW() WHERE id=$3`,
      [summary.imported, JSON.stringify({ errors: summary.errors }), job.id]);

    recordAudit({ req, action: 'import', entity_type: 'tapestry_bundle', entity_id: job.id,
      meta: { ...summary, entities: result } });

    res.json({ committed: true, ...summary, detail: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// BRIGHTHR BUNDLE ROUTES
// ════════════════════════════════════════════════════════════════════════════════

// GET /brighthr/export — MUST be before /:id routes to avoid param capture
router.get('/brighthr/export', async (req, res) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user?.role)) return res.status(403).json({ error: 'Managers only' });
  try {
    const { rows } = await getPool().query(
      `SELECT first_name, last_name, role, email, phone, employment_type, contracted_hours,
              TO_CHAR(contract_start, 'YYYY-MM-DD') AS contract_start
       FROM staff WHERE is_active=true AND id != 1
       ORDER BY last_name, first_name`);
    const headers = ['First Name','Last Name','Job Title','Email','Phone','Employment Type','Contracted Hours','Start Date'];
    const csvRows = rows.map(r =>
      [r.first_name, r.last_name, r.role, r.email || '',
       r.phone || '', r.employment_type || '', r.contracted_hours || '', r.contract_start || '']
        .map(v => `"${String(v ?? '').replace(/"/g, '""')}"`)
        .join(',')
    );
    const csv = [headers.join(','), ...csvRows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="brighthr-staff-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /brighthr/jobs
router.post('/brighthr/jobs', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO import_jobs (source_kind, target_entity, uploaded_by)
       VALUES ('brighthr','bundle',$1) RETURNING id`,
      [req.user.id]);
    res.json({ id: rows[0].id, source: 'brighthr' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /brighthr/:id/upload/employees
router.post('/brighthr/:id/upload/employees', (req, res) => {
  makeBrightHRUpload('employees.csv').single('file')(req, res, async (err) => {
    if (err) return res.status(err.status || 400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    try {
      await getPool().query(
        `UPDATE import_jobs SET file_path=$1, status='uploaded', uploaded_at=NOW(), updated_at=NOW() WHERE id=$2`,
        [req.file.path, req.params.id]);
      res.json({ ok: true, file: 'employees.csv', size: req.file.size });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// POST /brighthr/:id/upload/absences
router.post('/brighthr/:id/upload/absences', (req, res) => {
  makeBrightHRUpload('absences.csv').single('file')(req, res, async (err) => {
    if (err) return res.status(err.status || 400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    try {
      const dir = path.join(IMPORT_DIR, req.params.id);
      // Store separately alongside employees.csv
      await getPool().query(
        `UPDATE import_jobs SET mapping_json=jsonb_set(COALESCE(mapping_json,'{}'),'{"absences_uploaded"}','"true"'), updated_at=NOW() WHERE id=$1`,
        [req.params.id]);
      res.json({ ok: true, file: 'absences.csv', size: req.file.size });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// GET /brighthr/:id/preview
router.get('/brighthr/:id/preview', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const dir = path.join(IMPORT_DIR, job.id);
    const empPath = path.join(dir, 'employees.csv');
    const absPath = path.join(dir, 'absences.csv');
    const preview = {};
    if (fs.existsSync(empPath)) {
      const rows2 = parseCSVtoObjects(fs.readFileSync(empPath, 'utf8'));
      preview.employees = { count: rows2.length, sample: rows2.slice(0, 3) };
    }
    if (fs.existsSync(absPath)) {
      const rows2 = parseCSVtoObjects(fs.readFileSync(absPath, 'utf8'));
      preview.absences = { count: rows2.length };
    }
    res.json({ source: 'brighthr', ...preview });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /brighthr/:id/dry-run
router.post('/brighthr/:id/dry-run', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    const dir = path.join(IMPORT_DIR, job.id);
    const empPath = path.join(dir, 'employees.csv');
    if (!fs.existsSync(empPath)) return res.status(400).json({ error: 'employees.csv not uploaded' });

    const empRows = parseCSVtoObjects(fs.readFileSync(empPath, 'utf8'));
    const absPath = path.join(dir, 'absences.csv');
    const absRows = fs.existsSync(absPath) ? parseCSVtoObjects(fs.readFileSync(absPath, 'utf8')) : [];

    const client = await db.connect();
    let empResult, absResult;
    try {
      await client.query('BEGIN');
      empResult = await importEmployees(client, empRows);
      absResult = await importAbsences(client, absRows);
      await client.query('ROLLBACK');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally { client.release(); }

    res.json({ dry_run: true, employees: empResult, absences: absResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /brighthr/:id/commit
router.post('/brighthr/:id/commit', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    if (job.status === 'committed') return res.status(409).json({ error: 'Already committed' });
    const dir = path.join(IMPORT_DIR, job.id);
    const empPath = path.join(dir, 'employees.csv');
    if (!fs.existsSync(empPath)) return res.status(400).json({ error: 'employees.csv not uploaded' });

    const empRows = parseCSVtoObjects(fs.readFileSync(empPath, 'utf8'));
    const absPath = path.join(dir, 'absences.csv');
    const absRows = fs.existsSync(absPath) ? parseCSVtoObjects(fs.readFileSync(absPath, 'utf8')) : [];

    const client = await db.connect();
    let empResult, absResult;
    try {
      await client.query('BEGIN');
      empResult = await importEmployees(client, empRows);
      absResult = await importAbsences(client, absRows);
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      await db.query(`UPDATE import_jobs SET status='failed', updated_at=NOW() WHERE id=$1`, [job.id]);
      throw err;
    } finally { client.release(); }

    const imported = (empResult.created + empResult.updated) + absResult.created;
    await db.query(
      `UPDATE import_jobs SET status='committed', row_count_imported=$1, row_count_total=$2, error_log_json=$3, updated_at=NOW() WHERE id=$4`,
      [imported, empRows.length + absRows.length,
       JSON.stringify({ employees: empResult.errors, absences: absResult.errors }), job.id]);

    recordAudit({ req, action: 'import', entity_type: 'brighthr_bundle', entity_id: job.id,
      meta: { employees: empResult, absences: absResult } });

    res.json({ committed: true, employees: empResult, absences: absResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /brighthr/export — download staff as CSV
router.get('/brighthr/export', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT first_name, last_name, role, email, phone, employment_type, is_active
       FROM staff
       ORDER BY last_name, first_name`);

    const header = 'first_name,last_name,role,email,phone,employment_type,is_active';
    const csvRows = rows.map(r =>
      [r.first_name, r.last_name, r.role, r.email,
       r.phone || '', r.employment_type || '', r.is_active]
        .map(v => `"${String(v).replace(/"/g, '""')}"`)
        .join(',')
    );
    const csv = [header, ...csvRows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="brighthr_staff_export.csv"');
    res.setHeader('Content-Length', Buffer.byteLength(csv));
    res.send(csv);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
