'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// report-builder.js — custom reports, the EyMan kind: pick a subject, tick the fields, and ask for the GAPS.
// b342, 2026-09-21
//
// EyMan's custom reports let Toby put "parent names, parent emails, child names" on a page and see what is missing.
// Wren had nothing like it (reports.html is EYFS progress reports; export.js is PDFs). This is that.
//
// ONE TABLE-DRIVEN MAP. Every field a report can show is one entry in SUBJECTS[subject].fields — a label, a group, the
// SQL expression that yields the value, and which joins the expression needs. A new field is one entry, never a new
// query. The compiler below assembles ONE statement from the entries a definition names, and nothing else can reach
// the SQL: field keys are checked against the registry, filters are enums, and the only values that travel as
// parameters are numbers.
//
// WHAT "MISSING" MEANS
//   A value is missing when it is NULL or blank once trimmed. A consent that has never been answered is missing; one
//   answered "No" is not (a recorded refusal is an answer). A number is missing when NULL; zero is a real value.
//   The filter Toby asked for is "only rows where one of these fields is missing" — `missing: {mode:'any'|'all', fields}`.
//
// WHAT THIS FILE WILL NEVER DO
//   · return a pay field to someone who cannot see pay — `pay: true` fields are stripped/refused here, once, so a saved
//     report can never be a way round src/lib/capabilities.js (canViewSalaries);
//   · list a secret. There is no registry entry for pin_hash, totp_secret, ni_number, tax_code, a collection password,
//     a court order or a safeguarding field, and adding one is the only way one could ever appear;
//   · call a model, send an email or write a file. It returns rows; the route streams them to the manager who asked.
// ─────────────────────────────────────────────────────────────────────────────

const PARENT_RELS = "ARRAY['Mother','Father','Parent','Guardian']";
const blank = e => `NULLIF(btrim((${e})::text), '')`;
const ymd = e => `to_char(${e}, 'YYYY-MM-DD')`;             // a DATE never crosses to JS as a Date (memory: pg DATE → ymd() trap)
const yesNo = e => `CASE ${e} WHEN true THEN 'Yes' WHEN false THEN 'No' END`;

// ── children ─────────────────────────────────────────────────────────────────
const parentLateral = (alias, offset) => `
  LEFT JOIN LATERAL (
    SELECT ct.full_name, ct.primary_email, ct.primary_phone, ct.relationship
      FROM contacts ct
     WHERE c.id = ANY(ct.child_ids) AND ct.relationship = ANY(${PARENT_RELS}) AND NOT ct.is_emergency_contact
     ORDER BY COALESCE(ct.parent_slot, 3), CASE ct.relationship WHEN 'Mother' THEN 1 WHEN 'Father' THEN 2 ELSE 3 END, ct.id
     OFFSET ${offset} LIMIT 1
  ) ${alias} ON true`;

const emergencyLateral = (alias, offset) => `
  LEFT JOIN LATERAL (
    SELECT ct.id, ct.full_name, ct.relationship, ct.primary_phone
      FROM contacts ct
     WHERE c.id = ANY(ct.child_ids) AND ct.is_emergency_contact
     ORDER BY ct.id
     OFFSET ${offset} LIMIT 1
  ) ${alias} ON true`;

// The first emergency contact that is COMPLETE (a name AND a phone), wherever it lives: a flagged contact, else the two
// flat slots on the child row. "Has an emergency contact" is asked of this, not of a name alone — a name with no number
// cannot be rung.
const EC_COMPLETE = `
  LEFT JOIN LATERAL (
    SELECT x.n, x.p FROM (
      SELECT NULLIF(btrim(ct.full_name), '') AS n, NULLIF(btrim(ct.primary_phone), '') AS p, 1 AS ord, ct.id AS oid
        FROM contacts ct WHERE c.id = ANY(ct.child_ids) AND ct.is_emergency_contact
      UNION ALL
      SELECT NULLIF(btrim(c.emergency_contact_1_name), ''), NULLIF(btrim(c.emergency_contact_1_phone), ''), 2, 0
      UNION ALL
      SELECT NULLIF(btrim(c.emergency_contact_2_name), ''), NULLIF(btrim(c.emergency_contact_2_phone), ''), 3, 0
    ) x WHERE x.n IS NOT NULL AND x.p IS NOT NULL
    ORDER BY x.ord, x.oid LIMIT 1
  ) ec ON true`;

