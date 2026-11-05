'use strict';

/**
 * b230 (2026-08-25) — the notification centre's tab taxonomy.
 *
 * `notifications.category` is a free-text varchar(40). Two things write it:
 *   1. the dispatcher, using a key from notification-categories.js CATEGORIES
 *   2. older route code, INSERTing straight into ladn.notifications with a
 *      short ad-hoc word ('policy', 'medicine', 'collection', 'automation'…)
 *
 * Both are real and both appear in the bell. This file is the ONE place that
 * decides which tab a category lands on, so the API's counts and the screen's
 * filters can never disagree — they read the same map.
 *
 * RULE (Toby, b230): every tab must correspond to a category that actually
 * fires. The tabs below were derived from a census of live data, not invented:
 *
 *   wren_dev  ladn.notifications → 55 distinct categories
 *   wren      ladn.notifications → 24 distinct categories
 *   src/ + editions/ + scripts/  → 38 distinct notify()/notifyAsync() keys
 *
 * That census is also why there is NO "Documents" tab even though EyLog has
 * one: nothing in Wren has ever emitted a document notification. Adding the
 * tab would have meant shipping a permanently empty screen.
 */

const { CATEGORIES } = require('./notification-categories');

// tone drives the row tint on the centre + the dropdown. Never colour alone —
// every tone also carries a label/icon (see sections/notifications.html).
//   critical → red     (safeguarding, severe incident)
//   warn     → amber   (money owed, ratio/headcount, overdue)
//   info     → blue    (system, product-ish, reports)
//   neutral  → default surface
const TABS = [
  { key: 'all',           label: 'All',                icon: '🔔', tone: 'neutral' },
  { key: 'safeguarding',  label: 'Safeguarding',       icon: '🛡️', tone: 'critical' },
  { key: 'accidents',     label: 'Accidents & incidents', icon: '🚑', tone: 'warn' },   // acc-tab-20261103
  { key: 'enquiries',     label: 'Enquiries',          icon: '📩', tone: 'neutral' },
  { key: 'forms',         label: 'Registration & Forms', icon: '📝', tone: 'neutral' },
  { key: 'payments',      label: 'Payments',           icon: '💷', tone: 'warn' },
  { key: 'absence',       label: 'Absence',            icon: '🌡️', tone: 'warn' },
  { key: 'children',      label: 'Children & Learning', icon: '👶', tone: 'neutral' },
  { key: 'staff',         label: 'Staff & Rota',       icon: '👥', tone: 'neutral' },
  { key: 'messages',      label: 'Messages',           icon: '💬', tone: 'neutral' },
  { key: 'system',        label: 'Warnings & System',  icon: '⚠️', tone: 'info' },
];

const TAB_KEYS = TABS.map(t => t.key);
const TAB_BY_KEY = Object.fromEntries(TABS.map(t => [t.key, t]));

/**
 * Explicit category → tab. Left-hand side is every category observed firing in
 * wren, wren_dev or the source tree, plus the rest of the CATEGORIES catalog.
 */
