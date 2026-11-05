'use strict';
/**
 * b363 (2026-09-29) — payroll details import: BrightHR CSV → ladn.staff.
 *
 * Toby: "I'll try and get a CSV report from Bright and upload missing fields."
 *
 * WHY THIS IS NOT src/routes/bulk-edit.js
 * ---------------------------------------------------------------------------
 * b294's CSV round-trip REFUSES pay, tax and ID columns by name — ni_number,
 * tax_code, payroll_reference, hourly_rate, annual_salary are all on its
 * BLOCKED_EXACT list and a file carrying one is rejected whole. That is correct
 * and stays. This is a second, narrower door: one screen, gated on
 * canViewSalaries() (owner / admin / headteacher / business_manager — NOT the
 * deputy, see src/lib/capabilities.js), which can write the payroll fields and
 * nothing else.
 *
 * THE FIVE RULES THIS FILE IMPLEMENTS
 * ---------------------------------------------------------------------------
 *  1. A preview writes NOTHING. No table is touched until apply, so a file you
 *     are unsure about can be checked as often as you like.
 *  2. Blanks are filled; a value already on file is left alone unless that
 *     exact field, for that exact person, has been ticked. "Fill the gaps" and
 *     "overwrite the payroll data" are different actions and only one of them
 *     is the default.
 *  3. A row is matched on an identifier, never guessed. BrightHR employee id →
 *     payroll number → email → exact first+last name, in that order, and every
 *     row says which one it matched on. Two people matching the same row is a
 *     refusal, not a coin toss.
 *  4. A value that is not the right shape is refused with the reason, and the
 *     rest of the file still applies. (This differs from b294 deliberately: an
 *     HR export arrives with one odd cell in it and holding back 60 good fields
 *     over one bad one is how a payroll run ends up wrong anyway.)
 *  5. The writable column list is a closed allowlist, asserted per write.
 *     pin_hash, protected_staff_pins, role, email, totp_* and every other login
 *     field are not on it and cannot be reached through it — including for
 *     staff id 1, whose pay and tax fields ARE writable here (Toby asked) while
 *     his login fields are not.
 *
 * GDPR: this module reads and returns staff payroll data — NI numbers, dates of
 * birth, home addresses, pay. Every caller must be behind canViewSalaries().
 * Nothing here logs a value to stdout, and `maskFor()` is what goes into
 * payroll_import_changes and the audit diff (see feedback_counts_only_every_write_path).
 */

const crypto = require('crypto');
const { normaliseNi } = require('./hmrc-starter');

// ── CSV ─────────────────────────────────────────────────────────────────────
// RFC4180-ish: quoted fields, doubled quotes, embedded commas and newlines,
// CR/CRLF, and a UTF-8 BOM (which Excel writes, and which would otherwise turn
// the first header into "﻿Employee ID" and lose the match column).
//
// The delimiter is sniffed rather than assumed. A UK HR system exporting for
// Excel on a machine with a European locale writes semicolons, and a file whose
// every row is one giant field is not a useful error message.
function sniffDelimiter(text) {
  const firstLine = String(text || '').replace(/^﻿/, '').split(/\r?\n/)[0] || '';
  let best = ',', bestN = 0;
  for (const d of [',', ';', '\t', '|']) {
    // Count only delimiters outside quotes on the header line.
    let n = 0, inQ = false;
    for (let i = 0; i < firstLine.length; i++) {
      const c = firstLine[i];
      if (c === '"') { inQ = !inQ; continue; }
      if (!inQ && c === d) n++;
    }
    if (n > bestN) { bestN = n; best = d; }
  }
  return best;
}

