'use strict';
// ════════════════════════════════════════════════════════════════════════════
// b322 — storing what the parser read, and keeping the calendar in step.
// 2026-09-11.
//
// The parser (ealing-cpd-parse.js) is pure and knows nothing about the
// database. This file is the other half: it takes parsed courses and makes them
// durable, idempotent and visible on the calendar.
//
// ── IDEMPOTENCY IS THE WHOLE CONTRACT ───────────────────────────────────────
// Ealing re-send. "Final reminder:" is literally a subject line in the queue,
// and the 2026-27 programme table will be re-issued when a date changes. So
// every write here is an upsert keyed on the course's identity:
//
//   course_code  →  'code:EY-0926-T004'      (Toby's stated rule)
//   Event id     →  'event:297380'           (when there is no code)
//   title+date   →  't:eyfstransition…|2026-07-01'
//
// Running the same email through twice must produce the same rows and change
// nothing else. There is a test for exactly that in scripts/b322-verify.js.
//
// ── WHY A RE-SEND UPDATES BUT DOES NOT OVERWRITE EVERYTHING ─────────────────
// A later email is newer information about the same course, so dates, venue and
// times are refreshed. But COALESCE order matters: a re-send that omits a field
// must not blank a field we already knew. The upsert therefore takes the NEW
// value only when it is non-null, and otherwise keeps what is stored.
// ════════════════════════════════════════════════════════════════════════════

const parser = require('./ealing-cpd-parse');

