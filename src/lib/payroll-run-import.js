'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b524 (2026-10-21) — Paycheck payroll files into a Wren payroll run.
//
// Toby: "I run payroll and fees and everything [and] it gets put into the
// accounting section anyway."
//
// He downloads three files from Paycheck each month and drops them in:
//
//   payslips  one row per employee — gross, tax, employee NI, pension, net
//   p32       the HMRC return: tax + NI due for the month, employer NI
//   pension   one row per employee — employee and employer contributions
//
// WHAT THIS IS NOT. b228's "Generate" INFERS a run from clocked hours and pay
// rates, and every figure it produces is an estimate (project_payroll_screen_b228:
// "Hours are INFERRED, never measured"). Paycheck's figures are what was actually
// paid. So an imported run is marked `hours_source='paycheck-import'` and
// `hours_inferred=false`, and importing over a GENERATED run replaces estimates
// with facts. Importing over a FINALISED run is refused — a finalised run has
// been signed off and its numbers are the record.
//
// WHY A SECOND MAPPING REGISTRY. b363 already has a remembered column mapper
// (ladn.payroll_import_mappings), but it maps onto ladn.staff COLUMNS — NI
// number, tax code, home address — and its unique key is the header signature
// alone. These files map onto payroll RUN and LINE fields. Sharing the table
// would have meant dropping a unique constraint on a prod table, and a Paycheck
// payslip summary run through the staff-details field registry would try to
// write a pay figure into an address column. Separate registry, same mechanics:
// ladn.payroll_run_import_mappings, keyed (file_kind, header_signature).
//
// THE PARSING IS b363's. parseCSV / normHeader / headerSignature / splitFullName
// are imported from src/lib/payroll-import.js rather than written again, so a
// quoted comma or a BOM behaves identically in both importers.
//
// WHAT IT CANNOT DO
//  • create a member of staff — an unmatched row is REPORTED, never invented;
//  • write any column outside the per-kind field registry below;
//  • touch pin_hash, protected_staff_pins, role or any login field — it never
//    writes to ladn.staff at all, only to payroll_runs / payroll_staff_lines;
//  • half-apply a file: one transaction, and a throw rolls the lot back.
//
// ACCESS. Pay figures. Every route that reaches this is behind
// requireSalaryView (src/lib/capabilities.js) — a deputy manager is refused,
// exactly as b363's importer refuses one.
// ─────────────────────────────────────────────────────────────────────────────

const B363 = require('./payroll-import');
const { parseCSV, sniffDelimiter, normHeader, headerSignature, splitFullName } = B363;

