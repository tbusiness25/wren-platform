'use strict';
// ===========================================================================
// carer-identity.js — parentdetails-20261023. A parent's National Insurance number and date of birth.
//
// Toby, 2026-10-23: three under-2s' claims were blocked this month because Wren had no parent NI number, and there was nowhere
// in Wren to type one. They now live on the PARENT (contact_identity, one row per contacts.id, so siblings share it) and are
// edited in Roost → child profile → Family → Parental details.
//
// ONE ANSWER to "what is this child's parent NI / DOB?", used by the funding claim feed (src/routes/funding-portal.js) and the
// Missing-details engine (src/lib/outstanding.js), in this order — the first that has a value wins, per field:
//   1. the family's latest SIGNED funding declaration (what the parent told us, most recently)
//   2. the parent record (contact_identity — what the office typed, or the backfill copied)
//   3. the allocation row (child_funding.carer_ni_number / carer_dob — the legacy place; parent/carer 1 only)
//
// Toby, 2026-10-23 (evening): "We actually need date of birth and National Insurance number" — both, for every funding type.
// WORKING_TYPES still marks working-parent (30-hour / under-2) funding, which the 30-hour code checks use.
//
// GDPR: values only ever leave this file masked (last 3 characters), except reveal() and the claim feed. Every view, reveal
// and change is written to contact_identity_audit — field names only, never a value. Nothing here logs a value.
// ===========================================================================

const FC = require('./family-contacts');

const NI_RE = /^[A-CEGHJ-PR-TW-Z][A-CEGHJ-NPR-TW-Z]\d{6}[A-D]$/;
const NI_BAD_PREFIX = new Set(['BG', 'GB', 'NK', 'KN', 'TN', 'NT', 'ZZ']);   // HMRC never issues these
const WORKING_TYPES = ['extended', '2yr_working', '2yr_working_parents', '3yr_extended', 'under_2'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

const normaliseNi = v => { const s = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase(); return s || null; };
const validNi = v => { const s = normaliseNi(v); return !!s && NI_RE.test(s) && !NI_BAD_PREFIX.has(s.slice(0, 2)); };
const isoOf = v => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;   // pg DATE = local midnight
  const s = String(v).trim().slice(0, 10);
  return YMD.test(s) ? s : null;
};
/** null when fine, else a plain-words error. */
function checkDob(v) {
  const s = isoOf(v);
  if (!s) return 'Enter the date of birth as a full date.';
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return 'Enter the date of birth as a full date.';
  const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
  if (age < 16 || age > 100) return 'That date of birth doesn\'t look right. Check the year.';
  return null;
}
const NI_ERROR = 'That National Insurance number doesn\'t look right. It should be two letters, six numbers and a letter A to D, like QQ 12 34 56 C.';
/** Masked display: everything but the last 3 characters hidden. */
function mask(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, '');
  if (!s) return null;
  return '•'.repeat(Math.max(3, s.length - 3)) + s.slice(-3);
}
const maskDob = v => { const s = isoOf(v); return s ? mask(`${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`) : null; };