const P = (n, part) => {
  const alias = `p${n}`;
  const map = { name: ['full_name', `c.parent_${n}_name`], email: ['primary_email', `c.parent_${n}_email`], phone: ['primary_phone', `c.parent_${n}_phone`] };
  const [col, colFallback] = map[part];
  const expr = `COALESCE(${blank(`${alias}.${col}`)}, ${blank(colFallback)})`;
  return part === 'email' ? `lower(${expr})` : expr;
};
const EC = (n, part) => {
  const alias = `e${n}`;
  const flat = { name: `c.emergency_contact_${n}_name`, phone: `c.emergency_contact_${n}_phone`, relationship: n === 1 ? 'c.emergency_contact_1_relation' : 'NULL' };
  const col = { name: 'full_name', phone: 'primary_phone', relationship: 'relationship' }[part];
  return `CASE WHEN ${alias}.id IS NOT NULL THEN ${blank(`${alias}.${col}`)} ELSE ${blank(flat[part])} END`;
};

const CHILDREN = {
  label: 'Children', noun: 'child', nouns: 'children',
  from: 'children c',
  base: 'c.id',
  defaultOrder: 'c.last_name, c.first_name, c.id',
  profile: id => `/child-profile.html?id=${id}`,
  joins: {
    room: 'LEFT JOIN rooms r ON r.id = c.room_id',
    kp:   'LEFT JOIN staff kp ON kp.id = c.key_person_id',
    p1:   parentLateral('p1', 0),
    p2:   parentLateral('p2', 1),
    ec:   EC_COMPLETE,
    e1:   emergencyLateral('e1', 0),
    e2:   emergencyLateral('e2', 1),
    pa:   `LEFT JOIN LATERAL (SELECT count(*) FILTER (WHERE is_active) AS n, max(last_login) AS last_login
                                FROM parent_portal_access WHERE child_id = c.id) pa ON true`,
  },
  joinOrder: ['room', 'kp', 'p1', 'p2', 'ec', 'e1', 'e2', 'pa'],
  who: {
    // "On roll" is the app's own operational definition (src/utils/enrolment.js → operationalChildFilter): active, not 'confirmed'
    // (a place accepted but not yet started) and not 'left', and started. A child who has not started is "Starting soon", never both.
    on_roll:       { label: 'On roll',       sql: `c.is_active = true AND COALESCE(c.enrolment_status, 'attending') NOT IN ('confirmed', 'left') AND (c.start_date IS NULL OR c.start_date <= CURRENT_DATE) AND c.erased_at IS NULL AND COALESCE(c.is_demo, false) = false`, phrase: '' },
    starting_soon: { label: 'Starting soon', sql: `c.erased_at IS NULL AND COALESCE(c.enrolment_status, 'attending') <> 'left' AND COALESCE(c.is_demo, false) = false AND c.start_date > CURRENT_DATE AND c.start_date <= CURRENT_DATE + ($DAYS * INTERVAL '1 day')`, phrase: ' who are starting soon', days: true },
    left:          { label: 'Left',          sql: `c.erased_at IS NULL AND COALESCE(c.is_demo, false) = false AND (c.enrolment_status = 'left' OR (c.leave_date IS NOT NULL AND c.leave_date < CURRENT_DATE))`, phrase: ' who have left' },
    all:           { label: 'Everyone',      sql: `c.erased_at IS NULL AND COALESCE(c.is_demo, false) = false`, phrase: ' (all statuses)' },
  },
  roomFilter: 'c.room_id = $ROOM',
  fields: {
    // ── Child
    wren_number:      { group: 'Child', label: 'Wren number', kind: 'number', sql: 'c.id', always: true },
    child_name:       { group: 'Child', label: 'Child name', sql: `btrim(c.first_name || ' ' || c.last_name)`, gap: 'a name' },
    preferred_name:   { group: 'Child', label: 'Preferred name', sql: blank('c.preferred_name') },
    room:             { group: 'Child', label: 'Room', sql: blank('r.name'), needs: ['room'] },
    date_of_birth:    { group: 'Child', label: 'Date of birth', kind: 'date', sql: ymd('c.date_of_birth'), gap: 'a date of birth' },
    start_date:       { group: 'Child', label: 'Start date', kind: 'date', sql: ymd('c.start_date'), gap: 'a start date' },
    leave_date:       { group: 'Child', label: 'Leave date', kind: 'date', sql: ymd('c.leave_date') },
    key_person:       { group: 'Child', label: 'Key person', sql: blank(`kp.first_name || ' ' || kp.last_name`), needs: ['kp'], gap: 'a key person' },
    status:           { group: 'Child', label: 'Status', sql: blank('c.enrolment_status') },
    address:          { group: 'Child', label: 'Home address', sql: blank(`concat_ws(', ', NULLIF(btrim(c.address_line1), ''), NULLIF(btrim(c.postcode), ''))`), gap: 'a home address' },
    postcode:         { group: 'Child', label: 'Postcode', sql: blank('c.postcode') },
    gp:               { group: 'Child', label: 'GP name', sql: blank('c.gp_name'), gap: 'a GP' },
    gp_phone:         { group: 'Child', label: 'GP phone', sql: blank('c.gp_phone') },
    allergies_recorded: { group: 'Child', label: 'Allergies recorded', sql: `CASE WHEN ${blank('c.allergies')} IS NOT NULL THEN 'Yes' END`, gap: 'an allergies answer' },
    // ── Parent / carer 1, 2
    p1_name:          { group: 'Parent / carer 1', label: 'Parent 1 name',         sql: P(1, 'name'),  needs: ['p1'], gap: 'a parent 1 name' },
    p1_relationship:  { group: 'Parent / carer 1', label: 'Parent 1 relationship', sql: blank('p1.relationship'), needs: ['p1'] },
    p1_email:         { group: 'Parent / carer 1', label: 'Parent 1 email',        sql: P(1, 'email'), needs: ['p1'], gap: 'a parent 1 email' },
    p1_phone:         { group: 'Parent / carer 1', label: 'Parent 1 phone',        sql: P(1, 'phone'), needs: ['p1'], gap: 'a parent 1 phone number' },
    p2_name:          { group: 'Parent / carer 2', label: 'Parent 2 name',         sql: P(2, 'name'),  needs: ['p2'], gap: 'a parent 2 name' },
    p2_relationship:  { group: 'Parent / carer 2', label: 'Parent 2 relationship', sql: blank('p2.relationship'), needs: ['p2'] },
    p2_email:         { group: 'Parent / carer 2', label: 'Parent 2 email',        sql: P(2, 'email'), needs: ['p2'], gap: 'a parent 2 email' },
    p2_phone:         { group: 'Parent / carer 2', label: 'Parent 2 phone',        sql: P(2, 'phone'), needs: ['p2'], gap: 'a parent 2 phone number' },
    // ── Emergency contacts
    emergency_any:    { group: 'Emergency contacts', label: 'Emergency contact (name and phone)', sql: `CASE WHEN ec.n IS NOT NULL THEN ec.n || ' (' || ec.p || ')' END`, needs: ['ec'], gap: 'an emergency contact' },
    emergency_1_name: { group: 'Emergency contacts', label: 'Emergency contact 1 name',         sql: EC(1, 'name'),         needs: ['e1'], gap: 'an emergency contact 1 name' },
    emergency_1_relationship: { group: 'Emergency contacts', label: 'Emergency contact 1 relationship', sql: EC(1, 'relationship'), needs: ['e1'] },
    emergency_1_phone:{ group: 'Emergency contacts', label: 'Emergency contact 1 phone',        sql: EC(1, 'phone'),        needs: ['e1'], gap: 'an emergency contact 1 phone number' },
    emergency_2_name: { group: 'Emergency contacts', label: 'Emergency contact 2 name',         sql: EC(2, 'name'),         needs: ['e2'] },
    emergency_2_phone:{ group: 'Emergency contacts', label: 'Emergency contact 2 phone',        sql: EC(2, 'phone'),        needs: ['e2'] },
    // ── Funding
    funded_hours:     { group: 'Funding', label: 'Funded hours',        kind: 'number', sql: 'c.funded_hours::text' },
    funded_hours_type:{ group: 'Funding', label: 'Funding type',        sql: blank('c.funded_hours_type'), gap: 'a funding type' },
    eligibility_code: { group: 'Funding', label: 'Funding eligibility code', sql: blank('c.eligibility_code'), gap: 'a funding eligibility code' },
    eligibility_expiry:{ group: 'Funding', label: 'Eligibility code expiry', kind: 'date', sql: ymd('c.eligibility_code_expiry') },
    // ── Consents (a recorded "No" is an answer; only a question never answered is missing)
    photo_consent:    { group: 'Consents', label: 'Photo consent', sql: yesNo('c.photo_consent'), gap: 'a photo consent answer' },
    media_consent:    { group: 'Consents', label: 'Media consent', sql: yesNo('c.media_consent'), gap: 'a media consent answer' },
    // ── Portal access
    portal_access:    { group: 'Portal access', label: 'Parent portal access', sql: `CASE WHEN pa.n > 0 THEN 'Active' END`, needs: ['pa'], gap: 'parent portal access' },
    portal_last_login:{ group: 'Portal access', label: 'Last signed in', kind: 'date', sql: ymd('pa.last_login'), needs: ['pa'], gap: 'a sign-in' },
  },
};

