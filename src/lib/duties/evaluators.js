'use strict';
// b334 (2026-09-15) — one evaluator per duty. Each answers, for ONE subject
// (a child id, a room id, a staff id, or the setting — subject_id 0), the same
// three questions: when was it last done, by whom, and what state is it in.
//
// Every evaluator has the shape:
//   async (db, subjectId, def, today) => { state, last_done_date, last_done_by, next_due_date, detail }
//
// state is one of 'done' | 'due_soon' | 'overdue' | 'not_applicable'. Nothing
// here writes anywhere — src/routes/duties.js caches the result in duty_status.

/** Generic cadence -> state, from a last-done date and a next-due date. */
function stateFromDue(lastDoneDate, nextDueDate, graceDays, today) {
  if (!nextDueDate) return lastDoneDate ? 'done' : 'overdue';
  const due = new Date(nextDueDate);
  const grace = Number(graceDays) || 0;
  const dueSoonWindow = Math.min(14, grace > 0 ? grace : 7);
  const daysUntilDue = Math.round((due - today) / 86400000);
  if (daysUntilDue > dueSoonWindow) return lastDoneDate ? 'done' : 'overdue';
  if (daysUntilDue >= -grace) return lastDoneDate && daysUntilDue > 0 ? 'due_soon' : (lastDoneDate ? 'due_soon' : 'overdue');
  return 'overdue';
}

const CADENCE_DAYS = {
  daily: 1, weekly: 7, half_termly: 63, termly: 126, annual: 365,
};

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}
function ymd(d) {
  if (!d) return null;
  const dt = new Date(d);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
}

/** For a recurring cadence duty: last-done date + cadence interval = next due. */
function recurring(lastDoneDate, cadence, graceDays, today, anchorDate) {
  const days = CADENCE_DAYS[cadence] || 126;
  const anchor = lastDoneDate || anchorDate;
  if (!anchor) return { state: 'overdue', next_due_date: null };
  const nextDue = lastDoneDate ? addDays(lastDoneDate, days) : anchor;
  return { state: stateFromDue(lastDoneDate, nextDue, graceDays, today), next_due_date: ymd(nextDue) };
}

// ═══════════════════════════════════════════════════════════════════════════
// PER CHILD
// ═══════════════════════════════════════════════════════════════════════════

async function progressCheckTwo(db, childId, def, today) {
  const { rows: [c] } = await db.query('SELECT date_of_birth, created_at FROM children WHERE id=$1', [childId]);
  if (!c || !c.date_of_birth) return { state: 'not_applicable' };
  const ageMonths = monthsBetween(new Date(c.date_of_birth), today);
  if (ageMonths < 24) return { state: 'not_applicable', detail: { turns_24mo_in_months: 24 - ageMonths } };
  const { rows: [r] } = await db.query(
    `SELECT created_at::date AS d, staff_id FROM reports
      WHERE child_id=$1 AND report_type='two_year_check' ORDER BY created_at DESC LIMIT 1`, [childId]);
  if (r) return { state: 'done', last_done_date: r.d, last_done_by: r.staff_id };
  // Never done: due from the day the child turned 24 months.
  const dueFrom = addDays(new Date(c.date_of_birth), 24 * 30);
  return { state: stateFromDue(null, dueFrom, def.grace_days, today), next_due_date: ymd(dueFrom) };
}

async function twoYearCheckShared(db, childId, def, today) {
  const { rows: [c] } = await db.query('SELECT date_of_birth FROM children WHERE id=$1', [childId]);
  if (!c || !c.date_of_birth) return { state: 'not_applicable' };
  const ageMonths = monthsBetween(new Date(c.date_of_birth), today);
  if (ageMonths < 24) return { state: 'not_applicable' };
  const { rows: [r] } = await db.query(
    `SELECT created_at::date AS d, staff_id, shared_with_parents, sent_at FROM reports
      WHERE child_id=$1 AND report_type='two_year_check' ORDER BY created_at DESC LIMIT 1`, [childId]);
  if (!r) return { state: 'not_applicable', detail: { reason: 'no check recorded yet — see progress_check_two' } };
  if (r.shared_with_parents || r.sent_at) return { state: 'done', last_done_date: ymd(r.sent_at) || r.d, last_done_by: r.staff_id };
  return { state: stateFromDue(null, r.d, def.grace_days, today), next_due_date: r.d };
}