async function audit(db, { contactId = null, childId = null, action, fields = [], actorKind = 'staff', actorId = null, ip = null }) {
  try {
    await db.query(
      `INSERT INTO contact_identity_audit (contact_id, child_id, action, fields, actor_kind, actor_id, ip) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [contactId, childId, action, fields, actorKind, actorId, ip ? String(ip).slice(0, 64) : null]);
  } catch (e) { console.error('[carer-identity] audit failed:', e.message); }   // message only
}

/** Is the migration there? (dev/older databases: every reader degrades to "no parent record".) */
let _has = { at: 0, v: null };
async function hasTable(db) {
  if (_has.v === true || (_has.v === false && Date.now() - _has.at < 60000)) return _has.v;
  try { const { rows } = await db.query(`SELECT to_regclass(current_schema() || '.contact_identity') IS NOT NULL AS ok`); _has = { at: Date.now(), v: !!rows[0].ok }; }
  catch (e) { _has = { at: Date.now(), v: false }; }
  return _has.v;
}

/** Parent 1 / parent 2 contact rows for each child (family-contacts' own ordering — one definition), with their identity row. */
async function recordsFor(db, childIds) {
  const out = new Map();
  const ids = [...new Set((childIds || []).map(Number).filter(Number.isInteger))];
  if (!ids.length) return out;
  const contactIds = new Set();
  for (const cid of ids) {
    let slots = [];
    try { slots = await FC.parentSlotsFor(db, cid); } catch (e) { slots = []; }
    const p1 = slots.find(s => s.slot === 1) || null, p2 = slots.find(s => s.slot === 2) || null;
    out.set(cid, { p1, p2 });
    if (p1) contactIds.add(p1.id); if (p2) contactIds.add(p2.id);
  }
  const ident = new Map();
  if (contactIds.size && await hasTable(db)) {
    const { rows } = await db.query(
      `SELECT contact_id, ni_number, to_char(date_of_birth,'YYYY-MM-DD') AS dob, source, updated_at FROM contact_identity WHERE contact_id = ANY($1::int[])`,
      [[...contactIds]]);
    rows.forEach(r => ident.set(Number(r.contact_id), r));
  }
  for (const [cid, v] of out) {
    const pick = p => p ? Object.assign({ contact_id: p.id, name: p.full_name, relationship: p.relationship }, ident.get(Number(p.id)) || {}) : null;
    out.set(cid, { p1: pick(v.p1), p2: pick(v.p2) });
  }
  return out;
}

/**
 * The resolved NI / DOB for parent 1 and parent 2 of each child: Map childId → { p1:{ni, dob, ni_source, dob_source, contact_id},
 * p2:{…}, funding_type, working }. opts.termId picks that term's declaration and allocation first (the claim feed);
 * otherwise the current term's allocation and the latest signed declaration.
 */
async function resolve(db, childIds, opts = {}) {
  const ids = [...new Set((childIds || []).map(Number).filter(Number.isInteger))];
  const res = new Map();
  if (!ids.length) return res;
  const termId = opts.termId ? parseInt(opts.termId, 10) : null;
  const decl = new Map();
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (child_id) child_id, payload->'parent' AS parent, payload->'partner' AS partner
         FROM funding_declarations WHERE child_id = ANY($1::int[]) AND status = 'signed'
        ORDER BY child_id, (term_id = $2::int) IS TRUE DESC, signed_at DESC`, [ids, termId]);
    rows.forEach(r => decl.set(Number(r.child_id), r));
  } catch (e) { /* no declarations table */ }
  const cf = new Map();
  try {
    const { rows } = await db.query(
      `SELECT DISTINCT ON (cf.child_id) cf.child_id, cf.funding_type, cf.carer_ni_number, to_char(cf.carer_dob,'YYYY-MM-DD') AS carer_dob
         FROM child_funding cf JOIN funding_terms t ON t.id = cf.term_id
        WHERE cf.child_id = ANY($1::int[])
        ORDER BY cf.child_id, (cf.term_id = $2::int) IS TRUE DESC, (t.is_current IS TRUE) DESC,
                 (CURRENT_DATE BETWEEN t.start_date AND t.end_date) DESC, t.start_date DESC`, [ids, termId]);
    rows.forEach(r => cf.set(Number(r.child_id), r));
  } catch (e) { /* no funding tables */ }
  const rec = await recordsFor(db, ids);
  const first = (...pairs) => { for (const [v, src] of pairs) if (v) return [v, src]; return [null, null]; };
  for (const cid of ids) {
    const d = decl.get(cid) || {}, dp = d.parent || {}, dq = d.partner || {};
    const r = rec.get(cid) || {}, r1 = r.p1 || {}, r2 = r.p2 || {};
    const a = cf.get(cid) || {};
    const okNi = v => (validNi(v) ? normaliseNi(v) : null);
    const okDob = v => (isoOf(v) && !checkDob(v) ? isoOf(v) : null);
    const [n1, n1s] = first([okNi(dp.parent_ni), 'declaration'], [okNi(r1.ni_number), 'parent_record'], [okNi(a.carer_ni_number), 'allocation']);
    const [b1, b1s] = first([okDob(dp.parent_dob), 'declaration'], [okDob(r1.dob), 'parent_record'], [okDob(a.carer_dob), 'allocation']);
    const [n2, n2s] = first([okNi(dq.partner_ni), 'declaration'], [okNi(r2.ni_number), 'parent_record']);
    const [b2, b2s] = first([okDob(dq.partner_dob), 'declaration'], [okDob(r2.dob), 'parent_record']);
    res.set(cid, {
      p1: { ni: n1, ni_source: n1s, dob: b1, dob_source: b1s, contact_id: r1.contact_id || null },
      p2: { ni: n2, ni_source: n2s, dob: b2, dob_source: b2s, contact_id: r2.contact_id || null },
      funding_type: a.funding_type || null,
      working: WORKING_TYPES.includes(a.funding_type),
    });
  }
  return res;
}

/**
 * What the Family tab shows: parent 1 and 2, MASKED, plus where the claim will take each value from. Audited as a view.
 */
async function familyView(db, childId, actor = {}) {
  const cid = Number(childId);
  const rec = (await recordsFor(db, [cid])).get(cid) || {};
  const resolved = (await resolve(db, [cid])).get(cid) || {};
  const slot = (p, which) => p ? {
    contact_id: p.contact_id, name: p.name, relationship: p.relationship,
    ni_masked: mask(p.ni_number), has_ni: !!p.ni_number, dob_masked: maskDob(p.dob), has_dob: !!p.dob,
    updated_at: p.updated_at || null, source: p.source || null,
    claim: { ni_from: (resolved[which] || {}).ni_source || null, dob_from: (resolved[which] || {}).dob_source || null,
             ni_masked: mask((resolved[which] || {}).ni), dob_masked: maskDob((resolved[which] || {}).dob) },
  } : null;
  const out = { child_id: cid, parent_1: slot(rec.p1, 'p1'), parent_2: slot(rec.p2, 'p2'),
                funding_type: resolved.funding_type || null, working: !!resolved.working, migrated: await hasTable(db) };
  // addresses-20261023: each parent's full address (not masked) and the child's own, for "Use the child's address"
  try {
    const FA = require('./family-address');
    const addr = await FA.forContacts(db, [rec.p1, rec.p2].filter(Boolean).map(p => p.contact_id));
    for (const k of ['parent_1', 'parent_2']) if (out[k]) out[k].address = addr.get(Number(out[k].contact_id)) || null;
    out.child_address = await FA.forChild(db, cid);
    out.address_migrated = await FA.hasTown(db);
  } catch (e) { console.error('[carer-identity] address lookup failed:', e.message); }
  const viewed = [rec.p1, rec.p2].filter(Boolean);
  for (const p of viewed) await audit(db, { contactId: p.contact_id, childId: cid, action: 'view', fields: ['ni_number', 'date_of_birth'], actorId: actor.id || null, ip: actor.ip });
  return out;
}

