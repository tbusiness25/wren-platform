'use strict';

/**
 * Tapestry CSV bundle importer.
 * Accepts a ZIP containing children.csv, parents.csv, observations.csv, attendance.csv.
 * Dates in DD/MM/YYYY format → ISO.
 * Media file references logged to observation notes (v1).
 * v2 will handle actual media uploads.
 */

const AdmZip = require('adm-zip');

// ── Template definition (seeded once into import_templates) ──────────────

const TEMPLATE = {
  name: 'tapestry-bundle-v1',
  source_kind: 'tapestry',
  target_entity: 'bundle',
  version: 1,
  is_builtin: true,
  mapping: {
    children: {
      first_name:    'First Name',
      last_name:     'Last Name',
      date_of_birth: 'Date of Birth',
      room_name:     'Room',
      start_date:    'Start Date',
      leave_date:    'End Date',
      allergies:     'Allergies',
      medical_notes: 'Medical Info',
      parent_1_name:  'Parent 1 First Name',   // combined with Parent 1 Last Name below
      parent_1_email: 'Parent 1 Email',
      parent_1_phone: 'Parent 1 Phone',
      parent_2_name:  'Parent 2 First Name',
      parent_2_email: 'Parent 2 Email',
      parent_2_phone: 'Parent 2 Phone',
    },
    observations: {
      child_name:       'Child Name',
      title:            'Title',
      observation_text: 'Body',
      observation_type: 'Type',
      date:             'Date',
      observed_by:      'Observed By',
    },
    attendance: {
      child_name:     'Child Name',
      date:           'Date',
      session:        'Session',
      attended:       'Attended',
      absence_reason: 'Absence Reason',
    },
    parents: {
      child_first_name: 'Child First Name',
      child_last_name:  'Child Last Name',
      parent_name:      'First Name',     // parent's first+last combined in applyParents
      parent_last_name: 'Last Name',
      email:            'Email',
      phone:            'Phone',
      mobile:           'Mobile',
      relationship:     'Relationship',
    },
  },
};

module.exports.TEMPLATE = TEMPLATE;

// ── Date helpers ──────────────────────────────────────────────────────────────

