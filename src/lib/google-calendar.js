'use strict';
const { google } = require('googleapis');
const path = require('path');

const SA_KEY_PATH = process.env.GOOGLE_SA_KEY;
const CALENDAR_NAME = 'Wren Nursery Events';

let _auth = null;
function getAuth() {
  if (_auth) return _auth;
  if (!SA_KEY_PATH) throw new Error('GOOGLE_SA_KEY is not set — Google Calendar integration is disabled');
  const key = require(SA_KEY_PATH);
  _auth = new google.auth.JWT({
    email: key.client_email,
    key:   key.private_key,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/calendar.events',
    ],
  });
  return _auth;
}

function gcal() {
  return google.calendar({ version: 'v3', auth: getAuth() });
}

// Get or create the dedicated Wren Nursery calendar, caching ID in ladn.settings
async function getCalendarId(db) {
  // Check settings
  const { rows } = await db.query(
    `SELECT value FROM ladn.settings WHERE key = 'gcal_calendar_id'`
  );
  if (rows.length && rows[0].value) return rows[0].value;

  const cal = gcal();

  // Check if Wren calendar already exists on the service account
  const list = await cal.calendarList.list();
  const existing = (list.data.items || []).find(c => c.summary === CALENDAR_NAME);
  let calId;
  if (existing) {
    calId = existing.id;
  } else {
    // Create it
    const created = await cal.calendars.insert({
      requestBody: {
        summary:  CALENDAR_NAME,
        timeZone: 'Europe/London',
        description: 'Your Nursery — events synced from Wren',
      },
    });
    calId = created.data.id;
    // Make it publicly readable (so Toby can subscribe)
    await cal.acl.insert({
      calendarId: calId,
      requestBody: { role: 'reader', scope: { type: 'default' } },
    });
  }

  // Store in settings
  await db.query(
    `INSERT INTO ladn.settings (key, value, updated_at)
     VALUES ('gcal_calendar_id', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [calId]
  );
  return calId;
}

async function testConnection(db) {
  try {
    const calId = await getCalendarId(db);
    const cal   = gcal();
    const meta  = await cal.calendars.get({ calendarId: calId });
    const saEmail = require(SA_KEY_PATH).client_email;
    return {
      ok: true,
      calendar_id: calId,
      calendar_name: meta.data.summary,
      service_account: saEmail,
      subscribe_url: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(calId)}`,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function listEvents(db, { from, to, maxResults = 50 } = {}) {
  const calId = await getCalendarId(db);
  const cal   = gcal();
  const params = {
    calendarId:   calId,
    maxResults,
    singleEvents: true,
    orderBy:      'startTime',
  };
  if (from) params.timeMin = new Date(from).toISOString();
  if (to)   params.timeMax = new Date(to).toISOString();
  const res = await cal.events.list(params);
  return res.data.items || [];
}

async function createEvent(db, { summary, description, start, end, location, wrenRef, wrenType, colorId }) {
  const calId = await getCalendarId(db);
  const cal   = gcal();

  // Normalise start/end: if date-only string, use date format; otherwise dateTime
  function normaliseTime(t) {
    if (!t) return { dateTime: new Date().toISOString(), timeZone: 'Europe/London' };
    if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return { date: t };
    return { dateTime: new Date(t).toISOString(), timeZone: 'Europe/London' };
  }

  const event = await cal.events.insert({
    calendarId: calId,
    requestBody: {
      summary,
      description: description || '',
      location:    location || '',
      start:  normaliseTime(start),
      end:    normaliseTime(end || start),
      colorId: colorId || null,
      extendedProperties: wrenRef ? { private: { wrenRef, wrenType: wrenType || '' } } : undefined,
    },
  });

  // Track in DB
  if (wrenRef && db) {
    await db.query(
      `INSERT INTO ladn.gcal_events (wren_ref, gcal_event_id, calendar_id, wren_type, synced_at, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())
       ON CONFLICT (wren_ref) DO UPDATE
         SET gcal_event_id = EXCLUDED.gcal_event_id,
             calendar_id   = EXCLUDED.calendar_id,
             updated_at    = now()`,
      [wrenRef, event.data.id, calId, wrenType || null]
    );
  }

  return event.data;
}

async function updateEvent(db, wrenRef, fields) {
  const { rows } = await db.query(
    `SELECT gcal_event_id, calendar_id FROM ladn.gcal_events WHERE wren_ref = $1`, [wrenRef]
  );
  if (!rows.length) return createEvent(db, { ...fields, wrenRef });

  const cal   = gcal();
  const existing = await cal.events.get({ calendarId: rows[0].calendar_id, eventId: rows[0].gcal_event_id });
  const patched = { ...existing.data, ...fields };
  const res = await cal.events.update({
    calendarId: rows[0].calendar_id,
    eventId:    rows[0].gcal_event_id,
    requestBody: patched,
  });
  await db.query(`UPDATE ladn.gcal_events SET updated_at = now() WHERE wren_ref = $1`, [wrenRef]);
  return res.data;
}

async function deleteEvent(db, wrenRefOrEventId) {
  let calId, eventId;

  const { rows } = await db.query(
    `SELECT gcal_event_id, calendar_id FROM ladn.gcal_events WHERE wren_ref = $1`, [wrenRefOrEventId]
  );
  if (rows.length) {
    calId   = rows[0].calendar_id;
    eventId = rows[0].gcal_event_id;
  } else {
    calId   = await getCalendarId(db);
    eventId = wrenRefOrEventId;
  }

  const cal = gcal();
  await cal.events.delete({ calendarId: calId, eventId });
  await db.query(`DELETE FROM ladn.gcal_events WHERE wren_ref = $1 OR gcal_event_id = $2`, [wrenRefOrEventId, eventId]);
  return { ok: true };
}

module.exports = { getCalendarId, testConnection, listEvents, createEvent, updateEvent, deleteEvent };
