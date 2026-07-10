'use strict';
// calendar-feeds.js
// iCal subscription feeds for Wren: staff timetable, class, child, school-wide.
// Mount at /api/calendar in each edition server.js.
//
// Public endpoints (token-gated, no session required):
//   GET /api/calendar/staff/:token[.ics]   — staff timetable + school events
//   GET /api/calendar/school/:token[.ics]  — school-wide events (terms, INSET, trips …)
//   GET /api/calendar/child/:token[.ics]   — child/parent feed (school events + PE slots)
//   GET /api/calendar/class/:token[.ics]   — class timetable (secondary)
//   GET /api/calendar/pe-slot/:slotId[.ics]— single parents' evening slot download
//
// Authenticated endpoints:
//   GET  /api/calendar/tokens              — get/auto-create my staff + school tokens (JWT)
//   POST /api/calendar/tokens/regenerate   — invalidate + reissue a token (JWT) body: {scope}
//   POST /api/calendar/class-token         — get/create class token (JWT) body: {class_id}
//   GET  /api/calendar/child-token         — get/create child token (CF email auth, parents portal)

const express    = require('express');
const router     = express.Router();
const crypto     = require('crypto');
const authenticate = require('../middleware/auth');
const { getPool }  = require('../db/pool');
const { buildCalendar, buildParentsEveningIcs } = require('../lib/ical-builder');

