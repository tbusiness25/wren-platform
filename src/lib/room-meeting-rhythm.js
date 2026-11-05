'use strict';
/**
 * room-meeting-rhythm.js — b530 (2026-10-26). The automatic half.
 *
 * Toby: "it's their responsibility to make sure they are going ahead … and the
 * meeting minutes are written up." This is what makes that a rhythm instead of
 * a good intention:
 *
 *   1. Wren creates the next PLANNED meeting for each room from its own
 *      rhythm (ladn.cpd_room_meeting_schedule — day, time, every n weeks).
 *   2. The room leader is nudged THE DAY BEFORE.
 *   3. The room leader is nudged AGAIN if the minutes are not written within
 *      2 WORKING DAYS of the meeting.
 *   4. MANAGERS are told if a room has gone 2 WEEKS without a held meeting.
 *
 * ── IN-APP ONLY ────────────────────────────────────────────────────────────
 * The brief: in-app nudges only, no email, no Telegram. Three things make that
 * true rather than hoped for:
 *   - the three categories are in notification-categories.js's
 *     INAPP_ONLY_CATEGORIES, so "reset to role defaults" cannot give a manager
 *     Telegram for them;
 *   - they are named in the dispatcher's EMAIL_BLOCKED_CATEGORIES, so the email
 *     channel refuses them explicitly rather than by the fail-closed default;
 *   - the dispatcher now refuses the TELEGRAM channel for an in-app-only
 *     category outright, whatever an old preference row says.
 * Nothing here can reach a parent: every recipient is a staff id, and
 * recipientType is 'staff' or 'all-managers'.
 *
 * ── AT MOST ONCE ───────────────────────────────────────────────────────────
 * b346's finance-calendar pattern. Each nudge is CLAIMED first with an INSERT
 * … ON CONFLICT DO NOTHING on ladn.cpd_room_meeting_notices, and only whoever
 * wins the insert sends it. A crash between the claim and the send loses one
 * bell — which the page and the What-needs-me card both still show — and the
 * alternative is the same sentence every thirty seconds.
 *
 * It rides the EXISTING dispatcher poller (startDispatcher, 30s), like b184
 * event reminders, b209 task reminders and b346 finance deadlines: no new cron
 * job, no new timer. Throttled to once an hour in-process, and it only speaks
 * 07:00–18:00 London, because a nursery nobody is standing in does not need
 * telling about Wednesday.
 *
 * Nothing runs at all unless ladn.settings.room_meetings_enabled is 'true'.
 */

const RM = require('./room-meetings');

const CAT_TOMORROW = 'room_meeting_tomorrow';
const CAT_MINUTES  = 'room_meeting_minutes_due';
const CAT_OVERDUE  = 'room_meeting_room_overdue';
const LINK = '/room-meetings.html';
const EVERY_MS = 60 * 60 * 1000;

let _lastRun = 0;

const londonHour = (d = new Date()) =>
  parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', hour12: false }).format(d), 10) % 24;

/**
 * The next date on or after `from` that matches the room's rhythm.
 * every_n_weeks is counted from the room's LAST meeting (planned or held) so a
 * fortnightly room stays on its own fortnight instead of resetting whenever
 * this runs.
 */
function nextSlot(sched, from, lastDate) {
  let d = RM.toDate(from);
  for (let i = 0; i < 7; i++) {
    if (RM.isoDow(d) === sched.weekday) break;
    d = RM.addDays(d, 1);
  }
  if (sched.every_n_weeks > 1 && lastDate) {
    const last = RM.toDate(lastDate);
    // Walk forward in whole weeks until the gap is at least the room's cadence.
    while (Math.round((d - last) / 86400000) < sched.every_n_weeks * 7) d = RM.addDays(d, 7);
  }
  return d;
}

/**
 * Make sure each active room has a planned meeting in the diary.
 * Idempotent: createMeeting upserts on b262's UNIQUE (room_id, meeting_date).
 */