async function progressReport(db, childId, def, today) {
  const { rows: [c] } = await db.query('SELECT created_at::date AS enrolled FROM children WHERE id=$1', [childId]);
  const { rows: [r] } = await db.query(
    `SELECT created_at::date AS d, staff_id FROM reports
      WHERE child_id=$1 AND report_type IN ('termly_progress','termly_update','summative')
      ORDER BY created_at DESC LIMIT 1`, [childId]);
  const result = recurring(r ? r.d : null, def.cadence, def.grace_days, today, c ? new Date(c.enrolled) : today);
  return { ...result, last_done_date: r ? r.d : null, last_done_by: r ? r.staff_id : null };
}

async function keyPersonAssigned(db, childId, def, today) {
  const { rows: [c] } = await db.query('SELECT key_person_id, created_at::date AS d FROM children WHERE id=$1', [childId]);
  if (!c) return { state: 'not_applicable' };
  if (c.key_person_id) return { state: 'done', last_done_date: c.d, last_done_by: c.key_person_id };
  return { state: 'overdue', next_due_date: c.d };
}

async function nextStepsSet(db, childId, def, today) {
  const { rows: [c] } = await db.query('SELECT created_at::date AS enrolled FROM children WHERE id=$1', [childId]);
  // b393 (2026-10-05): "set" used to mean "one exists, ever" — true for every
  // child on prod, including the ones with 187 EyLog next steps nobody has
  // looked at in a year. The duty is now "has an ACTIVE next step that has
  // been reviewed inside the duty's own cadence", which is what the next-steps
  // decision doc asks the duties tracker to check.
  const { rows: [r] } = await db.query(`
    SELECT GREATEST(created_at, COALESCE(last_reviewed_at, created_at))::date AS d, staff_id
      FROM next_steps
     WHERE child_id=$1 AND status IN ('pending','open','planned') AND closed_at IS NULL
     ORDER BY GREATEST(created_at, COALESCE(last_reviewed_at, created_at)) DESC LIMIT 1`, [childId]);
  const result = recurring(r ? r.d : null, def.cadence, def.grace_days, today, c ? new Date(c.enrolled) : today);
  return { ...result, last_done_date: r ? r.d : null, last_done_by: r ? r.staff_id : null };
}

async function observationRecency(db, childId, def, today) {
  const { rows: [c] } = await db.query('SELECT created_at::date AS enrolled FROM children WHERE id=$1', [childId]);
  const { rows: [r] } = await db.query(
    `SELECT created_at::date AS d, staff_id FROM observations WHERE child_id=$1 ORDER BY created_at DESC LIMIT 1`, [childId]);
  const result = recurring(r ? r.d : null, def.cadence, def.grace_days, today, c ? new Date(c.enrolled) : today);
  return { ...result, last_done_date: r ? r.d : null, last_done_by: r ? r.staff_id : null };
}

async function accidentFormSigned(db, childId, def, today) {
  const { rows: [i] } = await db.query(
    `SELECT incident_date AS d, reported_by, parent_signed_at, manager_sign_off_at
       FROM incidents WHERE child_id=$1 ORDER BY incident_date DESC, created_at DESC LIMIT 1`, [childId]);
  if (!i) return { state: 'not_applicable' };
  if (i.parent_signed_at) return { state: 'done', last_done_date: ymd(i.parent_signed_at), last_done_by: i.reported_by };
  return { state: stateFromDue(null, i.d, def.grace_days, today), next_due_date: ymd(i.d), detail: { incident_date: ymd(i.d) } };
}

async function medicineFormSigned(db, childId, def, today) {
  const { rows: [m] } = await db.query(
    `SELECT time_given::date AS d, given_by_id, staff_id, manager_sign_off_at, staff_signature
       FROM medicine_records WHERE child_id=$1 ORDER BY time_given DESC LIMIT 1`, [childId]);
  if (!m) return { state: 'not_applicable' };
  if (m.manager_sign_off_at || m.staff_signature) {
    return { state: 'done', last_done_date: ymd(m.manager_sign_off_at) || m.d, last_done_by: m.given_by_id || m.staff_id };
  }
  return { state: stateFromDue(null, m.d, def.grace_days, today), next_due_date: m.d };
}

