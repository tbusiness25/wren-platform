'use strict';
// ===========================================================================
// outstanding.js — b502. ONE "outstanding details" engine. Everything that asks "what is still missing?" calls this:
// the Roost Missing-details page, the Forms & documents "Still needed" column, the parents' To-do banner, reminder campaigns,
// the staff accountability tasks (b501), and the weekly / monthly briefings (b503).
//
// It is DERIVED, never stored: the answer is whatever the live tables say right now, so a gap closes the moment somebody fills it in
// and no reminder can outlive the thing it was about. (The only things stored are WHEN we first noticed an item — detail_items_seen —
// and which reminders went out.)
//
// Two subjects:
//   children  one entry per active child with the items still outstanding: { code, label, who: 'parent'|'us', since, ... }
//             `who` = who has to supply it: the PARENT (details only the family has) or US (the office / key person).
//   staff     one entry per active staff member: DBS / right to work / training / qualification gaps, and their own open tasks.
//
// GDPR: names appear only in the objects this returns, which are only ever shown inside Wren (Roost, the family's own app). Nothing here
// builds an email, and nothing here is ever given to a parent except through forFamily(), which returns that family's own items only.
// ===========================================================================

const DEFAULT_CONSENTS = ['photo_media', 'marketing_face', 'learning_journey_group'];
const CONSENT_LABELS = {
  photo_media: 'Photo and media consent', marketing_face: 'Face-in-marketing consent', learning_journey_group: 'Group photos in learning journeys',
};

// who: 'parent' = the family has to supply it; 'us' = the office / key person.
// page: where a parent goes to fix it (parents app routes).
const CODES = {
  funding_declaration:    { label: 'Funding declaration not signed this term', who: 'parent', page: 'declaration' },
  // parentdetails-20261023: values come from src/lib/carer-identity.js resolve() (declaration → parent record → allocation).
  // parentsapp-20261023 (Toby: "We actually need date of birth and National Insurance number"): BOTH are needed for every funding
  // type again, so each one is its own gap.
  parent_ni:              { label: 'Parent NI number missing',                 who: 'parent', page: 'declaration' },
  parent_dob:             { label: 'Parent date of birth missing',             who: 'parent', page: 'declaration' },
  thirty_hour_code:       { label: '30-hour code missing',                     who: 'parent', page: 'declaration' },
  thirty_hour_reconfirm:  { label: '30-hour code needs reconfirming',          who: 'parent', page: 'declaration' },
  address:                { label: 'Home address or postcode missing',         who: 'parent', page: 'details' },
  ethnicity:              { label: 'Ethnicity not recorded',                   who: 'parent', page: 'details' },
  emergency_contact:      { label: 'No emergency contact',                     who: 'parent', page: 'details' },
  allergies:              { label: 'Allergies and medical not confirmed',      who: 'parent', page: 'details' },
  consent:                { label: 'Consent not answered',                     who: 'parent', page: 'consents' },
  form_to_sign:           { label: 'A form is waiting for a signature',        who: 'parent', page: 'forms' },
  about_me_missing:       { label: 'All About Me not started',                 who: 'parent', page: 'details' },
  about_me_incomplete:    { label: 'All About Me not marked complete',         who: 'us',     page: null },
  key_person:             { label: 'No key person assigned',                   who: 'us',     page: null },
};
const TYPE_GROUPS = {   // the filter on the page
  funding: ['funding_declaration', 'parent_ni', 'parent_dob', 'thirty_hour_code', 'thirty_hour_reconfirm'],
  contact: ['address', 'emergency_contact', 'ethnicity'],
  health:  ['allergies'],
  consent: ['consent'],
  forms:   ['form_to_sign'],
  about_me: ['about_me_missing', 'about_me_incomplete'],
  key_person: ['key_person'],
};

async function _setting(db, key, dflt) {
  try { const { rows } = await db.query(`SELECT value FROM settings WHERE key=$1`, [key]); return rows[0] && rows[0].value != null ? rows[0].value : dflt; }
  catch (e) { return dflt; }
}
async function consentTypes(db) {
  const v = await _setting(db, 'outstanding_consent_types', null);
  const list = v ? String(v).split(',').map(s => s.trim()).filter(Boolean) : DEFAULT_CONSENTS;
  return list.length ? list : DEFAULT_CONSENTS;
}

const name = r => `${r.first_name || ''} ${r.last_name || ''}`.trim();

// ── children ────────────────────────────────────────────────────────────────
/**
 * Every active child with at least one outstanding item (or all of them with `includeComplete`).
 * opts: { childIds?: int[], roomId?: int, codes?: string[], who?: 'parent'|'us' }
 */
