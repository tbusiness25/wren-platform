'use strict';
/**
 * morning-board.js — b286 (2026-09-08)
 *
 * Toby: "a page on the EY Portal (viewable on admin) and all it shows is a
 * combined tracker for: termly updates, two-year reports, chat with parents,
 * weekly observations target, tracking, phonics, resources and activities, and
 * planning. Ideally when they login each morning, it's just a quick reminder of
 * what they need to do."
 *
 * ── WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT ──────────────────────
 * It is a READER. It owns no table, writes nothing, and invents no deadline.
 * Every strand below asks a source that already exists — b277's termly tracker,
 * b243's two-year checks, the messages threads, observations, framework_tracker
 * / band_judgements, phonics, planned_activities, term_plans — and reports what
 * that source says is outstanding.
 *
 * Where a definition of "outstanding" already exists, it is CALLED, not copied:
 * the termly strand runs services/termly-tracker.js and reads its `outstanding`
 * counter, so the morning board and the termly tracker can never disagree. The
 * strands that had no existing count endpoint define one here, once, and the SQL
 * is recorded in ladn-ready/logs/b286.NOTES.md so any number on the page can be
 * checked by hand.
 *
 * ── THE ONE FAILURE MODE THAT MATTERS ───────────────────────────────────────
 * A false zero. "0 outstanding" reads as "done" and a practitioner walks away.
 * So a strand whose SOURCE is missing — no school terms configured, no framework
 * chosen, a table this edition never got — returns state 'not_tracked' with the
 * reason in words. It NEVER returns 0. A strand that errors returns 'error',
 * also never 0. Only a strand that genuinely asked its source and got nothing
 * back returns 0, and it says which question it asked.
 *
 * ── SCOPE ───────────────────────────────────────────────────────────────────
 * Default is the signed-in practitioner's own key children. They may widen to a
 * room they are actually in (their staff.room_id, or a room one of their key
 * children is in) and no further. A lead (room leader / senior / manager /
 * deputy / admin / headteacher) may pick any room, any key person, or the whole
 * setting — that is the Roost view Toby asked for.
 *
 * Nothing here is ever logged. Child names are in the response and in the
 * response only — see the log rule in logs/b277.NOTES.md, which applies to every
 * board of this class.
 */

const TT = require('./termly-tracker');
const CAL = require('../lib/school-calendar');

const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);
const LEAD_ROLES = new Set([...MANAGER_ROLES, 'room_leader', 'senior_practitioner']);
const isManager = u => !!(u && MANAGER_ROLES.has(u.role));
const isLead = u => !!(u && LEAD_ROLES.has(u.role));

// ── Dates ───────────────────────────────────────────────────────────────────
// Local getters, never toISOString(): a pg DATE arrives as a local-midnight JS
// Date and toISOString() can roll it back a day west of UTC.
function ymd(v) {
  if (!v) return null;
  if (typeof v === 'string') return /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null;
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d)) return null;
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDaysYmd(s, n) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return ymd(dt);
}
/** Monday of the week containing `on` (ISO weeks: Monday starts the week). */
function mondayOf(on) {
  const [y, m, d] = on.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return addDaysYmd(on, -((dt.getDay() + 6) % 7));
}

// ── Age bands ───────────────────────────────────────────────────────────────
// Computed from date_of_birth on every request, never stored. Expressed as a
// DOB range rather than a month count so the SQL stays sargable and so a child
// crossing a boundary overnight needs no job to move them.
const AGE_BANDS = [
  { key: 'under_2', label: 'Under 2',  from: 0,  to: 24 },
  { key: '2_to_3',  label: '2–3 years', from: 24, to: 36 },
  { key: '3_to_4',  label: '3–4 years', from: 36, to: 48 },
  { key: '4_plus',  label: '4 and over', from: 48, to: null },
  { key: 'unknown', label: 'No date of birth', from: null, to: null },
];
const AGE_BAND_KEYS = new Set(AGE_BANDS.map(b => b.key));

function ageMonths(dob, on) {
  const d = ymd(dob);
  if (!d) return null;
  const [by, bm, bd] = d.split('-').map(Number);
  const [oy, om, od] = on.split('-').map(Number);
  let months = (oy - by) * 12 + (om - bm);
  if (od < bd) months -= 1;
  return months < 0 ? null : months;
}
function bandOf(dob, on) {
  const m = ageMonths(dob, on);
  if (m === null) return 'unknown';
  for (const b of AGE_BANDS) {
    if (b.key === 'unknown') continue;
    if (m >= b.from && (b.to === null || m < b.to)) return b.key;
  }
  return 'unknown';
}

// ═══════════════════════════════════════════════════════════════════════════
// Scope — who this board is about
// ═══════════════════════════════════════════════════════════════════════════
/**
 * A practitioner's own rooms. staff.room_id is the declared one, but most of the
 * roster has it NULL (it is a nominal field nobody fills in), so the rooms their
 * key children are actually in count too. Without this second source a widen-to-
 * room toggle would show an empty board for nearly everybody.
 */
async function ownRooms(db, staffId) {
  const { rows } = await db.query(`
    SELECT DISTINCT r FROM (
      SELECT room_id AS r FROM staff    WHERE id = $1 AND room_id IS NOT NULL
      UNION
      SELECT room_id AS r FROM children WHERE key_person_id = $1 AND is_active AND room_id IS NOT NULL
    ) t`, [staffId]);
  return rows.map(r => Number(r.r));
}

/**
 * Resolve the requested filters against what this user is allowed to see.
 * Returns { mode, keyPersonId, roomIds, allowedRoomIds, ageBand, denied }.
 * `denied` is a sentence for the UI when a filter was refused — a silent
 * narrowing would read as "there is nothing there", which is the false zero
 * again in a different costume.
 */
