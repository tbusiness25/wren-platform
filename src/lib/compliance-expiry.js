'use strict';
/**
 * compliance-expiry.js — b186 (2026-08-19)
 *
 * ONE place that answers "what compliance thing is expiring?", so the API
 * (src/routes/compliance.js), the Single Central Record page and the nightly
 * alert sweep (scripts/report-engine-nightly.js --only=compliance) can never
 * disagree with each other about what is overdue.
 *
 * Generalises the DBS-only 60-day query that already lived in
 * src/routes/admin.js (~L120-161) — that one is left in place and untouched.
 *
 * Every collector is independently try/caught: this module is mounted on
 * editions whose schema may not carry every table (a school edition has no
 * sen_apdr_cycles, a fresh setup has no mandatory_training). A missing source
 * costs you that one kind, never the whole response.
 *
 * Items are shaped:
 *   { kind, subject_type, subject_id, subject_name, due_date, days_remaining,
 *     status, detail, item_key }
 *   status: 'overdue' (due_date < today) | 'due_soon' (within window) | 'ok'
 */

const DEFAULT_WINDOW_DAYS = 60;

// Every kind this module can emit. Exported so the UI can render a filter list
// without hard-coding strings that drift from the collectors below.
const KINDS = [
  'dbs',
  'right_to_work',
  'visa',
  'paediatric_first_aid',
  'safeguarding_training',
  'mandatory_training',
  'policy_review',
  'supervision_due',
  'sen_apdr_review',
  'induction',
  'ofsted_notification',   // b193 — a notifiable setting incident Ofsted has not been told about
];

const KIND_LABELS = {
  dbs:                   'DBS check',
  right_to_work:         'Right to work',
  visa:                  'Visa',
  paediatric_first_aid:  'Paediatric first aid',
  safeguarding_training: 'Safeguarding training',
  mandatory_training:    'Mandatory training',
  policy_review:         'Policy review',
  supervision_due:       'Supervision',
  sen_apdr_review:       'SEN APDR review',
  induction:             'Induction',
  ofsted_notification:   'Ofsted notification',
};

