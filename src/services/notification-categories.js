'use strict';

// Canonical list of notification event categories.
// channels: default channels for this category
// urgent: true = high priority, telegram preferred
// managerOnly: true = only shown in manager-role preset

const CATEGORIES = {
  staff_sick:                { label: 'Staff Called In Sick',         urgent: false, managerOnly: false },
  staff_late:                { label: 'Staff Clock-In Late',          urgent: false, managerOnly: false },
  staff_absent_unauthorised: { label: 'Unauthorised Staff Absence',   urgent: false, managerOnly: false },
  course_completed:          { label: 'CPD Course Completed',         urgent: false, managerOnly: false },
  course_due:                { label: 'CPD Course Expiring Soon',     urgent: false, managerOnly: false },
  medicine_given:            { label: 'Medicine Administered',        urgent: false, managerOnly: false },
  medicine_due:              { label: 'Medicine Scheduled',           urgent: false, managerOnly: false },
  safeguarding_logged:       { label: 'Safeguarding Concern Logged',  urgent: true,  managerOnly: false },
  safeguarding_assigned:     { label: 'Safeguarding Concern Assigned',urgent: true,  managerOnly: false },
  incident_reported:         { label: 'Incident Reported',           urgent: false, managerOnly: false },
  incident_severe:           { label: 'Severe Incident',              urgent: true,  managerOnly: false },
  parent_message_received:   { label: 'Parent Message',               urgent: false, managerOnly: false },
  parent_message_urgent:     { label: 'Urgent Parent Message',        urgent: true,  managerOnly: false },
  funding_decision:          { label: 'Funding Decision',             urgent: false, managerOnly: false },
  supervision_due:           { label: 'Supervision Due',              urgent: false, managerOnly: false },
  supervision_scheduled:     { label: 'Supervision Scheduled',        urgent: false, managerOnly: false },
  dbs_expiring:              { label: 'DBS Expiring',                 urgent: false, managerOnly: false },
  contract_action_required:  { label: 'Contract Action Required',     urgent: false, managerOnly: false },
  room_ratio_breach:         { label: 'Room Ratio Breach',            urgent: true,  managerOnly: false },
  child_arrived:             { label: 'Key Child Arrived',            urgent: false, managerOnly: false },
  child_departed:            { label: 'Key Child Departed',           urgent: false, managerOnly: false },
  payment_received:          { label: 'Payment Received',             urgent: false, managerOnly: false },
  payment_overdue:           { label: 'Payment Overdue',              urgent: false, managerOnly: false },
  system_critical:           { label: 'System Critical Alert',        urgent: true,  managerOnly: true  },
  doorbell_pressed:          { label: 'Doorbell — Front Entrance',    urgent: true,  managerOnly: false },
  termly_update_due:         { label: 'Progress Update Due (key child)', urgent: false, managerOnly: false },
  termly_update_summary:     { label: 'Progress Updates Outstanding',    urgent: false, managerOnly: true  },
  termly_review_due:         { label: 'Termly Key-Child Reviews Due',   urgent: false, managerOnly: false },
  // b181 (2026-08-19) — last week of term: the termly plan's group evaluation
  // (one per term per room) plus the per-child evaluations are now due.
  termly_plan_evaluation_due:{ label: 'Termly Plan Evaluation Due',     urgent: false, managerOnly: false },
  // b322 (2026-09-11) — the Ealing CPD catalogue. Two categories, not one,
  // because they point in opposite directions: the request goes UP to whoever
  // sorts out cover, the answer comes back DOWN to the person who asked.
  cpd_request_pending:       { label: 'CPD Request Awaiting Approval', urgent: false, managerOnly: true  },
  cpd_request_decided:       { label: 'Your CPD Request Answered',     urgent: false, managerOnly: false },
  email_gateway_pending:     { label: 'Staff Email Awaiting Approval', urgent: true,  managerOnly: true  },
  email_gateway_reply:       { label: 'Reply To Your Gateway Email',   urgent: false, managerOnly: false },
  email_gateway_result:      { label: 'Your Email Approval Result',    urgent: false, managerOnly: false },
  parent_reported_absence:  { label: 'Parent-Reported Absence/Holiday', urgent: false, managerOnly: false },
  headcount_due:             { label: 'Room Headcount Due',            urgent: false, managerOnly: false },
  headcount_missed:          { label: 'Room Headcount Missed',         urgent: true,  managerOnly: true  },
  parent_app_feedback:       { label: 'Parent App Feedback',           urgent: false, managerOnly: true  },
  // inset-20261026 — the INSET-day agenda in the HR app. In-app (+ push) only; never emailed.
  inset_feedback:            { label: 'INSET Agenda Feedback',         urgent: false, managerOnly: true  },
  inset_agenda:              { label: 'INSET Agenda Ready To Read',    urgent: false, managerOnly: false },

  // b530 (2026-10-26) — room meetings, owned by the room leader. THREE
  // categories, not one, because they point at different people and a single
  // mute would be the wrong size for all three:
  //   room_meeting_tomorrow      → the ROOM LEADER, the day before their own meeting
  //   room_meeting_minutes_due   → the ROOM LEADER again, minutes late by 2 working days
  //   room_meeting_room_overdue  → the MANAGERS, a room silent for 2 weeks
  // None is managerOnly except the last: a room leader is not a manager in
  // ROLE_SATISFIES, and the first two are addressed to them. None is urgent —
  // these are nudges about next Wednesday, not a ratio breach — and all three
  // are in INAPP_ONLY_CATEGORIES below, which is what keeps them off Telegram.
  room_meeting_tomorrow:     { label: 'Your Room Meeting Is Tomorrow',  urgent: false, managerOnly: false },
  room_meeting_minutes_due:  { label: 'Room Meeting Minutes To Write',  urgent: false, managerOnly: false },
  room_meeting_room_overdue: { label: 'A Room Has Not Met In 2 Weeks',  urgent: false, managerOnly: true  },

  // b149 — categories that were firing via notify() but were missing from this
  // catalog (invisible to the settings UI / role presets until now).
  task_reminder:             { label: 'Task Reminder',                urgent: false, managerOnly: false },
  staff_clock_forgot_in:     { label: 'Forgot To Clock In',           urgent: false, managerOnly: false },
  staff_clock_forgot_out:    { label: 'Forgot To Clock Out',          urgent: false, managerOnly: false },
  reports:                   { label: 'Report Ready',                 urgent: false, managerOnly: false },
  call_escalated:            { label: 'Call Escalated',               urgent: true,  managerOnly: true  },
  funding_declaration_signed:{ label: 'Funding Declaration Signed',   urgent: false, managerOnly: false },
  message_received:          { label: 'New Message',                  urgent: false, managerOnly: false },
  rota_open_shift:           { label: 'Open Shift Available',         urgent: false, managerOnly: false },
  rota_published:            { label: 'Rota Published',               urgent: false, managerOnly: false },
  toil_used:                 { label: 'TOIL Used',                    urgent: false, managerOnly: false },

  // b151 — chat-created reminders ("remind me to..."). Deliberately NOT in
  // DIGEST_DEFAULT_CATEGORIES below: unlike task_reminder (a repeated nag,
  // correctly batched), an ai_reminder fires exactly once at the moment the
  // user asked for — digesting it to next-day 08:00 would silently break the
  // one thing the feature promises ("remind me Friday at 5pm").
  ai_reminder:               { label: 'AI Reminder',                  urgent: false, managerOnly: false },

  // b331 (2026-09-15) — the kitchen. Manager-only: these go to Toby alone
  // (settings.kitchen_alert_staff_id, default 1) — never to parents or other staff.
  kitchen_check_missed:      { label: 'Kitchen Checks Missed',        urgent: true,  managerOnly: true  },
  kitchen_sensor_problem:    { label: 'Fridge/Freezer Probe Problem', urgent: true,  managerOnly: true  },

  // b366 (2026-09-29) — attendance triggers. TWO categories, pointing in
  // opposite directions and gated differently, which is the whole safety
  // property of the feature:
  //   hr_warning_stage_reached → the MANAGER, when a draft appears. Manager-only.
  //   hr_warning_issued        → the STAFF MEMBER, and only ever after a manager
  //                              has approved that specific draft. Nothing in the
  //                              nightly sweep can raise it.
  // Collapsing these into one category would make it one bad `recipientType`
  // away from telling somebody they have a warning that no human has read.
  hr_warning_stage_reached:  { label: 'Attendance Trigger Reached',   urgent: false, managerOnly: true  },
  hr_warning_issued:         { label: 'Attendance Letter For You',    urgent: false, managerOnly: false },

  // Moderation review queue (new/unqualified staff can't publish directly — see
  // observations.js review-queue routes). observation_pending_review goes to the
  // room's reviewers (managers/deputy/room leader), NOT all-staff. observation_returned
  // goes to the original author only. observation_published / report_shared are the
  // staff-side ping when something becomes visible to parents — scoped to the child's
  // key_person_id only (falls back to all-managers if the child has no key person set),
  // never all-staff.
  observation_pending_review: { label: 'Observation Awaiting Review', urgent: false, managerOnly: true  },
  observation_returned:       { label: 'Observation Returned To You', urgent: false, managerOnly: false },
  observation_published:      { label: 'Child Update Published',      urgent: false, managerOnly: false },
  report_shared:               { label: 'Report Shared With Parents', urgent: false, managerOnly: false },

  // b170 — always-on staff knowledge: manager assigns a termly knowledge-check topic.
  knowledge_check_due:        { label: 'Knowledge Check Assigned',    urgent: false, managerOnly: false },

  // b184 — waiting-list viewings + the automatic calendar reminders they create.
  // viewing_booked fires once, at booking, to the staff put on the viewing.
  // event_reminder is the 24h/1h nudge for ANY event with assigned staff — NOT
  // digested: a reminder rolled up to next-day 08:00 is no longer a reminder.
  viewing_booked:             { label: 'Viewing Booked',             urgent: false, managerOnly: false },
  event_reminder:             { label: 'Event Reminder',             urgent: false, managerOnly: false },
  compliance_expiry:          { label: 'Compliance Expiring/Overdue', urgent: false, managerOnly: true  }, // b186 — SCR sweep: DBS, RTW, visa, training, policy review, supervision, induction
  report_card_monthly:        { label: 'Monthly Setting Report Card',  urgent: false, managerOnly: true  }, // b187 — monthly readiness snapshot summary (internal indicator, NOT an Ofsted grade)

  // b189 — off-ratio accountability. Addressed to the ROOM LEADER (so managerOnly is
  // false): it asks the person who ran the room how the extra time was used. NOT
  // urgent — a next-morning reflection, not an alarm. Being over ratio is usually
  // deliberate and good; this only makes it visible.
  offratio_account_due:       { label: 'Off-Ratio Time To Account For', urgent: false, managerOnly: false },

  // b185 — the owner monthly digest (occupancy, staffing, CPD, practice headline,
  // finance, compliance counts). The EMAIL goes to the owner alone; this in-app
  // copy is manager-only so the month's figures also exist inside Wren.
  owner_digest_monthly:       { label: 'Owner Monthly Digest',          urgent: false, managerOnly: true  },

  // b206 — room moves (Baby Room → Pre-school the Monday after the 2nd birthday).
  // Goes to the CHILD'S KEY PERSON as well as the manager, which is why managerOnly
  // is false: the notice period exists so the receiving room can prepare and the
  // key person can tell the parents. One notification per child per move — the
  // dedupe lives in ladn.room_move_log, not here.
  room_move:                  { label: 'Room Move (child changing room)', urgent: false, managerOnly: false },

  // b209 — staff tasks assigned with a deadline. Deliberately THREE new keys
  // rather than reusing task_reminder, because task_reminder is in
  // DIGEST_DEFAULT_CATEGORIES below: it is the legacy drainer's repeated nag
  // about your own to-do list, correctly batched to 08:00 the next day. A b209
  // reminder is the opposite — a scheduled one-shot at a lead time the manager
  // chose ("1 hour before the medication audit is due"), and rolling it into
  // tomorrow's digest would silently break the only thing it promises.
  // b218 — you own an EYFS area. Near the end of a half-term this asks for two
  // things at once: the contribution (what you have noticed, what you'd change)
  // and the tick-list of intentions Wren has gathered from every child's current
  // next steps. ONE category, because it is one visit to one screen — and NOT
  // manager-only: it is addressed to the practitioner who owns the area.
  area_contribution_due:      { label: 'Your Area — Termly Contribution Due', urgent: false, managerOnly: false },

  // b231 — statutory framework change. The EYFS framework applying from
  // 1 September 2026 is the first one Wren has been live through, and the
  // existing legislation WATCHER only ever said "a gov.uk page moved". These
  // three say what it means for this setting.
  //
  // All manager-only and all urgent: a framework coming into force is a hard
  // legal deadline, not a nudge, and a practitioner cannot act on it. They are
  // deliberately NOT folded into the existing `compliance_expiry` category —
  // that one is the rolling DBS/training/supervision sweep, which a manager
  // triages weekly. Burying "the law changes in 7 days" inside it would be the
  // exact failure Toby is asking us to avoid.
  framework_effective:        { label: 'Statutory Framework Taking Effect', urgent: true,  managerOnly: true  },
  policy_must_change:         { label: 'Policy Must Change (framework)',    urgent: true,  managerOnly: true  },
  legislation_change:         { label: 'Legislation Changed (non-cosmetic)', urgent: true, managerOnly: true  },

  // b243 — a parent has booked their 2-2.5 year health visitor review and Wren
  // has drafted the statutory progress check at age two. It goes to the child's
  // KEY PERSON (falling back to the room lead, then managers), which is why it is
  // not managerOnly: the practitioner who knows the child is the one who has to
  // read, edit and sign it. Urgent because the document is only useful if it is
  // in the family's hand before the appointment they have already booked.
  two_year_check_draft:       { label: '2-Year Check Ready To Review',   urgent: true,  managerOnly: false },

  // b246 — a keyperson opened a child's termly update and the local model has
  // drafted the five sections from that child's own records. Not managerOnly and
  // not urgent: it is the key person's own work coming back to them, on a cycle
  // that runs to Ealing's half-terms, and the deadline is a fortnight into term
  // rather than an appointment somebody has already booked.
  termly_update_draft:        { label: 'Progress Update Ready To Review', urgent: false, managerOnly: false },

  // b277 — end of a half-term with next steps still open. Not urgent and not
  // manager-only: it is the key person's own list, and the whole point is that
  // it arrives with time left to act on it (14 days by default). It goes quiet
  // the moment there is nothing open.
  termly_next_steps_due:      { label: 'Next Steps Open At End Of Term', urgent: false, managerOnly: false },

  // b277 — the half-term's termly-update report: who was owed one, who sent one,
  // who was late and by how long. managerOnly, because it names one
  // practitioner's lateness to another; that is a supervision conversation.
  termly_update_report:       { label: 'Progress Update Report (end of half-term)', urgent: false, managerOnly: true },

  task_assigned:              { label: 'Task Assigned To You',           urgent: false, managerOnly: false },
  task_due:                   { label: 'Task Due Soon',                  urgent: false, managerOnly: false },
  // The one-shot overdue escalation. managerOnly: it is addressed to whoever
  // has to chase, never to the person who is already late.
  task_overdue:               { label: 'Task Overdue (escalation)',      urgent: true,  managerOnly: true  },
  // b501 (Tasks v2) — the accountability pair. task_nudge is the ONE daily nudge to the person who owes the work;
  // task_escalated goes once to whoever assigned it and to the person's line manager (so NOT managerOnly: a room leader
  // is a line manager). Neither is on the staff email allowlist — a task title can name a child.
  // b503 — "your briefing is ready". Counts only (see src/lib/briefing-delivery.js); the briefing itself names children and is read inside Wren.
  briefing_ready:             { label: 'Briefing ready (weekly / monthly / termly)', urgent: false, managerOnly: false },
  task_nudge:                 { label: 'Task Overdue (daily nudge)',     urgent: true,  managerOnly: false },
  task_escalated:             { label: 'Task Overdue (escalated to you)', urgent: true,  managerOnly: false },

  // ── b309 (2026-09-10) — overtime, fit notes and document signing ─────────
  // Registered here for the same reason b149 registered its seven: a category
  // that fires through notify() but is absent from this catalog is INVISIBLE to
  // the settings screen and to every role preset, so nobody can turn it off and
  // nobody knows it exists. Additive — no existing entry is changed.
  overtime_requested:         { label: 'Overtime Claimed',               urgent: false, managerOnly: true  },
  overtime_approved:          { label: 'Your Overtime Was Approved',     urgent: false, managerOnly: false },
  overtime_declined:          { label: 'Your Overtime Was Declined',     urgent: false, managerOnly: false },
  // A fit note is special-category medical data. managerOnly, and note that the
  // BODY of this notification deliberately says only that a document exists —
  // never the filename, never a condition. See the header of the proof block in
  // src/routes/absence.js.
  absence_proof_uploaded:     { label: 'Proof Of Absence Attached',      urgent: false, managerOnly: true  },
  document_to_sign:           { label: 'A Document Needs Your Signature', urgent: false, managerOnly: false },
  document_to_read:           { label: 'A Document Needs Acknowledging', urgent: false, managerOnly: false },
  document_signed:            { label: 'Document Signed',                urgent: false, managerOnly: true  },

  // ── b311 (2026-09-10) — the signals ─────────────────────────────────────
  // One category per signal, for the same reason b149 and b309 registered
  // theirs: a category that fires through notify() but is absent from this
  // catalog is invisible to the settings screen and to every role preset, so
  // nobody can turn it off and nobody knows it exists.
  //
  // A signal is NOT a reminder. It only speaks when the data says something is
  // wrong or about to be, so none of these is `urgent` — urgency here would put
  // a Telegram on a manager's phone for a prediction, which is the noise this
  // build exists to avoid. All managerOnly except the safeguarding one, which
  // is addressed to the DSL by name and so is not a "manager preset" question
  // at all (see recipients:'dsl' in src/lib/signals/stale-safeguarding.js).
  //
  // Per-signal muting lives in ladn.signal_state and is set from Roost →
  // Signals. These entries are the SECOND, per-staff, layer: a deputy who does
  // not want the occupancy forecast in their own bell can turn just that off.
  signal_ratio_risk:          { label: 'Signal — A day ahead that fails ratios', urgent: false, managerOnly: true  },
  signal_safeguarding_stale:  { label: 'Signal — Open concern with no recorded action', urgent: false, managerOnly: false },
  signal_invoice_run:         { label: 'Signal — Invoice run coming up',   urgent: false, managerOnly: true  },
  signal_payroll_run:         { label: 'Signal — Pay day coming up',       urgent: false, managerOnly: true  },
  signal_funding_headcount:   { label: 'Signal — Funding headcount due',   urgent: false, managerOnly: true  },
  signal_website_stale:       { label: 'Signal — Public site out of date', urgent: false, managerOnly: true  },
  signal_child_record_gap:    { label: 'Signal — Missing details on the roll', urgent: false, managerOnly: true  },
  signal_observation_gap:     { label: 'Signal — Children past the observation gap', urgent: false, managerOnly: true  },
  signal_occupancy_forecast:  { label: 'Signal — Occupancy months ahead',  urgent: false, managerOnly: true  },
  // b317 (2026-09-11) — an apprentice is behind their off-the-job hours. Not
  // urgent, and deliberately so: the whole value of it is that it says so MONTHS
  // before the end date, which is precisely when it should not buzz a phone.
  signal_apprentice_otj:      { label: 'Signal — Apprentice behind on off-the-job hours', urgent: false, managerOnly: true  },
  // ── b365 (2026-09-29) — the four money signals ───────────────────────────
  // All manager-only and none urgent. A business that is 3% over on its wage
  // ratio does not need a phone to buzz; it needs somebody to notice within the
  // week. signal_debt_ageing deliberately carries a COUNT and a TOTAL and never
  // a family name — the names live on the chase list, behind the finance guard.
  signal_empty_space:         { label: 'Signal — Empty space in a room',   urgent: false, managerOnly: true  },
  signal_supplier_rise:       { label: 'Signal — A supplier or cost is climbing', urgent: false, managerOnly: true  },
  signal_debt_ageing:         { label: 'Signal — Invoices ageing past due', urgent: false, managerOnly: true  },
  signal_wage_ratio:          { label: 'Signal — Wage bill above its share of fees', urgent: false, managerOnly: true  },
  // Sent once, when a signal mutes itself. Hard rule 3: a signal never goes
  // quiet without saying that it has.
  signal_muted_itself:        { label: 'Signal — Wren muted a signal',     urgent: false, managerOnly: true  },

  // ── b364 (2026-09-29) — an email landed in a section marked urgent ────────
  // urgent:true on purpose, unlike the signals above, and for the opposite
  // reason: a signal is a PREDICTION and does not deserve a phone buzz, but a
  // parent's email that is sitting unanswered is a real person waiting. The
  // default urgent sections are Parents, Ealing and Finance
  // (settings.inbox_urgent_sections), so this fires for the mail Toby said he
  // wants to hear about and nothing else.
  //
  // managerOnly is not the access rule — src/lib/inbox-alerts.js sends only to
  // people on settings.comms_manager_staff_ids who hold a grant for THAT
  // mailbox, which is narrower than any role. This flag only keeps the category
  // out of a practitioner's settings screen, where it would be a switch with
  // nothing behind it.
  //
  // The Telegram text is name + section + one-line gist. Never the body: see the
  // reasoning at the top of src/lib/inbox-alerts.js, and note this category is
  // on EMAIL_BLOCKED_CATEGORIES so Wren cannot email about an email.
  inbox_urgent_email:         { label: 'Email In An Urgent Section',      urgent: true,  managerOnly: true  },

  // b312 (2026-09-10) — the handbook consultation nudge. Registered here rather
  // than left unlisted for two reasons, and only the second is about the
  // settings UI:
  //   1. urgent:false is what makes it IN-APP ONLY. The presets below give a
  //      non-urgent category ['inapp'] and an urgent one ['telegram','inapp'].
  //      A nudge about reading a booklet must never buzz somebody's Telegram,
  //      and leaving the category unlisted would have got the same result by
  //      accident rather than on purpose.
  //   2. managerOnly:false so it appears in a practitioner's own notification
  //      settings and can be switched off by the person receiving it. Being
  //      chased about a consultation you have decided not to answer is exactly
  //      the kind of thing somebody should be able to turn off themselves.
  // Email is refused separately and unconditionally: the allowlist in
  // notification-dispatcher.js fails closed and this category is not on it.
  consultation_nudge:         { label: 'Consultation — chapters still to read', urgent: false, managerOnly: false },

  // b335 (2026-09-15) — one daily read instead of a stream. Carries duties
  // overdue by room (b334), pathway stages overdue by child (b335's own
  // child_pathways), and anything statutory approaching — see
  // scripts/b335-manager-digest.js. managerOnly and not urgent: it still
  // reaches the manager once a day (telegram+inapp, same as every other
  // managerOnly category on the admin/manager preset below), but it replaces
  // several per-event categories rather than adding to them — see that
  // script's header for exactly which ones, and why two others were
  // deliberately left alone.
  manager_daily_digest:       { label: 'Daily Digest — Duties, Pathways & Statutory', urgent: false, managerOnly: true },
  // b346 — the finance calendar. Heads-up at OUR date (in-app), urgent when the statutory date is near or gone.
  finance_deadline:           { label: 'Finance deadline — coming up',     urgent: false, managerOnly: true },
  finance_deadline_red:       { label: 'Finance deadline — due or overdue', urgent: true,  managerOnly: true },
  // b524 — Ealing funding that did not arrive, or arrived short. Urgent, and
  // therefore on Telegram for a manager: in July 2026 the under-2s money did not
  // come and nobody noticed for weeks, which is the only reason this category
  // exists. It carries the claim MONTH and the AMOUNT and nothing else — no
  // child, no family, no age band broken down to a number small enough to
  // identify anyone. The age-band split lives on the Accounts screen, behind the
  // finance guard.
  funding_receipt_short:      { label: 'Ealing funding — short or missing',  urgent: true,  managerOnly: true },
};