async function parentChat(db, childId, def, today) {
  const { rows: [c] } = await db.query('SELECT created_at::date AS enrolled FROM children WHERE id=$1', [childId]);
  const { rows: [r] } = await db.query(
    `SELECT chat_date AS d, staff_id FROM duty_parent_chats WHERE child_id=$1 ORDER BY chat_date DESC LIMIT 1`, [childId]);
  const result = recurring(r ? r.d : null, def.cadence, def.grace_days, today, c ? new Date(c.enrolled) : today);
  return { ...result, last_done_date: r ? r.d : null, last_done_by: r ? r.staff_id : null };
}

async function abcObservation(db, childId, def, today) {
  const { rows: [any] } = await db.query('SELECT count(*)::int AS n FROM behaviour_log WHERE child_id=$1', [childId]);
  if (!any || any.n === 0) return { state: 'not_applicable' };
  const { rows: [r] } = await db.query(
    `SELECT log_date AS d, staff_id FROM behaviour_log WHERE child_id=$1 ORDER BY log_date DESC LIMIT 1`, [childId]);
  const result = recurring(r.d, def.cadence, def.grace_days, today, r.d);
  return { ...result, last_done_date: r.d, last_done_by: r.staff_id };
}

async function ehcpPaperwork(db, childId, def, today) {
  const { rows: [s] } = await db.query(
    `SELECT ehcp_date, review_date, annual_review_date, senco_staff_id, sen_type
       FROM sen_register WHERE child_id=$1 AND is_active=true LIMIT 1`, [childId]);
  if (!s || (!s.ehcp_date && !/ehcp/i.test(s.sen_type || ''))) return { state: 'not_applicable' };
  const { rows: [rev] } = await db.query(
    `SELECT max(review_date) AS d FROM sen_apdr_reviews r
       JOIN sen_apdr_cycles cy ON cy.id = r.cycle_id WHERE cy.child_id=$1`, [childId]);
  const lastDone = (rev && rev.d) || null;
  const nextDue = s.review_date || s.annual_review_date;
  if (lastDone && nextDue && new Date(lastDone) >= new Date(nextDue)) {
    return { state: 'done', last_done_date: ymd(lastDone), next_due_date: ymd(nextDue) };
  }
  return { state: stateFromDue(ymd(lastDone), nextDue, def.grace_days, today), last_done_date: ymd(lastDone), next_due_date: ymd(nextDue), last_done_by: s.senco_staff_id };
}

// ═══════════════════════════════════════════════════════════════════════════
// PER ROOM
// ═══════════════════════════════════════════════════════════════════════════

async function termlyPlanPublished(db, roomId, def, today) {
  const { rows: [p] } = await db.query(
    `SELECT published_at::date AS d, published_by FROM term_plans
       WHERE room_id=$1 AND status='published' ORDER BY published_at DESC LIMIT 1`, [roomId]);
  const result = recurring(p ? p.d : null, def.cadence, def.grace_days, today, today);
  return { ...result, last_done_date: p ? p.d : null, last_done_by: p ? p.published_by : null };
}

async function weeklyPlanning(db, roomId, def, today) {
  const { rows: [w] } = await db.query(
    `SELECT created_at::date AS d, created_by FROM weekly_plans WHERE room_id=$1 ORDER BY created_at DESC LIMIT 1`, [roomId]);
  const result = recurring(w ? w.d : null, def.cadence, def.grace_days, today, today);
  return { ...result, last_done_date: w ? w.d : null, last_done_by: w ? w.created_by : null };
}

async function dailyDiaryPublished(db, roomId, def, today) {
  const { rows: [d1] } = await db.query(
    `SELECT count(*)::int AS n FROM daily_diary dd
       JOIN children c ON c.id = dd.child_id
       WHERE c.room_id=$1 AND dd.date = current_date
         AND (dd.finalised_at IS NOT NULL OR dd.shared_with_parents = true OR dd.status = 'finalised')`, [roomId]);
  const { rows: [last] } = await db.query(
    `SELECT max(dd.date) AS d FROM daily_diary dd JOIN children c ON c.id = dd.child_id
       WHERE c.room_id=$1 AND (dd.finalised_at IS NOT NULL OR dd.shared_with_parents = true OR dd.status = 'finalised')`, [roomId]);
  const doneToday = d1 && d1.n > 0;
  const lastDate = last ? last.d : null;
  if (doneToday) return { state: 'done', last_done_date: ymd(lastDate) };
  const hour = today.getHours();
  return { state: hour < 15 ? 'due_soon' : 'overdue', last_done_date: ymd(lastDate), next_due_date: ymd(today) };
}

