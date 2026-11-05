'use strict';
/**
 * b308 — the four retention clocks a departing child produces.
 *
 * WHY THIS FILE EXISTS
 *
 * wren-docs/compliance/record-retention.md is the specification. Its conclusion
 * is that one leaver is not one retention period:
 *
 *   handover   learning journey, keepsake, memory box.
 *              Not ours to keep — handed to the parent at exit, then deleted.
 *   ordinary   register, attendance, medication, accidents, permissions,
 *              funding, invoices.
 *              3 years after leaving, OR the next Ofsted inspection, whichever
 *              is later.  (EYFS / Childcare Act 2006; DPA 2018)
 *   consent    photo / video / audio permission records.
 *              21 years 6 months from the permission.  (UK GDPR / DPA 2018)
 *   protected  child protection, CIN/CAF, SEND, health care plans.
 *              25 years from DATE OF BIRTH. Looked After Child: 75 years.
 *              (Limitation Act 1980; Education Act 1996)
 *
 * An archive that cannot tell those apart can only be kept to the longest, i.e.
 * 25 years for a register entry — a GDPR breach of our own making. So the class
 * has to travel with the item, and the class has to be decided in ONE place that
 * the leaver job, the sweep and the API all read. That place is this file.
 *
 * THE FALLBACK IS DELIBERATELY PARANOID
 *
 * A table nobody has classified falls to `protected` with needs_review=true.
 * Over-retaining a safeguarding record is a defensible error that a human can
 * correct; deleting one is not. The flag is what stops "safe" turning into
 * "silently hoarding everything" — someone has to come and make the call.
 *
 * ANCHORS
 *
 * The anchor is the DATE THE CLOCK STARTS, and it is different per class. Get
 * this wrong and the expiry is wrong by decades: `protected` runs from the
 * child's BIRTH, not from the day they left, so a two-year-old who leaves in
 * 2026 has a CP record live until 2049 — not 2051.
 */

const CLASSES = ['handover', 'ordinary', 'consent', 'protected'];

const CLASS_RULES = {
  handover: {
    label: 'Handover',
    holds: 'learning journey, keepsake, memory box',
    rule: 'Not kept — handed to the parent at exit, then deleted',
    anchorName: 'leaving date',
    authority: 'EYFS statutory framework',
  },
  ordinary: {
    label: 'Ordinary records',
    holds: 'register, attendance, medication, accidents, permissions, funding, invoices',
    rule: '3 years after leaving, or the next Ofsted inspection, whichever is later',
    anchorName: 'leaving date',
    authority: 'EYFS (Childcare Act 2006); DPA 2018 / UK GDPR',
  },
  consent: {
    label: 'Consent',
    holds: 'photo / video / audio permission records',
    rule: '21 years and 6 months from the permission',
    anchorName: 'permission date',
    authority: 'UK GDPR / DPA 2018',
  },
  protected: {
    label: 'Protected',
    holds: 'child protection, CIN/CAF, SEND, health care plans',
    rule: '25 years from date of birth — Looked After Child: 75 years',
    anchorName: 'date of birth',
    authority: 'Limitation Act 1980; Education Act 1996',
  },
};

/**
 * Every ladn table carrying a child_id, and which clock it belongs on.
 * `why` is not decoration: when a DPO asks why an attendance row died at three
 * years and a SEN row did not, this column is the answer.
 */
