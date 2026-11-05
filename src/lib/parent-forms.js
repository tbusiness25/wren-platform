'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// parent-forms.js — b343 (2026-09-21)
//
// The ONE mechanism by which a parent signs paperwork in the app: medicine forms, accident forms,
// summative reports and two-year checks.
//
// Toby, 2026-09-21: "Yes, mandatory does mean we keep asking. Do this for everything — like medicine
// forms, accident forms, summative reports, two year checks. Parents should be able to sign it as well."
//
// ── THE MODEL ────────────────────────────────────────────────────────────────
// Nothing on the staff side is edited to raise a request. A form is a ROW THAT ALREADY EXISTS — a
// medicine_records row, an incidents row, a sent report — and this file decides, from that row, whether
// a parent is being asked to sign it and what they are shown.
//
//   1. Eligibility is a plain predicate per kind (below), always bounded by the go-live line
//      (settings.parent_forms_since) so the day this ships nobody is handed two years of paperwork.
//   2. What a parent is shown is built by one function per kind (showMedicine, showAccident, …) and
//      hashed. That hash is the VERSION. Change something a parent sees and the version changes, so
//      the parent is asked again; the earlier signature is untouched.
//   3. A request row (parent_form_requests) is made lazily for each (form, version) — when a parent
//      opens the app or the nudge sweep runs. A signature (parent_form_signatures) is APPEND-ONLY and
//      unique per request: the database, not only the route, refuses a second one.
//
// ── THE TWO RULES THAT ARE NOT NEGOTIABLE ────────────────────────────────────
//   MANDATORY MEANS WE KEEP ASKING, NEVER THAT A PARENT IS LOCKED OUT. Nothing here gates any screen
//   in the app. The list is a list; the home screen shows a card; nothing else waits on it.
//
//   SAFEGUARDING IS NEVER SIGNABLE. No safeguarding or LADO table is read by this file. An incident
//   is also withheld if a safeguarding concern was logged for the same child on the same day: a
//   parent must never be handed an accident form that sits beside a concern about their family.
//
// ── WHAT A PARENT NEVER SEES ─────────────────────────────────────────────────
//   Another child's name (redacted from every staff-written free-text field), a witness's name, a
//   prescriber, follow-up notes, RIDDOR references, photographs, or a member of staff's surname.
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

const KINDS = {
  medicine:         { label: 'Medicine form',    plural: 'Medicine forms' },
  accident:         { label: 'Accident form',    plural: 'Accident forms' },
  summative_report: { label: 'Report',           plural: 'Reports' },
  two_year_check:   { label: 'Two-year check',   plural: 'Two-year checks' },
};

// An accident form is not asked for while a practitioner may still be typing it: a record edited after
// the parent saw it would be a new version, and a parent should not be asked twice for one accident.
const ACCIDENT_SETTLE_MINUTES = Number(process.env.PARENT_FORMS_ACCIDENT_SETTLE_MINUTES != null ? process.env.PARENT_FORMS_ACCIDENT_SETTLE_MINUTES : 15);

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const clip = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const wordCount = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;
// Prose keeps its paragraph breaks (a two-year check is paragraphs); everything else is collapsed by clip().
const tidy = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, n);

const londonDate = d => new Date(d).toLocaleDateString('en-GB', { timeZone: 'Europe/London', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const londonTime = d => new Date(d).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });
const londonWhen = d => `${londonDate(d)} at ${londonTime(d)}`;
const label = c => (c && (c.preferred_name || c.first_name)) || 'your child';

// ── the go-live line ─────────────────────────────────────────────────────────
async function sinceLine(db) {
  try {
    const { rows } = await db.query(`SELECT value FROM ${SCHEMA()}.settings WHERE key = 'parent_forms_since'`);
    const t = rows[0] && Date.parse(rows[0].value);
    if (Number.isFinite(t)) return new Date(t);
  } catch (_) { /* fall through */ }
  return null;                       // no line set: ask about nothing rather than everything
}