// Local-midnight yyyy-mm-dd. Deliberately NOT toISOString(): on a BST host that
// shifts the date backwards for anything before 01:00 and a course would appear
// to expire a day early.
function todayYmd(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// ── courses ─────────────────────────────────────────────────────────────────

/**
 * Insert or refresh one parsed course. Returns { courseId, isNew, sessionsNew }.
 *
 * @param {import('pg').PoolClient|import('pg').Pool} db
 * @param {object} c        a course object from parser.parseEmail()
 * @param {object} ctx      { emailId, messageId }
 */
async function upsertCourse(db, c, ctx) {
  const key = parser.dedupeKey(c);
  const needsReview = c.confidence === 'low';

  const { rows } = await db.query(
    `INSERT INTO ealing_cpd_courses
       (dedupe_key, course_code, event_ref, title, raw_title, provider, venue,
        delivery_mode, start_time, end_time, price_text, price_pence, is_free,
        price_note, parts_total, first_date, last_date, booking_deadline,
        booking_url, source_url, extraction, confidence, needs_review,
        source_email_id, source_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     ON CONFLICT (dedupe_key) DO UPDATE SET
       -- COALESCE(new, old): a re-send that omits a field must never blank it.
       course_code      = COALESCE(EXCLUDED.course_code,      ealing_cpd_courses.course_code),
       event_ref        = COALESCE(EXCLUDED.event_ref,        ealing_cpd_courses.event_ref),
       title            = EXCLUDED.title,
       raw_title        = COALESCE(EXCLUDED.raw_title,        ealing_cpd_courses.raw_title),
       venue            = COALESCE(EXCLUDED.venue,            ealing_cpd_courses.venue),
       delivery_mode    = COALESCE(EXCLUDED.delivery_mode,    ealing_cpd_courses.delivery_mode),
       start_time       = COALESCE(EXCLUDED.start_time,       ealing_cpd_courses.start_time),
       end_time         = COALESCE(EXCLUDED.end_time,         ealing_cpd_courses.end_time),
       price_text       = COALESCE(EXCLUDED.price_text,       ealing_cpd_courses.price_text),
       price_pence      = COALESCE(EXCLUDED.price_pence,      ealing_cpd_courses.price_pence),
       is_free          = COALESCE(EXCLUDED.is_free,          ealing_cpd_courses.is_free),
       price_note       = COALESCE(EXCLUDED.price_note,       ealing_cpd_courses.price_note),
       parts_total      = COALESCE(EXCLUDED.parts_total,      ealing_cpd_courses.parts_total),
       first_date       = COALESCE(EXCLUDED.first_date,       ealing_cpd_courses.first_date),
       last_date        = COALESCE(EXCLUDED.last_date,        ealing_cpd_courses.last_date),
       booking_deadline = COALESCE(EXCLUDED.booking_deadline, ealing_cpd_courses.booking_deadline),
       booking_url      = COALESCE(EXCLUDED.booking_url,      ealing_cpd_courses.booking_url),
       -- A course seen again is current again, even if it had been archived by
       -- a previous expiry sweep and Ealing have since re-run it.
       status           = 'active',
       last_seen_at     = now(),
       updated_at       = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      key, c.course_code, c.event_ref, c.title, c.raw_title, c.provider, c.venue,
      c.delivery_mode, c.start_time, c.end_time, c.price_text, c.price_pence, c.is_free,
      c.price_note || null, c.parts_total, c.first_date, c.last_date, c.booking_deadline,
      c.booking_url, c.source_url, c.extraction, c.confidence || null, needsReview,
      ctx && ctx.emailId ? ctx.emailId : null, ctx && ctx.messageId ? ctx.messageId : null,
    ]
  );

  const courseId = rows[0].id;
  const isNew = rows[0].inserted === true;
  const sessionsNew = await upsertSessions(db, courseId, c);
  return { courseId, isNew, sessionsNew };
}

/** One row per date. Idempotent on (course_id, session_date). */
async function upsertSessions(db, courseId, c) {
  let created = 0;
  const dates = Array.isArray(c.dates) ? c.dates.filter(Boolean) : [];
  for (let i = 0; i < dates.length; i++) {
    const { rows } = await db.query(
      `INSERT INTO ealing_cpd_sessions (course_id, session_date, start_time, end_time, part_number)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (course_id, session_date) DO UPDATE SET
         start_time  = COALESCE(EXCLUDED.start_time,  ealing_cpd_sessions.start_time),
         end_time    = COALESCE(EXCLUDED.end_time,    ealing_cpd_sessions.end_time),
         part_number = COALESCE(EXCLUDED.part_number, ealing_cpd_sessions.part_number)
       RETURNING id, (xmax = 0) AS inserted`,
      [courseId, dates[i], c.start_time, c.end_time, dates.length > 1 ? i + 1 : null]
    );
    if (rows[0].inserted) created++;
  }
  return created;
}

// ── the calendar ────────────────────────────────────────────────────────────

/**
 * Put each session on the nursery calendar as a TENTATIVE entry.
 *
 * Toby asked for the dates to land on the calendar automatically. They are
 * marked tentative on purpose and the wording is not decoration: Wren cannot
 * book on ealingcpd.org.uk, so a calendar entry here means "Ealing are running
 * this", never "we are going".
 *
 * audience = 'staff' — MUST stay that way. events rows with any other audience
 * are parent-visible (src/routes/events.js fans them out to every child's
 * parents), and the council's internal training programme is not parent news.
 *
 * Best-effort by contract: a calendar failure is logged and swallowed, because
 * losing the course itself over a calendar row would be a worse outcome.
 */
async function syncCalendar(db, courseId) {
  let created = 0;
  const { rows: course } = await db.query(
    `SELECT id, title, venue, delivery_mode, booking_url, course_code, status
       FROM ealing_cpd_courses WHERE id = $1`, [courseId]);
  if (!course.length) return 0;
  const c = course[0];

  const { rows: sessions } = await db.query(
    `SELECT id, session_date, start_time, end_time, part_number, calendar_event_id
       FROM ealing_cpd_sessions WHERE course_id = $1 ORDER BY session_date`, [courseId]);

  for (const s of sessions) {
    if (s.calendar_event_id) continue;               // already on the calendar
    const partLabel = s.part_number ? ` (part ${s.part_number})` : '';
    const title = `CPD · ${c.title}${partLabel}`.slice(0, 200);
    const desc = [
      'Tentative — from Ealing’s training email. Nobody is booked on this yet.',
      c.course_code ? `Course code: ${c.course_code}` : null,
      c.venue ? `Venue: ${c.venue}` : null,
      c.booking_url ? `Details: ${c.booking_url}` : null,
      'Staff can ask to attend from the CPD catalogue in Wren.',
    ].filter(Boolean).join('\n');

    try {
      const { rows: ev } = await db.query(
        `INSERT INTO events
           (title, description, event_date, start_time, end_time, location,
            audience, rsvp_required, capacity, is_published, created_by,
            source_table, source_id)
         VALUES ($1,$2,$3,$4,$5,$6,'staff',false,NULL,true,NULL,'ealing_cpd_sessions',$7)
         RETURNING id`,
        [title, desc, s.session_date, s.start_time, s.end_time, c.venue, s.id]
      );
      await db.query('UPDATE ealing_cpd_sessions SET calendar_event_id = $1 WHERE id = $2',
        [ev[0].id, s.id]);
      created++;
    } catch (e) {
      console.error(`[ealing-cpd] calendar entry failed for session ${s.id}:`, e.message);
    }
  }
  return created;
}

/**
 * Retitle a session's calendar entry once somebody is actually going, so the
 * calendar stops saying "tentative" about a day we now need cover for.
 */
async function markCalendarBooked(db, courseId, staffNames) {
  const { rows } = await db.query(
    `SELECT s.calendar_event_id, c.title
       FROM ealing_cpd_sessions s JOIN ealing_cpd_courses c ON c.id = s.course_id
      WHERE s.course_id = $1 AND s.calendar_event_id IS NOT NULL`, [courseId]);
  for (const r of rows) {
    const who = (staffNames || []).join(', ');
    await db.query(
      `UPDATE events
          SET description = $2, updated_at = now()
        WHERE id = $1`,
      [r.calendar_event_id,
       `Booked${who ? ` — ${who}` : ''}. Confirmed on Ealing CPD Online.`]
    ).catch(e => console.error('[ealing-cpd] calendar retitle failed:', e.message));
  }
}

// ── expiry ──────────────────────────────────────────────────────────────────

/**
 * Archive courses whose last date has passed.
 *
 * Archived, never deleted: a request that reached 'attended' still points at
 * its course, and a CPD record that cannot name the course it came from is
 * worth very little at inspection.
 *
 * Note the catalogue query ALSO filters on last_date, so a course drops out of
 * the staff-facing list the day after it runs whether or not this sweep has
 * fired. That belt-and-braces is deliberate — expiry should not depend on a job.
 */
async function expireCourses(db, today) {
  const t = today || todayYmd();
  const { rowCount } = await db.query(
    `UPDATE ealing_cpd_courses
        SET status = 'archived', updated_at = now()
      WHERE status = 'active'
        AND last_date IS NOT NULL
        AND last_date < $1::date`, [t]);
  return rowCount;
}

// ── the entry points ────────────────────────────────────────────────────────

/**
 * Parse one email and store what it yields. The poller hook calls this.
 *
 * Contract with the caller: NEVER throws. The Gmail poll loop must not fail
 * because a council email had an unexpected table in it.
 *
 * @param {object} db     pg pool
 * @param {object} msg    { messageId, fromEmail, subject, bodyHtml, bodyText }
 * @param {object} [opts] { emailId, force }
 */
async function ingestFromEmail(db, msg, opts) {
  const o = opts || {};
  const messageId = msg && (msg.messageId || msg.message_id) || null;

  try {
    // Cheapest possible exit for the ~99% of mail that is not Ealing's.
    if (!parser.isEalingCpdEmail(msg)) return { skipped: 'not_ealing' };

    // Already read it? Re-reading is harmless (every write is an upsert) but
    // pointless, so skip unless explicitly forced by a rescan.
    if (messageId && !o.force) {
      const { rows } = await db.query(
        'SELECT id FROM ealing_cpd_email_log WHERE message_id = $1', [messageId]);
      if (rows.length) return { skipped: 'already_parsed' };
    }

    const emailId = o.emailId || await lookupEmailId(db, messageId);
    const result = parser.parseEmail(msg);

    let coursesNew = 0, sessionsNew = 0, calendarNew = 0;
    for (const c of result.courses) {
      try {
        const up = await upsertCourse(db, c, { emailId, messageId });
        if (up.isNew) coursesNew++;
        sessionsNew += up.sessionsNew;
        calendarNew += await syncCalendar(db, up.courseId);
      } catch (e) {
        console.error('[ealing-cpd] course upsert failed:', e.message);
      }
    }

    await logEmail(db, {
      emailId, messageId,
      subject: msg.subject, fromEmail: msg.fromEmail || msg.from_email,
      ok: result.ok, reason: result.reason, extraction: result.extraction,
      coursesFound: result.courses.length, coursesNew, sessionsNew,
    });

    if (result.courses.length) await expireCourses(db);

    // Identifiers and counts only — build-logs is an unwalled sink, so no
    // subject lines and no addresses go to stdout.
    console.log(`[ealing-cpd] msg=${messageId || '?'} ${result.reason} found=${result.courses.length} new=${coursesNew} sessions=${sessionsNew} calendar=${calendarNew}`);
    return { ok: result.ok, reason: result.reason, found: result.courses.length, coursesNew, sessionsNew, calendarNew };
  } catch (e) {
    console.error('[ealing-cpd] ingest failed:', e.message);
    return { error: e.message };
  }
}

async function lookupEmailId(db, messageId) {
  if (!messageId) return null;
  try {
    const { rows } = await db.query(
      'SELECT id FROM comms_email_queue WHERE message_id = $1', [messageId]);
    return rows.length ? rows[0].id : null;
  } catch (_) { return null; }
}

async function logEmail(db, r) {
  try {
    await db.query(
      `INSERT INTO ealing_cpd_email_log
         (email_id, message_id, subject, from_email, ok, reason, extraction,
          courses_found, courses_new, sessions_new)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (message_id) WHERE message_id IS NOT NULL DO UPDATE SET
         parsed_at     = now(),
         ok            = EXCLUDED.ok,
         reason        = EXCLUDED.reason,
         extraction    = EXCLUDED.extraction,
         courses_found = EXCLUDED.courses_found,
         courses_new   = EXCLUDED.courses_new,
         sessions_new  = EXCLUDED.sessions_new`,
      [r.emailId, r.messageId, (r.subject || '').slice(0, 300), (r.fromEmail || '').slice(0, 200),
       !!r.ok, r.reason, r.extraction, r.coursesFound, r.coursesNew, r.sessionsNew]
    );
  } catch (e) { console.error('[ealing-cpd] email log failed:', e.message); }
}

/**
 * Re-read emails already sitting in comms_email_queue.
 *
 * This is what makes the module useful on day one rather than in three months:
 * the queue already holds Ealing's 2026-27 programme, so a rescan populates the
 * whole catalogue immediately instead of waiting for the next council mailshot.
 * It is also how a parser improvement gets applied to mail already seen.
 */
async function rescanQueue(db, opts) {
  const o = opts || {};
  const limit = Math.min(parseInt(o.limit, 10) || 200, 1000);
  const sinceDays = Math.min(parseInt(o.sinceDays, 10) || 400, 3650);

  const { rows } = await db.query(
    `SELECT id, message_id, from_email, subject, body_html, body_text
       FROM comms_email_queue
      WHERE received_at > now() - ($1 || ' days')::interval
        AND (body_html ILIKE '%ealingcpd%'
             OR split_part(lower(from_email),'@',2) = 'ealing.gov.uk'
             OR split_part(lower(from_email),'@',2) LIKE '%.ealing.gov.uk'
             OR split_part(lower(from_email),'@',2) LIKE '%ealingcpd.org.uk')
      ORDER BY received_at DESC
      LIMIT $2`, [String(sinceDays), limit]);

  const summary = { examined: rows.length, emailsWithCourses: 0, coursesNew: 0, sessionsNew: 0, calendarNew: 0 };
  for (const r of rows) {
    const res = await ingestFromEmail(db, {
      messageId: r.message_id, fromEmail: r.from_email, subject: r.subject,
      bodyHtml: r.body_html, bodyText: r.body_text,
    }, { emailId: r.id, force: !!o.force });
    if (res && res.found) {
      summary.emailsWithCourses++;
      summary.coursesNew += res.coursesNew || 0;
      summary.sessionsNew += res.sessionsNew || 0;
      summary.calendarNew += res.calendarNew || 0;
    }
  }
  await expireCourses(db);
  return summary;
}

module.exports = {
  ingestFromEmail, rescanQueue, upsertCourse, upsertSessions,
  syncCalendar, markCalendarBooked, expireCourses, todayYmd,
};
