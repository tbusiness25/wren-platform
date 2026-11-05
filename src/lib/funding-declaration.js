'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// funding-declaration.js — b343 (2026-09-21)
//
// The FEEE parental declaration a family completes in the parents app, and what happens to it
// afterwards: one definition of the questions, the sheet a person can read, and the filing of that
// sheet against the child.
//
// Toby, 2026-09-21: "For anyone who doesn't have any funding, or for new parents when they join,
// obviously they can fill out the parental declaration form in the app, and then that generates us
// the PDF and then their details go into the system."
//
// ── ONE DEFINITION ───────────────────────────────────────────────────────────
// The questions a parent answers are laid out in editions/parents/welcome/declaration.html and the
// answers arrive as a JSON payload (child / parent / partner / entitlement / eligibility_checks /
// home_address_confirm / declarations). This file is the ONE place that says what every key MEANS —
// its label, its type, and the exact sentence beside each tick — and the PDF, the office's print view
// and the "details go into the system" step all read it. The payload's keys are the contract, so a key
// the page posts and this file does not know is not dropped: it lands under "Other answers" on the
// sheet, and scripts/b343-verify.js fails if declaration.html posts one (so the two cannot drift).
//
// (The brief said the question set lives in src/routes/funding.js. It does not: funding.js has only a
//  tokened click-to-sign with no questions, and funding-declarations.js GET /template is an older,
//  smaller set that declaration.html does not use. Neither was changed.)
//
// ── WHAT THE SHEET IS, AND IS NOT — the same rules as src/lib/hmrc-starter-pdf.js ───
//   1. It is the NURSERY's record of what the family answered and agreed to, so the office does not
//      have to type it again. Nothing here has been filed with Ealing Council or the DfE.
//   2. It is not a facsimile of any council or government form: no crest, no logo, no form number.
//      It is a Your Nursery document that says so.
//   3. It carries National Insurance numbers, so it is filed 'confidential' (managers only).
//
// ── "THEIR DETAILS GO INTO THE SYSTEM" ───────────────────────────────────────
// The declaration itself is stored whole in funding_declarations (unchanged). On top of that, when the
// child ALREADY has an allocation row for the term, a handful of plain facts are copied onto it — but
// only into columns that are still EMPTY. Whatever the office has typed there is never overwritten, and
// no hours, rates or amounts are ever taken from a family's answers (those drive invoices).
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';

// The five statements the server requires ticked (unchanged from the route that has always enforced them).
const REQUIRED_STATEMENTS = ['accurate', 'notify_changes', 'claim_consent', 'data_sharing', 'extras_understood'];

// Verbatim from declaration.html — the sentence a parent read beside each tick.
const STATEMENTS = {
  accurate: 'The information I have given is true and accurate to the best of my knowledge.',
  notify_changes: 'I will tell the nursery straight away if my circumstances change (for example if my child leaves, or my working-parent code stops being valid).',
  claim_consent: 'I authorise Your Nursery to claim early-education funding from Ealing Council on my behalf.',
  data_sharing: 'I understand my data is shared with the local authority and DfE/ESFA for funding and audit purposes (UK GDPR — legal obligation / public task).',
  extras_understood: 'I understand that meals, consumables and any additional hours beyond my funded entitlement are charged separately and itemised on my invoice.',
  notice_prev: 'If my child attended a previous provider, I have given them the required notice (tick if this is my child\'s first setting or not applicable).',
};

const ENTITLEMENTS = {
  universal_3_4: 'Universal 15 hours (age 3–4)',
  working_parent: 'Working-parent entitlement (needs an 11-digit code)',
  two_year_old: '2-year-old funding (LA reference)',
};

const ELIGIBILITY = {
  dla: 'Child entitled to Disability Living Allowance (Disability Access Fund)',
  universal_credit: 'Parent in receipt of Universal Credit',
  looked_after: 'Child is, or has been, looked after by a local authority in England or Wales',
  asylum_support: 'Parent receiving Asylum Support (Part Six, Immigration and Asylum Act 1999)',
};