async function ensureNextPlanned(db, { today, actor } = {}) {
  const from = RM.toDate(today || new Date());
  const sched = await RM.getSchedule(db);
  const out = [];
  for (const s of sched) {
    if (!s.is_active) continue;
    const { rows: ahead } = await db.query(
      `SELECT count(*)::int AS n FROM cpd_room_meetings
        WHERE room_id = $1 AND meeting_date >= $2 AND status = 'planned'
          AND cancelled_at IS NULL`, [s.room_id, RM.ymd(from)]);
    if (ahead[0].n > 0) continue;                 // something is already in the diary

    const { rows: last } = await db.query(
      `SELECT max(meeting_date) AS d FROM cpd_room_meetings WHERE room_id = $1`, [s.room_id]);
    let when = nextSlot({ weekday: s.weekday, every_n_weeks: s.every_n_weeks }, from, last[0].d);
    // Never plan one for today after the fact — if the slot is today and the
    // room has not already got it, today is still fair game (the meeting is at
    // 13:00); only skip when today's slot already exists, which the count above
    // covers for 'planned'. A held one for today means move to the next slot.
    const { rows: heldToday } = await db.query(
      `SELECT count(*)::int AS n FROM cpd_room_meetings WHERE room_id = $1 AND meeting_date = $2`,
      [s.room_id, RM.ymd(when)]);
    if (heldToday[0].n > 0) when = nextSlot({ weekday: s.weekday, every_n_weeks: s.every_n_weeks }, RM.addDays(when, 1), RM.ymd(when));

    const leader = s.leader_id ? Number(s.leader_id) : null;
    const created = await RM.createMeeting(db, actor || { id: leader }, {
      room_id: s.room_id, meeting_date: RM.ymd(when), start_time: s.start_time,
      led_by: leader, auto: true,
    });
    if (created.created) out.push({ room_id: s.room_id, room_name: s.room_name, meeting_id: created.id, date: RM.ymd(when) });
  }
  return out;
}

/** Claim a nudge. Returns true if THIS caller may send it. */
async function claim(db, kind, key, { meetingId = null, roomId = null } = {}) {
  const { rowCount } = await db.query(
    `INSERT INTO cpd_room_meeting_notices (kind, meeting_id, room_id, claim_key)
     VALUES ($1,$2,$3,$4) ON CONFLICT (claim_key) DO NOTHING`,
    [kind, meetingId, roomId, key]);
  return rowCount === 1;
}

/**
 * @param {object}   db        pg pool
 * @param {Function} dispatch  the dispatcher's async dispatch (category, recipientType, recipientId, title, body, opts)
 * @param {{force?:boolean, today?:string, now?:Date, skipEnsure?:boolean}} opts
 *        force skips the hourly throttle AND the working-hours window — which is
 *        how the tests fake the clock: pass force:true with today:'2026-11-04'.
 */