function parseDMY(v) {
  if (!v || !v.trim()) return null;
  const s = v.trim();
  // ISO already
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // DD/MM/YYYY  or  DD-MM-YYYY
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) {
    const iso = `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    if (!isNaN(new Date(iso))) return iso;
  }
  return null;
}

// ── CSV parser (handles quoted fields, CRLF/LF) ───────────────────────────────

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
      if (c === '"')                            { inQuote = true; }
      else if (c === ',')                       { row.push(field); field = ''; }
      else if (c === '\r' && next === '\n')     { row.push(field); rows.push(row); row = []; field = ''; i++; }
      else if (c === '\n' || c === '\r')        { row.push(field); rows.push(row); row = []; field = ''; }
      else                                      { field += c; }
    }
  }
  row.push(field);
  if (row.some(f => f !== '')) rows.push(row);
  return rows.filter(r => r.some(c => c.trim() !== ''));
}

function parseCSVtoObjects(text) {
  const rows = parseCSV(text);
  if (rows.length < 1) return [];
  const headers = rows[0].map(h => h.trim());
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (row[i] || '').trim(); });
    return obj;
  });
}

// ── ZIP extraction ────────────────────────────────────────────────────────────

/**
 * Extract known CSVs from a ZIP buffer.
 * Returns { children, parents, observations, attendance } — each is an array of row objects.
 * Unrecognised entries are ignored.
 */
function extractZip(buffer) {
  const zip = new AdmZip(buffer);
  const result = { children: [], parents: [], observations: [], attendance: [] };

  for (const entry of zip.getEntries()) {
    const name = entry.entryName.toLowerCase().replace(/.*\//, ''); // strip path prefix
    if (entry.isDirectory) continue;
    const text = entry.getData().toString('utf8').replace(/^﻿/, ''); // strip BOM
    if (name === 'children.csv')     result.children     = parseCSVtoObjects(text);
    else if (name === 'parents.csv') result.parents      = parseCSVtoObjects(text);
    else if (name === 'observations.csv') result.observations = parseCSVtoObjects(text);
    else if (name === 'attendance.csv')   result.attendance   = parseCSVtoObjects(text);
  }
  return result;
}
module.exports.extractZip = extractZip;

// ── Preview (returns counts only, no data) ─────────────────────────────────────

function previewBundle(buffer) {
  const { children, parents, observations, attendance } = extractZip(buffer);
  return {
    source: 'tapestry',
    children:     children.length,
    parents:      parents.length,
    observations: observations.length,
    attendance:   attendance.length,
  };
}
module.exports.previewBundle = previewBundle;

// ── Observation type normaliser ────────────────────────────────────────────────

const OBS_TYPE_MAP = {
  'learning story': 'learning_story',
  'achievement': 'learning_story',
  'milestone': 'milestone',
  'assessment': 'assessment',
  'formative assessment': 'assessment',
  'summative assessment': 'assessment',
  '2 year progress check': '2year_check',
  '2-year progress check': '2year_check',
  'two year progress check': '2year_check',
};

function normaliseObsType(raw) {
  if (!raw) return 'note';
  return OBS_TYPE_MAP[raw.toLowerCase().trim()] || 'note';
}

// ── Child name splitter (best-effort: last word = last name) ──────────────────

function splitName(fullName) {
  if (!fullName || !fullName.trim()) return { first: '', last: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

// ── Core import function ──────────────────────────────────────────────────────

/**
 * importBundle(client, files, schema)
 * client  — pg PoolClient (caller manages transaction)
 * files   — { children, parents, observations, attendance } row objects
 * schema  — PG schema name (default 'ladn')
 * Returns { children, parents, observations, attendance } counters with created/updated/skipped.
 */
async function importBundle(client, files, schema = 'ladn') {
  const S = schema;
  const result = {
    children:     { created: 0, updated: 0, skipped: 0, errors: [] },
    parents:      { created: 0, updated: 0, skipped: 0, errors: [] },
    observations: { created: 0, updated: 0, skipped: 0, errors: [] },
    attendance:   { created: 0, updated: 0, skipped: 0, errors: [] },
  };

  // ── 1. Children ──────────────────────────────────────────────────────────────
  for (const [i, row] of files.children.entries()) {
    const first = (row['First Name'] || '').trim();
    const last  = (row['Last Name']  || '').trim();
    const dobRaw = row['Date of Birth'] || row['DOB'] || '';
    const dob   = parseDMY(dobRaw);
    if (!first || !last || !dob) {
      result.children.errors.push({ row: i + 2, error: `Missing required field(s): first_name="${first}" last_name="${last}" dob="${dobRaw}"` });
      result.children.skipped++;
      continue;
    }

    // Build parent name from separate first+last columns
    const p1First = (row['Parent 1 First Name'] || '').trim();
    const p1Last  = (row['Parent 1 Last Name']  || '').trim();
    const p1Name  = p1First && p1Last ? `${p1First} ${p1Last}` : (p1First || p1Last || null);
    const p2First = (row['Parent 2 First Name'] || '').trim();
    const p2Last  = (row['Parent 2 Last Name']  || '').trim();
    const p2Name  = p2First && p2Last ? `${p2First} ${p2Last}` : (p2First || p2Last || null);

    let roomId = null;
    const roomName = (row['Room'] || row['Group'] || '').trim();
    if (roomName) {
      const { rows: rr } = await client.query(
        `SELECT id FROM ${S}.rooms WHERE lower(name)=lower($1) LIMIT 1`, [roomName]);
      roomId = rr[0]?.id ?? null;
    }

    const { rows: ex } = await client.query(
      `SELECT id FROM ${S}.children WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND date_of_birth=$3`,
      [first, last, dob]);

    try {
      if (ex.length) {
        await client.query(
          `UPDATE ${S}.children SET
             room_id=COALESCE($1,room_id),
             allergies=COALESCE(NULLIF($2,''),allergies),
             medical_notes=COALESCE(NULLIF($3,''),medical_notes),
             leave_date=COALESCE(NULLIF($4,'')::date,leave_date),
             parent_1_name=COALESCE($5,parent_1_name),
             parent_1_email=COALESCE(NULLIF($6,''),parent_1_email),
             parent_1_phone=COALESCE(NULLIF($7,''),parent_1_phone),
             parent_2_name=COALESCE($8,parent_2_name),
             parent_2_email=COALESCE(NULLIF($9,''),parent_2_email),
             parent_2_phone=COALESCE(NULLIF($10,''),parent_2_phone),
             updated_at=NOW()
           WHERE id=$11`,
          [roomId,
           row['Allergies']    || null, row['Medical Info'] || null,
           parseDMY(row['End Date'] || '') || null,
           p1Name || null, row['Parent 1 Email'] || null, row['Parent 1 Phone'] || null,
           p2Name || null, row['Parent 2 Email'] || null, row['Parent 2 Phone'] || null,
           ex[0].id]);
        result.children.updated++;
      } else {
        await client.query(
          `INSERT INTO ${S}.children
             (first_name,last_name,date_of_birth,room_id,allergies,medical_notes,
              start_date,leave_date,parent_1_name,parent_1_email,parent_1_phone,
              parent_2_name,parent_2_email,parent_2_phone,is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true)`,
          [first, last, dob, roomId,
           row['Allergies'] || null, row['Medical Info'] || null,
           parseDMY(row['Start Date'] || '') || null,
           parseDMY(row['End Date']   || '') || null,
           p1Name || null, row['Parent 1 Email'] || null, row['Parent 1 Phone'] || null,
           p2Name || null, row['Parent 2 Email'] || null, row['Parent 2 Phone'] || null]);
        result.children.created++;
      }
    } catch (err) {
      result.children.errors.push({ row: i + 2, error: err.message });
      result.children.skipped++;
    }
  }

  // ── 2. Parents (update child contact details from parents.csv) ───────────────
  for (const [i, row] of files.parents.entries()) {
    const childFirst = (row['Child First Name'] || '').trim();
    const childLast  = (row['Child Last Name']  || '').trim();
    if (!childFirst || !childLast) { result.parents.skipped++; continue; }

    const { rows: ch } = await client.query(
      `SELECT id FROM ${S}.children WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND is_active=true LIMIT 1`,
      [childFirst, childLast]);
    if (!ch.length) {
      result.parents.errors.push({ row: i + 2, error: `Child "${childFirst} ${childLast}" not found` });
      result.parents.skipped++;
      continue;
    }

    const firstName = (row['First Name'] || '').trim();
    const lastName  = (row['Last Name']  || '').trim();
    const pName     = firstName && lastName ? `${firstName} ${lastName}` : (firstName || lastName || null);
    const phone     = (row['Mobile'] || row['Phone'] || '').trim() || null;

    try {
      // Determine whether this is parent 1 or 2 slot (fill whichever is empty)
      const { rows: cur } = await client.query(
        `SELECT parent_1_email, parent_2_email FROM ${S}.children WHERE id=$1`, [ch[0].id]);
      const hasP1 = !!(cur[0]?.parent_1_email);

      if (!hasP1) {
        await client.query(
          `UPDATE ${S}.children SET parent_1_name=$1,parent_1_email=$2,parent_1_phone=$3,updated_at=NOW() WHERE id=$4`,
          [pName, row['Email'] || null, phone, ch[0].id]);
      } else {
        await client.query(
          `UPDATE ${S}.children SET parent_2_name=$1,parent_2_email=$2,parent_2_phone=$3,updated_at=NOW() WHERE id=$4`,
          [pName, row['Email'] || null, phone, ch[0].id]);
      }
      result.parents.updated++;
    } catch (err) {
      result.parents.errors.push({ row: i + 2, error: err.message });
      result.parents.skipped++;
    }
  }

  // ── 3. Observations ──────────────────────────────────────────────────────────
  for (const [i, row] of files.observations.entries()) {
    const childName = (row['Child Name'] || row['Child'] || '').trim();
    if (!childName) { result.observations.skipped++; continue; }
    const { first, last } = splitName(childName);

    const { rows: ch } = await client.query(
      `SELECT id FROM ${S}.children WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND is_active=true LIMIT 1`,
      [first, last]);
    if (!ch.length) {
      result.observations.errors.push({ row: i + 2, error: `Child "${childName}" not found` });
      result.observations.skipped++;
      continue;
    }

    const obsDate   = parseDMY(row['Date'] || '');
    const obsType   = normaliseObsType(row['Type'] || '');
    const title     = (row['Title'] || '').trim() || null;
    const bodyText  = (row['Body'] || row['Observation'] || row['Observation Text'] || '').trim();
    const observedBy = (row['Observed By'] || row['Practitioner'] || '').trim();

    // Handle media file references: log filenames in notes
    const mediaCol = row['Media Files'] || row['Attachments'] || '';
    const mediaNotes = mediaCol.trim()
      ? mediaCol.split(/[;,]/).map(f => `Media: ${f.trim()} (attached in Tapestry)`).join('\n')
      : null;

    const staffNotes = [
      observedBy ? `Observed by: ${observedBy}` : null,
      mediaNotes,
    ].filter(Boolean).join('\n') || null;

    try {
      await client.query(
        `INSERT INTO ${S}.observations
           (child_id,title,observation_text,observation_type,staff_notes,created_at)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()))
         ON CONFLICT DO NOTHING`,
        [ch[0].id, title, bodyText || '[Imported from Tapestry]',
         obsType, staffNotes,
         obsDate ? `${obsDate}T09:00:00Z` : null]);
      result.observations.created++;
    } catch (err) {
      result.observations.errors.push({ row: i + 2, error: err.message });
      result.observations.skipped++;
    }
  }

  // ── 4. Attendance ─────────────────────────────────────────────────────────────
  for (const [i, row] of files.attendance.entries()) {
    const childName = (row['Child Name'] || row['Child'] || '').trim();
    if (!childName) { result.attendance.skipped++; continue; }
    const { first, last } = splitName(childName);
    const date = parseDMY(row['Date'] || '');
    if (!date) { result.attendance.skipped++; continue; }

    const { rows: ch } = await client.query(
      `SELECT id FROM ${S}.children WHERE lower(first_name)=lower($1) AND lower(last_name)=lower($2) AND is_active=true LIMIT 1`,
      [first, last]);
    if (!ch.length) {
      result.attendance.errors.push({ row: i + 2, error: `Child "${childName}" not found` });
      result.attendance.skipped++;
      continue;
    }

    const attendedRaw = (row['Attended'] || '').toLowerCase().trim();
    const absent = ['no', 'false', '0', 'absent', 'n'].includes(attendedRaw) ? true : false;
    const session = (row['Session'] || 'full_day').trim().toLowerCase().replace(/\s+/g, '_') || 'full_day';
    const absence_reason = (row['Absence Reason'] || row['Absence reason'] || '').trim() || null;

    try {
      await client.query(
        `INSERT INTO ${S}.attendance (child_id,date,session,absent,absence_reason)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (child_id,date,session) DO UPDATE
           SET absent=EXCLUDED.absent, absence_reason=COALESCE(EXCLUDED.absence_reason,attendance.absence_reason)`,
        [ch[0].id, date, session, absent, absence_reason]);
      result.attendance.created++;
    } catch (err) {
      result.attendance.errors.push({ row: i + 2, error: err.message });
      result.attendance.skipped++;
    }
  }

  return result;
}
module.exports.importBundle = importBundle;

// ── Totals helper ─────────────────────────────────────────────────────────────

function summarise(result) {
  let total = 0, imported = 0, skipped = 0;
  const errors = [];
  for (const [entity, r] of Object.entries(result)) {
    total    += r.created + r.updated + r.skipped;
    imported += r.created + r.updated;
    skipped  += r.skipped;
    errors.push(...r.errors.map(e => ({ entity, ...e })));
  }
  return { total, imported, skipped, errors };
}
module.exports.summarise = summarise;
