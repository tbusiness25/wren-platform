'use strict';
/**
 * b294 (2026-09-09) — bulk edit staff and children by CSV round-trip.
 *
 * Toby was correcting 18 staff email addresses one profile at a time. The flow
 * here is: download the rows currently on screen, edit them in a spreadsheet,
 * upload, see exactly which cells will change, and only then apply.
 *
 * The whole file is built around one idea: a CSV round-trip is a blunt
 * instrument, so the damage a bad paste can do is bounded by what it is allowed
 * to reach. Concretely —
 *
 *   • Rows are matched on `id` and nothing else. The build exists BECAUSE email
 *     addresses are wrong, so an email is not an identity. A file with no `id`
 *     column is refused outright.
 *   • An id that is not in the database is REJECTED, never inserted. This edits.
 *   • A blank cell means "no change". Clearing a field needs the literal
 *     `--CLEAR--`, so an accidentally emptied column cannot wipe 55 phone numbers.
 *   • Only the columns in FIELDS below can be written. Anything on BLOCKED_COLS
 *     (pin_hash, role, funding, invoice values, safeguarding, medical…) refuses
 *     the entire file by name. Changing a role or a funding figure needs a person
 *     on a screen that says what it means.
 *   • Validation happens before any write, and an upload with ANY rejected row is
 *     refused whole. A half-applied spreadsheet is worse than a rejected one.
 *   • Apply runs in one transaction and writes bulk_edit_batches +
 *     bulk_edit_changes (who, when, which rows, which fields, old → new), which
 *     is also what the undo replays.
 *
 * GDPR: the children export carries child and parent data. Manager-level only,
 * served as an attachment with no-store, never written to disk, and the download
 * itself is audited.
 */