async function forChildren(db, opts = {}) {
  const o = opts || {};
  const types = await consentTypes(db);
  const params = [];
  let where = `c.is_active = true`;
  if (Array.isArray(o.childIds)) { params.push(o.childIds.map(Number).filter(Number.isInteger)); where += ` AND c.id = ANY($${params.length}::int[])`; }
  if (o.roomId) { params.push(Number(o.roomId)); where += ` AND c.room_id = $${params.length}`; }

  const { rows } = await db.query(`
    SELECT c.id, COALESCE(NULLIF(c.preferred_name,''), c.first_name) AS first_name, c.last_name, c.room_id, r.name AS room_name,
           c.key_person_id, kp.first_name AS key_person_first,
           c.start_date::text AS start_date,
           (btrim(coalesce(c.address_line1,'')) = '' OR btrim(coalesce(c.postcode,'')) = '')              AS no_address,
           (btrim(coalesce(c.ethnicity,'')) = '')                                                          AS no_ethnicity,
           (btrim(coalesce(c.emergency_contact_1_name,'')) = '' AND btrim(coalesce(c.emergency_contact_2_name,'')) = '') AS no_emergency,
           (c.allergies IS NULL AND coalesce(array_length(c.allergens,1),0) = 0
              AND btrim(coalesce(a.food_allergies,'')) = '' AND btrim(coalesce(c.allergen_notes,'')) = '')   AS allergies_unconfirmed,
           (c.key_person_id IS NULL)                                                                       AS no_key_person,
           (a.id IS NULL)                                                                                  AS about_me_missing,
           (a.id IS NOT NULL AND a.completed_at IS NULL)                                                   AS about_me_incomplete,
           a.created_at                                                                                    AS about_me_since,
           COALESCE((SELECT array_agg(DISTINCT cc.consent_type) FROM child_consents cc WHERE cc.child_id = c.id), '{}') AS consents_answered,
           f.id AS allocation_id, f.funding_type, f.has_code, f.code_expiry
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff kp ON kp.id = c.key_person_id
      LEFT JOIN child_about_me a ON a.child_id = c.id
      LEFT JOIN LATERAL (
        SELECT cf.id, cf.funding_type, btrim(coalesce(cf.thirty_hour_code,'')) <> '' AS has_code,
               to_char(cf.thirty_hour_code_expiry,'YYYY-MM-DD') AS code_expiry
          FROM child_funding cf JOIN funding_terms t ON t.id = cf.term_id
         WHERE cf.child_id = c.id
         ORDER BY (t.is_current IS TRUE) DESC, (CURRENT_DATE BETWEEN t.start_date AND t.end_date) DESC, t.start_date DESC LIMIT 1
      ) f ON true
     WHERE ${where}
     ORDER BY r.name NULLS LAST, c.first_name, c.last_name`, params);

  // funding declaration: the SAME test the office tracker and the parents' Forms card use (src/lib/parent-forms.js), not a second one.
  const ids = rows.map(r => r.id);
  let declWaiting = new Set(), term = null;
  try {
    const d = await require('./parent-forms').declarationsWaiting(db, ids);
    declWaiting = new Set(d.children.map(x => Number(x.id))); term = d.term;
  } catch (e) { /* schema without funding terms */ }
  // forms awaiting a signature (read only: requests are created elsewhere, we never create them here)
  const formsBy = new Map();
  try {
    const { rows: fr } = await db.query(`
      SELECT r.child_id, count(*)::int AS n, min(r.first_seen_at) AS since
        FROM parent_form_requests r
       WHERE r.child_id = ANY($1::int[]) AND r.superseded_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM parent_form_signatures s WHERE s.request_id = r.id)
       GROUP BY r.child_id`, [ids]);
    fr.forEach(x => formsBy.set(Number(x.child_id), x));
  } catch (e) { /* table not there yet */ }
  const seen = await _seen(db, 'child');
  const remindersBy = await _remindersByChild(db, ids);
  // parent NI / DOB: declaration → parent record → allocation (one resolver, shared with the claim feed)
  let identity = new Map();
  try { identity = await require('./carer-identity').resolve(db, ids); } catch (e) { /* no funding / contacts tables */ }
  const WORKING = require('./carer-identity').WORKING_TYPES;
  // a 30-hour code is due for reconfirming if it lapses within 3 weeks or before the next claim window closes
  const today = new Date().toISOString().slice(0, 10);
  let reconfirmBy = new Date(Date.now() + 21 * 86400000).toISOString().slice(0, 10);
  try {
    const { rows: [np] } = await db.query(`SELECT to_char(min(COALESCE(adj_portal_closes, portal_closes)),'YYYY-MM-DD') AS d
                                              FROM funding_claim_periods WHERE COALESCE(adj_portal_closes, portal_closes) >= CURRENT_DATE`);
    if (np && np.d && np.d > reconfirmBy) reconfirmBy = np.d;
  } catch (e) { /* no claim timetable */ }
  const dmy = iso => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

  const out = [];
  for (const r of rows) {
    const items = [];
    const add = (code, extra) => items.push(Object.assign({ code, label: CODES[code].label, who: CODES[code].who, since: null }, extra || {}));
    if (declWaiting.has(r.id)) add('funding_declaration', { since: term ? null : null });
    if (r.allocation_id && r.funding_type && r.funding_type !== 'none') {
      const p1 = (identity.get(r.id) || {}).p1 || {};
      const working = WORKING.includes(r.funding_type);
      if (!p1.ni) add('parent_ni');
      if (!p1.dob) add('parent_dob');
      if (working && !r.has_code) add('thirty_hour_code');
      else if (working && !r.code_expiry) add('thirty_hour_reconfirm', { label: '30-hour code: expiry / reconfirm date not recorded' });
      else if (working && r.code_expiry <= reconfirmBy) {
        add('thirty_hour_reconfirm', { due: r.code_expiry, expired: r.code_expiry < today,
          label: r.code_expiry < today ? `30-hour code lapsed ${dmy(r.code_expiry)}: needs reconfirming` : `30-hour code needs reconfirming by ${dmy(r.code_expiry)}` });
      }
    }
    if (r.no_address) add('address');
    if (r.no_ethnicity) add('ethnicity');
    if (r.no_emergency) add('emergency_contact');
    if (r.allergies_unconfirmed) add('allergies');
    for (const t of types) if (!(r.consents_answered || []).includes(t)) add('consent', { label: (CONSENT_LABELS[t] || t) + ' not answered', detail: t });
    const fm = formsBy.get(r.id);
    if (fm) add('form_to_sign', { label: fm.n === 1 ? CODES.form_to_sign.label : `${fm.n} forms are waiting for a signature`, since: fm.since });
    if (r.about_me_missing) add('about_me_missing');
    if (r.about_me_incomplete) add('about_me_incomplete', { since: r.about_me_since });
    if (r.no_key_person) add('key_person');
    for (const it of items) {
      if (!it.since) { const s = seen.get(`${r.id}:${it.code}${it.detail ? ':' + it.detail : ''}`) || seen.get(`${r.id}:${it.code}`); it.since = s || null; }
    }
    let kept = items;
    if (o.codes) kept = kept.filter(i => o.codes.includes(i.code));
    if (o.who) kept = kept.filter(i => i.who === o.who);
    const rem = remindersBy.get(r.id) || { n: 0, last: null };
    out.push({
      child_id: r.id, name: name(r), first_name: r.first_name, room_id: r.room_id, room_name: r.room_name,
      key_person_id: r.key_person_id, items: kept, reminders_sent: rem.n, last_reminded: rem.last,
    });
  }
  return o.includeComplete ? out : out.filter(c => c.items.length);
}