// ── staff ────────────────────────────────────────────────────────────────────
const STAFF = {
  label: 'Staff', noun: 'member of staff', nouns: 'staff',
  from: 'staff s',
  base: 's.id',
  defaultOrder: 's.first_name, s.last_name, s.id',
  profile: id => `/staff-profile.html?id=${id}`,
  joins: { room: 'LEFT JOIN rooms r ON r.id = s.room_id' },
  joinOrder: ['room'],
  who: {
    active: { label: 'Current staff', sql: `s.is_active = true AND COALESCE(s.terminated, false) = false`, phrase: '' },
    left:   { label: 'Left',          sql: `(s.is_active = false OR COALESCE(s.terminated, false) = true)`, phrase: ' who have left' },
    all:    { label: 'Everyone',      sql: 'true', phrase: ' (all)' },
  },
  roomFilter: 's.room_id = $ROOM',
  fields: {
    wren_number:   { group: 'Staff', label: 'Wren number', kind: 'number', sql: 's.id', always: true },
    staff_name:    { group: 'Staff', label: 'Name', sql: `btrim(s.first_name || ' ' || s.last_name)`, gap: 'a name' },
    job_title:     { group: 'Staff', label: 'Job title', sql: blank('s.job_title'), gap: 'a job title' },
    role:          { group: 'Staff', label: 'Role', sql: blank('s.role') },
    room:          { group: 'Staff', label: 'Room', sql: blank('r.name'), needs: ['room'], gap: 'a room' },
    email:         { group: 'Contact', label: 'Email', sql: `lower(${blank('s.email')})`, gap: 'an email' },
    phone:         { group: 'Contact', label: 'Phone', sql: blank('s.phone'), gap: 'a phone number' },
    emergency_name:{ group: 'Contact', label: 'Emergency contact name', sql: blank('s.emergency_contact_name'), gap: 'an emergency contact' },
    emergency_phone:{ group: 'Contact', label: 'Emergency contact phone', sql: blank('s.emergency_contact_phone'), gap: 'an emergency contact phone number' },
    employment_type:{ group: 'Contract', label: 'Employment type', sql: blank('s.employment_type') },
    contract_start:{ group: 'Contract', label: 'Contract start', kind: 'date', sql: ymd('s.contract_start'), gap: 'a contract start date' },
    contracted_hours:{ group: 'Contract', label: 'Contracted hours', kind: 'number', sql: 's.contracted_hours::text', gap: 'contracted hours' },
    dbs_expiry:    { group: 'Compliance', label: 'DBS expiry', kind: 'date', sql: ymd('s.dbs_expiry'), gap: 'a DBS expiry date' },
    right_to_work: { group: 'Compliance', label: 'Right to work status', sql: blank('s.right_to_work_status'), gap: 'a right-to-work status' },
    qualification_level: { group: 'Compliance', label: 'Qualification level', sql: blank('s.qualification_level'), gap: 'a qualification level' },
    first_aider:   { group: 'Compliance', label: 'First aider', sql: yesNo('s.is_first_aider') },
    // ── Pay: refused/stripped for anyone src/lib/capabilities.js does not let see it. Never widen this list casually.
    annual_salary: { group: 'Pay', label: 'Annual salary', kind: 'number', sql: 's.annual_salary::text', pay: true, gap: 'an annual salary' },
    hourly_rate:   { group: 'Pay', label: 'Hourly rate',   kind: 'number', sql: 's.hourly_rate::text',   pay: true, gap: 'an hourly rate' },
  },
};