function parseCSV(text, delim) {
  const src = String(text || '').replace(/^﻿/, '');
  const d = delim || sniffDelimiter(src);
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
    if (c === d)    { pushField(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { pushField(); pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length) { pushField(); pushRow(); }
  return rows.map(r => r.map(v => v.trim()));
}

/** Header text → a comparable key. 'NI Number *' and 'ni_number' are the same column. */
function normHeader(h) {
  return String(h == null ? '' : h)
    .replace(/^﻿/, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')          // "Salary (annual)" → "salary"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * A stable fingerprint of a header ROW, ignoring column order.
 * The same report with its columns rearranged is the same report, and should map
 * itself without being re-taught.
 */
function headerSignature(headers) {
  const norm = (headers || []).map(normHeader).filter(Boolean).sort();
  return crypto.createHash('sha256').update(norm.join(',')).digest('hex');
}

// ── Validators ──────────────────────────────────────────────────────────────
// Every failure names the ACTUAL problem. "Invalid" tells the person holding the
// spreadsheet nothing, and they upload the same file again.

// UK tax codes. Optional S (Scotland) or C (Wales) prefix, then one of:
//   digits + L/M/N/T   (1257L)      0T      BR      D0/D1/D2      NT      K + digits
// and an optional non-cumulative marker W1 / M1 / X.
const TAX_CODE_RE = /^([SC])?(\d{1,4}[LMNT]|0T|BR|D[0-8]|NT|K\d{1,4})\s*(W1|M1|X)?$/;

// GOV.UK's own postcode pattern, plus the GIR 0AA special case.
const POSTCODE_RE = /^(GIR ?0AA|[A-PR-UWYZ]([0-9]{1,2}|([A-HK-Y][0-9]([0-9ABEHMNPRV-Y])?)|[0-9][A-HJKPS-UW]) ?[0-9][ABD-HJLNP-UW-Z]{2})$/;

const CONTRACT_TYPE_MAP = new Map([
  ['hourly', 'hourly'], ['hourly paid', 'hourly'], ['hourly rate', 'hourly'],
  ['hourly pay', 'hourly'], ['waged', 'hourly'], ['wage', 'hourly'], ['wages', 'hourly'],
  ['hour', 'hourly'], ['per hour', 'hourly'], ['variable', 'hourly'],
  ['salaried', 'salaried'], ['salary', 'salaried'], ['annual', 'salaried'],
  ['annual salary', 'salaried'], ['fixed', 'salaried'], ['fixed salary', 'salaried'],
  ['monthly salary', 'salaried'], ['monthly', 'salaried'], ['per annum', 'salaried'],
]);

// The vocabulary already in ladn.staff.employment_type via b229's importer
// (src/lib/importers/brighthr.js → EMPLOYMENT_TYPE_MAP). Same four values, but
// an unknown one is REFUSED here instead of silently becoming 'permanent':
// an import that quietly turns "Apprentice" into "permanent" has told a lie
// about somebody's contract.
const EMPLOYMENT_TYPE_MAP = new Map([
  ['full time', 'permanent'], ['fulltime', 'permanent'], ['permanent', 'permanent'],
  ['permanent full time', 'permanent'], ['contracted', 'permanent'],
  ['part time', 'part_time'], ['parttime', 'part_time'], ['permanent part time', 'part_time'],
  ['temporary', 'temporary'], ['fixed term', 'temporary'], ['fixed term contract', 'temporary'],
  ['temp', 'temporary'], ['maternity cover', 'temporary'],
  ['bank', 'bank'], ['zero hours', 'bank'], ['zero hour', 'bank'], ['casual', 'bank'],
  ['relief', 'bank'], ['as and when', 'bank'],
]);

const PENSION_TRUE = new Set([
  'yes', 'y', 'true', '1', 'enrolled', 'auto enrolled', 'auto enrolment', 'auto enroled',
  'active', 'opted in', 'opt in', 'member', 'in scheme', 'in', 'eligible', 'joined',
  'contributing', 'enrolled nest', 'nest',
]);
const PENSION_FALSE = new Set([
  'no', 'n', 'false', '0', 'not enrolled', 'opted out', 'opt out', 'opted-out',
  'not eligible', 'ineligible', 'none', 'n a', 'na', 'exempt', 'not a member', 'out',
  'declined', 'left scheme',
]);
// Postponement is a real auto-enrolment state and it is NOT "enrolled". It lands
// as false with a warning rather than a refusal, because the employer's own
// record of it is exactly what payroll needs to see.
const PENSION_POSTPONED = new Set(['postponed', 'postponement', 'deferred', 'waiting period']);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function pad2(n) { return String(n).padStart(2, '0'); }
function ymd(d) {
  if (!d) return '';
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Parse a date cell. DAY FIRST — this is a UK HR export, and "03/04/1990" is the
 * third of April. A cell that can only be month-first (13/…/… reversed, i.e.
 * first part > 12 in the middle position) is refused rather than swapped, so a
 * mixed-format file cannot half-land.
 */
function parseDateCell(raw) {
  const s = String(raw || '').trim();
  if (!s) return { ok: true, value: null };

  let y, m, d;
  let mt;
  if ((mt = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/))) {
    y = +mt[1]; m = +mt[2]; d = +mt[3];
  } else if ((mt = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/))) {
    d = +mt[1]; m = +mt[2]; y = +mt[3];
    if (m > 12 && d <= 12) {
      return { ok: false, error: `"${s}" is month/day/year — Wren reads dates as day/month/year, `
        + 'so this one is ambiguous. Use YYYY-MM-DD in the spreadsheet and upload again.' };
    }
    if (y < 100) y += y > 40 ? 1900 : 2000;   // '68 → 1968, '05 → 2005
  } else if ((mt = s.match(/^(\d{1,2})[ -]([A-Za-z]{3,})[ -](\d{2}|\d{4})$/))) {
    d = +mt[1];
    m = MONTHS.indexOf(mt[2].slice(0, 3).toLowerCase()) + 1;
    y = +mt[3];
    if (y < 100) y += y > 40 ? 1900 : 2000;
  } else if ((mt = s.match(/^([A-Za-z]{3,})[ -](\d{1,2}),?[ -](\d{4})$/))) {
    m = MONTHS.indexOf(mt[1].slice(0, 3).toLowerCase()) + 1;
    d = +mt[2]; y = +mt[3];
  } else {
    return { ok: false, error: `"${s}" is not a date Wren can read. Use 31/03/1990 or 1990-03-31.` };
  }

  if (!m || m < 1 || m > 12) return { ok: false, error: `"${s}" has no month in it that makes sense.` };
  if (!d || d < 1 || d > 31) return { ok: false, error: `"${s}" has no day in it that makes sense.` };
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return { ok: false, error: `"${s}" is not a real date — check the day against the month.` };
  }
  return { ok: true, value: `${y}-${pad2(m)}-${pad2(d)}` };
}

function parseNumber(raw) {
  const s = String(raw || '').replace(/[£$€,\s]/g, '').replace(/^\+/, '');
  if (!s) return null;
  if (!/^-?\d*\.?\d+$/.test(s)) return NaN;
  return Number(s);
}

// Every field's validator returns { ok, value, display?, warning? } or { ok:false, error }.
const VALIDATORS = {
  text(raw, field) {
    const v = String(raw).trim().replace(/\s+/g, ' ');
    const max = field.max_length || 120;
    if (v.length > max) {
      return { ok: false, error: `${field.label} is ${v.length} characters — longer than the ${max} Wren stores.` };
    }
    return { ok: true, value: v };
  },

  ni(raw) {
    const r = normaliseNi(raw);                       // b303's validator, reserved prefixes and all
    if (!r.ok) return { ok: false, error: r.error };
    if (!r.value) return { ok: false, error: 'That National Insurance cell is empty.' };
    return { ok: true, value: r.value };
  },

  tax_code(raw) {
    const v = String(raw).toUpperCase().replace(/\s+/g, ' ').trim();
    const m = v.replace(/\s+/g, '').match(TAX_CODE_RE);
    if (!m) {
      return { ok: false, error: `"${String(raw).trim()}" is not a tax code Wren recognises. `
        + 'Codes look like 1257L, K475, BR, D0, 0T or NT, optionally with an S or C in front for '
        + 'Scotland or Wales and W1, M1 or X after it.' };
    }
    // Normalised: 'S1257LW1' → 'S1257L W1'.
    return { ok: true, value: (m[1] || '') + m[2] + (m[3] ? ' ' + m[3] : '') };
  },

  date(raw, field) {
    const r = parseDateCell(raw);
    if (!r.ok) return { ok: false, error: `${field.label}: ${r.error}` };
    if (!r.value) return { ok: false, error: `That ${field.label.toLowerCase()} cell is empty.` };
    if (field.key === 'date_of_birth') {
      const age = (Date.now() - Date.parse(r.value + 'T00:00:00Z')) / (365.2425 * 864e5);
      if (age < 14) return { ok: false, error: `${r.value} would make them ${Math.floor(age)} years old — `
        + 'check the year. Nobody under 14 can be employed here.' };
      if (age > 90) return { ok: false, error: `${r.value} would make them ${Math.floor(age)} years old — `
        + 'that is almost always a two-digit year read the wrong way round.' };
    }
    if (field.key === 'contract_start') {
      const yr = Number(r.value.slice(0, 4));
      if (yr < 1970 || yr > new Date().getFullYear() + 2) {
        return { ok: false, error: `${r.value} is not a plausible start date.` };
      }
    }
    return { ok: true, value: r.value };
  },

  postcode(raw) {
    const squashed = String(raw).toUpperCase().replace(/\s+/g, '');
    if (!squashed) return { ok: false, error: 'That postcode cell is empty.' };
    const spaced = squashed.length > 3
      ? squashed.slice(0, squashed.length - 3) + ' ' + squashed.slice(-3)
      : squashed;
    if (!POSTCODE_RE.test(spaced)) {
      return { ok: false, error: `"${String(raw).trim()}" is not a UK postcode. `
        + 'A 0 read as an O in the last three characters is the usual cause.' };
    }
    return { ok: true, value: spaced };
  },

  money(raw, field) {
    const n = parseNumber(raw);
    if (n === null) return { ok: false, error: `That ${field.label.toLowerCase()} cell is empty.` };
    if (Number.isNaN(n)) {
      return { ok: false, error: `"${String(raw).trim()}" is not an amount. `
        + 'Wren reads 12.50 or £12.50 — take out anything else, including "per hour".' };
    }
    if (n <= 0) return { ok: false, error: `${field.label} cannot be ${n}. A rate of zero is not a rate.` };
    if (n > field.max) {
      return { ok: false, error: `£${n.toLocaleString('en-GB')} is above the £${field.max.toLocaleString('en-GB')} `
        + `Wren will accept as ${field.label.toLowerCase()} — ${field.over_hint}` };
    }
    const value = Math.round(n * 100) / 100;
    const out = { ok: true, value, display: '£' + value.toFixed(2) };
    if (field.warn_below && n < field.warn_below) out.warning = field.warn_below_hint;
    return out;
  },

  hours(raw, field) {
    const n = parseNumber(raw);
    if (n === null) return { ok: false, error: 'That hours cell is empty.' };
    if (Number.isNaN(n)) return { ok: false, error: `"${String(raw).trim()}" is not a number of hours.` };
    if (n <= 0) return { ok: false, error: 'Contracted hours of zero are not contracted hours — '
      + 'a bank or as-and-when contract is recorded as an employment type, not as 0 hours.' };
    if (n > 60) return { ok: false, error: `${n} hours a week is above the 48-hour working-time limit `
      + 'by enough that it is almost certainly a monthly or annual figure.' };
    const value = Math.round(n * 100) / 100;
    const out = { ok: true, value, display: value + ' h/week' };
    if (n > 48) out.warning = `${n} hours is over the 48-hour working-time limit — an opt-out must be on file.`;
    return out;
  },

  percent(raw, field) {
    let n = parseNumber(String(raw).replace(/%/g, ''));
    if (n === null) return { ok: false, error: 'That contribution cell is empty.' };
    if (Number.isNaN(n)) return { ok: false, error: `"${String(raw).trim()}" is not a percentage.` };
    const out = {};
    if (n > 0 && n < 1) {            // 0.03 written for 3%
      n = Math.round(n * 1000) / 10;
      out.warning = `Read as ${n}% — the cell said ${String(raw).trim()}, which is a fraction, not a percentage.`;
    }
    if (n < 0 || n > 50) {
      return { ok: false, error: `${n}% is not a pension contribution Wren will accept. `
        + 'The legal minimums are 3% employer and 5% employee.' };
    }
    const value = Math.round(n * 100) / 100;
    return Object.assign({ ok: true, value, display: value + '%' }, out);
  },

  days(raw, field) {
    const n = parseNumber(raw);
    if (n === null) return { ok: false, error: 'That entitlement cell is empty.' };
    if (Number.isNaN(n)) return { ok: false, error: `"${String(raw).trim()}" is not a number of days.` };
    if (n < 0 || n > 70) return { ok: false, error: `${n} days is not a holiday entitlement Wren will accept `
      + '(the statutory minimum is 28 including bank holidays).' };
    const value = Math.round(n * 100) / 100;
    const out = { ok: true, value, display: value + ' days' };
    if (n < 20) out.warning = `${n} days is below the 28-day statutory minimum for a full-time contract — `
      + 'check whether this figure excludes bank holidays or is pro-rated.';
    return out;
  },

  contract_type(raw) {
    const k = String(raw).toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const v = CONTRACT_TYPE_MAP.get(k);
    if (!v) {
      return { ok: false, error: `"${String(raw).trim()}" is not a pay basis. Wren stores either `
        + '"hourly" or "salaried" here — it decides how payroll works the person out. '
        + 'Full-time, part-time, permanent and fixed-term belong in the employment type column.' };
    }
    return { ok: true, value: v, display: v === 'salaried' ? 'salaried (same every month)' : 'hourly' };
  },

  employment_type(raw) {
    const k = String(raw).toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    const v = EMPLOYMENT_TYPE_MAP.get(k);
    if (!v) {
      return { ok: false, error: `"${String(raw).trim()}" is not an employment type Wren stores. `
        + 'It keeps permanent, part_time, temporary or bank — map anything else to the closest of those '
        + 'in the spreadsheet first, so the word in Wren means what it says.' };
    }
    return { ok: true, value: v, display: v.replace(/_/g, ' ') };
  },

  pension(raw) {
    const k = String(raw).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (PENSION_TRUE.has(k))  return { ok: true, value: true,  display: 'enrolled' };
    if (PENSION_FALSE.has(k)) return { ok: true, value: false, display: 'not enrolled' };
    if (PENSION_POSTPONED.has(k)) {
      return { ok: true, value: false, display: 'not enrolled',
        warning: 'The file says postponed. Wren records that as NOT enrolled — the postponement date '
               + 'itself has nowhere to live yet, so keep it in BrightHR.' };
    }
    return { ok: false, error: `"${String(raw).trim()}" is not a pension status Wren can read. `
      + 'It understands enrolled / opted out / not eligible / postponed, or a plain yes or no.' };
  },

  id_text(raw, field) {
    const v = String(raw).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,39}$/.test(v)) {
      return { ok: false, error: `"${v}" is not a ${field.label.toLowerCase()} — `
        + 'letters, digits and - . _ / only, up to 40 characters.' };
    }
    return { ok: true, value: v };
  },
};

