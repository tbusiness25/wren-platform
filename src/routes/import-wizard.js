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
// b315 — the ONE room writer. An import that changes a child's room is a room
// move like any other, and must not have its own implementation of one.
const childRoom = require('../lib/child-room');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const IMPORT_DIR = '/app/uploads/imports';

// ── Auth ──────────────────────────────────────────────────────────────────────
router.use(authenticate);

const managerOnly = (req, res, next) => {
  // Include school leadership roles so headteachers / business managers can run
  // imports on school editions (their instances have no 'manager'/'admin' role).
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'])) {
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
  // b118 — EyLog migration wizard columns (schema-local, same import_jobs table)
  await db.query(`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS eylog_source VARCHAR(16)`);
  await db.query(`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS preview_json JSONB`);
  await db.query(`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS report_path TEXT`);
  await db.query(`ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS log_path TEXT`);
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
  },
  contacts: {
    label: 'Contacts',
    description: 'Import enquiry / waiting-list contacts (not yet enrolled children)',
    fields: [
      { key: 'full_name',      label: 'Full Name',   required: true,  type: 'string' },
      { key: 'primary_email',  label: 'Email',       required: false, type: 'email' },
      { key: 'primary_phone',  label: 'Phone',       required: false, type: 'string' },
      { key: 'status',         label: 'Status',      required: false, type: 'enum',
        values: ['enquirer','waiting_list','enrolled','leaver'] },
      { key: 'notes',          label: 'Notes',       required: false, type: 'string' },
    ]
  }
};