async function _seen(db, type) {
  const m = new Map();
  try {
    const { rows } = await db.query(`SELECT subject_id, code, first_seen_at FROM detail_items_seen WHERE subject_type=$1 AND resolved_at IS NULL`, [type]);
    rows.forEach(r => m.set(`${r.subject_id}:${r.code}`, r.first_seen_at));
  } catch (e) { /* table not there yet */ }
  return m;
}
async function _remindersByChild(db, ids) {
  const m = new Map();
  try {
    const { rows } = await db.query(`SELECT child_id, count(*)::int AS n, max(sent_at) AS last FROM detail_campaign_log WHERE child_id = ANY($1::int[]) GROUP BY child_id`, [ids]);
    rows.forEach(r => m.set(Number(r.child_id), { n: r.n, last: r.last }));
  } catch (e) { /* table not there yet */ }
  try {   // parentdetails-20261023: + nudges actually sent (src/lib/detail-nudge.js), counted against every child the message covered
    const { rows } = await db.query(
      `SELECT k AS child_id, count(*)::int AS n, max(sent_at) AS last FROM detail_nudge_log, unnest(child_ids) k
        WHERE NOT dry_run AND k = ANY($1::int[]) GROUP BY k`, [ids]);
    rows.forEach(r => { const cur = m.get(Number(r.child_id)) || { n: 0, last: null };
      m.set(Number(r.child_id), { n: cur.n + r.n, last: !cur.last || new Date(r.last) > new Date(cur.last) ? r.last : cur.last }); });
  } catch (e) { /* table not there yet */ }
  return m;
}

