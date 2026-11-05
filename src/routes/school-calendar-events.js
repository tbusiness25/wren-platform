const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
// b264: connection details come from src/db/connection.js. This file used to read
// process.env.PG_DATABASE, which NO container sets — every container sets PG_DB — so it
// silently connected to the literal default `wren` (production) whatever the process was
// configured with. resolveConnection() reads PG_DB first and keeps PG_DATABASE as a
// fallback, so behaviour is unchanged wherever PG_DB is already `wren`.
const { resolveConnection } = require('../db/connection');
const crypto = require('crypto');
const { requireParentIdentity, parentEmailOf } = require('../lib/parent-identity');

const pool = new Pool({ ...resolveConnection() });

const schema = () => process.env.PG_SCHEMA || 'demo_primary';
// node-postgres hands a DATE column back as a JS Date, so String(d).slice(0, 10) takes the
// head of Date.prototype.toString ("Thu Aug 20") instead of the calendar date. Format with
// LOCAL getters, not toISOString(): pg builds a DATE at local midnight, which under BST
// slides back a day in UTC. Same fix as toXeroDate() in src/services/xero-invoice-push.js.
function ymd(d) {
  if (!d) return '';
  if (!(d instanceof Date)) return String(d).slice(0, 10);
  if (isNaN(d)) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// GET /api/calendar — unified school events feed
router.get('/', async (req, res) => {
  const s = schema();
  try {
    const events = [];

    const { rows: terms } = await pool.query(`SELECT * FROM ${s}.terms ORDER BY start_date`);
    for (const t of terms) {
      events.push({ title: t.name, start: t.start_date, end: t.end_date, type: 'term', colour: '#4a9abf', allDay: true });
      if (t.half_term_start) events.push({ title: 'Half Term', start: t.half_term_start, end: t.half_term_end, type: 'half_term', colour: '#e07820', allDay: true });
    }

    const { rows: anns } = await pool.query(
      `SELECT id, title, body AS description, valid_from AS start, valid_until AS end FROM ${s}.school_announcements WHERE valid_from IS NOT NULL ORDER BY valid_from`
    );
    for (const a of anns) {
      events.push({ title: a.title, start: a.start, end: a.end, type: 'announcement', colour: '#8b5cf6', description: a.description });
    }

    const { rows: trips } = await pool.query(`SELECT * FROM ${s}.school_trips ORDER BY trip_date`);
    for (const t of trips) {
      events.push({ title: t.name, start: t.trip_date, end: t.trip_date, type: 'trip', colour: '#22c55e', description: `To ${t.destination||'—'}` });
    }

    const { rows: pe } = await pool.query(`SELECT DISTINCT slot_date FROM ${s}.parents_evening_slots ORDER BY slot_date`);
    for (const p of pe) {
      events.push({ title: "Parents' Evening", start: p.slot_date, end: p.slot_date, type: 'parents_evening', colour: '#f59e0b' });
    }

    const { rows: clubs } = await pool.query(`SELECT id, name, day_of_week, start_time, end_time FROM ${s}.school_clubs WHERE is_active=true ORDER BY name`);
    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    for (const c of clubs) {
      events.push({ title: c.name, type: 'club', colour: '#06b6d4', recurring: true,
        day_of_week: c.day_of_week, start_time: c.start_time, end_time: c.end_time,
        description: `Weekly club · ${DAY_NAMES[c.day_of_week]||''}` });
    }

    res.json(events);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/calendar/ics — iCal feed of school events.
// Declared as a named handler rather than an inline arrow so each edition can ALSO register it
// at the historical /api/calendar.ics (see router.icsHandler below). A router mounted at
// /api/calendar can never serve the dot form itself: app.use() only matches when the character
// after the mount path is "/" or end-of-string, so ".ics" has to be an app-level route.
// (The old declaration here was router.get('.ics', ...) — under Express 5 a router path must
// begin with "/", so it matched nothing and the feed 404'd.)
async function icsHandler(req, res) {
  const s = schema();
  try {
    const events = [];
    const { rows: terms } = await pool.query(`SELECT * FROM ${s}.terms ORDER BY start_date`);
    for (const t of terms) {
      events.push({ summary: t.name, dtstart: t.start_date, dtend: t.end_date, uid: `term-${t.id}@wren` });
      if (t.half_term_start) events.push({ summary: 'Half Term', dtstart: t.half_term_start, dtend: t.half_term_end, uid: `ht-${t.id}@wren` });
    }
    const { rows: trips } = await pool.query(`SELECT * FROM ${s}.school_trips ORDER BY trip_date`);
    for (const t of trips) events.push({ summary: `Trip: ${t.name}`, dtstart: t.trip_date, uid: `trip-${t.id}@wren`, description: `To ${t.destination||'—'}` });
    const { rows: pe } = await pool.query(`SELECT DISTINCT slot_date FROM ${s}.parents_evening_slots ORDER BY slot_date`);
    for (const p of pe) events.push({ summary: "Parents' Evening", dtstart: p.slot_date, uid: `pe-${p.slot_date}@wren` });
    const { rows: anns } = await pool.query(`SELECT * FROM ${s}.school_announcements WHERE valid_from IS NOT NULL`);
    for (const a of anns) events.push({ summary: a.title, dtstart: a.valid_from, uid: `ann-${a.id}@wren`, description: (a.body||'').slice(0,200) });

    const icsLines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Wren//School Calendar//EN',
      'X-WR-CALNAME:School Calendar','X-WR-CALDESC:Wren Primary School Events'];
    for (const e of events) {
      const dtstart = ymd(e.dtstart).replace(/-/g,'');
      const dtend = e.dtend ? ymd(e.dtend).replace(/-/g,'') : '';
      icsLines.push('BEGIN:VEVENT');
      icsLines.push(`DTSTART;VALUE=DATE:${dtstart}`);
      if (dtend && dtend !== dtstart) icsLines.push(`DTEND;VALUE=DATE:${dtend}`);
      icsLines.push(`SUMMARY:${(e.summary||'').replace(/[\r\n]/g,' ')}`);
      icsLines.push(`UID:${e.uid}`);
      if (e.description) icsLines.push(`DESCRIPTION:${(e.description||'').replace(/[\r\n]/g,' ').slice(0,255)}`);
      icsLines.push('END:VEVENT');
    }
    icsLines.push('END:VCALENDAR');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="school-calendar.ics"');
    res.send(icsLines.join('\r\n'));
  } catch (e) { res.status(500).send('Calendar generation failed'); }
}

router.get('/ics', icsHandler);

// GET /api/calendar/token — generate ICS token per parent email
//
// b264 SECURITY FIX. This route used to take the caller's identity straight from the
// plaintext `cf-access-authenticated-user-email` request header, with no authentication
// on the router at all and a fallback to 'demo@wren.test' when the header was absent.
// That meant an unauthenticated caller could:
//   · name any parent in the header and be handed that parent's calendar_token, which
//     is the bearer credential for their child's whole school calendar feed; and
//   · force a token to be MINTED AND STORED for a parent who had never had one, or
//     have an existing one read back — a silent account-level disclosure.
// Reproduced 2026-09-01 against wren-primary (:8193, synthetic demo data): a bare
// `curl -H 'cf-access-authenticated-user-email: <parent>' /api/calendar/token` returned
// a 200 with the token, and with no header at all it returned one for demo@wren.test.
//
// b239 moved 77 endpoints onto src/lib/parent-identity.js precisely so that a header
// alone can never be an identity — the plaintext header is only ever the CLAIM, which
// the signed Cf-Access-Jwt-Assertion (or a Wren parent JWT) then has to match. This
// route was mounted only in the school editions and was missed by that sweep.
router.get('/token', requireParentIdentity, async (req, res) => {
  const s = schema();
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const { rows } = await pool.query(`SELECT calendar_token FROM ${s}.parent_portal_access WHERE lower(email)=$1 AND is_active=true LIMIT 1`, [email]);
    if (rows.length && rows[0].calendar_token) return res.json({ token: rows[0].calendar_token });
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(`UPDATE ${s}.parent_portal_access SET calendar_token=$1 WHERE lower(email)=$2`, [token, email]);
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exposed so an edition can keep the advertised /api/calendar.ics working:
//   app.get('/api/calendar.ics', require('../../src/routes/school-calendar-events').icsHandler);
router.icsHandler = icsHandler;

module.exports = router;
