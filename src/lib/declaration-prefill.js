'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// declaration-prefill.js — 2026-10-29. The funding declaration (/welcome/declaration) opens filled in.
//
// Parent feedback #3: "child and parent details should be autofilled / copied over from previous submitted form, rather than
// needing to complete all details again each time." Toby: "the declaration form should automatically populate with known fields
// from application form… get it done".
//
// WHERE EACH ANSWER COMES FROM — first source with a value wins, per field
//   1. 'declaration' — the child's latest SIGNED declaration (any term): what the family told us last time.
//   2. 'records'     — what Wren holds from registration / EyLog: the child row (children.*, eylog_child_details), the signed-in
//                      parent's own contact row and parent record (contacts, contact_identity), and the allocation's carer columns.
//   3. 'funding'     — the nursery's allocation (child_funding): entitlement, code, hours, term-time or stretched.
//   One exception to that order: when the allocation is for THIS term and the last declaration was for an earlier one, the
//   allocation's entitlement / hours / term-time-or-stretched win — a child who turned three moves from 15 to 30 hours, and the
//   old declaration would carry the old figure forward.
//
// WHOSE DATA — the only rules that matter here
//   · Only a child the signed-in address is linked to (parent_portal_access, active). Anything else gets nothing at all.
//   · A parent's personal identifiers (NI, DOB, Asylum Support ref) are prefilled only when Wren holds them FOR THE SIGNED-IN
//     PARENT: their own last declaration (its parent email is theirs), their own parent record, or — when they are parent 1 —
//     the allocation's carer columns. The other parent's identifiers are never handed to them, even masked.
//   · The partner's identifiers come only from what this parent themself gave us (their last declaration, or the allocation's
//     partner columns when they are parent 1).
//   · Never the signature, never the six "I agree" statements: the parent does those every time.
//
// MASKED — NI numbers, Asylum Support refs and the 11-digit childcare code never leave this file whole. The form shows the last
// three characters and a "Change" button; if the parent keeps it, the form sends the field's key in `keep` and the submit route
// calls heldValues() to put the held value back into the signed payload — from the SAME gatherer, so it can only ever be this
// parent's own value for this child. Nothing here logs a value.
// ─────────────────────────────────────────────────────────────────────────────

const CI = require('./carer-identity');
const FC = require('./family-contacts');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const YMD = /^\d{4}-\d{2}-\d{2}$/;

// The keys a parent may ask us to keep (they were shown masked). Anything else in `keep` is ignored.
const MASKED = ['parent.parent_ni', 'parent.nass', 'partner.partner_ni', 'partner.partner_nass', 'entitlement.hmrc_code'];

// child_funding.funding_type → declaration.html's entitlement values
const ENTITLEMENT = {
  universal: 'universal_3_4', '3yr_universal': 'universal_3_4',
  extended: 'working_parent', '3yr_extended': 'working_parent', '2yr_working': 'working_parent',
  '2yr_working_parents': 'working_parent', under_2: 'working_parent',
  '2yr_disadvantaged': 'two_year_old',
};
const SEX = { f: 'Female', female: 'Female', girl: 'Female', m: 'Male', male: 'Male', boy: 'Male' };

const str = v => (v == null ? '' : String(v).trim());
const lc = v => str(v).toLowerCase();
const ymd = v => {
  if (v == null || v === '') return '';
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  const s = str(v).slice(0, 10);
  return YMD.test(s) ? s : '';
};
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/** True when this signed-in address may see this child (the same test /welcome/declaration/api/submit makes). */
async function owns(db, email, childId) {
  const e = lc(email), id = parseInt(childId, 10);
  if (!e || !Number.isInteger(id)) return false;
  const { rows } = await db.query(
    `SELECT 1 FROM ${SCHEMA()}.parent_portal_access WHERE lower(email) = $1 AND child_id = $2 AND is_active = true`, [e, id]);
  return rows.length > 0;
}

/**
 * Every value Wren holds for this child's declaration, as { 'section.key': { value, from } }, UNMASKED. Internal: callers get
 * either the masked view (prefillFor) or one held value at sign time (heldValues). Returns null when the address does not own
 * the child.
 */
