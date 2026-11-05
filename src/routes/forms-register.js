'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Forms & documents register (2026-09-23).
//
// Toby: "is there a section on admin where I can [see] a table of all of the forms, similar to
// funding loop, where I can drop down by age and then export the files for the portal? And that
// way I can see any missing documents or fields."
//
// This is the COMPLIANCE view: one row per child, what is on file, what is not. It is not the
// same thing as /parent-forms.html, which is the chase list of forms a parent has been asked to
// sign and has not — that stays where it is and the two pages link to each other.
//
// Everything here is read-only and derived; nothing is stored twice.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);
const MGR = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager', 'owner'];
const managerOnly = (req, res, next) =>
  MGR.includes(req.user && req.user.role) ? next() : res.status(403).json({ error: 'Manager access required' });

// Age band on the census date, which is what the LA asks for — not age today.
// Under 2 / 2-year-old / 3-4 year old are the funding populations.
const BAND_SQL = `
  CASE
    WHEN c.date_of_birth IS NULL THEN 'unknown'
    WHEN age($2::date, c.date_of_birth) < interval '2 years' THEN 'under_2'
    WHEN age($2::date, c.date_of_birth) < interval '3 years' THEN 'two'
    WHEN age($2::date, c.date_of_birth) < interval '5 years' THEN 'three_four'
    ELSE 'over_5'
  END`;

async function build(db, termId, onDate) {
  const { rows } = await db.query(`
    SELECT
      c.id AS child_id,
      COALESCE(NULLIF(c.preferred_name,''), c.first_name) AS first_name,
      c.last_name,
      to_char(c.date_of_birth,'YYYY-MM-DD') AS dob,
      ${BAND_SQL} AS age_band,
      r.name AS room_name,
      c.is_active,
      to_char(c.leave_date,'YYYY-MM-DD') AS leave_date,
      cf.id AS allocation_id,
      cf.funding_type,
      cf.universal_hours_week, cf.extended_hours_week, cf.total_hours_week,
      cf.stretched_funding,
      NULLIF(cf.thirty_hour_code,'')  AS thirty_hour_code,
      NULLIF(cf.carer_ni_number,'')   AS carer_ni_number,
      NULLIF(cf.two_year_ref,'')      AS two_year_ref,
      cf.declaration_signed,
      to_char(cf.declaration_signed_date,'YYYY-MM-DD') AS declaration_signed_date,
      to_char(cf.declaration_sent_at,'YYYY-MM-DD')     AS declaration_sent_at,
      (SELECT count(*) FROM person_documents d
        WHERE d.subject_type='child' AND d.subject_id=c.id AND NOT d.deleted)::int AS documents_on_file,
      (SELECT max(r2.sent_at)::date FROM funding_declaration_reminders r2
        WHERE r2.child_id=c.id AND r2.term_id=$1)       AS last_chased,
      EXISTS (SELECT 1 FROM parent_portal_access p WHERE p.child_id=c.id) AS parent_has_app
    FROM children c
    LEFT JOIN rooms r ON r.id = c.room_id
    LEFT JOIN child_funding cf ON cf.child_id = c.id AND cf.term_id = $1
   WHERE c.is_active = true OR cf.id IS NOT NULL
   ORDER BY c.first_name, c.last_name`, [termId, onDate]);

  // b502 — the "Still needed" list is the SAME one the Missing-details page, the parents' To-do banner and the reminder campaigns use
  // (src/lib/outstanding.js). The register keeps the few funding-only checks the engine does not model (childcare code, 2-year reference,
  // hours, declaration on file, entitlement check, parent app access, date of birth) and takes everything else from the engine.
  const engine = new Map();
  try {
    const e = await require('../lib/outstanding').forChildren(db, { childIds: rows.map(r => r.child_id), includeComplete: true });
    e.forEach(x => engine.set(Number(x.child_id), x));
  } catch (err) { console.error('[forms-register] engine:', err.message); }

  // "Missing" is only ever asserted for something that child actually needs.
  // A child with no funded allocation is not missing a childcare code.
  return rows.map((r) => {
    const missing = [];
    const claimsExtended = r.funding_type === 'extended';
    const claimsTwoYear = r.funding_type === '2yr_working' || r.funding_type === '2yr_disadvantaged';
    if (r.allocation_id) {
      if (!r.declaration_signed) missing.push('signed declaration');
      if (claimsExtended && !r.thirty_hour_code) missing.push('childcare code');
      if (claimsTwoYear && !r.two_year_ref) missing.push('2-year LA reference');
      if (!r.carer_ni_number) missing.push('NI number');
      if (!r.documents_on_file) missing.push('declaration on file');
      if (!Number(r.total_hours_week)) missing.push('hours');
    }
    if (!r.dob) missing.push('date of birth');
    if (!r.parent_has_app) missing.push('parent app access');

    // 2026-09-23 — the entitlement category has to match the child's AGE, because the rate does.
    // The EyMan importer decides 'extended' purely from whether extended hours exist; it has no
    // age logic at all. On Autumn 2026 that left 9 under-2s and 10 two-year-olds typed as the
    // 3-4 year old extended entitlement, which is paid at £5.94 against £12.56 for an under-2
    // and £8.96 for a two-year-old. Flagged, never corrected automatically: changing the
    // category changes what is claimed from the LA, and that is Toby's call on each child.
    if (r.allocation_id && r.funding_type === 'extended' && (r.age_band === 'under_2' || r.age_band === 'two')) {
      missing.push(r.age_band === 'under_2'
        ? 'check entitlement: under 2, typed 3-4yr'
        : 'check entitlement: 2-year-old, typed 3-4yr');
    }
    // b502 — fold the engine's items in; 'signed declaration' and 'NI number' were this file's own versions of engine items, so the engine's wording replaces them.
    const eng = engine.get(Number(r.child_id));
    let merged = missing;
    if (eng) {
      const own = missing.filter(m => m !== 'signed declaration' && m !== 'NI number');
      const fromEngine = eng.items.map(i => i.label);
      merged = [...fromEngine, ...own.filter(m => !fromEngine.includes(m))];
    }
    return Object.assign(r, {
      funded: !!r.allocation_id && r.funding_type && r.funding_type !== 'none',
      missing: merged,
      outstanding_items: eng ? eng.items.map(i => ({ code: i.code, label: i.label, who: i.who })) : [],
      // "ready" keeps its old meaning: a funded child with nothing funding-related missing. Engine items about the child's file
      // (consents, All About Me, key person) show in "Still needed" but do not turn a funding-ready child red.
      ready: r.allocation_id ? missing.length === 0 : null,
    });
  });
}