const CATEGORY_KEYS = Object.keys(CATEGORIES);

// b149 — categories that must never be fully muted ('off'). Users can still
// choose between inapp / inapp_push / digest, just not silence them entirely.
// Mirrored by a DB CHECK constraint on user_notification_prefs (defence in depth).
const COMPLIANCE_LOCKED_CATEGORIES = [
  'safeguarding_logged', 'safeguarding_assigned', 'incident_severe',
  'room_ratio_breach', 'system_critical', 'headcount_missed',
];

function isComplianceLocked(category) {
  return COMPLIANCE_LOCKED_CATEGORIES.includes(category);
}

// b149 — categories that flood the bell with a fresh notify() per re-check
// (task reminders re-fire every cooldown window per task; clock reminders
// re-fire every cooldown window per staff member) default to a daily digest
// instead of inapp_push. Everything else defaults to inapp_push. Used both by
// the one-time seed migration and as the dispatcher's live fallback when no
// explicit user_notification_prefs row exists (e.g. a staff member created
// after the migration ran).
const DIGEST_DEFAULT_CATEGORIES = ['task_reminder', 'staff_clock_forgot_in'];

function defaultModeForCategory(category) {
  return DIGEST_DEFAULT_CATEGORIES.includes(category) ? 'digest' : 'inapp_push';
}