async function resolveScope(db, user, q) {
  const lead = isLead(user);
  const allowed = lead ? null : await ownRooms(db, user.id);   // null = every room

  const wantMode = ['mine', 'room', 'all'].includes(q.scope) ? q.scope : 'mine';
  const wantRooms = String(q.room_id || '').split(',')
    .map(n => parseInt(n, 10)).filter(Number.isInteger);
  const wantStaff = /^\d+$/.test(String(q.staff_id || '')) ? parseInt(q.staff_id, 10) : null;
  const ageBand = AGE_BAND_KEYS.has(q.age_band) ? q.age_band : null;

  const out = { mode: wantMode, keyPersonId: null, roomIds: null, allowedRoomIds: allowed,
                ageBand, denied: null, is_lead: lead, is_manager: isManager(user) };

  // Which key person's list is this? A lead may name anyone; everybody else is
  // themselves, and asking for somebody else is refused out loud.
  if (wantMode === 'mine') {
    out.keyPersonId = (lead && wantStaff) ? wantStaff : user.id;
  } else if (wantStaff && lead) {
    out.keyPersonId = wantStaff;
  } else if (wantStaff && wantStaff !== user.id) {
    out.denied = 'You can only see your own key children. Ask a room leader for anyone else’s list.';
  }

  if (wantMode === 'room') {
    let rooms = wantRooms;
    if (!lead) {
      const permitted = rooms.filter(r => allowed.includes(r));
      if (rooms.length && permitted.length !== rooms.length) {
        out.denied = 'That room is not one of yours, so it is not shown. You can see your own room and your own key children.';
      }
      rooms = permitted.length ? permitted : allowed;
      if (!rooms.length) {
        out.denied = 'You are not attached to a room and have no key children, so there is no room to widen to. '
                   + 'A manager can set your room on your staff record.';
      }
    }
    out.roomIds = rooms.length ? rooms : [-1];   // -1 = deliberately empty, not "everyone"
  } else if (wantMode === 'all') {
    if (!lead) {
      out.denied = 'The whole setting is a room-leader view. You are seeing your own room instead.';
      out.mode = 'room';
      out.roomIds = allowed.length ? allowed : [-1];
    }
  }
  return out;
}

/** The children this board is about, already age-filtered. One query, reused by every strand. */
async function scopedChildren(db, scope, on) {
  // Params are pushed only when the clause that uses them is added. A placeholder
  // that appears in the array but never in the SQL makes pg refuse the whole
  // statement with "could not determine data type of parameter $1".
  const params = [];
  const conds = ['c.is_active = true'];

  if (scope.mode === 'mine') { params.push(scope.keyPersonId); conds.push(`c.key_person_id = $${params.length}`); }
  if (scope.roomIds)         { params.push(scope.roomIds);     conds.push(`c.room_id = ANY($${params.length}::int[])`); }
  // A non-lead asking for the whole setting has already been downgraded to
  // 'room' in resolveScope, so 'all' here can only be a lead.

  if (scope.ageBand) {
    const b = AGE_BANDS.find(x => x.key === scope.ageBand);
    if (b.key === 'unknown') conds.push('c.date_of_birth IS NULL');
    else {
      params.push(on);
      const p = `$${params.length}::date`;
      conds.push('c.date_of_birth IS NOT NULL');
      // older bound: born on or before (on - from months)
      conds.push(`c.date_of_birth <= (${p} - interval '${b.from} months')`);
      if (b.to !== null) conds.push(`c.date_of_birth > (${p} - interval '${b.to} months')`);
    }
  }

  const { rows } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.room_id, c.key_person_id,
           to_char(c.date_of_birth,'YYYY-MM-DD') AS date_of_birth,
           rm.name AS room_name,
           kp.first_name || ' ' || kp.last_name AS key_person_name
      FROM children c
      LEFT JOIN rooms rm ON rm.id = c.room_id
      LEFT JOIN staff kp ON kp.id = c.key_person_id
     WHERE ${conds.join(' AND ')}
     ORDER BY COALESCE(c.preferred_name, c.first_name), c.last_name
     LIMIT 600`, params);

  return rows.map(r => ({
    child_id: r.id,
    name: [(r.preferred_name || r.first_name), r.last_name].filter(Boolean).join(' '),
    room_id: r.room_id, room_name: r.room_name || null,
    key_person_id: r.key_person_id, key_person_name: r.key_person_name || null,
    dob: r.date_of_birth,
    age_months: ageMonths(r.date_of_birth, on),
    age_band: bandOf(r.date_of_birth, on),
  }));
}

// ═══════════════════════════════════════════════════════════════════════════
// Strand helpers
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Every strand answers the same shape so the page can render nine blocks with
 * one function. `state`:
 *   ok           asked the source, nothing outstanding
 *   outstanding  asked the source, here is the work
 *   none         the strand does not apply to anyone in scope (e.g. no child is
 *                on phonics) — an honest zero WITH its reason, not a bare 0
 *   not_tracked  the source does not exist yet. Never rendered as a number.
 *   error        the query failed. Never rendered as a number.
 */
function strand(key, label, extra) {
  return Object.assign({
    key, label, state: 'ok', outstanding: 0, considered: 0,
    items: [], definition: null, note: null, route: key,
  }, extra || {});
}
const notTracked = (key, label, why, definition) =>
  strand(key, label, { state: 'not_tracked', outstanding: null, note: why, definition });

/** Does a table exist in the current search_path? Cheap, and cached per process. */
const _tableCache = new Map();
async function hasTable(db, name) {
  if (_tableCache.has(name)) return _tableCache.get(name);
  const { rows } = await db.query(
    `SELECT to_regclass($1) IS NOT NULL AS ok`, [name]);
  const ok = !!(rows[0] && rows[0].ok);
  _tableCache.set(name, ok);
  return ok;
}
async function hasColumn(db, table, col) {
  const k = table + '.' + col;
  if (_tableCache.has(k)) return _tableCache.get(k);
  const { rows } = await db.query(`
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [table, col]);
  const ok = rows.length > 0;
  _tableCache.set(k, ok);
  return ok;
}

