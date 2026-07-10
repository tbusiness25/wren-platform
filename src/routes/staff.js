const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { getPool } = require('../db/pool');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { canViewSalaries, stripSalaryFields } = require('../lib/capabilities');

router.use(authenticate);

// GET / — all active staff
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.preferred_name, s.email, s.phone,
             s.role, s.room_id, s.employment_type, s.contracted_hours, s.is_active,
             s.dbs_expiry, s.contract_start, s.profile_photo,
             s.pin_length, (s.pin_hash IS NOT NULL) AS has_pin,
             r.name as room_name
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.is_active=true
      ORDER BY s.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /rooms — all rooms
router.get('/rooms', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM rooms ORDER BY id');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /work-patterns — must be before /:id to avoid param conflict
router.get('/work-patterns', requireRole('manager', 'deputy_manager'), async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT wp.staff_id, s.first_name, s.last_name, s.hourly_rate, s.qualification,
             s.hours_per_week, s.annual_salary,
             json_agg(json_build_object(
               'dow', wp.day_of_week,
               'start', wp.shift_start,
               'end', wp.shift_end,
               'is_off', wp.is_off,
               'lunch_mins', wp.lunch_break_minutes,
               'room', wp.room
             ) ORDER BY wp.day_of_week) AS patterns
      FROM staff_work_patterns wp
      JOIN staff s ON s.id = wp.staff_id
      WHERE wp.effective_to IS NULL
      GROUP BY wp.staff_id, s.first_name, s.last_name, s.hourly_rate, s.qualification,
               s.hours_per_week, s.annual_salary
      ORDER BY s.first_name
    `);
    // Deputy sees hours/work patterns but NOT pay — strip hourly_rate/annual_salary
    // (PROMPT 35, 2026-06-30). hours_per_week stays visible.
    if (!(await canViewSalaries(req.user))) {
      rows.forEach(stripSalaryFields);
    }
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.*, r.name as room_name
      FROM staff s
      LEFT JOIN rooms r ON r.id = s.room_id
      WHERE s.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const safe = rows[0];
    // pin_hash must NEVER reach the client (offline-crackable; PINs are protected — CLAUDE rule 1)
    delete safe.pin_hash;
    const isSelf = req.user.id === parseInt(req.params.id);
    // Sensitive PII fields: visible only to the staff member themselves or managers/deputies.
    // (NI / DOB / DBS / address / emergency contacts stay visible to deputy — unchanged.)
    if (!isSelf && !['manager','deputy_manager'].includes(req.user.role)) {
      for (const f of ['ni_number','date_of_birth','dbs_number',
                       'address_line1','address_line2','address','postcode',
                       'emergency_contact_name','emergency_contact_phone','emergency_contact',
                       'bank_account_number','bank_sort_code','telegram_chat_id']) {
        delete safe[f];
      }
    }
    // PAY/salary (annual_salary, hourly_rate, tax_code, payroll, pension): manager-only
    // confidential (PROMPT 35, 2026-06-30). Deputy keeps hours/work patterns but NOT pay.
    // Staff always see their own pay.
    if (!isSelf && !(await canViewSalaries(req.user))) {
      stripSalaryFields(safe);
    }
    res.json(safe);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  const canEditOthers = ['manager','deputy_manager'].includes(req.user.role);
  if (!canEditOthers && req.user.id !== parseInt(req.params.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const fields = ['first_name','last_name','preferred_name','email','phone',
    'role','room_id','employment_type','contracted_hours','is_active',
    'address_line1','address_line2','postcode','date_of_birth','ni_number',
    'dbs_number','dbs_expiry','emergency_contact_name','emergency_contact_phone',
    'emergency_contact_relation','notes','contract_start','contract_end'];
  const updates = [];
  const vals = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      vals.push(req.body[f]);
      updates.push(`${f}=$${vals.length}`);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No fields' });
  vals.push(req.params.id);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE staff SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING id,first_name,last_name,role,room_id`,
      vals
    );
    recordAudit({ req, action: 'update', entity_type: 'staff', entity_id: req.params.id,
      meta: { fields_changed: Object.keys(req.body).filter(k => fields.includes(k)) } });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/permissions — update scope and scope_value for a staff member (manager/admin/IT only)
router.put('/:id/permissions', async (req, res) => {
  const allowed = ['manager','deputy_manager','headteacher','admin','it_technician','senco','business_manager'];
  if (!allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden — manager or admin role required' });
  }
  const { scope, scope_value } = req.body;
  const validScopes = ['all','year_group','class','room'];
  if (!validScopes.includes(scope)) {
    return res.status(400).json({ error: 'Invalid scope. Must be: all, year_group, class, room' });
  }
  try {
    const db = getPool();
    await db.query(
      'UPDATE staff SET scope=$1, scope_value=$2, updated_at=NOW() WHERE id=$3',
      [scope, scope === 'all' ? null : (scope_value || null), req.params.id]
    );
    const { rows } = await db.query(
      'SELECT id, first_name, last_name, role, scope, scope_value FROM staff WHERE id=$1',
      [req.params.id]
    );
    res.json(rows[0] || { ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /permissions/year-groups — return distinct year groups / rooms for scope dropdown
router.get('/permissions/groups', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT DISTINCT year_group as value, year_group as label FROM children
      WHERE year_group IS NOT NULL AND is_active=true
      UNION
      SELECT DISTINCT form_group, form_group FROM children
      WHERE form_group IS NOT NULL AND is_active=true
      UNION
      SELECT DISTINCT r.name, r.name FROM rooms r
      WHERE r.name IS NOT NULL
      ORDER BY value
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /permissions/all — return all staff with scope info (manager/admin/IT only)
router.get('/permissions/all', async (req, res) => {
  const allowed = ['manager','deputy_manager','headteacher','admin','it_technician','senco','business_manager'];
  if (!allowed.includes(req.user.role)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id, first_name, last_name, role, scope, scope_value
      FROM staff WHERE is_active=true ORDER BY first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/set-pin — manager sets PIN for any staff; staff sets own
// Supports 4 OR 6 digit numeric PINs. Stores pin_length so the login pad
// knows when to auto-submit. bcrypt cost 10 (matches auth.js login verify).
//
// 🔒 CRITICAL: for id=1 (Toby) the PIN must be written to BOTH staff
// AND protected_staff_pins in the SAME transaction so the backup never
// goes stale. Any seed/reset prompt restores Toby's PIN from that backup.
router.post('/:id/set-pin', async (req, res) => {
  const canSetOthers = ['manager','deputy_manager'].includes(req.user.role);
  const targetId = parseInt(req.params.id, 10);
  if (!canSetOthers && req.user.id !== targetId) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const pin = req.body && req.body.pin != null ? String(req.body.pin) : '';
  if (!/^\d+$/.test(pin) || (pin.length !== 4 && pin.length !== 6)) {
    return res.status(400).json({ error: 'PIN must be exactly 4 or 6 digits' });
  }
  const db = getPool();
  const client = await db.connect();
  try {
    const hash = await bcrypt.hash(pin, 10);
    await client.query('BEGIN');
    // 2026-07-04: was hard-coded staff — a demo/HT edition calling set-pin
    // wrote into PRODUCTION staff (and for id=1 clobbered the protected backup
    // in the same transaction). Schema-unqualified: search_path scopes each
    // edition to its own schema.
    const { rows: upd } = await client.query(
      'UPDATE staff SET pin_hash=$1, pin_length=$2, updated_at=NOW() WHERE id=$3 RETURNING id, first_name, last_name',
      [hash, pin.length, targetId]
    );
    if (!upd.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Staff not found' });
    }
    // id=1 PIN-sync rule — keep the protected backup in lockstep (only where the
    // schema has the table; demo schemas may not, and must never touch ladn's)
    if (targetId === 1) {
      const { rows: reg } = await client.query(
        "SELECT to_regclass('protected_staff_pins') IS NOT NULL AS has_table");
      if (reg[0]?.has_table) {
        const name = `${upd[0].first_name || ''} ${upd[0].last_name || ''}`.trim();
        await client.query(`
          INSERT INTO protected_staff_pins (staff_id, staff_name, pin_hash, updated_at)
          VALUES (1, $1, $2, NOW())
          ON CONFLICT (staff_id) DO UPDATE SET staff_name=$1, pin_hash=$2, updated_at=NOW()
        `, [name, hash]);
      }
    }
    await client.query('COMMIT');
    recordAudit({ req, action: 'set_pin', entity_type: 'staff', entity_id: targetId,
      meta: { pin_length: pin.length, protected_synced: targetId === 1 } });
    res.json({ ok: true, pin_length: pin.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// POST / — create a new staff member (manager/deputy_manager only)
// Optional starting PIN (4 or 6 digits). New row defaults is_active=true.
router.post('/', requireRole('manager', 'deputy_manager'), async (req, res) => {
  const b = req.body || {};
  const first_name = (b.first_name || '').trim();
  const last_name = (b.last_name || '').trim();
  if (!first_name || !last_name) {
    return res.status(400).json({ error: 'First and last name are required' });
  }
  const role = (b.role || 'practitioner').trim();
  const startingPin = b.pin != null ? String(b.pin) : '';
  if (startingPin && (!/^\d+$/.test(startingPin) || (startingPin.length !== 4 && startingPin.length !== 6))) {
    return res.status(400).json({ error: 'Starting PIN must be exactly 4 or 6 digits' });
  }
  const db = getPool();
  try {
    let pinHash = null;
    let pinLength = 4;
    if (startingPin) {
      pinHash = await bcrypt.hash(startingPin, 10);
      pinLength = startingPin.length;
    }
    const { rows } = await db.query(`
      INSERT INTO staff
        (first_name, last_name, preferred_name, email, role, room_id,
         pin_hash, pin_length, is_active, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW(),NOW())
      RETURNING id, first_name, last_name, preferred_name, email, role, room_id, pin_length, is_active
    `, [
      first_name, last_name,
      (b.preferred_name || '').trim() || null,
      (b.email || '').trim() || null,
      role,
      b.room_id != null && b.room_id !== '' ? parseInt(b.room_id, 10) : null,
      pinHash, pinLength
    ]);
    recordAudit({ req, action: 'create', entity_type: 'staff', entity_id: rows[0].id,
      meta: { role, pin_set: !!startingPin } });
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /:id/deactivate — soft-deactivate (manager/deputy_manager only)
// NEVER deactivates id=1 (Toby). Sets is_active=false; data is retained.
router.patch('/:id/deactivate', requireRole('manager', 'deputy_manager'), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  if (targetId === 1) {
    return res.status(403).json({ error: 'The owner account cannot be deactivated' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE staff SET is_active=false, updated_at=NOW() WHERE id=$1 RETURNING id, first_name, last_name, is_active',
      [targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    recordAudit({ req, action: 'deactivate', entity_type: 'staff', entity_id: targetId });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /:id/reactivate — restore a soft-deactivated staff member (manager only)
router.patch('/:id/reactivate', requireRole('manager', 'deputy_manager'), async (req, res) => {
  const targetId = parseInt(req.params.id, 10);
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE staff SET is_active=true, updated_at=NOW() WHERE id=$1 RETURNING id, first_name, last_name, is_active',
      [targetId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Staff not found' });
    recordAudit({ req, action: 'reactivate', entity_type: 'staff', entity_id: targetId });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/absences
router.get('/:id/absences', async (req, res) => {
  const canViewOthers = ['manager','deputy_manager'].includes(req.user.role);
  if (!canViewOthers && req.user.id !== parseInt(req.params.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM absence_requests WHERE staff_id=$1 ORDER BY start_date DESC LIMIT 50`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/training — mandatory training records for a staff member
// Backs the "Mandatory Training" tab in hr/my-cpd.html (was 404 — route was missing).
router.get('/:id/training', async (req, res) => {
  const canViewOthers = ['manager','deputy_manager'].includes(req.user.role);
  if (!canViewOthers && req.user.id !== parseInt(req.params.id)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, staff_id, training_type, completed_date, expiry_date, provider, certificate_url
         FROM mandatory_training
        WHERE staff_id=$1
        ORDER BY (expiry_date IS NULL), expiry_date ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Work-pattern importer ─────────────────────────────────────────────────────
// POST /import-workpattern  (manager/deputy_manager only)
// Accepts multipart .xlsx or .csv upload with columns:
//   First, Last, Hours per week, Hourly Rate, Qualification, Years of Service,
//   Monday, Tuesday, Wednesday, Thursday, Friday, Lunch break, Room
//
// Shift cell format: "H-H", "H.MM-H.MM", empty = day off.
// Ambiguity rule: hours 1-6 in the end position → treat as pm (add 12).
//   e.g. "8-6" → 08:00-18:00, "8-1.30" → 08:00-13:30, "7.45-6" → 07:45-18:00.
//   Hours ≥7 kept as-is (morning). No nursery shifts start before 07:00.

function _parseShiftTime(raw) {
  // raw e.g. "7.45" or "6" or "1.30" or "10"
  raw = String(raw).trim();
  const dotIdx = raw.indexOf('.');
  let h, m;
  if (dotIdx >= 0) {
    h = parseInt(raw.slice(0, dotIdx), 10);
    const minStr = raw.slice(dotIdx + 1).padEnd(2, '0').slice(0, 2);
    m = parseInt(minStr, 10);
  } else {
    h = parseInt(raw, 10);
    m = 0;
  }
  if (isNaN(h) || isNaN(m)) return null;
  // Hours 1-6 are afternoon in a nursery context (nursery opens 08:00, closes 18:00)
  if (h >= 1 && h <= 6) h += 12;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function _parseShiftCell(cell) {
  // Returns { start, end } or null if day off, or { error } if unparseable
  if (cell === null || cell === undefined || String(cell).trim() === '' || String(cell).trim().toLowerCase() === 'none') {
    return null; // day off
  }
  const s = String(cell).trim();
  const dashIdx = s.lastIndexOf('-');
  if (dashIdx < 1) return { error: `Cannot parse shift "${cell}"` };
  const startRaw = s.slice(0, dashIdx).trim();
  const endRaw   = s.slice(dashIdx + 1).trim();
  const start = _parseShiftTime(startRaw);
  const end   = _parseShiftTime(endRaw);
  if (!start) return { error: `Bad start time in "${cell}"` };
  if (!end)   return { error: `Bad end time in "${cell}"` };
  return { start, end };
}

const QUAL_LEVEL = { l6: 6, l5: 5, l4: 4, l3: 3, l2: 2, apprentice: 1, unqual: 0 };
function _qualLevel(q) {
  if (!q) return null;
  const k = String(q).toLowerCase().replace(/\s+/g, '');
  return QUAL_LEVEL[k] ?? null;
}

router.post('/import-workpattern', requireRole('manager', 'deputy_manager'), (req, res, next) => {
  const upload = getUpload();
  if (!upload) return res.status(500).json({ error: 'multer not installed' });
  upload.single('file')(req, res, next);
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  let rows;
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  } catch (e) {
    return res.status(400).json({ error: `Could not parse file: ${e.message}` });
  }

  if (!rows.length) return res.status(400).json({ error: 'Empty file' });

  // Find header row
  const hdr = rows[0].map(h => String(h || '').trim().toLowerCase());
  const col = name => hdr.indexOf(name.toLowerCase());
  const idxFirst = col('first');
  const idxLast  = col('last');
  if (idxFirst < 0 || idxLast < 0) {
    return res.status(400).json({ error: 'Missing First/Last columns in header' });
  }
  const idxHours   = col('hours per week');
  const idxRate    = col('hourly rate');
  const idxQual    = col('qualification');
  const idxYears   = col('years of service');
  const idxMon     = col('monday');
  const idxTue     = col('tuesday');
  const idxWed     = col('wednesday');
  const idxThu     = col('thursday');
  const idxFri     = col('friday');
  const idxLunch   = col('lunch break');
  const idxRoom    = col('room');

  const db = getPool();
  const dataRows = rows.slice(1).filter(r => r[idxFirst] || r[idxLast]);

  const matched = [];
  const unmatched = [];
  let totalShifts = 0;

  for (const row of dataRows) {
    const first = String(row[idxFirst] || '').trim();
    const last  = String(row[idxLast]  || '').trim();
    if (!first && !last) continue;

    // Look up staff by case-insensitive first+last name match
    const { rows: staffRows } = await db.query(
      'SELECT id FROM staff WHERE lower(first_name)=$1 AND lower(last_name)=$2 AND is_active=true',
      [first.toLowerCase(), last.toLowerCase()]
    );

    if (!staffRows.length) {
      unmatched.push({ first, last, reason: 'No active staff found with this name' });
      continue;
    }

    const staffId = staffRows[0].id;
    const qualText  = idxQual >= 0 ? String(row[idxQual] || '').trim() || null : null;
    const qualLevel = _qualLevel(qualText);
    const hoursPerWeek = idxHours >= 0 && row[idxHours] != null ? parseFloat(row[idxHours]) : null;
    const hourlyRate   = idxRate  >= 0 && row[idxRate]  != null ? parseFloat(row[idxRate])  : null;
    const yearsService = idxYears >= 0 && row[idxYears] != null ? parseInt(row[idxYears], 10) : null;
    const lunchMins    = idxLunch >= 0 && row[idxLunch] != null ? parseInt(String(row[idxLunch]).replace(/[^0-9]/g, ''), 10) || 0 : 0;
    const room         = idxRoom  >= 0 && row[idxRoom]  != null ? String(row[idxRoom]).trim() || null : null;

    // Update staff row (skip annual_salary — it is a generated column)
    const staffUpdates = [];
    const staffVals = [];
    if (hourlyRate   !== null && !isNaN(hourlyRate))   { staffUpdates.push(`hourly_rate=$${staffUpdates.length+1}`);   staffVals.push(hourlyRate); }
    if (qualText)                                       { staffUpdates.push(`qualification=$${staffUpdates.length+1}`); staffVals.push(qualText); }
    if (qualLevel    !== null)                          { staffUpdates.push(`qualification_level=$${staffUpdates.length+1}`); staffVals.push(qualLevel); }
    if (yearsService !== null && !isNaN(yearsService)) { staffUpdates.push(`years_of_service=$${staffUpdates.length+1}`); staffVals.push(yearsService); }
    if (hoursPerWeek !== null && !isNaN(hoursPerWeek)) { staffUpdates.push(`hours_per_week=$${staffUpdates.length+1}`); staffVals.push(hoursPerWeek); }

    if (staffUpdates.length) {
      staffVals.push(staffId);
      await db.query(`UPDATE staff SET ${staffUpdates.join(',')}, updated_at=NOW() WHERE id=$${staffVals.length}`, staffVals);
    }

    // Insert/replace work patterns for Mon(0)-Fri(4)
    const dayCols = [idxMon, idxTue, idxWed, idxThu, idxFri];
    let shiftsForStaff = 0;
    const parseErrors = [];

    for (let dow = 0; dow < 5; dow++) {
      const cellIdx = dayCols[dow];
      const cell = cellIdx >= 0 ? row[cellIdx] : null;
      const parsed = _parseShiftCell(cell);

      if (parsed && parsed.error) {
        parseErrors.push(parsed.error);
        continue;
      }

      const isOff = parsed === null;
      const start = isOff ? null : parsed.start;
      const end   = isOff ? null : parsed.end;

      await db.query(`
        INSERT INTO staff_work_patterns
          (staff_id, day_of_week, shift_start, shift_end, is_off, lunch_break_minutes, room, effective_from)
        VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE)
        ON CONFLICT (staff_id, day_of_week, effective_from)
        DO UPDATE SET shift_start=$3, shift_end=$4, is_off=$5, lunch_break_minutes=$6, room=$7, updated_at=NOW()
      `, [staffId, dow, start, end, isOff, lunchMins, room]);
      shiftsForStaff++;
    }

    totalShifts += shiftsForStaff;

    if (parseErrors.length) {
      unmatched.push({ first, last, reason: parseErrors.join('; ') });
    } else {
      matched.push({ staff_id: staffId, name: `${first} ${last}`, patterns_inserted: shiftsForStaff });
    }
  }

  res.json({
    matched,
    unmatched,
    summary: {
      total_rows: dataRows.length,
      matched: matched.length,
      unmatched: unmatched.length,
      shifts_created: totalShifts,
    },
  });
});

// POST /:id/photo — staff profile photo (2026-07-11). Served from /uploads/staff-photos.
const _staffPhotoDir = '/app/uploads/staff-photos';
const _staffPhotoUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb){ fs.mkdirSync(_staffPhotoDir, { recursive: true }); cb(null, _staffPhotoDir); },
    filename(req, file, cb){ const ext=(path.extname(file.originalname).toLowerCase()||'.jpg').replace('.jpeg','.jpg'); cb(null, String(req.params.id)+ext); },
  }),
  limits: { fileSize: 8*1024*1024 },
  fileFilter(req, file, cb){ cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)); },
});
router.post('/:id/photo', _staffPhotoUpload.single('photo'), async (req, res) => {
  const canEditOthers = ['manager','deputy_manager'].includes(req.user.role);
  if (!canEditOthers && req.user.id !== parseInt(req.params.id)) return res.status(403).json({ error: 'Forbidden' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = '/uploads/staff-photos/' + req.file.filename;
  try {
    await getPool().query('UPDATE staff SET photo_url=$1, updated_at=NOW() WHERE id=$2', [url, req.params.id]);
    res.json({ photo_url: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;

// BrightHR import — multer parses multipart upload in-memory
let _multer;
function getUpload() {
  if (!_multer) {
    try { _multer = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 10*1024*1024 } }); }
    catch { return null; }
  }
  return _multer;
}

router.post('/import-brighthr', authenticate, (req, res, next) => {
  const upload = getUpload();
  if (!upload) return res.status(500).json({ error: 'multer not installed — run: npm install multer' });
  upload.single('file')(req, res, next);
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const csv = req.file.buffer.toString('utf-8').replace(/^\uFEFF/, '');
  const lines = csv.split('\n');
  const data = {};
  let section = null, hdrs = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) { section = null; continue; }
    if (l.startsWith('Personal Details:'))    { section='personal';  i++; hdrs=lines[i].split(',').map(h=>h.trim().replace(/"/g,'')); continue; }
    if (l.startsWith('Terms of Employment:')) { section='terms';     i++; hdrs=lines[i].split(',').map(h=>h.trim().replace(/"/g,'')); continue; }
    if (l.startsWith('Employment Contracts:')){ section='contract';  i++; hdrs=lines[i].split(',').map(h=>h.trim().replace(/"/g,'')); continue; }
    if (l.startsWith('User Information:'))    { section='user';      i++; hdrs=lines[i].split(',').map(h=>h.trim().replace(/"/g,'')); continue; }
    if (section && hdrs.length) {
      const vals = l.split(',');
      hdrs.forEach((h,idx) => { data[`${section}_${h}`] = (vals[idx]||'').replace(/^"|"$/g,'').trim(); });
      section = null;
    }
  }
  const pd = s => { if(!s||s==='N/A')return null; const d=new Date(s); return isNaN(d)?null:d.toISOString().split('T')[0]; };
  const jt = data['terms_Job Title']||'';
  const roleMap = {'Room Leader':'room_leader','Deputy Manager':'deputy_manager','Manager':'manager','Apprentice':'apprentice','Cook':'cook'};
  const role = Object.entries(roleMap).find(([k])=>jt.toLowerCase().includes(k.toLowerCase()))?.[1]||'practitioner';
  const staff = {
    first_name: data['personal_First Name']||'',
    last_name:  data['personal_Last Name']||'',
    email:      data['user_Email Address']||data['personal_Work Email Address']||'',
    phone:      data['personal_Mobile Number']||'',
    date_of_birth: pd(data['personal_Date of Birth']),
    address_line1: data['personal_Address Line 1']||'',
    postcode:   data['personal_PostCode']||'',
    role, contracted_hours: parseFloat(data['contract_Hours Per Week'])||null,
    contract_start: pd(data['terms_Start Date']),
    is_active: !data['terms_End Date']||!pd(data['terms_End Date']),
  };
  if (!staff.first_name||!staff.last_name) return res.status(400).json({ error: 'Could not parse name' });
  const db = getPool();
  try {
    const { rows } = await db.query('SELECT id FROM staff WHERE first_name=$1 AND last_name=$2',[staff.first_name,staff.last_name]);
    if (rows.length) {
      const keys=Object.keys(staff);
      await db.query(`UPDATE staff SET ${keys.map((k,i)=>`${k}=$${i+1}`).join(',')} WHERE id=$${keys.length+1}`,[...Object.values(staff),rows[0].id]);
      res.json({ action:'updated', name:`${staff.first_name} ${staff.last_name}` });
    } else {
      const keys=Object.keys(staff);
      await db.query(`INSERT INTO staff (${keys.join(',')}) VALUES (${keys.map((_,i)=>'$'+(i+1)).join(',')})`,[...Object.values(staff)]);
      res.json({ action:'created', name:`${staff.first_name} ${staff.last_name}` });
    }
  } catch(e) { res.status(500).json({ error: e.message }); }
});