// [key, label, type]  — type: 'date' | 'entitlement' | undefined (text)
const SECTIONS = [
  { key: 'child', title: 'The child', fields: [
    ['legal_name', 'Full name'], ['dob', 'Date of birth', 'date'], ['address', 'Home address'], ['postcode', 'Postcode'],
    ['known_as', 'Known as'], ['start_date', 'Start date at setting', 'date'], ['ethnicity', 'Ethnicity'], ['sex', 'Sex'],
  ] },
  { key: 'parent', title: 'Parent / carer 1', fields: [
    ['parent_name', 'Full name'], ['parent_dob', 'Date of birth', 'date'], ['parent_ni', 'National Insurance number'],
    ['email', 'Contact email'], ['phone', 'Contact phone'], ['nass', 'Asylum Support reference (NASS)'],
  ] },
  { key: 'partner', title: 'Partner', fields: [
    ['partner_name', 'Full name'], ['partner_dob', 'Date of birth', 'date'], ['partner_ni', 'National Insurance number'],
    ['partner_email', 'Email'], ['partner_phone', 'Phone'], ['partner_nass', 'Asylum Support reference (NASS)'],
  ] },
  { key: 'entitlement', title: 'Entitlement claimed', fields: [
    ['entitlement_type', 'Entitlement', 'entitlement'], ['hmrc_code', '11-digit childcare code'], ['code_start', 'Code start date', 'date'],
    ['code_end', 'Code end / grace date', 'date'], ['la_reference', '2-year-old LA reference'],
    ['hours_here', 'Funded hours a week here'], ['hours_elsewhere', 'Funded hours a week elsewhere'],
    ['other_setting_name', 'Other setting'], ['stretched', 'How the hours are taken'],
  ] },
];

const KNOWN_TOP_LEVEL = new Set(['child', 'parent', 'partner', 'entitlement', 'eligibility_checks', 'home_address_confirm', 'declarations']);

const YMD = /^\d{4}-\d{2}-\d{2}$/;
function longDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!YMD.test(s)) return s;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' });
}
const clip = (v, n = 400) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/**
 * What the sheet says, as data: [{ title, rows:[{label, value}] }, …]. Blank answers read "Not given" — a gap
 * is information for the office and must never be dropped. Unknown keys are kept, not lost (see the header).
 */
function describe(payload) {
  const p = isObj(payload) ? payload : {};
  const out = [];
  for (const s of SECTIONS) {
    const src = isObj(p[s.key]) ? p[s.key] : {};
    const rows = s.fields.map(([k, label, type]) => {
      let v = clip(src[k]);
      if (type === 'date') v = longDate(v);
      else if (type === 'entitlement') v = ENTITLEMENTS[v] || v;
      return { label, value: v || 'Not given' };
    });
    // A partner section with nothing in it is "not applicable", not eight lines of "Not given".
    if (s.key === 'partner' && rows.every(r => r.value === 'Not given')) {
      out.push({ title: s.title, rows: [{ label: 'Partner', value: 'None given' }] });
    } else out.push({ title: s.title, rows });
  }
  const elig = isObj(p.eligibility_checks) ? p.eligibility_checks : {};
  out.push({ title: 'Eligibility checks the family opted into',
    rows: Object.keys(ELIGIBILITY).map(k => ({ label: ELIGIBILITY[k], value: elig[k] === true ? 'Yes' : 'No' })) });
  if (clip(p.home_address_confirm)) out.push({ title: 'Home address confirmed', rows: [{ label: 'Address typed at signing', value: clip(p.home_address_confirm) }] });

  const decl = isObj(p.declarations) ? p.declarations : {};
  const agreed = Object.keys(STATEMENTS).filter(k => decl[k] === true).map(k => ({ label: 'Agreed', value: STATEMENTS[k] }));
  out.push({ title: 'Statements the parent agreed to', rows: agreed.length ? agreed : [{ label: 'Agreed', value: 'None' }] });

  const other = [];
  for (const [k, v] of Object.entries(p)) {
    if (KNOWN_TOP_LEVEL.has(k)) continue;
    other.push({ label: k.replace(/_/g, ' '), value: clip(typeof v === 'object' ? JSON.stringify(v) : v) || 'Not given' });
  }
  for (const s of SECTIONS) {                       // a key inside a known section that the definition does not name
    const known = new Set(s.fields.map(f => f[0]));
    for (const [k, v] of Object.entries(isObj(p[s.key]) ? p[s.key] : {})) {
      if (!known.has(k)) other.push({ label: `${s.title} — ${k.replace(/_/g, ' ')}`, value: clip(v) || 'Not given' });
    }
  }
  if (other.length) out.push({ title: 'Other answers', rows: other });
  return out;
}

