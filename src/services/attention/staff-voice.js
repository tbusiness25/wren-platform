'use strict';
/**
 * staff-voice.js — b345 collector for the "What needs me" board.
 *
 * ONE card, when anonymous comments from staff are waiting for a manager to read them:
 * "3 anonymous comments from staff are waiting". It goes green by itself the moment none are
 * marked new. That is the whole digest — a manager who wants more opens Staff → Staff voice.
 *
 * ── CONTENT ────────────────────────────────────────────────────────────�
 * A count and the week the oldest arrived. Never a word of a comment, and nothing about who wrote
 * one — there is nothing to say, the table has no such column. Named entries (what a practitioner
 * wrote about themselves) never raise a card at all: the brief is explicit that nothing pushes a
 * named comment at a manager, least of all with its writer's name on it.
 *
 * It is not urgent and it is not statutory, so it is amber only in the sense every "waiting on
 * Toby" item is amber (rag.js: blocked on Toby). If the b345 migration has not been applied the
 * collector answers "nothing to report" rather than failing, so prod stays quiet until it is.
 */
const { getPool } = require('../../db/pool');
const { classify } = require('./rag');

const SOURCE = 'staff-voice';

async function collect() {
  const db = getPool();
  // b521 — Toby, 2026-10-20: "let's also remove the strengths and voice from staff
  // on Roost." Switched off through feature_flags.staff_voice, the same key the
  // Staff > Staff voice tab and the staff-profile tab read, so the card and the tab
  // it links to are never out of step: a card pointing at a hidden tab is a dead
  // end. Fail-open (missing key, or a query that errors, leaves the card on), and
  // nothing in staff_voice_anonymous is touched.
  try {
    const { rows: f } = await db.query("SELECT is_enabled FROM feature_flags WHERE key='staff_voice'");
    if (f.length && !f[0].is_enabled) return { ok: true, items: [], note: 'staff_voice feature off' };
  } catch (e) { /* fail open */ }
  let n = 0, oldest = null;
  try {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, to_char(min(received_week), 'YYYY-MM-DD') AS oldest
         FROM staff_voice_anonymous WHERE status = 'new'`);
    n = rows[0].n; oldest = rows[0].oldest;
  } catch (e) {
    if (e.code === '42P01') return { ok: true, items: [], note: 'b345 migration not applied' };
    throw e;
  }
  if (!n) return { ok: true, items: [] };

  const c = classify({ blockedOnToby: true });
  return {
    ok: true,
    items: [{
      source: SOURCE,
      source_key: 'anonymous-waiting',
      title: n === 1 ? 'One anonymous comment from staff is waiting' : `${n} anonymous comments from staff are waiting`,
      detail: `The oldest arrived in the week of ${oldest}. Read them in Staff → Staff voice and mark each one read or actioned — `
            + 'that is what clears this card. They are anonymous: there is nobody to reply to.',
      why: c.why,
      rag: c.rag,
      category: 'staff',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: Math.min(30, 5 * n),
      action_url: '/admin/staff/staff-voice',
      evidence: { table: 'staff_voice_anonymous', count: n },
      sort_hint: 2,
    }],
  };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