async function registerHeadcount(db, roomId, def, today) {
  const { rows: [h] } = await db.query(
    `SELECT completed_at, completed_by FROM room_headcounts
       WHERE room_id=$1 AND scheduled_for::date = current_date AND status = 'completed'
       ORDER BY completed_at DESC LIMIT 1`, [roomId]);
  const { rows: [lastAny] } = await db.query(
    `SELECT max(scheduled_for)::date AS d FROM room_headcounts WHERE room_id=$1 AND status='completed'`, [roomId]);
  if (h) return { state: 'done', last_done_date: ymd(h.completed_at), last_done_by: h.completed_by };
  const hour = today.getHours();
  return { state: hour < 12 ? 'due_soon' : 'overdue', last_done_date: lastAny ? lastAny.d : null, next_due_date: ymd(today) };
}

// ═══════════════════════════════════════════════════════════════════════════
// PER STAFF
// ═══════════════════════════════════════════════════════════════════════════

async function supervision(db, staffId, def, today) {
  const { rows: [s] } = await db.query('SELECT created_at::date AS joined FROM staff WHERE id=$1', [staffId]);
  const { rows: [r] } = await db.query(
    `SELECT conducted_date AS d, supervisor_id FROM supervisions
       WHERE staff_id=$1 AND conducted_date IS NOT NULL ORDER BY conducted_date DESC LIMIT 1`, [staffId]);
  const result = recurring(r ? r.d : null, def.cadence, def.grace_days, today, s ? new Date(s.joined) : today);
  return { ...result, last_done_date: r ? r.d : null, last_done_by: r ? r.supervisor_id : null };
}

async function cpdActivity(db, staffId, def, today) {
  const { rows: [r] } = await db.query(
    `SELECT completion_date AS d FROM cpd_records
       WHERE staff_id=$1 AND completion_date IS NOT NULL ORDER BY completion_date DESC LIMIT 1`, [staffId]);
  const result = recurring(r ? r.d : null, def.cadence, def.grace_days, today, today);
  return { ...result, last_done_date: r ? r.d : null };
}

async function mandatoryTraining(db, staffId, def, today) {
  const { rows } = await db.query(
    `SELECT training_type, completed_date, expiry_date FROM mandatory_training WHERE staff_id=$1`, [staffId]);
  if (!rows.length) return { state: 'overdue', detail: { reason: 'no mandatory training on record' } };
  let soonest = null;
  for (const r of rows) {
    if (r.expiry_date && (!soonest || new Date(r.expiry_date) < new Date(soonest))) soonest = r.expiry_date;
  }
  const lastCompleted = rows.map(r => r.completed_date).filter(Boolean).sort().pop() || null;
  if (!soonest) return { state: 'done', last_done_date: lastCompleted };
  return {
    state: stateFromDue(lastCompleted, soonest, def.grace_days, today),
    last_done_date: lastCompleted, next_due_date: ymd(soonest),
    detail: { expiring_or_expired: rows.filter(r => r.expiry_date && new Date(r.expiry_date) <= addDays(today, 60)).map(r => r.training_type) },
  };
}

async function meetingsAttended(db, staffId, def, today) {
  const { rows: [s] } = await db.query('SELECT created_at::date AS joined FROM staff WHERE id=$1', [staffId]);
  const { rows: [r] } = await db.query(
    `SELECT m.meeting_date AS d FROM cpd_room_meeting_attendees a
       JOIN cpd_room_meetings m ON m.id = a.meeting_id
       WHERE a.staff_id=$1 ORDER BY m.meeting_date DESC LIMIT 1`, [staffId]);
  const result = recurring(r ? r.d : null, def.cadence, def.grace_days, today, s ? new Date(s.joined) : today);
  return { ...result, last_done_date: r ? r.d : null };
}

// ═══════════════════════════════════════════════════════════════════════════
// PER SETTING (subject_id is always 0)
// ═══════════════════════════════════════════════════════════════════════════

