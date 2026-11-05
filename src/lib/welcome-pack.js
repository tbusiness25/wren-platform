'use strict';
// b422 (2026-10-08) — Registration welcome pack.
//
// Toby/the office manager: when a family moves from "Offer accepted" to "Registered", send a
// confirmation email, get them signed up to Wren, the red book, their details,
// policies, permissions, funding declaration and allergy action plan — and let
// Settings customise the text and attachments.
//
// THE CHECKLIST IS NEVER STORED. Every item already lives in a real table
// (parent_portal_access, onboarding_invites, child_about_me, child_consents,
// child_funding, parent_policy_acknowledgments, person_documents,
// gocardless_mandates) — the same "derive readiness live" shape as
// forms-register.js and admin.js's payment_setup. A stored "welcome pack
// progress" column would just be a second, driftable copy of those tables.
// Only the settings (template + which items apply + attachments) and a log of
// who sent what, when, are real rows — see migrations/b422.

const PERMS = require('./child-permissions');

const ITEM_DEFS = [
  { key: 'app_signup',   label: 'Signed up to the Parents app' },
  { key: 'family_details', label: 'Child & family details complete' },
  { key: 'redbook',      label: 'Red book / immunisations' },
  { key: 'about_me',     label: 'All about me' },
  { key: 'policies',     label: 'Policies & procedures read and signed' },
  { key: 'consents',     label: 'Permissions / consents set' },
  { key: 'funding',      label: 'Funding declaration' },
  { key: 'allergy_plan', label: 'Allergy action plan' },
  { key: 'payment',      label: 'Direct Debit / payment set-up' },
];