const express      = require('express');
const crypto       = require('crypto');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
// b315 — the ONE room writer. A spreadsheet that moves children between rooms is
// a batch of room moves, not a batch of column writes.
const childRoom = require('../lib/child-room');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// Manager-level, matching the guard on Finance → Reconcile (src/routes/finance-reconcile.js).
// Deputy manager is included deliberately: the deputy runs the staff list day to day.
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner'];
router.use((req, res, next) => {
  if (!hasRole(req.user, MANAGER_ROLES)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

const CLEAR = '--CLEAR--';

// ── CSV ──────────────────────────────────────────────────────────────────────
// RFC4180-ish reader: quoted fields, doubled quotes, embedded commas and
// newlines, CR/CRLF, and a UTF-8 BOM (which Excel writes and which would
// otherwise turn the first header into "﻿id" and lose the id column).
function parseCSV(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', i = 0, inQ = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow   = () => { rows.push(row); row = []; };
  while (i < src.length) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { inQ = true; i++; continue; }
    if (c === ',')  { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { pushField(); pushRow(); }
  // Drop trailing rows that are entirely empty (a spreadsheet's blank tail).
  while (rows.length && rows[rows.length - 1].every(v => String(v).trim() === '')) rows.pop();
  return rows;
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function csvLine(arr) { return arr.map(csvCell).join(','); }

function normHeader(h) {
  return String(h || '').replace(/^﻿/, '').trim().toLowerCase()
    .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

// ── Dates ────────────────────────────────────────────────────────────────────
// pg returns DATE as a local-midnight JS Date. toISOString() shifts it back a
// day in BST and String() gives "Tue Sep 09 2026…" — use the local getters.
function ymd(v) {
  if (!v) return '';
  if (v instanceof Date) {
    const p = n => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  const s = String(v);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

// Accept YYYY-MM-DD or UK DD/MM/YYYY (what Excel writes back in a UK locale).
// Never build a Date from the raw string: new Date('05/08/2026') is 8 MAY.
function parseDateCell(raw) {
  const v = String(raw).trim();
  let y, m, d;
  let mt = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (mt) { [, y, m, d] = mt; }
  else {
    mt = v.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    if (!mt) return { error: 'not a date — use YYYY-MM-DD (or UK DD/MM/YYYY)' };
    [, d, m, y] = mt;
  }
  y = +y; m = +m; d = +d;
  if (m < 1 || m > 12 || d < 1 || d > 31) return { error: `not a real date: ${v}` };
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return { error: `not a real date: ${v}` };
  }
  const p = n => String(n).padStart(2, '0');
  return { value: `${y}-${p(m)}-${p(d)}` };
}

// ── Cell validators ──────────────────────────────────────────────────────────
function validEmail(v) {
  const s = String(v).trim();
  if (s.length > 254) return 'email is too long';
  if (!/^[^\s@,;]+@[^\s@,;]+\.[A-Za-z]{2,}$/.test(s)) return `"${s}" is not a valid email address`;
  return null;
}

// Excel silently strips the leading zero off a UK mobile ("07123456789" →
// 7123456789) and sometimes renders long numbers in scientific notation. Both
// would otherwise be written back as a plausible-looking wrong number, so both
// are rejected with the reason rather than saved.
function validPhone(v) {
  const s = String(v).trim();
  if (/e\+/i.test(s)) return `"${s}" looks like a spreadsheet turned the number into scientific notation — format the column as Text and re-enter it`;
  const digits = s.replace(/[^\d]/g, '');
  if (!digits) return `"${s}" has no digits in it`;
  if (digits.length < 7) return `"${s}" is too short to be a phone number`;
  if (digits.length > 15) return `"${s}" is too long to be a phone number`;
  if (!s.startsWith('+') && !s.startsWith('0') && /^[1-9]/.test(digits) && digits.length === 10) {
    return `"${s}" looks like it lost its leading zero in a spreadsheet — write it as 0${digits} or format the column as Text`;
  }
  if (!/^[\d\s()+-]+$/.test(s)) return `"${s}" contains characters that are not part of a phone number`;
  return null;
}

// "08:00-17:00" | "off". Blank = no change (handled by the caller).
function parsePatternCell(raw) {
  const v = String(raw).trim().toLowerCase();
  if (v === 'off' || v === 'not working' || v === 'none') return { is_off: true, start: null, end: null };
  const m = v.match(/^(\d{1,2}):(\d{2})\s*(?:-|–|to)\s*(\d{1,2}):(\d{2})$/);
  if (!m) return { error: `"${raw}" is not a shift — use 08:00-17:00, or "off"` };
  const [, h1, m1, h2, m2] = m;
  if (+h1 > 23 || +h2 > 23 || +m1 > 59 || +m2 > 59) return { error: `"${raw}" is not a real time` };
  const p = n => String(n).padStart(2, '0');
  const start = `${p(+h1)}:${m1}`, end = `${p(+h2)}:${m2}`;
  if (end <= start) return { error: `"${raw}" ends at or before it starts` };
  return { is_off: false, start, end };
}

function fmtPattern(row) {
  if (!row) return '';
  if (row.is_off) return 'off';
  if (!row.shift_start || !row.shift_end) return '';
  return `${String(row.shift_start).slice(0, 5)}-${String(row.shift_end).slice(0, 5)}`;
}

// ── Column blocklist ─────────────────────────────────────────────────────────
// Present in an uploaded file → the whole file is refused, by name. These are
// changes that need a person on a screen that says what they mean.
const BLOCKED_EXACT = new Set([
  'pin', 'pin_hash', 'pin_length', 'password', 'password_hash', 'token', 'totp_secret',
  'role', 'role_original', 'permissions', 'capabilities', 'scope', 'scope_value',
  'is_active', 'terminated', 'is_dsl', 'is_deputy_dsl', 'is_send_lead', 'can_publish',
  'inbox_access', 'counts_on_ratio', 'ratio_level',
  'ni_number', 'nhs_number', 'upn', 'tax_code', 'payroll_reference',
  // b303 — the HMRC starter-checklist answers. Payroll data about a named
  // employee, and the sort of thing that must come from the person themselves
  // on a form that explains what it is, never from a spreadsheet column.
  'starter_declaration', 'student_loan_plan', 'postgrad_loan', 'p45_provided',
  'hourly_rate', 'annual_salary', 'salary',
  'medical_notes', 'medicine', 'collection_password',
  'looked_after', 'court_order', 'court_order_details',
  'social_worker_name', 'social_worker_phone',
  'eylog_ref', 'eylog_child_id', 'eylog_group_id',
  'erased_at', 'erasure_request_id',
]);
const BLOCKED_PATTERNS = [
  /^dbs/, /^safeguard/, /^medicine/, /^medical/, /^fund/, /^invoice/, /^payment/,
  /^fee/, /^pension/, /^right_to_work/, /^visa/, /^sen_/, /^ehcp/, /^thirty_hour/,
  /^two_year_fund/, /^eligibility_code/, /^tfc_/, /_pence$/, /^amount/,
];
function blockedReason(h) {
  if (BLOCKED_EXACT.has(h)) return h;
  for (const re of BLOCKED_PATTERNS) if (re.test(h)) return h;
  return null;
}

// ── Field registry ───────────────────────────────────────────────────────────
// `key` is the CSV header. `column` writes straight to the table; the other
// kinds ('room', 'key_person', 'pattern') resolve a name to an id or write to a
// second table, and carry their own reader/writer below.
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];

const STAFF_FIELDS = [
  { key: 'first_name',     label: 'First name',     column: 'first_name',     kind: 'text', required: true },
  { key: 'last_name',      label: 'Last name',      column: 'last_name',      kind: 'text', required: true },
  { key: 'preferred_name', label: 'Preferred name', column: 'preferred_name', kind: 'text' },
  { key: 'email',          label: 'Email',          column: 'email',          kind: 'email', unique: true },
  { key: 'phone',          label: 'Phone',          column: 'phone',          kind: 'phone' },
  { key: 'job_title',      label: 'Job title',      column: 'job_title',      kind: 'text' },
  { key: 'room',           label: 'Room',           column: 'room_id',        kind: 'room' },
  { key: 'start_date',     label: 'Start date',     column: 'contract_start', kind: 'date' },
  ...DAYS.map((d, i) => ({
    key: `work_${d}`, label: `Work pattern — ${d[0].toUpperCase() + d.slice(1)}`,
    kind: 'pattern', day: i,
  })),
];

const CHILD_FIELDS = [
  { key: 'first_name',     label: 'First name',     column: 'first_name',     kind: 'text', required: true },
  { key: 'last_name',      label: 'Last name',      column: 'last_name',      kind: 'text', required: true },
  { key: 'preferred_name', label: 'Preferred name', column: 'preferred_name', kind: 'text' },
  { key: 'date_of_birth',  label: 'Date of birth',  column: 'date_of_birth',  kind: 'date' },
  { key: 'room',           label: 'Room',           column: 'room_id',        kind: 'room' },
  { key: 'key_person',     label: 'Key person',     column: 'key_person_id',  kind: 'key_person' },
  { key: 'start_date',     label: 'Start date',     column: 'start_date',     kind: 'date' },
  { key: 'parent_1_name',  label: 'Parent 1 name',  column: 'parent_1_name',  kind: 'text' },
  { key: 'parent_1_email', label: 'Parent 1 email', column: 'parent_1_email', kind: 'email' },
  { key: 'parent_1_phone', label: 'Parent 1 phone', column: 'parent_1_phone', kind: 'phone' },
  { key: 'parent_2_name',  label: 'Parent 2 name',  column: 'parent_2_name',  kind: 'text' },
  { key: 'parent_2_email', label: 'Parent 2 email', column: 'parent_2_email', kind: 'email' },
  { key: 'parent_2_phone', label: 'Parent 2 phone', column: 'parent_2_phone', kind: 'phone' },
  { key: 'allergies',      label: 'Allergies',      column: 'allergies',      kind: 'text' },
  { key: 'dietary',        label: 'Dietary',        column: 'dietary_requirements', kind: 'text' },
];

const ENTITIES = {
  staff: {
    table: 'staff', label: 'staff member', plural: 'staff',
    fields: STAFF_FIELDS,
    listSQL: `SELECT s.*, r.name AS room_name
                FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
               WHERE COALESCE(s.is_active, true) = true
               ORDER BY s.first_name, s.last_name`,
    byIdSQL: `SELECT s.*, r.name AS room_name
                FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
               WHERE s.id = ANY($1::int[])`,
  },
  children: {
    table: 'children', label: 'child', plural: 'children',
    fields: CHILD_FIELDS,
    listSQL: `SELECT c.*, r.name AS room_name,
                     k.first_name || ' ' || k.last_name AS key_person_name
                FROM children c
                LEFT JOIN rooms r ON r.id = c.room_id
                LEFT JOIN staff k ON k.id = c.key_person_id
               WHERE COALESCE(c.is_active, true) = true
               ORDER BY c.first_name, c.last_name`,
    byIdSQL: `SELECT c.*, r.name AS room_name,
                     k.first_name || ' ' || k.last_name AS key_person_name
                FROM children c
                LEFT JOIN rooms r ON r.id = c.room_id
                LEFT JOIN staff k ON k.id = c.key_person_id
               WHERE c.id = ANY($1::int[])`,
  },
};

function entityOr404(req, res) {
  const e = ENTITIES[req.params.entity];
  if (!e) { res.status(404).json({ error: 'Unknown entity — use staff or children' }); return null; }
  return e;
}

// Defence in depth: the UPDATE builder may only ever name a column that appears
// in the registry above. If a future edit ever lets something else through, this
// throws rather than writing it.
const WRITABLE_COLUMNS = {
  staff:    new Set(STAFF_FIELDS.filter(f => f.column).map(f => f.column)),
  children: new Set(CHILD_FIELDS.filter(f => f.column).map(f => f.column)),
};
function assertWritable(entity, col) {
  if (!WRITABLE_COLUMNS[entity].has(col)) {
    throw new Error(`refusing to write ${entity}.${col} — not on the CSV allowlist`);
  }
}

// ── Reading the current value, in the CSV's own text form ────────────────────
async function loadPatterns(db, staffIds) {
  const out = new Map(); // staff_id -> { dow -> row }
  if (!staffIds.length) return out;
  const { rows } = await db.query(
    `SELECT DISTINCT ON (staff_id, day_of_week)
            id, staff_id, day_of_week, shift_start::text AS shift_start,
            shift_end::text AS shift_end, is_off, effective_from
       FROM staff_work_patterns
      WHERE staff_id = ANY($1::int[]) AND effective_to IS NULL
        AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
      ORDER BY staff_id, day_of_week, effective_from DESC, id DESC`, [staffIds]);
  for (const r of rows) {
    if (!out.has(r.staff_id)) out.set(r.staff_id, {});
    out.get(r.staff_id)[r.day_of_week] = r;
  }
  return out;
}

function currentValue(field, row, ctx) {
  switch (field.kind) {
    case 'date':       return ymd(row[field.column]);
    case 'room':       return row.room_name || '';
    case 'key_person': return row.key_person_name || '';
    case 'pattern':    return fmtPattern((ctx.patterns.get(row.id) || {})[field.day]);
    default:           return row[field.column] == null ? '' : String(row[field.column]);
  }
}

async function buildContext(db, entity, rows) {
  const ctx = { rooms: [], staffByName: new Map(), patterns: new Map() };
  const { rows: rooms } = await db.query('SELECT id, name FROM rooms ORDER BY id');
  ctx.rooms = rooms;
  if (entity === 'staff') {
    ctx.patterns = await loadPatterns(db, rows.map(r => r.id));
  }
  if (entity === 'children') {
    const { rows: staff } = await db.query(
      `SELECT id, first_name, last_name FROM staff
        WHERE COALESCE(is_active, true) = true AND COALESCE(terminated, false) = false`);
    for (const s of staff) {
      const k = `${s.first_name} ${s.last_name}`.trim().toLowerCase();
      if (!ctx.staffByName.has(k)) ctx.staffByName.set(k, []);
      ctx.staffByName.get(k).push(s);
    }
  }
  return ctx;
}

// ── GET /api/bulk-edit/:entity/fields ────────────────────────────────────────
// What the CSV round-trip can and cannot touch — the UI renders its help text
// from this rather than keeping a second copy of the list.
router.get('/:entity/fields', (req, res) => {
  const ent = entityOr404(req, res); if (!ent) return;
  res.json({
    entity: req.params.entity,
    clear_sentinel: CLEAR,
    columns: [{ key: 'id', label: 'id', editable: false, note: 'the match key — never changed, never deleted' }]
      .concat(ent.fields.map(f => ({ key: f.key, label: f.label, editable: true, required: !!f.required }))),
    blocked_note: 'pin, password, role, permissions, safeguarding, medical, DBS, funding, invoice and payment ' +
                  'columns are refused: those changes need a person on a screen that says what they mean.',
  });
});

// ── GET /api/bulk-edit/:entity/export.csv ────────────────────────────────────
// The rows currently on screen (?ids=1,2,3) or every active row. Served as an
// attachment with no-store — never written to disk — and audited.
router.get('/:entity/export.csv', async (req, res) => {
  const ent = entityOr404(req, res); if (!ent) return;
  const entity = req.params.entity;
  const db = getPool();
  try {
    let rows;
    const idsRaw = String(req.query.ids || '').trim();
    if (idsRaw) {
      const ids = idsRaw.split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n));
      if (!ids.length) return res.status(400).json({ error: 'ids= was given but held no numbers' });
      if (ids.length > 5000) return res.status(400).json({ error: 'too many ids in one export' });
      ({ rows } = await db.query(ent.byIdSQL, [ids]));
      const order = new Map(ids.map((id, i) => [id, i]));
      rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    } else {
      ({ rows } = await db.query(ent.listSQL));
    }
    const ctx = await buildContext(db, entity, rows);
    const header = ['id', ...ent.fields.map(f => f.key)];
    const lines = [csvLine(header)];
    for (const row of rows) {
      lines.push(csvLine([row.id, ...ent.fields.map(f => currentValue(f, row, ctx))]));
    }
    const stamp = ymd(new Date());
    const name = `${entity}-bulk-edit-${stamp}.csv`;
    recordAudit({
      req, action: 'export', entity_type: entity === 'staff' ? 'staff' : 'child',
      meta: { feature: 'bulk-edit', rows: rows.length, filtered: !!idsRaw },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // A UTF-8 BOM so Excel reads accented names correctly; parseCSV strips it again.
    res.send('﻿' + lines.join('\r\n') + '\r\n');
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── The heart: read a CSV, work out what would change, and why a row cannot ───
async function analyse(db, entity, csvText) {
  const ent = ENTITIES[entity];
  const grid = parseCSV(csvText);
  if (!grid.length) return { fatal: { error: 'empty_file', message: 'That file had no rows in it.' } };

  const rawHeaders = grid[0].map(normHeader);
  const dataRows   = grid.slice(1);

  // Blocked columns refuse the whole file, by name.
  const blocked = [...new Set(rawHeaders.map(blockedReason).filter(Boolean))];
  if (blocked.length) {
    return { fatal: {
      error: 'blocked_columns', columns: blocked,
      message: `This file contains ${blocked.length > 1 ? 'columns' : 'a column'} that a CSV upload is never ` +
               `allowed to change: ${blocked.join(', ')}. Delete ${blocked.length > 1 ? 'them' : 'it'} and upload ` +
               `again — roles, PINs, funding, safeguarding and medical details are changed on their own screens.`,
    } };
  }

  if (!rawHeaders.includes('id')) {
    return { fatal: {
      error: 'missing_id_column',
      message: 'There is no "id" column. Rows are matched on id and nothing else — ' +
               'an email address is exactly the thing being corrected, so it cannot be the key. ' +
               'Download a fresh CSV and keep the id column.',
    } };
  }

  const dupHeaders = rawHeaders.filter((h, i) => h && rawHeaders.indexOf(h) !== i);
  if (dupHeaders.length) {
    return { fatal: {
      error: 'duplicate_columns', columns: [...new Set(dupHeaders)],
      message: `The column ${[...new Set(dupHeaders)].join(', ')} appears more than once.`,
    } };
  }

  const known = new Map(ent.fields.map(f => [f.key, f]));
  const present = [];      // { field, index }
  const ignored = [];
  rawHeaders.forEach((h, i) => {
    if (!h || h === 'id') return;
    if (known.has(h)) present.push({ field: known.get(h), index: i });
    else ignored.push(h);
  });

  const idIndex = rawHeaders.indexOf('id');
  const rejects = [];
  const parsed  = [];      // { id, lineNo }
  const seenIds = new Map();

  dataRows.forEach((cells, n) => {
    const lineNo = n + 2;                                     // 1-based, header is line 1
    if (cells.every(v => String(v).trim() === '')) return;    // blank spacer row
    const idRaw = String(cells[idIndex] ?? '').trim();
    if (!idRaw) { rejects.push({ line: lineNo, id: null, cell: 'id', reason: 'this row has no id, so there is nothing to match it to' }); return; }
    if (!/^\d+$/.test(idRaw)) { rejects.push({ line: lineNo, id: idRaw, cell: 'id', reason: `"${idRaw}" is not an id` }); return; }
    const id = parseInt(idRaw, 10);
    if (seenIds.has(id)) { rejects.push({ line: lineNo, id, cell: 'id', reason: `id ${id} also appears on line ${seenIds.get(id)}` }); return; }
    seenIds.set(id, lineNo);
    parsed.push({ id, lineNo, cells });
  });

  const ids = parsed.map(p => p.id);
  const { rows: dbRows } = ids.length ? await db.query(ent.byIdSQL, [ids]) : { rows: [] };
  const byId = new Map(dbRows.map(r => [r.id, r]));
  const ctx  = await buildContext(db, entity, dbRows);

  const roomByName = new Map(ctx.rooms.map(r => [r.name.trim().toLowerCase(), r]));

  const changes = [];        // { id, line, name, field, label, old, new, column|day }
  const unchanged = [];

  for (const p of parsed) {
    const row = byId.get(p.id);
    if (!row) {
      rejects.push({ line: p.lineNo, id: p.id, cell: 'id',
        reason: `no ${ent.label} with id ${p.id} — an upload edits rows, it never creates them` });
      continue;
    }
    const displayName = `${row.first_name || ''} ${row.last_name || ''}`.trim();
    const rowChanges = [];
    let rowRejected = false;

    for (const { field, index } of present) {
      const raw = String(p.cells[index] ?? '');
      if (raw.trim() === '') continue;                        // blank = no change

      const clearing = raw.trim() === CLEAR;
      const oldVal = currentValue(field, row, ctx);
      let newVal, extra = {};

      if (clearing) {
        if (field.required) {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key,
            reason: `${field.label} cannot be cleared — every ${ent.label} needs one` });
          rowRejected = true; continue;
        }
        if (field.kind === 'pattern') {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key,
            reason: 'a work pattern cannot be blanked — write "off" to record a non-working day' });
          rowRejected = true; continue;
        }
        newVal = '';
      } else if (field.kind === 'date') {
        const d = parseDateCell(raw);
        if (d.error) {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key, reason: `${field.label}: ${d.error}` });
          rowRejected = true; continue;
        }
        newVal = d.value;
      } else if (field.kind === 'email') {
        const err = validEmail(raw);
        if (err) {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key, reason: `${field.label}: ${err}` });
          rowRejected = true; continue;
        }
        newVal = raw.trim();
      } else if (field.kind === 'phone') {
        const err = validPhone(raw);
        if (err) {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key, reason: `${field.label}: ${err}` });
          rowRejected = true; continue;
        }
        newVal = raw.trim();
      } else if (field.kind === 'room') {
        const room = roomByName.get(raw.trim().toLowerCase());
        if (!room) {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key,
            reason: `there is no room called "${raw.trim()}" — the rooms are ${ctx.rooms.map(r => r.name).join(', ')}` });
          rowRejected = true; continue;
        }
        newVal = room.name; extra.resolved_id = room.id;
      } else if (field.kind === 'key_person') {
        const hits = ctx.staffByName.get(raw.trim().toLowerCase()) || [];
        if (!hits.length) {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key,
            reason: `no active staff member called "${raw.trim()}" — write the key person's full name exactly as it appears on the staff list` });
          rowRejected = true; continue;
        }
        if (hits.length > 1) {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key,
            reason: `"${raw.trim()}" matches ${hits.length} staff members — this cell cannot say which` });
          rowRejected = true; continue;
        }
        newVal = `${hits[0].first_name} ${hits[0].last_name}`.trim();
        extra.resolved_id = hits[0].id;
      } else if (field.kind === 'pattern') {
        const pat = parsePatternCell(raw);
        if (pat.error) {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key, reason: `${field.label}: ${pat.error}` });
          rowRejected = true; continue;
        }
        newVal = pat.is_off ? 'off' : `${pat.start}-${pat.end}`;
        extra.pattern = pat;
      } else {
        newVal = raw.trim();
        if (newVal.length > 500) {
          rejects.push({ line: p.lineNo, id: p.id, name: displayName, cell: field.key, reason: `${field.label} is longer than 500 characters` });
          rowRejected = true; continue;
        }
      }

      if (String(newVal) === String(oldVal)) continue;        // already correct
      rowChanges.push({
        id: p.id, line: p.lineNo, name: displayName,
        field: field.key, label: field.label,
        old: oldVal, new: newVal,
        column: field.column || null, kind: field.kind, day: field.day,
        ...extra,
      });
    }

    if (rowRejected) continue;
    if (rowChanges.length) changes.push(...rowChanges);
    else unchanged.push({ id: p.id, line: p.lineNo, name: displayName });
  }

  // Uniqueness that the database enforces anyway — caught here so it reads as a
  // named cell rather than a constraint violation halfway through the write.
  const uniqueFields = ent.fields.filter(f => f.unique);
  for (const f of uniqueFields) {
    const proposed = changes.filter(c => c.field === f.key);
    const seen = new Map();
    for (const c of proposed) {
      const k = String(c.new).toLowerCase();
      if (seen.has(k)) {
        rejects.push({ line: c.line, id: c.id, name: c.name, cell: f.key,
          reason: `${f.label} "${c.new}" is also on line ${seen.get(k)} — it can only belong to one ${ent.label}` });
      } else seen.set(k, c.line);
    }
    if (proposed.length) {
      const { rows: clashes } = await db.query(
        `SELECT id, ${f.column} AS v FROM ${ent.table}
          WHERE lower(${f.column}) = ANY($1::text[]) AND NOT (id = ANY($2::int[]))`,
        [proposed.map(c => String(c.new).toLowerCase()), proposed.map(c => c.id)]);
      const clashBy = new Map(clashes.map(r => [String(r.v).toLowerCase(), r.id]));
      for (const c of proposed) {
        const other = clashBy.get(String(c.new).toLowerCase());
        if (other != null) {
          rejects.push({ line: c.line, id: c.id, name: c.name, cell: f.key,
            reason: `${f.label} "${c.new}" already belongs to ${ent.label} #${other}` });
        }
      }
    }
  }

  // If a uniqueness check rejected a row, its other changes must not be applied.
  const rejectedIds = new Set(rejects.map(r => r.id).filter(v => v != null));
  const applicable  = changes.filter(c => !rejectedIds.has(c.id));

  const changedIds = [...new Set(applicable.map(c => c.id))];
  const checksum = crypto.createHash('sha256')
    .update(entity + '\n' + JSON.stringify(applicable.map(c => [c.id, c.field, c.old, c.new])))
    .digest('hex');

  return {
    entity,
    columns_read: present.map(p => p.field.key),
    ignored_columns: ignored,
    counts: {
      rows_in_file: parsed.length,
      rows_changed: changedIds.length,
      cells_changed: applicable.length,
      rows_unchanged: unchanged.length,
      rows_rejected: new Set(rejects.map(r => r.line)).size,
    },
    changes: applicable,
    rejects,
    checksum,
  };
}