// ── The field registry — and the closed column allowlist ────────────────────
// `role`:  'write' — imported into the staff row
//          'match' — used to identify the person, never written
//          'both'  — an identifier that is also a field worth filling in
// `column` is the ONLY way a value reaches the database; assertWritable() below
// is the backstop if this list is ever edited carelessly.
const FIELDS = [
  // ── identity ──
  { key: 'brighthr_employee_id', label: 'BrightHR employee id', role: 'both',
    column: 'brighthr_employee_id', kind: 'id_text', group: 'identity',
    aliases: ['employee id', 'employee no', 'employee number', 'brighthr id', 'brighthr ref',
              'bright hr id', 'staff id', 'id', 'emp id', 'employee reference'],
    help: 'Matched on first. Stored so next month\'s export matches on it straight away.' },

  { key: 'payroll_reference', label: 'Payroll number', role: 'both',
    column: 'payroll_reference', kind: 'id_text', group: 'identity',
    aliases: ['payroll number', 'payroll no', 'payroll ref', 'payroll reference', 'payroll id',
              'works number', 'pay number'],
    help: 'The number payroll software knows them by. Second match key.' },

  { key: 'email', label: 'Email address', role: 'match', group: 'identity',
    aliases: ['email', 'email address', 'work email', 'e mail', 'personal email', 'home email'],
    help: 'Used to identify the row. NEVER written — an email address is a login, and it is '
        + 'changed on the staff record where that is obvious.' },

  { key: 'first_name', label: 'First name', role: 'match', group: 'identity',
    aliases: ['first name', 'forename', 'given name', 'firstname', 'known as'] },

  { key: 'last_name', label: 'Last name', role: 'match', group: 'identity',
    aliases: ['last name', 'surname', 'family name', 'lastname'] },

  { key: 'full_name', label: 'Full name', role: 'match', group: 'identity',
    aliases: ['name', 'full name', 'employee name', 'employee', 'staff name', 'displayname', 'display name'],
    help: 'Read as "First Last" or "Last, First". Last match key, and only on an exact match.' },

  // ── HMRC ──
  { key: 'ni_number', label: 'NI number', role: 'write', column: 'ni_number', kind: 'ni',
    group: 'hmrc', sensitive: true,
    aliases: ['ni number', 'national insurance number', 'national insurance', 'ni no', 'nino',
              'ni', 'nat ins no', 'national insurance no'] },

  { key: 'tax_code', label: 'Tax code', role: 'write', column: 'tax_code', kind: 'tax_code',
    group: 'hmrc', sensitive: true,
    aliases: ['tax code', 'paye tax code', 'taxcode', 'current tax code', 'paye code'] },

  { key: 'date_of_birth', label: 'Date of birth', role: 'write', column: 'date_of_birth',
    kind: 'date', group: 'hmrc',
    aliases: ['date of birth', 'dob', 'birth date', 'birthdate', 'd o b', 'born'] },

  // ── pay ──
  { key: 'contract_type', label: 'Pay basis', role: 'write', column: 'contract_type',
    kind: 'contract_type', group: 'pay',
    aliases: ['contract type', 'pay basis', 'pay type', 'salary basis', 'paid', 'pay frequency basis',
              'rate type', 'pay method'],
    help: 'Either "hourly" or "salaried". Payroll reads this to decide whether to multiply hours '
        + 'by a rate or to divide an annual salary by twelve.' },

  { key: 'hourly_rate', label: 'Hourly rate', role: 'write', column: 'hourly_rate', kind: 'money',
    group: 'pay', max: 200, over_hint: 'that looks like a weekly or monthly figure in the wrong column.',
    warn_below: 8, warn_below_hint: 'This is below every 2026 National Minimum Wage band — check it is an hourly rate.',
    aliases: ['hourly rate', 'rate per hour', 'hourly pay', 'pay rate', 'rate', 'hourly', 'basic hourly rate'] },

  // WRITES fixed_annual_salary, NOT annual_salary. staff.annual_salary is a
  // GENERATED ALWAYS column — (hourly_rate * hours_per_week * 52) — on dev and
  // prod alike, so Postgres refuses to write it at all ("can only be updated to
  // DEFAULT"). fixed_annual_salary is the exact figure Toby added on 2026-09-29
  // for the two salaried people, and src/lib/payroll-engine.js already reads
  // COALESCE(fixed_annual_salary, annual_salary), so this is the column a real
  // salary belongs in.
  { key: 'annual_salary', label: 'Annual salary (exact)', role: 'write',
    column: 'fixed_annual_salary', kind: 'money',
    group: 'pay', max: 500000, over_hint: 'check it is not pennies rather than pounds.',
    warn_below: 5000, warn_below_hint: 'Below £5,000 a year is almost always a monthly figure in an annual column.',
    aliases: ['annual salary', 'salary', 'yearly salary', 'gross salary', 'annual pay', 'basic salary',
              'salary per annum', 'full time salary', 'fixed annual salary'],
    help: 'The salary payroll should actually use. Without one, Wren works an annual figure out '
        + 'as hourly rate × hours × 52, which is right for hourly staff and wrong for salaried ones.' },

  { key: 'contracted_hours', label: 'Contracted hours', role: 'write', column: 'contracted_hours',
    kind: 'hours', group: 'pay',
    // Payroll reads hours_per_week FIRST and falls back to contracted_hours
    // (src/lib/payroll-engine.js). Writing only one of them would leave a stale
    // figure deciding the pay, so a blank hours_per_week is filled to match.
    // It is never OVERWRITTEN here: a deliberately different payroll figure wins.
    also_fill_blank: 'hours_per_week',
    aliases: ['contracted hours', 'contract hours', 'hours per week', 'weekly hours', 'hours',
              'contracted weekly hours', 'hours week'] },

  { key: 'contract_start', label: 'Start date', role: 'write', column: 'contract_start',
    kind: 'date', group: 'pay',
    aliases: ['start date', 'employment start date', 'date started', 'continuous service date',
              'commencement date', 'hire date', 'joined'] },

  { key: 'employment_type', label: 'Employment type', role: 'write', column: 'employment_type',
    kind: 'employment_type', group: 'pay',
    aliases: ['employment type', 'employment status', 'work type', 'contract basis', 'job type',
              'full time part time'] },

  { key: 'holiday_entitlement_days', label: 'Holiday entitlement', role: 'write',
    column: 'holiday_entitlement_days', kind: 'days', group: 'pay',
    aliases: ['holiday entitlement', 'annual leave entitlement', 'holiday days', 'holiday allowance',
              'annual leave days', 'entitlement days'] },

  // ── pension ──
  { key: 'pension_eligible', label: 'Pension status', role: 'write', column: 'pension_eligible',
    kind: 'pension', group: 'pension',
    aliases: ['pension', 'pension status', 'pension scheme', 'auto enrolment', 'auto enrolment status',
              'pension enrolled', 'in pension scheme', 'pension member', 'auto enroled'] },

  { key: 'pension_employee_contribution', label: 'Employee pension %', role: 'write',
    column: 'pension_employee_contribution', kind: 'percent', group: 'pension',
    aliases: ['employee pension contribution', 'employee pension', 'employee contribution',
              'employee pension percent', 'ee contribution'] },

  { key: 'pension_employer_contribution', label: 'Employer pension %', role: 'write',
    column: 'pension_employer_contribution', kind: 'percent', group: 'pension',
    aliases: ['employer pension contribution', 'employer pension', 'employer contribution',
              'employer pension percent', 'er contribution'] },

  // ── address ──
  { key: 'address_line1', label: 'Address line 1', role: 'write', column: 'address_line1',
    kind: 'text', group: 'address', max_length: 200,
    aliases: ['address line 1', 'address 1', 'address', 'street address', 'home address',
              'address line one', 'house number and street'] },

  { key: 'address_line2', label: 'Address line 2', role: 'write', column: 'address_line2',
    kind: 'text', group: 'address', max_length: 200,
    aliases: ['address line 2', 'address 2', 'address line two', 'town', 'city', 'town city',
              'address line 3', 'county'] },

  { key: 'postcode', label: 'Postcode', role: 'write', column: 'postcode', kind: 'postcode',
    group: 'address',
    aliases: ['postcode', 'post code', 'zip', 'zip code', 'postal code', 'home postcode'] },
];

