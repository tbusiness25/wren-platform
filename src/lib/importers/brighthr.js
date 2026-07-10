'use strict';

/**
 * BrightHR CSV importer.
 * Two CSVs: employees.csv → staff + staff_contracts
 *            absences.csv  → absence_requests
 * Dates: DD-MMM-YYYY, DD MMM YYYY, DD/MM/YYYY all handled.
 * Salary stored as integer pence to avoid float rounding.
 */

const bcrypt = require('bcryptjs');

// ── Template ──────────────────────────────────────────────────────────────────

const TEMPLATE = {
  name: 'brighthr-v1',
  source_kind: 'brighthr',
  target_entity: 'bundle',
  version: 1,
  is_builtin: true,
  mapping: {
    employees: {
      first_name:       'First Name',
      last_name:        'Last Name',
      email:            'Email Address',
      mobile:           'Mobile Number',
      job_title:        'Job Title',
      department:       'Department',
      employment_type:  'Employment Type',
      start_date:       'Start Date',
      end_date:         'End Date',
      annual_salary:    'Annual Salary',
      contracted_hours: 'Contracted Hours',
    },
    absences: {
      first_name:   'Employee First Name',
      last_name:    'Employee Last Name',
      start_date:   'Start Date',
      end_date:     'End Date',
      absence_type: 'Absence Type',
      duration:     'Duration (Days)',
      notes:        'Notes',
    },
  },
};

module.exports.TEMPLATE = TEMPLATE;

// ── Role mapping: BrightHR job titles → Wren roles ───────────────────────────

const ROLE_TITLE_MAP = [
  { pattern: /manager.*owner|owner.*manager/i,   role: 'manager' },
  { pattern: /nursery\s*manager|setting\s*manager|centre\s*manager/i, role: 'manager' },
  { pattern: /^manager$/i,                        role: 'manager' },
  { pattern: /deputy\s*manager|deputy/i,          role: 'deputy_manager' },
  { pattern: /room\s*lead|team\s*lead|senior\s*practitioner|lead\s*practitioner/i, role: 'room_leader' },
  { pattern: /administrator|admin|office\s*manager|receptionist/i, role: 'admin' },
  { pattern: /cook|chef|kitchen/i,                role: 'admin' },
  { pattern: /practitioner|keyworker|key\s*worker|early\s*years|nursery\s*nurse|childcare|educator/i, role: 'practitioner' },
];

function mapJobTitleToRole(title) {
  if (!title) return 'practitioner';
  for (const { pattern, role } of ROLE_TITLE_MAP) {
    if (pattern.test(title)) return role;
  }
  return 'practitioner';
}
module.exports.mapJobTitleToRole = mapJobTitleToRole;

// ── Employment type normaliser ────────────────────────────────────────────────

const EMPLOYMENT_TYPE_MAP = {
  'full time': 'permanent',
  'full-time': 'permanent',
  'permanent': 'permanent',
  'part time': 'part_time',
  'part-time': 'part_time',
  'temporary': 'temporary',
  'fixed term': 'temporary',
  'fixed-term': 'temporary',
  'bank': 'bank',
  'zero hours': 'bank',
  'zero-hours': 'bank',
  'casual': 'bank',
};

function normaliseEmploymentType(raw) {
  if (!raw) return 'permanent';
  return EMPLOYMENT_TYPE_MAP[raw.toLowerCase().trim()] || 'permanent';
}

// ── Absence type normaliser ───────────────────────────────────────────────────

const ABSENCE_TYPE_MAP = {
  'sickness': 'sick',
  'sick': 'sick',
  'illness': 'sick',
  'annual leave': 'holiday',
  'holiday': 'holiday',
  'annual': 'holiday',
  'maternity': 'maternity',
  'paternity': 'paternity',
  'parental': 'parental',
  'shared parental': 'parental',
  'compassionate': 'compassionate',
  'bereavement': 'compassionate',
  'training': 'training',
  'cpd': 'training',
  'unauthorised': 'unauthorised',
  'other': 'other',
};

function normaliseAbsenceType(raw) {
  if (!raw) return 'other';
  return ABSENCE_TYPE_MAP[raw.toLowerCase().trim()] || 'other';
}

// ── Date parser: handles DD-MMM-YYYY, DD MMM YYYY, DD/MM/YYYY ────────────────

