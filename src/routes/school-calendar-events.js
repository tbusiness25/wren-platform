const express = require('express');
const router = express.Router();
const { Pool } = require('pg');
const crypto = require('crypto');

const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  user: process.env.PG_USER || 'wren',
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE || 'wren',
});

const schema = () => process.env.PG_SCHEMA || 'demo_primary';

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

// GET /api/calendar.ics?token=XXX
router.get('.ics', async (req, res) => {
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
      const dtstart = String(e.dtstart).slice(0,10).replace(/-/g,'');
      const dtend = e.dtend ? String(e.dtend).slice(0,10).replace(/-/g,'') : '';
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
});

// GET /api/calendar/token — generate ICS token per parent email
router.get('/token', async (req, res) => {
  const s = schema();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim() || 'demo@wren.test';
  try {
    const { rows } = await pool.query(`SELECT calendar_token FROM ${s}.parent_portal_access WHERE lower(email)=$1 AND is_active=true LIMIT 1`, [email]);
    if (rows.length && rows[0].calendar_token) return res.json({ token: rows[0].calendar_token });
    const token = crypto.randomBytes(32).toString('hex');
    await pool.query(`UPDATE ${s}.parent_portal_access SET calendar_token=$1 WHERE lower(email)=$2`, [token, email]);
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