const FIELD_BY_KEY = new Map(FIELDS.map(f => [f.key, f]));

const GROUP_LABELS = {
  identity: 'Which person this row is',
  hmrc:     'HMRC / PAYE',
  pay:      'Pay and contract',
  pension:  'Pension',
  address:  'Home address',
};

/**
 * THE CLOSED ALLOWLIST. Every column this module may ever write, derived from the
 * registry above so the two can never disagree. `also_fill_blank` targets are in
 * it too, because they are written for real.
 */
const WRITABLE_COLUMNS = new Set();
for (const f of FIELDS) {
  if (f.role === 'match') continue;
  if (f.column) WRITABLE_COLUMNS.add(f.column);
  if (f.also_fill_blank) WRITABLE_COLUMNS.add(f.also_fill_blank);
}

// Columns that must NEVER be reachable, whatever the registry says. This is not
// belt-and-braces theatre: it is the assertion that fails loudly if somebody
// later adds { key:'pin', column:'pin_hash' } to the list above.
const FORBIDDEN_COLUMNS = new Set([
  // annual_salary is GENERATED ALWAYS ((hourly_rate * hours_per_week) * 52) on
  // dev and prod. Postgres refuses to write it, so naming it in the registry
  // would fail the whole import at UPDATE time rather than at load time. The
  // exact-salary field writes fixed_annual_salary instead.
  'annual_salary',
  'id', 'pin_hash', 'pin_length', 'role', 'email', 'is_active', 'terminated',
  'totp_secret', 'totp_enrolled_at', 'totp_verified', 'totp_last_used',
  'telegram_chat_id', 'telegram_link_code', 'scope', 'scope_value',
  'wren_id_provisioned_at', 'inbox_access', 'can_publish',
]);

