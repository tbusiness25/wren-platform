'use strict';
// ===========================================================================
// b289 (2026-09-08) — where a pipeline child CAME FROM and what happens NEXT.
//
// Toby, relaying the office manager: "Elody is on eylog but on wren she is still on pipeline —
// does she need to be sent registration via wren too or will she be sent over via
// eylog — confusing!"
//
// THE ANSWER, established by reading /app/eylog-sync.sh rather than assuming:
// the nightly sync does NOT promote anybody. Its steps are observations,
// attendance, daily diary, framework tracker, accidents, sleep checks, assessment
// snapshots, reports, and (since 2026-08-19) EyMan enquiries INTO the pipeline.
// The only step that can write ladn.children at all is b190 import-child-gaps.py,
// which is gated behind EYLOG_B190 (unset — the log records "SKIPPED" every night)
// and is blank-fill-only on rows that already exist; it never creates a child.
// import-enquiries.py states outright that Wren-side stage/status are never
// overwritten. So a child who is enrolled in EyLog and sitting in the Wren pipeline
// will sit there for ever. Somebody has to register them in Wren.
//
// A correct database that reads ambiguously is still broken, so that answer is
// computed per row and rendered on the card instead of being folk knowledge.
// ===========================================================================

// How the row got into Wren. Sources are free text and case-inconsistent
// ('eyman' / 'eylog' / 'website' / 'planner-import' / 'Website').
const SOURCE_LABELS = [
  [/^eylog$|^eyman$/i,      'EyLog / EyMan import'],
  [/^planner[- ]?import$/i, 'Planner import'],
  [/^website$/i,            'Website form'],
  [/^phone$/i,              'Phone'],
  [/^referral$/i,           'Referral'],
  [/^walk[- ]?in$/i,        'Walk-in'],
];
function sourceLabel(source) {
  const s = String(source || '').trim();
  if (!s) return 'Unknown';
  for (const [re, label] of SOURCE_LABELS) if (re.test(s)) return label;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// pg hands back a DATE as a local-midnight JS Date. String() gives "Sun Sep 20 2026"
// and toISOString() can roll it back a day across BST — so read the local parts.
function ymdLocal(d) {
  if (!d) return null;
  const t = (d instanceof Date) ? d : new Date(d);
  if (isNaN(t)) return String(d).slice(0, 10);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}

const nameKey = (first, last) =>
  `${String(first || '').trim().toLowerCase()}|${String(last || '').trim().toLowerCase()}`;

/**
 * One query, then O(1) lookups. Keyed on normalised child name because the
 * pipeline tables carry no child_id — linking them by name is exactly what
 * surfaced Elody's duplicate child record, so the same rule is used here.
 * Duplicate child rows are kept in a list so the UI can say so rather than
 * silently picking one.
 */
async function loadEnrolmentIndex(db) {
  const { rows } = await db.query(`
    SELECT id, first_name, last_name, is_active, start_date, room_id, status,
           (eylog_child_id IS NOT NULL) AS from_eylog
    FROM children
    ORDER BY is_active DESC, id`);
  const idx = new Map();
  for (const c of rows) {
    const k = nameKey(c.first_name, c.last_name);
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(c);
  }
  return idx;
}

/**
 * Returns { source_label, provenance, pipeline_state, pipeline_next,
 *           enrolled_child_id, enrolled_child_ids, room_status }
 * pipeline_state is one of:
 *   'registered'        — a child record already exists and is active
 *   'registered_left'   — a child record exists but is archived
 *   'needs_registering' — nothing in ladn.children matches
 */
function describe(row, idx, { roomIsUsable } = {}) {
  const matches = idx.get(nameKey(row.child_first_name, row.child_last_name)) || [];
  const active = matches.filter(c => c.is_active);
  // b398 — a self-service registration (the b321/onboarding-public.js flow, and
  // now the waiting-list "Send registration link…") creates the child row
  // straight away as is_active=false, status='pending', awaiting a manager's
  // approval. That used to fall into the SAME bucket as a child who has
  // actually LEFT (also is_active=false), and read "archived" — exactly
  // backwards for a family mid-registration. Split them.
  const pending = matches.filter(c => !c.is_active && c.status === 'pending');
  const archived = matches.filter(c => !c.is_active && c.status !== 'pending');
  const usable = typeof roomIsUsable === 'function'
    ? roomIsUsable(row.room_needed)
    : !!(row.room_needed && !String(row.room_needed).includes(':'));

  let state, next;
  if (active.length) {
    state = 'registered';
    next = active.length > 1
      // Registering the same child twice is what the confusion actually causes, so
      // say it plainly rather than showing one of the two and looking correct.
      ? `Already registered in Wren — but there are ${active.length} child records under this name (#${active.map(c => c.id).join(', #')}). One needs removing.`
      : `On roll (child #${active[0].id}${active[0].start_date ? `, starts ${ymdLocal(active[0].start_date)}` : ''}). Nothing to send — close this pipeline entry.`;
  } else if (pending.length) {
    state = 'pending_approval';
    next = `Registered — awaiting approval (child #${pending[0].id}). Approve it in Children → pending to put them on roll.`;
  } else if (archived.length) {
    state = 'registered_left';
    next = `A child record exists (#${archived[0].id}) but is archived. Check whether this pipeline entry is a re-enquiry before doing anything.`;
  } else {
    state = 'needs_registering';
    next = 'Not registered in Wren. The nightly EyLog sync will NOT do this — it imports observations, registers and enquiries only, never a new child. Somebody has to register them here.';
  }

  return {
    source_label: sourceLabel(row.source),
    provenance: sourceLabel(row.source),
    pipeline_state: state,
    pipeline_next: next,
    enrolled_child_id: active.length ? active[0].id : (pending.length ? pending[0].id : (archived.length ? archived[0].id : null)),
    enrolled_child_ids: matches.map(c => c.id),
    // 'set' | 'pattern' (the import put a booking pattern in the room field) | 'none'
    room_status: usable ? 'set'
      : (row.room_needed && String(row.room_needed).includes(':')) ? 'pattern' : 'none',
  };
}

module.exports = { loadEnrolmentIndex, describe, sourceLabel, nameKey, ymdLocal };