// ── Field registries, one per file kind ──────────────────────────────────────
// `key` is what the mapping maps a column TO. `money:true` means "parse as
// pounds-and-pence and store as pence". Aliases are normalised header text.
const FIELDS = {
  payslips: [
    { key: 'employee_ref', label: 'Employee number / payroll ref', id: true,
      aliases: ['employee number', 'employee no', 'emp no', 'payroll number', 'payroll ref',
                'payroll reference', 'works number', 'staff number', 'employee id', 'ref'] },
    { key: 'employee_name', label: 'Employee name', id: true,
      aliases: ['name', 'employee name', 'employee', 'full name', 'surname forename'] },
    { key: 'ni_number', label: 'NI number', id: true, sensitive: true,
      aliases: ['ni number', 'national insurance number', 'nino', 'ni no'] },
    { key: 'gross_pence', label: 'Gross pay', money: true, required: true,
      aliases: ['gross', 'gross pay', 'total gross', 'gross pay for ni', 'taxable gross', 'total pay'] },
    { key: 'tax_pence', label: 'PAYE tax', money: true,
      aliases: ['tax', 'paye', 'paye tax', 'income tax', 'tax deducted', 'paye deducted'] },
    { key: 'ni_pence', label: "Employee's NI", money: true,
      aliases: ['ni', 'employee ni', 'ee ni', 'national insurance', 'ni employee', 'nic employee'] },
    { key: 'employer_ni_pence', label: "Employer's NI", money: true,
      aliases: ['employer ni', 'er ni', 'ni employer', 'nic employer', 'employers ni', 'secondary ni'] },
    { key: 'pension_pence', label: "Employee's pension", money: true,
      aliases: ['pension', 'employee pension', 'ee pension', 'pension employee', 'pension deduction'] },
    { key: 'net_pence', label: 'Net pay', money: true, required: true,
      aliases: ['net', 'net pay', 'take home', 'net payment', 'nett pay', 'amount paid'] },
    { key: 'hours', label: 'Hours paid',
      aliases: ['hours', 'hours paid', 'total hours', 'basic hours', 'units'] },
  ],
  p32: [
    { key: 'tax_pence', label: 'PAYE tax due', money: true, required: true,
      aliases: ['tax', 'paye', 'paye tax', 'income tax', 'tax due', 'paye income tax'] },
    { key: 'ni_pence', label: "Employee's NI due", money: true,
      aliases: ['employee ni', 'ee ni', 'ni employee', 'nic employee', 'class 1 employee'] },
    { key: 'employer_ni_pence', label: "Employer's NI due", money: true,
      aliases: ['employer ni', 'er ni', 'ni employer', 'nic employer', 'class 1 employer', 'employers ni'] },
    { key: 'total_pence', label: 'Total due to HMRC', money: true,
      aliases: ['total', 'total due', 'amount due', 'total payable', 'net payable to hmrc', 'hmrc payment'] },
    { key: 'period', label: 'Tax month / period',
      aliases: ['period', 'tax month', 'month', 'tax period', 'pay period'] },
  ],
  pension: [
    { key: 'employee_ref', label: 'Employee number / payroll ref', id: true,
      aliases: ['employee number', 'employee no', 'payroll number', 'payroll ref', 'payroll reference',
                'staff number', 'employee id', 'ref'] },
    { key: 'employee_name', label: 'Employee name', id: true,
      aliases: ['name', 'employee name', 'employee', 'full name', 'member name'] },
    { key: 'ni_number', label: 'NI number', id: true, sensitive: true,
      aliases: ['ni number', 'national insurance number', 'nino', 'ni no'] },
    { key: 'pension_pence', label: "Employee's contribution", money: true, required: true,
      aliases: ['employee contribution', 'ee contribution', 'member contribution', 'employee', 'contribution'] },
    { key: 'employer_pension_pence', label: "Employer's contribution", money: true,
      aliases: ['employer contribution', 'er contribution', 'employer', 'employers contribution'] },
    { key: 'pensionable_pence', label: 'Pensionable earnings', money: true,
      aliases: ['pensionable earnings', 'qualifying earnings', 'pensionable pay', 'earnings'] },
  ],
};
const KINDS = Object.keys(FIELDS);
const FIELD_BY = {};
for (const k of KINDS) FIELD_BY[k] = new Map(FIELDS[k].map(f => [f.key, f]));

// ── Column guessing ──────────────────────────────────────────────────────────
const ALIAS = {};
for (const k of KINDS) {
  ALIAS[k] = new Map();
  for (const f of FIELDS[k]) {
    ALIAS[k].set(normHeader(f.key.replace(/_pence$/, '').replace(/_/g, ' ')), f.key);
    ALIAS[k].set(normHeader(f.label), f.key);
    for (const a of f.aliases) ALIAS[k].set(normHeader(a), f.key);
  }
}

/**
 * Which Paycheck report is this?
 *
 * Scored on how many of each kind's REQUIRED fields the headers resolve, then on
 * total matches. A payslip summary and a pension schedule share "employee name"
 * and a money column, so the discriminator is the required set: payslips needs a
 * net pay column, pension needs a contribution one, p32 needs a tax-due one and
 * (unlike the other two) has no per-employee identity column at all.
 */