const idsOf = kids => kids.map(k => k.child_id);
const byId = kids => new Map(kids.map(k => [k.child_id, k]));

/** Turn a set of child ids into board items, newest problem first is the caller's job. */
function childItems(kids, ids, detailFor) {
  const map = byId(kids);
  return ids.map(id => {
    const k = map.get(id);
    if (!k) return null;
    return {
      kind: 'child', child_id: k.child_id, label: k.name,
      sub: [k.room_name, detailFor ? detailFor(k) : null].filter(Boolean).join(' · '),
      room_id: k.room_id, room_name: k.room_name,
      key_person_id: k.key_person_id, key_person_name: k.key_person_name,
      age_band: k.age_band, age_months: k.age_months,
    };
  }).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Termly updates — b277's tracker, called not copied
// ═══════════════════════════════════════════════════════════════════════════
const DEF_TERMLY =
  'b277’s termly tracker for the current half-term, filtered to the children on this board. '
+ 'Outstanding = the tracker says this child is owed an update this cycle and it is not done '
+ '(no completion flag, no sent document). The number is the tracker’s own `outstanding` counter, '
+ 'so this page and /ey/termly-tracker can never disagree.';

async function strandTermly(db, kids, on, scope) {
  const key = 'termly', label = 'Termly updates';
  let out;
  try {
    out = await TT.trackerFor(db, { on });
  } catch (e) {
    return notTracked(key, label,
      'The termly cycle could not be read (' + e.message + '), so this strand is not counted.', DEF_TERMLY);
  }
  if (!out.cycle) {
    return notTracked(key, label,
      'No half-term is open on ' + on + '. Termly updates are counted against the school calendar '
      + '(Planning → Calendar); until a half-term covers today there is no cycle to be outstanding in.',
      DEF_TERMLY);
  }
  const inScope = new Set(idsOf(kids));
  const rows = out.children.filter(r => inScope.has(r.child_id));
  const owed = rows.filter(r => r.owed);
  const open = owed.filter(r => r.state !== 'done');

  // overdue first, then due, then in progress, then upcoming
  const rank = { overdue: 0, due: 1, in_progress: 2, upcoming: 3 };
  open.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9) || a.name.localeCompare(b.name));

  const map = byId(kids);
  return strand(key, label, {
    state: open.length ? 'outstanding' : 'ok',
    outstanding: open.length,
    considered: owed.length,
    definition: DEF_TERMLY,
    note: 'Cycle: ' + out.cycle.label + ' · due ' + out.cycle.due_on
        + ' · overdue from ' + out.cycle.overdue_on + '.',
    context: { cycle_key: out.cycle.key, cycle_label: out.cycle.label, due_on: out.cycle.due_on },
    items: open.map(r => {
      const k = map.get(r.child_id) || {};
      const words = r.state === 'overdue' ? (r.days_over + ' days past the due date')
                  : r.state === 'due' ? 'due now'
                  : r.state === 'in_progress' ? 'drafted, not sent to the family yet'
                  : 'due ' + r.due_on;
      return { kind: 'child', child_id: r.child_id, label: r.name,
               sub: [r.room_name, words].filter(Boolean).join(' · '),
               state: r.state, room_id: r.room_id, room_name: r.room_name,
               key_person_id: r.key_person_id, key_person_name: r.key_person_name,
               age_band: k.age_band || null, age_months: k.age_months ?? null };
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Two-year reports
// ═══════════════════════════════════════════════════════════════════════════
const DEF_TWO_YEAR =
  'Children aged 24 to 35 months inclusive on the board’s date, with no COMPLETED progress check. '
+ 'A check counts as complete from either of the two places Wren keeps them: a ladn.reports row with '
+ 'report_type = \'two_year_check\' that has been sent (status \'sent\'/\'completed\', or sent_at set), '
+ 'or a module_records row against the "EYFS 2-Year Progress Check" module. A draft sitting in review is '
+ 'shown as started, and still counts as outstanding — the family has not had it.';

async function strandTwoYear(db, kids, on) {
  const key = 'two_year', label = 'Two-year reports';
  const due = kids.filter(k => k.age_months !== null && k.age_months >= 24 && k.age_months < 36);
  if (!due.length) {
    return strand(key, label, {
      state: 'none', considered: 0, definition: DEF_TWO_YEAR,
      note: 'No child on this board is between 24 and 35 months old, so no progress check is due.',
    });
  }
  const ids = due.map(k => k.child_id);

  const { rows: done } = await db.query(`
    SELECT DISTINCT child_id, bool_or(complete) AS complete, max(status_txt) AS status_txt FROM (
      SELECT r.child_id,
             (r.status IN ('sent','completed') OR r.sent_at IS NOT NULL) AS complete,
             r.status AS status_txt
        FROM reports r
       WHERE r.report_type = 'two_year_check' AND r.child_id = ANY($1::int[])
      UNION ALL
      SELECT mr.entity_id AS child_id, true AS complete, 'filed'::text
        FROM module_records mr
        JOIN modules m ON m.id = mr.module_id
       WHERE m.slug = 'assess-eyfs-2yr-progress-check'
         AND mr.entity_type = 'child' AND mr.is_deleted = false
         AND mr.entity_id = ANY($1::int[])
    ) t GROUP BY child_id`, [ids]);

  const state = new Map(done.map(r => [Number(r.child_id), r]));
  const open = due.filter(k => !(state.get(k.child_id) || {}).complete);
  open.sort((a, b) => (b.age_months - a.age_months) || a.name.localeCompare(b.name));

  return strand(key, label, {
    state: open.length ? 'outstanding' : 'ok',
    outstanding: open.length, considered: due.length,
    definition: DEF_TWO_YEAR,
    note: due.length + ' child' + (due.length === 1 ? ' is' : 'ren are') + ' in the 24–35 month window.',
    items: open.map(k => {
      const st = state.get(k.child_id);
      const started = st ? ('started — ' + (st.status_txt || 'in progress')) : 'not started';
      return { kind: 'child', child_id: k.child_id, label: k.name,
               sub: [k.room_name, k.age_months + ' months', started].filter(Boolean).join(' · '),
               state: st ? 'in_progress' : 'not_started',
               room_id: k.room_id, room_name: k.room_name,
               key_person_id: k.key_person_id, key_person_name: k.key_person_name,
               age_band: k.age_band, age_months: k.age_months };
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Chat with parents
// ═══════════════════════════════════════════════════════════════════════════
const DEF_MESSAGES =
  'Message threads attached to a child on this board whose most recent message came FROM a parent and '
+ 'landed more than 24 hours ago. A thread whose last word is the setting’s is answered; a parent '
+ 'message from this morning is not late yet and is shown separately as "waiting". Threads with no child '
+ 'attached (staff DMs, waiting-list enquiries) belong to nobody’s key-children list and are not counted here.';

async function strandMessages(db, kids, on) {
  const key = 'messages', label = 'Chat with parents';
  if (!(await hasTable(db, 'message_threads')) || !(await hasTable(db, 'messages'))) {
    return notTracked(key, label, 'This edition has no message threads table.', DEF_MESSAGES);
  }
  const ids = idsOf(kids);
  if (!ids.length) return strand(key, label, { state: 'none', definition: DEF_MESSAGES, note: 'No children in scope.' });

  const { rows } = await db.query(`
    SELECT t.id AS thread_id, t.child_id, t.subject,
           m.sender_type, m.created_at,
           to_char(m.created_at,'YYYY-MM-DD HH24:MI') AS last_at,
           EXTRACT(EPOCH FROM (now() - m.created_at)) / 3600.0 AS hours_waiting
      FROM message_threads t
      JOIN LATERAL (
        SELECT sender_type, created_at FROM messages
         WHERE thread_id = t.id ORDER BY created_at DESC, id DESC LIMIT 1) m ON true
     WHERE t.child_id = ANY($1::int[])
       AND m.sender_type = 'parent'
     ORDER BY m.created_at ASC`, [ids]);

  const map = byId(kids);
  const late = rows.filter(r => Number(r.hours_waiting) >= 24);
  const waiting = rows.length - late.length;

  return strand(key, label, {
    state: late.length ? 'outstanding' : 'ok',
    outstanding: late.length,
    considered: rows.length,
    definition: DEF_MESSAGES,
    note: waiting
      ? waiting + ' more parent message' + (waiting === 1 ? '' : 's') + ' arrived in the last 24 hours — not late yet.'
      : (late.length
          ? 'Nothing else is waiting — these are the threads already past 24 hours.'
          : 'No parent is waiting on a reply.'),
    items: late.map(r => {
      const k = map.get(Number(r.child_id)) || {};
      const hrs = Math.floor(Number(r.hours_waiting));
      const wait = hrs >= 48 ? Math.floor(hrs / 24) + ' days' : hrs + ' hours';
      return { kind: 'thread', thread_id: r.thread_id, child_id: Number(r.child_id),
               label: k.name || ('Child #' + r.child_id),
               sub: [k.room_name, (r.subject || 'No subject'), 'waiting ' + wait].filter(Boolean).join(' · '),
               state: hrs >= 72 ? 'overdue' : 'due',
               room_id: k.room_id, room_name: k.room_name,
               key_person_id: k.key_person_id, key_person_name: k.key_person_name,
               age_band: k.age_band || null, age_months: k.age_months ?? null };
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Weekly observations target
// ═══════════════════════════════════════════════════════════════════════════
const DEF_OBS =
  'Observations written for each child between Monday of this week and the board’s date, counted as '
+ 'ROWS — b183’s rule: the per-practitioner target is effort-weighted (a group observation counts '
+ 'once, by group_uuid) but the per-CHILD target counts rows, because a child observed as part of a group '
+ 'is still an observed child. Drafts awaiting review count — the practitioner has done the writing. '
+ 'The weekly target is ladn.settings[obs_target_per_child_week] if set; otherwise it is derived from the '
+ 'existing obs_target_per_child_term divided by the number of weeks in the current half-term, so there is '
+ 'no second target to drift from the first.';

async function weeklyObsTarget(db, on) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN ('obs_target_per_child_week','obs_target_per_child_term')`);
  const s = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const explicit = parseInt(s.obs_target_per_child_week, 10);
  if (Number.isInteger(explicit) && explicit > 0) {
    return { target: explicit, source: 'settings.obs_target_per_child_week' };
  }
  const perTerm = parseInt(s.obs_target_per_child_term, 10);
  if (!Number.isInteger(perTerm) || perTerm <= 0) return { target: 1, source: 'default (no setting found)' };
  let weeks = 6;
  try {
    const { terms, breaks } = await CAL.loadCalendar(db, null);
    const ht = CAL.halfTermFor(terms, on);
    if (ht) weeks = Math.max(1, CAL.halfTermWeeks(ht, breaks).length);
  } catch (_) { /* fall back to a 6-week half term */ }
  return { target: Math.max(1, Math.round(perTerm / weeks)),
           source: 'derived: obs_target_per_child_term (' + perTerm + ') ÷ ' + weeks + ' weeks in this half-term' };
}

async function strandObservations(db, kids, on) {
  const key = 'observations', label = 'Weekly observations';
  const ids = idsOf(kids);
  if (!ids.length) return strand(key, label, { state: 'none', definition: DEF_OBS, note: 'No children in scope.' });

  const weekStart = mondayOf(on);
  const { target, source } = await weeklyObsTarget(db, on);

  const { rows } = await db.query(`
    SELECT c.id AS child_id, COUNT(o.id)::int AS n
      FROM children c
      LEFT JOIN observations o
             ON o.child_id = c.id
            AND o.created_at >= $2::date
            AND o.created_at <  ($3::date + 1)
     WHERE c.id = ANY($1::int[])
     GROUP BY c.id`, [ids, weekStart, on]);

  const counts = new Map(rows.map(r => [Number(r.child_id), r.n]));
  const under = kids.filter(k => (counts.get(k.child_id) || 0) < target);
  under.sort((a, b) => (counts.get(a.child_id) || 0) - (counts.get(b.child_id) || 0) || a.name.localeCompare(b.name));

  return strand(key, label, {
    state: under.length ? 'outstanding' : 'ok',
    outstanding: under.length, considered: kids.length,
    definition: DEF_OBS,
    note: 'Target ' + target + ' per child this week (' + source + '). Week from ' + weekStart + '.',
    context: { target, week_start: weekStart, target_source: source },
    items: under.map(k => {
      const n = counts.get(k.child_id) || 0;
      return { kind: 'child', child_id: k.child_id, label: k.name,
               sub: [k.room_name, n + ' of ' + target + ' this week'].filter(Boolean).join(' · '),
               state: n === 0 ? 'overdue' : 'due',
               room_id: k.room_id, room_name: k.room_name,
               key_person_id: k.key_person_id, key_person_name: k.key_person_name,
               age_band: k.age_band, age_months: k.age_months };
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Tracking
// ═══════════════════════════════════════════════════════════════════════════
const DEF_TRACKING =
  'Children with no tracker judgement recorded inside the current half-term. Two sources are accepted, '
+ 'because Wren records a judgement in two shapes: ladn.framework_tracker (a statement marked against a '
+ 'child, dated assessed_at) and ladn.band_judgements (b278’s per-area RANGE, dated judged_on). A child '
+ 'with either is tracked. The window is the half-term from ladn.school_terms that contains the board’s date.';

async function strandTracking(db, kids, on) {
  const key = 'tracking', label = 'Tracking';
  const ids = idsOf(kids);
  if (!ids.length) return strand(key, label, { state: 'none', definition: DEF_TRACKING, note: 'No children in scope.' });

  let ht = null;
  try {
    const { terms } = await CAL.loadCalendar(db, null);
    ht = CAL.halfTermFor(terms, on);
  } catch (e) {
    return notTracked(key, label, 'The school calendar could not be read (' + e.message + ').', DEF_TRACKING);
  }
  if (!ht) {
    return notTracked(key, label,
      'No half-term in ladn.school_terms contains ' + on + ', so "this term" has no dates to measure against. '
      + 'Set the term dates in Planning → Calendar.', DEF_TRACKING);
  }
  const from = ymd(ht.start_date), to = ymd(ht.end_date);

  const hasBands = await hasTable(db, 'band_judgements');
  const { rows } = await db.query(`
    SELECT c.id AS child_id,
           COUNT(ft.id)::int AS statements
           ${hasBands ? ', COUNT(bj.id)::int AS bands' : ', 0 AS bands'}
      FROM children c
      LEFT JOIN framework_tracker ft
             ON ft.child_id = c.id AND ft.assessed_at >= $2::date AND ft.assessed_at < ($3::date + 1)
      ${hasBands ? `LEFT JOIN band_judgements bj
             ON bj.child_id = c.id AND bj.judged_on >= $2::date AND bj.judged_on <= $3::date` : ''}
     WHERE c.id = ANY($1::int[])
     GROUP BY c.id`, [ids, from, to]);

  const seen = new Map(rows.map(r => [Number(r.child_id), Number(r.statements) + Number(r.bands)]));
  const open = kids.filter(k => !(seen.get(k.child_id) > 0));

  return strand(key, label, {
    state: open.length ? 'outstanding' : 'ok',
    outstanding: open.length, considered: kids.length,
    definition: DEF_TRACKING,
    note: ht.name + ' · ' + from + ' to ' + to
        + (hasBands ? '' : ' · band_judgements is not present in this edition, so only statements are counted.'),
    context: { half_term: ht.name, from, to },
    items: childItems(kids, open.map(k => k.child_id), () => 'nothing recorded this half-term')
      .map(i => Object.assign(i, { state: 'overdue' })),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Phonics
// ═══════════════════════════════════════════════════════════════════════════
const DEF_PHONICS =
  'Children whose per-child phonics switch is ON (ladn.children.phonics_enabled — b247: a child with the '
+ 'switch off has no phonics anywhere in Wren) with nothing recorded between Monday of this week and the '
+ 'board’s date. Three places count as an entry, because all three are how phonics gets recorded: '
+ 'ladn.phonics_tracker.updated_at (the tap-to-cycle sound grid), ladn.child_phonics_progress.last_assessed_at '
+ '(the per-sound assessment) and ladn.phonics_group_participants.assessed_at (a group session).';

async function strandPhonics(db, kids, on) {
  const key = 'phonics', label = 'Phonics';
  if (!(await hasColumn(db, 'children', 'phonics_enabled'))) {
    return notTracked(key, label,
      'This edition has no per-child phonics switch (children.phonics_enabled), so there is no phonics cohort to count.',
      DEF_PHONICS);
  }
  const ids = idsOf(kids);
  if (!ids.length) return strand(key, label, { state: 'none', definition: DEF_PHONICS, note: 'No children in scope.' });

  const weekStart = mondayOf(on);
  const { rows: enrolled } = await db.query(
    `SELECT id FROM children WHERE id = ANY($1::int[]) AND phonics_enabled = true`, [ids]);
  if (!enrolled.length) {
    return strand(key, label, {
      state: 'none', considered: 0, definition: DEF_PHONICS,
      note: 'No child on this board has the phonics switch turned on, so nothing is expected. '
          + 'The switch is per child, on their profile.',
    });
  }
  const eIds = enrolled.map(r => Number(r.id));

  const hasProgress = await hasTable(db, 'child_phonics_progress');
  const hasGroup = await hasTable(db, 'phonics_group_participants');
  const parts = [`SELECT child_id FROM phonics_tracker
                   WHERE child_id = ANY($1::int[]) AND updated_at >= $2::date AND updated_at < ($3::date + 1)`];
  if (hasProgress) parts.push(`SELECT child_id FROM child_phonics_progress
                   WHERE child_id = ANY($1::int[]) AND last_assessed_at >= $2::date AND last_assessed_at < ($3::date + 1)`);
  if (hasGroup) parts.push(`SELECT child_id FROM phonics_group_participants
                   WHERE child_id = ANY($1::int[]) AND assessed_at >= $2::date AND assessed_at < ($3::date + 1)`);

  const { rows: seenRows } = await db.query(
    `SELECT DISTINCT child_id FROM (${parts.join(' UNION ALL ')}) t`, [eIds, weekStart, on]);
  const seen = new Set(seenRows.map(r => Number(r.child_id)));
  const open = eIds.filter(id => !seen.has(id));

  return strand(key, label, {
    state: open.length ? 'outstanding' : 'ok',
    outstanding: open.length, considered: eIds.length,
    definition: DEF_PHONICS,
    note: eIds.length + ' child' + (eIds.length === 1 ? ' has' : 'ren have') + ' phonics switched on. Week from ' + weekStart + '.',
    context: { week_start: weekStart, enrolled: eIds.length },
    items: childItems(kids, open, () => 'nothing recorded this week')
      .map(i => Object.assign(i, { state: 'due' })),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Resources & activities
// ═══════════════════════════════════════════════════════════════════════════
const DEF_ACTIVITIES =
  'Rows in ladn.planned_activities with a plan_date inside this week (Monday to Sunday) whose status is still '
+ '\'planned\' or \'overdue\' — i.e. not \'happened\' and not \'cancelled\'. A child-scoped activity (one '
+ 'raised from a next step) belongs to that child’s key person; a room-scoped activity (child_id NULL) '
+ 'belongs to everyone working in that room, so it appears whenever the board covers that room. '
+ 'Resource cards attached to this week’s termly plan days are shown alongside as context, not counted.';

async function strandActivities(db, kids, on, scope) {
  const key = 'activities', label = 'Resources & activities';
  if (!(await hasTable(db, 'planned_activities'))) {
    return notTracked(key, label, 'This edition has no planned_activities table.', DEF_ACTIVITIES);
  }
  const weekStart = mondayOf(on);
  const weekEnd = addDaysYmd(weekStart, 6);
  const ids = idsOf(kids);
  const rooms = [...new Set(kids.map(k => k.room_id).filter(Boolean))];

  // Room-wide rows only when the board actually covers that room. In 'mine' scope
  // the rooms are the ones this practitioner's key children are in, which is the
  // right answer: those are the rooms they are standing in.
  const { rows } = await db.query(`
    SELECT pa.id, pa.plan_date, to_char(pa.plan_date,'YYYY-MM-DD') AS on_ymd,
           pa.slot, pa.status, pa.child_id, pa.room_id,
           COALESCE(pa.title, pa.custom_title, ca.name, 'Untitled activity') AS title,
           rm.name AS room_name
      FROM planned_activities pa
      LEFT JOIN curriculum_activities ca ON ca.id = pa.activity_id
      LEFT JOIN rooms rm ON rm.id = COALESCE(pa.room_id, (SELECT room_id FROM children WHERE id = pa.child_id))
     WHERE pa.plan_date >= $1::date AND pa.plan_date <= $2::date
       AND COALESCE(pa.status,'planned') IN ('planned','overdue')
       AND ( pa.child_id = ANY($3::int[])
             OR (pa.child_id IS NULL AND pa.room_id = ANY($4::int[])) )
     ORDER BY pa.plan_date, pa.id`, [weekStart, weekEnd, ids.length ? ids : [-1], rooms.length ? rooms : [-1]]);

  // ⚠ "0 undelivered" has two completely different meanings and they must not
  // share a word. Everything planned this week HAS been delivered → "all done".
  // Nothing was planned for this week at all → "nothing planned", which is a
  // prompt to go and plan, not permission to relax.
  const { rows: [planned] } = await db.query(`
    SELECT COUNT(*)::int AS n FROM planned_activities pa
     WHERE pa.plan_date >= $1::date AND pa.plan_date <= $2::date
       AND ( pa.child_id = ANY($3::int[])
             OR (pa.child_id IS NULL AND pa.room_id = ANY($4::int[])) )`,
    [weekStart, weekEnd, ids.length ? ids : [-1], rooms.length ? rooms : [-1]]);

  // Context only: how much of this week's plan has resource cards on it.
  let cards = null;
  try {
    if (await hasTable(db, 'termly_plan_days')) {
      const { rows: cr } = await db.query(`
        SELECT COUNT(*)::int AS days,
               COUNT(*) FILTER (WHERE jsonb_array_length(COALESCE(resource_card_ids,'[]'::jsonb)) > 0)::int AS with_cards
          FROM termly_plan_days d
          JOIN termly_plan_weeks w ON w.plan_id = d.plan_id AND w.week_no = d.week_no
         WHERE w.week_commencing = $1::date
           AND ($2::int[] = '{}' OR COALESCE(d.room_id, w.room_id) = ANY($2::int[]))`,
        [weekStart, rooms]);
      cards = cr[0] || null;
    }
  } catch (_) { cards = null; }

  const map = byId(kids);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return strand(key, label, {
    state: rows.length ? 'outstanding' : (planned.n ? 'ok' : 'none'),
    outstanding: rows.length, considered: planned.n,
    definition: DEF_ACTIVITIES,
    note: (planned.n
            ? planned.n + ' activit' + (planned.n === 1 ? 'y is' : 'ies are') + ' planned for this week. '
            : 'Nothing is planned for this week yet — that is not the same as everything being delivered. ')
        + 'Week ' + weekStart + ' to ' + weekEnd
        + (cards ? ' · ' + cards.with_cards + ' of ' + cards.days
                   + ' planned sessions this week have resource cards attached.' : ''),
    context: { week_start: weekStart, week_end: weekEnd, planned_this_week: planned.n, resource_cards: cards },
    items: rows.map(r => {
      const k = r.child_id ? map.get(Number(r.child_id)) : null;
      const d = new Date(r.on_ymd + 'T00:00:00');
      const when = weekday[d.getDay()] + ' ' + r.on_ymd.slice(8) + '/' + r.on_ymd.slice(5, 7);
      return { kind: 'activity', id: r.id, child_id: r.child_id ? Number(r.child_id) : null,
               label: r.title,
               sub: [when, r.slot || null, k ? 'for ' + k.name : (r.room_name || 'whole setting')]
                      .filter(Boolean).join(' · '),
               state: r.on_ymd < on ? 'overdue' : (r.on_ymd === on ? 'due' : 'upcoming'),
               room_id: r.room_id, room_name: r.room_name,
               key_person_id: k ? k.key_person_id : null, key_person_name: k ? k.key_person_name : null,
               age_band: k ? k.age_band : null, age_months: k ? k.age_months : null };
    }),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Planning
// ═══════════════════════════════════════════════════════════════════════════
const DEF_PLANNING =
  'For every room this board covers: (a) the current half-term with no ladn.term_plans row — nobody has '
+ 'set a theme for that room; and (b) each plannable week of the current half-term (from ladn.school_terms '
+ 'minus ladn.school_breaks) with no ladn.termly_plan_weeks row for that room. Weeks already past are shown '
+ 'as overdue, the current week as due, later weeks as upcoming. If no half-term contains the board’s '
+ 'date the strand is not counted rather than shown as zero.';

async function strandPlanning(db, kids, on, scope) {
  const key = 'planning', label = 'Planning';
  let terms, breaks, ht;
  try {
    ({ terms, breaks } = await CAL.loadCalendar(db, null));
    ht = CAL.halfTermFor(terms, on);
  } catch (e) {
    return notTracked(key, label, 'The school calendar could not be read (' + e.message + ').', DEF_PLANNING);
  }
  if (!ht) {
    return notTracked(key, label,
      'No half-term in ladn.school_terms contains ' + on + ', so there is no half-term to plan. '
      + 'Set the term dates in Planning → Calendar.', DEF_PLANNING);
  }

  // The rooms this board is about. In 'mine' scope that is the rooms the
  // practitioner's key children sit in — planning is a room job, and those are
  // the rooms they work in.
  let rooms = scope.roomIds && scope.roomIds[0] !== -1 ? scope.roomIds
            : [...new Set(kids.map(k => k.room_id).filter(Boolean))];
  if (scope.mode === 'all') {
    const { rows } = await db.query('SELECT id FROM rooms ORDER BY id');
    rooms = rows.map(r => Number(r.id));
  }
  if (!rooms.length) {
    return strand(key, label, {
      state: 'none', definition: DEF_PLANNING,
      note: 'This board covers no room (no key children with a room, and no room filter), so there is nothing to plan against.',
    });
  }

  const weeks = CAL.halfTermWeeks(ht, breaks);   // [{week_no, week_commencing, ...}]
  const roomNames = new Map();
  {
    const { rows } = await db.query('SELECT id, name FROM rooms WHERE id = ANY($1::int[])', [rooms]);
    rows.forEach(r => roomNames.set(Number(r.id), r.name));
  }

  const { rows: plans } = await db.query(`
    SELECT p.id AS plan_id, p.room_id, p.theme
      FROM term_plans p
     WHERE p.school_term_id = $1 AND p.room_id = ANY($2::int[])`, [ht.id, rooms]);
  const planByRoom = new Map(plans.map(p => [Number(p.room_id), p]));

  const planIds = plans.map(p => p.plan_id);
  const filled = new Set();
  if (planIds.length) {
    const { rows: wk } = await db.query(`
      SELECT plan_id, week_no, room_id FROM termly_plan_weeks WHERE plan_id = ANY($1::int[])`, [planIds]);
    const roomOfPlan = new Map(plans.map(p => [Number(p.plan_id), Number(p.room_id)]));
    wk.forEach(w => filled.add((w.room_id != null ? Number(w.room_id) : roomOfPlan.get(Number(w.plan_id))) + ':' + w.week_no));
  }

  const thisMonday = mondayOf(on);
  const items = [];
  for (const roomId of rooms) {
    const rName = roomNames.get(roomId) || ('Room #' + roomId);
    const plan = planByRoom.get(roomId);
    if (!plan) {
      items.push({ kind: 'plan', id: 'ht:' + roomId, room_id: roomId, room_name: rName,
                   label: rName + ' — ' + ht.name + ' has no plan',
                   sub: 'No theme, intentions or books set for this half-term',
                   state: 'overdue' });
      continue;   // no plan row means every week is unplanned; one line says it better than six
    }
    for (const w of weeks) {
      const wc = ymd(w.week_commencing);
      if (filled.has(roomId + ':' + w.week_no)) continue;
      items.push({ kind: 'plan', id: 'wk:' + roomId + ':' + w.week_no, room_id: roomId, room_name: rName,
                   label: rName + ' — week ' + w.week_no + ' not planned',
                   sub: 'Week commencing ' + wc,
                   state: wc < thisMonday ? 'overdue' : (wc === thisMonday ? 'due' : 'upcoming') });
    }
  }
  const rank = { overdue: 0, due: 1, upcoming: 2 };
  items.sort((a, b) => (rank[a.state] - rank[b.state]) || a.label.localeCompare(b.label));

  return strand(key, label, {
    state: items.length ? 'outstanding' : 'ok',
    outstanding: items.length,
    considered: rooms.length * (weeks.length || 1),
    definition: DEF_PLANNING,
    note: ht.name + ' · ' + weeks.length + ' plannable week' + (weeks.length === 1 ? '' : 's')
        + ' · ' + rooms.length + ' room' + (rooms.length === 1 ? '' : 's') + ' on this board.',
    context: { half_term: ht.name, weeks: weeks.length, rooms: rooms.length },
    items,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// The board
// ═══════════════════════════════════════════════════════════════════════════
const STRAND_ORDER = ['termly', 'two_year', 'messages', 'observations', 'tracking',
                      'phonics', 'activities', 'planning'];

async function board(db, user, q) {
  const on = ymd(q.on) || ymd(new Date());
  const scope = await resolveScope(db, user, q);
  const kids = await scopedChildren(db, scope, on);

  const run = (fn, key, label) => fn().catch(e => strand(key, label, {
    state: 'error', outstanding: null,
    note: 'This strand could not be read: ' + e.message + '. It is shown as unknown, never as zero.',
  }));

  const results = await Promise.all([
    run(() => strandTermly(db, kids, on, scope), 'termly', 'Termly updates'),
    run(() => strandTwoYear(db, kids, on), 'two_year', 'Two-year reports'),
    run(() => strandMessages(db, kids, on), 'messages', 'Chat with parents'),
    run(() => strandObservations(db, kids, on), 'observations', 'Weekly observations'),
    run(() => strandTracking(db, kids, on), 'tracking', 'Tracking'),
    run(() => strandPhonics(db, kids, on), 'phonics', 'Phonics'),
    run(() => strandActivities(db, kids, on, scope), 'activities', 'Resources & activities'),
    run(() => strandPlanning(db, kids, on, scope), 'planning', 'Planning'),
  ]);
  const byKey = new Map(results.map(s => [s.key, s]));
  const strands = STRAND_ORDER.map(k => byKey.get(k)).filter(Boolean);

  // ── The empty scope is a false zero wearing a different hat ────────────────
  // A practitioner with no key children asked for "my children" and every strand
  // came back 0. Read literally that says "you are up to date"; the truth is
  // "nobody has been assigned to you". A strand that reached its source and found
  // nothing IN AN EMPTY SCOPE is downgraded from 'ok' ("all done") to 'none'
  // ("nothing expected") and says why. This is the same rule as not_tracked,
  // applied to the scope rather than to the source.
  let emptyReason = null;
  if (!kids.length) {
    emptyReason = scope.mode === 'mine'
      ? 'No children are assigned to this key person, so “my children” is empty — that is not the same as being '
        + 'up to date. Switch to a room to see the work in front of you.'
      : 'No children match this room and age filter. Nothing below is a claim that the work is done.';
    for (const s of strands) {
      if (s.state === 'ok' && s.outstanding === 0) {
        s.state = 'none';
        s.note = emptyReason + (s.note ? ' ' + s.note : '');
      }
    }
  }

  const counted = strands.filter(s => typeof s.outstanding === 'number');
  const total = counted.reduce((a, s) => a + s.outstanding, 0);

  return {
    on,
    week_start: mondayOf(on),
    scope: {
      mode: scope.mode,
      key_person_id: scope.keyPersonId,
      room_ids: scope.roomIds && scope.roomIds[0] !== -1 ? scope.roomIds : null,
      age_band: scope.ageBand,
      is_lead: scope.is_lead,
      is_manager: scope.is_manager,
      allowed_room_ids: scope.allowedRoomIds,     // null = every room
      denied: scope.denied,
      empty_reason: emptyReason,
    },
    children_in_scope: kids.length,
    total_outstanding: total,
    unknown_strands: strands.filter(s => s.outstanding === null).map(s => s.key),
    strands,
  };
}

/** Rooms + practitioners the filter bar may offer this user. */
async function filters(db, user) {
  const lead = isLead(user);
  const allowed = lead ? null : await ownRooms(db, user.id);
  const { rows: rooms } = await db.query('SELECT id, name FROM rooms ORDER BY name');
  let staff = [];
  if (lead) {
    const { rows } = await db.query(`
      SELECT s.id, s.first_name || ' ' || s.last_name AS name, s.role,
             COUNT(c.id)::int AS key_children
        FROM staff s
        LEFT JOIN children c ON c.key_person_id = s.id AND c.is_active
       WHERE s.is_active = true
       GROUP BY s.id, name, s.role
       HAVING COUNT(c.id) > 0
       ORDER BY name`);
    staff = rows;
  }
  return {
    rooms: rooms
      .filter(r => allowed === null || allowed.includes(Number(r.id)))
      .map(r => ({ id: Number(r.id), name: r.name })),
    all_rooms: rooms.map(r => ({ id: Number(r.id), name: r.name })),
    age_bands: AGE_BANDS.map(b => ({ key: b.key, label: b.label })),
    practitioners: staff,
    is_lead: lead,
    is_manager: isManager(user),
    me: { id: user.id, role: user.role },
  };
}

module.exports = {
  board, filters, resolveScope, scopedChildren,
  AGE_BANDS, STRAND_ORDER, isLead, isManager,
  _internal: { ymd, mondayOf, ageMonths, bandOf, weeklyObsTarget },
};
