'use strict';
/**
 * policy.js — b348: the one place that says what a cloud model may and may not see.
 *
 * Wren Chat talks to Gemini. Google is a processor here, not the nursery, and the nursery's
 * rule (Toby, 2026-09-21) is that a child's name, a parent's name or address, an observation,
 * a diary entry, a medicine record, a safeguarding note or a message never reaches it.
 * That rule is enforced in CODE, in three places, none of which is a prompt:
 *
 *   1. the query layer (query-layer.js) — only allow-listed, parameterised, aggregate queries;
 *   2. the redaction gate (redact.js)   — everything that leaves is scrubbed, and fails closed;
 *   3. the call log (wren_chat_calls)   — what left, when, and what class of data it held.
 *
 * Everything those three share — the vocabulary of protected tables and columns, the limits —
 * is here, so a change to "what is protected" is one edit and one review.
 */

/** What an outbound payload can be made of. Logged per call. There is deliberately no class
 *  for child rows, parent rows, observations, diary, medicine, safeguarding or messages:
 *  nothing in this module can put them in a payload. */
const DATA_CLASSES = Object.freeze({
  system_prompt: 'Wren Chat instructions (static text)',
  user_question: "The person's question, after redaction",
  history:       'Earlier turns of this conversation, after redaction',
  docs:          'Passages from the Wren documentation',
  schema:        'Table and column NAMES (never values)',
  aggregate:     'Counts / sums / averages from an allow-listed metric',
});

/** Tables whose rows are about an identifiable person. A metric may read them only inside an
 *  aggregate; nothing may ever return a row from them. Matched against the bare table name. */
const PROTECTED_TABLE_RE = /^(children|child_.*|contacts|parent.*|family_.*|enquiries|waiting_list|observations?|eylog_observations|daily_diary|diary_entries|diary_.*|safeguarding.*|medicine.*|messages?|message_.*|threads?|thread_messages|incidents?|sen_.*|voice_notes|staff|staff_.*|absence_requests|mandatory_training|cpd_records|supervisions|person_documents|invoices?|payments?|payroll.*|xero_.*|bank_.*|transcriptions|attendance.*|rota.*|sleep.*|food_.*|nappy.*|leave.*|clock.*|payment_.*|finance_.*|v_allocation_periods|v_money_on_account)$/;

/** Tables a metric may read that hold no personal data (settings-like or reference tables). */
const OPEN_TABLES = Object.freeze(['rooms', 'funding_terms', 'school_terms']);
// b365 added payment_*, finance_* and the two allocation views to the PROTECTED list above
// rather than here. finance_pnl_lines holds no personal data at all, but an allocation joins
// a payment to a child, and classifying the family of tables one way keeps the rule sayable:
// money is aggregate-only. Nothing is lost — every b365 metric is an aggregate anyway.
// `invoices` and `settings` are deliberately NOT here: an invoice row is a per-child, per-payer
// financial record (protected, aggregate-only), and `settings` can hold credentials. A table that
// is in neither list is refused as unclassified, so a new table has to be classified on purpose.

/** Column names that identify a person, a place, or a personal record. A metric's SQL must not
 *  mention any of these anywhere (except through a vetted snippet). Lower-case. */
const BANNED_COLUMNS = Object.freeze(new Set([
  // names
  'first_name', 'last_name', 'middle_name', 'preferred_name', 'preferred_forename', 'preferred_surname',
  'full_name', 'child_first_name', 'child_last_name', 'parent_name', 'parent_1_name', 'parent_2_name',
  'emergency_contact_1_name', 'emergency_contact_2_name', 'emergency_contact_name', 'social_worker_name',
  'gp_name', 'witness_name', 'author_name', 'logged_by_name', 'subject_other_name', 'name_of_child',
  'medicine_name', 'prescriber_name', 'collected_by', 'staff_name', 'display_name_full',
  // contact + address
  'email', 'primary_email', 'primary_contact_email', 'parent_1_email', 'parent_2_email', 'bill_payer_email',
  'phone', 'primary_phone', 'secondary_phone', 'parent_1_phone', 'parent_2_phone', 'telegram_chat_id',
  'emergency_contact_1_phone', 'emergency_contact_2_phone', 'emergency_contact_phone', 'gp_phone',
  'social_worker_phone', 'address_line1', 'address_line2', 'postcode',
  // ids that name a person
  'nhs_number', 'upn', 'ni_number', 'dbs_number', 'collection_password', 'tax_code', 'payroll_reference',
  'pin_hash', 'totp_secret', 'date_of_birth', 'child_dob', 'eylog_ref', 'eylog_child_id', 'tfc_reference',
  'tfc_payment_reference', 'stripe_session_id', 'gc_payment_id', 'xero_invoice_id',
  // free text about a person
  'notes', 'private_notes', 'description', 'observation_text', 'analysis', 'next_steps', 'medical_notes',
  'allergies', 'allergen_notes', 'dietary_requirements', 'sen_notes', 'sen_needs', 'sen_provisions',
  'dsl_notes', 'supervision_notes', 'staff_notes', 'body', 'content', 'comment', 'message', 'subject',
  'wren_thoughts', 'ai_summary_cache', 'injury_description', 'follow_up_notes', 'immediate_action',
  'court_order_details', 'leave_reason_notes', 'side_effects_noted', 'reason', 'title',
]));

/** Aggregate functions that hand a raw value back (a MIN of a name is the name). Never allowed. */
const RAW_VALUE_FUNCTIONS = Object.freeze(['min', 'max', 'string_agg', 'array_agg', 'json_agg', 'jsonb_agg',
  'json_object_agg', 'jsonb_object_agg', 'mode', 'first_value', 'last_value', 'any_value']);

/** `*_id` columns that are NOT a person, so grouping by them is fine. Anything else ending in _id
 *  in a dimension position would give one row per child/staff member. */
const SAFE_ID_COLUMNS = Object.freeze(new Set(['room_id', 'term_id']));

/** How small a group may be before its number is withheld. A "1" in a cell of safeguarding
 *  concerns is one identifiable child, however anonymously it is labelled. */
const MIN_CELL = Object.freeze({ normal: 0, sensitive: 3, special: 5 });

const LIMITS = Object.freeze({
  maxQuestionChars: 2000,
  maxHistoryTurns: 8,
  maxHistoryTurnChars: 4000,
  maxToolRounds: 3,
  maxRows: 200,                 // rows a metric may return
  maxLabelChars: 48,            // a dimension label longer than this is not a label
  statementTimeoutMs: 5000,
  callTimeoutMs: 45000,
  turnDeadlineMs: 50000,        // the whole turn (all tool rounds); nginx cuts a request at 60 s
  maxDocChars: 6000,            // grounding: documentation
  maxSchemaChars: 4500,         // grounding: schema digest
});

const CURRENCY_NOTE = 'USD, at Google\'s published list price — an estimate, not an invoice.';

module.exports = {
  DATA_CLASSES, PROTECTED_TABLE_RE, OPEN_TABLES, BANNED_COLUMNS, RAW_VALUE_FUNCTIONS,
  SAFE_ID_COLUMNS, MIN_CELL, LIMITS, CURRENCY_NOTE,
};