/**
 * Note when each outstanding item was FIRST seen, and close the ones that are no longer outstanding. Called by the page, the sync and the
 * campaign runner so "how long has it been outstanding" is honest without a cron of its own. Idempotent.
 */
async function touch(db, type, entries, scopeIds) {
  try {
    const scope = Array.isArray(scopeIds) ? new Set(scopeIds.map(Number)) : null;     // only subjects inside this scope may be marked resolved
    const present = new Set();
    for (const e of entries) {
      const id = e.child_id != null ? e.child_id : e.staff_id;
      for (const it of e.items) {
        const key = `${it.code}${it.detail ? ':' + it.detail : ''}`;
        present.add(`${id}|${key}`);
        await db.query(`INSERT INTO detail_items_seen (subject_type, subject_id, code) VALUES ($1,$2,$3) ON CONFLICT (subject_type, subject_id, code) DO NOTHING`, [type, id, key]);
      }
    }
    const { rows } = await db.query(`SELECT subject_id, code FROM detail_items_seen WHERE subject_type=$1 AND resolved_at IS NULL`, [type]);
    for (const r of rows) {
      if (scope && !scope.has(Number(r.subject_id))) continue;
      if (!present.has(`${r.subject_id}|${r.code}`)) await db.query(`UPDATE detail_items_seen SET resolved_at=now() WHERE subject_type=$1 AND subject_id=$2 AND code=$3`, [type, r.subject_id, r.code]);
    }
  } catch (e) { /* the table may not exist yet; since stays null */ }
}

// ── the parents' own view ────────────────────────────────────────────────────
/** What THIS family still has to supply, for its own children only. Parent-to-do items only; never an internal "us" item. */
async function forFamily(db, childIds) {
  const kids = await forChildren(db, { childIds, who: 'parent' });
  const items = [];
  for (const k of kids) for (const it of k.items) {
    items.push({ child_id: k.child_id, child_name: k.first_name, code: it.code, label: it.label, page: CODES[it.code].page, since: it.since });
  }
  return items;
}

// ── staff ───────────────────────────────────────────────────────────────────
const STAFF_CODES = {
  dbs_missing:        { label: 'DBS details missing' },
  dbs_expiring:       { label: 'DBS expiring or expired' },
  rtw_missing:        { label: 'Right to work not recorded' },
  rtw_expiring:       { label: 'Right to work expiring or expired' },
  training_missing:   { label: 'Mandatory training not recorded' },
  training_expired:   { label: 'Training expired or expiring' },
  qualification:      { label: 'Qualification not recorded' },
};
const EXPIRY_WINDOW_DAYS = 60;

