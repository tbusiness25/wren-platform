'use strict';
// ===========================================================================
// event-reminders.js — automatic in-app reminders for calendar events (b184)
//
// Every row in `events` that names assigned staff (events.staff_ids) earns two
// in-app reminders: one 24h before and one 1h before. Lead times are settings,
// not constants:
//     settings.event_reminder_lead_1   default 1440  (minutes)
//     settings.event_reminder_lead_2   default 60    (minutes)
//
// Two-phase on purpose:
//   1. SCHEDULE — a row in `event_reminders` per (event, staff, lead) with the
//      wall-clock moment it should fire. Scheduling is a backfill sweep over
//      future events, so ANY code path that inserts an event (this build's
//      book-viewing, POST /api/events, a future importer) gets reminders for
//      free — nothing has to remember to call us.
//   2. FIRE — when scheduled_for passes, notify() creates the notification.
//      The notification row is deliberately NOT created up front: the bell
//      (GET /api/notifications) orders by notifications.created_at with no
//      delivery join, so an early row would show a "reminder" the moment the
//      event was booked, which is the one thing a reminder must not do.
//
// Both phases run inside the EXISTING notification dispatcher poller
// (services/notification-dispatcher.js startDispatcher, 30s) — no new cron job
// and no new systemd timer.
//
// Schema-unqualified table names throughout: the pool sets search_path per
// edition, so this works on ladn, demo_*, htps and childrenscorner alike.
// ===========================================================================

const DEFAULT_LEAD_1 = 1440;   // 24h before, minutes
const DEFAULT_LEAD_2 = 60;     // 1h before, minutes
const DEFAULT_START  = '09:00';
const TZ             = 'Europe/London';

// Only sweep events starting within this horizon — keeps the backfill query
// cheap and stops a 2030 event from sitting in the table for years.
const HORIZON_DAYS = 120;

let _schemaChecked = false;

// Idempotent self-heal, mirroring the house pattern in server-unified.js
// (_initDeviceTable). Runs once per process; the authoritative DDL also lives
// in scripts/migrations/2026-08-18-b184-event-reminders.sql.
async function ensureSchema(db) {
  if (_schemaChecked) return true;
  try {
    await db.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS staff_ids integer[]`);
    await db.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS source_table text`);
    await db.query(`ALTER TABLE events ADD COLUMN IF NOT EXISTS source_id integer`);
    await db.query(`
      CREATE TABLE IF NOT EXISTS event_reminders (
        id              serial PRIMARY KEY,
        event_id        integer NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        staff_id        integer NOT NULL,
        lead_mins       integer NOT NULL,
        scheduled_for   timestamptz NOT NULL,
        status          text NOT NULL DEFAULT 'scheduled',
        notification_id integer,
        fired_at        timestamptz,
        created_at      timestamptz DEFAULT now()
      )`);
    await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS event_reminders_uq ON event_reminders (event_id, staff_id, lead_mins)`);
    await db.query(`CREATE INDEX IF NOT EXISTS event_reminders_due_idx ON event_reminders (status, scheduled_for)`);
    _schemaChecked = true;
    return true;
  } catch (e) {
    console.error('[event-reminders] schema init failed:', e.message);
    return false;
  }
}

// Lead times in minutes, from settings, newest value wins. Bad/blank values
// fall back to the documented defaults rather than scheduling nonsense.
async function getLeadMinutes(db) {
  const leads = [DEFAULT_LEAD_1, DEFAULT_LEAD_2];
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('event_reminder_lead_1','event_reminder_lead_2')`);
    for (const r of rows) {
      const n = parseInt(r.value, 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      if (r.key === 'event_reminder_lead_1') leads[0] = n;
      if (r.key === 'event_reminder_lead_2') leads[1] = n;
    }
  } catch (e) {
    console.error('[event-reminders] lead lookup failed, using defaults:', e.message);
  }
  // Dedupe: identical leads would collide on the (event, staff, lead) unique index.
  return [...new Set(leads)];
}