/** Alert window in days — settings.compliance_alert_days, default 60. */
async function windowDays(db) {
  try {
    const { rows } = await db.query(
      `SELECT value FROM settings WHERE key = 'compliance_alert_days'`);
    const n = parseInt(rows[0] && rows[0].value, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) { /* settings unavailable — fall through to the default */ }
  return DEFAULT_WINDOW_DAYS;
}

function statusFor(daysRemaining, win) {
  if (daysRemaining < 0) return 'overdue';
  if (daysRemaining <= win) return 'due_soon';
  return 'ok';
}

/**
 * Run one collector safely. `sql` must SELECT at least:
 *   subject_id, subject_name, due_date  (+ optional detail, item_key)
 */
async function collect(db, kind, subjectType, sql, params, win, out) {
  let rows;
  try {
    ({ rows } = await db.query(sql, params || []));
  } catch (e) {
    // Missing table/column on this edition — skip the kind, keep the rest.
    console.warn(`[compliance-expiry] ${kind} skipped: ${e.message}`);
    return;
  }
  for (const r of rows) {
    if (!r.due_date) continue;
    const days = Math.round(
      (new Date(r.due_date + 'T00:00:00Z') - new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z'))
      / 86400000);
    out.push({
      kind,
      subject_type:   subjectType,
      subject_id:     r.subject_id,
      subject_name:   (r.subject_name || '').trim() || `#${r.subject_id}`,
      due_date:       r.due_date,
      days_remaining: days,
      status:         statusFor(days, win),
      detail:         r.detail || KIND_LABELS[kind] || kind,
      item_key:       r.item_key || `${kind}:${r.subject_id}`,
    });
  }
}

const STAFF_NAME = `btrim(coalesce(s.preferred_name, s.first_name, '') || ' ' || coalesce(s.last_name, ''))`;

/**
 * Everything due, overdue or (with includeOk) simply dated.
 * @param {object}  db          pg pool (search_path already set per edition)
 * @param {object}  opts
 * @param {number}  opts.win    override the settings window
 * @param {boolean} opts.includeOk  keep status 'ok' items (the SCR page wants them)
 * @param {string[]} opts.kinds     restrict to these kinds
 */
async function collectExpiring(db, opts = {}) {
  const win = Number.isFinite(opts.win) ? opts.win : await windowDays(db);
  const want = k => !opts.kinds || !opts.kinds.length || opts.kinds.includes(k);
  const out = [];

  // ── staff: DBS / right to work / visa ─────────────────────────────────────
  if (want('dbs')) await collect(db, 'dbs', 'staff', `
    SELECT s.id AS subject_id, ${STAFF_NAME} AS subject_name,
           s.dbs_expiry::text AS due_date,
           'DBS ' || coalesce(s.dbs_number, '(no number on file)') AS detail,
           'staff:' || s.id AS item_key
      FROM staff s
     WHERE s.is_active = true AND s.dbs_expiry IS NOT NULL`, [], win, out);

  if (want('right_to_work')) await collect(db, 'right_to_work', 'staff', `
    SELECT s.id AS subject_id, ${STAFF_NAME} AS subject_name,
           s.right_to_work_expiry_date::text AS due_date,
           'Right to work (' || coalesce(s.right_to_work_status, 'status not recorded') || ')' AS detail,
           'staff:' || s.id AS item_key
      FROM staff s
     WHERE s.is_active = true AND s.right_to_work_expiry_date IS NOT NULL`, [], win, out);

  if (want('visa')) await collect(db, 'visa', 'staff', `
    SELECT s.id AS subject_id, ${STAFF_NAME} AS subject_name,
           s.visa_expiry_date::text AS due_date,
           'Visa expiry' AS detail,
           'staff:' || s.id AS item_key
      FROM staff s
     WHERE s.is_active = true AND s.visa_expiry_date IS NOT NULL`, [], win, out);

  // ── training ──────────────────────────────────────────────────────────────
  // Paediatric first aid is pulled out of mandatory_training as its own kind
  // (EYFS statutory ratio requirement), and excluded from the generic kind
  // below so nothing is counted twice.
  const PFA_MATCH = `(mt.training_type ILIKE '%paediatric%' OR mt.training_type ILIKE '%first_aid%' OR mt.training_type ILIKE '%first aid%')`;

  if (want('paediatric_first_aid')) await collect(db, 'paediatric_first_aid', 'staff', `
    SELECT s.id AS subject_id, ${STAFF_NAME} AS subject_name,
           mt.expiry_date::text AS due_date,
           'Paediatric first aid' AS detail,
           'mandatory_training:' || mt.id AS item_key
      FROM mandatory_training mt
      JOIN staff s ON s.id = mt.staff_id
     WHERE s.is_active = true AND mt.expiry_date IS NOT NULL AND ${PFA_MATCH}`, [], win, out);

  if (want('mandatory_training')) {
    await collect(db, 'mandatory_training', 'staff', `
      SELECT s.id AS subject_id, ${STAFF_NAME} AS subject_name,
             mt.expiry_date::text AS due_date,
             coalesce(replace(mt.training_type, '_', ' '), 'Mandatory training') AS detail,
             'mandatory_training:' || mt.id AS item_key
        FROM mandatory_training mt
        JOIN staff s ON s.id = mt.staff_id
       WHERE s.is_active = true AND mt.expiry_date IS NOT NULL AND NOT ${PFA_MATCH}`, [], win, out);

    // cpd_records carries the same statutory renewals for courses taken through
    // the Wren academy — same query shape admin.js already uses for its counters.
    await collect(db, 'mandatory_training', 'staff', `
      SELECT s.id AS subject_id, ${STAFF_NAME} AS subject_name,
             c.expiry_date::text AS due_date,
             coalesce(c.course_name, 'Mandatory CPD') AS detail,
             'cpd_records:' || c.id AS item_key
        FROM cpd_records c
        JOIN staff s ON s.id = c.staff_id
       WHERE s.is_active = true AND c.is_mandatory = true AND c.expiry_date IS NOT NULL`, [], win, out);
  }

  if (want('safeguarding_training')) await collect(db, 'safeguarding_training', 'staff', `
    SELECT s.id AS subject_id, ${STAFF_NAME} AS subject_name,
           st.expiry_date::text AS due_date,
           coalesce(replace(st.training_type, '_', ' '), 'Safeguarding training') AS detail,
           'safeguarding_training:' || st.id AS item_key
      FROM safeguarding_training st
      JOIN staff s ON s.id = st.staff_id
     WHERE s.is_active = true AND st.expiry_date IS NOT NULL`, [], win, out);

  // ── induction: still open past its target completion date ─────────────────
  if (want('induction')) await collect(db, 'induction', 'staff', `
    SELECT s.id AS subject_id, ${STAFF_NAME} AS subject_name,
           ia.target_complete_date::text AS due_date,
           'Induction (' || coalesce(ia.status, 'in progress') || ')' AS detail,
           'induction_assignments:' || ia.id AS item_key
      FROM induction_assignments ia
      JOIN staff s ON s.id = ia.staff_id
     WHERE s.is_active = true AND ia.target_complete_date IS NOT NULL
       AND coalesce(ia.status, '') NOT IN ('complete', 'completed', 'signed_off')`, [], win, out);

  // ── supervision: the next date agreed at the most recent supervision ──────
  if (want('supervision_due')) await collect(db, 'supervision_due', 'staff', `
    SELECT DISTINCT ON (s.id)
           s.id AS subject_id, ${STAFF_NAME} AS subject_name,
           sv.next_supervision_date::text AS due_date,
           'Next supervision' AS detail,
           'supervisions:' || sv.id AS item_key
      FROM staff s
      JOIN supervisions sv ON sv.staff_id = s.id
     WHERE s.is_active = true AND sv.next_supervision_date IS NOT NULL
     ORDER BY s.id, sv.next_supervision_date DESC`, [], win, out);

  // ── policy review (new in b186 — policies had no date at all before) ──────
  if (want('policy_review')) await collect(db, 'policy_review', 'policy', `
    SELECT p.id AS subject_id, p.title AS subject_name,
           p.review_due::text AS due_date,
           'Policy review' || coalesce(' — ' || p.category, '') AS detail,
           'policies:' || p.id AS item_key
      FROM policies p
     WHERE p.is_active = true AND p.review_due IS NOT NULL`, [], win, out);

  // ── SEN APDR: an OPEN cycle whose review date has come round ──────────────
  // NOTE: sen_apdr_reviews records reviews already HELD (no due date), so the
  // due-date source is the open cycle in sen_apdr_cycles.
  if (want('sen_apdr_review')) await collect(db, 'sen_apdr_review', 'child', `
    SELECT ch.id AS subject_id,
           btrim(coalesce(ch.preferred_name, ch.first_name, '') || ' ' || coalesce(ch.last_name, '')) AS subject_name,
           cy.review_date::text AS due_date,
           'APDR cycle ' || coalesce(cy.cycle_number::text, '?') || ' review' AS detail,
           'sen_apdr_cycles:' || cy.id AS item_key
      FROM sen_apdr_cycles cy
      JOIN children ch ON ch.id = cy.child_id
     WHERE cy.review_date IS NOT NULL
       AND coalesce(cy.status, 'open') NOT IN ('closed', 'complete', 'completed')`, [], win, out);

  // ── Ofsted notification (b193) ────────────────────────────────────────────
  // EYFS requires providers to notify Ofsted of significant events affecting
  // their suitability to care for children (and of food poisoning affecting two
  // or more children) as soon as reasonably practicable and in any event within
  // 14 days. setting_incidents.ofsted_due_by carries that deadline, so an
  // un-notified event chases itself every night through the same sweep as DBS
  // and policy reviews rather than depending on someone remembering.
  //
  // GDPR: subject_name is the incident REFERENCE and its category — never a
  // child's name. These alerts reach a manager's Telegram/email.
  if (want('ofsted_notification')) await collect(db, 'ofsted_notification', 'setting_incident', `
    SELECT si.id AS subject_id,
           si.incident_ref || ' — ' || coalesce(c.label, si.category, 'setting incident') AS subject_name,
           si.ofsted_due_by::text AS due_date,
           'Ofsted not yet notified' AS detail,
           'setting_incidents:' || si.id AS item_key
      FROM setting_incidents si
      LEFT JOIN setting_incident_categories c ON c.id = si.category
     WHERE si.ofsted_notifiable = true
       AND si.ofsted_notified_at IS NULL
       AND si.ofsted_due_by IS NOT NULL`, [], win, out);

  const keep = opts.includeOk ? out : out.filter(i => i.status !== 'ok');
  keep.sort((a, b) => (a.due_date < b.due_date ? -1 : a.due_date > b.due_date ? 1 : 0));
  return { window_days: win, items: keep };
}

module.exports = {
  collectExpiring,
  windowDays,
  statusFor,
  KINDS,
  KIND_LABELS,
  DEFAULT_WINDOW_DAYS,
};
