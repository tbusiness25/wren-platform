'use strict';
/**
 * room-meetings.js — b530 collector for the "What needs me" board.
 *
 * The manager half of Toby's ask. Two cards at most, never one per meeting:
 *
 *   rooms-not-meeting   a room has gone more than two weeks without HOLDING a
 *                       room meeting. This is the escalation the brief asks for,
 *                       and it is the same sentence the bell sends — both read
 *                       src/lib/room-meetings.js's roomsWithoutAMeeting(), so a
 *                       card and a nudge can never disagree about which rooms.
 *   minutes-outstanding meetings that happened and were never written up.
 *
 * Room meetings are the ROOM LEADER's to organise — that is the whole point of
 * the feature — so neither card is a job for Toby to do himself. Both are
 * blocked_on 'toby' because the board's own CHECK allows only toby / claude /
 * external and he is the person who acts on it; what he does is have a
 * conversation, which is what the detail says in as many words. The room
 * leader has already been nudged in the app before either card appears.
 *
 * CONTENT: room names, counts and dates. No child, parent or staff name — a
 * card says "Baby Room last met on 8 October", never who did or did not turn
 * up. Reading that means opening the meeting, where the access checks live.
 *
 * If the b530 migration has not been applied the collector answers "nothing to
 * report" rather than failing, so prod stays quiet until it is.
 */
const { getPool } = require('../../db/pool');
const RM = require('../../lib/room-meetings');

const SOURCE = 'room-meetings';

async function collect() {
  const db = getPool();
  const items = [];

  let stale = [], outstanding = [];
  try {
    stale = await RM.roomsWithoutAMeeting(db, { days: 14 });
    const { rows } = await db.query(`
      SELECT m.room_id, rm.name AS room_name, count(*)::int AS n,
             to_char(min(m.meeting_date), 'YYYY-MM-DD') AS oldest
        FROM cpd_room_meetings m JOIN rooms rm ON rm.id = m.room_id
       WHERE m.status = 'held'
       GROUP BY m.room_id, rm.name ORDER BY rm.name`);
    outstanding = rows;
  } catch (e) {
    if (e.code === '42P01' || e.code === '42703') return { ok: true, items: [], note: 'b530 migration not applied' };
    throw e;
  }

  if (stale.length) {
    const names = stale.map(r => r.room_name).join(' and ');
    items.push({
      source: SOURCE,
      source_key: 'rooms-not-meeting',
      title: stale.length === 1
        ? `${names} has not held a room meeting in two weeks`
        : `${stale.length} rooms have not held a room meeting in two weeks`,
      detail: stale.map(r => r.last_held
        ? `${r.room_name} last met on ${RM.niceDate(r.last_held)} (${r.days_since} days ago).`
        : `${r.room_name} has no record of a room meeting at all.`).join(' ')
        + ' The room leader organises these, so this is a conversation rather than a job: '
        + 'CPD → Deep Dive → Room meetings shows every room’s last eight weeks, and the room leader '
        + 'has already been nudged in the app.',
      why: 'A room that has stopped meeting is the first thing to go quiet, and nothing else on this board would show it.',
      rag: 'amber',
      category: 'staff',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 10,
      action_url: '/admin/cpd/deep-dive',
      evidence: { table: 'cpd_room_meetings', rooms: stale.map(r => r.room_id), days: 14 },
      sort_hint: 5,
    });
  }

  const total = outstanding.reduce((a, r) => a + r.n, 0);
  if (total) {
    items.push({
      source: SOURCE,
      source_key: 'minutes-outstanding',
      title: total === 1
        ? 'One room meeting has been held but not written up'
        : `${total} room meetings have been held but not written up`,
      detail: outstanding.map(r => `${r.room_name}: ${r.n}`).join(' · ')
        + `. The oldest is from ${RM.niceDate(outstanding.reduce((m, r) => (!m || r.oldest < m ? r.oldest : m), null))}. `
        + 'Minutes nobody wrote are a meeting that, as far as any record goes, did not happen — '
        + 'and the team cannot confirm they have read them. The room leader owns this and has been nudged.',
      why: 'Writing up the meeting is the part that survives the week, and it is the part that slips.',
      rag: total > 2 ? 'amber' : 'green',
      category: 'staff',
      due_date: null,
      blocked_on: 'toby',
      effort_minutes: 5 * total,
      action_url: '/admin/cpd/deep-dive',
      evidence: { table: 'cpd_room_meetings', status: 'held', count: total },
      sort_hint: 7,
    });
  }

  return { ok: true, items };
}

module.exports = { name: SOURCE, owns: [SOURCE], collect };