async function forStaff(db, opts = {}) {
  const o = opts || {};
  const params = [];
  let where = `s.is_active = true AND s.role NOT IN ('parent','accountant') AND COALESCE(s.terminated,false) = false AND COALESCE(s.is_demo,false) = false`;
  if (Array.isArray(o.staffIds)) { params.push(o.staffIds.map(Number).filter(Number.isInteger)); where += ` AND s.id = ANY($${params.length}::int[])`; }
  if (o.roomId) { params.push(Number(o.roomId)); where += ` AND s.room_id = $${params.length}`; }
  const { rows } = await db.query(`
    SELECT s.id, s.first_name, s.last_name, s.role, s.room_id, r.name AS room_name,
           s.dbs_number, s.dbs_expiry::text AS dbs_expiry, s.right_to_work_status, s.right_to_work_expiry_date::text AS rtw_expiry,
           s.qualification, s.qualification_level,
           (SELECT count(*)::int FROM tasks t WHERE t.status IN ('open','in_progress') AND t.category='nursery' AND t.archived_at IS NULL
              AND t.source NOT IN ('outstanding','outstanding_weekly')
              AND (t.owner_staff_id = s.id OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.staff_id = s.id AND a.status <> 'done'))) AS open_tasks
      FROM staff s LEFT JOIN rooms r ON r.id = s.room_id
     WHERE ${where}
     ORDER BY s.first_name, s.last_name`, params);

  // Training: the matrix is the one definition of "expired / missing" (src/lib/training-matrix.js), used by Staff records and the CPD matrix.
  // cells[key].status is 'missing' | 'overdue' | 'expiring_soon' | 'current'; only MANDATORY courses count as outstanding.
  const training = new Map();
  let courses = [];
  try {
    const m = await require('./training-matrix').computeTrainingMatrix(db);
    courses = (m.courses || []).filter(c => c.mandatory !== false);
    for (const st of (m.staff || [])) training.set(Number(st.staff_id), st);
  } catch (e) { /* matrix unavailable: no training items rather than a wrong answer */ }

  const today = new Date().toISOString().slice(0, 10);
  const soon = new Date(Date.now() + EXPIRY_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const seen = await _seen(db, 'staff');
  const out = [];
  for (const r of rows) {
    const items = [];
    const add = (code, extra) => items.push(Object.assign({ code, label: STAFF_CODES[code].label, who: 'staff', since: null }, extra || {}));
    if (!r.dbs_expiry && !String(r.dbs_number || '').trim()) add('dbs_missing');
    else if (r.dbs_expiry && r.dbs_expiry <= soon) add('dbs_expiring', { due: r.dbs_expiry, expired: r.dbs_expiry < today });
    if (!String(r.right_to_work_status || '').trim()) add('rtw_missing');
    else if (r.rtw_expiry && r.rtw_expiry <= soon) add('rtw_expiring', { due: r.rtw_expiry, expired: r.rtw_expiry < today });
    if (!String(r.qualification || '').trim() && r.qualification_level == null) add('qualification');
    const tm = training.get(r.id);
    if (tm) {
      const nameOf = k => (courses.find(c => c.key === k) || {}).name || k;
      const keys = courses.map(c => c.key);
      const missing = keys.filter(k => (tm.cells[k] || {}).status === 'missing');
      const bad = keys.filter(k => ['overdue', 'expiring_soon'].includes((tm.cells[k] || {}).status));
      if (bad.length) add('training_expired', { detail: bad.map(nameOf).slice(0, 6).join(', '), count: bad.length });
      if (missing.length) add('training_missing', { detail: missing.map(nameOf).slice(0, 6).join(', '), count: missing.length });
    }
    for (const it of items) it.since = seen.get(`${r.id}:${it.code}`) || null;
    out.push({ staff_id: r.id, name: name(r), role: r.role, room_id: r.room_id, room_name: r.room_name, open_tasks: r.open_tasks, items });
  }
  return o.includeComplete ? out : out.filter(s => s.items.length);
}

// ── summary / checklist (b503 calls these) ───────────────────────────────────
/** Counts for a scope. scope = { room_id } for a room leader, or {} for the whole setting. */
async function summary(db, scope = {}) {
  const kids = await forChildren(db, { roomId: scope.room_id || null });
  const byCode = {}, rooms = {};
  let parentTodo = 0, usTodo = 0;
  for (const k of kids) for (const it of k.items) {
    byCode[it.code] = (byCode[it.code] || 0) + 1;
    if (it.who === 'parent') parentTodo++; else usTodo++;
    rooms[k.room_name || 'No room'] = (rooms[k.room_name || 'No room'] || 0) + 1;
  }
  const staff = scope.room_id ? [] : await forStaff(db);
  return {
    children_with_gaps: kids.length, items: parentTodo + usTodo, parent_to_do: parentTodo, us_to_do: usTodo,
    by_code: byCode, by_room: rooms, staff_with_gaps: staff.length, staff_items: staff.reduce((n, s) => n + s.items.length, 0),
  };
}

/**
 * "This week's outstanding details" for one scope: the lines a manager / deputy / room leader goes through every Monday.
 * Returns { title, lines: [{ label, count, who, children: [first names] }], total } — the weekly task and the b503 briefing both use it.
 */
async function checklist(db, scope = {}) {
  const kids = await forChildren(db, { roomId: scope.room_id || null });
  const groups = new Map();
  for (const k of kids) for (const it of k.items) {
    const key = it.code === 'consent' ? `consent:${it.detail}` : it.code;
    if (!groups.has(key)) groups.set(key, { code: it.code, label: it.code === 'consent' ? it.label : CODES[it.code].label, who: it.who, children: [] });
    groups.get(key).children.push(k.first_name);
  }
  const lines = [...groups.values()].map(g => ({ code: g.code, label: g.label, who: g.who, count: g.children.length, children: g.children.slice(0, 40) }))
    .sort((a, b) => (a.who === b.who ? b.count - a.count : (a.who === 'us' ? -1 : 1)));
  const staff = scope.room_id ? [] : await forStaff(db);
  return { title: "This week's outstanding details", lines, total: lines.reduce((n, l) => n + l.count, 0),
           staff: staff.map(s => ({ name: s.name, items: s.items.map(i => i.label) })) };
}

module.exports = { CODES, TYPE_GROUPS, STAFF_CODES, CONSENT_LABELS, forChildren, forFamily, forStaff, summary, checklist, touch, consentTypes };
