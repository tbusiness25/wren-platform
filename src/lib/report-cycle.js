'use strict';
/**
 * report-cycle.js — b244 (2026-08-28)
 *
 * WHEN each child's reports are due, and WHICH of the ones we already hold
 * satisfy them. Nothing in here writes a report or drafts a word of one: this
 * build schedules and chases.
 *
 * ── THE SCHEDULE, AS TOBY GAVE IT (2026-08-28) ──────────────────────────────
 *   "When they join baby room they get settling in report 4-8 weeks after start
 *    date. then they get 6 month chat with parents, termly updates (next steps
 *    and planned activities), 2 year check (done at 2.5 years), and then
 *    continued 6 month chats. joining pre-school they do settling in, 2y check
 *    if needed, then 6 month chats."
 *
 * Four formats, and only four. The 88 reports pulled out of EyLog use about
 * fifteen different titles for them — "starting point summary", "settling
 * report", "6 month chat with mum", "2 year report" — and normaliseFormat()
 * below is where that drift is collapsed. Getting that mapping right is the
 * difference between a board that knows 88 documents already exist and one that
 * declares all 88 overdue on the morning it ships.
 *
 * ── WHY THIS IS DERIVED, NOT STORED ─────────────────────────────────────────
 * There is no b244 table and no b244 backfill UPDATE. A slot ("this child owes a
 * 6-month chat, due 14 Sept") is computed from children.start_date,
 * children.date_of_birth and the documents on file, every time it is asked for.
 *
 * That is deliberate. A stored schedule would need a backfill over 165 existing
 * report rows and would then drift the first time someone corrected a start date
 * or a report was imported late. Deriving costs one query over a table with 165
 * rows and can never disagree with the records it is derived from.
 *
 * ── WHERE THE DOCUMENTS LIVE — BOTH TABLES ──────────────────────────────────
 * Wren has two report tables and they are both real:
 *
 *   reports         the EyLog imports (b238 — 88 rows carrying PDFs), the b243
 *                   parent-triggered 2-year checks, and hand-written reports.
 *   parent_reports  what the b93 nightly engine auto-drafts
 *                   (scripts/report-engine-nightly.js).
 *
 * gatherDocuments() reads BOTH and normalises them into one list, because a
 * family does not care which table their child's settling-in report is in. A
 * schedule that read only one of them would chase reports that already exist —
 * which is what the existing b93 tracker does today (see the note in
 * wren/logs/b244-report-lifecycle.NOTES.md).
 *
 * ── STATUS ──────────────────────────────────────────────────────────────────
 * Three statuses, EyLog's, because 23 live reports are sitting in one of them
 * and the staff already know what they mean: draft / pending_parent_review /
 * completed. normaliseStatus() maps every internal vocabulary onto those three
 * (b243's requested/drafting/awaiting_review/sent, b93's draft/finalised/sent,
 * EyLog's own strings). Only a document that has actually reached the family —
 * pending_parent_review or completed — satisfies a slot. A draft leaves the slot
 * open and marks it in progress, because a draft nobody sent is not a report:
 * prod is currently holding 63 auto-drafted parent_reports rows, every one of
 * them still 'draft'.
 */

// ── The four formats ─────────────────────────────────────────────────────────
// `key` is the stable identifier used in the API, the attention_items source_key
// and the UI. Never renamed once shipped.
const FORMATS = [
  {
    key: 'settling_in',
    label: 'Settling in',
    // Plural spelled out per format: "Settling in" + "s" is "Settling ins",
    // and "Progress check at age two" + "s" is worse. The board says these out
    // loud to Toby, so they have to read like English.
    plural: 'settling-in reports',
    // EyLog wrote this one under two names and LADN says a third out loud.
    aka: ['starting point summary', 'settling report', 'settling in report'],
    once: true,
    anchor: 'start_date',
    blurb: 'How the child has settled, written 4–8 weeks after they start.',
  },
  {
    key: 'six_month_chat',
    label: '6-month chat with parents',
    plural: '6-month chats with parents',
    aka: ['6 month chat', 'chat with parents', 'parent meeting', 'progress chat'],
    repeating: true,
    anchor: 'start_date',
    blurb: 'Every six months from the child\'s start date, continuing for as long as they are with us.',
  },
  {
    key: 'termly_update',
    label: 'Progress update',
    plural: 'progress updates',
    // b296 (2026-09-09) — renamed to "Progress update" for staff. Every name it
    // has ever had stays matchable here: the key is untouched and so is the data.
    aka: ['progress update & tracking', 'termly update', 'termly updates',
          'termly update & tracking', 'learning journey'],
    repeating: true,
    // NOT a reports row. b238 records a termly update as observations.termly_update
    // = true and src/services/termly-status.js is the single source of truth for
    // "has this child had theirs this cycle". b244 reads that service rather than
    // inventing a second mechanism — the brief was explicit about it.
    from_observations: true,
    // b246 (2026-08-28): the cadence now follows Ealing's half-terms rather than
    // a rolling window from each child's own last update, and the update itself
    // has five sections (src/lib/termly-update.js) rather than only a flag.
    on_school_terms: true,
    blurb: 'What went well last term, what we are working on this term, next steps, ideas for home '
         + 'and the tracking data — one per half-term, on Ealing\'s school dates.',
  },
  {
    key: 'two_year_check',
    label: 'Progress check at age two',
    plural: 'progress checks at age two',
    aka: ['2 year check', '2 year report'],
    once: true,
    anchor: 'date_of_birth',
    // Due at 2.5 years — Toby, 2026-08-28, and it matches the health visitor's
    // 2–2½ year review, which is the appointment the summary is written for.
    // The 24–36 month STATUTORY eligibility window (b243) is a different thing
    // and is unchanged: 24 months is when the check MAY be written, 30 months is
    // when this nursery expects it done.
    blurb: 'The statutory EYFS check, done at 2½ so it is in the family\'s hand for the health visitor review.',
  },
];
const FORMAT_KEYS = FORMATS.map(f => f.key);
const FORMAT_BY_KEY = FORMATS.reduce((m, f) => (m[f.key] = f, m), {});