const MERGE_FIELDS = [
  { key: 'parent_name',       label: 'Parent name' },
  { key: 'child_first_name',  label: "Child's first name" },
  { key: 'child_name',        label: "Child's full name" },
  { key: 'start_date',        label: 'Start date' },
  { key: 'nursery_name',      label: 'Nursery name' },
  { key: 'signup_link',       label: 'Parents app sign-up link' },
  { key: 'checklist_list',    label: 'The checklist, as a list (HTML)' },
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function familyEmails(child) {
  return [...new Set([child.parent_1_email, child.parent_2_email, child.primary_contact_email]
    .map(e => (e || '').trim().toLowerCase()).filter(Boolean))];
}

/** Computes every checklist item live from the tables that already hold the fact. */
async function computeChecklist(db, child, checklistConfig) {
  const childId = child.id;
  const emails = familyEmails(child);
  const items = [];

  const { rows: accessRows } = await db.query(
    `SELECT is_active, last_login FROM parent_portal_access WHERE child_id=$1`, [childId]);
  const signedIn = accessRows.some(r => r.is_active && r.last_login);
  const accessGranted = accessRows.some(r => r.is_active);
  items.push({
    key: 'app_signup', label: 'Signed up to the Parents app', applicable: true, done: signedIn,
    detail: signedIn ? 'Signed in' : (accessGranted ? 'Access granted — not signed in yet' : 'No portal access yet'),
    parentPath: null,
  });

  // b428 — this used to read the status of a registration-form invite, which
  // is wrong for a family that reaches Registered without one (e.g. "Confirm
  // enrol" from the Waiting list never sends a form invite at all) and stays
  // stuck "not done" forever even once the family's real details are on file.
  // Read the actual record instead: the child row's own parent/emergency
  // contact fields (every registration path — the self-service form AND a
  // manual Roost add — writes these columns), with `contacts` (the b342
  // canonical store, kept in sync with these columns) as a fallback for a
  // family whose details were entered there first.
  const { rows: contactRows } = await db.query(
    `SELECT is_emergency_contact FROM contacts WHERE $1 = ANY(child_ids)`, [childId]).catch(() => ({ rows: [] }));
  const hasContactParent = contactRows.some(r => !r.is_emergency_contact);
  const hasContactEmergency = contactRows.some(r => r.is_emergency_contact);
  const hasParentDetails = !!(child.parent_1_name && (child.parent_1_email || child.parent_1_phone)) || hasContactParent;
  const hasEmergencyDetails = !!(child.emergency_contact_1_name && child.emergency_contact_1_phone) || hasContactEmergency;
  const detailsDone = hasParentDetails && hasEmergencyDetails && !!child.date_of_birth;
  items.push({
    key: 'family_details', label: 'Child & family details complete', applicable: true, done: detailsDone,
    detail: detailsDone ? 'Parent and emergency contact details on file' : 'Parent or emergency contact details missing',
    parentPath: '/welcome/details',
  });

  const { rows: rbRows } = await db.query(
    `SELECT is_up_to_date FROM child_redbook_status WHERE child_id=$1`, [childId]);
  const { rows: rbDocRows } = await db.query(
    `SELECT 1 FROM person_documents WHERE subject_type='child' AND subject_id=$1
       AND category='red_book' AND deleted=false LIMIT 1`, [childId]);
  const redbookDone = (rbRows[0] && rbRows[0].is_up_to_date !== null) || rbDocRows.length > 0;
  items.push({
    key: 'redbook', label: 'Red book / immunisations', applicable: true, done: redbookDone,
    detail: redbookDone ? 'Confirmed / uploaded' : 'Not yet confirmed', parentPath: '/welcome/redbook',
  });

  const { rows: aboutRows } = await db.query(
    `SELECT completed_at, food_allergies FROM child_about_me WHERE child_id=$1`, [childId]);
  const about = aboutRows[0] || null;
  const aboutDone = !!(about && about.completed_at);
  items.push({
    key: 'about_me', label: 'All about me', applicable: true, done: aboutDone,
    detail: aboutDone ? 'Completed' : 'Not completed', parentPath: '/welcome/details',
  });

  const { rows: reqPolicies } = await db.query(
    `SELECT id, version FROM policies WHERE is_active=true AND parent_facing=true AND requires_parent_signature=true`);
  let policiesDone = true, policiesOutstanding = 0;
  if (reqPolicies.length) {
    if (!emails.length) { policiesDone = false; policiesOutstanding = reqPolicies.length; }
    else {
      const { rows: ackRows } = await db.query(
        `SELECT policy_id, policy_version FROM parent_policy_acknowledgments
          WHERE child_id=$1 OR parent_email = ANY($2::text[])`, [childId, emails]);
      const ackSet = new Set(ackRows.map(r => r.policy_id + ':' + r.policy_version));
      policiesOutstanding = reqPolicies.filter(p => !ackSet.has(p.id + ':' + p.version)).length;
      policiesDone = policiesOutstanding === 0;
    }
  }
  items.push({
    key: 'policies', label: 'Policies & procedures read and signed',
    applicable: reqPolicies.length > 0, done: policiesDone,
    detail: reqPolicies.length === 0 ? 'No signature-required policies' : (policiesDone ? 'All signed' : `${policiesOutstanding} outstanding`),
    parentPath: '/welcome/policies',
  });

  const settable = PERMS.CONSENT_TYPES.filter(t => PERMS.familyCanSet(t.key));
  let consentsOutstanding = 0;
  if (settable.length) {
    const { rows: consentRows } = await db.query(
      `SELECT consent_type FROM child_consents WHERE child_id=$1`, [childId]);
    const have = new Set(consentRows.map(r => r.consent_type));
    consentsOutstanding = settable.filter(t => !have.has(t.key)).length;
  }
  items.push({
    key: 'consents', label: 'Permissions / consents set', applicable: settable.length > 0, done: consentsOutstanding === 0,
    detail: consentsOutstanding === 0 ? 'All set' : `${consentsOutstanding} not yet set`, parentPath: '/welcome/consents',
  });

  const { rows: fundingRows } = await db.query(
    `SELECT declaration_signed FROM child_funding
      WHERE child_id=$1 AND funding_type IS NOT NULL AND funding_type <> 'none'
      ORDER BY term_id DESC LIMIT 1`, [childId]).catch(() => ({ rows: [] }));
  const funding = fundingRows[0] || null;
  items.push({
    key: 'funding', label: 'Funding declaration', applicable: !!funding, done: !!(funding && funding.declaration_signed),
    detail: !funding ? 'Not funded' : (funding.declaration_signed ? 'Signed' : 'Not signed yet'), parentPath: '/welcome/declaration',
  });

  const hasAllergy = !!((child.allergies && child.allergies.trim()) || (about && about.food_allergies && about.food_allergies.trim()));
  const { rows: allergyDocRows } = await db.query(
    `SELECT 1 FROM person_documents WHERE subject_type='child' AND subject_id=$1
       AND category='allergy_doc' AND deleted=false LIMIT 1`, [childId]);
  items.push({
    key: 'allergy_plan', label: 'Allergy action plan', applicable: hasAllergy, done: allergyDocRows.length > 0,
    detail: !hasAllergy ? 'No allergy recorded' : (allergyDocRows.length ? 'On file' : 'Not uploaded yet'), parentPath: '/welcome/documents',
  });

  let mandateRows = [];
  if (emails.length) {
    ({ rows: mandateRows } = await db.query(
      `SELECT 1 FROM gocardless_mandates
        WHERE (child_id=$1 OR bill_payer_email = ANY($2::text[])) AND status='active' LIMIT 1`,
      [childId, emails]).catch(() => ({ rows: [] })));
  }
  items.push({
    key: 'payment', label: 'Direct Debit / payment set-up', applicable: true, done: mandateRows.length > 0,
    detail: mandateRows.length ? 'Active mandate' : 'Not set up', parentPath: '/welcome/dd-setup',
  });

  const cfg = checklistConfig || {};
  // b429 — 'payment' is opt-IN, not opt-out: prod holds only 3 ACTIVE
  // GoCardless mandates (a prior count of 32 wasn't filtering by status), so
  // on the DEFAULT item set this would sit outstanding for almost every
  // family forever. Still available — a manager can switch it on in Settings.
  const DEFAULT_OFF = new Set(['payment']);
  const effective = items.filter(it => DEFAULT_OFF.has(it.key) ? cfg[it.key] === true : cfg[it.key] !== false);
  const applicable = effective.filter(it => it.applicable);
  const done = applicable.filter(it => it.done).length;

  return { items: effective, progress: { done, total: applicable.length } };
}

function checklistToHtml(items) {
  const applicable = items.filter(it => it.applicable);
  if (!applicable.length) return '';
  return '<p>Here is what is still left to do:</p><ul>'
    + applicable.map(it => `<li>${esc(it.label)}${it.done ? ' ✓' : ''}</li>`).join('')
    + '</ul>';
}

function renderTemplate(template, fields) {
  return String(template || '').replace(/\{\{(\w+)\}\}/g, (m, key) => (fields[key] != null ? String(fields[key]) : ''));
}

module.exports = { ITEM_DEFS, MERGE_FIELDS, computeChecklist, checklistToHtml, renderTemplate, familyEmails, esc };