const CATEGORY_TAB = {
  // ── Safeguarding — deliberately TIGHT. This tab is the one a manager opens
  // in a hurry; padding it with routine child admin would defeat the point.
  safeguarding_logged: 'safeguarding',
  safeguarding_assigned: 'safeguarding',
  safeguarding: 'safeguarding',
  sen_flag: 'safeguarding',

  // ── Accidents & incidents (acc-tab-20261103, Toby: "Safeguarding is just safeguarding").
  // Every accident a member of staff filed used to land on the Safeguarding tab, red,
  // beside the real concerns. An accident is its own record; setting incidents (fire,
  // intruder, lost child) fire the same two keys, so they come here too. A severe one
  // still tints red through its catalog `urgent` flag (toneFor), and anything a manager
  // escalates becomes a safeguarding_logged notification on the Safeguarding tab.
  incident_severe: 'accidents',
  incident_reported: 'accidents',
  incident: 'accidents',
  accident: 'accidents',

  // ── Enquiries / new business
  enquiry: 'enquiries',
  'waiting-list': 'enquiries',
  waiting_list: 'enquiries',
  viewing_booked: 'enquiries',
  booking: 'enquiries',
  recruit_application: 'enquiries',
  call_escalated: 'enquiries',

  // ── Registration & forms — anything a parent or applicant SUBMITS
  funding_declaration_signed: 'forms',
  funding_decision: 'forms',
  funding: 'forms',
  parent_change_request: 'forms',
  parent_app_feedback: 'forms',
  bug_report: 'forms',
  report_fixed: 'forms',
  contract_action_required: 'forms',
  parent_permission: 'forms',
  permission_slip: 'forms',

  // ── Payments
  payment_received: 'payments',
  payment_overdue: 'payments',
  payment: 'payments',
  invoice: 'payments',
  finance: 'payments',
  funding_receipt_short: 'payments',   // b524 — money owed to us that did not arrive

  // ── Absence — staff and children alike; it is the same question ("who is
  // not here today") whichever side it came from.
  staff_sick: 'absence',
  staff_late: 'absence',
  staff_absent_unauthorised: 'absence',
  parent_reported_absence: 'absence',
  absence: 'absence',
  toil_used: 'absence',

  // ── Children & learning — the room floor's own routine
  child_arrived: 'children',
  child_departed: 'children',
  collection: 'children',
  final_check: 'children',
  medicine: 'children',
  medicine_given: 'children',
  medicine_due: 'children',
  room_move: 'children',
  observation_pending_review: 'children',
  observation_returned: 'children',
  observation_published: 'children',
  report_shared: 'children',
  form_needs_signature: 'forms',   // b343 — parent-directed: a form is waiting for a parent's signature
  termly_update_due: 'children',
  termly_update_summary: 'children',
  termly_review_due: 'children',
  termly_plan_evaluation_due: 'children',
  termly_next_steps_due: 'children',   // b277
  termly_update_report: 'children',    // b277
  area_contribution_due: 'children',
  first_words: 'children',

  // ── Staff & rota — the HR/CPD side
  course_completed: 'staff',
  inset_feedback: 'staff',   // inset-20261026 — a colleague's comment on the INSET agenda
  inset_agenda: 'staff',     // inset-20261026 — "the INSET agenda is ready"
  course_due: 'staff',
  knowledge_check_due: 'staff',
  supervision_due: 'staff',
  supervision_scheduled: 'staff',
  dbs_expiring: 'staff',
  compliance_expiry: 'staff',
  compliance: 'staff',
  policy: 'staff',
  rota_published: 'staff',
  rota_open_shift: 'staff',
  rota_shift_claimed: 'staff',
  staff_clock_forgot_in: 'staff',
  staff_clock_forgot_out: 'staff',
  offratio_account_due: 'staff',
  celebration_dayb4_reminder: 'staff',

  // ── Messages
  parent_message_received: 'messages',
  parent_message_urgent: 'messages',
  message_received: 'messages',
  message: 'messages',
  email_gateway_pending: 'messages',
  email_gateway_reply: 'messages',
  email_gateway_result: 'messages',
  gmail: 'messages',

  // ── Warnings & system — the ops tab. Ratio and headcount live HERE rather
  // than under Safeguarding: they are staffing warnings, and mixing them into
  // the safeguarding tab would bury a real concern under 200 headcount pings.
  // b231 — statutory framework / legislation. These sit on the ops tab rather
  // than under Staff & Rota (where `policy` and `compliance_expiry` live):
  // Staff & Rota is about a person's own record falling due, whereas these are
  // setting-wide legal deadlines with a fixed date. Toby's ask was explicitly
  // "that's the kind of thing I need notifications for" — so they go where the
  // warnings are, not into the CPD-and-DBS stream.
  framework_effective: 'system',
  policy_must_change: 'system',
  legislation_change: 'system',

  room_ratio_breach: 'system',
  headcount_due: 'system',
  headcount_missed: 'system',
  doorbell_pressed: 'system',
  system_critical: 'system',
  system: 'system',
  task_assigned: 'system',
  task_due: 'system',
  task_overdue: 'system',
  task_nudge: 'system',
  briefing_ready: 'system',
  task_escalated: 'system',
  task_reminder: 'system',
  ai_reminder: 'system',
  event_reminder: 'system',
  calendar: 'system',
  reports: 'system',
  report_card_monthly: 'system',
  owner_digest_monthly: 'system',
  automation: 'system',
  repair: 'system',
  'action-plan': 'system',
  test_notification: 'system',
  test_webpush: 'system',
  verification_test: 'system',
};

/**
 * Prefix rules for categories nobody has mapped yet. A new category added by a
 * future build must still land SOMEWHERE — silently dropping it from every tab
 * is how a notification goes missing without anyone noticing.
 */
const PREFIX_RULES = [
  [/^safeguard/,                        'safeguarding'],
  [/^(incident|accident)/,              'accidents'],   // acc-tab-20261103 (was 'safeguarding')
  [/(^|_)(payment|invoice|billing)/,    'payments'],
  [/(^|_)absen/,                        'absence'],
  [/(^|_)messag/,                       'messages'],
  [/^email_gateway/,                    'messages'],
  [/(^|_)enquir/,                       'enquiries'],
  [/^observation/,                      'children'],
  [/^termly/,                           'children'],
  [/^medicine/,                         'children'],
  [/^(course|supervision|rota|staff)/,  'staff'],
  [/(^|_)task/,                         'system'],
];