function getCategoryMeta(category) {
  return CATEGORIES[category] || { label: category, urgent: false, managerOnly: false };
}

// b312 (2026-09-10) — categories that must never reach Telegram, whatever the
// role. The manager/admin branch below hands EVERY category ['telegram','inapp']
// rather than honouring CATEGORIES[k].urgent the way the room_leader branch
// does. That is left exactly as it is — sixty categories depend on it — but it
// means a category whose whole point is "a gentle in-app nudge" would buzz a
// manager's phone the moment anybody pressed "reset to role defaults".
//
// This set is the narrow exception, not a change to the rule: named categories
// get ['inapp'] in every branch. Add to it only for something that is by
// definition not urgent and not personal to the recipient's phone.
const INAPP_ONLY_CATEGORIES = new Set([
  'consultation_nudge',   // "you have four chapters left" is never a phone buzz
  'inset_feedback',       // inset-20261026 — "the room leader commented on the INSET agenda": the bell, not Telegram
  'inset_agenda',         // inset-20261026 — "the INSET agenda is ready": the bell (and push if subscribed)
  // b530 — the brief is explicit: "In-app nudges only (NO email, NO Telegram)".
  // These three are the only enforcement of the Telegram half, and as of b530
  // the dispatcher reads this set at dispatch time as well as at preset time,
  // so an old preference row cannot route one to a phone either.
  'room_meeting_tomorrow',
  'room_meeting_minutes_due',
  'room_meeting_room_overdue',
]);

