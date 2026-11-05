'use strict';
// ============================================================================
// b363 (2026-09-29) — Roost → Staff → Payroll → "Import payroll details (CSV)".
// Mounted INSIDE src/routes/payroll.js as `/import`, so the live paths are
// /api/payroll/import/*.
//
// WHY MOUNTED INSIDE payroll.js RATHER THAN AS ITS OWN /api PREFIX
// ---------------------------------------------------------------------------
// editions/ladn/server-unified.js gates by FIRST PATH SEGMENT: PARENT_DENY,
// HR_DENY, OFFSITE_CHILD and FINANCE_SET all list 'payroll'. Hanging this off
// that same segment means it inherits every one of those rules as written —
// including the off-site FINANCE_SET denial, which is exactly right for a screen
// that shows every employee's NI number and pay. A new top-level prefix would
// have had to be added to four separate lists correctly, and the failure mode of
// getting that wrong is silent.
//
// THE GATES, OUTERMOST FIRST
//   1. Roost person allowlist (server-unified.js, ladn.settings
//      roost_admin_staff_ids) — the admin host answers everyone else
//      403 roost_restricted before any route runs.
//   2. FINANCE_SET off-site denial — no payroll data off the premises.
//   3. authenticate + requireStaffAdmin, from payroll.js.
//   4. requireSalaryView, HERE, on the whole router: owner / admin /
//      headteacher / business_manager, or an explicit view_staff_salaries grant.
//      A DEPUTY MANAGER IS REFUSED — the deputy runs the staff list and does not see
//      pay (src/lib/capabilities.js, project_staff_salary_permissions). This is
//      the one gate that makes this router different from its parent, which
//      deliberately lets a deputy see hours.
//
// WHAT IT CANNOT DO, BY CONSTRUCTION
//   • Write any column not in src/lib/payroll-import.js WRITABLE_COLUMNS.
//     assertWritable() runs per column per UPDATE and throws rather than writes.
//   • Touch pin_hash, protected_staff_pins, role, email or any totp_* field:
//     they are on FORBIDDEN_COLUMNS and the registry has no entry for them.
//   • Create a staff row. An id that matches nobody is reported as unmatched.
//   • Clear a field. A blank cell means "leave what Wren has".
//   • Half-apply a person. One transaction; a throw rolls the lot back.
//
// STAFF ID 1 (Toby) is writable HERE for pay and tax fields — he asked for that
// explicitly, he is the only person who can reach this screen by default, and
// the columns available are pay columns. His login fields are unreachable for
// the same reason everybody else's are.
// ============================================================================

const express = require('express');
const router  = express.Router();
const { getPool } = require('../db/pool');
const { requireSalaryView } = require('../lib/capabilities');
const { recordAudit } = require('../utils/audit');
const imp = require('../lib/payroll-import');

// Roost only. The parent router (/api/payroll) is deliberately reachable from
// the EY host, because a manager on a tablet in the office has a legitimate
// reason to look at hours. This router is every employee's NI number, date of
// birth, home address and pay in one response, and its only screen is on Roost,
// so a request from any other portal is refused whatever the token says.
//
// `|| 'admin'` rather than cameras.js's `|| null`: req._portal is set by the
// hostname dispatcher in editions/ladn/server-unified.js, and the demo and school
// editions that bake src/ have no dispatcher at all. Refusing a missing portal
// would break the importer on those editions rather than protect anything there.
// Same idiom as src/routes/email-rules.js.
router.use((req, res, next) => {
  const portal = req._portal || 'admin';
  if (portal !== 'admin') {
    return res.status(403).json({ error: 'forbidden_portal',
      message: 'Importing payroll details is done in Roost.' });
  }
  next();
});

// Pay gate on the whole router — see note 4 above.
router.use(requireSalaryView);