const TABLE_CLASS = {
  // ── handover — the learning journey. The parent's, not ours. ───────────────
  observations:              { class: 'handover', why: 'the learning journey itself' },
  next_steps:                { class: 'handover', why: 'next steps hang off observations' },
  child_about_me:            { class: 'handover', why: 'the all-about-me the family wrote' },
  first_words:               { class: 'handover', why: 'milestone keepsake' },
  memory_box_entries:        { class: 'handover', why: 'memory box' },
  leavers_books:             { class: 'handover', why: 'the leavers keepsake book' },
  leavers_gift_packages:     { class: 'handover', why: 'the leavers keepsake package' },
  framework_tracker:         { class: 'handover', why: 'developmental tracking — part of the journey' },
  framework_child_optout:    { class: 'handover', why: 'the family opting out of tracking' },
  band_judgements:           { class: 'handover', why: 'developmental judgements' },
  child_range_judgements:    { class: 'handover', why: 'developmental judgements' },
  termly_child_reviews:      { class: 'handover', why: 'termly progress review' },
  termly_child_evaluations:  { class: 'handover', why: 'termly progress evaluation' },
  reports:                   { class: 'handover', why: 'progress reports shared with the parent' },
  parent_reports:            { class: 'handover', why: 'progress reports shared with the parent' },
  report_sessions:           { class: 'handover', why: 'report generation for the parent' },
  assessments:               { class: 'handover', why: 'curriculum assessment' },
  assessments_primary:       { class: 'handover', why: 'curriculum assessment' },
  assessments_secondary:     { class: 'handover', why: 'curriculum assessment' },
  ctf_assessment_results:    { class: 'handover', why: 'assessment results carried on transfer' },
  phonics_tracker:           { class: 'handover', why: 'phonics progress' },
  child_phonics_progress:    { class: 'handover', why: 'phonics progress' },
  phonics_game_sessions:     { class: 'handover', why: 'phonics practice' },
  phonics_group_participants:{ class: 'handover', why: 'phonics grouping' },
  daily_diary:               { class: 'handover', why: 'the daily record shared with the parent' },
  diary_entries:             { class: 'handover', why: 'the daily record shared with the parent' },
  food_intake_log:           { class: 'handover', why: 'the daily record shared with the parent' },
  home_log:                  { class: 'handover', why: 'the home/nursery shared log' },
  visual_schedules:          { class: 'handover', why: "the child's own visual schedule" },
  settling_in_plans:         { class: 'handover', why: 'settling-in narrative' },
  planned_activities:        { class: 'handover', why: 'planning written around this child' },
  area_intention_sources:    { class: 'handover', why: 'planning provenance' },
  shared_items:              { class: 'handover', why: 'already shared with the parent' },

  // ── ordinary — 3 years, or the next inspection, whichever is later ─────────
  attendance:                { class: 'ordinary', why: 'register' },
  attendance_events:         { class: 'ordinary', why: 'register' },
  attendance_register:       { class: 'ordinary', why: 'register' },
  attendance_concern_actions:{ class: 'ordinary', why: 'attendance follow-up' },
  register_checks:           { class: 'ordinary', why: 'register' },
  child_bookings:            { class: 'ordinary', why: 'booked sessions — the register source' },
  child_sessions:            { class: 'ordinary', why: 'booked sessions' },
  child_holidays:            { class: 'ordinary', why: 'booked absence' },
  booking_requests:          { class: 'ordinary', why: 'booking administration' },
  parent_reported_absences:  { class: 'ordinary', why: 'register' },
  child_room_moves:          { class: 'ordinary', why: 'placement record' },
  room_move_log:             { class: 'ordinary', why: 'placement record' },
  medicine_records:          { class: 'ordinary', why: 'medication record — named in the schedule' },
  parent_medicine_consents:  { class: 'ordinary', why: 'medication permission' },
  child_temperatures:        { class: 'ordinary', why: 'health monitoring log' },
  sleep_checks:              { class: 'ordinary', why: 'safety check log' },
  incidents:                 { class: 'ordinary', why: 'accident record — named in the schedule' },
  setting_incident_children: { class: 'ordinary', why: 'accident record' },
  authorised_collectors:     { class: 'ordinary', why: 'collection permission' },
  permission_slip_responses: { class: 'ordinary', why: 'parental permission form' },
  parent_permissions_child_overrides: { class: 'ordinary', why: 'parental permission' },
  parent_policy_acknowledgments:      { class: 'ordinary', why: 'parental acknowledgement' },
  home_visits:               { class: 'ordinary', why: 'settling-in visit record' },
  child_funding:             { class: 'ordinary', why: 'LA funding data — named in the schedule' },
  funding_declarations:      { class: 'ordinary', why: 'LA funding data' },
  funding_declaration_reminders: { class: 'ordinary', why: 'LA funding administration' },
  invoices:                  { class: 'ordinary', why: 'financial record' },
  finance_invoices:          { class: 'ordinary', why: 'financial record' },
  payments:                  { class: 'ordinary', why: 'financial record' },
  payment_allocations:       { class: 'ordinary', why: 'financial record' },
  payment_plans:             { class: 'ordinary', why: 'financial record' },
  child_fee_items:           { class: 'ordinary', why: 'financial record' },
  child_fee_optouts:         { class: 'ordinary', why: 'financial record' },
  child_discounts:           { class: 'ordinary', why: 'financial record' },
  child_deposits:            { class: 'ordinary', why: 'financial record' },
  child_invoice_settings:    { class: 'ordinary', why: 'financial record' },
  tfc_payments:              { class: 'ordinary', why: 'financial record' },
  gocardless_mandates:       { class: 'ordinary', why: 'financial record' },
  eylog_deleted_invoices:    { class: 'ordinary', why: 'financial record (migrated)' },
  eylog_reconciliation:      { class: 'ordinary', why: 'financial record (migrated)' },
  eylog_uninvoiced_sessions: { class: 'ordinary', why: 'financial record (migrated)' },
  eyman_aged_debtors:        { class: 'ordinary', why: 'financial record (migrated)' },
  eyman_child_sessions:      { class: 'ordinary', why: 'booked sessions (migrated)' },
  eyman_credit_notes:        { class: 'ordinary', why: 'financial record (migrated)' },
  eyman_deposit_movements:   { class: 'ordinary', why: 'financial record (migrated)' },
  eyman_direct_debits:       { class: 'ordinary', why: 'financial record (migrated)' },
  eyman_emergency_contacts:  { class: 'ordinary', why: 'contact record (migrated)' },
  eyman_funding_weekly:      { class: 'ordinary', why: 'LA funding data (migrated)' },
  eyman_monthly_debtors:     { class: 'ordinary', why: 'financial record (migrated)' },
  eyman_monthly_funding:     { class: 'ordinary', why: 'LA funding data (migrated)' },
  eyman_parent_details:      { class: 'ordinary', why: 'contact record (migrated)' },
  message_threads:           { class: 'ordinary', why: 'parent correspondence' },
  parent_change_requests:    { class: 'ordinary', why: 'parent correspondence' },
  child_leaving_notices:     { class: 'ordinary', why: 'the written notice under the contract, and what the parent was shown when they gave it (b341)' },
  keepsake_requests:         { class: 'ordinary', why: 'a family asking for their own memory book — administration (b341)' },
  parent_form_requests:      { class: 'ordinary', why: 'which form a parent was asked to sign, and when — bookkeeping, no content (b343)' },
  parent_form_signatures:    { class: 'ordinary', why: 'what a parent signed and exactly what they were shown: medicine and accident records are ordinary, reports handover — the longer applies (b343)' },
  parent_app_feedback:       { class: 'ordinary', why: 'parent correspondence' },
  parent_group_members:      { class: 'ordinary', why: 'parent communication grouping' },
  parent_portal_access:      { class: 'ordinary', why: 'who was given access, and when' },
  event_rsvps:               { class: 'ordinary', why: 'event administration' },
  survey_invites:            { class: 'ordinary', why: 'parent survey administration' },
  survey_responses:          { class: 'ordinary', why: 'parent survey' },
  behaviour_log:             { class: 'ordinary', why: 'conduct record — general child record' },
  behaviour_log_primary:     { class: 'ordinary', why: 'conduct record — general child record' },
  exclusions:                { class: 'ordinary', why: 'conduct record — general child record' },
  ctf_fsm_history:           { class: 'ordinary', why: 'entitlement history carried on transfer' },
  ctf_school_history:        { class: 'ordinary', why: 'placement history carried on transfer' },
  data_subject_requests:     { class: 'ordinary', why: 'GDPR request administration' },

  // ── consent — 21 years 6 months from the permission ────────────────────────
  // child_consents is SPLIT: see CLASS_SPLITS. Photo/video/audio permissions run
  // for 21y6m; every other consent type is an ordinary parental permission form.

  // ── protected — 25 years from birth (75 for a Looked After Child) ──────────
  children:                  { class: 'protected', why: 'the child record itself carries court orders, social worker and medical detail' },
  safeguarding_concerns:     { class: 'protected', why: 'child protection' },
  safeguarding_log:          { class: 'protected', why: 'child protection' },
  safeguarding_transfers:    { class: 'protected', why: 'child protection' },
  cp_register:               { class: 'protected', why: 'CP / CIN plan' },
  carer_restrictions:        { class: 'protected', why: 'who may not collect — a court/CP matter' },
  sen_register:              { class: 'protected', why: 'SEND record' },
  sen_targets:               { class: 'protected', why: 'SEND record' },
  sen_apdr_cycles:           { class: 'protected', why: 'SEND record' },
  sen_play_plans:            { class: 'protected', why: 'SEND record' },
  sen_strategy_links:        { class: 'protected', why: 'SEND record' },
  sen_flag_suggestions:      { class: 'protected', why: 'SEND record' },
  ctf_sen_history:           { class: 'protected', why: 'SEND record carried on transfer' },
  interventions:             { class: 'protected', why: 'targeted support — treated as SEND' },
  person_documents:          { class: 'protected', why: 'uploaded documents are classed per document, defaulting here' },
};