function detectKind(headers) {
  const scores = KINDS.map((k) => {
    const mapped = guessMapping(headers, k);
    const keys = new Set(Object.values(mapped));
    const req = FIELDS[k].filter(f => f.required).map(f => f.key);
    const hasId = FIELDS[k].some(f => f.id && keys.has(f.key));
    return {
      kind: k,
      required_met: req.filter(r => keys.has(r)).length,
      required_total: req.length,
      matches: keys.size,
      // p32 is a TOTALS report. Seeing a per-employee identity column where p32
      // expects none is strong evidence it is one of the other two.
      penalty: (k === 'p32' && hasId) ? 2 : 0,
    };
  }).sort((a, b) =>
    (b.required_met - b.penalty) - (a.required_met - a.penalty) || b.matches - a.matches);
  const best = scores[0];
  return {
    kind: (best && best.required_met > 0) ? best.kind : null,
    confident: !!(best && best.required_met === best.required_total
                  && (!scores[1] || (best.required_met - best.penalty) > (scores[1].required_met - scores[1].penalty))),
    scores,
  };
}

/** headers → { 'Column header': 'field_key' }. Unrecognised columns are omitted. */
function guessMapping(headers, kind) {
  const out = {};
  const taken = new Set();
  for (const h of headers || []) {
    const key = ALIAS[kind] && ALIAS[kind].get(normHeader(h));
    // First column wins a field. Paycheck's payslip summary carries both a
    // "Gross Pay" and a "Gross Pay for NI" column and they are not the same
    // number; taking the later one silently would change the run's gross.
    if (key && !taken.has(key)) { out[h] = key; taken.add(key); }
  }
  return out;
}

/** The choices a person gets in the mapping UI, per kind. */
function mappingOptions(kind) {
  return (FIELDS[kind] || []).map(f => ({
    key: f.key, label: f.label, required: !!f.required,
    identity: !!f.id, money: !!f.money, sensitive: !!f.sensitive,
  }));
}

// ── Cell parsing ─────────────────────────────────────────────────────────────
/**
 * A money cell → integer pence.
 *
 * Handles £, thousands separators, a trailing CR/DR, and accountancy brackets
 * for a negative. Returns null for a blank — which means "the file does not say",
 * not zero: a blank tax cell on a payslip is a person who paid no tax, and a
 * MISSING tax column is a file we cannot read. The two are distinguished by
 * whether the field is in the mapping at all, never by the value.
 */