const MONTH_MAP = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function parseDate(v) {
  if (!v || !v.trim()) return null;
  const s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // DD/MM/YYYY or DD-MM-YYYY (numeric)
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{2})[\/\-](\d{4})$/);
  if (dmy) {
    const iso = `${dmy[3]}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`;
    if (!isNaN(new Date(iso))) return iso;
  }

  // DD-MMM-YYYY or DD MMM YYYY
  const named = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[\s\-](\d{4})$/);
  if (named) {
    const mon = MONTH_MAP[named[2].toLowerCase()];
    if (mon) return `${named[3]}-${mon}-${named[1].padStart(2,'0')}`;
  }

  return null;
}
module.exports.parseDate = parseDate;

// ── Salary parser: string "£25,000.50" → integer pence ────────────────────────

function parseSalaryPennies(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[£$,\s]/g, ''));
  if (isNaN(num)) return null;
  return Math.round(num * 100);
}

// ── CSV helpers ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuote) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"')            { inQuote = false; }
      else                           { field += c; }
    } else {
      if (c === '"')                        { inQuote = true; }
      else if (c === ',')                   { row.push(field); field = ''; }
      else if (c === '\r' && next === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
      else if (c === '\n' || c === '\r')    { row.push(field); rows.push(row); row = []; field = ''; }
      else                                  { field += c; }
    }
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function parseCSVtoObjects(text) {
  const rows = parseCSV(text.replace(/^﻿/, ''));  // strip BOM
  if (rows.length < 1) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (row[i] || '').trim(); });
    return obj;
  });
}
module.exports.parseCSVtoObjects = parseCSVtoObjects;

// ── Employee importer ─────────────────────────────────────────────────────────

/**
 * importEmployees(client, rows, schema)
 * Returns { created, updated, skipped, errors, contractsCreated }
 */
async function importEmployees(client, rows, schema = 'ladn') {
  const S = schema;
  let created = 0, updated = 0, skipped = 0, contractsCreated = 0;
  const errors = [];

  for (const [i, row] of rows.entries()) {
    const first = (row['First Name'] || row['Forename'] || '').trim();
    const last  = (row['Last Name'] || row['Surname'] || '').trim();
    const email = (row['Email Address'] || row['Email'] || '').trim().toLowerCase();

    if (!first || !last) {
      errors.push({ row: i + 2, error: `Missing first or last name` });
      skipped++;
      continue;
    }

    const role           = mapJobTitleToRole(row['Job Title'] || '');
    const employment_type = normaliseEmploymentType(row['Employment Type'] || row['Contract Type'] || '');
    const phone          = (row['Mobile Number'] || row['Mobile'] || row['Phone'] || '').trim() || null;
    const startDate      = parseDate(row['Start Date'] || '');
    const endDate        = parseDate(row['End Date'] || '');
    const contractedHours = parseFloat(row['Contracted Hours'] || '') || null;
    const salaryPennies  = parseSalaryPennies(row['Annual Salary'] || '');
    const jobTitle       = (row['Job Title'] || '').trim() || null;
    const department     = (row['Department'] || '').trim() || null;
    // BrightHR employee IDs — use as brighthr_ref for idempotency
    const brighthrRef    = (row['Employee ID'] || row['ID'] || '').trim() || null;

    try {
      let staffId;

      if (email) {
        // ABSOLUTE RULE: never touch id=1 (Nursery Manager)
        const { rows: ex } = await client.query(
          `SELECT id FROM ${S}.staff WHERE lower(email)=lower($1) AND id != 1 LIMIT 1`, [email]);

        if (ex.length) {
          staffId = ex[0].id;
          await client.query(
            `UPDATE ${S}.staff SET
               first_name=COALESCE(NULLIF($1,''),first_name),
               last_name=COALESCE(NULLIF($2,''),last_name),
               role=COALESCE(NULLIF($3,''),role),
               phone=COALESCE(NULLIF($4,''),phone),
               employment_type=COALESCE(NULLIF($5,''),employment_type),
               contracted_hours=COALESCE($6,contracted_hours),
               contract_start=COALESCE($7,contract_start),
               contract_end=COALESCE($8,contract_end),
               updated_at=NOW()
             WHERE id=$9`,
            [first, last, role, phone, employment_type,
             contractedHours, startDate || null, endDate || null, staffId]);
          updated++;
        } else {
          const pinHash = await bcrypt.hash('0000', 10);
          const { rows: ins } = await client.query(
            `INSERT INTO ${S}.staff
               (first_name,last_name,role,email,pin_hash,phone,employment_type,
                contracted_hours,contract_start,contract_end,is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)
             ON CONFLICT (email) DO NOTHING
             RETURNING id`,
            [first, last, role, email, pinHash, phone, employment_type,
             contractedHours, startDate || null, endDate || null]);
          if (ins.length) {
            staffId = ins[0].id;
            created++;
          } else {
            skipped++;
            continue;
          }
        }
      } else {
        // No email — match by name only
        const { rows: ex } = await client.query(
          `SELECT id FROM ${S}.staff WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND id != 1 LIMIT 1`,
          [first, last]);
        if (ex.length) {
          staffId = ex[0].id;
          updated++;
        } else {
          const pinHash = await bcrypt.hash('0000', 10);
          const { rows: ins } = await client.query(
            `INSERT INTO ${S}.staff
               (first_name,last_name,role,pin_hash,phone,employment_type,
                contracted_hours,contract_start,contract_end,is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true)
             RETURNING id`,
            [first, last, role, pinHash, phone, employment_type,
             contractedHours, startDate || null, endDate || null]);
          if (ins.length) { staffId = ins[0].id; created++; }
          else { skipped++; continue; }
        }
      }

      // Upsert staff_contracts
      if (staffId) {
        await client.query(
          `INSERT INTO ${S}.staff_contracts
             (staff_id,start_date,end_date,employment_type,contracted_hours,
              annual_salary_pennies,job_title,department,brighthr_ref)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (brighthr_ref) DO UPDATE SET
             start_date=EXCLUDED.start_date,
             end_date=EXCLUDED.end_date,
             employment_type=EXCLUDED.employment_type,
             contracted_hours=EXCLUDED.contracted_hours,
             annual_salary_pennies=EXCLUDED.annual_salary_pennies,
             job_title=EXCLUDED.job_title,
             department=EXCLUDED.department,
             updated_at=NOW()`,
          [staffId, startDate || null, endDate || null, employment_type,
           contractedHours, salaryPennies, jobTitle, department,
           brighthrRef || `staff_${staffId}_${startDate || 'nod'}`]);
        contractsCreated++;
      }
    } catch (err) {
      errors.push({ row: i + 2, error: err.message });
      skipped++;
    }
  }

  return { created, updated, skipped, contractsCreated, errors };
}
module.exports.importEmployees = importEmployees;