/**
 * One table, two clocks. A photo permission and a trip permission slip are both
 * rows in child_consents, and they die 18 years apart.
 */
const CLASS_SPLITS = {
  child_consents: [
    {
      class: 'consent',
      why: 'photo / video / audio permission — 21y6m',
      where: `consent_type ~* '(photo|video|audio|image|media|film)'`,
      anchorColumn: 'consent_date',
      suffix: 'media',
    },
    {
      class: 'ordinary',
      why: 'every other parental permission form',
      where: `consent_type !~* '(photo|video|audio|image|media|film)' OR consent_type IS NULL`,
      suffix: 'other',
    },
  ],
};

/**
 * Not archived at all — and this is a different statement from "no retention
 * class". These are credentials and session state, not records about a child.
 * Copying them into a 25-year archive would be storing live secrets for a
 * quarter of a century.
 */
const EXCLUDE = {
  refresh_tokens:     'session credentials, not a record about the child',
  external_api_tokens:'API credentials, not a record about the child',
  // The archive's own index. Copying it into the archive would archive the
  // record of the archiving, and the next run would archive that.
  archive_items:      'the archive index itself',
  archive_runs:       'the archive job log itself',
};

/**
 * File-bearing columns, declared per table. A path column is the only reliable
 * way to find the actual artefact: nothing else in the schema distinguishes
 * "text that happens to look like a filename" from a file we are holding.
 * Media inherits the class of its own table.
 */