function parseMoney(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  if (/\bCR\b/i.test(s)) neg = true;
  // Order matters, and getting it wrong is silent. Removing the whitespace FIRST
  // turns "12.34 CR" into "12.34CR", and \bCR\b no longer matches (there is no
  // word boundary between '4' and 'C'), so the suffix survives, the numeric test
  // fails, and the cell reads as "the file does not say" instead of −£12.34.
  s = s.replace(/\b(CR|DR)\b/gi, '').replace(/[£,\s]/g, '');
  if (!/^-?\d*\.?\d*$/.test(s) || s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  // Round at the penny, after the sign, so -0.005 does not become -0.
  const pence = Math.round(Math.abs(n) * 100) * ((neg || n < 0) ? -1 : 1);
  return pence;
}

function parseHours(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const n = Number(String(raw).replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const idKey = v => String(v || '').trim().toLowerCase().replace(/^0+(?=\d)/, '');
const nameKey = v => String(v || '').toLowerCase().replace(/[^a-z]+/g, '');
const niKey = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Index the staff three ways: payroll reference, NI number, and name.
 *
 * Match order is reference → NI → name, because that is the order of how little
 * room each leaves for being wrong. Names are matched on a sorted letters-only
 * token set, which is what b205 found actually works
 * ("Surname, Forename" vs "Forename Surname", middle names, double-barrelled):
 * a (first,last) pair matched 22 of 110 and token sets matched 107.
 *
 * A name that matches TWO people is not a match. Two sisters on the staff, or a
 * married pair, would otherwise have one of them paid the other's figures.
 */
async function buildStaffIndex(db) {
  const { rows } = await db.query(`
    SELECT id, first_name, last_name, payroll_reference, ni_number, is_active
      FROM staff ORDER BY id`);
  const byRef = new Map(), byNi = new Map(), byName = new Map();
  for (const s of rows) {
    if (s.payroll_reference) push(byRef, idKey(s.payroll_reference), s);
    if (s.ni_number)        push(byNi,  niKey(s.ni_number), s);
    push(byName, tokenKey(`${s.first_name} ${s.last_name}`), s);
  }
  return { rows, byRef, byNi, byName };
}
function push(m, k, v) { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(v); }
/**
 * A name as a sorted token set: "Jones, Toby" and "Nursery Manager" give the same key.
 *
 * DIGITS ARE KEPT. The first version stripped them, which is tempting because
 * real names have none — and on wren_dev it collapsed 40 active staff to 14
 * distinct keys (the synthetic names are "Dev Person <hex>"), so almost every
 * row came back `ambiguous_name` and nothing imported. Keeping them costs
 * nothing on real data and it is the safer direction anyway: a collision makes
 * two people share a key, and the only thing standing between that and paying
 * one person the other's figures is the ambiguity check.
 */
function tokenKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/).filter(Boolean).sort().join(' ');
}

function matchStaff(index, row) {
  const ref = row.employee_ref, ni = row.ni_number, name = row.employee_name;
  if (ref) {
    const c = index.byRef.get(idKey(ref));
    if (c && c.length === 1) return { staff: c[0], how: 'payroll_reference' };
    if (c && c.length > 1)   return { staff: null, how: 'ambiguous_reference', candidates: c.length };
  }
  if (ni) {
    const c = index.byNi.get(niKey(ni));
    if (c && c.length === 1) return { staff: c[0], how: 'ni_number' };
    if (c && c.length > 1)   return { staff: null, how: 'ambiguous_ni', candidates: c.length };
  }
  if (name) {
    // "Surname, Forename" and "Forename Surname" both reduce to the same token
    // set, so the split is only needed to feed the fallback below.
    const c = index.byName.get(tokenKey(name));
    if (c && c.length === 1) return { staff: c[0], how: 'name' };
    if (c && c.length > 1)   return { staff: null, how: 'ambiguous_name', candidates: c.length };
    const parts = splitFullName(name);
    if (parts && parts.first && parts.last) {
      const c2 = index.byName.get(tokenKey(`${parts.first} ${parts.last}`));
      if (c2 && c2.length === 1) return { staff: c2[0], how: 'name_parts' };
    }
  }
  return { staff: null, how: 'unmatched' };
}

// ── Read a file ──────────────────────────────────────────────────────────────
/**
 * Parse and analyse, without writing anything.
 *
 * Returns the mapping it used (remembered, guessed or given), the parsed rows
 * with the staff each resolved to, the totals, and every warning. The UI shows
 * this and nothing is written until somebody presses Import.
 */
async function analyse(db, { csvText, kind = null, mapping = null } = {}) {
  const delim = sniffDelimiter(csvText);
  const grid = parseCSV(csvText, delim);
  const nonEmpty = grid.filter(r => r.some(c => String(c || '').trim() !== ''));
  if (!nonEmpty.length) return { error: 'empty_file' };

  // The header row is the first row with at least two cells that look like
  // headers rather than numbers. Paycheck's exports carry a title line and
  // sometimes a blank one above the real header.
  let hIdx = 0;
  for (let i = 0; i < Math.min(nonEmpty.length, 10); i++) {
    const cells = nonEmpty[i].filter(c => String(c || '').trim() !== '');
    const wordy = cells.filter(c => /[a-z]/i.test(String(c)) && parseMoney(c) == null).length;
    if (cells.length >= 2 && wordy >= 2) { hIdx = i; break; }
  }
  const headers = nonEmpty[hIdx].map(h => String(h || '').trim());
  const sig = headerSignature(headers);

  // Remembered layout first — "Wren reads them with a column-mapper that
  // remembers the layout". A mapping given explicitly still wins, so a person
  // can correct one that was learned wrong.
  let remembered = null, resolvedKind = kind;
  if (!resolvedKind || !mapping) {
    const { rows: mem } = await db.query(
      `SELECT * FROM payroll_run_import_mappings WHERE header_signature=$1
        ${resolvedKind ? 'AND file_kind=$2' : ''} ORDER BY times_used DESC LIMIT 1`,
      resolvedKind ? [sig, resolvedKind] : [sig]);
    if (mem.length) { remembered = mem[0]; resolvedKind = resolvedKind || mem[0].file_kind; }
  }
  const detected = detectKind(headers);
  if (!resolvedKind) resolvedKind = detected.kind;
  if (!resolvedKind || !FIELDS[resolvedKind]) {
    return { error: 'unknown_file_kind', headers, header_signature: sig, detection: detected };
  }

  const map = mapping || (remembered && remembered.mapping) || guessMapping(headers, resolvedKind);
  const fields = FIELD_BY[resolvedKind];

  const colOf = {};
  headers.forEach((h, i) => { const k = map[h]; if (k) colOf[k] = i; });

  const missingRequired = FIELDS[resolvedKind].filter(f => f.required && colOf[f.key] == null).map(f => f.label);

  const index = (resolvedKind === 'p32') ? null : await buildStaffIndex(db);
  const rows = [], warnings = [];
  if (missingRequired.length) {
    warnings.push({ code: 'missing_required_columns', severity: 'blocking',
      message: `This file has no column mapped to: ${missingRequired.join(', ')}. Map them, or pick a different report.` });
  }

  for (let i = hIdx + 1; i < nonEmpty.length; i++) {
    const cells = nonEmpty[i];
    const rec = { _row: i + 1 };
    let anyValue = false;
    for (const [key, ci] of Object.entries(colOf)) {
      const f = fields.get(key);
      const raw = cells[ci];
      let v;
      if (f.money) v = parseMoney(raw);
      else if (key === 'hours') v = parseHours(raw);
      else v = (raw == null ? null : String(raw).trim() || null);
      rec[key] = v;
      if (v != null && v !== '') anyValue = true;
    }
    if (!anyValue) continue;

    // The b205 grand-total trap, in its Paycheck form. A totals row puts the
    // word "Total" (or "Totals"/"Grand total") in the name column and the
    // column sums in the money ones. The first import of an EyMan report booked
    // such a row as a £4.29m payment and reconciliation PASSED, because both
    // sides read the same report. One guard, applied here before anything else.
    const nameish = String(rec.employee_name || rec.employee_ref || '');
    if (/^\s*(grand\s+)?totals?\b/i.test(nameish) || /^\s*sub[-\s]?totals?\b/i.test(nameish)) {
      rows.push(Object.assign(rec, { _skipped: 'totals_row' }));
      continue;
    }

    if (index) {
      const m = matchStaff(index, rec);
      rec._staff_id = m.staff ? m.staff.id : null;
      rec._matched_by = m.how;
      rec._candidates = m.candidates || null;
      // Toby is staff id 1 and his pay is in this file like everyone else's. The
      // importer writes to payroll_staff_lines, never to ladn.staff, so there is
      // no path from here to his PIN or any login field.
      if (m.staff && m.staff.is_active === false) {
        warnings.push({ code: 'inactive_staff', severity: 'info', row: rec._row,
          message: `Row ${rec._row} matched a member of staff who is no longer active — a leaver's final pay is legitimate, so it is imported.` });
      }
    }
    rows.push(rec);
  }

  const live = rows.filter(r => !r._skipped);
  const sum = (k) => live.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const totals = resolvedKind === 'p32'
    ? { tax_pence: sum('tax_pence'), ni_pence: sum('ni_pence'),
        employer_ni_pence: sum('employer_ni_pence'), total_pence: sum('total_pence') }
    : resolvedKind === 'pension'
      ? { pension_pence: sum('pension_pence'), employer_pension_pence: sum('employer_pension_pence'),
          pensionable_pence: sum('pensionable_pence') }
      : { gross_pence: sum('gross_pence'), tax_pence: sum('tax_pence'), ni_pence: sum('ni_pence'),
          employer_ni_pence: sum('employer_ni_pence'), pension_pence: sum('pension_pence'),
          net_pence: sum('net_pence'), hours: Math.round(sum('hours') * 100) / 100 };

  const unmatched = live.filter(r => index && !r._staff_id);
  if (unmatched.length) {
    warnings.push({ code: 'unmatched_rows', severity: 'warning', count: unmatched.length,
      message: `${unmatched.length} of ${live.length} rows could not be matched to a member of staff. They are reported and NOT imported — Wren never creates a staff record from a payroll file. Set the person's Payroll reference on their staff record and import again.` });
  }
  // The arithmetic self-check from b226: if the buckets do not sum to the total,
  // something is being read wrong, and that is better found here than in the run.
  if (resolvedKind === 'payslips' && totals.gross_pence > 0) {
    const deductions = totals.tax_pence + totals.ni_pence + totals.pension_pence;
    const implied = totals.gross_pence - deductions;
    if (Math.abs(implied - totals.net_pence) > live.length) {   // 1p per row of rounding
      warnings.push({ code: 'gross_net_mismatch', severity: 'warning',
        message: `Gross less tax, NI and pension comes to ${implied}p but the file's net total is ${totals.net_pence}p — a difference of ${implied - totals.net_pence}p. There is probably another deduction or addition column that is not mapped (student loan, salary sacrifice, expenses).` });
    }
  }
  if (resolvedKind === 'p32' && totals.total_pence > 0) {
    const parts = totals.tax_pence + totals.ni_pence + totals.employer_ni_pence;
    if (parts > 0 && parts !== totals.total_pence) {
      warnings.push({ code: 'p32_parts_mismatch', severity: 'warning',
        message: `Tax, employee NI and employer NI add up to ${parts}p but the stated total due is ${totals.total_pence}p.` });
    }
  }

  return {
    file_kind: resolvedKind,
    detection: detected,
    header_signature: sig,
    headers,
    mapping: map,
    mapping_source: mapping ? 'given' : (remembered ? 'remembered' : 'guessed'),
    remembered_mapping_id: remembered ? remembered.id : null,
    options: mappingOptions(resolvedKind),
    unmapped_headers: headers.filter(h => !map[h]),
    missing_required: missingRequired,
    rows_in_file: rows.length,
    rows_usable: live.length,
    rows_skipped_totals: rows.filter(r => r._skipped === 'totals_row').length,
    rows_matched: live.filter(r => r._staff_id).length,
    rows_unmatched: unmatched.length,
    unmatched_rows: unmatched.map(r => ({ row: r._row, matched_by: r._matched_by, candidates: r._candidates })),
    totals,
    warnings,
    can_import: !missingRequired.length && live.length > 0,
    // Never the parsed rows themselves: they hold NI numbers and per-person pay.
    // The caller gets counts and totals; the rows go straight into the run.
    _rows: live,
  };
}

// ── Write a run ──────────────────────────────────────────────────────────────
/**
 * Apply an analysed file to a payroll run, in one transaction.
 *
 * `payroll_runs` carries UNIQUE(period_year, period_month) from its original
 * migration — one run per calendar month, kept deliberately because dropping it
 * is destructive on a prod table (project_payroll_screen_b228). So the month's
 * run is found or created, and the three files for one month all land on it:
 * payslips write the lines and the gross/net totals, p32 corrects the HMRC
 * figures, pension fills the pension total.
 */
async function applyFile(db, {
  csvText, kind = null, mapping = null, periodYear, periodMonth,
  actorId = null, remember = true, filename = null,
} = {}) {
  const a = await analyse(db, { csvText, kind, mapping });
  if (a.error) return a;
  if (!a.can_import) return Object.assign({ error: 'cannot_import' }, a);
  if (!(periodYear > 0) || !(periodMonth >= 1 && periodMonth <= 12)) {
    return { error: 'bad_period', message: 'A payroll month (year and month) is required.' };
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL search_path TO ladn');

    let { rows: [run] } = await client.query(
      'SELECT * FROM payroll_runs WHERE period_year=$1 AND period_month=$2 FOR UPDATE',
      [periodYear, periodMonth]);
    if (run && run.status === 'finalised') {
      await client.query('ROLLBACK');
      return { error: 'run_finalised', run_id: run.id,
        message: `The ${run.period_label} run is finalised. A finalised run's figures are the record — unlock it on the Payroll screen first if Paycheck has reissued the month.` };
    }
    if (!run) {
      const from = `${periodYear}-${String(periodMonth).padStart(2, '0')}-01`;
      const { rows: [r] } = await client.query(`
        INSERT INTO payroll_runs
          (period_label, period_year, period_month, period_from, period_to, status,
           period_shape, hours_note, generated_by)
        VALUES ($1,$2,$3,$4::date, (date_trunc('month',$4::date) + INTERVAL '1 month - 1 day')::date,
                'draft','monthly',$5,$6)
        RETURNING *`,
        [monthLabel(periodYear, periodMonth), periodYear, periodMonth, from,
         'Imported from Paycheck — these are the figures that were actually paid, not inferred from clocked hours.',
         actorId]);
      run = r;
    }

    let linesWritten = 0, linesUpdated = 0, linesInserted = 0;
    if (a.file_kind === 'payslips') {
      // UPSERT per person, never DELETE-then-INSERT.
      //
      // payroll_staff_lines is a production table and the absolute rules are
      // additive-only, so re-importing a corrected file UPDATES the person's
      // existing line in place. There is no unique index on (run_id, staff_id) to
      // hang an ON CONFLICT off — adding one would mean de-duplicating a prod
      // table first — so the upsert is an UPDATE and an INSERT when it touched
      // nothing. A line left untouched by this file is REPORTED below, not
      // removed: a person who is in Wren's generated run but not in Paycheck's
      // file is a question for a human, not a row to delete.
      for (const r of a._rows) {
        if (!r._staff_id) continue;
        const u = await client.query(`
          UPDATE payroll_staff_lines SET
            gross_pence=$2, tax_pence=$3, ni_pence=$4, employer_ni_pence=$5,
            pension_pence=$6, net_pence=$7, hours_worked=$8,
            hours_source='paycheck-import', hours_inferred=false, pay_basis='paycheck',
            notes=$9, edited=false, updated_at=now()
           WHERE run_id=$1 AND staff_id=$10`,
          [run.id, r.gross_pence || 0, r.tax_pence || 0, r.ni_pence || 0,
           r.employer_ni_pence, r.pension_pence || 0, r.net_pence || 0, r.hours || 0,
           `Paycheck row ${r._row}, matched by ${r._matched_by}`, r._staff_id]);
        if (u.rowCount) { linesUpdated += u.rowCount; linesWritten += u.rowCount; continue; }
        await client.query(`
          INSERT INTO payroll_staff_lines
            (run_id, staff_id, staff_name, gross_pence, tax_pence, ni_pence, employer_ni_pence,
             pension_pence, net_pence, hours_worked, hours_source, hours_inferred, pay_basis, notes)
          SELECT $1, s.id, s.first_name || ' ' || s.last_name, $2,$3,$4,$5,$6,$7,$8,
                 'paycheck-import', false, 'paycheck', $9
            FROM staff s WHERE s.id = $10`,
          [run.id, r.gross_pence || 0, r.tax_pence || 0, r.ni_pence || 0,
           r.employer_ni_pence, r.pension_pence || 0, r.net_pence || 0, r.hours || 0,
           `Paycheck row ${r._row}, matched by ${r._matched_by}`, r._staff_id]);
        linesInserted++; linesWritten++;
      }
      // Lines on this run that Paycheck's file did not mention. Counted, named
      // in the result, left alone.
      const staffInFile = a._rows.filter(r => r._staff_id).map(r => r._staff_id);
      const { rows: [stale] } = await client.query(`
        SELECT COUNT(*)::int AS n FROM payroll_staff_lines
         WHERE run_id=$1 AND NOT (staff_id = ANY($2::int[]))`, [run.id, staffInFile]);
      var linesNotInFile = stale.n;
      // The run's totals come from the FILE, so a line the file did not mention
      // is not in them — which is why it has to be reported rather than ignored.
      await client.query(`
        UPDATE payroll_runs SET
          total_gross_pence = $2, total_tax_pence = $3, total_ni_pence = $4,
          total_pension_pence = $5, total_net_pence = $6,
          total_employer_ni_pence = COALESCE(NULLIF($7::bigint, 0), total_employer_ni_pence),
          staff_count = $8, hours_note = $9, updated_at = now()
         WHERE id = $1`,
        [run.id, a.totals.gross_pence, a.totals.tax_pence, a.totals.ni_pence,
         a.totals.pension_pence, a.totals.net_pence, a.totals.employer_ni_pence,
         linesWritten,
         'Imported from Paycheck — actual figures, not inferred from clocked hours.']);

    } else if (a.file_kind === 'p32') {
      // The P32 is the authority on what HMRC is owed, so it OVERWRITES the tax
      // and NI totals the payslip file set. The payslip file is the authority on
      // gross and net, so those are left alone.
      await client.query(`
        UPDATE payroll_runs SET
          total_tax_pence = COALESCE(NULLIF($2::bigint,0), total_tax_pence),
          total_ni_pence  = COALESCE(NULLIF($3::bigint,0), total_ni_pence),
          total_employer_ni_pence = COALESCE(NULLIF($4::bigint,0), total_employer_ni_pence),
          updated_at = now()
         WHERE id = $1`,
        [run.id, a.totals.tax_pence, a.totals.ni_pence, a.totals.employer_ni_pence]);

    } else if (a.file_kind === 'pension') {
      await client.query(`
        UPDATE payroll_runs SET
          total_pension_pence = COALESCE(NULLIF($2::bigint,0), total_pension_pence),
          updated_at = now()
         WHERE id = $1`, [run.id, a.totals.pension_pence]);
      // Per-person contributions, onto the lines the payslip file created. A
      // pension file loaded on its own has no lines to land on, which is said
      // rather than silently doing nothing.
      for (const r of a._rows) {
        if (!r._staff_id) continue;
        const u = await client.query(
          `UPDATE payroll_staff_lines SET pension_pence=$3, updated_at=now()
            WHERE run_id=$1 AND staff_id=$2`, [run.id, r._staff_id, r.pension_pence || 0]);
        linesWritten += u.rowCount;
      }
    }

    const { rows: [imp] } = await client.query(`
      INSERT INTO payroll_file_imports
        (run_id, file_kind, filename, header_signature, mapping, period_year, period_month,
         rows_in_file, rows_matched, rows_unmatched, totals, warnings, status, imported_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'applied',$13) RETURNING *`,
      [run.id, a.file_kind, filename, a.header_signature,
       JSON.stringify(a.mapping), periodYear, periodMonth,
       a.rows_in_file, a.rows_matched, a.rows_unmatched,
       JSON.stringify(a.totals), JSON.stringify(a.warnings), actorId]);

    if (remember) {
      await client.query(`
        INSERT INTO payroll_run_import_mappings
          (file_kind, header_signature, source_label, mapping, headers, created_by, last_used_at, times_used)
        VALUES ($1,$2,'Paycheck',$3,$4,$5,now(),1)
        ON CONFLICT (file_kind, header_signature) DO UPDATE SET
          mapping = EXCLUDED.mapping, headers = EXCLUDED.headers,
          last_used_at = now(), times_used = payroll_run_import_mappings.times_used + 1,
          updated_at = now()`,
        [a.file_kind, a.header_signature, JSON.stringify(a.mapping),
         JSON.stringify(a.headers), actorId]);
    }

    await client.query('COMMIT');

    // Post the totals to the ledger view AFTER the commit: the posting is
    // derived from the committed run, and a failure to post must not lose the
    // import. It is idempotent, so the Accounts page's Refresh re-posts it.
    const store = require('./accounts-store');
    const posted = await store.postPayrollRun(db, run.id, { actorId }).catch(e => ({ error: e.message }));

    return {
      ok: true, run_id: run.id, run_label: run.period_label,
      file_kind: a.file_kind, import_id: imp.id,
      lines_written: linesWritten,
      lines_updated: linesUpdated, lines_inserted: linesInserted,
      lines_not_in_file: (typeof linesNotInFile === 'number') ? linesNotInFile : null,
      rows_in_file: a.rows_in_file, rows_matched: a.rows_matched, rows_unmatched: a.rows_unmatched,
      rows_skipped_totals: a.rows_skipped_totals,
      totals: a.totals, warnings: a.warnings,
      mapping_remembered: remember, posted,
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (y, m) => `${MONTHS[(Number(m) || 1) - 1]} ${y}`;

module.exports = {
  FIELDS, FIELD_BY, KINDS, mappingOptions, detectKind, guessMapping,
  parseMoney, parseHours, tokenKey, buildStaffIndex, matchStaff,
  analyse, applyFile, monthLabel,
};