// RETIRED by b530 (2026-10-26). The duty_definitions row is is_active=false, so
// this is never called any more; it is left in place (and still correct) so a
// re-activated duty keeps working, and because deleting the function would make
// the registry below lie about what source_key 'staffMeeting' means.
// ladn.duty_staff_meetings has 0 rows and no read route — see src/routes/duties.js.
async function staffMeeting(db, _id, def, today) {
  const { rows: [r] } = await db.query(`SELECT meeting_date AS d, led_by FROM duty_staff_meetings ORDER BY meeting_date DESC LIMIT 1`);
  const result = recurring(r ? r.d : null, def.cadence, def.grace_days, today, addDays(today, -180));
  return { ...result, last_done_date: r ? r.d : null, last_done_by: r ? r.led_by : null };
}

// b530 (2026-10-26): status <> 'planned'. Before b530 every row in this table
// was a meeting that had happened, because the only way to make one was to
// write it up. Wren now puts next week's meeting in the diary by itself, so
// "when did this room last meet" has to ignore the ones that have not happened
// yet — otherwise the duty goes green the moment the rhythm schedules one,
// which is the opposite of what it is for.
async function roomMeeting(db, _id, def, today) {
  let r = null;
  try {
    ({ rows: [r] } = await db.query(
      `SELECT meeting_date AS d, led_by FROM cpd_room_meetings
        WHERE status IN ('held','minutes_written') ORDER BY meeting_date DESC LIMIT 1`));
  } catch (e) {
    // 42703 = the b530 status column is not there yet, on a deploy where the
    // code landed before the migration. Fall back to the pre-b530 question,
    // which was correct while every row was a meeting that had happened.
    if (e.code !== '42703') throw e;
    ({ rows: [r] } = await db.query(
      `SELECT meeting_date AS d, led_by FROM cpd_room_meetings ORDER BY meeting_date DESC LIMIT 1`));
  }
  const result = recurring(r ? r.d : null, def.cadence, def.grace_days, today, addDays(today, -180));
  return { ...result, last_done_date: r ? r.d : null, last_done_by: r ? r.led_by : null };
}

async function fireDrill(db, _id, def, today) {
  const { rows: [r] } = await db.query(`SELECT drill_date AS d, next_drill_due, conducted_by FROM fire_drills ORDER BY drill_date DESC LIMIT 1`);
  if (!r) return { state: 'overdue' };
  return {
    state: stateFromDue(r.d, r.next_drill_due, def.grace_days, today),
    last_done_date: r.d, last_done_by: r.conducted_by, next_due_date: ymd(r.next_drill_due),
  };
}

async function policyReview(db, _id, def, today) {
  const { rows } = await db.query(
    `SELECT title, review_due FROM policies WHERE is_active=true AND review_due IS NOT NULL`);
  if (!rows.length) return { state: 'not_applicable' };
  const overdue = rows.filter(r => new Date(r.review_due) < today);
  const dueSoon = rows.filter(r => {
    const days = Math.round((new Date(r.review_due) - today) / 86400000);
    return days >= 0 && days <= 30;
  });
  const nextDue = rows.map(r => r.review_due).sort()[0];
  if (overdue.length) return { state: 'overdue', next_due_date: ymd(nextDue), detail: { overdue: overdue.map(r => r.title) } };
  if (dueSoon.length) return { state: 'due_soon', next_due_date: ymd(nextDue), detail: { due_soon: dueSoon.map(r => r.title) } };
  return { state: 'done', next_due_date: ymd(nextDue) };
}

async function kitchenChecks(db, _id, def, today) {
  const { rows: [r] } = await db.query(
    `SELECT count(*)::int AS n FROM kitchen_sfbb_log WHERE date = current_date`);
  const { rows: [last] } = await db.query(`SELECT max(date) AS d FROM kitchen_sfbb_log`);
  if (r && r.n > 0) return { state: 'done', last_done_date: ymd(today) };
  const hour = today.getHours();
  return { state: hour < 11 ? 'due_soon' : 'overdue', last_done_date: last ? last.d : null, next_due_date: ymd(today) };
}

module.exports = {
  progressCheckTwo, twoYearCheckShared, progressReport, keyPersonAssigned, nextStepsSet,
  observationRecency, accidentFormSigned, medicineFormSigned, parentChat, abcObservation, ehcpPaperwork,
  termlyPlanPublished, weeklyPlanning, dailyDiaryPublished, registerHeadcount,
  supervision, cpdActivity, mandatoryTraining, meetingsAttended,
  staffMeeting, roomMeeting, fireDrill, policyReview, kitchenChecks,
  stateFromDue, ymd,
};
