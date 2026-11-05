'use strict';
// ===========================================================================
// family-address.js — addresses-20261023. A parent's full postal address (line 1, line 2, town, postcode) on contacts.
//
// Toby, 2026-10-23: "the address info isn't shown in Wren; we have postcodes but not address line 1, line 2."
// The address lives on the person (contacts.address_line1 / address_line2 / town / postcode) and is shown and edited in Roost →
// child profile → Family → Parental details. A child's own address is on children (address_line1 / address_line2 / town /
// postcode) and is edited on the child profile's Details tab through the ordinary PUT /api/children/:id.
//
// A child's address is NEVER copied onto a parent automatically (separated parents, grandparents…). The Family editor offers
// "Use the child's address" as a button a person presses; the backfill (scripts/addresses-backfill.js) only counts those.
// Every change is written to contact_identity_audit (field names only, never the address).
// ===========================================================================

const CI = require('./carer-identity');

const FIELDS = ['address_line1', 'address_line2', 'town', 'postcode'];
const LIMITS = { address_line1: 200, address_line2: 200, town: 100, postcode: 12 };
const UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

const clean = v => { const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim(); return s || null; };
/** "ab12cd" → "AB1 2CD". Anything that is not a UK postcode is returned trimmed, unchanged. */
function normalisePostcode(v) {
  const s = clean(v);
  if (!s) return null;
  const t = s.replace(/\s+/g, '').toUpperCase();
  return UK_POSTCODE.test(t) ? `${t.slice(0, -3)} ${t.slice(-3)}` : s;
}

// Localities that EyMan (and people) put in "address 2" when they mean the town. Used only to split an imported EyMan address.
const LOCALITIES = new Set(['london', 'ealing', 'west ealing', 'south ealing', 'northfields', 'hanwell', 'acton', 'west acton', 'east acton',
  'greenford', 'southall', 'perivale', 'northolt', 'brentford', 'isleworth', 'hounslow', 'chiswick', 'middlesex', 'shepherds bush',
  'hammersmith', 'harrow', 'wembley', 'uxbridge', 'hayes', 'twickenham', 'richmond', 'kew', 'osterley']);
const isLocality = v => !!v && LOCALITIES.has(String(v).toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim());

/** An EyMan parent row's address_1/2/3 → Wren's four fields. address_3 is the town when present; else a locality in address_2 is. */
function fromEyman(r) {
  const a1 = clean(r.address_1), a2 = clean(r.address_2), a3 = clean(r.address_3);
  let line2 = a2, town = a3;
  if (!a3 && isLocality(a2)) { town = a2; line2 = null; }
  return { address_line1: a1, address_line2: line2, town, postcode: normalisePostcode(r.postcode) };
}

async function hasTown(db) {
  try {
    const { rows } = await db.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'contacts' AND column_name = 'town'`);
    return rows.length > 0;
  } catch (e) { return false; }
}

/** Map contactId → { address_line1, address_line2, town, postcode }. */
async function forContacts(db, contactIds) {
  const ids = [...new Set((contactIds || []).map(Number).filter(Number.isInteger))];
  const out = new Map();
  if (!ids.length) return out;
  const town = (await hasTown(db)) ? 'town' : 'NULL::text AS town';
  const { rows } = await db.query(`SELECT id, address_line1, address_line2, ${town}, postcode FROM contacts WHERE id = ANY($1::int[])`, [ids]);
  rows.forEach(r => out.set(Number(r.id), { address_line1: r.address_line1, address_line2: r.address_line2, town: r.town, postcode: r.postcode }));
  return out;
}

/** The child's own address (for "Use the child's address" and the claim feed). */
async function forChild(db, childId) {
  try {
    const { rows: [c] } = await db.query(`SELECT address_line1, address_line2, town, postcode FROM children WHERE id = $1`, [childId]);
    return c || null;
  } catch (e) {
    const { rows: [c] } = await db.query(`SELECT address_line1, NULL::text AS address_line2, NULL::text AS town, postcode FROM children WHERE id = $1`, [childId]);
    return c || null;
  }
}

/**
 * Set a parent's address. body: any of FIELDS — an absent key is not touched, '' clears it. The contact must be on this child's
 * record. Returns { status, fields?, error? }.
 */
async function update(db, actor = {}, { contactId, childId, body = {} }) {
  if (!(await hasTown(db))) return { status: 503, error: 'Addresses need migrations/2026-10-23-addresses-town-line2.sql' };
  const cId = parseInt(contactId, 10), chId = parseInt(childId, 10);
  if (!Number.isInteger(cId) || !Number.isInteger(chId)) return { status: 400, error: 'contact and child required' };
  const { rows: own } = await db.query(`SELECT address_line1, address_line2, town, postcode FROM contacts WHERE id = $1 AND $2 = ANY(child_ids)`, [cId, chId]);
  if (!own.length) return { status: 404, error: 'That person is not on this child\'s record.' };
  const cur = own[0], next = {};
  for (const f of FIELDS) {
    if (body[f] === undefined) continue;
    let v = clean(body[f]);
    if (v && v.length > LIMITS[f]) return { status: 400, error: `That ${f.replace(/_/g, ' ')} is too long.`, field: f };
    if (f === 'postcode') v = normalisePostcode(v);
    next[f] = v;
  }
  if (next.postcode && !UK_POSTCODE.test(next.postcode.replace(/\s+/g, ''))) return { status: 400, error: 'That postcode doesn\'t look like a UK postcode.', field: 'postcode' };
  const changed = Object.keys(next).filter(f => (cur[f] || null) !== (next[f] || null));
  if (!changed.length) return { status: 200, fields: [], unchanged: true };
  const vals = [cId], sets = changed.map(f => { vals.push(next[f]); return `${f} = $${vals.length}`; });   // column names from FIELDS only
  await db.query(`UPDATE contacts SET ${sets.join(', ')} WHERE id = $1`, vals);
  await CI.audit(db, { contactId: cId, childId: chId, action: 'update', fields: changed, actorId: actor.id || null, ip: actor.ip });
  return { status: 200, fields: changed };
}

const oneLine = a => (a ? [a.address_line1, a.address_line2, a.town, a.postcode].map(clean).filter(Boolean).join(', ') : '');

module.exports = { FIELDS, normalisePostcode, isLocality, fromEyman, forContacts, forChild, update, oneLine, hasTown };