// A staff export is a few kilobytes. 2MB is ~10,000 rows and is here to stop a
// mis-dropped video from being parsed as a spreadsheet, not to be a real limit.
const MAX_CSV_BYTES = 2 * 1024 * 1024;

function csvFromBody(req, res) {
  const csv = req.body && req.body.csv;
  if (typeof csv !== 'string' || !csv.trim()) {
    res.status(400).json({ error: 'no_csv', message: 'No file contents arrived with that request.' });
    return null;
  }
  if (Buffer.byteLength(csv, 'utf8') > MAX_CSV_BYTES) {
    res.status(413).json({ error: 'csv_too_large',
      message: `That file is larger than the ${Math.round(MAX_CSV_BYTES / 1024 / 1024)}MB a payroll `
             + 'export should ever be. Check it is the CSV and not a spreadsheet with images in it.' });
    return null;
  }
  return csv;
}

/** Only real field keys, only for headers in this file — never trust a posted map. */
function cleanMapping(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [header, key] of Object.entries(raw)) {
    if (typeof header !== 'string' || !header.length) continue;
    if (key === null || key === '' || key === undefined) continue;
    if (typeof key !== 'string' || !imp.FIELD_BY_KEY.has(key)) continue;
    out[header] = key;
  }
  return out;
}

/** { "12:tax_code": true } — anything else is dropped. */
function cleanOverwrite(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [k, v] of Object.entries(raw)) {
    if (v !== true) continue;
    const m = /^(\d{1,9}):([a-z0-9_]+)$/.exec(String(k));
    if (!m || !imp.FIELD_BY_KEY.has(m[2])) continue;
    out[`${Number(m[1])}:${m[2]}`] = true;
  }
  return out;
}

// ── GET /api/payroll/import/context ─────────────────────────────────────────
// Everything the screen needs before a file exists: what can be mapped, the
// mappings this setting has taught Wren before, the last few imports, and the
// gap list as it stands right now.
router.get('/context', async (req, res) => {
  const db = getPool();
  try {
    const [mappings, batches, gaps] = await Promise.all([
      db.query(`SELECT id, header_signature, source_label, mapping, headers, times_used,
                       last_used_at, created_at
                  FROM payroll_import_mappings
                 ORDER BY COALESCE(last_used_at, created_at) DESC LIMIT 10`).then(r => r.rows, () => []),
      db.query(`SELECT b.id, b.filename, b.source_label, b.rows_in_file, b.rows_matched,
                       b.rows_unmatched, b.staff_touched, b.fields_filled, b.fields_overwritten,
                       b.fields_rejected, b.applied_at, b.applied_by,
                       (s.first_name || ' ' || s.last_name) AS applied_by_name
                  FROM payroll_import_batches b
                  LEFT JOIN staff s ON s.id = b.applied_by
                 ORDER BY b.applied_at DESC LIMIT 8`).then(r => r.rows, () => []),
      imp.gaps(db),
    ]);
    res.json({
      options: imp.mappingOptions(),
      group_labels: imp.GROUP_LABELS,
      writable_columns: [...imp.WRITABLE_COLUMNS].sort(),
      saved_mappings: mappings,
      recent_imports: batches,
      gaps,
      rules: [
        'Blanks are filled in. A value already in Wren is only replaced if you tick that field.',
        'Rows are matched on the BrightHR employee id, then the payroll number, then the email '
          + 'address, then an exact first and last name. Nothing is guessed.',
        'A value that is not the right shape is refused with the reason. The rest of the file '
          + 'still applies.',
        'An import cannot change a PIN, a role, an email address or anything else used to log in.',
      ],
      // Said on every payroll surface so nothing here reads as a filing.
      not_a_filing: 'Wren does not file with HMRC. This is what the employer needs on file to operate PAYE.',
    });
  } catch (e) {
    res.status(500).json({ error: 'context_failed', message: e.message });
  }
});

