'use strict';
// family-details.js (3 Nov 2026) — one family, two rows.
//
// A family on the Pipeline is an `enquiries` row; once they join the waiting list they
// also have a `waiting_list` row (waiting_list.enquiry_id), and both carry the child's
// and the parent's details. The office could edit them in only ONE place — the Waiting
// list tab's Update box — and nowhere at all for a Pipeline card with no waiting-list
// row, so a missing email or a misspelt name stayed missing on one of the two. Toby:
// "there also isn't a way to add missing details at a later date, so you need to be
// able to go and edit or add fields". Every details edit now goes through here and
// lands on both rows.

// [enquiries column, waiting_list column]
const PAIRS = [
  ['child_first_name',     'child_first_name'],
  ['child_last_name',      'child_last_name'],
  ['child_dob',            'child_dob'],
  ['parent_name',          'parent_name'],
  ['parent_email',         'parent_email'],
  ['parent_phone',         'parent_phone'],
  ['preferred_room',       'room_needed'],
  ['preferred_start_date', 'expected_start_date'],
];
const ENQUIRY_FIELDS = PAIRS.map(p => p[0]);
const TO_WAITLIST = Object.fromEntries(PAIRS);
const TO_ENQUIRY  = Object.fromEntries(PAIRS.map(([e, w]) => [w, e]));
const DATE_FIELDS = new Set(['child_dob', 'preferred_start_date', 'expected_start_date']);
const DATE_LABELS = { child_dob: 'Date of birth', preferred_start_date: 'Start date', expected_start_date: 'Start date' };

// Only the keys present in `body` are read, so a form that sends just what changed never
// overwrites a field nobody touched. '' clears a field — except the phone: b532 made a
// phone mandatory at every creation point, and an edit must not be the way round that.
function fromBody(body, fields) {
  const out = {};
  for (const f of fields) {
    if (!Object.prototype.hasOwnProperty.call(body || {}, f)) continue;
    let v = body[f] === null || body[f] === undefined ? '' : String(body[f]).trim();
    if (f === 'parent_phone' && !v) continue;
    if (!v) { out[f] = null; continue; }
    if (f === 'parent_email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('That email address does not look right.');
    if (DATE_FIELDS.has(f)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(v))) throw new Error(`${DATE_LABELS[f]} must be a date.`);
    }
    if (v.length > 200) v = v.slice(0, 200);
    out[f] = v;
  }
  return out;
}

async function update(db, table, id, values) {
  const keys = Object.keys(values);
  if (!keys.length) return null;
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  if (table === 'enquiries') sets.push('updated_at = NOW()'); // waiting_list has no updated_at
  const { rows } = await db.query(
    `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    [id, ...keys.map(k => values[k])]);
  return rows[0] || null;
}

// The mirror carries real values only, never a blank: the Waiting list tab's Update box
// sends every field whether it changed or not, so an empty email there would otherwise
// wipe the email the family gave on their enquiry.
function translate(values, map) {
  const out = {};
  for (const [k, v] of Object.entries(values)) {
    if (!map[k] || v === null || v === undefined || v === '') continue;
    out[map[k]] = v;
  }
  return out;
}

// Enquiry edited → the family's live waiting-list row, if they have one.
async function mirrorToWaitlist(db, enquiryId, enquiryValues) {
  const { rows } = await db.query(
    `SELECT id FROM waiting_list_live WHERE enquiry_id = $1 ORDER BY id DESC LIMIT 1`, [enquiryId]);
  if (!rows.length) return null;
  return update(db, 'waiting_list', rows[0].id, translate(enquiryValues, TO_WAITLIST));
}

// Waiting-list row edited → the Pipeline card it came from, if any.
async function mirrorToEnquiry(db, enquiryId, waitlistValues) {
  if (!enquiryId) return null;
  return update(db, 'enquiries', enquiryId, translate(waitlistValues, TO_ENQUIRY));
}

module.exports = { ENQUIRY_FIELDS, WAITLIST_FIELDS: PAIRS.map(p => p[1]), fromBody, update, mirrorToWaitlist, mirrorToEnquiry };