async function gather(db, { childId, email }) {
  const S = SCHEMA();
  const id = parseInt(childId, 10);
  const me = lc(email);
  if (!(await owns(db, me, id))) return null;

  const { rows: [c] } = await db.query(
    `SELECT first_name, preferred_name, to_char(start_date,'YYYY-MM-DD') AS start_date, ethnicity, gender,
            concat_ws(', ', NULLIF(btrim(address_line1),''), NULLIF(btrim(address_line2),''), NULLIF(btrim(town),'')) AS address,
            postcode, parent_1_name, parent_1_email, parent_1_phone, parent_2_name, parent_2_email, parent_2_phone,
            thirty_hour_code, to_char(thirty_hour_code_expiry,'YYYY-MM-DD') AS thirty_hour_code_expiry,
            eligibility_code, to_char(eligibility_code_expiry,'YYYY-MM-DD') AS eligibility_code_expiry
       FROM ${S}.children WHERE id = $1`, [id]);
  if (!c) return null;

  let ey = {};
  try {
    const { rows: [e] } = await db.query(
      `SELECT payload->>'ethnicity' AS ethnicity, payload->>'gender' AS gender FROM ${S}.eylog_child_details WHERE child_id = $1
        ORDER BY fetched_at DESC NULLS LAST LIMIT 1`, [id]);
    ey = e || {};
  } catch (_) { /* no EyLog landing table on this database */ }

  const { rows: [term] } = await db.query(
    `SELECT id, name FROM ${S}.funding_terms
      ORDER BY (is_current IS TRUE) DESC, (CURRENT_DATE BETWEEN start_date AND end_date) DESC, start_date DESC LIMIT 1`);
  const termId = term ? term.id : null;

  const { rows: [d] } = await db.query(
    `SELECT d.payload, d.term_id, d.signed_at, t.name AS term_name
       FROM ${S}.funding_declarations d LEFT JOIN ${S}.funding_terms t ON t.id = d.term_id
      WHERE d.child_id = $1 AND d.status = 'signed' ORDER BY d.signed_at DESC LIMIT 1`, [id]);

  const { rows: [a] } = await db.query(
    `SELECT cf.term_id, cf.funding_type, cf.stretched_funding, cf.universal_hours_week, cf.extended_hours_week,
            cf.thirty_hour_code, to_char(cf.thirty_hour_code_expiry,'YYYY-MM-DD') AS code_end,
            COALESCE(NULLIF(btrim(cf.two_year_ref),''), NULLIF(btrim(cf.la_reference),'')) AS la_reference,
            cf.carer_ni_number, to_char(cf.carer_dob,'YYYY-MM-DD') AS carer_dob, cf.partner_name, cf.partner_ni_number
       FROM ${S}.child_funding cf JOIN ${S}.funding_terms t ON t.id = cf.term_id
      WHERE cf.child_id = $1
      ORDER BY (cf.term_id = $2::int) IS TRUE DESC, (t.is_current IS TRUE) DESC, t.start_date DESC LIMIT 1`, [id, termId]);

  // Which parent is signed in: their slot (1/2) and contact row, matched on the address they signed in with.
  let slots = [];
  try { slots = await FC.parentSlotsFor(db, id); } catch (_) { slots = []; }
  const mine = slots.find(s => lc(s.primary_email) === me) || null;
  const mySlot = mine ? mine.slot : (lc(c.parent_1_email) === me ? 1 : lc(c.parent_2_email) === me ? 2 : null);
  let myIdent = {};
  if (mine) {
    try {
      if (await CI.hasTable(db)) {
        const { rows: [r] } = await db.query(
          `SELECT ni_number, to_char(date_of_birth,'YYYY-MM-DD') AS dob FROM ${S}.contact_identity WHERE contact_id = $1`, [mine.id]);
        myIdent = r || {};
      }
    } catch (_) { /* parent-details migration not on this database */ }
  }

  const out = {};
  const put = (key, value, from) => {
    if (out[key]) return;                                   // an earlier (higher-priority) source already answered
    if (typeof value === 'boolean') { if (value) out[key] = { value, from }; return; }
    const v = str(value);
    if (v) out[key] = { value: v, from };
  };
  const okNi = v => (CI.validNi(v) ? CI.normaliseNi(v) : '');
  const okDob = v => (ymd(v) && !CI.checkDob(ymd(v)) ? ymd(v) : '');

  // ── 1. the last signed declaration ─────────────────────────────────────────
  const p = d && isObj(d.payload) ? d.payload : null;
  const allocWinsThisTerm = !!(a && termId && a.term_id === termId && (!d || d.term_id !== termId));
  if (p) {
    const ch = isObj(p.child) ? p.child : {}, par = isObj(p.parent) ? p.parent : {}, prt = isObj(p.partner) ? p.partner : {};
    const ent = isObj(p.entitlement) ? p.entitlement : {}, elig = isObj(p.eligibility_checks) ? p.eligibility_checks : {};
    // about the child: theirs whoever signed
    put('child.known_as', ch.known_as, 'declaration');
    put('child.start_date', ymd(ch.start_date), 'declaration');
    put('child.ethnicity', ch.ethnicity, 'declaration');
    put('child.sex', ch.sex, 'declaration');
    put('home_address_confirm', p.home_address_confirm, 'declaration');
    put('eligibility_checks.dla', elig.dla === true, 'declaration');
    put('eligibility_checks.looked_after', elig.looked_after === true, 'declaration');
    if (!allocWinsThisTerm) {
      put('entitlement.entitlement_type', ent.entitlement_type, 'declaration');
      put('entitlement.hours_here', ent.hours_here, 'declaration');
      put('entitlement.stretched', ent.stretched, 'declaration');
    }
    put('entitlement.hmrc_code', str(ent.hmrc_code).replace(/\s+/g, ''), 'declaration');
    put('entitlement.code_start', ymd(ent.code_start), 'declaration');
    put('entitlement.code_end', ymd(ent.code_end), 'declaration');
    put('entitlement.la_reference', ent.la_reference, 'declaration');
    put('entitlement.hours_elsewhere', ent.hours_elsewhere, 'declaration');
    put('entitlement.other_setting_name', ent.other_setting_name, 'declaration');

    if (me && lc(par.email) === me) {
      // they signed it: their own answers, and the partner they named
      put('parent.parent_name', par.parent_name, 'declaration');
      put('parent.parent_dob', okDob(par.parent_dob), 'declaration');
      put('parent.parent_ni', okNi(par.parent_ni), 'declaration');
      put('parent.email', par.email, 'declaration');
      put('parent.phone', par.phone, 'declaration');
      put('parent.nass', par.nass, 'declaration');
      put('partner.partner_name', prt.partner_name, 'declaration');
      put('partner.partner_dob', okDob(prt.partner_dob), 'declaration');
      put('partner.partner_ni', okNi(prt.partner_ni), 'declaration');
      put('partner.partner_email', prt.partner_email, 'declaration');
      put('partner.partner_phone', prt.partner_phone, 'declaration');
      put('partner.partner_nass', prt.partner_nass, 'declaration');
      put('eligibility_checks.universal_credit', elig.universal_credit === true, 'declaration');
      put('eligibility_checks.asylum_support', elig.asylum_support === true, 'declaration');
    } else if (me && lc(prt.partner_email) === me) {
      // they were the partner last time: their own details move across; the other parent's identifiers do not
      put('parent.parent_name', prt.partner_name, 'declaration');
      put('parent.parent_dob', okDob(prt.partner_dob), 'declaration');
      put('parent.parent_ni', okNi(prt.partner_ni), 'declaration');
      put('parent.email', prt.partner_email, 'declaration');
      put('parent.phone', prt.partner_phone, 'declaration');
      put('parent.nass', prt.partner_nass, 'declaration');
      put('partner.partner_name', par.parent_name, 'declaration');
      put('partner.partner_email', par.email, 'declaration');
      put('partner.partner_phone', par.phone, 'declaration');
    }
  }

  // ── 2. what Wren holds from registration / EyLog ───────────────────────────
  put('child.known_as', lc(c.preferred_name) && lc(c.preferred_name) !== lc(c.first_name) ? c.preferred_name : '', 'records');
  put('child.start_date', c.start_date, 'records');
  put('child.ethnicity', c.ethnicity || ey.ethnicity, 'records');
  put('child.sex', SEX[lc(c.gender)] || SEX[lc(ey.gender)] || '', 'records');
  put('home_address_confirm', [c.address, c.postcode].map(str).filter(Boolean).join(', '), 'records');
  if (mySlot) {
    put('parent.parent_name', (mine && mine.full_name) || c[`parent_${mySlot}_name`], 'records');
    put('parent.email', (mine && mine.primary_email) || c[`parent_${mySlot}_email`], 'records');
    put('parent.phone', (mine && mine.primary_phone) || c[`parent_${mySlot}_phone`], 'records');
    put('parent.parent_dob', okDob(myIdent.dob), 'records');
    put('parent.parent_ni', okNi(myIdent.ni_number), 'records');
    if (mySlot === 1 && a) {                               // the allocation's carer is parent/carer 1
      put('parent.parent_dob', okDob(a.carer_dob), 'records');
      put('parent.parent_ni', okNi(a.carer_ni_number), 'records');
      put('partner.partner_name', a.partner_name, 'records');
      put('partner.partner_ni', okNi(a.partner_ni_number), 'records');
    }
  }
  put('parent.email', me, 'records');

  // ── 3. the nursery's funding record ───────────────────────────────────────
  if (a) {
    put('entitlement.entitlement_type', ENTITLEMENT[a.funding_type] || '', 'funding');
    const hrs = Number(a.universal_hours_week || 0) + Number(a.extended_hours_week || 0);
    if (hrs > 0 && hrs <= 30) put('entitlement.hours_here', String(Math.round(hrs * 100) / 100), 'funding');
    if (a.stretched_funding != null) put('entitlement.stretched', a.stretched_funding ? 'Stretched' : 'Term-time', 'funding');
    put('entitlement.hmrc_code', str(a.thirty_hour_code).replace(/\s+/g, ''), 'funding');
    put('entitlement.code_end', a.code_end, 'funding');
    put('entitlement.la_reference', a.la_reference, 'funding');
  }
  put('entitlement.hmrc_code', str(c.thirty_hour_code || c.eligibility_code).replace(/\s+/g, ''), 'records');
  put('entitlement.code_end', c.thirty_hour_code_expiry || c.eligibility_code_expiry, 'records');

  return {
    fields: out,
    last_declaration: d ? { term: d.term_name || null, signed_at: d.signed_at, this_term: !!(termId && d.term_id === termId) } : null,
  };
}