// ── GET /api/payroll/import/gaps ────────────────────────────────────────────
// The same list the Payroll run needs, on its own so the screen can refresh it
// after an apply without re-reading everything else.
router.get('/gaps', async (req, res) => {
  try {
    res.json(await imp.gaps(getPool()));
  } catch (e) {
    res.status(500).json({ error: 'gaps_failed', message: e.message });
  }
});

// ── GET /api/payroll/import/template.csv ────────────────────────────────────
// For a setting with no BrightHR at all: the headers Wren recognises, and one
// example row so the date and money formats are unambiguous.
router.get('/template.csv', (req, res) => {
  const headers = imp.templateHeaders();
  const example = headers.map(h => {
    switch (h) {
      case 'BrightHR employee id': return 'EMP001';
      case 'Payroll number':       return '17';
      case 'Email address':        return 'someone@example.co.uk';
      case 'First name':           return 'Example';
      case 'Last name':            return 'Person';
      case 'NI number':            return 'AB123456C';
      case 'Tax code':             return '1257L';
      case 'Date of birth':        return '14/03/1994';
      case 'Pay basis':            return 'hourly';
      case 'Hourly rate':          return '13.25';
      case 'Annual salary':        return '';
      case 'Contracted hours':     return '37.5';
      case 'Start date':           return '02/09/2024';
      case 'Employment type':      return 'permanent';
      case 'Holiday entitlement':  return '28';
      case 'Pension status':       return 'enrolled';
      case 'Employee pension %':   return '5';
      case 'Employer pension %':   return '3';
      case 'Address line 1':       return '123 Example Lane';
      case 'Address line 2':       return 'Ealing';
      case 'Postcode':             return 'AB1 2CD';
      default:                     return '';
    }
  });
  const line = a => a.map(v => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v)).join(',');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wren-payroll-details-template.csv"');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send('﻿' + line(headers) + '\r\n' + line(example) + '\r\n');
});

// ── POST /api/payroll/import/preview ────────────────────────────────────────
// WRITES NOTHING. Every table is untouched, including the mapping store — the
// mapping is only remembered when a file is actually applied, so experimenting
// with a mapping cannot teach Wren a wrong one.
router.post('/preview', async (req, res) => {
  const csv = csvFromBody(req, res); if (csv === null) return;
  try {
    const out = await imp.analyse(getPool(), {
      csvText: csv,
      mapping: cleanMapping(req.body.mapping),
      overwrite: cleanOverwrite(req.body.overwrite),
    });
    if (out.fatal) return res.status(422).json(out.fatal);

    // A saved mapping for these exact headers, offered when the caller has not
    // sent one of its own.
    if (!req.body.mapping || !Object.keys(req.body.mapping).length) {
      const { rows } = await getPool().query(
        'SELECT mapping, source_label, times_used FROM payroll_import_mappings WHERE header_signature = $1',
        [out.signature]).catch(() => ({ rows: [] }));
      if (rows.length) {
        out.saved_mapping = rows[0].mapping;
        out.saved_mapping_label = rows[0].source_label;
        out.saved_mapping_times_used = rows[0].times_used;
      }
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'preview_failed', message: e.message });
  }
});