// Default presets by role — returns array of {event_category, channels, scope}
function defaultPresetForRole(role) {
  const urgentChans = ['telegram', 'inapp'];
  const normalChans = ['inapp'];

  const urgentCats = CATEGORY_KEYS.filter(k => CATEGORIES[k].urgent);

  if (['manager', 'admin'].includes(role)) {
    return CATEGORY_KEYS.map(k => ({
      event_category: k,
      channels: INAPP_ONLY_CATEGORIES.has(k) ? normalChans : urgentChans,
      enabled: true,
      scope: 'all',
    }));
  }

  if (role === 'room_leader') {
    return CATEGORY_KEYS
      .filter(k => !['payment_received','payment_overdue','system_critical'].includes(k))
      .map(k => ({
        event_category: k,
        channels: CATEGORIES[k].urgent ? urgentChans : normalChans,
        enabled: true,
        scope: 'all',
      }));
  }

  if (role === 'practitioner') {
    const included = [
      'course_due','course_completed','knowledge_check_due',
      'supervision_due','supervision_scheduled',
      'parent_message_received','incident_reported','incident_severe',
      'medicine_given','medicine_due','safeguarding_assigned',
      'child_arrived','child_departed',
      'termly_update_due',
      'doorbell_pressed',
      'area_contribution_due',   // b218 — addressed to the practitioner who owns the area
    ];
    return included.map(k => {
      let scope = 'all';
      if (['parent_message_received','incident_reported','incident_severe','medicine_given','medicine_due'].includes(k)) scope = 'my_room';
      if (['child_arrived','child_departed','termly_update_due'].includes(k)) scope = 'my_keychildren';
      return {
        event_category: k,
        channels: CATEGORIES[k]?.urgent ? urgentChans : normalChans,
        enabled: true,
        scope,
      };
    });
  }

  // apprentice — same as practitioner but inapp only
  if (role === 'apprentice') {
    const included = [
      'course_due','course_completed','knowledge_check_due','supervision_due','supervision_scheduled',
      'parent_message_received','incident_severe','medicine_given','safeguarding_assigned',
    ];
    return included.map(k => ({
      event_category: k,
      channels: normalChans,
      enabled: true,
      scope: ['parent_message_received','medicine_given'].includes(k) ? 'my_room' : 'all',
    }));
  }

  return [];
}