// ── contacts ─────────────────────────────────────────────────────────────────
const CONTACTS = {
  label: 'Contacts', noun: 'contact', nouns: 'contacts',
  from: 'contacts ct',
  base: 'ct.id',
  defaultOrder: 'ct.full_name, ct.id',
  profile: null,
  joins: {
    kids: `LEFT JOIN LATERAL (SELECT count(*)::int AS n, string_agg(btrim(k.first_name || ' ' || k.last_name), ', ' ORDER BY k.first_name, k.id) AS names
                               FROM children k WHERE k.id = ANY(ct.child_ids) AND k.erased_at IS NULL) kids ON true`,
    login: `LEFT JOIN LATERAL (SELECT count(*)::int AS n FROM parent_portal_access pa WHERE lower(pa.email) = lower(ct.primary_email) AND pa.is_active) login ON true`,
  },
  joinOrder: ['kids', 'login'],
  who: {
    enrolled:     { label: 'Enrolled families', sql: `ct.status = 'enrolled' AND ct.archived_at IS NULL`, phrase: '' },
    enquirer:     { label: 'Enquiries',         sql: `ct.status = 'enquirer' AND ct.archived_at IS NULL`, phrase: ' who are enquiries' },
    waiting_list: { label: 'Waiting list',      sql: `ct.status = 'waiting_list' AND ct.archived_at IS NULL`, phrase: ' on the waiting list' },
    leaver:       { label: 'Leavers',           sql: `ct.status = 'leaver' AND ct.archived_at IS NULL`, phrase: ' who have left' },
    all:          { label: 'Everyone',          sql: `ct.archived_at IS NULL`, phrase: ' (all statuses)' },
  },
  roomFilter: null,
  fields: {
    wren_number:  { group: 'Contact', label: 'Contact number', kind: 'number', sql: 'ct.id', always: true },
    contact_name: { group: 'Contact', label: 'Name', sql: blank('ct.full_name'), gap: 'a name' },
    relationship: { group: 'Contact', label: 'Relationship', sql: blank('ct.relationship'), gap: 'a relationship' },
    email:        { group: 'Contact', label: 'Email', sql: `lower(${blank('ct.primary_email')})`, gap: 'an email' },
    phone:        { group: 'Contact', label: 'Phone', sql: blank('ct.primary_phone'), gap: 'a phone number' },
    status:       { group: 'Contact', label: 'Status', sql: blank('ct.status') },
    emergency:    { group: 'Contact', label: 'Emergency contact', sql: `CASE WHEN ct.is_emergency_contact THEN 'Yes' END` },
    children:     { group: 'Children', label: 'Children', sql: blank('kids.names'), needs: ['kids'], gap: 'a child' },
    children_count:{ group: 'Children', label: 'Number of children', kind: 'number', sql: 'kids.n::text', needs: ['kids'] },
    portal_login: { group: 'Access', label: 'Can sign in to the parents app', sql: `CASE WHEN login.n > 0 THEN 'Yes' END`, needs: ['login'], gap: 'a parents-app login' },
    source:       { group: 'Access', label: 'Where we got them', sql: blank('ct.source') },
  },
};