// ── POST /api/payroll/import/apply ──────────────────────────────────────────
// One transaction. The file is RE-PARSED and RE-VALIDATED here against the rows
// as they are inside that transaction — the preview's own output is never
// trusted as an instruction, because between the two calls somebody may have
// edited a staff record on another screen, and "fill the blank" must mean the
// blank as it is now.
router.post('/apply', async (req, res) => {
  const csv = csvFromBody(req, res); if (csv === null) return;
  const mapping   = cleanMapping(req.body.mapping);
  const overwrite = cleanOverwrite(req.body.overwrite);
  const filename  = String(req.body.filename || '').slice(0, 200) || null;
  const label     = String(req.body.source_label || '').slice(0, 120) || null;

  const db = getPool();
  const client = await db.connect();
  let committed = false;
  try {
    await client.query('BEGIN');

    const plan = await imp.analyse(client, { csvText: csv, mapping, overwrite });
    if (plan.fatal) { await client.query('ROLLBACK'); return res.status(422).json(plan.fatal); }

    if (req.body.checksum && req.body.checksum !== plan.checksum) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'file_changed',
        message: 'That is not the file that was previewed. Preview it again before applying.' });
    }

    const toWrite = plan.changes.filter(c => c.applied);
    if (!toWrite.length) {
      await client.query('ROLLBACK');
      return res.status(200).json({
        applied: false, reason: 'nothing_to_write',
        message: plan.counts.overwrites_available
          ? 'Nothing was written. Every field in that file either already matches Wren or would '
            + 'replace a value, and replacing one needs its tick.'
          : 'Nothing was written — every field in that file already matches what Wren holds.',
        counts: plan.counts, gaps: await imp.gaps(client),
      });
    }

    // ── the batch header ──
    const { rows: [batch] } = await client.query(
      `INSERT INTO payroll_import_batches
         (filename, source_label, header_signature, mapping, rows_in_file, rows_matched,
          rows_unmatched, staff_touched, fields_filled, fields_overwritten, fields_rejected, applied_by)
       VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING id, applied_at`,
      [filename, label, plan.signature, JSON.stringify(plan.mapping),
       plan.counts.rows_in_file, plan.counts.rows_matched, plan.counts.rows_unmatched,
       new Set(toWrite.map(c => c.staff_id)).size,
       toWrite.filter(c => c.state === 'fill').length,
       toWrite.filter(c => c.state === 'overwrite').length,
       plan.counts.fields_rejected, req.user.id]);

    // ── one UPDATE per person ──
    const byStaff = new Map();
    for (const c of toWrite) {
      if (!byStaff.has(c.staff_id)) byStaff.set(c.staff_id, []);
      byStaff.get(c.staff_id).push(c);
    }

    const auditRows = [];
    for (const [staffId, list] of byStaff) {
      const sets = [], params = [];
      for (const c of list) {
        const col = imp.assertWritable(c.column);          // throws → whole apply rolls back
        params.push(c.value);
        sets.push(`${col} = $${params.length}`);
        if (c.also_fill_blank) {
          // COALESCE, not a bare assignment: this column is filled only while it
          // is empty, and re-running the same file must not start overwriting it.
          const extra = imp.assertWritable(c.also_fill_blank);
          sets.push(`${extra} = COALESCE(${extra}, $${params.length})`);
        }
      }
      sets.push('updated_at = now()');
      params.push(staffId);
      const { rowCount } = await client.query(
        `UPDATE staff SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
      if (rowCount !== 1) throw new Error(`staff ${staffId} did not update — rolling the import back`);

      for (const c of list) {
        const oldM = imp.maskFor(c.field, c.old || null);
        const newM = imp.maskFor(c.field, c.new);
        await client.query(
          `INSERT INTO payroll_import_changes
             (batch_id, staff_id, field, column_name, old_value, new_value, masked,
              was_overwrite, matched_by, csv_line)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [batch.id, staffId, c.field, c.column, oldM.text, newM.text, oldM.masked || newM.masked,
           c.state === 'overwrite', (plan.rows.find(r => r.staff_id === staffId) || {}).matched_by || null,
           c.line]);
        auditRows.push({ staffId, c, oldM, newM });
      }
    }

    await client.query('COMMIT');
    committed = true;

    // Audit AFTER the commit, one entry per FIELD, which is the grain the brief
    // asks for. Masked exactly as the changes table is: an audit trail that
    // holds every NI number in the setting is a new place for them to leak from.
    for (const a of auditRows) {
      recordAudit({
        req, action: 'update', entity_type: 'staff', entity_id: a.staffId,
        diff: { old: { [a.c.field]: a.oldM.text }, new: { [a.c.field]: a.newM.text } },
        meta: {
          feature: 'payroll-import', batch_id: batch.id, field: a.c.field, column: a.c.column,
          was_overwrite: a.c.state === 'overwrite', masked: a.oldM.masked || a.newM.masked,
          matched_by: (plan.rows.find(r => r.staff_id === a.staffId) || {}).matched_by || null,
          csv_line: a.c.line, filename,
        },
      });
    }

    // Remember the mapping — only now, only because it worked.
    await db.query(
      `INSERT INTO payroll_import_mappings
         (header_signature, source_label, mapping, headers, created_by, last_used_at, times_used)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,now(),1)
       ON CONFLICT (header_signature) DO UPDATE SET
         mapping      = EXCLUDED.mapping,
         source_label = COALESCE(EXCLUDED.source_label, payroll_import_mappings.source_label),
         headers      = EXCLUDED.headers,
         last_used_at = now(),
         times_used   = payroll_import_mappings.times_used + 1,
         updated_at   = now()`,
      [plan.signature, label, JSON.stringify(plan.mapping), JSON.stringify(plan.headers), req.user.id])
      .catch(e => console.error('[payroll-import] mapping not remembered:', e.message));

    res.json({
      applied: true,
      batch_id: batch.id,
      applied_at: batch.applied_at,
      staff_touched: byStaff.size,
      fields_written: toWrite.length,
      fields_filled: toWrite.filter(c => c.state === 'fill').length,
      fields_overwritten: toWrite.filter(c => c.state === 'overwrite').length,
      fields_rejected: plan.counts.fields_rejected,
      rows_unmatched: plan.counts.rows_unmatched,
      rejects: plan.rejects,
      unmatched: plan.unmatched,
      // Per person, what landed — masked for NI and tax code exactly as the log is.
      landed: [...byStaff.entries()].map(([staffId, list]) => ({
        staff_id: staffId,
        name: (plan.rows.find(r => r.staff_id === staffId) || {}).name || null,
        fields: list.map(c => ({
          field: c.field, label: c.label,
          old: imp.maskFor(c.field, c.old || null).text,
          new: imp.maskFor(c.field, c.new).text,
          masked: !!c.sensitive, was_overwrite: c.state === 'overwrite',
        })),
      })),
      // The whole point of the screen: the gaps, recounted.
      gaps: await imp.gaps(db),
    });
  } catch (e) {
    if (!committed) { try { await client.query('ROLLBACK'); } catch (_) {} }
    console.error('[payroll-import] apply failed:', e.message);
    res.status(500).json({ error: 'apply_failed',
      message: committed
        ? `The import was applied but the summary could not be built: ${e.message}`
        : `Nothing was written — the whole import was rolled back. ${e.message}` });
  } finally {
    client.release();
  }
});

// ── GET /api/payroll/import/batches/:id ─────────────────────────────────────
// What one import did, as logged. Values are as masked as the log is; this is
// not a way round the masking.
router.get('/batches/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad_id' });
  const db = getPool();
  try {
    const { rows: [batch] } = await db.query(
      `SELECT b.*, (s.first_name || ' ' || s.last_name) AS applied_by_name
         FROM payroll_import_batches b
         LEFT JOIN staff s ON s.id = b.applied_by
        WHERE b.id = $1`, [id]);
    if (!batch) return res.status(404).json({ error: 'not_found' });
    const { rows: changes } = await db.query(
      `SELECT c.*, (s.first_name || ' ' || s.last_name) AS staff_name
         FROM payroll_import_changes c
         LEFT JOIN staff s ON s.id = c.staff_id
        WHERE c.batch_id = $1
        ORDER BY s.first_name, s.last_name, c.field`, [id]);
    res.json({ batch, changes });
  } catch (e) {
    res.status(500).json({ error: 'batch_failed', message: e.message });
  }
});

module.exports = router;