/** Every payload key the definition names — used by the verifier to compare with declaration.html. */
function knownKeys() {
  const keys = new Set();
  for (const s of SECTIONS) for (const f of s.fields) keys.add(`${s.key}.${f[0]}`);
  for (const k of Object.keys(ELIGIBILITY)) keys.add(`eligibility_checks.${k}`);
  for (const k of Object.keys(STATEMENTS)) keys.add(`declarations.${k}`);
  keys.add('home_address_confirm');
  return keys;
}

// ── "their details go into the system" ───────────────────────────────────────
const NI = /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/;
/**
 * The plain facts worth copying onto an existing allocation row. Values that do not look right are left out
 * (a mistyped code is worse in a column the office trusts than a gap they can see). Never hours or money.
 */
function columnsFromPayload(payload) {
  const p = isObj(payload) ? payload : {};
  const e = isObj(p.entitlement) ? p.entitlement : {};
  const par = isObj(p.parent) ? p.parent : {};
  const cols = {};
  const type = clip(e.entitlement_type, 40);
  const code = clip(e.hmrc_code, 20).replace(/\s+/g, '');
  if (type === 'working_parent' && /^\d{11}$/.test(code)) {
    cols.thirty_hour_code = code;
    const end = clip(e.code_end, 12);
    if (YMD.test(end) && !Number.isNaN(new Date(end + 'T00:00:00Z').getTime())) cols.thirty_hour_code_expiry = end;
  }
  const la = clip(e.la_reference, 60);
  if (type === 'two_year_old' && la) cols.two_year_ref = la;
  const ni = clip(par.parent_ni, 20).replace(/\s+/g, '').toUpperCase();
  if (NI.test(ni)) cols.carer_ni_number = ni;
  // parentsapp-20261023: the parent's date of birth too. Only the NI was copied, so a family that signed with both still showed
  // no DOB on the allocation (and so on the Family card / claim when there was no declaration to read).
  const dob = clip(par.parent_dob, 12);
  if (YMD.test(dob)) {
    const d = new Date(dob + 'T00:00:00Z');
    const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
    if (!Number.isNaN(d.getTime()) && age >= 16 && age <= 100) cols.carer_dob = dob;
  }
  return cols;
}

/**
 * Copy those facts onto the child's allocation row for the term — into EMPTY columns only. Returns the names of
 * the columns that were filled (names only; never a value). No row for the term → nothing to fill, nothing made:
 * hours and rates on an allocation drive invoices, so creating one from a family's own answer is the office's call.
 */
async function fillEmptyColumns(db, { childId, termId, payload }) {
  const cols = columnsFromPayload(payload);
  const names = Object.keys(cols);
  // parentsapp-20261023: the parent record (contact_identity) is filled too, whether or not there is an allocation yet.
  let parentRecord = [];
  try { parentRecord = await fillParentRecord(db, { childId, payload }); } catch (e) { console.error('[funding-declaration] parent record fill failed:', e.message); }
  const { rows: [cf] } = await db.query(
    `SELECT id, thirty_hour_code, thirty_hour_code_expiry, two_year_ref, carer_ni_number, carer_dob
       FROM ${SCHEMA()}.child_funding WHERE child_id = $1 AND term_id = $2`, [childId, termId]);
  if (!cf) return { filled: [], allocation: false, parent_record: parentRecord };   // no allocation for this term yet: the office makes it, from the signed declaration
  const filled = [];
  for (const n of names) {
    const cur = cf[n];
    if (cur !== null && cur !== undefined && String(cur).trim() !== '') continue;          // the office's value stands
    // column names come from the fixed list above, never from a request
    await db.query(`UPDATE ${SCHEMA()}.child_funding SET ${n} = $1, updated_at = now() WHERE id = $2`, [cols[n], cf.id]);
    filled.push(n);
  }
  return { filled, allocation: true, parent_record: parentRecord };
}