function assertWritable(column) {
  if (FORBIDDEN_COLUMNS.has(column)) {
    throw new Error(`refusing to write staff.${column} from a CSV — it is a login or status field`);
  }
  if (!WRITABLE_COLUMNS.has(column)) {
    throw new Error(`refusing to write staff.${column} — not on the payroll-import allowlist`);
  }
  return column;
}
// Run the check once at load: a registry that names a forbidden column is a bug
// that must not wait for an upload to be discovered.
for (const c of WRITABLE_COLUMNS) assertWritable(c);

// ── Mapping guesswork ───────────────────────────────────────────────────────
const ALIAS_INDEX = new Map();   // normalised alias → field key
for (const f of FIELDS) {
  ALIAS_INDEX.set(normHeader(f.key), f.key);
  ALIAS_INDEX.set(normHeader(f.label), f.key);
  for (const a of f.aliases || []) {
    const k = normHeader(a);
    if (!ALIAS_INDEX.has(k)) ALIAS_INDEX.set(k, f.key);
  }
}

/**
 * Guess { "<header as written>": "<field key>" } from the header row.
 *
 * Exact alias match first, then a contains-match, and a field is only claimed
 * ONCE — the first header that wants it gets it, so an export with both
 * "Address Line 1" and "Address" does not map both onto the same column and
 * then quietly write whichever came last.
 */
function guessMapping(headers) {
  const taken = new Set();
  const out = {};
  const list = (headers || []).map(h => ({ raw: h, norm: normHeader(h) })).filter(h => h.norm);

  for (const h of list) {                                    // pass 1 — exact
    const key = ALIAS_INDEX.get(h.norm);
    if (key && !taken.has(key)) { out[h.raw] = key; taken.add(key); }
  }
  for (const h of list) {                                    // pass 2 — contains
    if (out[h.raw]) continue;
    let best = null, bestLen = 0;
    for (const [alias, key] of ALIAS_INDEX) {
      if (taken.has(key) || alias.length < 4) continue;
      if (h.norm === alias || h.norm.includes(alias) || alias.includes(h.norm)) {
        if (alias.length > bestLen) { best = key; bestLen = alias.length; }
      }
    }
    if (best) { out[h.raw] = best; taken.add(best); }
  }
  return out;
}

/** What the mapping step shows: every header, its guess, and every choice. */
function mappingOptions() {
  return FIELDS.map(f => ({
    key: f.key, label: f.label, group: f.group, group_label: GROUP_LABELS[f.group] || f.group,
    role: f.role, writable: f.role !== 'match', sensitive: !!f.sensitive, help: f.help || null,
    example_headers: (f.aliases || []).slice(0, 3),
  }));
}

// ── Masking, for the log ────────────────────────────────────────────────────
/**
 * What goes into payroll_import_changes and the audit diff. NI numbers and tax
 * codes keep their last two characters only — enough to tell two entries apart
 * when checking what happened, not enough to be a second copy of the payroll
 * data. Everything else is logged as written: an address or a pay rate is
 * already in the staff row this log describes.
 */
function maskFor(fieldKey, value) {
  const f = FIELD_BY_KEY.get(fieldKey);
  if (value === null || value === undefined || value === '') return { text: null, masked: !!(f && f.sensitive) };
  const s = String(value);
  if (!f || !f.sensitive) return { text: s, masked: false };
  const tail = s.slice(-2);
  return { text: '•'.repeat(Math.max(0, s.length - 2)) + tail, masked: true };
}

// ── Reading the current value in the CSV's own terms ────────────────────────
function currentText(field, row) {
  const v = row[field.column];
  if (v === null || v === undefined || String(v).trim() === '') return '';
  switch (field.kind) {
    case 'date':    return ymd(v);
    case 'pension': return v === true ? 'enrolled' : 'not enrolled';
    case 'money':   return '£' + Number(v).toFixed(2);
    case 'hours':   return Number(v) + ' h/week';
    case 'percent': return Number(v) + '%';
    case 'days':    return Number(v) + ' days';
    default:        return String(v);
  }
}

/** Is the value already on file the same as what the file would write? */
function sameValue(field, current, next) {
  if (current === null || current === undefined) return false;
  switch (field.kind) {
    case 'date':    return ymd(current) === next;
    case 'pension': return current === next;
    case 'money': case 'hours': case 'percent': case 'days':
      return Math.abs(Number(current) - Number(next)) < 0.005;
    default:
      return String(current).trim().toLowerCase() === String(next).trim().toLowerCase();
  }
}