// ── The three statuses, EyLog's ──────────────────────────────────────────────
const STATUSES = [
  { key: 'draft',                 label: 'Draft' },
  { key: 'pending_parent_review', label: 'Pending Parent Review' },
  { key: 'completed',             label: 'Completed' },
];
const STATUS_KEYS = STATUSES.map(s => s.key);
// A slot is satisfied by a document that has reached the family. A draft has not.
const SATISFYING_STATUSES = new Set(['pending_parent_review', 'completed']);

// ── Tunables, every one overridable from ladn.settings ───────────────────────
// Defaults are Toby's schedule verbatim. The settings rows exist so a second
// nursery running Wren can have a different cadence without a code change.
const DEFAULTS = {
  settling_due_weeks: 4,        // "4-8 weeks after start date" — due at 4…
  settling_overdue_weeks: 8,    // …overdue after 8.
  chat_months: 6,
  chat_grace_weeks: 6,          // a 6-month chat is a conversation to arrange, not a deadline
  two_year_due_months: 30,      // 2.5 years
  two_year_overdue_months: 33,
  two_year_window_end_months: 36, // b243's statutory ceiling — past it the check can no longer be written
  // A child who started long before Wren held any records should not generate a
  // permanently-overdue settling-in report nobody can ever satisfy. Anything
  // anchored further back than this, with nothing on file, is reported as
  // 'not_applicable' with a reason rather than as a failure.
  grandfather_months: 12,
  // How far ahead the "Reports due" board looks. Beyond this a slot is real but
  // not yet worth anybody's attention.
  horizon_weeks: 8,
};

const SETTING_KEYS = {
  settling_due_weeks:      'report_cycle_settling_due_weeks',
  settling_overdue_weeks:  'report_cycle_settling_overdue_weeks',
  chat_months:             'report_cycle_chat_months',
  chat_grace_weeks:        'report_cycle_chat_grace_weeks',
  two_year_due_months:     'report_cycle_two_year_due_months',
  two_year_overdue_months: 'report_cycle_two_year_overdue_months',
  grandfather_months:      'report_cycle_grandfather_months',
  horizon_weeks:           'report_cycle_horizon_weeks',
};