const SUBJECTS = { children: CHILDREN, staff: STAFF, contacts: CONTACTS };
const MAX_ROWS = 5000;
const MAX_FIELDS = 40;

// ── validation ───────────────────────────────────────────────────────────────
class ReportError extends Error {
  constructor(status, error, extra) { super(error); this.status = status; this.error = error; Object.assign(this, extra || {}); }
}

const defaultWho = subject => Object.keys(SUBJECTS[subject].who)[0];

/**
 * Turn whatever was posted into a definition the compiler can trust — or throw a ReportError saying what was wrong.
 * `canPay` is the answer from canViewSalaries(): without it a pay field is REFUSED when a definition is being written or
 * run for the first time, and STRIPPED (with a note) when an existing saved report is opened, so one manager's saved
 * report never becomes another manager's way to read pay.
 */
function normaliseDefinition(raw, { canPay = false, stripPay = false } = {}) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const subject = String(d.subject || 'children');
  const S = SUBJECTS[subject];
  if (!S) throw new ReportError(400, `Unknown subject "${subject}".`);

  if (!Array.isArray(d.fields) || !d.fields.length) throw new ReportError(400, 'Choose at least one field.');
  if (d.fields.length > MAX_FIELDS) throw new ReportError(400, `A report can have at most ${MAX_FIELDS} fields.`);
  const seen = new Set(), fields = [], hidden = [];
  for (const k of d.fields) {
    const f = S.fields[k];
    if (!f) throw new ReportError(400, `Unknown field "${String(k).slice(0, 40)}".`);
    if (seen.has(k)) continue;
    seen.add(k);
    if (f.pay && !canPay) {
      if (stripPay) { hidden.push(f.label); continue; }
      throw new ReportError(403, 'Pay fields are only available to people who can see pay.', { code: 'salary_view_forbidden' });
    }
    fields.push(k);
  }
  if (!fields.length) throw new ReportError(400, 'None of those fields are available to you.');

  const who = d.who == null || d.who === '' ? defaultWho(subject) : String(d.who);
  if (!S.who[who]) throw new ReportError(400, `Unknown "who to include": ${String(who).slice(0, 30)}.`);
  const out = { subject, fields, who };
  if (S.who[who].days) {
    const days = d.days == null || d.days === '' ? 90 : Number(d.days);
    if (!Number.isInteger(days) || days < 1 || days > 730) throw new ReportError(400, 'Days must be a whole number from 1 to 730.');
    out.days = days;
  }
  if (d.room_id != null && d.room_id !== '') {
    const room = Number(d.room_id);
    if (!Number.isInteger(room) || room < 1) throw new ReportError(400, 'That room was not understood.');
    if (!S.roomFilter) throw new ReportError(400, 'This subject cannot be filtered by room.');
    out.room_id = room;
  }

  const m = d.missing;
  if (m && typeof m === 'object' && Array.isArray(m.fields) && m.fields.length) {
    const mode = m.mode === 'all' ? 'all' : 'any';
    const mf = [];
    for (const k of m.fields) {
      const f = S.fields[k];
      if (!f) throw new ReportError(400, `Unknown field "${String(k).slice(0, 40)}" in the missing check.`);
      if (f.always) continue;                                             // an id is never missing; ignoring it beats a confusing error
      if (f.pay && !canPay) { if (stripPay) { hidden.push(f.label + ' (missing check)'); continue; } throw new ReportError(403, 'Pay fields are only available to people who can see pay.', { code: 'salary_view_forbidden' }); }
      if (!mf.includes(k)) mf.push(k);
    }
    if (mf.length) out.missing = { mode, fields: mf };
  }

  if (d.sort && typeof d.sort === 'object' && d.sort.field) {
    if (!fields.includes(d.sort.field)) throw new ReportError(400, 'You can only sort by a field that is in the report.');
    out.sort = { field: d.sort.field, dir: d.sort.dir === 'desc' ? 'desc' : 'asc' };
  }
  return { def: out, hidden };
}