const STAFF_SELECT = `
  SELECT id, first_name, last_name, preferred_name, email, role, job_title,
         COALESCE(is_active, true) AS is_active, COALESCE(terminated, false) AS terminated,
         contract_end, brighthr_employee_id, payroll_reference,
         ni_number, tax_code, date_of_birth,
         address_line1, address_line2, postcode,
         hourly_rate, annual_salary, fixed_annual_salary,
         contract_type, employment_type, contracted_hours, hours_per_week,
         contract_start, holiday_entitlement_days,
         pension_eligible, pension_employee_contribution, pension_employer_contribution
    FROM staff`;

function fullName(s) {
  return `${s.first_name || ''} ${s.last_name || ''}`.trim();
}
const nameKey = (a, b) => `${String(a || '').trim()} ${String(b || '').trim()}`
  .toLowerCase().replace(/\s+/g, ' ').trim();
const idKey = v => String(v || '').trim().toLowerCase().replace(/^0+(?=\d)/, '');

/** Split "Last, First" / "First Last" the way an HR export writes it. */
function splitFullName(raw) {
  const s = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s.includes(',')) {
    const [last, first] = s.split(',');
    if (!first || !first.trim()) return null;
    return { first: first.trim().split(' ')[0], last: last.trim() };
  }
  const parts = s.split(' ');
  if (parts.length < 2) return null;
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Build the match index. Three id sources, because b229 scattered the BrightHR
 * employee id across three tables (see the migration's note): the new
 * staff.brighthr_employee_id, staff_contracts.brighthr_ref, and the
 * 'bhr-emp:<id>' refs on work_patterns.
 */
async function buildIndex(db, staffRows) {
  const byBright = new Map(), byPayroll = new Map(), byEmail = new Map(), byName = new Map();
  const push = (map, k, id) => {
    if (!k) return;
    if (!map.has(k)) map.set(k, new Set());
    map.get(k).add(id);
  };
  for (const s of staffRows) {
    push(byBright,  idKey(s.brighthr_employee_id), s.id);
    push(byPayroll, idKey(s.payroll_reference), s.id);
    push(byEmail,   String(s.email || '').trim().toLowerCase(), s.id);
    push(byName,    nameKey(s.first_name, s.last_name), s.id);
    if (s.preferred_name) push(byName, nameKey(s.preferred_name, s.last_name), s.id);
  }
  try {
    const { rows } = await db.query(
      `SELECT staff_id, brighthr_ref FROM staff_contracts
        WHERE staff_id IS NOT NULL AND brighthr_ref IS NOT NULL AND brighthr_ref NOT LIKE 'staff\\_%'`);
    for (const r of rows) push(byBright, idKey(r.brighthr_ref), r.staff_id);
  } catch (_) { /* a tenant without staff_contracts */ }
  try {
    const { rows } = await db.query(
      `SELECT staff_id, substring(brighthr_ref from 9) AS ref FROM work_patterns
        WHERE staff_id IS NOT NULL AND brighthr_ref LIKE 'bhr-emp:%'
          AND substring(brighthr_ref from 9) NOT LIKE 's%'`);
    for (const r of rows) push(byBright, idKey(r.ref), r.staff_id);
  } catch (_) { /* a tenant without work_patterns */ }
  return { byBright, byPayroll, byEmail, byName };
}

const MATCH_LABEL = {
  brighthr_employee_id: 'BrightHR employee id',
  payroll_reference:    'payroll number',
  email:                'email address',
  name:                 'first and last name',
};

/**
 * Work out what a CSV would do, without touching a single table.
 *
 * @param {object} db      pg pool or client
 * @param {object} opts
 * @param {string} opts.csvText
 * @param {object} [opts.mapping]   { header → field key }. Omitted ⇒ guessed.
 * @param {object} [opts.overwrite] { "<staffId>:<fieldKey>": true } — the ticks
 * @returns {Promise<object>} the whole preview, ready for the screen
 */
async function analyse(db, { csvText, mapping, overwrite } = {}) {
  const grid = parseCSV(csvText);
  if (!grid.length) {
    return { fatal: { error: 'empty_file', message: 'That file had no rows in it at all.' } };
  }
  const headers = grid[0].map(h => String(h || '').replace(/^﻿/, '').trim());
  if (!headers.filter(Boolean).length) {
    return { fatal: { error: 'no_headers', message: 'The first row of that file is empty, so there is '
      + 'nothing to map. The first row has to be the column names.' } };
  }
  const signature = headerSignature(headers);
  const guessed = guessMapping(headers);
  const map = (mapping && Object.keys(mapping).length) ? mapping : guessed;

  // Only headers that are actually in this file, and only field keys we know.
  //
  // `sample` is the first non-empty value in the column. It is what makes a wrong
  // guess obvious on the mapping screen — "Reference: 1257L" is a tax code in a
  // column called Reference, and no amount of alias matching would have known.
  const columns = [];
  const claimed = new Map();
  const sampleAt = (i) => {
    for (let n = 1; n < grid.length && n <= 60; n++) {
      const v = String((grid[n] || [])[i] ?? '').trim();
      if (v) return v.length > 40 ? v.slice(0, 39) + '…' : v;
    }
    return '';
  };
  headers.forEach((h, i) => {
    const key = map[h] || null;
    const field = key ? FIELD_BY_KEY.get(key) : null;
    const dup = field && claimed.has(key);
    columns.push({
      header: h, index: i, field_key: field && !dup ? key : null,
      label: field ? field.label : null,
      guessed: guessed[h] || null,
      duplicate_of: dup ? claimed.get(key) : null,
      sample: sampleAt(i),
    });
    if (field && !dup) claimed.set(key, h);
  });

  const mapped = columns.filter(c => c.field_key);
  const writeCols = mapped.filter(c => FIELD_BY_KEY.get(c.field_key).role !== 'match');
  const idCols    = mapped.filter(c => ['brighthr_employee_id', 'payroll_reference', 'email',
                                        'first_name', 'last_name', 'full_name'].includes(c.field_key));
  if (!idCols.length) {
    return { fatal: { error: 'no_identity_column', headers, mapping: map, signature,
      columns, options: mappingOptions(),
      message: 'None of these columns says WHO each row is. Map at least one of the employee id, '
             + 'payroll number, email address or name columns before going any further — rows are '
             + 'matched on an identifier, never on the order they happen to be in.' } };
  }
  if (!writeCols.length) {
    return { fatal: { error: 'no_fields_mapped', headers, mapping: map, signature,
      columns, options: mappingOptions(),
      message: 'Every column in this file is either unmapped or an identifier, so there is nothing '
             + 'to import. Map at least one field — a tax code, an NI number, a pay rate.' } };
  }

  const { rows: staffRows } = await db.query(STAFF_SELECT);
  const byId = new Map(staffRows.map(s => [s.id, s]));
  const index = await buildIndex(db, staffRows);
  const excluded = await excludedStaffIds(db);

  const ticks = overwrite && typeof overwrite === 'object' ? overwrite : {};
  const tickKey = (staffId, fieldKey) => `${staffId}:${fieldKey}`;

  const at = (cells, key) => {
    const c = claimed.get(key);
    if (c === undefined) return '';
    const col = columns.find(x => x.header === c);
    return String(cells[col.index] ?? '').trim();
  };

  const rowsOut = [], unmatched = [], rejects = [], changes = [];
  const seenStaff = new Map();          // staff_id → first csv line, to catch a duplicated person
  let blankRows = 0;

  for (let n = 1; n < grid.length; n++) {
    const cells = grid[n];
    const line = n + 1;                                  // 1-based, header is line 1
    if (!cells.length || cells.every(v => String(v).trim() === '')) { blankRows++; continue; }

    // ── identify ──
    const bright  = at(cells, 'brighthr_employee_id');
    const payroll = at(cells, 'payroll_reference');
    const email   = at(cells, 'email');
    let first     = at(cells, 'first_name');
    let last      = at(cells, 'last_name');
    if ((!first || !last) && claimed.has('full_name')) {
      const sp = splitFullName(at(cells, 'full_name'));
      if (sp) { first = first || sp.first; last = last || sp.last; }
    }
    const shown = [ (first || last) ? `${first} ${last}`.trim() : '',
                    email, payroll ? '#' + payroll : '', bright ? 'id ' + bright : '' ]
                  .filter(Boolean).join(' · ') || `line ${line}`;

    let staffId = null, matchedBy = null, ambiguous = null;
    const tryMatch = (map_, k, why) => {
      if (staffId || !k) return;
      const hit = map_.get(k);
      if (!hit || !hit.size) return;
      if (hit.size > 1) { ambiguous = ambiguous || { why, ids: [...hit] }; return; }
      staffId = [...hit][0]; matchedBy = why;
    };
    tryMatch(index.byBright,  idKey(bright), 'brighthr_employee_id');
    tryMatch(index.byPayroll, idKey(payroll), 'payroll_reference');
    tryMatch(index.byEmail,   email.toLowerCase(), 'email');
    if (!staffId && first && last) tryMatch(index.byName, nameKey(first, last), 'name');

    if (!staffId) {
      unmatched.push({
        line, shown,
        reason: ambiguous
          ? `the ${MATCH_LABEL[ambiguous.why]} in this row belongs to ${ambiguous.ids.length} people in Wren `
            + `(staff ${ambiguous.ids.join(', ')}), so which one this is cannot be told from the file`
          : 'nothing in this row matches anybody in Wren — no employee id, payroll number, email '
            + 'address or exact first-and-last name that Wren holds',
        tried: idCols.map(c => c.field_key),
      });
      continue;
    }

    const dupLine = seenStaff.get(staffId);
    if (dupLine) {
      unmatched.push({ line, shown, staff_id: staffId,
        reason: `this is the same person as line ${dupLine}. Two rows for one person cannot both be `
              + 'right, so neither is applied — take one of them out of the file.' });
      // The earlier row's changes are withdrawn too: a duplicated person is a
      // file to fix, not a race between two rows.
      for (let i = changes.length - 1; i >= 0; i--) if (changes[i].staff_id === staffId) changes.splice(i, 1);
      const earlier = rowsOut.find(r => r.staff_id === staffId && r.line === dupLine);
      if (earlier) { earlier.withdrawn = true; earlier.fields = []; }
      continue;
    }
    seenStaff.set(staffId, line);

    const s = byId.get(staffId);
    const notes = [];
    if (!s.is_active || s.terminated) notes.push('This person is not active in Wren.');
    if (s.contract_end && ymd(s.contract_end) < ymd(new Date())) {
      notes.push(`Their contract ended ${ymd(s.contract_end)}.`);
    }
    if (excluded.has(staffId)) notes.push('Excluded from payroll runs by the payroll template.');

    // ── the fields ──
    const rowFields = [];
    for (const col of writeCols) {
      const field = FIELD_BY_KEY.get(col.field_key);
      const raw = String(cells[col.index] ?? '').trim();
      if (!raw) continue;                                   // a blank cell is not a change

      const v = (VALIDATORS[field.kind] || VALIDATORS.text)(raw, field);
      if (!v.ok) {
        const rj = { line, staff_id: staffId, name: fullName(s), field: field.key,
                     label: field.label, header: col.header, given: raw, reason: v.error };
        rejects.push(rj);
        rowFields.push(Object.assign({ state: 'rejected' }, rj));
        continue;
      }

      const current = s[field.column];
      const currentBlank = current === null || current === undefined || String(current).trim() === '';
      const display = v.display || String(v.value);

      if (!currentBlank && sameValue(field, current, v.value)) {
        rowFields.push({ state: 'same', field: field.key, label: field.label, header: col.header,
                         old: currentText(field, s), new: display });
        continue;
      }

      const warnings = [];
      if (v.warning) warnings.push(v.warning);
      if (field.key === 'annual_salary' && s.annual_salary != null) {
        warnings.push(`Payroll currently works their annual figure out as £${Number(s.annual_salary).toFixed(2)} `
          + '(rate × hours × 52). This exact salary will be used instead.');
      }
      if (field.key === 'contract_type' && v.value === 'salaried' && s.fixed_annual_salary == null
          && !writeCols.some(c => c.field_key === 'annual_salary' && String(cells[c.index] ?? '').trim())) {
        warnings.push('Marked salaried, but there is no exact salary on file and none in this file, so '
          + 'payroll will fall back to rate × hours × 52 — which is the figure being salaried is meant to replace.');
      }

      const state = currentBlank ? 'fill' : 'overwrite';
      const ticked = state === 'overwrite' && ticks[tickKey(staffId, field.key)] === true;
      const ch = {
        state, applied: state === 'fill' || ticked, ticked,
        line, staff_id: staffId, name: fullName(s),
        field: field.key, label: field.label, header: col.header, column: field.column,
        old: currentText(field, s), new: display, value: v.value,
        sensitive: !!field.sensitive,
        also_fill_blank: field.also_fill_blank && (s[field.also_fill_blank] === null
          || s[field.also_fill_blank] === undefined) ? field.also_fill_blank : null,
        warnings,
        tick_key: tickKey(staffId, field.key),
      };
      rowFields.push(ch);
      changes.push(ch);
    }

    rowsOut.push({
      line, staff_id: staffId, name: fullName(s), job_title: s.job_title || s.role || null,
      matched_by: matchedBy, matched_by_label: MATCH_LABEL[matchedBy], shown,
      notes, fields: rowFields,
      fills: rowFields.filter(f => f.state === 'fill').length,
      overwrites: rowFields.filter(f => f.state === 'overwrite').length,
      rejected: rowFields.filter(f => f.state === 'rejected').length,
      same: rowFields.filter(f => f.state === 'same').length,
    });
  }

  const applied = changes.filter(c => c.applied);
  const counts = {
    rows_in_file:  grid.length - 1 - blankRows,
    rows_matched:  rowsOut.filter(r => !r.withdrawn).length,
    rows_unmatched: unmatched.length,
    fields_to_fill:      changes.filter(c => c.state === 'fill').length,
    fields_to_overwrite: changes.filter(c => c.state === 'overwrite' && c.ticked).length,
    overwrites_available: changes.filter(c => c.state === 'overwrite').length,
    fields_rejected: rejects.length,
    fields_same: rowsOut.reduce((n, r) => n + r.same, 0),
    fields_to_write: applied.length,
    columns_unmapped: columns.filter(c => !c.field_key && c.header).length,
  };

  return {
    signature, headers, mapping: map, guessed, columns, options: mappingOptions(),
    group_labels: GROUP_LABELS,
    rows: rowsOut, unmatched, rejects, changes, counts,
    // The apply call re-reads and re-validates the file; this is only here so the
    // screen can tell that the file in the box is still the file it previewed.
    checksum: crypto.createHash('sha256').update(String(csvText || '')).digest('hex').slice(0, 16),
    notes: [
      'Dates are read as day/month/year.',
      'A blank cell means "leave what Wren has" — it never clears a field.',
      'Email addresses and names identify the row and are never written by an import.',
    ],
  };
}

/** Staff ids the default payroll template leaves out (the business manager on prod). */
async function excludedStaffIds(db) {
  const out = new Set();
  try {
    const { rows } = await db.query('SELECT exclude_staff_ids FROM payroll_templates');
    for (const r of rows) {
      const list = Array.isArray(r.exclude_staff_ids) ? r.exclude_staff_ids
        : (() => { try { return JSON.parse(r.exclude_staff_ids || '[]'); } catch (_) { return []; } })();
      for (const id of list) if (Number.isFinite(Number(id))) out.add(Number(id));
    }
  } catch (_) { /* no templates table */ }
  return out;
}

/**
 * What the next payroll run is still missing, person by person.
 *
 * NAMES PEOPLE, deliberately, and is therefore gated exactly as the rest of this
 * module is: canViewSalaries only. The counts-only rule
 * (memory/feedback_counts_only_every_write_path) is about the surfaces a whole
 * team can see — the attention board and the finance tab, which
 * payrollCosts.payrollReadiness() serves and which must not name anybody. This
 * is the screen where the person filling the gaps in is standing, and a count of
 * 9 missing dates of birth tells them nothing about which nine.
 *
 * Staff excluded from payroll by a template are left out entirely: the business manager has a
 * login and no payroll, and listing him as "missing a tax code" every month is
 * how a checklist trains somebody to ignore it.
 */
async function gaps(db) {
  const excluded = await excludedStaffIds(db);
  const { rows } = await db.query(`${STAFF_SELECT}
    WHERE COALESCE(is_active, true) = true
      AND COALESCE(terminated, false) = false
      AND (contract_end IS NULL OR contract_end >= CURRENT_DATE)
    ORDER BY first_name, last_name`);

  const WANTED = [
    { key: 'tax_code',          label: 'tax code',           blocking: true },
    { key: 'ni_number',         label: 'NI number',          blocking: false },
    { key: 'date_of_birth',     label: 'date of birth',      blocking: false },
    { key: 'payroll_reference', label: 'payroll number',     blocking: false },
    { key: 'contract_type',     label: 'pay basis',          blocking: false },
    { key: 'pension_eligible',  label: 'pension status',     blocking: false },
    { key: 'address_line1',     label: 'home address',       blocking: false },
    { key: 'postcode',          label: 'postcode',           blocking: false },
    { key: 'contracted_hours',  label: 'contracted hours',   blocking: false },
  ];

  const people = [], byField = {};
  for (const w of WANTED) byField[w.key] = 0;
  let payRateMissing = 0;

  for (const s of rows) {
    if (excluded.has(s.id)) continue;
    const missing = [];
    for (const w of WANTED) {
      const f = FIELD_BY_KEY.get(w.key);
      const v = s[f.column];
      const blank = v === null || v === undefined || String(v).trim() === '';
      if (blank) { missing.push({ key: w.key, label: w.label, blocking: w.blocking }); byField[w.key]++; }
    }
    // A pay rate is EITHER an hourly rate or an exact salary — missing BOTH is
    // the only version of it that is a gap, which is why it is not in WANTED.
    // staff.annual_salary is deliberately not consulted: it is generated from
    // hourly_rate × hours_per_week × 52, so it is never populated when the rate
    // is missing and counting it would make this test tautological.
    const noRate = (s.hourly_rate == null || Number(s.hourly_rate) === 0)
                && (s.fixed_annual_salary == null || Number(s.fixed_annual_salary) === 0);
    if (noRate) { missing.push({ key: 'pay_rate', label: 'pay rate', blocking: true }); payRateMissing++; }
    if (missing.length) {
      people.push({
        staff_id: s.id, name: fullName(s), job_title: s.job_title || s.role || null,
        missing, blocking: missing.some(m => m.blocking),
      });
    }
  }
  byField.pay_rate = payRateMissing;

  return {
    checked: rows.filter(s => !excluded.has(s.id)).length,
    excluded_from_payroll: [...excluded],
    complete: rows.filter(s => !excluded.has(s.id)).length - people.length,
    people,
    by_field: byField,
    blocking_people: people.filter(p => p.blocking).length,
    basis: 'Active staff with a live contract, minus anyone the payroll template excludes. '
         + 'A pay rate counts as present if there is either an hourly rate or a salary. '
         + 'Wren does not file with HMRC — this is what the employer needs on file to run PAYE.',
  };
}

/** The header row of a blank template, for somebody starting from nothing. */
function templateHeaders() {
  return FIELDS.filter(f => f.key !== 'full_name').map(f => f.label);
}

module.exports = {
  FIELDS, FIELD_BY_KEY, GROUP_LABELS, WRITABLE_COLUMNS, FORBIDDEN_COLUMNS,
  assertWritable, parseCSV, sniffDelimiter, normHeader, headerSignature,
  guessMapping, mappingOptions, templateHeaders,
  VALIDATORS, parseDateCell, maskFor, currentText, sameValue,
  analyse, gaps, excludedStaffIds, splitFullName, MATCH_LABEL, STAFF_SELECT,
};