/** What the form shows. Masked keys carry `masked` (last three characters) and no value. */
async function prefillFor(db, { childId, email }) {
  const g = await gather(db, { childId, email });
  if (!g) return null;
  const fields = {};
  for (const [k, f] of Object.entries(g.fields)) {
    fields[k] = MASKED.includes(k) ? { masked: CI.mask(f.value), from: f.from } : { value: f.value, from: f.from };
  }
  return { child_id: parseInt(childId, 10), fields, filled: Object.keys(fields).length, last_declaration: g.last_declaration };
}

/**
 * At sign time: put the held value back for each masked field the parent kept. Only keys in MASKED, only into a field the
 * payload left blank, only from this parent's own gather for this child. Returns { payload, unresolved:[keys we no longer hold] }.
 */
async function applyKept(db, { childId, email, payload, keep }) {
  const want = (Array.isArray(keep) ? keep : []).filter(k => MASKED.includes(k));
  if (!want.length || !isObj(payload)) return { payload, unresolved: [] };
  const g = await gather(db, { childId, email });
  const unresolved = [];
  for (const k of want) {
    const [sec, key] = k.split('.');
    if (!isObj(payload[sec])) payload[sec] = {};
    if (str(payload[sec][key])) continue;                 // they typed a new one — theirs stands
    const held = g && g.fields[k];
    if (held && str(held.value)) payload[sec][key] = held.value;
    else unresolved.push(k);
  }
  return { payload, unresolved };
}

module.exports = { prefillFor, applyKept, owns, MASKED };