const MEDIA_COLUMNS = {
  observations:          [{ column: 'photo_urls',   array: true },
                          { column: 'voice_note_url' }],
  leavers_books:         [{ column: 'pdf_url' }],
  voice_notes:           [{ column: 'audio_path' }],
  person_documents:      [{ column: 'stored_path' }],
  cctv_footage_requests: [{ column: 'clip_path' }],
};

/**
 * person_documents.category → class. An EHCP and a photo-consent form are not
 * on the same clock even though they arrived through the same upload button.
 */
const DOCUMENT_CATEGORY_CLASS = {
  photo_consent: 'consent',
  ehcp:          'protected',
  medical:       'protected',
  certificate:   'ordinary',
  contract:      'ordinary',
  report:        'handover',
  other:         null,          // null → fall through to the paranoid default
  // b321 — what a family uploads at registration. These MUST be listed here as
  // well as in src/lib/child-documents.js: without an entry, a peg photo
  // archives as `protected` and is held for twenty-five years, which is the
  // exact GDPR failure the class system exists to prevent.
  family_photo:     'handover',   // the family's picture, lent to us to print
  peg_portrait:     'handover',
  allergy_doc:      'ordinary',   // "medication records" in the schedule
  medicine_doc:     'ordinary',
  health_care_plan: 'protected',  // named alongside CP and SEND — 25 years
  red_book:         'ordinary',   // b422 — immunisation record, "medication records" territory
};

/**
 * b321 — the class of ONE uploaded document.
 *
 * Prefers the class STORED on the row. The category map above is a rule about
 * categories; retention_class is a fact about this file, written when it was
 * uploaded. They agree today, and the stored one has to win when they stop
 * agreeing — a document re-categorised in 2031 must not silently move a
 * protected record onto a three-year clock.
 *
 * @param {object} row  a person_documents row (needs .retention_class, .category)
 * @returns {{class:string, needsReview:boolean, source:string}}
 */
function documentClass(row) {
  const stored = row && row.retention_class;
  if (stored && CLASSES.includes(stored)) {
    return { class: stored, needsReview: false, source: 'stored on the row at upload' };
  }
  const mapped = DOCUMENT_CATEGORY_CLASS[row && row.category];
  if (mapped) return { class: mapped, needsReview: false, source: 'category rule' };
  const fallback = classify('person_documents');
  return { class: fallback.class, needsReview: true, source: 'unclassified — paranoid default' };
}

/** The paranoid default, and the flag that stops it being silent. */
function classify(table) {
  if (EXCLUDE[table]) return { class: null, excluded: true, why: EXCLUDE[table], needsReview: false };
  const hit = TABLE_CLASS[table];
  if (hit) return { class: hit.class, why: hit.why, needsReview: false, excluded: false };
  return {
    class: 'protected',
    why: 'no rule names this table — defaulted to protected and flagged for a human',
    needsReview: true,
    excluded: false,
  };
}