// ── b212: which portal does each category belong to? ─────────────────────────
// Purely presentational: it groups the 62 categories on the notification
// settings screen so a manager can reason about "everything the parents app
// pings us about" instead of scrolling one flat list. It changes NO routing —
// every notification still goes to staff, wherever it originated. A category
// missing from this map falls back to 'roost', so adding a category without
// touching this file degrades gracefully rather than vanishing from settings.
const CATEGORY_PORTALS = {
  nest: [
    'medicine_given','medicine_due','incident_reported','incident_severe',
    'safeguarding_logged','safeguarding_assigned','child_arrived','child_departed',
    'room_ratio_breach','headcount_due','headcount_missed','doorbell_pressed',
    'observation_pending_review','observation_returned','observation_published',
    'termly_update_due','termly_update_summary','termly_review_due',
    'termly_plan_evaluation_due','report_shared','knowledge_check_due',
    'offratio_account_due','room_move','event_reminder',
    'area_contribution_due',   // b218 — area of responsibility: contribution + intentions
    'two_year_check_draft',    // b243 — statutory 2-year check drafted, waiting on the key person
    'termly_update_draft',     // b246 — progress update drafted, waiting on the key person
    'termly_next_steps_due',   // b277 — half-term ending with next steps still open
    'termly_update_report',    // b277 — the half-term's staff report on progress updates
    // b312 — the handbook consultation nudge. Nest, not Roost: the booklet is a
    // page on the EY portal and the nudge links straight into it, so it belongs
    // in the group a practitioner recognises. Purely presentational, as the
    // note above this map says. Additive.
    'consultation_nudge',
  ],
  egg: [
    'parent_message_received','parent_message_urgent','message_received',
    'parent_reported_absence','parent_app_feedback','funding_declaration_signed',
    'email_gateway_pending','email_gateway_reply','email_gateway_result',
    'viewing_booked','call_escalated',
  ],
  seed: [
    'staff_sick','staff_late','staff_absent_unauthorised','course_completed',
    'course_due','supervision_due','supervision_scheduled','dbs_expiring',
    'contract_action_required','staff_clock_forgot_in','staff_clock_forgot_out',
    'rota_open_shift','rota_published','toil_used','compliance_expiry',
    // b309 — all six belong to Seed (staff & HR), beside toil_used and the
    // clock-in pair they sit next to in the product. Additive.
    'overtime_requested','overtime_approved','overtime_declined',
    'absence_proof_uploaded','document_to_sign','document_to_read','document_signed',
    // b530 — room meetings. Seed (staff & HR): a room meeting is the team's own
    // CPD and accountability, which is where supervision_due and course_due
    // already sit. The manager escalation is filed here too, beside staff_sick,
    // because it is about a colleague's work rather than about the business.
    'room_meeting_tomorrow','room_meeting_minutes_due','room_meeting_room_overdue',
  ],
  roost: [
    'funding_decision','payment_received','payment_overdue','system_critical',
    'reports','report_card_monthly','owner_digest_monthly','ai_reminder',
    'task_assigned','task_due','task_overdue','task_reminder','task_nudge','task_escalated','briefing_ready',
    // b311 — the signal categories (b317 added the eleventh). Filed under Roost
    // because a signal is a management prediction about the business, whatever part of the nursery
    // the data came from: the settings screen groups them together so a manager
    // can reason about "everything Wren tells me before I ask" in one block.
    // Additive — nothing above is changed, and portalForCategory() already
    // defaults to 'roost', so this listing is for legibility rather than
    // routing.
    'signal_ratio_risk','signal_safeguarding_stale','signal_invoice_run',
    'signal_payroll_run','signal_funding_headcount','signal_website_stale',
    'signal_child_record_gap','signal_observation_gap','signal_occupancy_forecast',
    'signal_apprentice_otj',
    // b365 — the money signals. Roost for the same reason as the rest: they are
    // predictions about the business, not events on the room floor.
    'signal_empty_space','signal_supplier_rise','signal_debt_ageing','signal_wage_ratio',
    'signal_muted_itself',
    'manager_daily_digest',   // b335 — filed beside the signals: a daily prediction/summary, not a room-floor event.
    'finance_deadline','finance_deadline_red',   // b346 — tax & filing deadlines. Roost: it is the company's finance, not the room floor.
    'funding_receipt_short',  // b524 — an Ealing claim that was not paid, or was paid short. Roost: it is a receivable, not a room-floor event.
    'inbox_urgent_email',     // b364 — mail in an urgent section. Roost: the shared inbox is a management screen.
  ],
};

