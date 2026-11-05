'use strict';
// ===========================================================================
// detail-inbox-search.js — parentdetails-20261023. "Search the inbox" for one gap on the Missing-details page.
//
// Behind its own switch, OFF by default (settings.detail_inbox_search_enabled). A manager presses the button for one child's gap;
// this reads that family's own past emails to the nursery (email_triage rows FROM an address the family uses), asks the LOCAL
// model (src/lib/sovereign-model.js — Ollama on the Ascent; that module refuses any non-private host, so no cloud model can be
// reached) to find the value, and returns a PROPOSAL. Nothing is written: a person reads the quote and confirms it in the normal
// editor, which audits the change.
//
// The model's answer is checked before it is shown: the value must match the field's format AND appear in the email it was said to
// come from. A model that invents a plausible NI number gets "nothing found", never a wrong number in front of the office.
// Each search is audited (contact_identity_audit, action 'inbox_search', the gap code only — never a value).
// ===========================================================================

const CI = require('./carer-identity');

const SUPPORTED = {
  parent_ni: 'the parent\'s UK National Insurance number (two letters, six digits, a letter A-D)',
  parent_dob: 'the parent\'s own date of birth (NOT the child\'s)',
  thirty_hour_code: 'the 11-digit childcare / 30-hour eligibility code from HMRC',
  thirty_hour_reconfirm: 'the 11-digit childcare / 30-hour eligibility code from HMRC',
  allergies: 'whether the child has any allergies, and what they are (or that they have none)',
};
const MAX_EMAILS = 12, MAX_CHARS = 2500;
const squash = s => String(s || '').replace(/\s+/g, '').toUpperCase();
const norm = s => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

async function familyEmails(db, childId) {
  const emails = new Set();
  try {
    const { rows } = await db.query(`SELECT lower(email) AS e FROM parent_portal_access WHERE child_id = $1 AND is_active = true`, [childId]);
    rows.forEach(r => r.e && emails.add(r.e));
  } catch (e) { /* no table */ }
  try {
    const { rows } = await db.query(`SELECT lower(primary_email) AS e FROM contacts WHERE $1 = ANY(child_ids) AND primary_email IS NOT NULL`, [childId]);
    rows.forEach(r => r.e && emails.add(r.e));
  } catch (e) { /* no table */ }
  return [...emails];
}

/** Does the model's value hold up against the email text it came from? Returns the cleaned value or null. */
function verify(code, value, text) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (code === 'parent_ni') return CI.validNi(v) && squash(text).includes(squash(v)) ? CI.normaliseNi(v) : null;
  if (code === 'thirty_hour_code' || code === 'thirty_hour_reconfirm') {
    const d = v.replace(/\D/g, '');
    return d.length === 11 && String(text).replace(/\D/g, '').includes(d) ? d : null;
  }
  if (code === 'parent_dob') {
    const iso = CI.isoOf(v);
    if (!iso || CI.checkDob(iso)) return null;
    const [y, m, d] = iso.split('-');
    const t = String(text);
    const forms = [`${d}/${m}/${y}`, `${+d}/${+m}/${y}`, `${d}.${m}.${y}`, `${d}-${m}-${y}`, iso];
    return forms.some(f => t.includes(f)) || (t.includes(y) && new RegExp(`\\b0?${+d}(st|nd|rd|th)?\\b`).test(t)) ? iso : null;
  }
  return v.slice(0, 300);   // allergies: free text, checked through the quote below
}

/**
 * opts: { childId, code, actor, generateJSON (tests) }. Returns { status, proposal|null, searched, reason? }.
 */
async function search(db, { childId, code, actor = {}, generateJSON } = {}) {
  const on = await db.query(`SELECT value FROM settings WHERE key = 'detail_inbox_search_enabled'`).then(r => r.rows[0] && r.rows[0].value === 'true').catch(() => false);
  if (!on) return { status: 403, error: 'Inbox search is switched off (Roost → Missing details → settings).' };
  if (!SUPPORTED[code]) return { status: 400, error: 'This gap is not something the inbox can answer.' };
  const cid = parseInt(childId, 10);
  if (!Number.isInteger(cid)) return { status: 400, error: 'child required' };
  await CI.audit(db, { childId: cid, action: 'inbox_search', fields: [code], actorId: actor.id || null, ip: actor.ip });
  const emails = await familyEmails(db, cid);
  if (!emails.length) return { status: 200, proposal: null, searched: 0, reason: 'We hold no email address for this family.' };
  let rows = [];
  try {
    ({ rows } = await db.query(
      `SELECT id, received_at, subject, COALESCE(NULLIF(body_full,''), body_preview, '') AS body
         FROM email_triage WHERE lower(from_email) = ANY($1::text[]) AND received_at > now() - interval '18 months'
        ORDER BY received_at DESC LIMIT $2`, [emails, MAX_EMAILS]));
  } catch (e) { return { status: 200, proposal: null, searched: 0, reason: 'The inbox is not available here.' }; }
  if (!rows.length) return { status: 200, proposal: null, searched: 0, reason: 'No emails from this family in the last 18 months.' };

  const numbered = rows.map((r, i) => `=== EMAIL ${i + 1} (subject: ${String(r.subject || '').slice(0, 120)}) ===\n${String(r.body).slice(0, MAX_CHARS)}`).join('\n\n');
  const prompt = `Below are emails a family sent to their children's nursery. Find ${SUPPORTED[code]}.\n`
    + `Only answer from what is written. If it is not clearly there, answer found=false. Never guess or construct a value.\n`
    + `Reply with JSON only: {"found": true|false, "value": "<the value exactly as written>", "email": <email number>, "quote": "<the shortest exact sentence from that email that contains it>"}\n\n${numbered}`;
  const gen = generateJSON || require('./sovereign-model').generateJSON;
  let ans;
  try { ans = await gen({ prompt, numPredict: 300, temperature: 0 }); }
  catch (e) { return { status: 503, error: 'The local model is not reachable right now. Nothing was sent anywhere else.' }; }
  if (!ans || !ans.ok || !ans.value || ans.value.found !== true) return { status: 200, proposal: null, searched: rows.length, reason: 'Nothing found in this family\'s emails.' };
  const idx = parseInt(ans.value.email, 10) - 1;
  const src = rows[idx];
  if (!src) return { status: 200, proposal: null, searched: rows.length, reason: 'The model\'s answer didn\'t check out, so it isn\'t shown.' };
  const text = `${src.subject || ''}\n${src.body}`;
  const value = verify(code, ans.value.value, text);
  const quote = String(ans.value.quote || '').slice(0, 400);
  const quoteOk = quote && norm(text).includes(norm(quote));
  if (!value || (code === 'allergies' && !quoteOk)) return { status: 200, proposal: null, searched: rows.length, reason: 'The model\'s answer didn\'t check out, so it isn\'t shown.' };
  return {
    status: 200, searched: rows.length,
    proposal: { code, value, quote: quoteOk ? quote : null, email: { id: src.id, received_at: src.received_at, subject: src.subject } },
    confirm_in: code === 'parent_ni' || code === 'parent_dob' ? 'family_identity' : code === 'allergies' ? 'child_profile_health' : 'funding_allocation',
  };
}

module.exports = { search, verify, familyEmails, SUPPORTED };