// ── date helpers ────────────────────────────────────────────────────────────
// pg hands back a DATE as a JS Date at LOCAL midnight. toISOString() shifts it
// backwards a day west of UTC, and String() gives a long-form date nobody can
// parse back. Always read it with the LOCAL getters. (See reference note
// "pg DATE → ymd() trap".)
function ymd(d) {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseYmd(s) {
  const t = ymd(s);
  if (!t) return null;
  const [y, m, d] = t.split('-').map(Number);
  return new Date(y, m - 1, d);          // local midnight, same as pg hands us
}

/** Calendar-correct add. 29 Feb + 1 year lands on 28 Feb, not 1 March. */
function addPeriod(date, { years = 0, months = 0, days = 0 }) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const targetMonth = d.getMonth() + months;
  const probe = new Date(d.getFullYear() + years, targetMonth, 1);
  const lastDay = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate();
  probe.setDate(Math.min(d.getDate(), lastDay));
  probe.setDate(probe.getDate() + days);
  return probe;
}

/**
 * The whole point of the build, in one function.
 *
 * @param {string} cls           one of CLASSES
 * @param {object} child         { leave_date, date_of_birth, looked_after }
 * @param {object} opts          { consentDate, handoverGraceDays, archivedOn }
 * @returns {{expires_on:string|null, anchor:string, anchor_date:string|null, note?:string}}
 */
function computeExpiry(cls, child, opts = {}) {
  const grace = Number.isFinite(opts.handoverGraceDays) ? opts.handoverGraceDays : 30;
  const leave = parseYmd(child.leave_date);
  const dob   = parseYmd(child.date_of_birth);
  const archived = parseYmd(opts.archivedOn) || new Date();

  switch (cls) {
    case 'handover': {
      // Not a retention period: the learning journey is the parent's. Our copy
      // exists only long enough to hand it over, so the clock is a short grace
      // from the leaving date — long enough that a family collecting it a
      // fortnight late still gets it, short enough that we are not quietly
      // keeping what we said we would not keep.
      const anchorDate = leave || archived;
      return {
        expires_on: ymd(addPeriod(anchorDate, { days: grace })),
        anchor: leave ? `leaving date + ${grace} day handover grace` : `archived + ${grace} day handover grace`,
        anchor_date: ymd(anchorDate),
        note: 'not kept — handed to the parent, then deleted',
      };
    }
    case 'ordinary': {
      // The three-year floor is what gets stored. The "or the next Ofsted
      // inspection, whichever is later" half CANNOT be stored: at archive time
      // that inspection has not happened. The sweep enforces it (and refuses to
      // expire this class at all while the last-inspection setting is unset).
      if (!leave) return { expires_on: null, anchor: 'leaving date (missing)', anchor_date: null,
        note: 'no leave_date — cannot date this record, so it will never be swept' };
      return {
        expires_on: ymd(addPeriod(leave, { years: 3 })),
        anchor: 'leaving date + 3 years',
        anchor_date: ymd(leave),
        note: 'held further if no Ofsted inspection has fallen since the child left',
      };
    }
    case 'consent': {
      const anchorDate = parseYmd(opts.consentDate) || leave;
      if (!anchorDate) return { expires_on: null, anchor: 'permission date (missing)', anchor_date: null,
        note: 'no permission date — cannot date this record' };
      return {
        expires_on: ymd(addPeriod(anchorDate, { years: 21, months: 6 })),
        anchor: opts.consentDate ? 'permission date + 21 years 6 months' : 'leaving date + 21 years 6 months (no permission date recorded)',
        anchor_date: ymd(anchorDate),
      };
    }
    case 'protected': {
      // From BIRTH, not from leaving. Getting this wrong is a decades-long error.
      if (!dob) return { expires_on: null, anchor: 'date of birth (missing)', anchor_date: null,
        note: 'no date of birth — cannot date this record, so it will never be swept' };
      const years = child.looked_after ? 75 : 25;
      return {
        expires_on: ymd(addPeriod(dob, { years })),
        anchor: `date of birth + ${years} years`,
        anchor_date: ymd(dob),
        note: child.looked_after ? 'Looked After Child — 75 years' : null,
      };
    }
    default:
      throw new Error(`unknown retention class: ${cls}`);
  }
}

module.exports = {
  CLASSES, CLASS_RULES, TABLE_CLASS, CLASS_SPLITS, EXCLUDE,
  MEDIA_COLUMNS, DOCUMENT_CATEGORY_CLASS,
  classify, documentClass, computeExpiry, ymd, parseYmd, addPeriod,
};