const PORTAL_LABELS = {
  nest:  { label: 'Nest — room floor',   hint: 'Children, medicine, safeguarding, observations, the door' },
  egg:   { label: 'Egg — parents',       hint: 'Messages, absences, feedback, enquiries and viewings' },
  seed:  { label: 'Seed — staff & HR',   hint: 'Absence, clock-ins, CPD, supervisions, rota, compliance' },
  roost: { label: 'Roost — management',  hint: 'Finance, tasks, reports and system alerts' },
};

const _PORTAL_OF = (() => {
  const m = {};
  for (const [portal, keys] of Object.entries(CATEGORY_PORTALS)) for (const k of keys) m[k] = portal;
  return m;
})();

/** Portal a category is filed under on the settings screen. Defaults to 'roost'. */
function portalForCategory(key) { return _PORTAL_OF[key] || 'roost'; }

/**
 * b530 — is this category in-app only? Exported so the DISPATCHER can enforce
 * it, not just defaultPresetForRole(). Before b530 the set was read at "reset
 * to role defaults" time only, so a preference row written before a category
 * joined the set would still route it to Telegram — which for a nudge about
 * next Wednesday's meeting is exactly the thing the set exists to prevent.
 */
function isInAppOnly(category) { return INAPP_ONLY_CATEGORIES.has(String(category || '')); }

module.exports = {
  CATEGORY_PORTALS, PORTAL_LABELS, portalForCategory,
  CATEGORIES, CATEGORY_KEYS, getCategoryMeta, defaultPresetForRole,
  COMPLIANCE_LOCKED_CATEGORIES, isComplianceLocked, defaultModeForCategory,
  INAPP_ONLY_CATEGORIES, isInAppOnly,
};