async function loadConfig(db) {
  const cfg = Object.assign({}, DEFAULTS);
  try {
    const keys = Object.values(SETTING_KEYS);
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key = ANY($1::text[])`, [keys]);
    const byKey = {};
    for (const r of rows) byKey[r.key] = r.value;
    for (const [field, key] of Object.entries(SETTING_KEYS)) {
      const n = parseInt(byKey[key], 10);
      if (Number.isFinite(n) && n > 0) cfg[field] = n;
    }
  } catch (_) { /* settings table missing → the defaults above, which are Toby's schedule */ }
  return cfg;
}

// ── Dates ────────────────────────────────────────────────────────────────────
// pg hands a DATE back as a local-midnight JS Date. toISOString() on that shifts
// a BST date back a day, which is enough to move a child across the 30-month
// boundary on their half-birthday. Everything here reads LOCAL getters and
// carries dates as 'YYYY-MM-DD' strings, which compare correctly with < and >.
function ymd(v) {
  if (!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' → a local-midnight Date. Parsing the string with new Date()
 *  would give UTC midnight, which is the same bug one layer down. */
function parseYmd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return isNaN(d) ? null : d;
}

function addDays(iso, n) {
  const d = parseYmd(iso); if (!d) return null;
  d.setDate(d.getDate() + n); return ymd(d);
}
function addWeeks(iso, n) { return addDays(iso, n * 7); }
/** Calendar months. setMonth() clamps 31 Jan + 1 month to 28/29 Feb, which is
 *  the behaviour we want for a birthday-anchored due date. */
function addMonths(iso, n) {
  const d = parseYmd(iso); if (!d) return null;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return ymd(d);
}
function ageInMonths(dobIso, onIso) {
  const d = parseYmd(dobIso), t = parseYmd(onIso);
  if (!d || !t) return null;
  let m = (t.getFullYear() - d.getFullYear()) * 12 + (t.getMonth() - d.getMonth());
  if (t.getDate() < d.getDate()) m -= 1;
  return m;
}
function today() { return ymd(new Date()); }

// ── Normalising a format out of EyLog's title drift ──────────────────────────
// Specific report_type values first: where a previous import already decided
// what a document is, that decision stands.
const TYPE_TO_FORMAT = {
  settling_in: 'settling_in',
  starting_point: 'settling_in',
  settling: 'settling_in',                 // b93 parent_reports
  six_month_chat: 'six_month_chat',
  'parent-chat': 'six_month_chat',         // b93 parent_reports — the logged conversation
  progress: 'six_month_chat',              // b93's "+12mo written report" IS the 6-month chat here
  two_year_check: 'two_year_check',
  '2-year check': 'two_year_check',        // b93 parent_reports
  '2year_check': 'two_year_check',
  termly_progress: 'termly_update',
  termly: 'termly_update',
  termly_update: 'termly_update',
};

// Types that carry no format information — an EyLog dump with the real name in
// its title. For these the title is the only evidence, so fall through to it.
const GENERIC_TYPES = new Set(['eylog_report', 'report', 'summative', '']);

// Types that are real documents but are NOT part of the cycle. Listed so they
// are known-and-excluded rather than silently unmatched.
//
// assessment_snapshot is here rather than in GENERIC_TYPES: prod holds 47 of
// them, none with a title, and they are Wren's own periodic tracker snapshots,
// not a document anybody writes for a family. Treating them as "could not be
// identified" made the attention collector report 51 unmatched documents on a
// setting where only 4 genuinely are — exactly the cry-wolf failure that stops
// the number being read at all.
const OUT_OF_CYCLE_TYPES = new Set(['transition', 'leaving', 'leaver', 'assessment_snapshot']);

// Ordered. Two-year first: "2 year report" cannot also be a 6-month chat, but a
// title like "2 year check - 6 month follow up" would match both, and the
// statutory document is the one that must win.
const TITLE_PATTERNS = [
  [/\b(2|two)[\s-]*year\b/i,                                    'two_year_check'],
  [/starting[\s-]*point|settl(e|ing)/i,                         'settling_in'],
  [/\b(6|six)[\s-]*month\b|chat\s+with|parent\s+meeting|progress\s+chat/i, 'six_month_chat'],
  [/termly|learning\s+journey/i,                                'termly_update'],
];

/**
 * Which of the four formats is this document?
 * @param {{report_type?:string, title?:string}} doc
 * @returns {string|null} a FORMAT_KEYS value, or null for anything outside the cycle.
 */
function normaliseFormat(doc) {
  const type = String((doc && doc.report_type) || '').trim().toLowerCase();
  const title = String((doc && doc.title) || '').trim();

  if (OUT_OF_CYCLE_TYPES.has(type)) return null;
  if (!GENERIC_TYPES.has(type) && TYPE_TO_FORMAT[type]) return TYPE_TO_FORMAT[type];

  if (title) {
    for (const [re, key] of TITLE_PATTERNS) if (re.test(title)) return key;
  }
  // A generic type with an unusable title genuinely tells us nothing. Returning
  // null (rather than guessing settling_in, the commonest) is what stops a
  // mis-mapped document from silently satisfying a statutory slot.
  return TYPE_TO_FORMAT[type] || null;
}

// ── Normalising a status onto EyLog's three ──────────────────────────────────
const EYLOG_STATUS = {
  'completed': 'completed',
  'pending parent review': 'pending_parent_review',
  'draft': 'draft',
};
// b243's parent-triggered 2-year check workflow.
const B243_STATUS = {
  requested: 'draft', drafting: 'draft', awaiting_review: 'draft',
  sent: 'pending_parent_review',
};
// b93's parent_reports.
const B93_STATUS = {
  draft: 'draft', finalised: 'completed', sent: 'completed',
};

/**
 * @param {object} row a reports or parent_reports row (plus its parsed content)
 * @returns {'draft'|'pending_parent_review'|'completed'}
 */
function normaliseStatus(row) {
  if (!row) return 'draft';
  // 1. An explicit b244 lifecycle status is a human's decision and wins outright.
  const explicit = String(row.lifecycle_status || '').trim().toLowerCase();
  if (STATUS_KEYS.includes(explicit)) return explicit;

  const content = row.content && typeof row.content === 'object' ? row.content : {};

  // 2. What EyLog itself said, carried through the import.
  const ey = String(content.eylog_status || '').trim().toLowerCase();
  if (EYLOG_STATUS[ey]) return EYLOG_STATUS[ey];

  // 3. The workflow vocabularies.
  const st = String(row.status || '').trim().toLowerCase();
  if (row._table === 'parent_reports') {
    if (B93_STATUS[st]) return B93_STATUS[st];
  } else if (B243_STATUS[st]) {
    return B243_STATUS[st];
  }

  // 4. An imported document with no status of its own. It exists as a finished
  //    PDF in a family's file, so it is completed — this is the clause that stops
  //    the 88 EyLog imports being read as 88 unwritten reports.
  if (row.source === 'eylog') return 'completed';
  if (content.eylog_report_id || content.eylog_url) return 'completed';
  if (row.pdf_path) return 'completed';
  if (row.shared_with_parents === true || row.sent_at) return 'completed';

  return 'draft';
}

/** The date a document belongs to — EyLog's own report_date where we have it,
 *  otherwise when the row was written. */
function documentDate(row) {
  const content = row && row.content && typeof row.content === 'object' ? row.content : {};
  const rd = String(content.report_date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(rd)) return rd.slice(0, 10);
  return ymd(row && (row.report_date || row.generated_at || row.created_at)) || null;
}

// ── Rooms ────────────────────────────────────────────────────────────────────
// Toby's two sequences. Both rooms need all four formats — what differs is the
// ORDER a child meets them, which is entirely a consequence of how old they are
// when they join. A baby-room starter has their first 6-month chat long before
// they are 2½; a pre-school starter may be due their 2-year check first.
//
// The sequences below are used for DISPLAY ORDER and for explaining the cycle.
// They are deliberately not used as gates: the gate on a 2-year check is the
// child's age and whether one has already been done, never which room they sit
// in. That is what makes a room move a non-event (see roomFamily's note).
const ROOM_CYCLES = {
  baby: ['settling_in', 'six_month_chat', 'termly_update', 'two_year_check'],
  preschool: ['settling_in', 'two_year_check', 'six_month_chat', 'termly_update'],
};

/**
 * Which sequence to narrate for this child.
 *
 * NOTE THE ABSENCE: there is no room-entry date anywhere in this file. Every
 * date below is anchored to children.start_date or children.date_of_birth, so a
 * child moving baby room → pre-school changes nothing about what they are owed
 * or when. That is the "a room move does not restart the cycle" requirement, and
 * it holds by construction rather than by a rule that could be forgotten.
 */
function roomFamily(roomName) {
  return /baby|infant|under\s*2|nursery\s*1/i.test(String(roomName || '')) ? 'baby' : 'preschool';
}

// ── Slot states ──────────────────────────────────────────────────────────────
// done            a satisfying document is on file
// in_progress     a draft exists; the slot is not satisfied but somebody is on it
// overdue         past the overdue date with nothing on file
// due             past the due date, inside the grace window
// upcoming        due date is in the future
// not_applicable  cannot apply to this child (too young, too old, no start date,
//                 or predates the records we hold) — always with a reason
const STATE_ORDER = { overdue: 0, due: 1, in_progress: 2, upcoming: 3, done: 4, not_applicable: 5 };

function stateFromDates(dueOn, overdueOn, on) {
  if (!dueOn) return 'upcoming';
  if (overdueOn && on >= overdueOn) return 'overdue';
  if (on >= dueOn) return 'due';
  return 'upcoming';
}

/**
 * The whole cycle for one child.
 *
 * @param {object} child   { id, first_name, last_name, preferred_name, date_of_birth,
 *                           start_date, leave_date, room_id, room_name,
 *                           key_person_id, key_person_name }   dates as 'YYYY-MM-DD'
 * @param {Array}  docs    normalised documents for THIS child (see gatherDocuments)
 * @param {object} opts    { config, on, termly }  termly = the child's row from
 *                         termly-status.fetchTermlyStatuses(), or null
 * @returns {{child_id, name, room_name, room_family, key_person_id, key_person_name, slots: Array}}
 */
function scheduleForChild(child, docs, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts.config || {});
  const on = opts.on || today();
  const start = ymd(child.start_date);
  const dob = ymd(child.date_of_birth);
  const leave = ymd(child.leave_date);
  const family = roomFamily(child.room_name);
  const mine = (docs || []).filter(d => d.format);

  const satisfying = f => mine
    .filter(d => d.format === f && SATISFYING_STATUSES.has(d.status))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const drafts = f => mine.filter(d => d.format === f && d.status === 'draft');

  const slots = [];
  const push = s => slots.push(s);

  // ── 1. Settling in — 4 weeks after start, overdue after 8 ──────────────────
  {
    const done = satisfying('settling_in')[0] || null;
    const draft = drafts('settling_in')[0] || null;
    const dueOn = start ? addWeeks(start, cfg.settling_due_weeks) : null;
    const overdueOn = start ? addWeeks(start, cfg.settling_overdue_weeks) : null;
    let state, reason = null;
    if (done) state = 'done';
    else if (!start) { state = 'not_applicable'; reason = 'No start date on file, so there is nothing to count from.'; }
    else if (start < addMonths(on, -cfg.grandfather_months)) {
      // Started more than a year ago with nothing on file. Either it was written
      // on paper before Wren, or it was never done and the moment has passed —
      // either way chasing it now helps nobody.
      state = 'not_applicable';
      reason = `Started ${start}, before the records Wren holds. Not chased.`;
    } else if (draft) state = 'in_progress';
    else state = stateFromDates(dueOn, overdueOn, on);
    push(slot('settling_in', { due_on: dueOn, overdue_on: overdueOn, state, reason, done, draft }, on));
  }

  // ── 2. 6-month chat — every 6 months, continuing indefinitely ──────────────
  // Anchored on the LAST chat that actually happened, falling back to the start
  // date. Anchoring on start_date alone would put a child who had their chat
  // three weeks late permanently three weeks out of step; anchoring on the last
  // one keeps the cadence and, crucially, means one overdue chat is shown rather
  // than the six a child enrolled for three years would otherwise accumulate.
  {
    const had = satisfying('six_month_chat');
    const last = had[0] || null;
    const draft = drafts('six_month_chat')[0] || null;
    const anchor = last ? last.date : start;
    const dueOn = anchor ? addMonths(anchor, cfg.chat_months) : null;
    const overdueOn = dueOn ? addWeeks(dueOn, cfg.chat_grace_weeks) : null;
    let state, reason = null;
    if (!anchor) { state = 'not_applicable'; reason = 'No start date on file, so there is nothing to count from.'; }
    else if (leave && dueOn && dueOn > leave) { state = 'not_applicable'; reason = `Leaves ${leave}, before the next chat is due.`; }
    else if (draft) state = 'in_progress';
    else state = stateFromDates(dueOn, overdueOn, on);
    push(slot('six_month_chat', {
      due_on: dueOn, overdue_on: overdueOn, state, reason,
      done: null,             // a repeating slot is never "done" — only "next one is upcoming"
      draft,
      last_done: last, count_done: had.length,
    }, on));
  }

  // ── 3. Termly update — Ealing's half-terms (b246) ──────────────────────────
  // src/services/termly-status.js still owns this question; b244 reads its
  // verdict and translates it into a slot rather than recomputing anything.
  //
  // b246 (2026-08-28) changed what that verdict is anchored to. The due and
  // overdue dates now come from the child's HALF-TERM (ladn.school_terms —
  // Ealing's published dates), so a room lands together instead of every child
  // running a private six-week clock from their own last update. The row carries
  // due_on / overdue_on / cycle_key when that anchoring is in force; when it is
  // not — no term calendar, or the setting says 'rolling' — the row carries the
  // pre-b246 fields and the arithmetic below is exactly what it always was.
  //
  // b246 also made a SENT termly-update document satisfy the slot alongside the
  // observation flag, which is why last_done can now say which it was.
  {
    const t = opts.termly || null;
    let state, reason = null, dueOn = null, overdueOn = null, lastDate = null;
    if (!t) { state = 'not_applicable'; reason = 'Termly-update status unavailable for this child.'; }
    else {
      lastDate = ymd(t.last_termly_date);
      if (t.due_on) {
        // Term-anchored. Take the dates and the state as given — recomputing them
        // here from cycle weeks is what would put this board and the EY page on
        // two different calendars.
        dueOn = t.due_on;
        overdueOn = t.overdue_on || null;
        // t.state is b246's five-value vocabulary and maps straight onto the
        // slot states, which use the same words.
        state = ['done', 'due', 'overdue', 'upcoming', 'not_applicable'].includes(t.state)
          ? t.state
          : (t.status === 'done' ? 'done' : (t.status === 'overdue' ? 'overdue' : 'due'));
        reason = t.reason || null;
        if (!reason && state === 'done') {
          reason = `Last progress update ${lastDate || 'recorded'}${t.cycle_label ? ' for ' + t.cycle_label : ''}.`;
        }
      } else {
        const cycleW = t.cycle_weeks || 8, graceW = t.grace_weeks || 2;
        const anchor = lastDate || start;
        dueOn = anchor ? addWeeks(anchor, cycleW) : null;
        overdueOn = dueOn ? addWeeks(dueOn, graceW) : null;
        state = t.status === 'done' ? 'done' : (t.status === 'overdue' ? 'overdue' : 'due');
        if (state === 'done') reason = `Last progress update ${lastDate || 'recorded'}; next due ${dueOn || 'when the cycle turns'}.`;
      }
    }
    push(slot('termly_update', {
      due_on: dueOn, overdue_on: overdueOn, state, reason,
      done: null,
      // The b246 document, when there is one, so the board can link to it rather
      // than dumping the practitioner on the child's profile to hunt for it.
      draft: (t && t.open_report_id)
        ? { id: t.open_report_id, table: 'reports', status: 'draft' } : null,
      last_done: lastDate
        ? { date: lastDate, id: (t.last_update_source === 'termly_update' ? t.last_report_id : t.last_obs_id),
            source: t.last_update_source || 'observation' }
        : null,
      cycle_key: t && t.cycle_key ? t.cycle_key : null,
      cycle_label: t && t.cycle_label ? t.cycle_label : null,
    }, on));
  }

  // ── 4. Progress check at age two — due at 2½ ───────────────────────────────
  {
    const done = satisfying('two_year_check')[0] || null;
    const draft = drafts('two_year_check')[0] || null;
    const months = dob ? ageInMonths(dob, on) : null;
    const dueOn = dob ? addMonths(dob, cfg.two_year_due_months) : null;
    const overdueOn = dob ? addMonths(dob, cfg.two_year_overdue_months) : null;
    let state, reason = null;
    if (done) {
      // Never asked for again. Not when they move room, not when they turn three.
      state = 'done';
      reason = `Completed ${done.date || ''}`.trim();
    } else if (!dob) { state = 'not_applicable'; reason = 'No date of birth on file.'; }
    else if (months > cfg.two_year_window_end_months) {
      // b243's statutory ceiling. Past 36 months the check can no longer be
      // written, so showing it as overdue forever would be a lie with a red dot
      // on it.
      state = 'not_applicable';
      reason = `Now ${months} months old — past the 24–36 month window in which this check can be written.`;
    } else if (draft) state = 'in_progress';
    else state = stateFromDates(dueOn, overdueOn, on);
    push(slot('two_year_check', {
      due_on: dueOn, overdue_on: overdueOn, state, reason, done, draft,
      age_months: months,
      // b243's window, carried through so the UI can say "can be written now"
      // separately from "this nursery wants it done by".
      window_open_on: dob ? addMonths(dob, 24) : null,
      window_close_on: dob ? addMonths(dob, cfg.two_year_window_end_months) : null,
    }, on));
  }

  // Display order: the room's sequence, but anything actually needing attention
  // floats to the top of it.
  const seq = ROOM_CYCLES[family];
  slots.sort((a, b) =>
    (STATE_ORDER[a.state] - STATE_ORDER[b.state]) ||
    (seq.indexOf(a.format) - seq.indexOf(b.format)));

  return {
    child_id: child.id,
    name: [(child.preferred_name || child.first_name), child.last_name].filter(Boolean).join(' '),
    room_id: child.room_id || null,
    room_name: child.room_name || null,
    room_family: family,
    sequence: seq,
    key_person_id: child.key_person_id || null,
    key_person_name: child.key_person_name || null,
    start_date: start, date_of_birth: dob, leave_date: leave,
    slots,
  };
}

/**
 * @param {string} format
 * @param {object} o
 * @param {string} on  the date the schedule is being built FOR. Passed in rather
 *   than read from the clock inside: /due accepts ?on=YYYY-MM-DD for testing and
 *   for asking "what did this board look like in September", and a days_over
 *   computed against today would silently contradict the state computed against
 *   `on` — a row reading "overdue" next to "in 3 weeks".
 */
function slot(format, o, on) {
  const f = FORMAT_BY_KEY[format];
  const done = o.done || null;
  const asOf = on || today();
  return {
    format,
    label: f.label,
    blurb: f.blurb,
    state: o.state,
    reason: o.reason || null,
    due_on: o.due_on || null,
    overdue_on: o.overdue_on || null,
    // days_over is negative before the due date — one number the UI can sort on.
    days_over: o.due_on ? daysBetween(o.due_on, asOf) : null,
    // What satisfies (or is trying to satisfy) it.
    report_id: (done && done.id) || (o.draft && o.draft.id) || null,
    report_table: (done && done.table) || (o.draft && o.draft.table) || null,
    report_status: done ? done.status : (o.draft ? o.draft.status : null),
    last_done: o.last_done || done || null,
    count_done: o.count_done == null ? (done ? 1 : 0) : o.count_done,
    age_months: o.age_months == null ? null : o.age_months,
    window_open_on: o.window_open_on || null,
    window_close_on: o.window_close_on || null,
    // b246 — which half-term this slot belongs to. Null on every format except
    // the termly update, which is the only one anchored to the school calendar.
    cycle_key: o.cycle_key || null,
    cycle_label: o.cycle_label || null,
  };
}

function daysBetween(fromIso, toIso) {
  const a = parseYmd(fromIso), b = parseYmd(toIso);
  if (!a || !b) return null;
  return Math.round((b - a) / 86400000);
}

// ── Reading both report tables ───────────────────────────────────────────────
/**
 * Every cycle document Wren holds for these children, from BOTH report tables,
 * normalised to { id, table, child_id, format, status, date, title }.
 *
 * `unmapped` counts documents whose format could not be determined. It is
 * returned rather than swallowed: if that number is large, the title
 * normalisation above has drifted and the schedule is quietly wrong.
 */
async function gatherDocuments(db, childIds) {
  const out = [];
  const unmapped = { reports: 0, parent_reports: 0 };
  if (!childIds || !childIds.length) return { docs: out, unmapped };

  const take = (r, table) => {
    const format = normaliseFormat({ report_type: r.report_type, title: r.title });
    if (!format) {
      // OUT_OF_CYCLE_TYPES are known-and-excluded, so they are not "unmapped".
      // Only a document we genuinely could not identify counts, because that
      // number is reported to a human as "the board may be chasing reports that
      // already exist".
      if (!OUT_OF_CYCLE_TYPES.has(String(r.report_type || '').toLowerCase())) unmapped[table]++;
      return;
    }
    out.push({
      id: r.id, table, child_id: r.child_id, format,
      status: normaliseStatus(r), date: documentDate(r),
      report_type: r.report_type, title: r.title || null,
    });
  };

  // reports — EyLog imports (b238), b243 2-year checks, hand-written reports.
  // Selected column-by-column: `content` can hold a whole rendered report, and
  // SELECT * over 165 of those for a board that needs five fields is waste.
  //
  // Two column sets. The full one wants b243's `status`/`sent_at` and b244's
  // `lifecycle_status`; the legacy one is what a schema that has had neither
  // migration can actually answer. A demo edition — or prod before Toby runs
  // the migrations — must show a schedule rather than a 500. Those columns
  // refine the status derivation; they are not load-bearing for it.
  const FULL = `id, child_id, report_type, source, pdf_path, shared_with_parents,
                created_at, status, sent_at, lifecycle_status,
                content->>'name' AS title, content->>'report_date' AS report_date,
                content->>'eylog_status' AS eylog_status,
                (content ? 'eylog_report_id') AS has_eylog_id,
                (content ? 'eylog_url') AS has_eylog_url`;
  const LEGACY = `id, child_id, report_type, source, pdf_path, shared_with_parents,
                  created_at,
                  content->>'name' AS title, content->>'report_date' AS report_date,
                  content->>'eylog_status' AS eylog_status,
                  (content ? 'eylog_report_id') AS has_eylog_id,
                  (content ? 'eylog_url') AS has_eylog_url`;

  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT ${FULL} FROM reports WHERE child_id = ANY($1::int[])`, [childIds]));
  } catch (e) {
    // 42703 = undefined_column. Matched on the CODE, not on a column name in the
    // message: prod has had neither the b243 nor the b244 migration, so the first
    // name postgres complains about is `status`, and a regex looking for
    // 'lifecycle_status' would miss it and 500 the whole board.
    if (e.code !== '42703') throw e;
    ({ rows } = await db.query(
      `SELECT ${LEGACY} FROM reports WHERE child_id = ANY($1::int[])`, [childIds]));
  }
  for (const r of rows) {
    r._table = 'reports';
    r.content = {
      eylog_status: r.eylog_status,
      report_date: r.report_date,
      eylog_report_id: r.has_eylog_id ? 1 : null,
      eylog_url: r.has_eylog_url ? 1 : null,
    };
    take(r, 'reports');
  }

  // parent_reports — the b93 nightly engine's drafts. Optional: a demo schema
  // may not have the table at all.
  try {
    const { rows: pr } = await db.query(`
      SELECT id, child_id, report_type, status, generated_at, finalised_at, sent_at
        FROM parent_reports
       WHERE child_id = ANY($1::int[])`, [childIds]);
    for (const r of pr) {
      r._table = 'parent_reports';
      r.title = null;
      take(r, 'parent_reports');
    }
  } catch (_) { /* table optional on demo schemas */ }

  return { docs: out, unmapped };
}