// ── compilation ──────────────────────────────────────────────────────────────
const missingPredicate = (f) => `(${f.sql}) IS NULL OR btrim((${f.sql})::text) = ''`;

function compile(def) {
  const S = SUBJECTS[def.subject];
  const params = [];
  const p = v => { params.push(v); return `$${params.length}`; };

  const whoDef = S.who[def.who];
  let whoSql = whoDef.sql;
  if (whoDef.days) whoSql = whoSql.replace('$DAYS', p(def.days));
  let filterSql = `(${whoSql})`;
  if (def.room_id) filterSql += ` AND ${S.roomFilter.replace('$ROOM', p(def.room_id))}`;
  const populationParams = params.slice();
  const populationSql = `SELECT count(*)::int AS n FROM ${S.from} WHERE ${filterSql}`;

  const needed = new Set();
  const useFields = [...def.fields];
  for (const k of def.fields) (S.fields[k].needs || []).forEach(n => needed.add(n));
  if (def.missing) for (const k of def.missing.fields) (S.fields[k].needs || []).forEach(n => needed.add(n));

  let where = filterSql;
  if (def.missing) {
    const preds = def.missing.fields.map(k => `(${missingPredicate(S.fields[k])})`);
    where += ` AND (${preds.join(def.missing.mode === 'all' ? ' AND ' : ' OR ')})`;
  }

  const select = useFields.map((k, i) => `${S.fields[k].sql} AS c${i}`).join(',\n       ');
  const joins = S.joinOrder.filter(n => needed.has(n)).map(n => S.joins[n]).join('\n');
  let order = S.defaultOrder;
  if (def.sort) {
    const i = useFields.indexOf(def.sort.field);
    order = `c${i} ${def.sort.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, ${S.base}`;
  }
  const text = `SELECT ${S.base} AS _id, count(*) OVER() AS _total,\n       ${select}\n  FROM ${S.from}\n${joins}\n WHERE ${where}\n ORDER BY ${order}\n LIMIT ${MAX_ROWS}`;
  return { text, params, populationText: populationSql, populationParams, columns: useFields.map(k => ({ key: k, label: S.fields[k].label, kind: S.fields[k].kind || 'text', group: S.fields[k].group })) };
}