// ── Helpers ────────────────────────────────────────────────────────────────────

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function icsHeaders(res, filename) {
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Cache-Control', 'max-age=900, public');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}

// Strip optional .ics suffix from token path segments
function stripIcs(raw) {
  return String(raw || '').replace(/\.ics$/, '');
}

// Convert a pg date value (Date object or "YYYY-MM-DD" string) to "YYYY-MM-DD"
function toDateStr(val) {
  if (!val) return null;
  // pg returns `date` columns as Date objects (midnight UTC) — use UTC methods
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  const s = String(val);
  // Already ISO "YYYY-MM-DD..." — take first 10 chars
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Fallback: try to parse as a date
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s.slice(0, 10);
}

// Combine "YYYY-MM-DD" + "HH:MM" → "YYYY-MM-DDTHH:MM:00"
function toDatetime(dateStr, timeStr) {
  const d = toDateStr(dateStr);
  const t = String(timeStr || '00:00').slice(0, 5);
  return `${d}T${t}:00`;
}

// ── Nursery family events + child milestones (LADN/EYFS editions, 2026-07-09) ──
// The school tables (terms/school_trips) don't exist on nursery schemas, so the
// child feed was near-empty there. This adds: published nursery events (all-
// audience or the child's room), funding-term dates, the child's birthday, the
// two-year progress check window, and 6-monthly key-person catch-ups derived
// from the child's start date. Every query is individually guarded — a missing
// table just skips that source.
async function fetchNurseryFamilyEvents(db, childId) {
  const events = [];
  let child = null;
  try {
    const { rows } = await db.query(
      `SELECT first_name, date_of_birth, start_date, room_id FROM children WHERE id=$1`, [childId]);
    child = rows[0] || null;
  } catch (_) {}

  // Published nursery events (stay-and-play, sports day…) — all or child's room
  try {
    const { rows } = await db.query(
      `SELECT id, title, description, event_date, start_time, end_time, location
       FROM events
       WHERE is_published = true
         AND event_date >= CURRENT_DATE - interval '7 days'
         AND (audience IS NULL OR audience = 'all' OR audience = $1)
       ORDER BY event_date LIMIT 100`,
      [String(child?.room_id ?? '')]);
    for (const e of rows) {
      const d = toDateStr(e.event_date);
      events.push(e.start_time ? {
        uid: `nursery-event-${e.id}@wren`,
        summary: e.title,
        dtstart: toDatetime(d, e.start_time),
        dtend:   toDatetime(d, e.end_time || e.start_time),
        allDay:  false,
        description: e.description || '',
        location: e.location || '',
      } : {
        uid: `nursery-event-${e.id}@wren`,
        summary: e.title,
        dtstart: d, dtend: d, allDay: true,
        description: e.description || '',
        location: e.location || '',
      });
    }
  } catch (_) {}

  // Funding terms as term dates (the nursery's equivalent of the school terms table)
  try {
    const { rows } = await db.query(
      `SELECT id, name, start_date, end_date FROM funding_terms
       WHERE end_date >= CURRENT_DATE - interval '30 days' ORDER BY start_date LIMIT 8`);
    for (const t of rows) {
      events.push({ uid: `funding-term-${t.id}@wren`, summary: `${t.name} (funding term)`,
        dtstart: toDateStr(t.start_date), dtend: toDateStr(t.end_date), allDay: true });
    }
  } catch (_) {}

  if (child && child.date_of_birth) {
    const dob = new Date(toDateStr(child.date_of_birth) + 'T00:00:00Z');
    const now = new Date();
    // Birthday — this year and next
    for (const y of [now.getUTCFullYear(), now.getUTCFullYear() + 1]) {
      const bd = new Date(Date.UTC(y, dob.getUTCMonth(), dob.getUTCDate()));
      if (bd >= new Date(now.getTime() - 86400000)) {
        events.push({ uid: `birthday-${childId}-${y}@wren`,
          summary: `🎂 ${child.first_name}'s birthday (${y - dob.getUTCFullYear()})`,
          dtstart: bd.toISOString().slice(0, 10), dtend: bd.toISOString().slice(0, 10), allDay: true });
      }
    }
    // Two-year progress check — window opens at the 2nd birthday (EYFS: done 24–36mo)
    const two = new Date(Date.UTC(dob.getUTCFullYear() + 2, dob.getUTCMonth(), dob.getUTCDate()));
    const ageMonths = (now - dob) / (30.44 * 86400000);
    if (ageMonths < 30) {
      events.push({ uid: `two-year-check-${childId}@wren`,
        summary: `📋 ${child.first_name} — Two-Year Progress Check window opens`,
        dtstart: two.toISOString().slice(0, 10), dtend: two.toISOString().slice(0, 10), allDay: true,
        description: 'The EYFS progress check at age two is completed between 24 and 36 months. The key person will share it with you.' });
    }
    // Key-person catch-ups — every 6 months from the child's start date, next two
    if (child.start_date) {
      const start = new Date(toDateStr(child.start_date) + 'T00:00:00Z');
      let added = 0;
      for (let i = 1; i <= 12 && added < 2; i++) {
        const c = new Date(start); c.setUTCMonth(c.getUTCMonth() + 6 * i);
        if (c > now) {
          events.push({ uid: `catchup-${childId}-${i}@wren`,
            summary: `💬 ${child.first_name} — 6-month key-person catch-up due`,
            dtstart: c.toISOString().slice(0, 10), dtend: c.toISOString().slice(0, 10), allDay: true,
            description: 'Six-monthly catch-up with your child\'s key person — the nursery will arrange a time.' });
          added++;
        }
      }
    }
  }
  return events;
}

// ── School-wide events (terms, trips, parents' evenings, announcements) ───────

async function fetchSchoolEvents(db) {
  const events = [];

  try {
    const { rows } = await db.query(
      `SELECT * FROM terms ORDER BY start_date LIMIT 20`
    );
    for (const t of rows) {
      events.push({
        uid: `term-${t.id}@wren`,
        summary: t.name,
        dtstart: toDateStr(t.start_date),
        dtend:   toDateStr(t.end_date),
        allDay: true,
      });
      if (t.half_term_start) {
        events.push({
          uid: `ht-${t.id}@wren`,
          summary: 'Half Term',
          dtstart: toDateStr(t.half_term_start),
          dtend:   toDateStr(t.half_term_end),
          allDay: true,
        });
      }
    }
  } catch (_) {}

  try {
    const { rows } = await db.query(
      `SELECT * FROM school_trips
       WHERE trip_date >= now() - interval '14 days'
       ORDER BY trip_date LIMIT 100`
    );
    for (const t of rows) {
      events.push({
        uid: `trip-${t.id}@wren`,
        summary: `Trip: ${t.name}`,
        dtstart: toDateStr(t.trip_date),
        allDay: true,
        description: t.destination ? `Destination: ${t.destination}` : undefined,
      });
    }
  } catch (_) {}

  try {
    const { rows } = await db.query(
      `SELECT DISTINCT slot_date FROM parents_evening_slots
       WHERE slot_date >= now() - interval '7 days'
       ORDER BY slot_date LIMIT 20`
    );
    for (const p of rows) {
      const d = toDateStr(p.slot_date);
      events.push({
        uid: `pe-${d}@wren`,
        summary: "Parents' Evening",
        dtstart: d,
        allDay: true,
      });
    }
  } catch (_) {}

  try {
    const { rows } = await db.query(
      `SELECT * FROM school_announcements
       WHERE valid_from IS NOT NULL
         AND valid_from >= now() - interval '30 days'
       ORDER BY valid_from LIMIT 100`
    );
    for (const a of rows) {
      events.push({
        uid: `ann-${a.id}@wren`,
        summary: a.title,
        dtstart: toDateStr(a.valid_from),
        dtend:   a.valid_until ? toDateStr(a.valid_until) : undefined,
        allDay: true,
        description: (a.body || '').slice(0, 400),
      });
    }
  } catch (_) {}

  return events;
}

// ── Secondary timetable expansion for a staff member ─────────────────────────
// Generates individual VEVENT instances for the next 12 weeks.

async function fetchStaffTimetableSecondary(db, staffId) {
  const events = [];
  try {
    // Get term date ranges to constrain expansion
    const { rows: terms } = await db.query(
      `SELECT * FROM terms
       WHERE end_date >= now() - interval '7 days'
       ORDER BY start_date LIMIT 4`
    );
    if (!terms.length) return events;

    // Activities for this teacher with period times
    const { rows: acts } = await db.query(
      `SELECT ta.id, ta.week_pattern, ta.day_of_week,
              COALESCE(ta.subject_name, 'Lesson') AS subject_name,
              ta.room_code, ta.notes,
              tp.start_time, tp.end_time
       FROM timetable_activities ta
       JOIN timetable_periods tp ON tp.id = ta.period_id
       WHERE ta.teacher_id = $1
         AND tp.is_break = false AND tp.is_lunch = false
       ORDER BY ta.week_pattern, ta.day_of_week, tp.start_time`,
      [staffId]
    );
    if (!acts.length) return events;

    // Reference Monday for Week A: Monday of the week containing the earliest term start
    const { rows: earliest } = await db.query(`SELECT min(start_date) AS d FROM terms`);
    const refDate = new Date(earliest[0].d || terms[0].start_date);
    const refDow = refDate.getDay(); // 0=Sun
    refDate.setDate(refDate.getDate() - (refDow === 0 ? 6 : refDow - 1));

    // Build flat list of in-term date ranges (splitting half terms out)
    const termRanges = [];
    for (const t of terms) {
      if (t.half_term_start) {
        termRanges.push({ start: new Date(t.start_date),       end: new Date(t.half_term_start) });
        termRanges.push({ start: new Date(t.half_term_end),    end: new Date(t.end_date) });
      } else {
        termRanges.push({ start: new Date(t.start_date), end: new Date(t.end_date) });
      }
    }

    const today   = new Date(); today.setHours(0, 0, 0, 0);
    const horizon = new Date(today); horizon.setDate(today.getDate() + 84); // 12 weeks

    // Determine the week number of today relative to refDate
    const msPerWeek = 7 * 24 * 60 * 60 * 1000;
    const startWeekNum = Math.floor((today - refDate) / msPerWeek);

    for (const act of acts) {
      const dayOffset = act.day_of_week - 1; // Mon=0
      const timeStart = String(act.start_time).slice(0, 5);
      const timeEnd   = String(act.end_time).slice(0, 5);

      for (let wk = Math.max(0, startWeekNum - 1); wk < startWeekNum + 14; wk++) {
        const weekPattern = (wk % 2 === 0) ? 1 : 2;
        if (weekPattern !== act.week_pattern) continue;

        const weekMonday = new Date(refDate.getTime() + wk * msPerWeek);
        const eventDate  = new Date(weekMonday);
        eventDate.setDate(weekMonday.getDate() + dayOffset);
        eventDate.setHours(0, 0, 0, 0);

        if (eventDate < today || eventDate > horizon) continue;

        // Only generate if this date falls inside a term
        const inTerm = termRanges.some(r => eventDate >= r.start && eventDate <= r.end);
        if (!inTerm) continue;

        const d = `${eventDate.getFullYear()}-${String(eventDate.getMonth()+1).padStart(2,'0')}-${String(eventDate.getDate()).padStart(2,'0')}`;
        events.push({
          uid:         `ta-${act.id}-${d}@wren`,
          summary:     act.subject_name,
          dtstart:     toDatetime(d, timeStart),
          dtend:       toDatetime(d, timeEnd),
          allDay:      false,
          location:    act.room_code || '',
          description: act.notes || '',
        });
      }
    }

    // Add cover duties: lessons this teacher is covering for someone else
    try {
      const { rows: cover } = await db.query(
        `SELECT tc.id, tc.cover_date,
                COALESCE(ta.subject_name, 'Cover lesson') AS subject_name,
                tc.notes,
                tp.start_time, tp.end_time
         FROM timetable_cover tc
         JOIN timetable_activities ta ON ta.id = tc.activity_id
         JOIN timetable_periods tp    ON tp.id = ta.period_id
         WHERE tc.cover_teacher_id = $1
           AND tc.cover_date BETWEEN now() - interval '7 days' AND now() + interval '84 days'
         ORDER BY tc.cover_date`,
        [staffId]
      );
      for (const c of cover) {
        const d = toDateStr(c.cover_date);
        events.push({
          uid:         `cover-${c.id}@wren`,
          summary:     `Cover: ${c.subject_name}`,
          dtstart:     toDatetime(d, String(c.start_time).slice(0, 5)),
          dtend:       toDatetime(d, String(c.end_time).slice(0, 5)),
          allDay:      false,
          description: c.notes || '',
        });
      }
    } catch (_) {}

  } catch (e) {
    console.error('[calendar-feeds] secondary timetable:', e.message);
  }
  return events;
}

// ── Primary rota shifts for a staff member ────────────────────────────────────
// rota_shifts rows are already per-date, so no expansion needed.

async function fetchStaffRotaPrimary(db, staffId) {
  const events = [];
  try {
    const { rows } = await db.query(
      `SELECT rs.shift_date, ls.start_time, ls.end_time, ls.name AS slot_name,
              rs.slot_type, c.name AS class_name, rs.notes
       FROM rota_shifts rs
       JOIN lesson_slots ls ON ls.id = rs.lesson_slot_id
       LEFT JOIN classes c  ON c.id  = rs.class_id
       WHERE rs.staff_id = $1
         AND rs.shift_date BETWEEN now() - interval '1 day' AND now() + interval '84 days'
         AND rs.slot_type NOT IN ('ppa', 'free')
       ORDER BY rs.shift_date, ls.start_time`,
      [staffId]
    );
    for (const r of rows) {
      const d       = toDateStr(r.shift_date);
      const summary = r.class_name
        ? `${r.slot_name} — ${r.class_name}`
        : r.slot_name;
      events.push({
        uid:         `rota-${staffId}-${d}-${String(r.start_time).slice(0,5).replace(':','')}@wren`,
        summary,
        dtstart:     toDatetime(d, String(r.start_time).slice(0, 5)),
        dtend:       toDatetime(d, String(r.end_time).slice(0, 5)),
        allDay:      false,
        description: r.notes || '',
      });
    }
  } catch (e) {
    console.error('[calendar-feeds] primary rota:', e.message);
  }
  return events;
}

// ── Token management (JWT-authenticated) ──────────────────────────────────────

// GET /api/calendar/tokens — get (or auto-create) my staff + school tokens
router.get('/tokens', authenticate, async (req, res) => {
  const db     = getPool();
  const userId = req.user.id;
  try {
    const { rows } = await db.query(
      `SELECT token, scope FROM calendar_feed_tokens
       WHERE entity_type = 'staff' AND entity_id = $1`,
      [userId]
    );
    const existing = {};
    for (const r of rows) existing[r.scope] = r.token;

    // Auto-create missing tokens
    for (const scope of ['staff', 'school']) {
      if (!existing[scope]) {
        const t = newToken();
        await db.query(
          `INSERT INTO calendar_feed_tokens (token, scope, entity_type, entity_id)
           VALUES ($1, $2, 'staff', $3)
           ON CONFLICT (token) DO NOTHING`,
          [t, scope, userId]
        );
        existing[scope] = t;
      }
    }

    res.json(existing);
  } catch (e) {
    console.error('[calendar-feeds] tokens:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/calendar/tokens/regenerate — invalidate old token and issue a new one
// body: { scope: 'staff' | 'school' }
router.post('/tokens/regenerate', authenticate, async (req, res) => {
  const db     = getPool();
  const userId = req.user.id;
  const { scope } = req.body || {};
  if (!['staff', 'school'].includes(scope)) {
    return res.status(400).json({ error: 'scope must be staff or school' });
  }
  try {
    await db.query(
      `DELETE FROM calendar_feed_tokens
       WHERE entity_type = 'staff' AND entity_id = $1 AND scope = $2`,
      [userId, scope]
    );
    const t = newToken();
    await db.query(
      `INSERT INTO calendar_feed_tokens (token, scope, entity_type, entity_id, regenerated_at)
       VALUES ($1, $2, 'staff', $3, now())`,
      [t, scope, userId]
    );
    res.json({ token: t });
  } catch (e) {
    console.error('[calendar-feeds] regenerate:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/calendar/class-token — get or create a token for a class feed (secondary)
// body: { class_id: number }
router.post('/class-token', authenticate, async (req, res) => {
  const db = getPool();
  const { class_id } = req.body || {};
  if (!class_id) return res.status(400).json({ error: 'class_id required' });
  try {
    const { rows } = await db.query(
      `SELECT token FROM calendar_feed_tokens
       WHERE entity_type = 'class' AND entity_id = $1 AND scope = 'class'
       LIMIT 1`,
      [class_id]
    );
    if (rows.length) return res.json({ token: rows[0].token });

    const t = newToken();
    await db.query(
      `INSERT INTO calendar_feed_tokens (token, scope, entity_type, entity_id)
       VALUES ($1, 'class', 'class', $2)
       ON CONFLICT (token) DO NOTHING`,
      [t, class_id]
    );
    res.json({ token: t });
  } catch (e) {
    console.error('[calendar-feeds] class-token:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/calendar/child-token — parents portal: get or create token for child feed
// Auth: Cloudflare Access email header (no JWT on parents portal)
router.get('/child-token', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  // Parent JWT fallback (2026-07-09): the parents SPA authenticates with a JWT
  // carrying child_id — accept it so the export tile works without relying on
  // the CF header (and on dev, which has no Cloudflare in front).
  let jwtChildId = null;
  if (!email) {
    try {
      const jwt = require('jsonwebtoken');
      const header = req.headers['authorization'] || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if ((decoded.aud === 'parents' || decoded.role === 'parent') && decoded.child_id) jwtChildId = parseInt(decoded.child_id);
    } catch (_) { /* fall through to 401 */ }
  }
  if (!email && !jwtChildId) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    let childId = jwtChildId;
    if (!childId) {
      // Look up the child linked to this parent email
      const { rows: access } = await db.query(
        `SELECT child_id FROM parent_portal_access
         WHERE lower(email) = $1 AND is_active = true
         ORDER BY child_id LIMIT 1`,
        [email]
      );
      if (!access.length) return res.status(404).json({ error: 'No linked child found' });
      childId = access[0].child_id;
    }

    const { rows } = await db.query(
      `SELECT token FROM calendar_feed_tokens
       WHERE entity_type = 'child' AND entity_id = $1 AND scope = 'child'
       LIMIT 1`,
      [childId]
    );
    if (rows.length) return res.json({ token: rows[0].token, child_id: childId });

    const t = newToken();
    await db.query(
      `INSERT INTO calendar_feed_tokens (token, scope, entity_type, entity_id)
       VALUES ($1, 'child', 'child', $2)
       ON CONFLICT (token) DO NOTHING`,
      [t, childId]
    );
    res.json({ token: t, child_id: childId });
  } catch (e) {
    console.error('[calendar-feeds] child-token:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── iCal feed endpoints (public, token-gated) ────────────────────────────────

// GET /api/calendar/staff/:token[.ics]
router.get('/staff/:token', async (req, res) => {
  const token = stripIcs(req.params.token);
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT entity_id FROM calendar_feed_tokens
       WHERE token = $1 AND scope = 'staff' AND entity_type = 'staff'`,
      [token]
    );
    if (!rows.length) return res.status(404).type('text').send('Feed not found');
    const staffId = rows[0].entity_id;

    let staffName = 'Staff';
    try {
      const { rows: sr } = await db.query(
        `SELECT first_name, last_name FROM staff WHERE id = $1`, [staffId]
      );
      if (sr.length) staffName = `${sr[0].first_name} ${sr[0].last_name}`;
    } catch (_) {}

    // Try secondary timetable first; fall back to primary rota
    let timetableEvents = [];
    let usedSecondary = false;
    try {
      await db.query('SELECT 1 FROM timetable_activities LIMIT 0');
      timetableEvents = await fetchStaffTimetableSecondary(db, staffId);
      usedSecondary = true;
    } catch (_) {}

    if (!usedSecondary) {
      try {
        await db.query('SELECT 1 FROM rota_shifts LIMIT 0');
        timetableEvents = await fetchStaffRotaPrimary(db, staffId);
      } catch (_) {}
    }

    const schoolEvents = await fetchSchoolEvents(db);
    icsHeaders(res, 'my-timetable.ics');
    res.send(buildCalendar({
      name: `${staffName} — Timetable`,
      events: [...timetableEvents, ...schoolEvents],
    }));
  } catch (e) {
    console.error('[calendar-feeds] staff feed:', e.message);
    res.status(500).type('text').send('Calendar generation failed');
  }
});

// GET /api/calendar/school/:token[.ics]
router.get('/school/:token', async (req, res) => {
  const token = stripIcs(req.params.token);
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT id FROM calendar_feed_tokens WHERE token = $1 AND scope = 'school'`,
      [token]
    );
    if (!rows.length) return res.status(404).type('text').send('Feed not found');

    const events = await fetchSchoolEvents(db);
    icsHeaders(res, 'school-calendar.ics');
    res.send(buildCalendar({ name: 'School Calendar', events }));
  } catch (e) {
    console.error('[calendar-feeds] school feed:', e.message);
    res.status(500).type('text').send('Calendar generation failed');
  }
});

// GET /api/calendar/child/:token[.ics] — child/parent feed
router.get('/child/:token', async (req, res) => {
  const token = stripIcs(req.params.token);
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT entity_id FROM calendar_feed_tokens
       WHERE token = $1 AND scope = 'child' AND entity_type = 'child'`,
      [token]
    );
    if (!rows.length) return res.status(404).type('text').send('Feed not found');
    const childId = rows[0].entity_id;

    let childName = 'Child';
    try {
      const { rows: cr } = await db.query(
        `SELECT first_name FROM children WHERE id = $1`, [childId]
      );
      if (cr.length) childName = cr[0].first_name;
    } catch (_) {}

    const schoolEvents = await fetchSchoolEvents(db);
    const nurseryEvents = await fetchNurseryFamilyEvents(db, childId);

    // Include any booked parents' evening slots for this child
    const peEvents = [];
    try {
      const { rows: slots } = await db.query(
        `SELECT slot_date, slot_time, duration_minutes, notes
         FROM parents_evening_slots
         WHERE pupil_id = $1
           AND booked_by_parent_email IS NOT NULL
           AND slot_date >= now() - interval '7 days'
         ORDER BY slot_date, slot_time`,
        [childId]
      );
      for (const s of slots) {
        const d = toDateStr(s.slot_date);
        const t = String(s.slot_time).slice(0, 5);
        const dur = s.duration_minutes || 10;
        const [h, m] = t.split(':').map(Number);
        const endTotalMin = h * 60 + m + dur;
        const endTime = `${String(Math.floor(endTotalMin / 60) % 24).padStart(2, '0')}:${String(endTotalMin % 60).padStart(2, '0')}`;
        peEvents.push({
          uid:     `pe-slot-${childId}-${d}-${t.replace(':', '')}@wren`,
          summary: `Parents' Evening — ${childName}`,
          dtstart: toDatetime(d, t),
          dtend:   toDatetime(d, endTime),
          allDay:  false,
          description: s.notes || "Parents' Evening appointment",
        });
      }
    } catch (_) {}

    icsHeaders(res, `${childName.toLowerCase().replace(/\s+/g, '-')}-calendar.ics`);
    res.send(buildCalendar({
      name: `${childName}'s Calendar`,
      events: [...schoolEvents, ...nurseryEvents, ...peEvents],
    }));
  } catch (e) {
    console.error('[calendar-feeds] child feed:', e.message);
    res.status(500).type('text').send('Calendar generation failed');
  }
});

// GET /api/calendar/class/:token[.ics] — class timetable (secondary)
router.get('/class/:token', async (req, res) => {
  const token = stripIcs(req.params.token);
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT entity_id FROM calendar_feed_tokens
       WHERE token = $1 AND scope = 'class' AND entity_type = 'class'`,
      [token]
    );
    if (!rows.length) return res.status(404).type('text').send('Feed not found');
    const classId = rows[0].entity_id;

    let className = 'Class';
    try {
      const { rows: cr } = await db.query(`SELECT name FROM classes WHERE id = $1`, [classId]);
      if (cr.length) className = cr[0].name;
    } catch (_) {}

    const timetableEvents = [];
    try {
      const { rows: terms } = await db.query(
        `SELECT * FROM terms
         WHERE end_date >= now() - interval '7 days'
         ORDER BY start_date LIMIT 4`
      );

      if (terms.length) {
        const { rows: earliest } = await db.query(`SELECT min(start_date) AS d FROM terms`);
        const refDate = new Date(earliest[0].d || terms[0].start_date);
        const dow = refDate.getDay();
        refDate.setDate(refDate.getDate() - (dow === 0 ? 6 : dow - 1));

        const termRanges = [];
        for (const t of terms) {
          if (t.half_term_start) {
            termRanges.push({ start: new Date(t.start_date),    end: new Date(t.half_term_start) });
            termRanges.push({ start: new Date(t.half_term_end), end: new Date(t.end_date) });
          } else {
            termRanges.push({ start: new Date(t.start_date), end: new Date(t.end_date) });
          }
        }

        const { rows: acts } = await db.query(
          `SELECT ta.id, ta.week_pattern, ta.day_of_week,
                  COALESCE(ta.subject_name, 'Lesson') AS subject_name,
                  ta.teacher_name, ta.room_code,
                  tp.start_time, tp.end_time
           FROM timetable_activities ta
           JOIN timetable_periods tp ON tp.id = ta.period_id
           WHERE ta.class_id = $1
             AND tp.is_break = false AND tp.is_lunch = false
           ORDER BY ta.week_pattern, ta.day_of_week, tp.start_time`,
          [classId]
        );

        const msPerWeek = 7 * 24 * 60 * 60 * 1000;
        const today   = new Date(); today.setHours(0, 0, 0, 0);
        const horizon = new Date(today); horizon.setDate(today.getDate() + 84);
        const startWeekNum = Math.floor((today - refDate) / msPerWeek);

        for (const act of acts) {
          const dayOffset = act.day_of_week - 1;
          for (let wk = Math.max(0, startWeekNum - 1); wk < startWeekNum + 14; wk++) {
            const weekPattern = (wk % 2 === 0) ? 1 : 2;
            if (weekPattern !== act.week_pattern) continue;

            const weekMonday = new Date(refDate.getTime() + wk * msPerWeek);
            const eventDate  = new Date(weekMonday);
            eventDate.setDate(weekMonday.getDate() + dayOffset);
            eventDate.setHours(0, 0, 0, 0);

            if (eventDate < today || eventDate > horizon) continue;
            const inTerm = termRanges.some(r => eventDate >= r.start && eventDate <= r.end);
            if (!inTerm) continue;

            const d = `${eventDate.getFullYear()}-${String(eventDate.getMonth()+1).padStart(2,'0')}-${String(eventDate.getDate()).padStart(2,'0')}`;
            timetableEvents.push({
              uid:      `class-ta-${act.id}-${d}@wren`,
              summary:  act.subject_name,
              dtstart:  toDatetime(d, String(act.start_time).slice(0, 5)),
              dtend:    toDatetime(d, String(act.end_time).slice(0, 5)),
              allDay:   false,
              location: act.room_code || '',
              description: act.teacher_name ? `Teacher: ${act.teacher_name}` : '',
            });
          }
        }
      }
    } catch (e) {
      console.error('[calendar-feeds] class timetable:', e.message);
    }

    const schoolEvents = await fetchSchoolEvents(db);
    icsHeaders(res, `${className.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-timetable.ics`);
    res.send(buildCalendar({
      name:   `${className} Timetable`,
      events: [...timetableEvents, ...schoolEvents],
    }));
  } catch (e) {
    console.error('[calendar-feeds] class feed:', e.message);
    res.status(500).type('text').send('Calendar generation failed');
  }
});

// GET /api/calendar/pe-slot/:slotId[.ics] — download .ics for a single parents' evening slot
// Used for email attachments and direct download links on booking confirmation pages.
// Auth: token-less; the slotId itself is the gating mechanism (opaque numeric id is sufficient
// given it is always served over HTTPS with Cloudflare Access in front of the parents portal).
router.get('/pe-slot/:slotId', async (req, res) => {
  const slotId = parseInt(stripIcs(req.params.slotId));
  if (!slotId || isNaN(slotId)) return res.status(400).type('text').send('Bad request');
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT pes.slot_date, pes.slot_time, pes.duration_minutes, pes.notes,
              s.first_name || ' ' || s.last_name AS teacher_name,
              c.first_name AS child_name
       FROM parents_evening_slots pes
       LEFT JOIN staff s    ON s.id = pes.teacher_id
       LEFT JOIN children c ON c.id = pes.pupil_id
       WHERE pes.id = $1`,
      [slotId]
    );
    if (!rows.length) return res.status(404).type('text').send('Slot not found');
    const slot = rows[0];

    const ics = buildParentsEveningIcs({
      slotDate:        toDateStr(slot.slot_date),
      slotTime:        String(slot.slot_time).slice(0, 5),
      durationMinutes: slot.duration_minutes || 10,
      teacherName:     slot.teacher_name || '',
      childName:       slot.child_name || '',
      location:        '',
    });
    icsHeaders(res, `parents-evening-${toDateStr(slot.slot_date)}.ics`);
    res.send(ics);
  } catch (e) {
    console.error('[calendar-feeds] pe-slot:', e.message);
    res.status(500).type('text').send('Calendar generation failed');
  }
});

module.exports = router;