/**
 * The whole board: every active child's cycle.
 *
 * @param {object} db
 * @param {object} opts { room_id, key_person_id, on, child_ids }
 */
async function buildSchedule(db, opts = {}) {
  const cfg = await loadConfig(db);
  const on = opts.on || today();

  const params = [];
  const conds = [];
  if (opts.child_ids && opts.child_ids.length) {
    params.push(opts.child_ids); conds.push(`c.id = ANY($${params.length}::int[])`);
  } else {
    conds.push('c.is_active = true');
  }
  if (opts.room_id) { params.push(opts.room_id); conds.push(`c.room_id = $${params.length}`); }
  if (opts.key_person_id) { params.push(opts.key_person_id); conds.push(`c.key_person_id = $${params.length}`); }

  const { rows: kids } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.preferred_name,
           c.date_of_birth, c.start_date, c.leave_date,
           c.room_id, r.name AS room_name,
           c.key_person_id, kp.first_name || ' ' || kp.last_name AS key_person_name
      FROM children c
      LEFT JOIN rooms r  ON r.id = c.room_id
      LEFT JOIN staff kp ON kp.id = c.key_person_id
     WHERE ${conds.join(' AND ')}
     ORDER BY c.first_name, c.last_name`, params);

  if (!kids.length) return { on, config: cfg, children: [], unmapped: { reports: 0, parent_reports: 0 }, termly_available: false };

  const ids = kids.map(k => k.id);
  const { docs, unmapped } = await gatherDocuments(db, ids);
  const byChild = {};
  for (const d of docs) (byChild[d.child_id] = byChild[d.child_id] || []).push(d);

  // Termly updates come from b238's flag — and, since b246, from a sent termly
  // update document — by way of the service that already owns that question. If
  // it cannot answer, every termly slot says so rather than the board inventing
  // a verdict.
  let termlyByChild = {}, termlyAvailable = false, termlyCycle = null, termlyAnchor = null;
  try {
    const { fetchTermlyStatuses } = require('../services/termly-status');
    // `on` matters here: /due accepts ?on=YYYY-MM-DD, and a termly verdict
    // computed against today next to a settling-in state computed against `on`
    // is exactly the "overdue next to in 3 weeks" contradiction the slot()
    // comment warns about.
    const t = await fetchTermlyStatuses(db, { on });
    for (const row of t.children) {
      termlyByChild[row.child_id] = Object.assign({}, row,
        { cycle_weeks: t.cycleWeeks, grace_weeks: t.graceWeeks });
    }
    termlyAvailable = true;
    termlyCycle = t.cycle || null;
    termlyAnchor = t.anchor || null;
  } catch (_) { /* termly slots become not_applicable with a reason */ }

  // b246 — the updates already open for this cycle, so a slot somebody is
  // actively writing shows as in progress rather than as overdue. One query for
  // the whole board; the column is guarded because a schema that has not run the
  // b246 migration has no cycle_key.
  if (termlyAvailable && termlyCycle) {
    try {
      const { rows: open } = await db.query(`
        SELECT child_id, id, status FROM reports
         WHERE report_type = 'termly_update' AND cycle_key = $1
           AND child_id = ANY($2::int[]) AND COALESCE(status,'') <> 'sent'`,
        [termlyCycle.key, ids]);
      for (const o of open) {
        if (termlyByChild[o.child_id]) termlyByChild[o.child_id].open_report_id = o.id;
      }
    } catch (_) { /* pre-migration schema — the slot simply has no draft to link */ }
  }

  const children = kids.map(k => scheduleForChild(k, byChild[k.id] || [],
    { config: cfg, on, termly: termlyByChild[k.id] || null }));

  return { on, config: cfg, children, unmapped, termly_available: termlyAvailable,
           // b246 — which half-term the termly rows are judged against, and by
           // what rule, so the board can say it out loud instead of the reader
           // having to guess why a date is what it is.
           termly_cycle: termlyCycle, termly_anchor: termlyAnchor };
}

/** Flatten a schedule into one row per slot that needs a human — the board. */
function dueRows(schedule, opts = {}) {
  const cfg = schedule.config || DEFAULTS;
  const horizon = addWeeks(schedule.on, opts.horizon_weeks || cfg.horizon_weeks);
  const wanted = new Set(opts.states || ['overdue', 'due', 'in_progress']);
  const rows = [];
  for (const c of schedule.children) {
    for (const s of c.slots) {
      const include = wanted.has(s.state) ||
        (opts.include_upcoming && s.state === 'upcoming' && s.due_on && s.due_on <= horizon);
      if (!include) continue;
      rows.push({
        child_id: c.child_id, child_name: c.name,
        room_id: c.room_id, room_name: c.room_name,
        key_person_id: c.key_person_id, key_person_name: c.key_person_name,
        format: s.format, format_label: s.label,
        due_on: s.due_on, overdue_on: s.overdue_on, days_over: s.days_over,
        state: s.state, reason: s.reason,
        report_id: s.report_id, report_table: s.report_table, report_status: s.report_status,
        cycle_key: s.cycle_key || null, cycle_label: s.cycle_label || null,
      });
    }
  }
  // Overdue first, then longest overdue first, then by due date.
  rows.sort((a, b) =>
    (STATE_ORDER[a.state] - STATE_ORDER[b.state]) ||
    ((b.days_over == null ? -1e9 : b.days_over) - (a.days_over == null ? -1e9 : a.days_over)) ||
    String(a.due_on || '9999').localeCompare(String(b.due_on || '9999')));
  return rows;
}

module.exports = {
  FORMATS, FORMAT_KEYS, FORMAT_BY_KEY, OUT_OF_CYCLE_TYPES, GENERIC_TYPES,
  STATUSES, STATUS_KEYS, SATISFYING_STATUSES,
  DEFAULTS, SETTING_KEYS, ROOM_CYCLES, STATE_ORDER,
  loadConfig, normaliseFormat, normaliseStatus, documentDate,
  roomFamily, scheduleForChild, gatherDocuments, buildSchedule, dueRows,
  ymd, parseYmd, addDays, addWeeks, addMonths, ageInMonths, daysBetween, today,
};