// ── the sentence at the top ──────────────────────────────────────────────────
function joinList(list, word) {
  if (list.length <= 1) return list[0] || '';
  return list.slice(0, -1).join(', ') + ` ${word} ` + list[list.length - 1];
}
function describe(def, matched, population) {
  const S = SUBJECTS[def.subject];
  const phrase = S.who[def.who].phrase;
  const nouns = S.nouns;
  if (!def.missing) {
    return `${matched} ${matched === 1 ? S.noun : nouns}${phrase}`;
  }
  const gaps = def.missing.fields.map(k => S.fields[k].gap || `a ${S.fields[k].label.toLowerCase()}`);
  const list = joinList(gaps, def.missing.mode === 'all' ? 'and' : 'or');
  if (matched === 0) return `None of the ${population} ${nouns}${phrase} are missing ${list}.`;
  return `${matched} of ${population} ${nouns}${phrase} ${matched === 1 ? 'is' : 'are'} missing ${list}.`;
}

// ── run ──────────────────────────────────────────────────────────────────────
async function runReport(db, def) {
  const c = compile(def);
  const { rows } = await db.query(c.text, c.params);
  const pop = (await db.query(c.populationText, c.populationParams)).rows[0].n;
  const S = SUBJECTS[def.subject];
  const matched = rows.length ? Number(rows[0]._total) : 0;
  return {
    subject: def.subject,
    columns: c.columns,
    rows: rows.map(r => c.columns.map((_, i) => (r[`c${i}`] == null ? null : String(r[`c${i}`])))),
    ids: rows.map(r => r._id),
    profile: S.profile ? rows.map(r => S.profile(r._id)) : null,
    matched, population: pop,
    truncated: matched > rows.length,
    summary: describe(def, matched, pop),
  };
}

// ── CSV, written by hand ─────────────────────────────────────────────────────
// RFC 4180: fields with a comma, a quote or a line break are quoted, quotes are doubled, lines end CRLF. A UTF-8 BOM
// leads the file so Excel reads "Zoë" and not "ZoÃ«".
//
// FORMULA INJECTION: a parent chooses what their own name says, and a manager opens this in a spreadsheet. A value that
// starts with = @ TAB or CR, or with + / - followed by something that is not a digit, space or bracket, is prefixed with
// an apostrophe so it is text and never a formula. "+44 7700 900123" and "-5" are left alone — a phone number must
// survive the export.
function csvSafe(v) {
  let s = v == null ? '' : String(v);
  if (/^[=@\t\r]/.test(s) || /^[+\-][^0-9\s(]/.test(s)) s = `'${s}`;
  return s;
}
function csvField(v) {
  const s = csvSafe(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(columns, rows) {
  const lines = [columns.map(c => csvField(c.label)).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ── the catalogue the page draws its checkboxes from ─────────────────────────
function catalogue(canPay) {
  const out = {};
  for (const [key, S] of Object.entries(SUBJECTS)) {
    const groups = new Map();
    for (const [fk, f] of Object.entries(S.fields)) {
      if (f.pay && !canPay) continue;
      if (!groups.has(f.group)) groups.set(f.group, []);
      groups.get(f.group).push({ key: fk, label: f.label, kind: f.kind || 'text', pay: !!f.pay, always: !!f.always });
    }
    out[key] = {
      label: S.label, noun: S.noun, nouns: S.nouns, roomFilter: !!S.roomFilter,
      who: Object.entries(S.who).map(([k, w]) => ({ key: k, label: w.label, days: !!w.days })),
      groups: [...groups.entries()].map(([label, fields]) => ({ label, fields })),
    };
  }
  return out;
}

module.exports = { SUBJECTS, MAX_ROWS, ReportError, normaliseDefinition, compile, describe, runReport, toCsv, csvField, csvSafe, catalogue, missingPredicate };
