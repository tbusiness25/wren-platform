'use strict';
/**
 * pii-registry.js — b402 (2026-10-06).
 *
 * One place that decides whether a (table, column) pair is personal data, and
 * which of six classes it belongs to. Pure and synchronous — no DB, no schema
 * awareness beyond the names it is given — so the same function classifies a
 * live information_schema row (scripts/pii-inventory.js) and a report-builder
 * field key or a route's own row-object key (src/lib/anonymise.js) identically.
 *
 * WHY CLASSES, NOT A BOOLEAN
 * "Is PII" isn't enough to know what anonymising it should DO — a name becomes
 * a pseudonym, a phone number is removed outright, a DOB is coarsened. Six
 * classes line up with six different transforms in anonymise.js.
 *
 * FALSE POSITIVES / NEGATIVES
 * Wren has 600+ tables. Pattern matching on column names will always be wrong
 * somewhere — "room_name" is not personal data, "staff.name" (if it exists) is.
 * OVERRIDES below is the hand-kept correction list; extend it as the inventory
 * (scripts/pii-inventory.js) surfaces a wrong answer. Table-qualified entries
 * win over a bare column-name entry, which wins over the pattern rules.
 */

const PII_CLASSES = Object.freeze([
  'identifier', 'dob', 'gov_id', 'financial', 'special_category', 'free_text',
]);

// table.column (lowercase) -> forced class, or null to force "not PII".
// Keys are literal, not patterns. Add to this as the inventory finds a miss.
const OVERRIDES = Object.freeze({
  // known false positives — configuration/catalogue "name" fields, not people
  'rooms.name': null,
  'menu_items.name': null,
  'menu_groups.name': null,
  'modules.name': null,
  'tag_definitions.name': null,
  'resources.name': null,
  'courses.name': null,
  'custom_reports.name': null,
  'action_plans.name': null,
  'policies.name': null,
  'handbook.name': null,
  'document_workspaces.name': null,
  'funding_terms.name': null,
  'settings.name': null,
  'school_terms.name': null,
  'curriculum_activities.name': null,
  'outings.name': null,
  'weekly_plans.name': null,
  'survey.name': null,
  'newsletters.name': null,

  // known false negatives — plain "name"/"full_name" columns that ARE a person,
  // kept explicit so the bare-"name" rule below doesn't have to guess for them
  'children.name': 'identifier',
  'staff.name': 'identifier',
  'contacts.name': 'identifier',
  'contacts.full_name': 'identifier',

  // free text that carries PII inline, not a clean field — see memory
  // reference_payments_eylog_ref_is_bank_text_pii.md: legacy rows hold
  // payer/child names in what looks like a bank reference string.
  'payments.eylog_ref': 'free_text',

  // found by scripts/pii-inventory.js on wren_dev (2026-10-06):
  // an NFC fob UID, not a bank card — and per memory
  // reference_fob_uid_is_a_credential_b310.md it's stored hashed, not raw.
  'door_events.card_no': null,
  // an FK to a payment_settings row (integer), not an account number.
  'finance_payments.bank_account_id': null,

  // src/lib/report-builder.js exposes its own short field-KEY vocabulary,
  // independent of the real DB column names (e.g. the real column is
  // children.parent_1_name; the report-builder field key for the same value
  // is "p1_name"). classifyColumn(subject, fieldKey) is called with the
  // subject as the "table", so these need their own entries — found by
  // scripts/anonymise-selftest.js-style probing against the live field list,
  // not by the DB-column-only inventory, which cannot see them.
  'children.key_person':       'identifier', // a staff member's name
  'children.gp':                'identifier', // "GP name", despite the bare key
  'children.p1_name':            'identifier',
  'children.p2_name':            'identifier',
  'children.emergency_any':      'identifier', // combined "name (phone)" string
  'children.emergency_1_name':   'identifier',
  'children.emergency_2_name':   'identifier',
  'staff.emergency_name':        'identifier',
  'contacts.children':           'identifier', // a list of linked children's names
});

// Tables where a bare "name" / "full_name" column names a PERSON. Everywhere
// else a bare "name" column is assumed to name a thing (a room, a course, a
// saved report) and is left alone, per the override list above.
const PERSON_TABLES = new Set([
  'children', 'staff', 'contacts', 'parents', 'guardians', 'emergency_contacts',
  'enquiries', 'waiting_list', 'sen_register', 'staff_fobs',
]);

// `\bword\b` does NOT mean "a whole snake_case token" — underscore is a \w
// character, so `\bemail\b` fails to match inside "parent_1_email" (there is
// no \w/non-\w transition either side of that '_'). tok() matches a token
// delimited by underscore-or-string-edge instead, which is what every column
// name in this codebase actually uses.
const tok = (w) => `(?:^|_)${w}(?:_|$)`;

// Checked in order — special_category and gov_id/financial are the highest-risk
// classes so they win over a column that also happens to look like a name.
const RULES = [
  { class: 'special_category', re: new RegExp(`allerg|medic(?:al|ine)|safeguard|diagnos|religio|ethnic|${tok('sen')}`, 'i') },
  { class: 'gov_id', re: new RegExp(`ni_number|national_insurance|nhs_number|passport_no|passport_number|dbs_number|dbs_cert|${tok('nino')}|${tok('upn')}`, 'i') },
  { class: 'financial', re: /account_no|account_number|sort_code|iban|card_number|card_no|mandate_ref|bank_account|bank_sort|bank_details/i },
  { class: 'dob', re: new RegExp(`date_of_birth|${tok('dob')}`, 'i') },
  {
    class: 'identifier',
    re: new RegExp(
      `first_name|last_name|middle_name|preferred_name|given_name|family_name|maiden_name|child_name|parent_?\\d?_?name|staff_name|contact_name|guardian_name|emergency_contact_\\d_name|next_of_kin_name|display_name|typed_name|signatory_name|submitted_by_name|created_by_name|updated_by_name|reported_by_name|supervisor_name|room_leader_name|email|phone|mobile|address|postcode|post_code|${tok('tel')}`,
      'i',
    ),
  },
  { class: 'free_text', re: new RegExp(`observation_text|statement_text|${tok('notes?')}|${tok('body')}|${tok('description')}|${tok('comment')}|${tok('narrative')}|${tok('summary')}`, 'i') },
];

function override(table, column) {
  const key = `${table}.${column}`;
  if (key in OVERRIDES) return OVERRIDES[key];
  return undefined; // no override on record
}

/**
 * @param {string} table  lowercase table name (or report-builder subject key —
 *                         field keys there follow the same naming convention)
 * @param {string} column lowercase column / field key
 * @returns {string|null} one of PII_CLASSES, or null if not personal data
 */
function classifyColumn(table, column) {
  const t = String(table || '').toLowerCase();
  const c = String(column || '').toLowerCase();

  const forced = override(t, c);
  if (forced !== undefined) return forced;

  if (c === 'name' || c === 'full_name') {
    return PERSON_TABLES.has(t) ? 'identifier' : null;
  }

  for (const rule of RULES) {
    if (rule.re.test(c)) return rule.class;
  }
  return null;
}

module.exports = { PII_CLASSES, OVERRIDES, PERSON_TABLES, classifyColumn };