// ── POST /api/bulk-edit/:entity/preview ──────────────────────────────────────
// Nothing is written. Returns exactly what would change, cell by cell.
router.post('/:entity/preview', async (req, res) => {
  const ent = entityOr404(req, res); if (!ent) return;
  const csvText = req.body && req.body.csv;
  if (typeof csvText !== 'string' || !csvText.trim()) {
    return res.status(400).json({ error: 'no_csv', message: 'Nothing was uploaded.' });
  }
  try {
    const out = await analyse(getPool(), req.params.entity, csvText);
    if (out.fatal) return res.status(422).json(out.fatal);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/bulk-edit/:entity/apply ────────────────────────────────────────
// All-or-nothing. Refuses if anything was rejected, and refuses if the database
// moved between the preview and this call (the checksum covers every old value).
router.post('/:entity/apply', async (req, res) => {
  const ent = entityOr404(req, res); if (!ent) return;
  const entity = req.params.entity;
  const csvText = req.body && req.body.csv;
  const claimed = req.body && req.body.checksum;
  const filename = (req.body && req.body.filename) ? String(req.body.filename).slice(0, 200) : null;
  if (typeof csvText !== 'string' || !csvText.trim()) {
    return res.status(400).json({ error: 'no_csv', message: 'Nothing was uploaded.' });
  }
  const db = getPool();
  // The analysis runs on the SAME connection, inside the SAME transaction as the
  // writes. Reading with the pool and then writing with a client leaves a window
  // in which another screen edits one of these records between the two — the
  // checksum would still match and the change would be silently overwritten.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await analyse(client, entity, csvText);

    if (out.fatal) { await client.query('ROLLBACK'); return res.status(422).json(out.fatal); }

    if (out.rejects.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'rejected_rows', rejects: out.rejects,
        message: `${out.counts.rows_rejected} row(s) could not be read, so nothing was applied. ` +
                 'Fix those cells in the spreadsheet and upload again.',
      });
    }
    if (claimed && claimed !== out.checksum) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'stale_preview',
        message: 'Someone changed one of these records since the preview was taken, so nothing was applied. ' +
                 'Upload the file again to see a fresh preview.',
      });
    }
    if (!out.changes.length) {
      await client.query('ROLLBACK');
      return res.json({ ok: true, batch_id: null, applied: 0, message: 'Nothing to change — every cell already matched.' });
    }

    const { rows: [batch] } = await client.query(
      `INSERT INTO bulk_edit_batches
         (entity, actor_id, actor_name, filename, rows_in_file, rows_changed, cells_changed, kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'apply') RETURNING id, created_at`,
      [entity, req.user?.id || null, req.user?.name || null, filename,
       out.counts.rows_in_file, out.counts.rows_changed, out.counts.cells_changed]);

    await applyChanges(client, entity, out.changes, batch.id, req.user?.id || null);
    await client.query('COMMIT');

    recordAudit({
      req, action: 'update', entity_type: entity === 'staff' ? 'staff' : 'child',
      meta: { feature: 'bulk-edit', batch_id: batch.id,
              rows: out.counts.rows_changed, cells: out.counts.cells_changed,
              fields: [...new Set(out.changes.map(c => c.field))] },
    });

    res.json({
      ok: true, batch_id: batch.id,
      applied: out.counts.cells_changed, rows: out.counts.rows_changed,
      unchanged: out.counts.rows_unchanged,
      changes: out.changes.map(c => ({ id: c.id, name: c.name, field: c.field, label: c.label, old: c.old, new: c.new })),
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already gone */ }
    res.status(500).json({ error: e.message, message: 'Nothing was applied — the whole upload was rolled back.' });
  } finally {
    client.release();
  }
});