/** Which tab does this category belong on? Unknown categories → 'system'. */
function tabForCategory(category) {
  const key = String(category || '').trim();
  if (CATEGORY_TAB[key]) return CATEGORY_TAB[key];
  for (const [re, tab] of PREFIX_RULES) if (re.test(key)) return tab;
  return 'system';
}

/** Categories this tab collects. 'all' returns null (meaning "do not filter"). */
function categoriesForTab(tab) {
  if (!tab || tab === 'all') return null;
  if (!TAB_BY_KEY[tab]) return null;
  return Object.keys(CATEGORY_TAB).filter(k => CATEGORY_TAB[k] === tab);
}

/**
 * A tab's tone is the default for its rows, but some categories are plainly good
 * news sitting in an otherwise anxious tab — "Payment received" tinted amber and
 * labelled "Attention" reads as a problem when it is the opposite. These pin the
 * row tone regardless of the tab, unless priority/urgency overrides upward.
 */
const CATEGORY_TONE = {
  payment_received:            'neutral',
  funding_declaration_signed:  'neutral',
  course_completed:            'neutral',
  rota_shift_claimed:          'neutral',
  observation_published:       'neutral',
  report_shared:               'neutral',
  form_needs_signature:        'neutral',
  report_fixed:                'neutral',
  payment_overdue:             'warn',
};

/**
 * Row tint. `priority` is the notifications column ('low'|'normal'|'high'|
 * 'urgent'); `urgent` on the catalog entry is the category's own severity.
 * Safeguarding always wins — it must never be tinted as routine.
 */
function toneFor(category, priority) {
  const tab = tabForCategory(category);
  if (tab === 'safeguarding') return 'critical';
  if (priority === 'urgent') return 'critical';
  if (CATEGORIES[category] && CATEGORIES[category].urgent) return 'critical';
  if (priority === 'high') return 'warn';
  if (CATEGORY_TONE[category]) return CATEGORY_TONE[category];
  const t = TAB_BY_KEY[tab];
  return (t && t.tone) || 'neutral';
}

/** True for the categories "Dismiss all" must not silently clear. */
function needsDismissConfirm(category) {
  return tabForCategory(category) === 'safeguarding';
}

/** Human label for a raw category, falling back to a de-underscored word. */
function labelForCategory(category) {
  if (CATEGORIES[category] && CATEGORIES[category].label) return CATEGORIES[category].label;
  return String(category || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * seed-gdpr-20261030 (Toby, INSET day): "Seed notifications show child names, and emails —
 * this should be kept to Nest for GDPR." Seed (the HR app, staff's own phones) shows only
 * these categories, in the bell AND as phone pushes from an HR-installed app. Everything
 * else (parent messages, the email inbox, observations, termly updates, key children,
 * headcounts, tasks — a task can name a child) stays on Nest.
 *
 * Same test as EMAIL_ALLOWED_CATEGORIES in notification-dispatcher.js: could this text
 * ever name a child, a parent, or a concern? Fails closed — a new category does not
 * reach Seed until someone adds it here. Left off on purpose: report_fixed (quotes the
 * bug report's own title, which can name a child), offratio_account_due.
 */
const SEED_CATEGORIES = [
  'absence_request', 'absence_approved', 'absence_declined', 'absence_reminder',
  'rota_published', 'rota_changed', 'rota_open_shift', 'rota_shift_claimed',
  'shift_reminder', 'shift_swap',
  'staff_clock_forgot_in', 'staff_clock_forgot_out',
  'training_due', 'training_expiring', 'cpd_due', 'course_due', 'course_completed',
  'knowledge_check_due',
  'supervision_due', 'supervision_scheduled', 'probation_due', 'appraisal_due',
  'dbs_expiring', 'compliance_expiry',
  'policy', 'policy_signature_due',
  'staff_celebration', 'celebration_dayb4_reminder', 'staff_notice_newsletter',
  'briefing_ready', 'reading_corner_digest',
  'inset_agenda', 'inset_feedback',
  'hr_warning_stage_reached', 'repair',
  'system', 'test_notification', 'test_webpush',
];
const _SEED_SET = new Set(SEED_CATEGORIES);
/** May this category be shown on Seed (the HR app)? Unknown → no. */
function seedAllows(category) { return _SEED_SET.has(String(category || '')); }

module.exports = {
  TABS, TAB_KEYS, TAB_BY_KEY, CATEGORY_TAB, CATEGORY_TONE,
  tabForCategory, categoriesForTab, toneFor, needsDismissConfirm, labelForCategory,
  SEED_CATEGORIES, seedAllows,
};
