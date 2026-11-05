'use strict';
/**
 * Fob enrolment listener (b199, 2026-08-19).
 *
 * THE PROBLEM THIS SOLVES: a Mifare card number is 8 hex characters with no visual
 * clue on the fob itself. Reading it off the Dahua UI and typing it into Wren is the
 * step that goes wrong — one transposed character and the fob silently never works.
 *
 * So instead: Toby arms "listen for the next swipe" in Roost, taps the fob on the
 * reader, and the number arrives on its own. The bridge already forwards every swipe
 * to POST /api/clockin/dahua-webhook, which lands in handleFobEvent — that is where
 * capture() is called from, for known AND unknown cards alike (a known card needs to
 * show up too, otherwise re-assigning an existing fob looks like a broken reader).
 *
 * DELIBERATELY IN-MEMORY, NOT IN THE DB. An armed listener is a 2-minute UI state,
 * not a record: it must not survive a restart, must not replicate between processes,
 * and must expire on its own if Toby walks away mid-enrolment. Wren runs the door
 * console in one process (wren-ladn), so a module-level singleton is the whole story.
 *
 * SECURITY: arming is manager-only (enforced at the route). Capture stores a card
 * number and a first name — no PII beyond what the fob list already shows — and the
 * whole state is dropped on disarm, on claim, and on expiry.
 */

const DEFAULT_TTL_MS = 120_000;   // 2 minutes: long enough to walk to the reader
const MAX_TTL_MS     = 600_000;   // never leave a listener armed longer than 10 min

let _state = null;   // { armedBy, armedByName, expiresAt, capture } | null

function _live() {
  if (_state && _state.expiresAt <= Date.now()) _state = null;
  return _state;
}

/** Arm the listener for `ttlMs`. Re-arming replaces any existing listener. */
function arm({ staffId, staffName, ttlMs } = {}) {
  const ttl = Math.min(Math.max(parseInt(ttlMs, 10) || DEFAULT_TTL_MS, 10_000), MAX_TTL_MS);
  _state = {
    armedBy: staffId || null,
    armedByName: staffName || null,
    armedAt: Date.now(),
    expiresAt: Date.now() + ttl,
    capture: null,
  };
  return getState();
}

function disarm() { _state = null; return getState(); }

/** Is a listener currently armed? Cheap enough to call on every swipe. */
function isArmed() { return !!_live(); }

/**
 * Record a swipe seen while armed. No-op when nothing is listening, so the fob
 * hot-path in clockin.js pays almost nothing for this.
 *
 * @param {object} evt
 * @param {string} evt.card_no       the raw card number as the reader reported it
 * @param {boolean} evt.known        does it already match an active staff_fobs row?
 * @param {number}  [evt.staff_id]   who it is assigned to, when known
 * @param {string}  [evt.staff_name] their name, when known
 * @param {string}  [evt.door_name]
 */
function capture(evt) {
  const s = _live();
  if (!s || !evt || !evt.card_no) return false;
  s.capture = {
    card_no: String(evt.card_no).toUpperCase().trim().slice(0, 64),
    known: !!evt.known,
    staff_id: evt.staff_id || null,
    staff_name: evt.staff_name || null,
    door_name: evt.door_name || null,
    seen_at: new Date().toISOString(),
  };
  return true;
}

/** Snapshot for the polling UI. Always a plain object — never null. */
function getState() {
  const s = _live();
  if (!s) return { armed: false, capture: null, expires_in: 0 };
  return {
    armed: true,
    armed_by: s.armedBy,
    armed_by_name: s.armedByName,
    expires_in: Math.max(0, Math.round((s.expiresAt - Date.now()) / 1000)),
    capture: s.capture,
  };
}

/** Take the captured swipe and stop listening — used once it has been assigned. */
function claim() {
  const s = _live();
  const cap = s ? s.capture : null;
  _state = null;
  return cap;
}

// ── b250: the ONE place that decides what a "swipe" row looks like ──────────
// ladn.door_events holds two very different kinds of 'card' row: an actual tap at
// the reader (written by clockin.js logCardSwipe) and a management action — issued,
// revoked, replaced (written by door.js logDoorEvent). They were indistinguishable,
// so the Roost keyring's "last swipe" happily reported the moment a fob was ISSUED
// as though someone had used it. On a screen whose whole job is to say what is true
// of the door, that is exactly the wrong lie to tell.
//
// door_events.event_type cannot grow a new value — door_events_type_chk allows only
// ring/open/denied/card, and widening a production check constraint is not this
// build's business. So the discriminator is the reason text, defined HERE and used
// by both sides: clockin.js builds it, door.js matches on it. Neither file owns a
// copy of the string.
const SWIPE_MARKER = 'presented at';

/** The reason text for a real tap at the reader. */
function swipeReason(doorLabel, known) {
  return known
    ? `fob ${SWIPE_MARKER} ${doorLabel}`
    : `UNASSIGNED fob ${SWIPE_MARKER} ${doorLabel} — not registered to any staff member`;
}

/** SQL ILIKE pattern that matches a swipe row and nothing else. */
const SWIPE_SQL_PATTERN = `%${SWIPE_MARKER}%`;

module.exports = { arm, disarm, isArmed, capture, getState, claim, DEFAULT_TTL_MS,
                   SWIPE_MARKER, swipeReason, SWIPE_SQL_PATTERN };