// ── other children's names, out of staff-written text ────────────────────────
// Staff type "Jack pushed Ada" into a description. A parent must never read another child's name, so
// every other child on roll is masked to an initial. Matching is whole-word and CASE-SENSITIVE on the
// capitalised name (so "will" in "she will be fine" is left alone but "Will" is masked — sentence starts
// are a known false positive, and masking too much is the safe direction).
async function makeRedactor(db, childId) {
  let names = [];
  try {
    const { rows } = await db.query(
      `SELECT first_name, last_name, preferred_name FROM ${SCHEMA()}.children
        WHERE id <> $1 AND COALESCE(is_active, true) = true`, [childId]);
    const set = new Set();
    for (const r of rows) for (const n of [r.first_name, r.last_name, r.preferred_name]) {
      const s = String(n || '').trim();
      if (/^\p{L}[\p{L}'’-]{2,}$/u.test(s)) set.add(s);
    }
    names = [...set].sort((a, b) => b.length - a.length);
  } catch (_) { /* no list → no masking is possible; callers treat free text as untrusted anyway */ }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = names.length ? new RegExp(`(?<![\\p{L}'’-])(?:${names.map(esc).join('|')})(?![\\p{L}'’-])`, 'gu') : null;
  return text => {
    const t = tidy(text, 12000);
    return re ? t.replace(re, m => m[0].toUpperCase() + '.') : t;
  };
}

// ── what a parent is shown, per kind ─────────────────────────────────────────
// Every builder returns { title, subtitle, facts:[{label,value}], sections:[{heading,body}] } and NOTHING else.
// Facts are short labelled values; sections are prose. The object is hashed as built, so the field ORDER here is part of
// the version and must not be reshuffled casually.

async function showMedicine(db, row, child, red) {
  const facts = [
    { label: 'Medicine', value: clip(row.medicine_name, 200) || 'Not recorded' },
    { label: 'Dose', value: clip(row.medicine_dose || row.dose, 120) || 'Not recorded' },
  ];
  if (row.medicine_route) facts.push({ label: 'How it was given', value: clip(row.medicine_route, 80) });
  facts.push({ label: 'When', value: row.time_given ? londonWhen(row.time_given) : 'Not recorded' });
  if (row.reason) facts.push({ label: 'Why', value: red(row.reason) });
  if (row.temperature != null && row.temperature !== '') facts.push({ label: 'Temperature taken', value: `${Number(row.temperature).toFixed(1)}°C` });
  const sections = [];
  if (row.side_effects_noted) sections.push({ heading: 'Anything we noticed afterwards', body: red(row.side_effects_noted) });
  if (row.notes) sections.push({ heading: 'Note from the nursery', body: red(row.notes) });
  // The title names the medicine and the subtitle the time, so two doses on one day are two recognisable rows in the list.
  return { title: `${clip(row.medicine_name, 80) || 'Medicine'} for ${label(child)}`, subtitle: row.time_given ? londonWhen(row.time_given) : '', facts, sections };
}

async function showAccident(db, row, child, red) {
  const when = row.incident_ymd
    ? `${londonDate(row.incident_ymd + 'T12:00:00Z')}${row.incident_hm ? ' at ' + row.incident_hm : ''}`
    : 'Not recorded';
  const facts = [
    { label: 'When', value: when },
    { label: 'What kind', value: clip(row.incident_type, 80) || 'Not recorded' },
  ];
  if (row.location) facts.push({ label: 'Where', value: red(row.location) });
  if (row.body_map_area) facts.push({ label: 'Where on the body', value: clip(row.body_map_area, 120) });
  if (row.hospital_transfer) facts.push({ label: 'Taken to hospital', value: 'Yes' });
  const sections = [];
  if (row.description) sections.push({ heading: 'What happened', body: red(row.description) });
  if (row.injury_description) sections.push({ heading: 'The injury', body: red(row.injury_description) });
  if (row.first_aid_given) sections.push({ heading: 'What we did', body: red(row.first_aid_given) });
  return { title: `${clip(row.incident_type, 60) || 'Accident'} — ${label(child)}`, subtitle: when, facts, sections };
}

function sectionsFromContent(content) {
  const c = content && typeof content === 'object' ? content : {};
  const out = [];
  for (const s of Array.isArray(c.sections) ? c.sections : []) {
    const heading = clip(s && (s.heading || s.title), 160);
    const body = String((s && (s.body || s.text || s.content)) || '').replace(/\r/g, '').trim().slice(0, 8000);
    if (heading || body) out.push({ heading, body });
  }
  return out;
}

async function showTwoYearCheck(db, row, child, red) {
  const c = typeof row.content === 'string' ? JSON.parse(row.content) : (row.content || {});
  const facts = [];
  if (row.sent_at) facts.push({ label: 'Shared with you', value: londonDate(row.sent_at) });
  if (c.keyperson_signed && c.keyperson_signed.name) {
    facts.push({ label: 'Written by', value: `${clip(String(c.keyperson_signed.name).split(/\s+/)[0], 60)}${c.keyperson_signed.role ? ', ' + clip(c.keyperson_signed.role, 80) : ''}` });
  }
  return { title: `${label(child)}'s progress check at age two`, subtitle: row.sent_at ? londonDate(row.sent_at) : '', facts, sections: sectionsFromContent(c).map(s => ({ heading: s.heading, body: red(s.body) })) };
}

async function showTermlyUpdate(db, row, child, red) {
  const c = typeof row.content === 'string' ? JSON.parse(row.content) : (row.content || {});
  const facts = [];
  if (c.cycle_label) facts.push({ label: 'Term', value: clip(c.cycle_label, 80) });
  if (row.sent_at) facts.push({ label: 'Shared with you', value: londonDate(row.sent_at) });
  return { title: `${label(child)}'s termly update`, subtitle: row.sent_at ? londonDate(row.sent_at) : '', facts, sections: sectionsFromContent(c).map(s => ({ heading: s.heading, body: red(s.body) })) };
}

async function showParentReport(db, row, child, red) {
  const facts = [];
  const type = String(row.report_type || '');
  facts.push({ label: 'Kind of report', value: type === 'progress' ? 'Progress report' : type === 'termly' ? 'Termly report' : clip(type, 40) });
  if (row.period_start_ymd && row.period_end_ymd) facts.push({ label: 'Covers', value: `${londonDate(row.period_start_ymd + 'T12:00:00Z')} to ${londonDate(row.period_end_ymd + 'T12:00:00Z')}` });
  if (row.sent_at) facts.push({ label: 'Shared with you', value: londonDate(row.sent_at) });
  return { title: `${label(child)}'s ${type === 'progress' ? 'progress' : 'termly'} report`, subtitle: row.sent_at ? londonDate(row.sent_at) : '',
    facts, sections: [{ heading: '', body: red(String(row.final_content || '').slice(0, 12000)) }] };
}

// ── eligibility: one query per source, each bounded by the go-live line ──────
// Each returns candidate rows for the given children. `kind`, `source_table`, `builder` describe how to treat them.
const SOURCES = [
  {
    kind: 'medicine', source_table: 'medicine_records', build: showMedicine, at: r => r.time_given || r.created_at,
    sql: S => `SELECT m.* FROM ${S}.medicine_records m
           WHERE m.child_id = ANY($1) AND m.created_at >= $2 AND m.medicine_name IS NOT NULL
           ORDER BY m.time_given DESC NULLS LAST, m.id DESC LIMIT 200`,
  },
  {
    // 2026-11-02: status='draft' rows (accidents typed up from the manager's notes, not yet checked and
    // published by staff on Nest) are never a parent's form. The supersede pass in ensureRequests sets aside
    // any request made for a row while it was eligible.
    // Accident-shaped incident types only ("Accident", "Minor accident", "minor_injury", "Incident", "Illness").
    // Withheld if a safeguarding concern was logged for the same child the same day — see the header.
    kind: 'accident', source_table: 'incidents', build: showAccident, at: r => r.created_at,
    sql: S => `SELECT i.*, to_char(i.incident_date, 'YYYY-MM-DD') AS incident_ymd, to_char(i.incident_time, 'HH24:MI') AS incident_hm
            FROM ${S}.incidents i
           WHERE i.child_id = ANY($1) AND i.created_at >= $2
             AND i.status IS DISTINCT FROM 'draft'
             AND i.created_at <= now() - ($3 || ' minutes')::interval
             AND i.incident_type ~* '(accident|injur|incident|illness)'
             AND i.incident_type !~* 'near'
             AND NOT EXISTS (SELECT 1 FROM ${S}.safeguarding_concerns sc
                              WHERE sc.child_id = i.child_id
                                AND (sc.concern_date AT TIME ZONE 'Europe/London')::date = COALESCE(i.incident_date, (i.created_at AT TIME ZONE 'Europe/London')::date))
           ORDER BY i.created_at DESC, i.id DESC LIMIT 200`,
    extra: () => [String(ACCIDENT_SETTLE_MINUTES)],
  },
  {
    kind: 'two_year_check', source_table: 'reports', build: showTwoYearCheck, at: r => r.sent_at,
    sql: S => `SELECT r.* FROM ${S}.reports r
           WHERE r.child_id = ANY($1) AND r.report_type = 'two_year_check' AND r.status = 'sent' AND r.sent_at >= $2
           ORDER BY r.sent_at DESC, r.id DESC LIMIT 100`,
  },
  {
    kind: 'summative_report', source_table: 'reports', build: showTermlyUpdate, at: r => r.sent_at,
    sql: S => `SELECT r.* FROM ${S}.reports r
           WHERE r.child_id = ANY($1) AND r.report_type = 'termly_update' AND r.status = 'sent' AND r.sent_at >= $2
           ORDER BY r.sent_at DESC, r.id DESC LIMIT 100`,
  },
  {
    kind: 'summative_report', source_table: 'parent_reports', build: showParentReport, at: r => r.sent_at,
    sql: S => `SELECT p.*, to_char(p.period_start, 'YYYY-MM-DD') AS period_start_ymd, to_char(p.period_end, 'YYYY-MM-DD') AS period_end_ymd
            FROM ${S}.parent_reports p
           WHERE p.child_id = ANY($1) AND p.report_type IN ('progress', 'termly') AND p.status = 'sent'
             AND p.sent_at >= $2 AND COALESCE(p.final_content, '') <> ''
           ORDER BY p.sent_at DESC, p.id DESC LIMIT 100`,
  },
];
const SOURCE_BY = Object.fromEntries(SOURCES.map(s => [`${s.kind}|${s.source_table}`, s]));

async function loadChildren(db, childIds) {
  if (!childIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, first_name, preferred_name FROM ${SCHEMA()}.children WHERE id = ANY($1)`, [childIds]);
  return new Map(rows.map(r => [r.id, r]));
}

/** Build what a parent is shown for one source row, and its version. */
async function buildShown(db, src, row, child, red) {
  const shown = await src.build(db, row, child, red);
  const canonical = JSON.stringify(shown);
  return { shown, version: sha(canonical) };
}

/**
 * Make sure every eligible form for these children has a request row for its CURRENT version, and that any
 * unsigned request for an older version is marked superseded. Idempotent; safe to call on every read.
 * Returns the request rows it touched: [{ id, child_id, form_kind, source_table, source_id, version, isNew, shown }].
 */
async function ensureRequests(db, childIds) {
  const S = SCHEMA();
  const ids = [...new Set((childIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return [];
  const since = await sinceLine(db);
  if (!since) return [];
  const kids = await loadChildren(db, ids);
  const reds = new Map();
  const out = [];
  for (const src of SOURCES) {
    let rows;
    try {
      rows = (await db.query(src.sql(S), [ids, since, ...(src.extra ? src.extra() : [])])).rows;
    } catch (e) {
      console.error(`[parent-forms] ${src.kind}/${src.source_table} query failed:`, e.message);   // one broken source must not hide the others
      continue;
    }
    // 2026-10-29 (parent report 4): an unsigned request whose record is no longer eligible (before
    // the go-live line, a near miss now, a safeguarding concern the same day) is superseded. The
    // Forms page already hid these, but the home To do still counted them ("5 forms waiting",
    // none to open). Only for a source whose query just succeeded.
    await db.query(
      `UPDATE ${S}.parent_form_requests r SET superseded_at = now()
        WHERE r.child_id = ANY($1) AND r.form_kind = $2 AND r.source_table = $3 AND r.superseded_at IS NULL
          AND NOT (r.source_id = ANY($4::int[]))
          AND NOT EXISTS (SELECT 1 FROM ${S}.parent_form_signatures s WHERE s.request_id = r.id)`,
      [ids, src.kind, src.source_table, rows.map(r => r.id)]);
    for (const row of rows) {
      const child = kids.get(row.child_id);
      if (!child) continue;
      if (!reds.has(row.child_id)) reds.set(row.child_id, await makeRedactor(db, row.child_id));
      const { shown, version } = await buildShown(db, src, row, child, reds.get(row.child_id));
      const ins = await db.query(
        `INSERT INTO ${S}.parent_form_requests (child_id, form_kind, source_table, source_id, version)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (form_kind, source_table, source_id, version) DO NOTHING RETURNING id`,
        [row.child_id, src.kind, src.source_table, row.id, version]);
      let id = ins.rows[0] && ins.rows[0].id;
      const isNew = !!id;
      if (!id) {
        const ex = await db.query(
          `SELECT id FROM ${S}.parent_form_requests WHERE form_kind=$1 AND source_table=$2 AND source_id=$3 AND version=$4`,
          [src.kind, src.source_table, row.id, version]);
        id = ex.rows[0].id;
        // eligible again after being set aside: this version is the current one
        await db.query(`UPDATE ${S}.parent_form_requests SET superseded_at = NULL WHERE id = $1 AND superseded_at IS NOT NULL`, [id]);
      }
      // an unsigned request for an OLDER version of the same record is replaced by this one
      await db.query(
        `UPDATE ${S}.parent_form_requests r SET superseded_at = now()
          WHERE r.form_kind=$1 AND r.source_table=$2 AND r.source_id=$3 AND r.version <> $4 AND r.superseded_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM ${S}.parent_form_signatures s WHERE s.request_id = r.id)`,
        [src.kind, src.source_table, row.id, version]);
      out.push({ id, child_id: row.child_id, form_kind: src.kind, source_table: src.source_table, source_id: row.id, version, isNew, shown,
        event_at: src.at(row) });
    }
  }
  return out;
}

// ── a parent's own children ──────────────────────────────────────────────────
async function ownedChildIds(db, email) {
  const { rows } = await db.query(
    `SELECT c.id FROM ${SCHEMA()}.parent_portal_access pa JOIN ${SCHEMA()}.children c ON c.id = pa.child_id
      WHERE lower(pa.email) = $1 AND pa.is_active = true AND COALESCE(c.is_active, true) = true`, [email]);
  return rows.map(r => r.id);
}

// ── the funding declaration, as one more thing that is waiting ───────────────
async function currentTerm(db) {
  const { rows } = await db.query(
    `SELECT id, name FROM ${SCHEMA()}.funding_terms
      ORDER BY (is_current IS TRUE) DESC, (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC LIMIT 1`);
  return rows[0] || null;
}
/**
 * Funded children, for the CURRENT term, with no declaration on file — the SAME test the office's tracker uses
 * (a signed electronic declaration OR the allocation flagged signed, paper included). "Funded" = an allocation row for
 * the term whose funding_type is not 'none'. Only these children; nobody else is ever prompted.
 */
async function declarationsWaiting(db, childIds) {
  const S = SCHEMA();
  const ids = [...new Set((childIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return { term: null, children: [] };
  const term = await currentTerm(db);
  if (!term) return { term: null, children: [] };
  const { rows } = await db.query(
    `SELECT cf.child_id AS id, c.first_name, c.preferred_name
       FROM ${S}.child_funding cf JOIN ${S}.children c ON c.id = cf.child_id
      WHERE cf.term_id = $1 AND cf.child_id = ANY($2) AND COALESCE(cf.funding_type, 'none') <> 'none'
        AND COALESCE(cf.declaration_signed, false) = false
        AND NOT EXISTS (SELECT 1 FROM ${S}.funding_declarations d
                         WHERE d.child_id = cf.child_id AND d.term_id = cf.term_id AND d.status = 'signed')
      ORDER BY c.first_name, c.id`, [term.id, ids]);
  return { term, children: rows };
}

// ── the parent's list ────────────────────────────────────────────────────────
/**
 * Everything waiting for this parent, newest first, plus what has been signed lately.
 * Never throws for a missing table (the migration may not have run): an empty list is the honest answer.
 */
async function listFor(db, email) {
  const S = SCHEMA();
  const ids = await ownedChildIds(db, email);
  const kids = await loadChildren(db, ids);
  let waiting = [], signed = [];
  try {
    const touched = await ensureRequests(db, ids);
    if (ids.length) {
      const { rows } = await db.query(
        `SELECT r.id, r.child_id, r.form_kind, r.source_table, r.source_id, r.first_seen_at
           FROM ${S}.parent_form_requests r
          WHERE r.child_id = ANY($1) AND r.superseded_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM ${S}.parent_form_signatures s WHERE s.request_id = r.id)
          ORDER BY r.first_seen_at DESC, r.id DESC`, [ids]);
      const byId = new Map(touched.map(t => [t.id, t]));
      waiting = rows.filter(r => byId.has(r.id)).map(r => {
        const t = byId.get(r.id);
        return { id: r.id, kind: r.form_kind, kind_label: KINDS[r.form_kind].label, child_id: r.child_id,
          child_name: label(kids.get(r.child_id)), title: t.shown.title, subtitle: t.shown.subtitle, first_seen_at: r.first_seen_at,
          event_at: t.event_at };
      }).sort((a, b) => new Date(b.event_at || b.first_seen_at) - new Date(a.event_at || a.first_seen_at) || b.id - a.id);
    }
    const sg = await db.query(
      `SELECT s.id, s.child_id, s.form_kind, s.typed_name, s.signed_at, s.mode, s.shown->>'title' AS title, s.signed_by_email
         FROM ${S}.parent_form_signatures s WHERE s.child_id = ANY($1)
        ORDER BY s.signed_at DESC, s.id DESC LIMIT 25`, [ids]);
    signed = sg.rows.map(s => ({ id: s.id, kind: s.form_kind, kind_label: KINDS[s.form_kind].label, child_name: label(kids.get(s.child_id)),
      title: s.title, typed_name: s.typed_name, signed_at: s.signed_at, by_you: String(s.signed_by_email).toLowerCase() === email }));
  } catch (e) {
    console.error('[parent-forms] list failed:', e.message);
  }
  let declarations = [];
  try {
    const d = await declarationsWaiting(db, ids);
    declarations = d.children.map(c => ({ kind: 'funding_declaration', kind_label: 'Funding declaration', child_id: c.id,
      child_name: label(c), title: `Funding declaration for ${label(c)}`, subtitle: d.term ? d.term.name : '', href: `/welcome/declaration?child=${c.id}` }));
  } catch (e) { console.error('[parent-forms] declarations failed:', e.message); }
  return { waiting, declarations, signed, count: waiting.length + declarations.length };
}

// ── opening one ──────────────────────────────────────────────────────────────
async function loadRequest(db, requestId) {
  const { rows } = await db.query(`SELECT * FROM ${SCHEMA()}.parent_form_requests WHERE id = $1`, [requestId]);
  return rows[0] || null;
}
// The columns a source row is read with. It MUST be the same in the list query (SOURCES, above) and here, where a form is
// re-read when it is opened and signed: the version is a hash of what is built from the row, so a column that exists in one read
// and not the other would make every form look "changed". DATE columns come back as text (the pg DATE → local-midnight trap).
const ONE = {
  medicine_records: S => `SELECT m.* FROM ${S}.medicine_records m WHERE m.id = $1`,
  incidents: S => `SELECT i.*, to_char(i.incident_date, 'YYYY-MM-DD') AS incident_ymd, to_char(i.incident_time, 'HH24:MI') AS incident_hm FROM ${S}.incidents i WHERE i.id = $1 AND i.status IS DISTINCT FROM 'draft'`,
  reports: S => `SELECT r.* FROM ${S}.reports r WHERE r.id = $1`,
  parent_reports: S => `SELECT p.*, to_char(p.period_start, 'YYYY-MM-DD') AS period_start_ymd, to_char(p.period_end, 'YYYY-MM-DD') AS period_end_ymd FROM ${S}.parent_reports p WHERE p.id = $1`,
};
async function loadSource(db, req) {
  const sql = ONE[req.source_table];
  if (!sql) return null;                                         // never build SQL from a stored string that is not on the list
  const { rows } = await db.query(sql(SCHEMA()), [req.source_id]);
  return rows[0] || null;
}

/** The mode and the exact sentence beside the tick. Medicine depends on whether the dose has been given yet. */
function statementFor(kind, row, child, now = new Date()) {
  const n = label(child);
  if (kind === 'medicine') {
    const name = clip(row.medicine_name, 120), dose = clip(row.medicine_dose || row.dose, 80);
    const what = `${name}${dose ? ' (' + dose + ')' : ''}`;
    const future = row.time_given && new Date(row.time_given).getTime() > now.getTime();
    return future
      ? { mode: 'agree', text: `I agree to ${n} being given ${what}, as shown above.` }
      : { mode: 'acknowledge', text: `I have been told that ${n} was given ${what}, as shown above.` };
  }
  if (kind === 'accident') return { mode: 'acknowledge', text: `I have been told what happened to ${n}, as set out above.` };
  if (kind === 'two_year_check') return { mode: 'read', text: `I have read ${n}'s progress check at age two.` };
  return { mode: 'read', text: `I have read this report about ${n}.` };
}

/**
 * Open one waiting form for its parent: re-verify ownership, rebuild what they are shown NOW, and refuse (409 changed) if
 * that is no longer the version the request was made for.
 * → { ok:true, form } | { ok:false, status, reason, error }
 */
async function openForm(db, email, requestId) {
  const req = await loadRequest(db, requestId);
  if (!req) return { ok: false, status: 404, reason: 'not_found', error: 'That form was not found.' };
  const mine = await ownedChildIds(db, email);
  if (!mine.includes(req.child_id)) return { ok: false, status: 403, reason: 'not_yours', error: 'That form is not for one of your children.' };
  const signed = await db.query(`SELECT typed_name, signed_at FROM ${SCHEMA()}.parent_form_signatures WHERE request_id = $1`, [req.id]);
  if (signed.rows[0]) return { ok: false, status: 409, reason: 'already_signed', error: 'This form has already been signed.', signed: signed.rows[0] };
  const cur = await currentVersion(db, req);
  if (!cur) return { ok: false, status: 410, reason: 'gone', error: 'That form is no longer waiting for you.' };
  if (cur.version !== req.version || req.superseded_at) {
    await ensureRequests(db, [req.child_id]);
    return { ok: false, status: 409, reason: 'changed', error: 'This form was updated after your list loaded. Please go back and open it again.' };
  }
  const st = statementFor(req.form_kind, cur.row, cur.child);
  return { ok: true, form: { id: req.id, kind: req.form_kind, kind_label: KINDS[req.form_kind].label, child_id: req.child_id,
    child_name: label(cur.child), shown: cur.shown, mode: st.mode, statement: st.text } };
}

async function currentVersion(db, req) {
  const row = await loadSource(db, req);
  if (!row) return null;
  const src = SOURCE_BY[`${req.form_kind}|${req.source_table}`];
  if (!src) return null;
  const kids = await loadChildren(db, [req.child_id]);
  const child = kids.get(req.child_id);
  const red = await makeRedactor(db, req.child_id);
  const b = await buildShown(db, src, row, child, red);
  return { row, child, shown: b.shown, version: b.version };
}

/**
 * Sign. Everything is re-derived here from the request id and the parent's own session: a body child_id, kind or
 * statement is never believed. One signature per request — the unique key means a second attempt (the other parent, a
 * double tap, a replay) writes nothing and touches nothing.
 */
async function sign(db, { email, requestId, typedName, agreed, ip, userAgent }) {
  const S = SCHEMA();
  const name = clip(typedName, 200);
  if (agreed !== true) return { ok: false, status: 400, reason: 'not_ticked', error: 'Please tick the box to say you agree.' };
  if (wordCount(name) < 2) return { ok: false, status: 400, reason: 'name', error: 'Please type your full name.' };
  const opened = await openForm(db, email, requestId);
  if (!opened.ok) return opened;
  const f = opened.form;
  const req = await loadRequest(db, requestId);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO ${S}.parent_form_signatures
         (request_id, child_id, form_kind, source_table, source_id, version, mode, statement, shown, shown_sha256, typed_name, signed_by_email, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14) RETURNING id, signed_at`,
      [req.id, req.child_id, req.form_kind, req.source_table, req.source_id, req.version, f.mode, f.statement,
       JSON.stringify(f.shown), req.version, name, email, clip(ip, 80) || null, clip(userAgent, 300) || null]);
    // The one column the staff side already reads: the accident duty and the incident PDF look at parent_signed_at.
    // Filled only if empty — a value the office recorded first stays.
    if (req.form_kind === 'accident') {
      await client.query(`UPDATE ${S}.incidents SET parent_signed_at = $1 WHERE id = $2 AND parent_signed_at IS NULL`, [ins.rows[0].signed_at, req.source_id]);
    }
    await client.query('COMMIT');
    return { ok: true, id: ins.rows[0].id, signed_at: ins.rows[0].signed_at, child_id: req.child_id, kind: req.form_kind, source_id: req.source_id };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* gone */ }
    if (e && e.code === '23505') {
      const s = await db.query(`SELECT typed_name, signed_at FROM ${S}.parent_form_signatures WHERE request_id = $1`, [req.id]);
      return { ok: false, status: 409, reason: 'already_signed', error: 'This form has already been signed.', signed: s.rows[0] || null };
    }
    throw e;
  } finally { client.release(); }
}

// ── the office's side: who has signed what, and what is still waiting ────────
/**
 * For a child, keyed 'kind|table|id' → { signed:{by,at,mode,earlier_version?}|null, waiting:bool }.
 * Names only what a member of staff can already see on the child's record (the parent's typed name). No content.
 */
async function statusForChild(db, childId) {
  const S = SCHEMA();
  const out = {};
  const sg = await db.query(
    `SELECT s.form_kind, s.source_table, s.source_id, s.typed_name, s.signed_at, s.mode, s.version
       FROM ${S}.parent_form_signatures s WHERE s.child_id = $1 ORDER BY s.signed_at DESC, s.id DESC`, [childId]);
  const rq = await db.query(
    `SELECT r.form_kind, r.source_table, r.source_id, r.version, r.first_seen_at, r.superseded_at,
            EXISTS (SELECT 1 FROM ${S}.parent_form_signatures s WHERE s.request_id = r.id) AS is_signed
       FROM ${S}.parent_form_requests r WHERE r.child_id = $1`, [childId]);
  for (const r of rq.rows) {
    const key = `${r.form_kind}|${r.source_table}|${r.source_id}`;
    const o = out[key] || (out[key] = { signed: null, waiting: false, since: null });
    if (!r.is_signed && !r.superseded_at) { o.waiting = true; o.since = r.first_seen_at; }
  }
  const latest = new Map();
  for (const r of rq.rows) {
    const key = `${r.form_kind}|${r.source_table}|${r.source_id}`;
    if (!r.superseded_at) latest.set(key, r.version);
  }
  for (const s of sg.rows) {
    const key = `${s.form_kind}|${s.source_table}|${s.source_id}`;
    const o = out[key] || (out[key] = { signed: null, waiting: false, since: null });
    if (!o.signed) o.signed = { by: s.typed_name, at: s.signed_at, mode: s.mode, earlier_version: latest.has(key) && latest.get(key) !== s.version && o.waiting };
  }
  return out;
}

module.exports = {
  KINDS, SOURCES, ACCIDENT_SETTLE_MINUTES,
  sinceLine, makeRedactor, ensureRequests, ownedChildIds, currentTerm, declarationsWaiting,
  listFor, openForm, sign, statementFor, statusForChild, wordCount,
};