// Writes one batch of changes inside an existing transaction, and records every
// cell in bulk_edit_changes. Column writes are grouped per row so a row is one
// UPDATE; pattern writes go to staff_work_patterns.
async function applyChanges(client, entity, changes, batchId, actorId) {
  const ent = ENTITIES[entity];
  const byRow = new Map();
  for (const c of changes) {
    if (!byRow.has(c.id)) byRow.set(c.id, []);
    byRow.get(c.id).push(c);
  }
  for (const [id, list] of byRow) {
    const sets = [], params = [];
    for (const c of list) {
      if (c.kind === 'pattern') continue;
      assertWritable(entity, c.column);
      let value;
      if (c.new === '') value = null;
      else if (c.kind === 'room' || c.kind === 'key_person') value = c.resolved_id;
      else value = c.new;
      params.push(value);
      sets.push(`${c.column} = $${params.length}`);
    }
    // b315 — a bulk edit that changes a CHILD's room is a room move like any
    // other, and this loop wrote children.room_id and nothing else: the booking
    // stayed in the old room, so occupancy, the ratios and the forecast never
    // heard about a whole spreadsheet of moves. Read the room BEFORE the UPDATE;
    // afterwards nothing on the row remembers where they came from.
    const roomChange = entity === 'children'
      ? list.find(c => c.kind === 'room' && c.resolved_id != null) : null;
    let prevRoomId = null;
    if (roomChange) {
      const { rows: pr } = await client.query('SELECT room_id FROM children WHERE id = $1', [id]);
      prevRoomId = pr.length ? pr[0].room_id : null;
    }

    if (sets.length) {
      params.push(id);
      const sql = `UPDATE ${ent.table} SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length}`;
      const r = await client.query(sql, params);
      if (r.rowCount !== 1) throw new Error(`expected to update exactly one ${ent.label} (id ${id}), updated ${r.rowCount}`);
    }

    // The one room writer, inside this batch's transaction so an undo still
    // rolls the whole thing back together.
    if (roomChange && Number(prevRoomId) !== Number(roomChange.resolved_id)) {
      await childRoom.setChildRoom(client, {
        childId: id, toRoomId: roomChange.resolved_id, fromRoomId: prevRoomId,
        actorId, source: 'bulk-edit',
      });
    }

    for (const c of list) {
      if (c.kind !== 'pattern') continue;
      await writePattern(client, id, c);
    }
  }
  for (const c of changes) {
    await client.query(
      `INSERT INTO bulk_edit_changes (batch_id, entity, entity_id, field, old_value, new_value)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [batchId, entity, c.id, c.field, c.old === '' ? null : c.old, c.new === '' ? null : c.new]);
  }
}

// A CSV corrects the record of a work pattern; it does not declare a new
// contractual pattern starting today. So the CURRENT row for that weekday is
// updated in place (which is also what makes the undo exactly reversible), and
// a row is only created when the weekday has none.
async function writePattern(client, staffId, change) {
  const pat = change.pattern || parsePatternCell(change.new);
  if (pat.error) throw new Error(pat.error);
  const { rows } = await client.query(
    `SELECT id FROM staff_work_patterns
      WHERE staff_id = $1 AND day_of_week = $2 AND effective_to IS NULL
        AND (effective_from IS NULL OR effective_from <= CURRENT_DATE)
      ORDER BY effective_from DESC, id DESC LIMIT 1`, [staffId, change.day]);
  if (rows.length) {
    await client.query(
      `UPDATE staff_work_patterns
          SET shift_start = $2, shift_end = $3, is_off = $4,
              lunch_break_minutes = CASE WHEN $4 THEN 0 ELSE COALESCE(lunch_break_minutes, 60) END,
              updated_at = now()
        WHERE id = $1`,
      [rows[0].id, pat.start, pat.end, pat.is_off]);
  } else {
    await client.query(
      `INSERT INTO staff_work_patterns
         (staff_id, day_of_week, shift_start, shift_end, is_off, lunch_break_minutes, effective_from)
       VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE)
       ON CONFLICT (staff_id, day_of_week, effective_from)
       DO UPDATE SET shift_start = EXCLUDED.shift_start, shift_end = EXCLUDED.shift_end,
                     is_off = EXCLUDED.is_off, effective_to = NULL, updated_at = now()`,
      [staffId, change.day, pat.start, pat.end, pat.is_off, pat.is_off ? 0 : 60]);
  }
}

// ── GET /api/bulk-edit/batches ───────────────────────────────────────────────
// "What did that upload do?", the next morning.
router.get('/batches', async (req, res) => {
  const db = getPool();
  const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
  try {
    const params = [limit];
    let where = '';
    if (req.query.entity && ENTITIES[req.query.entity]) { params.unshift(req.query.entity); where = 'WHERE b.entity = $1'; }
    const { rows } = await db.query(
      `SELECT b.*, s.first_name || ' ' || s.last_name AS actor_display
         FROM bulk_edit_batches b
         LEFT JOIN staff s ON s.id = b.actor_id
         ${where}
        ORDER BY b.created_at DESC
        LIMIT $${params.length}`, params);
    res.json({ batches: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/batches/:id', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });
  try {
    const { rows: [batch] } = await db.query(
      `SELECT b.*, s.first_name || ' ' || s.last_name AS actor_display
         FROM bulk_edit_batches b LEFT JOIN staff s ON s.id = b.actor_id
        WHERE b.id = $1`, [id]);
    if (!batch) return res.status(404).json({ error: 'Not found' });
    const { rows: changes } = await db.query(
      `SELECT * FROM bulk_edit_changes WHERE batch_id = $1 ORDER BY entity_id, field`, [id]);
    res.json({ batch, changes });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/bulk-edit/batches/:id/undo ─────────────────────────────────────
// Replays old_value back over every cell the batch changed. Refuses whole if any
// of those cells has moved on since — an undo that silently clobbers someone
// else's later correction is worse than one that stops and says so.
router.post('/batches/:id/undo', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Not found' });

  // Everything — the drift check and the reversal — happens on one connection
  // inside one transaction, for the same reason apply does.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: [batch] } = await client.query('SELECT * FROM bulk_edit_batches WHERE id = $1 FOR UPDATE', [id]);
    const bail = (status, body) => client.query('ROLLBACK').then(() => res.status(status).json(body));
    if (!batch)            return await bail(404, { error: 'Not found' });
    if (batch.undone_at)   return await bail(409, { error: 'already_undone', message: 'That upload has already been undone.' });
    if (batch.kind === 'undo') return await bail(409, { error: 'is_an_undo', message: 'That entry is itself an undo.' });

    const entity = batch.entity;
    const ent = ENTITIES[entity];
    if (!ent) return await bail(400, { error: 'unknown_entity' });

    const { rows: changes } = await client.query(
      'SELECT * FROM bulk_edit_changes WHERE batch_id = $1 ORDER BY id', [id]);
    if (!changes.length) return await bail(409, { error: 'nothing_to_undo' });

    const ids = [...new Set(changes.map(c => c.entity_id))];
    const { rows: dbRows } = await client.query(ent.byIdSQL, [ids]);
    const byId = new Map(dbRows.map(r => [r.id, r]));
    const ctx  = await buildContext(client, entity, dbRows);
    const fieldByKey = new Map(ent.fields.map(f => [f.key, f]));
    const roomByName = new Map(ctx.rooms.map(r => [r.name.trim().toLowerCase(), r]));

    const drifted = [], reverse = [];
    for (const c of changes) {
      const row = byId.get(c.entity_id);
      const field = fieldByKey.get(c.field);
      if (!row || !field) { drifted.push({ id: c.entity_id, field: c.field, reason: 'the record no longer exists' }); continue; }
      const now = currentValue(field, row, ctx);
      const expect = c.new_value == null ? '' : c.new_value;
      if (String(now) !== String(expect)) {
        drifted.push({ id: c.entity_id, name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
          field: c.field, expected: expect, found: now,
          reason: 'this has been changed again since the upload' });
        continue;
      }
      const back = c.old_value == null ? '' : c.old_value;
      if (field.required && back === '') {
        drifted.push({ id: c.entity_id, field: c.field, reason: `${field.label} cannot be put back to empty` });
        continue;
      }
      const rev = {
        id: c.entity_id, name: `${row.first_name || ''} ${row.last_name || ''}`.trim(),
        field: field.key, label: field.label, old: expect, new: back,
        column: field.column || null, kind: field.kind, day: field.day,
      };
      if (field.kind === 'room' && back !== '') {
        const room = roomByName.get(back.trim().toLowerCase());
        if (!room) { drifted.push({ id: c.entity_id, field: c.field, reason: `the room "${back}" no longer exists` }); continue; }
        rev.resolved_id = room.id;
      }
      if (field.kind === 'key_person' && back !== '') {
        const hits = ctx.staffByName.get(back.trim().toLowerCase()) || [];
        if (hits.length !== 1) { drifted.push({ id: c.entity_id, field: c.field, reason: `"${back}" no longer matches exactly one staff member` }); continue; }
        rev.resolved_id = hits[0].id;
      }
      if (field.kind === 'pattern') {
        if (back === '') { drifted.push({ id: c.entity_id, field: c.field, reason: 'there was no work pattern recorded before this upload, and an undo cannot remove one' }); continue; }
        const pat = parsePatternCell(back);
        if (pat.error) { drifted.push({ id: c.entity_id, field: c.field, reason: pat.error }); continue; }
        rev.pattern = pat;
      }
      reverse.push(rev);
    }

    if (drifted.length) {
      return await bail(409, {
        error: 'drifted', drifted,
        message: `${drifted.length} of these cells has changed since the upload, so nothing was undone.`,
      });
    }

    const { rows: [undoBatch] } = await client.query(
      `INSERT INTO bulk_edit_batches
         (entity, actor_id, actor_name, filename, rows_in_file, rows_changed, cells_changed, kind, reverses_batch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'undo',$8) RETURNING id`,
      [entity, req.user?.id || null, req.user?.name || null, `undo of upload #${id}`,
       ids.length, new Set(reverse.map(r => r.id)).size, reverse.length, id]);
    await applyChanges(client, entity, reverse, undoBatch.id, req.user?.id || null);
    await client.query('UPDATE bulk_edit_batches SET undone_at = now(), undone_by = $2 WHERE id = $1',
      [id, req.user?.id || null]);
    await client.query('COMMIT');

    recordAudit({ req, action: 'update', entity_type: entity === 'staff' ? 'staff' : 'child',
      meta: { feature: 'bulk-edit-undo', batch_id: id, undo_batch_id: undoBatch.id, cells: reverse.length } });
    res.json({ ok: true, undo_batch_id: undoBatch.id, reverted: reverse.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* the transaction is already gone */ }
    res.status(500).json({ error: e.message, message: 'Nothing was undone — the whole reversal was rolled back.' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports._internals = { parseCSV, parseDateCell, validEmail, validPhone, parsePatternCell, ymd, normHeader, blockedReason };