async function sweepRoomMeetings(db, dispatch, opts = {}) {
  const now = opts.now || new Date();
  if (!opts.force) {
    if (now - _lastRun < EVERY_MS) return { skipped: 'throttled' };
    const h = londonHour(now);
    if (h < 7 || h >= 18) { _lastRun = now.getTime(); return { skipped: 'out of hours' }; }
  }
  if (!opts.force) _lastRun = now.getTime();

  if (!await RM.isEnabled(db)) return { skipped: 'room_meetings_enabled is not true' };

  const today = RM.ymd(RM.toDate(opts.today || now));
  const result = { created: [], tomorrow: 0, minutes_due: 0, room_overdue: 0 };

  // 1. keep the diary full
  if (!opts.skipEnsure) {
    try { result.created = await ensureNextPlanned(db, { today }); }
    catch (e) { console.error('[room-meetings] ensureNextPlanned:', e.message); }
  }

  const leaders = await RM.leadersByRoom(db);

  // 2. the room leader, the day before
  const tomorrow = RM.ymd(RM.addDays(today, 1));
  const { rows: soon } = await db.query(
    `SELECT m.id, m.room_id, m.meeting_date, m.start_time, m.led_by, rm.name AS room_name,
            (SELECT count(*)::int FROM cpd_room_meeting_agenda g WHERE g.meeting_id = m.id) AS agenda_count,
            (SELECT count(*)::int FROM cpd_room_meeting_attendees x WHERE x.meeting_id = m.id) AS expected
       FROM cpd_room_meetings m JOIN rooms rm ON rm.id = m.room_id
      WHERE m.status = 'planned' AND m.meeting_date = $1 AND m.cancelled_at IS NULL`, [tomorrow]);
  for (const m of soon) {
    const who = m.led_by || leaders.get(Number(m.room_id));
    if (!who) continue;
    if (!await claim(db, 'tomorrow', `tomorrow:${m.id}`, { meetingId: m.id, roomId: m.room_id })) continue;
    await dispatch(CAT_TOMORROW, 'staff', Number(who),
      `${m.room_name} meeting tomorrow${m.start_time ? ', ' + RM.hhmm(m.start_time) : ''}`,
      `You are leading ${m.room_name}'s meeting on ${RM.niceDate(m.meeting_date)}`
      + `${m.start_time ? ' at ' + RM.hhmm(m.start_time) : ''}. `
      + `${m.agenda_count ? `There ${m.agenda_count === 1 ? 'is 1 item' : `are ${m.agenda_count} items`} on the agenda` : 'The agenda is empty'}`
      + ` and ${m.expected} ${m.expected === 1 ? 'person is' : 'people are'} expected. `
      + 'Open Room meetings to add anything else and check who is in.',
      { relatedTable: 'cpd_room_meetings', relatedId: Number(m.id), link: LINK });
    result.tomorrow++;
  }

  // 3. the room leader again, if the minutes are not written in 2 working days
  const { rows: unwritten } = await db.query(
    `SELECT m.id, m.room_id, m.meeting_date, m.led_by, rm.name AS room_name
       FROM cpd_room_meetings m JOIN rooms rm ON rm.id = m.room_id
      WHERE m.status = 'held' AND m.meeting_date <= $1
      ORDER BY m.meeting_date`, [today]);
  for (const m of unwritten) {
    if (!RM.minutesOverdue({ status: 'held', meeting_date: m.meeting_date }, today)) continue;
    const who = m.led_by || leaders.get(Number(m.room_id));
    if (!who) continue;
    // One nudge per meeting per DAY: the minutes being late is a thing that
    // stays true, so it is worth saying again tomorrow — but only once a day.
    if (!await claim(db, 'minutes_due', `minutes:${m.id}:${today}`, { meetingId: m.id, roomId: m.room_id })) continue;
    await dispatch(CAT_MINUTES, 'staff', Number(who),
      `${m.room_name}'s minutes are still to write`,
      `${m.room_name}'s meeting on ${RM.niceDate(m.meeting_date)} has not been written up, and it is now more than two working days. `
      + 'Open Room meetings, fill in what was discussed and what the room decided, then mark the minutes written — '
      + 'the team cannot confirm they have read them until you do.',
      { relatedTable: 'cpd_room_meetings', relatedId: Number(m.id), link: LINK });
    result.minutes_due++;
  }

  // 4. managers, if a room has gone two weeks without a held meeting
  const stale = await RM.roomsWithoutAMeeting(db, { days: 14, today });
  for (const r of stale) {
    // Weekly at most, keyed on the Monday of the week, so a room that stays
    // silent for a term produces one card a week rather than ninety.
    const monday = RM.ymd(RM.addDays(today, -(RM.isoDow(today) - 1)));
    if (!await claim(db, 'room_overdue', `overdue:${r.room_id}:${monday}`, { roomId: r.room_id })) continue;
    await dispatch(CAT_OVERDUE, 'all-managers', null,
      `${r.room_name} has not held a meeting in ${r.days_since ? r.days_since + ' days' : 'the records'}`,
      `${r.room_name}`
      + (r.last_held
        ? ` last held a room meeting on ${RM.niceDate(r.last_held)}.`
        : ' has no record of a room meeting at all.')
      + ' Room meetings are the room leader’s to organise, so this is a conversation rather than a task: '
      + 'Roost → CPD → Deep Dive → Room meetings shows every room’s last eight weeks.',
      { relatedTable: 'rooms', relatedId: Number(r.room_id), link: '/admin/cpd/deep-dive' });
    result.room_overdue++;
  }

  return result;
}

module.exports = {
  sweepRoomMeetings, ensureNextPlanned, nextSlot,
  CAT_TOMORROW, CAT_MINUTES, CAT_OVERDUE,
};