// events.start_time is free text ('09:30', '9:30am', ''). Normalise to HH:MM so
// the timestamp maths below can't be fed something Postgres will reject.
function normaliseTime(raw) {
  const m = String(raw || '').match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return DEFAULT_START;
  const h = Math.min(23, parseInt(m[1], 10));
  const min = Math.min(59, parseInt(m[2], 10));
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

// Schedule the reminders for ONE event. Returns the rows it created (empty when
// the event has no assigned staff, or every lead time is already in the past).
// ON CONFLICT DO NOTHING makes this safe to call repeatedly — the booking route
// calls it inline so the caller gets ids back immediately, and the sweep calls
// it again later for anything created elsewhere.
async function scheduleEventReminders(db, eventId) {
  if (!(await ensureSchema(db))) return [];
  const { rows: evs } = await db.query(
    `SELECT id, title, event_date, start_time, location, staff_ids FROM events WHERE id=$1`, [eventId]);
  const ev = evs[0];
  if (!ev) return [];
  const staffIds = (ev.staff_ids || []).filter(n => Number.isInteger(n));
  if (!staffIds.length) return [];

  const leads = await getLeadMinutes(db);
  const startTime = normaliseTime(ev.start_time);
  const created = [];

  for (const staffId of staffIds) {
    for (const lead of leads) {
      try {
        // Every parameter is cast explicitly: $3 feeds both an integer column and
        // an interval, and without ::int Postgres infers it as text from the
        // interval side and then rejects the insert.
        const { rows } = await db.query(`
          INSERT INTO event_reminders (event_id, staff_id, lead_mins, scheduled_for)
          SELECT $1::int, $2::int, $3::int, ts
          FROM (
            SELECT (($4::date + $5::time) AT TIME ZONE $6) - make_interval(mins => $3::int) AS ts
          ) s
          WHERE s.ts > NOW()
          ON CONFLICT (event_id, staff_id, lead_mins) DO NOTHING
          RETURNING id, event_id, staff_id, lead_mins, scheduled_for, status`,
          [ev.id, staffId, lead, ev.event_date, startTime, TZ]);
        if (rows[0]) created.push(rows[0]);
      } catch (e) {
        console.error(`[event-reminders] schedule failed (event ${ev.id}, staff ${staffId}, lead ${lead}):`, e.message);
      }
    }
  }
  return created;
}

// Backfill sweep: any future event with assigned staff that is missing reminder
// rows gets them. This is what makes "every row inserted into events produces
// reminders" true regardless of which route did the inserting.
async function scheduleMissingReminders(db) {
  if (!(await ensureSchema(db))) return 0;
  let evs = [];
  try {
    const { rows } = await db.query(`
      SELECT e.id
      FROM events e
      WHERE e.staff_ids IS NOT NULL
        AND array_length(e.staff_ids, 1) > 0
        AND e.event_date >= CURRENT_DATE
        AND e.event_date <= CURRENT_DATE + ($1 || ' days')::interval
        AND (
          SELECT COUNT(*) FROM event_reminders r WHERE r.event_id = e.id
        ) < (array_length(e.staff_ids, 1) * 2)
      ORDER BY e.event_date
      LIMIT 200`, [HORIZON_DAYS]);
    evs = rows;
  } catch (e) {
    console.error('[event-reminders] backfill query failed:', e.message);
    return 0;
  }
  let n = 0;
  for (const e of evs) n += (await scheduleEventReminders(db, e.id)).length;
  return n;
}

// Fire everything now due. notifyAsync is awaited (not fire-and-forget) so the
// notification id can be stamped onto the reminder row — that stamp is also the
// proof the reminder actually landed.
async function fireDueReminders(db, notifyAsync) {
  if (!(await ensureSchema(db))) return 0;
  let due = [];
  try {
    const { rows } = await db.query(`
      SELECT r.id, r.event_id, r.staff_id, r.lead_mins, r.scheduled_for,
             e.title, e.event_date, e.start_time, e.location
      FROM event_reminders r
      JOIN events e ON e.id = r.event_id
      WHERE r.status = 'scheduled' AND r.scheduled_for <= NOW()
      ORDER BY r.scheduled_for
      LIMIT 50`);
    due = rows;
  } catch (e) {
    console.error('[event-reminders] due query failed:', e.message);
    return 0;
  }

  let fired = 0;
  for (const r of due) {
    // Claim the row first so a second dispatcher process (prod runs one, but a
    // dev container shares the DB) can't fire the same reminder twice.
    let claimed = false;
    try {
      const { rowCount } = await db.query(
        `UPDATE event_reminders SET status='firing' WHERE id=$1 AND status='scheduled'`, [r.id]);
      claimed = rowCount > 0;
    } catch (e) { console.error('[event-reminders] claim failed:', e.message); }
    if (!claimed) continue;

    const whenLabel = r.lead_mins >= 1440
      ? `${Math.round(r.lead_mins / 1440)} day${Math.round(r.lead_mins / 1440) === 1 ? '' : 's'} from now`
      : `${r.lead_mins} minutes from now`;
    const dateLabel = new Date(r.event_date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
    const body = `${dateLabel} at ${normaliseTime(r.start_time)}`
      + (r.location ? ` · ${r.location}` : '')
      + ` — ${whenLabel}.`;

    let notifId = null;
    try {
      notifId = await notifyAsync('event_reminder', 'staff', r.staff_id,
        `⏰ ${r.title}`, body,
        { relatedTable: 'events', relatedId: r.event_id, link: '/admissions/index.html' });
    } catch (e) {
      console.error('[event-reminders] notify failed:', e.message);
    }

    try {
      await db.query(
        `UPDATE event_reminders SET status=$1, notification_id=$2, fired_at=NOW() WHERE id=$3`,
        [notifId ? 'sent' : 'skipped', notifId || null, r.id]);
    } catch (e) { console.error('[event-reminders] stamp failed:', e.message); }
    if (notifId) fired++;
  }
  return fired;
}

// One tick of both phases — the single entry point the dispatcher calls.
async function sweepEventReminders(db, notifyAsync) {
  const scheduled = await scheduleMissingReminders(db);
  const fired = await fireDueReminders(db, notifyAsync);
  return { scheduled, fired };
}

module.exports = {
  ensureSchema,
  getLeadMinutes,
  normaliseTime,
  scheduleEventReminders,
  scheduleMissingReminders,
  fireDueReminders,
  sweepEventReminders,
};