/**
 * parentsapp-20261023: copy the signed declaration's parent / carer 1 NI number and date of birth onto that parent's record
 * (contact_identity, the child's slot-1 parent — src/lib/family-contacts.js), into EMPTY fields only, exactly like the allocation
 * columns above. Whatever the office typed stands. Audited as action 'declaration' (field names only). Returns the fields filled.
 * Nothing happens if the child has no parent 1 on file or the parent-details migration is not there.
 */
async function fillParentRecord(db, { childId, payload }) {
  const CI = require('./carer-identity');
  if (!(await CI.hasTable(db))) return [];
  const cols = columnsFromPayload(payload);
  const want = {};
  if (cols.carer_ni_number && CI.validNi(cols.carer_ni_number)) want.ni_number = CI.normaliseNi(cols.carer_ni_number);
  if (cols.carer_dob) want.date_of_birth = cols.carer_dob;
  if (!Object.keys(want).length) return [];
  const slots = await require('./family-contacts').parentSlotsFor(db, childId);
  const p1 = slots.find(s => s.slot === 1);
  if (!p1) return [];
  const { rows: [cur] } = await db.query(`SELECT ni_number, date_of_birth FROM ${SCHEMA()}.contact_identity WHERE contact_id = $1`, [p1.id]);
  const fill = {};
  for (const f of Object.keys(want)) if (!cur || cur[f] == null || String(cur[f]).trim() === '') fill[f] = want[f];
  if (!Object.keys(fill).length) return [];
  await db.query(
    `INSERT INTO ${SCHEMA()}.contact_identity (contact_id, ni_number, date_of_birth, source, updated_at) VALUES ($1, $2, $3, 'declaration', now())
     ON CONFLICT (contact_id) DO UPDATE SET ni_number = COALESCE(contact_identity.ni_number, EXCLUDED.ni_number),
       date_of_birth = COALESCE(contact_identity.date_of_birth, EXCLUDED.date_of_birth), updated_at = now()`,
    [p1.id, fill.ni_number || null, fill.date_of_birth || null]);
  await CI.audit(db, { contactId: p1.id, childId, action: 'declaration', fields: Object.keys(fill), actorKind: 'parent' });
  return Object.keys(fill);
}

/**
 * 2026-10-13 (Toby): the parent/carer's date of birth and National Insurance number are mandatory — Ealing's headcount needs both
 * for Parent/Carer 1, and the funding extension fills them from the signed declaration.
 * 2026-10-23: briefly "DOB OR NI"; Toby reversed it the same day ("We actually need date of birth and National Insurance number"),
 * so BOTH are required again, for every funding type.
 * One rule for both ways a family signs (/welcome/declaration and the parents app's Funding tab, which posts to
 * /api/funding-declarations/:childId/sign). An Asylum Support (NASS) reference stands in for the NI number, exactly as on Ealing's
 * own NI/NASS field. Returns null when the answers are fine, else { error } in plain words.
 */
function validateParentIdentity(payload) {
  const par = isObj(payload) && isObj(payload.parent) ? payload.parent : {};
  const dob = clip(par.parent_dob, 12);
  if (!dob) return { error: 'Please enter your date of birth (Parent/Carer 1).' };
  const d = YMD.test(dob) ? new Date(dob + 'T00:00:00Z') : null;
  if (!d || Number.isNaN(d.getTime())) return { error: 'Please enter your date of birth as a full date.' };
  const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (age < 16 || age > 100) return { error: 'That date of birth doesn\'t look right — please check the year.' };
  const ni = clip(par.parent_ni, 20).replace(/\s+/g, '').toUpperCase();
  const nass = clip(par.nass, 40);
  if (!ni && !nass) return { error: 'Please enter your National Insurance number (Parent/Carer 1).' };
  if (ni && !NI.test(ni)) return { error: 'That National Insurance number doesn\'t look right. It should be two letters, six numbers and a letter A–D, like QQ 12 34 56 C.' };
  return null;
}