// ── Absence importer ──────────────────────────────────────────────────────────

/**
 * importAbsences(client, rows, schema)
 * Returns { created, skipped, errors }
 */
async function importAbsences(client, rows, schema = 'ladn') {
  const S = schema;
  let created = 0, skipped = 0;
  const errors = [];

  for (const [i, row] of rows.entries()) {
    const first = (row['Employee First Name'] || row['First Name'] || '').trim();
    const last  = (row['Employee Last Name']  || row['Last Name'] || row['Surname'] || '').trim();
    if (!first || !last) { skipped++; continue; }

    const startDate = parseDate(row['Start Date'] || '');
    const endDate   = parseDate(row['End Date']   || '');
    if (!startDate) {
      errors.push({ row: i + 2, error: `Invalid or missing start date` });
      skipped++;
      continue;
    }

    const { rows: st } = await client.query(
      `SELECT id FROM ${S}.staff WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND id != 1 LIMIT 1`,
      [first, last]);
    if (!st.length) {
      errors.push({ row: i + 2, error: `Staff member "${first} ${last}" not found` });
      skipped++;
      continue;
    }

    const absenceType = normaliseAbsenceType(row['Absence Type'] || row['Type'] || '');
    const durationDays = parseFloat(row['Duration (Days)'] || row['Duration'] || '') || null;
    const notes = (row['Notes'] || row['Description'] || row['Reason'] || '').trim() || null;

    try {
      await client.query(
        `INSERT INTO ${S}.absence_requests
           (staff_id,start_date,end_date,absence_type,days_count,notes,status,auto_approved,request_type)
         VALUES ($1,$2,$3,$4,$5,$6,'approved',true,'absence')
         ON CONFLICT DO NOTHING`,
        [st[0].id, startDate, endDate || startDate, absenceType,
         durationDays, notes]);
      created++;
    } catch (err) {
      errors.push({ row: i + 2, error: err.message });
      skipped++;
    }
  }

  return { created, skipped, errors };
}
module.exports.importAbsences = importAbsences;