// ── GET / — the register ─────────────────────────────────────────────────────
router.get('/', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    let termId = parseInt(req.query.term_id, 10);
    if (!Number.isInteger(termId)) {
      const { rows: t } = await db.query(
        `SELECT id FROM funding_terms
          ORDER BY (is_current IS TRUE) DESC, (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC
          LIMIT 1`);
      if (!t.length) return res.status(400).json({ error: 'No funding term configured' });
      termId = t[0].id;
    }
    const { rows: [term] } = await db.query(`SELECT id, name, start_date, end_date FROM funding_terms WHERE id=$1`, [termId]);
    const onDate = (req.query.on_date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.on_date))
      ? req.query.on_date
      : (term && term.start_date ? new Date(term.start_date).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10));
    const children = await build(db, termId, onDate);
    const { rows: terms } = await db.query(`SELECT id, name FROM funding_terms ORDER BY start_date DESC LIMIT 12`);
    const counts = children.reduce((a, c) => {
      a.total++; if (c.funded) a.funded++;
      if (c.allocation_id && c.ready) a.ready++;
      if (c.allocation_id && !c.ready) a.incomplete++;
      return a;
    }, { total: 0, funded: 0, ready: 0, incomplete: 0 });
    res.json({ term, on_date: onDate, terms, counts, children });
  } catch (e) { console.error('[forms-register]', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /export.csv — the file that goes to the portal ───────────────────────
router.get('/export.csv', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const termId = parseInt(req.query.term_id, 10);
    if (!Number.isInteger(termId)) return res.status(400).json({ error: 'term_id required' });
    const { rows: [term] } = await db.query(`SELECT id, name, start_date FROM funding_terms WHERE id=$1`, [termId]);
    if (!term) return res.status(404).json({ error: 'Term not found' });
    const onDate = (req.query.on_date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.on_date))
      ? req.query.on_date : new Date(term.start_date).toISOString().slice(0, 10);
    let rows = await build(db, termId, onDate);
    const band = req.query.age_band;
    if (band && band !== 'all') rows = rows.filter(r => r.age_band === band);
    if (req.query.funded_only === 'true') rows = rows.filter(r => r.funded);

    const cols = [
      ['Child ID', r => r.child_id], ['First name', r => r.first_name], ['Last name', r => r.last_name],
      ['DOB', r => r.dob], ['Age band', r => r.age_band], ['Room', r => r.room_name],
      ['Funding type', r => r.funding_type || ''],
      ['Universal hrs/wk', r => r.universal_hours_week || ''], ['Extended hrs/wk', r => r.extended_hours_week || ''],
      ['Total hrs/wk', r => r.total_hours_week || ''], ['Stretched', r => r.stretched_funding ? 'Yes' : 'No'],
      ['Childcare code', r => r.thirty_hour_code || ''], ['NI number', r => r.carer_ni_number || ''],
      ['2yr LA ref', r => r.two_year_ref || ''],
      ['Declaration signed', r => r.declaration_signed ? 'Yes' : 'No'],
      ['Declaration date', r => r.declaration_signed_date || ''],
      ['Docs on file', r => r.documents_on_file], ['Parent app', r => r.parent_has_app ? 'Yes' : 'No'],
      ['Last chased', r => r.last_chased ? new Date(r.last_chased).toISOString().slice(0,10) : ''],
      ['Missing', r => r.missing.join('; ')],
    ];
    const q = (v) => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = [cols.map(c => c[0]).join(',')]
      .concat(rows.map(r => cols.map(c => q(c[1](r))).join(','))).join('\n');

    // A term name is written by a human and Autumn 2026's carries an en dash, which Node will
    // not put in a header. Same trap that made the funding export 500 — keep the name ASCII.
    const safe = String(term.name || 'term').normalize('NFKD')
      .replace(/[^\x20-\x7E]/g, '-').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'term';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',
      `attachment; filename="forms-register-${safe}${band && band !== 'all' ? '-' + band : ''}-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  } catch (e) { console.error('[forms-register] export', e.message); res.status(500).json({ error: e.message }); }
});

module.exports = router;