// ── the sheet ────────────────────────────────────────────────────────────────
const INK = '#1c2b3a', MUTED = '#5b6b7c', LINE = '#d7dee6';
const londonStamp = d => new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Renders the sheet and resolves to a Buffer. `d` = { child, term, payload, signed_name, signed_at, sha256, method }. */
function renderDeclarationPdf(d) {
  const childName = [d.child && d.child.first_name, d.child && d.child.last_name].filter(Boolean).join(' ').trim() || 'Child';
  const doc = new PDFDocument({ size: 'A4', margin: 54, info: {
    Title: `Funding declaration — ${childName} — ${d.term && d.term.name ? d.term.name : ''}`.trim(),
    Author: 'Your Nursery',
  } });
  const chunks = [];
  doc.on('data', c => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });
  const L = doc.page.margins.left, R = doc.page.width - doc.page.margins.right;
  const W = R - L;

  doc.fillColor(INK).font('Helvetica-Bold').fontSize(17).text('Parental declaration — funded early education', L, doc.y);
  doc.moveDown(0.25);
  doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text('Your Nursery · 123 Example Lane, Northfields, Ealing, AB1 2CD');
  doc.moveDown(0.7);
  doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(
    'This is the nursery\'s record of the answers a parent gave and the statements they agreed to, completed in the Your Nursery parents app. '
    + 'It is used to claim the child\'s funded hours from Ealing Council. It is not a council or government form and nothing here has been filed by Wren. '
    + 'It holds National Insurance numbers, so it is kept confidential to managers.', L, doc.y, { width: W });
  doc.moveDown(0.5);
  doc.moveTo(L, doc.y).lineTo(R, doc.y).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.moveDown(0.7);

  const row = (label, value) => {
    if (doc.y > doc.page.height - 90) doc.addPage();
    const y = doc.y;
    doc.font('Helvetica').fontSize(9.2).fillColor(MUTED).text(label, L, y, { width: 165 });
    const labelBottom = doc.y;
    doc.font('Helvetica-Bold').fontSize(9.6).fillColor(INK).text(value, L + 172, y, { width: W - 172 });
    doc.y = Math.max(labelBottom, doc.y);
    doc.moveDown(0.32);
  };
  const section = title => {
    if (doc.y > doc.page.height - 110) doc.addPage();
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(INK).text(title, L, doc.y, { width: W });
    doc.moveDown(0.3);
  };

  section('Declaration');
  row('Child', childName);
  if (d.child && d.child.date_of_birth) row('Date of birth (nursery record)', longDate(String(d.child.date_of_birth).slice(0, 10)));
  row('Funding term', (d.term && d.term.name) || 'Not recorded');

  for (const s of describe(d.payload)) {
    section(s.title);
    for (const r of s.rows) row(r.label, r.value);
  }

  section('Signature');
  row('Signed by (typed full name)', clip(d.signed_name, 200) || 'Not recorded');
  row('Signed on', d.signed_at ? londonStamp(d.signed_at) + ' (UK time)' : 'Not recorded');
  const HOW = { parents_app: 'In the Your Nursery parents app', electronic: 'Online, in the parents portal', portal: 'Online, in the parents portal' };
  row('How', HOW[d.method] || d.method || 'Not recorded');
  doc.moveDown(0.4);
  doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(MUTED).text(
    'Typing a full name and ticking the statements is an electronic signature (Electronic Communications Act 2000). '
    + `Record fingerprint (SHA-256 of the signed answers): ${d.sha256 || 'not recorded'}.`, L, doc.y, { width: W });

  doc.moveDown(1);
  doc.moveTo(L, doc.y).lineTo(R, doc.y).lineWidth(0.8).strokeColor(LINE).stroke();
  doc.moveDown(0.5);
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(
    `Generated by Wren on ${londonStamp(new Date())} from the answers held in the nursery's system. `
    + 'Later declarations for the same child and term replace this one; this copy stays on file as the record of what was signed on the date above.',
    L, doc.y, { width: W });
  doc.end();
  return done;
}