async function _ownedBy(db, contactId, childId) {
  const { rows } = await db.query(`SELECT id FROM contacts WHERE id = $1 AND $2 = ANY(child_ids)`, [contactId, childId]);
  return rows.length > 0;
}

/**
 * Set / change / clear a parent's NI and DOB. body: { ni_number?, date_of_birth? } — an absent key is not touched, '' clears.
 * Returns { status, error? , fields? }. The contact must belong to childId (so a route can only reach this child's parents).
 */
async function update(db, actor = {}, { contactId, childId, body = {}, source = 'roost' }) {
  if (!(await hasTable(db))) return { status: 503, error: 'Parental details need migrations/2026-10-23-parentdetails-ni-dob-nudge.sql' };
  const cId = parseInt(contactId, 10), chId = parseInt(childId, 10);
  if (!Number.isInteger(cId) || !Number.isInteger(chId)) return { status: 400, error: 'contact and child required' };
  if (!(await _ownedBy(db, cId, chId))) return { status: 404, error: 'That person is not on this child\'s record.' };
  const sets = {}, fields = [];
  if (body.ni_number !== undefined) {
    const ni = normaliseNi(body.ni_number);
    if (ni && !validNi(ni)) return { status: 400, error: NI_ERROR, field: 'ni_number' };
    sets.ni_number = ni; fields.push('ni_number');
  }
  if (body.date_of_birth !== undefined) {
    const s = String(body.date_of_birth || '').trim();
    if (s) { const err = checkDob(s); if (err) return { status: 400, error: err, field: 'date_of_birth' }; }
    sets.date_of_birth = s ? isoOf(s) : null; fields.push('date_of_birth');
  }
  if (!fields.length) return { status: 400, error: 'nothing to change' };
  const { rows: [cur] } = await db.query(`SELECT ni_number, to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth FROM contact_identity WHERE contact_id = $1`, [cId]);
  const changed = fields.filter(f => ((cur || {})[f] || null) !== (sets[f] || null));
  if (!changed.length) return { status: 200, fields: [], unchanged: true };
  const next = Object.assign({ ni_number: null, date_of_birth: null }, cur || {}, sets);
  await db.query(
    `INSERT INTO contact_identity (contact_id, ni_number, date_of_birth, source, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (contact_id) DO UPDATE SET ni_number = EXCLUDED.ni_number, date_of_birth = EXCLUDED.date_of_birth,
       source = EXCLUDED.source, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [cId, next.ni_number, next.date_of_birth, source, actor.id || null]);
  await audit(db, { contactId: cId, childId: chId, action: 'update', fields: changed, actorId: actor.id || null, ip: actor.ip });
  return { status: 200, fields: changed };
}

/** The full NI number, for a manager who pressed Show. Audited. */
async function reveal(db, actor = {}, { contactId, childId }) {
  if (!(await hasTable(db))) return { status: 503, error: 'not migrated' };
  const cId = parseInt(contactId, 10), chId = parseInt(childId, 10);
  if (!(await _ownedBy(db, cId, chId))) return { status: 404, error: 'That person is not on this child\'s record.' };
  const { rows: [r] } = await db.query(`SELECT ni_number, to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth FROM contact_identity WHERE contact_id = $1`, [cId]);
  await audit(db, { contactId: cId, childId: chId, action: 'reveal', fields: ['ni_number', 'date_of_birth'], actorId: actor.id || null, ip: actor.ip });
  return { status: 200, ni_number: r ? r.ni_number : null, date_of_birth: r ? r.date_of_birth : null };
}

/** Recent audit lines for one child's parents (who looked / changed, never what). */
async function auditFor(db, childId, limit = 20) {
  if (!(await hasTable(db))) return [];
  const { rows } = await db.query(
    `SELECT a.action, a.fields, a.contact_id, a.actor_kind, a.at, s.first_name AS actor_name
       FROM contact_identity_audit a LEFT JOIN staff s ON s.id = a.actor_id
      WHERE a.child_id = $1 ORDER BY a.at DESC LIMIT $2`, [Number(childId), limit]);
  return rows;
}

module.exports = {
  NI_RE, WORKING_TYPES, NI_ERROR, normaliseNi, validNi, checkDob, isoOf, mask, maskDob,
  hasTable, recordsFor, resolve, familyView, update, reveal, audit, auditFor,
};
