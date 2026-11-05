'use strict';
/**
 * my-morning.js — b286 (2026-09-08). Mounted at /api/my-morning.
 *
 * The one page a practitioner opens each morning: eight strands of outstanding
 * work for THEIR children, on one screen, with no drilling.
 *
 * This router is thin on purpose. Every definition of "outstanding" lives in
 * src/services/morning-board.js, and where one already existed elsewhere the
 * service calls it rather than restating it (the termly strand runs b277's
 * tracker). Nothing here writes.
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 * Staff session required. The response names children and gives their key
 * person, so the mount is listed in server-unified.js's PARENT_DENY / HR_DENY /
 * _ONSITE_CHILD_DATA / OFFSITE_CHILD sets alongside 'termly-watcher',
 * 'report-cycle' and 'two-year-check' — the same class of data.
 *
 * Within that, scoping is the service's job and it is role-based, not
 * capability-based, for the reason in memory/reference_hascapability_ignores_
 * level.md: hasCapability() ignores the level, so a 'view' grant would open a
 * gate meant for a lead. b243, b244, b246 and b277 all gate this class of data
 * on the role, and this board must agree with them or it would show a
 * practitioner a list its own source pages refuse them.
 *
 * A practitioner sees their own key children by default and may widen only to a
 * room they are actually in. A lead may pick any room, any key person, or the
 * whole setting — that is the Roost view.
 */

const express = require('express');
const router = express.Router();

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const MB = require('../services/morning-board');
const MD = require('../services/my-day');

router.use(authenticate);

// ═══════════════════════════════════════════════════════════════════════════
// GET /filters — the rooms, age bands and (for a lead) practitioners on offer
// ═══════════════════════════════════════════════════════════════════════════
// Separate from /board so the filter bar renders once and the board can be
// re-fetched on every filter change without re-sending the option lists. A
// practitioner is offered only the rooms they are in — the server refuses the
// rest anyway, but a filter you are not allowed to use should not be in the list.
router.get('/filters', async (req, res) => {
  try {
    res.json(await MB.filters(getPool(), req.user));
  } catch (e) {
    console.error('my-morning filters:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /board — the morning board itself
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Query: scope=mine|room|all, room_id=1,2, age_band=under_2|2_to_3|3_to_4|4_plus|unknown,
 *        staff_id=<key person, leads only>, on=YYYY-MM-DD (defaults to today).
 *
 * Every strand carries its OWN children, not just a count, so a number on the
 * page is clickable without a second request — and so a count can never be
 * shown that the page cannot itemise. A strand whose source is missing comes
 * back with outstanding: null and state 'not_tracked'; the page must render
 * that as words, never as 0.
 */
router.get('/board', async (req, res) => {
  try {
    res.json(await MB.board(getPool(), req.user, req.query || {}));
  } catch (e) {
    console.error('my-morning board:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /day — "my day", b358 (2026-09-29)
// ═══════════════════════════════════════════════════════════════════════════
/**
 * Toby: "This is the first thing staff should be shown once they login."
 *
 * Appended beside /board rather than folded into it, because the two answer
 * different questions and have different shapes. /board is the eight-strand
 * caseload view, shared with Roost and filterable across rooms and key people.
 * /day is a quick glance at the signed-in person's OWN day — what is on, who is
 * off, who is in, what they have been asked to do — and takes no scope at all:
 * the staff id comes from the signed token and cannot be named in the query
 * string, so this endpoint can only ever describe the caller.
 *
 * Query: on=YYYY-MM-DD (defaults to today), for testing a given date.
 *
 * Every block carries its own definition, and a block whose source is missing
 * comes back with count: null and state 'not_tracked' — the page must render
 * that as words, never as 0. services/my-day.js has the reasoning.
 */
router.get('/day', async (req, res) => {
  try {
    res.json(await MD.day(getPool(), req.user, req.query || {}));
  } catch (e) {
    console.error('my-morning day:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