function safeSlug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'term'; }

/**
 * Render the sheet for a stored declaration and FILE it against the child (person_documents, 'confidential', class
 * 'ordinary' — the same class b308 gives funding_declarations). Idempotent: a declaration that already has a live
 * document returns it. Never throws; returns { ok, docId, created, error? }.
 */
async function fileDeclarationPdf(db, declId) {
  const S = SCHEMA();
  try {
    const { rows: [d] } = await db.query(`SELECT * FROM ${S}.funding_declarations WHERE id = $1`, [declId]);
    if (!d) return { ok: false, error: 'declaration not found' };
    if (d.pdf_document_id) {
      const { rows: [ex] } = await db.query(`SELECT id, stored_path FROM ${S}.person_documents WHERE id = $1 AND deleted = false`, [d.pdf_document_id]);
      if (ex && ex.stored_path && fs.existsSync(ex.stored_path)) return { ok: true, docId: ex.id, created: false };
    }
    const { rows: [child] } = await db.query(`SELECT id, first_name, last_name, date_of_birth FROM ${S}.children WHERE id = $1`, [d.child_id]);
    const { rows: [term] } = await db.query(`SELECT id, name FROM ${S}.funding_terms WHERE id = $1`, [d.term_id]);
    const { rows: [cf] } = await db.query(`SELECT declaration_method FROM ${S}.child_funding WHERE child_id = $1 AND term_id = $2`, [d.child_id, d.term_id]);
    const payload = typeof d.payload === 'string' ? JSON.parse(d.payload) : d.payload;
    const buf = await renderDeclarationPdf({
      child, term, payload, signed_name: d.signed_name, signed_at: d.signed_at, sha256: d.sha256,
      method: (cf && cf.declaration_method) || 'parents_app',
    });

    const base = process.env.PERSON_DOC_BASE || path.join(__dirname, '../../data/person-documents');
    const dir = path.join(base, 'child', String(d.child_id));
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, `decl_${d.id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.pdf`);
    fs.writeFileSync(stored, buf);
    const signedYmd = new Date(d.signed_at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    const title = `Funding declaration — ${(term && term.name) || 'term ' + d.term_id} (signed ${longDate(signedYmd)})`;
    const { rows: [pd] } = await db.query(
      `INSERT INTO ${S}.person_documents
         (subject_type, subject_id, title, category, filename, stored_path, mime, size_bytes, visibility,
          uploaded_by_kind, uploaded_by_id, notes, retention_class, exif_stripped, sniffed_mime, sha256)
       VALUES ('child', $1, $2, 'other', $3, $4, 'application/pdf', $5, 'confidential', 'parent', 0, $6, 'ordinary', false, 'application/pdf', $7)
       RETURNING id`,
      [d.child_id, title, `funding-declaration-${safeSlug(term && term.name)}-${d.id}.pdf`, stored, buf.length,
       'Completed by the family in the parents app. Holds National Insurance numbers — confidential to managers.',
       crypto.createHash('sha256').update(buf).digest('hex')]);
    await db.query(`UPDATE ${S}.funding_declarations SET pdf_document_id = $1 WHERE id = $2`, [pd.id, d.id]);
    try {
      await db.query(`INSERT INTO ${S}.person_document_audit (doc_id, action, actor_kind, actor_id, detail) VALUES ($1, 'upload', 'parent', 0, $2)`,
        [pd.id, `funding declaration #${d.id} · generated from the signed answers`]);
    } catch (_) { /* the file is filed; a failed audit line must not undo it */ }
    return { ok: true, docId: pd.id, created: true };
  } catch (e) {
    console.error('[funding-declaration] file pdf failed:', e.message);          // message only, never a field value
    return { ok: false, error: 'could not file the PDF' };
  }
}

module.exports = {
  REQUIRED_STATEMENTS, STATEMENTS, ENTITLEMENTS, ELIGIBILITY, SECTIONS,
  describe, knownKeys, columnsFromPayload, fillEmptyColumns, fillParentRecord, renderDeclarationPdf, fileDeclarationPdf,
  validateParentIdentity,
};