// Dedupe key documented per entity — surfaced in the reconciliation report (b119: be
// explicit about the key used, per the ground-truth spec).
const DEDUPE_KEY_DESC = {
  children:     'first_name + last_name + date_of_birth (exact match, case-insensitive)',
  staff:        'email (case-insensitive); falls back to first_name+last_name when no email column — id=1 (Nursery Manager) is always excluded',
  contacts:     'primary_email (case-insensitive) when provided, else full_name (case-insensitive)',
  parents:      'matched to an existing child by first_name+last_name (update-only — never creates a child)',
  attendance:   'child (name match) + date + session (existing unique constraint)',
  observations: 'none — a plain CSV carries no stable row id, so every commit inserts new rows; re-importing the same file will duplicate observations',
  funding:      'matched to an existing child by first_name+last_name (update-only)',
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

// ── Date-format detector (surfaced to the user, not just silently guessed) ────
function detectDateFormat(values) {
  let iso = 0, dmy = 0, invalid = 0;
  for (const raw of values) {
    const s = String(raw || '').trim();
    if (!s) continue;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { iso++; continue; }
    const m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (m) { dmy++; continue; } // Wren is UK-only — ambiguous D/M pairs assumed DD/MM/YYYY
    invalid++;
  }
  let detected = 'unknown / no valid dates sampled';
  if (iso > 0 && dmy === 0) detected = 'ISO (YYYY-MM-DD)';
  else if (dmy > 0 && iso === 0) detected = 'DD/MM/YYYY';
  else if (iso > 0 && dmy > 0) detected = `mixed — ${iso} ISO + ${dmy} DD/MM/YYYY seen`;
  return { detected, sampled: values.length, iso_count: iso, dmy_count: dmy, invalid_count: invalid };
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
          // b314/b315 — a CSV that moves an existing child to another room is a
          // room MOVE, and occupancy reads child_bookings.room_id, not
          // children.room_id. Writing only the profile here left the register —
          // and therefore the board, the ratios and the forecast — showing the
          // room the child had left.
          //
          // b315: no second path "just for imports". This is the same
          // setChildRoom() the profile save, the occupancy board and the nightly
          // engine call, so an imported move is recorded in child_room_moves like
          // any other. It is a no-op for a child already in that room, so
          // re-running an import is safe. `client` is this import's transaction.
          if (roomId) {
            try {
              await childRoom.setChildRoom(client, {
                childId: ex[0].id, toRoomId: roomId,
                actorId: req.user && req.user.id, source: 'import',
              });
            } catch (tErr) {
              console.error('[import-wizard] room transfer for child', ex[0].id, tErr.message);
            }
          }
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
        // ABSOLUTE RULE: never touch id=1 (Nursery Manager) — see CLAUDE.md
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

      } else if (entity === 'contacts') {
        const email = (row.primary_email || '').trim().toLowerCase();
        const fullName = (row.full_name || '').trim();
        const { rows: ex } = email
          ? await client.query('SELECT id FROM contacts WHERE lower(primary_email)=lower($1)', [email])
          : await client.query('SELECT id FROM contacts WHERE lower(full_name)=lower($1)', [fullName]);
        if (ex.length) {
          await client.query(
            `UPDATE contacts SET
               full_name=COALESCE(NULLIF($1,''),full_name),
               primary_phone=COALESCE(NULLIF($2,''),primary_phone),
               notes=COALESCE(NULLIF($3,''),notes),
               status=COALESCE(NULLIF($4,''),status)
             WHERE id=$5`,
            [fullName||null, row.primary_phone||null, row.notes||null,
             row.status ? row.status.toLowerCase() : null, ex[0].id]);
          updated++;
        } else {
          await client.query(
            `INSERT INTO contacts (full_name, primary_email, primary_phone, notes, status)
             VALUES ($1,$2,$3,$4,COALESCE(NULLIF($5,''),'enquirer'))`,
            [fullName, email||null, row.primary_phone||null, row.notes||null,
             row.status ? row.status.toLowerCase() : null]);
          created++;
        }
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
    const mappedRows = [];
    for (let i = 0; i < dataRows.length; i++) {
      const row = applyMapping(dataRows[i], headers, job.mapping_json);
      errors.push(...validateRow(row, schema, i + 2));
      if (i < 5) mappedRows.push(row);
    }

    // Date-format detection per mapped date field — surfaced, not silently guessed.
    const dateFormats = {};
    for (const field of schema.fields.filter(f => f.type === 'date' && job.mapping_json[f.key])) {
      const colIdx = headers.findIndex(h => h.toLowerCase().trim() === String(job.mapping_json[field.key]).toLowerCase().trim());
      const sample = colIdx === -1 ? [] : dataRows.slice(0, 50).map(r => r[colIdx]).filter(Boolean);
      dateFormats[field.key] = detectDateFormat(sample);
    }

    const valid = errors.length === 0;
    await db.query(
      `UPDATE import_jobs SET status=$1, row_count_total=$2, error_log_json=$3, updated_at=NOW() WHERE id=$4`,
      [valid ? 'validated' : 'preview', dataRows.length, JSON.stringify({ errors }), job.id]);
    res.json({
      valid, errors, total: dataRows.length, error_count: errors.length,
      mapped_preview: mappedRows, date_formats: dateFormats,
      dedupe_key: DEDUPE_KEY_DESC[job.target_entity] || null,
    });
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

    const report = buildReport({
      source: `csv:${job.target_entity}`, db: IMPORT_DB, schema: IMPORT_SCHEMA,
      mode: 'dry-run (rolled back — nothing written)', jobId: job.id,
      dedupeKey: DEDUPE_KEY_DESC[job.target_entity] || null,
      sections: [{ name: job.target_entity, sourceCount: dataRows.length,
        created: result.created, updated: result.updated, errors: result.errors }],
    });
    await saveReport(db, job.id, report);

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

    const report = buildReport({
      source: `csv:${job.target_entity}`, db: IMPORT_DB, schema: IMPORT_SCHEMA,
      mode: 'live (committed)', jobId: job.id,
      dedupeKey: DEDUPE_KEY_DESC[job.target_entity] || null,
      sections: [{ name: job.target_entity, sourceCount: dataRows.length,
        created: result.created, updated: result.updated, errors: result.errors }],
    });
    await saveReport(db, job.id, report);

    res.json({ committed: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /jobs/:id/report — JSON { content } ───────────────────────────────────
router.get('/jobs/:id/report', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT report_path FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length || !rows[0].report_path || !fs.existsSync(rows[0].report_path)) {
      return res.status(404).json({ error: 'No report available yet' });
    }
    res.json({ content: fs.readFileSync(rows[0].report_path, 'utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /jobs/:id/report.md — raw download ────────────────────────────────────
router.get('/jobs/:id/report.md', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT report_path FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length || !rows[0].report_path || !fs.existsSync(rows[0].report_path)) {
      return res.status(404).json({ error: 'No report available yet' });
    }
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="csv-import-${req.params.id}.md"`);
    res.send(fs.readFileSync(rows[0].report_path, 'utf8'));
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
const { buildReport } = require('../lib/importers/report');
const fs2 = require('fs');

// Schema is NEVER hard-coded — always this instance's own PG_SCHEMA (same rule the
// b118 EyLog wizard follows). Previously these two importers were called with no
// schema argument at all, so they silently fell back to the literal string 'ladn'
// regardless of what schema this container actually runs on — harmless on LADN's own
// dev/prod (both really are named 'ladn'), but wrong on any other instance.
const IMPORT_SCHEMA = process.env.PG_SCHEMA || 'ladn';
const IMPORT_DB = process.env.PG_DB || 'wren';

function bundleReportsDir(jobId) {
  const dir = path.join(IMPORT_DIR, jobId, 'reports');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function saveReport(db, jobId, markdown) {
  const dir = bundleReportsDir(jobId);
  const reportPath = path.join(dir, 'report.md');
  fs.writeFileSync(reportPath, markdown, 'utf8');
  await db.query(`UPDATE import_jobs SET report_path=$1, updated_at=NOW() WHERE id=$2`, [reportPath, jobId]);
  return reportPath;
}

function tapestryReportArgs({ files, result, mode, jobId }) {
  return {
    source: 'tapestry', db: IMPORT_DB, schema: IMPORT_SCHEMA, mode, jobId,
    sections: [
      { name: 'children', dedupeKey: 'first_name + last_name + date_of_birth (exact, case-insensitive)',
        sourceCount: files.children.length, created: result.children.created,
        updated: result.children.updated, errors: result.children.errors },
      { name: 'parents (contact update only, never creates a child)', dedupeKey: 'child first_name + last_name (must already exist)',
        sourceCount: files.parents.length, created: 0, updated: result.parents.updated, errors: result.parents.errors },
      { name: 'observations', dedupeKey: 'source_ref = sha1(child_id + date + title + body prefix) — Tapestry rows carry no stable id, so an edited-then-re-exported row is treated as new, not an update (documented limitation)',
        sourceCount: files.observations.length, created: result.observations.created,
        duplicate: result.observations.duplicate, errors: result.observations.errors },
      { name: 'attendance', dedupeKey: 'child_id + date + session (existing unique constraint — real update on conflict)',
        sourceCount: files.attendance.length, created: result.attendance.created,
        updated: result.attendance.updated, errors: result.attendance.errors },
    ],
  };
}

function brighthrReportArgs({ empRows, absRows, empResult, absResult, mode, jobId }) {
  return {
    source: 'brighthr', db: IMPORT_DB, schema: IMPORT_SCHEMA, mode, jobId,
    sections: [
      { name: 'employees', dedupeKey: 'email (case-insensitive) — falls back to first_name+last_name when no email column; id=1 (Nursery Manager) is always excluded',
        sourceCount: empRows.length, created: empResult.created, updated: empResult.updated, errors: empResult.errors },
      { name: 'absences', dedupeKey: 'external_ref (same column + unique index the live BrightHR API sync already uses) = "bhr-abs:<Absence ID>" when the export has that column, else "bhr-abs-csv:" + sha1(staff_id + start_date + end_date + type + duration)',
        sourceCount: absRows.length, created: absResult.created, duplicate: absResult.duplicate, errors: absResult.errors },
    ],
  };
}

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
      result = await tapestryImportBundle(client, files, IMPORT_SCHEMA);
      await client.query('ROLLBACK');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally { client.release(); }

    const summary = tapSummarise(result);
    const report = buildReport(tapestryReportArgs({
      files, result, jobId: job.id, mode: 'dry-run (rolled back — nothing written)' }));
    await saveReport(db, job.id, report);

    res.json({ dry_run: true, ...summary, detail: result });
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
      result = await tapestryImportBundle(client, files, IMPORT_SCHEMA);
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

    const report = buildReport(tapestryReportArgs({
      files, result, jobId: job.id, mode: 'live (committed)' }));
    await saveReport(db, job.id, report);

    recordAudit({ req, action: 'import', entity_type: 'tapestry_bundle', entity_id: job.id,
      meta: { ...summary, entities: result } });

    res.json({ committed: true, ...summary, detail: result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /tapestry/:id/report — JSON { content }
router.get('/tapestry/:id/report', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT report_path FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length || !rows[0].report_path || !fs.existsSync(rows[0].report_path)) {
      return res.status(404).json({ error: 'No report available yet' });
    }
    res.json({ content: fs.readFileSync(rows[0].report_path, 'utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /tapestry/:id/report.md — raw download
router.get('/tapestry/:id/report.md', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT report_path FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length || !rows[0].report_path || !fs.existsSync(rows[0].report_path)) {
      return res.status(404).json({ error: 'No report available yet' });
    }
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="tapestry-import-${req.params.id}.md"`);
    res.send(fs.readFileSync(rows[0].report_path, 'utf8'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════════════════════
// BRIGHTHR BUNDLE ROUTES
// ════════════════════════════════════════════════════════════════════════════════

// GET /brighthr/export — MUST be before /:id routes to avoid param capture
router.get('/brighthr/export', async (req, res) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) return res.status(403).json({ error: 'Managers only' });
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
      empResult = await importEmployees(client, empRows, IMPORT_SCHEMA);
      absResult = await importAbsences(client, absRows, IMPORT_SCHEMA);
      await client.query('ROLLBACK');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (_) {}
      throw err;
    } finally { client.release(); }

    const report = buildReport(brighthrReportArgs({
      empRows, absRows, empResult, absResult, jobId: job.id,
      mode: 'dry-run (rolled back — nothing written)' }));
    await saveReport(db, job.id, report);

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
      empResult = await importEmployees(client, empRows, IMPORT_SCHEMA);
      absResult = await importAbsences(client, absRows, IMPORT_SCHEMA);
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

    const report = buildReport(brighthrReportArgs({
      empRows, absRows, empResult, absResult, jobId: job.id, mode: 'live (committed)' }));
    await saveReport(db, job.id, report);

    recordAudit({ req, action: 'import', entity_type: 'brighthr_bundle', entity_id: job.id,
      meta: { employees: empResult, absences: absResult } });

    res.json({ committed: true, employees: empResult, absences: absResult });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /brighthr/:id/report — JSON { content }
router.get('/brighthr/:id/report', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT report_path FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length || !rows[0].report_path || !fs.existsSync(rows[0].report_path)) {
      return res.status(404).json({ error: 'No report available yet' });
    }
    res.json({ content: fs.readFileSync(rows[0].report_path, 'utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /brighthr/:id/report.md — raw download
router.get('/brighthr/:id/report.md', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT report_path FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length || !rows[0].report_path || !fs.existsSync(rows[0].report_path)) {
      return res.status(404).json({ error: 'No report available yet' });
    }
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="brighthr-import-${req.params.id}.md"`);
    res.send(fs.readFileSync(rows[0].report_path, 'utf8'));
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

// ════════════════════════════════════════════════════════════════════════════════
// EYLOG MIGRATION WIZARD (b118 — on top of b117's run-import.py)
// ════════════════════════════════════════════════════════════════════════════════
// Schema is NEVER read from the client — always this instance's own PG_SCHEMA (fixed
// at container level). That's what makes "never target ladn from a demo/other
// instance" structurally true: whatever schema this container is, that's the only
// schema this wizard can ever write to. run-import.py itself also refuses --schema
// ladn unconditionally (belt & braces — the guard below just avoids a wasted spawn
// and gives a friendlier message).
const { spawn } = require('child_process');
const AdmZip2 = require('adm-zip');
const EYLOG_SCRIPT = path.join(__dirname, '../../scripts/eylog-import/run-import.py');
const EYLOG_SCHEMA = process.env.PG_SCHEMA || 'ladn';
const EYLOG_DB = process.env.PG_DB || 'wren_dev';
// creds live in memory ONLY for the lifetime of a job — never DB, never logged.
const eylogCreds = new Map();   // jobId -> { serial, password, base, pracId, pracPin, at }
const eylogProcs = new Map();   // jobId -> running ChildProcess (real /start runs only)

// ── b214 — entity picker ─────────────────────────────────────────────────────
// A setting mid-year wants children + contacts long before it wants five years of
// observations, so every entity is independently tickable. Each picker entity maps to
// one or more run-import.py sections — the SAME pipeline, not a parallel import path.
const EYLOG_ENTITIES = [
  { key: 'children', label: 'Children', sections: ['children'], default: true,
    fetches: 'Name, date of birth, room, start date, key person, allergies, dietary and medical notes, SEND flags, ethnicity/religion/language.',
    dedupe: 'EyLog child_id → children.eylog_child_id (unique). A re-run updates the same child.',
    writes: 'children (+ rooms auto-created by name)' },
  { key: 'contacts', label: 'Parents & contacts', sections: ['contacts'], default: true,
    requires: 'children',
    fetches: "Each child's parents/guardians — name, email, mobile, relationship.",
    dedupe: "EyLog parent id → contacts.eylog_ref (unique). One parent shared by siblings stays ONE contact.",
    writes: 'contacts (+ blank parent_1/2 fields on children — never overwrites anything typed into Wren)' },
  { key: 'staff', label: 'Staff', sections: ['staff'], default: false,
    fetches: 'Practitioner name, job title, email, phone, start date, active/leaver status.',
    dedupe: 'EyLog practitioner_id → staff.eylog_ref (unique).',
    writes: 'staff — no PIN is ever imported, so nobody can sign in until a manager sets one' },
  { key: 'attendance', label: 'Attendance & bookings', sections: ['attendance', 'bookings'], default: false,
    requires: 'children',
    fetches: 'Daily register (in/out times, absences) and the weekly booking pattern.',
    dedupe: 'attendance.eylog_ref and child_bookings.eylog_ref (both unique) — one booking row per child.',
    writes: 'attendance, child_bookings' },
  { key: 'observations', label: 'Observations & media list', sections: ['observations', 'media-manifest'], default: false,
    requires: 'children',
    fetches: 'Observation text, author, date, EYFS areas and framework-statement links. Media is listed only — photos and videos are NOT downloaded.',
    dedupe: 'EyLog observation id → observations.eylog_ref (unique).',
    writes: 'observations, observation_statements' },
  { key: 'diary', label: 'Daily diary', sections: ['diary'], default: false,
    requires: 'children',
    fetches: 'Nappies, sleeps, meals and bottles from the daily diary.',
    dedupe: 'daily_diary.eylog_ref (unique).',
    writes: 'daily_diary' },
  { key: 'funding', label: 'Funding', sections: ['funding'], default: false,
    requires: 'children',
    fetches: 'Funding eligibility flags (2-year, universal 15h, extended 30h, 1:1) and any 30-hour code.',
    dedupe: 'child + funding term → child_funding.eylog_ref (unique). Needs a funding term covering today, or every child is skipped with that reason.',
    writes: 'child_funding' },
];
const EYLOG_ENTITY_KEYS = EYLOG_ENTITIES.map(e => e.key);
const EYLOG_DEFAULT_ENTITIES = EYLOG_ENTITIES.filter(e => e.default).map(e => e.key);

// Picker keys -> the --sections argument, in run-import.py's own dependency order
// (children first: every other section resolves child_id through children.eylog_child_id).
function eylogSectionsFor(entities) {
  const want = new Set(entities || []);
  const out = [];
  for (const e of EYLOG_ENTITIES) {
    if (want.has(e.key)) out.push(...e.sections);
  }
  return out;
}

function normaliseEntities(input) {
  const list = Array.isArray(input) ? input : [];
  const picked = EYLOG_ENTITY_KEYS.filter(k => list.includes(k));
  return picked;
}

// Selection is stored in mapping_json — the ONLY thing this job ever persists.
// Credentials are deliberately not part of it (see eylogCreds above).
function jobEntities(job) {
  const e = job?.mapping_json?.entities;
  return Array.isArray(e) && e.length ? e : null;
}

// ── b214 — credential hygiene ────────────────────────────────────────────────
// Belt and braces on top of "never persist them": nothing derived from a subprocess's
// output reaches the DB, the report or the browser without the job's own secrets being
// replaced first. run-import.py does not print them; this guarantees it even if a
// future EyLog error message echoes one back.
const EYLOG_CREDS_TTL_MS = 2 * 60 * 60 * 1000;   // forget an abandoned job after 2h

function scrubCreds(jobId, text) {
  let out = String(text == null ? '' : text);
  const c = eylogCreds.get(jobId);
  if (!c) return out;
  for (const secret of [c.password, c.serial, c.pracPin]) {
    if (secret && String(secret).length >= 3) {
      out = out.split(String(secret)).join('«redacted»');
    }
  }
  return out;
}

function forgetEylogCreds(jobId) { eylogCreds.delete(jobId); }

function sweepEylogCreds() {
  const cutoff = Date.now() - EYLOG_CREDS_TTL_MS;
  for (const [id, c] of eylogCreds) {
    if (!c.at || c.at < cutoff) {
      if (!eylogProcs.has(id)) eylogCreds.delete(id);
    }
  }
}
setInterval(sweepEylogCreds, 10 * 60 * 1000).unref?.();

function eylogJobDir(id) {
  const dir = path.join(IMPORT_DIR, id, 'eylog');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function eylogExportDir(id) { return path.join(eylogJobDir(id), 'export'); }
function eylogReportsDir(id) { return path.join(eylogJobDir(id), 'reports'); }

async function assertEylogAllowed(db, excludeId) {
  if (EYLOG_SCHEMA === 'ladn') {
    throw Object.assign(new Error(
      "This instance's schema is 'ladn' (LADN production) — it already has automated " +
      'nightly EyLog sync. This wizard is for onboarding NEW settings only.'), { status: 403 });
  }
  const { rows } = await db.query(
    `SELECT id FROM import_jobs WHERE source_kind='eylog' AND status='running' AND id != $1`,
    [excludeId || '00000000-0000-0000-0000-000000000000']);
  if (rows.length) {
    throw Object.assign(new Error(
      'Another EyLog import is already running for this instance — wait for it to finish.'), { status: 409 });
  }
}

// Extract every *.json entry from a ZIP flat into destDir (drops nested folder paths —
// official exports are sometimes nested; run-import.py matches exact (case-sensitive)
// filenames, e.g. `attendance_register_ALL.json` — case must be preserved on disk.
function extractEylogZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const zip = new AdmZip2(zipPath);
  let count = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const base = entry.entryName.replace(/.*\//, '');
    if (!base.toLowerCase().endsWith('.json')) continue;
    fs.writeFileSync(path.join(destDir, base), entry.getData());
    count++;
  }
  return count;
}

// Writes a transient 0600 creds-env file, runs fn(credsPath), always deletes after.
async function withEylogCredsFile(jobId, fn) {
  const creds = eylogCreds.get(jobId);
  if (!creds) throw Object.assign(new Error('No EyLog credentials set for this job'), { status: 400 });
  const dir = eylogJobDir(jobId);
  const credsPath = path.join(dir, `.creds-${Date.now()}.env`);
  const lines = [
    `EYLOG_SERIAL=${creds.serial}`,
    `EYLOG_PASSWORD=${creds.password}`,
    `EYLOG_BASE=${creds.base}`,
  ];
  if (creds.pracId) lines.push(`EYLOG_PRAC_ID=${creds.pracId}`);
  if (creds.pracPin) lines.push(`EYLOG_PRAC_PIN=${creds.pracPin}`);
  fs.writeFileSync(credsPath, lines.join('\n') + '\n', { mode: 0o600 });
  try {
    return await fn(credsPath);
  } finally {
    try { fs.unlinkSync(credsPath); } catch (_) {}
  }
}

// Spawn run-import.py with no docker-CLI dependency (containers have neither docker
// CLI nor the socket) — override PSQL_EXEC to a plain TCP psql using this container's
// own PG_HOST/PG_PORT/PG_USER/PG_PASSWORD (same creds the Node pool already uses).
function spawnEylogImporter(args, logPath) {
  const env = {
    ...process.env,
    PSQL_EXEC: `psql -h ${process.env.PG_HOST || 'wren-postgres'} -p ${process.env.PG_PORT || '5432'} -U ${process.env.PG_USER || 'wren'}`,
    PGPASSWORD: process.env.PG_PASSWORD,
  };
  const logFd = fs.openSync(logPath, 'a');
  const proc = spawn('python3', [EYLOG_SCRIPT, ...args], { cwd: path.join(__dirname, '../..'), env });
  let output = '';
  proc.stdout.on('data', d => { output += d.toString(); try { fs.writeSync(logFd, d); } catch (_) {} });
  proc.stderr.on('data', d => { output += d.toString(); try { fs.writeSync(logFd, d); } catch (_) {} });
  const done = new Promise(resolve => {
    proc.on('close', (code) => { try { fs.closeSync(logFd); } catch (_) {} resolve({ code, output }); });
  });
  return { proc, done };
}

function numOrNull(v) { return v === '?' ? null : parseInt(v, 10); }

// Parses run-import.py's "=== summary ===" block into structured section rows.
function parseEylogSummary(output) {
  const sections = [];
  let inSummary = false;
  for (const raw of output.split('\n')) {
    if (/^===\s*summary/.test(raw.trim())) { inSummary = true; continue; }
    if (!inSummary) continue;
    const skipMatch = raw.match(/^\s*(\S+)\s+SKIPPED:\s*(.+)$/);
    if (skipMatch) { sections.push({ name: skipMatch[1], error: skipMatch[2] }); continue; }
    const mediaMatch = raw.match(/^\s*media\s+total=(\d+)\s+by_type=(\{.*?\})\s+\(source: (.+?)\)/);
    if (mediaMatch) {
      sections.push({ name: 'media', total: parseInt(mediaMatch[1], 10), byType: mediaMatch[2], source: mediaMatch[3] });
      continue;
    }
    // b214 — "every row that would be skipped, with the reason". run-import.py emits one
    // SKIP line per distinct reason (refs are EyLog ids, never names — no PII on stdout).
    const skipMatch2 = raw.match(/^\s*SKIP\s+(\S+)\s+n=(\d+)\s+refs=(\S*)\s+::\s*(.+)$/);
    if (skipMatch2) {
      const target = sections.find(x => x.name === skipMatch2[1]);
      if (target) {
        (target.skipReasons = target.skipReasons || []).push({
          count: parseInt(skipMatch2[2], 10),
          refs: skipMatch2[3] ? skipMatch2[3].split(',').filter(Boolean) : [],
          reason: skipMatch2[4].trim(),
        });
      }
      continue;
    }
    const noteMatch = raw.match(/^\s*NOTE\s+(\S+)\s+::\s*(.+)$/);
    if (noteMatch) {
      const target = sections.find(x => x.name === noteMatch[1]);
      if (target) (target.notes = target.notes || []).push(noteMatch[2].trim());
      continue;
    }
    const m = raw.match(/^\s*(\w+)\s+source=(\d+|\?)\s+eligible=(\d+|\?)\s+in_target=(\d+|\?)\s+new=(-?\d+|\?)(?:\s+skipped=(\d+))?(?:\s+stmt_links=(\d+))?/);
    if (m) {
      sections.push({
        name: m[1], source: numOrNull(m[2]), eligible: numOrNull(m[3]),
        inTarget: numOrNull(m[4]), new: numOrNull(m[5]),
        skipped: m[6] ? parseInt(m[6], 10) : 0,
        stmtLinks: m[7] ? parseInt(m[7], 10) : undefined,
      });
    }
  }
  return sections;
}

function parseReportPath(output) {
  const m = output.match(/>>\s*reconciliation report:\s*(.+)/);
  return m ? m[1].trim() : null;
}

// ── GET /eylog/info — tells the UI up front whether this instance can run EyLog import
router.get('/eylog/info', (req, res) => {
  res.json({
    schema: EYLOG_SCHEMA,
    allowed: EYLOG_SCHEMA !== 'ladn',
    reason: EYLOG_SCHEMA === 'ladn'
      ? "This is the LADN production instance — it already has automated nightly EyLog sync. This wizard is for onboarding NEW settings only."
      : null,
    // b214
    entities: EYLOG_ENTITIES,
    default_entities: EYLOG_DEFAULT_ENTITIES,
    dry_run_required: true,
  });
});

// ── GET /eylog/entities — the picker catalogue on its own (b214) ─────────────
// One segment, so it can never be captured by the /eylog/:id/... routes below.
router.get('/eylog/entities', (req, res) => {
  res.json({ entities: EYLOG_ENTITIES, default_entities: EYLOG_DEFAULT_ENTITIES });
});

// ── POST /eylog/:id/entities — save what this setting wants to bring across ──
// Stored in mapping_json. This is the only thing the job persists; credentials are
// never part of it.
router.post('/eylog/:id/entities', async (req, res) => {
  const entities = normaliseEntities(req.body?.entities);
  if (!entities.length) {
    return res.status(400).json({
      error: 'Pick at least one thing to import',
      valid: EYLOG_ENTITY_KEYS,
    });
  }
  // Everything except children resolves child_id through children.eylog_child_id, so a
  // child that was never imported means silently-skipped rows. Warn, don't block: a
  // setting topping up observations onto children imported last week is legitimate.
  const needsChildren = EYLOG_ENTITIES
    .filter(e => entities.includes(e.key) && e.requires === 'children')
    .map(e => e.label);
  const warnings = [];
  if (needsChildren.length && !entities.includes('children')) {
    warnings.push(`${needsChildren.join(', ')} link to children by their EyLog id — ` +
      'anything whose child is not already in Wren will be skipped (the dry-run will show how many).');
  }
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT id FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    // Changing the selection invalidates any dry-run already seen — the commit gate
    // below compares the two, so clear the preview rather than leaving a stale pass.
    await db.query(
      `UPDATE import_jobs
       SET mapping_json = COALESCE(mapping_json,'{}'::jsonb) || $1::jsonb,
           preview_json = NULL,
           updated_at = NOW()
       WHERE id=$2`,
      [JSON.stringify({ entities }), req.params.id]);
    res.json({ ok: true, entities, sections: eylogSectionsFor(entities), warnings });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /eylog/:id/creds — forget the login without finishing the job ─────
router.delete('/eylog/:id/creds', async (req, res) => {
  forgetEylogCreds(req.params.id);
  try {
    await getPool().query(
      `UPDATE import_jobs SET eylog_source=NULL, preview_json=NULL, status='draft', updated_at=NOW() WHERE id=$1`,
      [req.params.id]);
  } catch (_) {}
  res.json({ ok: true, forgotten: true });
});

// ── POST /eylog/jobs — create a new EyLog import job
router.post('/eylog/jobs', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `INSERT INTO import_jobs (source_kind, target_entity, uploaded_by, mapping_json)
       VALUES ('eylog','eylog_setting',$1,$2) RETURNING id`,
      [req.user.id, JSON.stringify({ entities: EYLOG_DEFAULT_ENTITIES })]);
    res.json({ id: rows[0].id, schema: EYLOG_SCHEMA, entities: EYLOG_DEFAULT_ENTITIES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /eylog/:id/creds — EyLog login (held in memory only, never DB/log)
router.post('/eylog/:id/creds', async (req, res) => {
  const { serial, password, base, pracId, pracPin } = req.body || {};
  if (!serial || !password || !base) {
    return res.status(400).json({ error: 'serial, password and base URL are required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT id FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    eylogCreds.set(req.params.id, {
      serial, password, base, pracId: pracId || '', pracPin: pracPin || '', at: Date.now(),
    });
    // Credentials are held in this process's memory ONLY. They are not written to
    // import_jobs (or any other table), and changing them clears any dry-run already
    // recorded — a preview taken against a different login must not unlock a commit.
    await db.query(
      `UPDATE import_jobs SET eylog_source='api', status='creds_set', preview_json=NULL, updated_at=NOW() WHERE id=$1`,
      [req.params.id]);
    res.json({ ok: true, held: 'in memory for this job only', expires_in_minutes: EYLOG_CREDS_TTL_MS / 60000 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Multer for the official EyLog export ZIP (can be large; limit on this route only)
const uploadEylogZip = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, eylogJobDir(req.params.id)),
    filename: (req, file, cb) => cb(null, 'export-upload.zip'),
  }),
  limits: { fileSize: 300 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!/\.(zip)$/i.test(file.originalname)) {
      return cb(Object.assign(new Error('Only ZIP files accepted'), { status: 400 }));
    }
    cb(null, true);
  },
});

// ── POST /eylog/:id/upload — official EyLog export (ZIP of JSON files)
router.post('/eylog/:id/upload', (req, res) => {
  uploadEylogZip.single('file')(req, res, async (err) => {
    if (err) return res.status(err.status || 400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    try {
      const n = extractEylogZip(req.file.path, eylogExportDir(req.params.id));
      if (!n) return res.status(400).json({ error: 'No recognisable EyLog JSON files found in the ZIP' });
      await getPool().query(
        `UPDATE import_jobs SET eylog_source='export', status='export_set', preview_json=NULL, updated_at=NOW() WHERE id=$1`,
        [req.params.id]);
      res.json({ ok: true, files_found: n });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
});

// ── GET /eylog/:id/preview — dry-run: shows would-import counts, writes 0 rows
router.get('/eylog/:id/preview', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    await assertEylogAllowed(db, job.id);

    // b214 — import only what the setting ticked. No selection saved yet => the
    // defaults (children + their parents), which is what a mid-year setting wants first.
    const entities = jobEntities(job) || EYLOG_DEFAULT_ENTITIES;
    const sectionArg = eylogSectionsFor(entities).join(',');
    if (!sectionArg) return res.status(400).json({ error: 'Pick at least one thing to import' });

    const logPath = path.join(eylogJobDir(job.id), 'preview.log');
    const reportDir = eylogReportsDir(job.id);
    await db.query(`UPDATE import_jobs SET status='previewing', updated_at=NOW() WHERE id=$1`, [job.id]);

    const runDry = async (extraArgs) => {
      const { done } = spawnEylogImporter([
        '--schema', EYLOG_SCHEMA, '--db', EYLOG_DB, ...extraArgs,
        '--sections', sectionArg,
        '--log-dir', reportDir, '--dry-run',
      ], logPath);
      return done;
    };

    let result;
    if (job.eylog_source === 'export') {
      if (!fs.existsSync(eylogExportDir(job.id))) return res.status(400).json({ error: 'No export uploaded yet' });
      result = await runDry(['--export-dir', eylogExportDir(job.id)]);
    } else if (job.eylog_source === 'api') {
      result = await withEylogCredsFile(job.id, (credsPath) => runDry(['--creds-env', credsPath]));
    } else {
      return res.status(400).json({ error: 'Choose EyLog credentials or upload an export first' });
    }

    const output = scrubCreds(job.id, result.output);
    const sections = parseEylogSummary(output);
    const reportPath = parseReportPath(output);
    const status = result.code === 0 ? 'previewed' : 'preview_failed';
    // The commit gate reads dry_run_ok + entities back out of here: a dry-run only
    // unlocks the exact selection it was run for.
    const previewJson = {
      sections,
      entities,
      sections_run: sectionArg,
      dry_run_ok: result.code === 0,
      previewed_at: new Date().toISOString(),
      output_tail: output.slice(-6000),
    };
    await db.query(
      `UPDATE import_jobs SET status=$1, preview_json=$2, log_path=$3, report_path=$4, updated_at=NOW() WHERE id=$5`,
      [status, JSON.stringify(previewJson), logPath, reportPath, job.id]);

    if (result.code !== 0) {
      return res.status(422).json({ error: 'Preview failed — see log', sections, entities,
        output_tail: output.slice(-4000) });
    }
    res.json({ dry_run: true, sections, entities, output_tail: output.slice(-4000) });
  } catch (e) { res.status(e.status || 500).json({ error: scrubCreds(req.params.id, e.message) }); }
});

// ── POST /eylog/:id/start — real import, runs in the background; poll /status
router.post('/eylog/:id/start', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];
    await assertEylogAllowed(db, job.id);
    if (job.eylog_source !== 'export' && job.eylog_source !== 'api') {
      return res.status(400).json({ error: 'Choose EyLog credentials or upload an export first' });
    }
    if (job.eylog_source === 'export' && !fs.existsSync(eylogExportDir(job.id))) {
      return res.status(400).json({ error: 'No export uploaded yet' });
    }

    // ── b214 — DRY-RUN IS MANDATORY ─────────────────────────────────────────
    // Nobody commits somebody else's children's records without having seen what
    // would land. The gate is the preview's own record of itself: it must have
    // succeeded, and it must have been run for exactly the selection about to commit.
    const entities = jobEntities(job) || EYLOG_DEFAULT_ENTITIES;
    const sectionArg = eylogSectionsFor(entities).join(',');
    if (!sectionArg) return res.status(400).json({ error: 'Pick at least one thing to import' });
    const pv = job.preview_json || {};
    if (!pv.dry_run_ok) {
      return res.status(409).json({
        error: 'Run the dry-run first — this import cannot commit until a preview has succeeded.',
        needs_dry_run: true,
      });
    }
    if (pv.sections_run !== sectionArg) {
      return res.status(409).json({
        error: 'What you picked has changed since the dry-run. Re-run the dry-run for this selection before importing.',
        needs_dry_run: true,
        previewed: pv.entities || [],
        selected: entities,
      });
    }

    const logPath = path.join(eylogJobDir(job.id), 'run.log');
    fs.writeFileSync(logPath, ''); // fresh log for this run
    const reportDir = eylogReportsDir(job.id);
    await db.query(`UPDATE import_jobs SET status='running', updated_at=NOW() WHERE id=$1`, [job.id]);

    const finish = async ({ code, output }) => {
      eylogProcs.delete(job.id);
      const clean = scrubCreds(job.id, output);
      const sections = parseEylogSummary(clean);
      const reportPath = parseReportPath(clean);
      const status = code === 0 ? 'committed' : 'failed';
      const imported = sections.filter(s => !s.error).reduce((a, s) => a + (s.new || 0), 0);
      try {
        await db.query(
          `UPDATE import_jobs SET status=$1, preview_json=$2, log_path=$3, report_path=$4,
             row_count_imported=$5, updated_at=NOW() WHERE id=$6`,
          [status, JSON.stringify({ sections, entities, sections_run: sectionArg,
                                    dry_run_ok: true, output_tail: clean.slice(-6000) }),
           logPath, reportPath, imported, job.id]);
      } catch (_) {}
      // The audit row records WHAT was imported and by whom — never the login used.
      recordAudit({ req, action: 'import', entity_type: 'eylog_setting', entity_id: job.id,
        meta: { schema: EYLOG_SCHEMA, source: job.eylog_source, entities, code, sections } });
      // b214: the job is over either way — the login goes out of memory now, not on a timer.
      forgetEylogCreds(job.id);
    };

    if (job.eylog_source === 'export') {
      const { proc, done } = spawnEylogImporter([
        '--schema', EYLOG_SCHEMA, '--db', EYLOG_DB, '--export-dir', eylogExportDir(job.id),
        '--sections', sectionArg, '--log-dir', reportDir,
      ], logPath);
      eylogProcs.set(job.id, proc);
      done.then(finish);
    } else {
      // creds-env file must live for the whole subprocess lifetime; delete only on close.
      const creds = eylogCreds.get(job.id);
      if (!creds) return res.status(400).json({ error: 'No EyLog credentials set for this job — enter them again' });
      creds.at = Date.now();
      const credsPath = path.join(eylogJobDir(job.id), `.creds-${Date.now()}.env`);
      const lines = [`EYLOG_SERIAL=${creds.serial}`, `EYLOG_PASSWORD=${creds.password}`, `EYLOG_BASE=${creds.base}`];
      if (creds.pracId) lines.push(`EYLOG_PRAC_ID=${creds.pracId}`);
      if (creds.pracPin) lines.push(`EYLOG_PRAC_PIN=${creds.pracPin}`);
      fs.writeFileSync(credsPath, lines.join('\n') + '\n', { mode: 0o600 });
      const { proc, done } = spawnEylogImporter([
        '--schema', EYLOG_SCHEMA, '--db', EYLOG_DB, '--creds-env', credsPath,
        '--sections', sectionArg, '--log-dir', reportDir,
      ], logPath);
      eylogProcs.set(job.id, proc);
      done.then(async (result) => {
        try { fs.unlinkSync(credsPath); } catch (_) {}
        // finish() scrubs the output against the creds, so forget them AFTER it runs
        // (finish() calls forgetEylogCreds itself as its last act).
        await finish(result);
      });
    }

    res.json({ started: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── GET /eylog/:id/status — poll: job status + tail of the running log
router.get('/eylog/:id/status', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    let job = rows[0];

    // Recover from a server restart mid-job: no in-memory process + stale log => failed.
    if (job.status === 'running' && !eylogProcs.has(job.id) && job.log_path) {
      try {
        const st = fs.statSync(job.log_path);
        if (Date.now() - st.mtimeMs > 2 * 60 * 1000) {
          await db.query(`UPDATE import_jobs SET status='failed', updated_at=NOW() WHERE id=$1`, [job.id]);
          job = { ...job, status: 'failed' };
        }
      } catch (_) {}
    }

    let logTail = '';
    const logPath = job.log_path || path.join(eylogJobDir(job.id), 'run.log');
    if (fs.existsSync(logPath)) {
      const buf = fs.readFileSync(logPath, 'utf8');
      logTail = scrubCreds(job.id, buf.slice(-4000));
    }

    // b214 — the UI needs to know whether the Run button is unlocked and why not.
    const entities = jobEntities(job) || EYLOG_DEFAULT_ENTITIES;
    const sectionArg = eylogSectionsFor(entities).join(',');
    const pv = job.preview_json || {};
    res.json({
      status: job.status,
      eylog_source: job.eylog_source,
      preview: job.preview_json,
      report_ready: !!job.report_path,
      log_tail: logTail,
      entities,
      creds_held: eylogCreds.has(job.id),
      dry_run_ok: !!pv.dry_run_ok && pv.sections_run === sectionArg,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /eylog/:id/report — render the reconciliation report on screen
router.get('/eylog/:id/report', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT report_path FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const reportPath = rows[0].report_path;
    if (!reportPath || !fs.existsSync(reportPath)) return res.status(400).json({ error: 'Report not ready yet' });
    res.json({ content: fs.readFileSync(reportPath, 'utf8') });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /eylog/:id/report.md — download raw report
router.get('/eylog/:id/report.md', async (req, res) => {
  try {
    const { rows } = await getPool().query('SELECT report_path FROM import_jobs WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Job not found' });
    const reportPath = rows[0].report_path;
    if (!reportPath || !fs.existsSync(reportPath)) return res.status(400).json({ error: 'Report not ready yet' });
    res.setHeader('Content-Type', 'text/markdown');
    res.setHeader('Content-Disposition', `attachment; filename="eylog-import-report-${req.params.id}.md"`);
    res.send(fs.readFileSync(reportPath, 'utf8'));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
