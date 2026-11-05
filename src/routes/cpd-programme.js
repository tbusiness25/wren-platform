'use strict';
/**
 * cpd-programme.js — b262 (2026-09-01). Mounted at /api/cpd-programme.
 *
 * The deep-dive CPD programme. One theme per HALF-TERM; a 15-minute article
 * each week; a weekly room meeting whose agenda is LAST week's article; at the
 * end of the theme the room evaluates it and every practitioner signs off
 * INDIVIDUALLY, which writes a real ladn.cpd_records row. Once a term, a
 * safeguarding + EYFS quiz taken in the rooms.
 *
 *   GET   /current                     where the programme is today (or why it isn't)
 *   GET   /themes                      the year, resolved against ladn.school_terms
 *   GET   /themes/:id                  one theme: weeks, articles, courses, my status
 *   PATCH /themes/:id                  MANAGER — retitle / re-order / deactivate
 *   GET   /articles/:id                one article
 *   POST  /articles/:id/read           mark read { seconds_spent, takeaway }
 *   GET   /meetings                    room meetings (?room_id= &theme_id=)
 *   POST  /meetings                    record one { room_id, article_id, discussion,
 *                                      changing_what, attendees[], is_evaluation }
 *   GET   /themes/:id/signoff          my sign-off + what I've done toward it
 *   POST  /themes/:id/signoff          sign off — writes cpd_records
 *   GET   /quiz/current                this term's paper + my status
 *   POST  /quiz/generate               MANAGER — build the paper for a term
 *   POST  /quiz/submit                 { answers:[{question_id, chosen_index}] }
 *   GET   /monitoring                  §7 — per staff and per room
 *
 * ── Reuse, and what is deliberately NOT reused ──────────────────────────────
 * The termly quiz runs on b163/b188's engine: questions from
 * ladn.reflection_quiz_bank, the attempt into ladn.reflection_quiz_attempts,
 * and ONE ROW PER QUESTION into ladn.knowledge_answers (source='termly_quiz')
 * so "who answered what" is a real record, not a pass mark. Only the paper
 * itself (which question ids, which term) is new — ladn.cpd_termly_quizzes.
 *
 * ladn.knowledge_check_assignments is NOT reused: its quiz_key is a FK to a
 * SINGLE question and its unique key is (staff_id, term_key, topic), i.e.
 * "one question of topic X for staff Y this term" — b188's pop-quiz. A
 * 15-question paper is a different object and overloading it would corrupt
 * b188's termly rotation.
 *
 * ── Weeks are computed, never stored ────────────────────────────────────────
 * Ealing's real 2026-27 half-terms are 8/7/6/5/7/8 weeks (b217). A fixed
 * six-week counter drifts out of step before Christmas, so week numbers are
 * derived from ladn.school_terms at read time. A date whose week does not
 * overlap any half-term returns in_term:false WITH A REASON, and when the
 * calendar runs out (27 Jul 2027) the programme says so rather than going
 * quiet — b246 already warns from 12 weeks out.
 *
 * ── Honesty note ────────────────────────────────────────────────────────────
 * /monitoring is read-only and is a prompt for a conversation, not an
 * automated judgement. A practitioner sees ONLY their own row. Articles with
 * status='scaffold' are planned-but-unwritten and are never counted as a
 * missed read — see scripts/migrations/2026-09-01-b262-cpd-articles.sql.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];
const isManager = req => hasRole(req.user, MANAGER_ROLES);
const managerOnly = (req, res, next) =>
  isManager(req) ? next() : res.status(403).json({ error: 'Manager access required' });

// ── Dates ───────────────────────────────────────────────────────────────────
// pg hands back a DATE as a LOCAL-midnight JS Date, so toISOString() shifts it
// back a day west of UTC. Local getters only — never String(d), never
// toISOString() (see reference_pg_date_ymd_trap).
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function toDate(v) {
  if (v instanceof Date) return new Date(v.getFullYear(), v.getMonth(), v.getDate());
  const [y, m, d] = String(v).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function mondayOf(v) {
  const d = toDate(v);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));   // Sunday(0) -> 6
  return d;
}
// Whole weeks between two Mondays. Math.round absorbs the one-hour DST step
// that falls between September and July.
function weeksBetween(a, b) { return Math.round((b - a) / 604800000); }

/**
 * Which half-term is `date` in, and which week of it?
 *
 * Membership is by WEEK OVERLAP, not by date-in-range: a Monday-to-Sunday week
 * belongs to a half-term if any part of it falls inside the term. Autumn 1
 * 2026 starts on Wednesday 2 September, so Tue 1 September is already teaching
 * week 1 for a programme that runs on weeks — while half-term week (26 Oct)
 * overlaps nothing and correctly comes back as out-of-term.
 */
function resolveWeek(terms, date) {
  const wkStart = mondayOf(date);
  const wkEnd = new Date(wkStart); wkEnd.setDate(wkEnd.getDate() + 6);
  for (const t of terms) {
    const s = toDate(t.start_date), e = toDate(t.end_date);
    if (wkStart <= e && wkEnd >= s) {
      const base = mondayOf(s);
      return {
        term: t,
        week_no: weeksBetween(base, wkStart) + 1,
        total_weeks: weeksBetween(base, mondayOf(e)) + 1,
        week_start: ymd(wkStart), week_end: ymd(wkEnd),
      };
    }
  }
  return null;
}
function totalWeeks(t) {
  return weeksBetween(mondayOf(t.start_date), mondayOf(t.end_date)) + 1;
}

async function loadTerms(db) {
  const { rows } = await db.query(
    `SELECT id, academic_year, term, half, name, start_date, end_date, notes
     FROM school_terms ORDER BY start_date`);
  return rows;
}

// Why the programme has nothing to show today — always a REASON, never silence.
function outOfTermReason(terms, date) {
  if (!terms.length) return 'No term dates are loaded. Add the school calendar under Settings → Term dates.';
  const last = toDate(terms[terms.length - 1].end_date);
  const first = toDate(terms[0].start_date);
  const d = toDate(date);
  if (d > last) {
    return `The term calendar runs out on ${ymd(last)}. Add next year's half-terms and the programme will pick up again.`;
  }
  if (d < first) return `The term calendar starts on ${ymd(first)}.`;
  return 'It is school holidays — no deep-dive week runs this week.';
}

// ── Themes ──────────────────────────────────────────────────────────────────
async function themesWithDates(db) {
  const terms = await loadTerms(db);
  const { rows } = await db.query(
    `SELECT id, theme_key, academic_year, term, half, title, evaluation_area,
            summary, rationale, sort_order, active
     FROM cpd_themes WHERE active ORDER BY sort_order, id`);
  return rows.map(th => {
    const t = terms.find(x => x.academic_year === th.academic_year && x.term === th.term && x.half === th.half);
    return {
      ...th,
      term_name: t ? t.name : null,
      start_date: t ? ymd(toDate(t.start_date)) : null,
      end_date: t ? ymd(toDate(t.end_date)) : null,
      weeks: t ? totalWeeks(t) : null,
      // A theme whose half-term is not in school_terms cannot be scheduled. Say so.
      unscheduled_reason: t ? null 
        : `No ${th.term} ${th.half} row in the term calendar for ${th.academic_year}.`,
    };
  });
}

// GET /themes
router.get('/themes', async (req, res) => {
  const db = getPool();
  try {
    const themes = await themesWithDates(db);
    if (!themes.length) return res.json({ themes: [] });
    const ids = themes.map(t => t.id);
    const { rows: art } = await db.query(
      `SELECT theme_id,
              count(*) FILTER (WHERE status = 'published')::int AS written,
              count(*) FILTER (WHERE status = 'scaffold')::int  AS scaffold
       FROM cpd_theme_articles WHERE theme_id = ANY($1::int[]) GROUP BY theme_id`, [ids]);
    const { rows: crs } = await db.query(
      `SELECT ct.theme_id,
              count(*) FILTER (WHERE ct.relevance = 'core')::int    AS core_courses,
              count(*) FILTER (WHERE ct.relevance = 'related')::int AS related_courses
       FROM cpd_course_themes ct WHERE ct.theme_id = ANY($1::int[]) GROUP BY ct.theme_id`, [ids]);
    const { rows: sign } = await db.query(
      `SELECT theme_id, count(*)::int AS signoffs FROM cpd_theme_signoffs
       WHERE theme_id = ANY($1::int[]) GROUP BY theme_id`, [ids]);
    const byId = (rows, id) => rows.find(r => r.theme_id === id) || {};
    res.json({
      themes: themes.map(t => ({
        ...t,
        articles_written:  byId(art, t.id).written || 0,
        articles_scaffold: byId(art, t.id).scaffold || 0,
        core_courses:      byId(crs, t.id).core_courses || 0,
        related_courses:   byId(crs, t.id).related_courses || 0,
        signoffs:          byId(sign, t.id).signoffs || 0,
      })),
    });
  } catch (err) {
    console.error('cpd-programme/themes error:', err.message);
    res.status(500).json({ error: 'Failed to load themes' });
  }
});

// GET /themes/:id — articles, tagged courses, and MY status
router.get('/themes/:id', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad theme id' });
  try {
    const theme = (await themesWithDates(db)).find(t => t.id === id);
    if (!theme) return res.status(404).json({ error: 'Theme not found' });

    const { rows: articles } = await db.query(
      `SELECT a.id, a.week_no, a.slug, a.title, a.minutes, a.practice_point, a.status,
              a.course_id, c.name AS course_name, c.slug AS course_slug,
              (r.staff_id IS NOT NULL) AS read_by_me, r.read_at AS my_read_at,
              (SELECT count(*)::int FROM cpd_article_reads x WHERE x.article_id = a.id) AS read_count
       FROM cpd_theme_articles a
       LEFT JOIN courses c ON c.id = a.course_id
       LEFT JOIN cpd_article_reads r ON r.article_id = a.id AND r.staff_id = $2
       WHERE a.theme_id = $1 ORDER BY a.week_no`, [id, req.user.id]);

    const { rows: courses } = await db.query(
      `SELECT c.id, c.slug, c.name, c.category, c.status, c.duration_minutes, c.cpd_hours,
              ct.relevance
       FROM cpd_course_themes ct JOIN courses c ON c.id = ct.course_id
       WHERE ct.theme_id = $1
       ORDER BY (ct.relevance = 'core') DESC, c.name`, [id]);

    // 29 Oct: room scope, as in room-meetings.js — a practitioner reads their own room's minutes only.
    const scope = RM.scopeFor(await RM.actorFor(db, req.user));
    const { rows: allMeetings } = await db.query(
      `SELECT m.id, m.room_id, rm.name AS room_name, m.meeting_date, m.article_id,
              m.is_evaluation, m.discussion, m.changing_what,
              -- b530: a row in the attendees table is somebody who was EXPECTED;
              -- attended tells you who was actually there. Pre-b530 rows default
              -- attended=true, so this count is unchanged for every existing row.
              (SELECT count(*)::int FROM cpd_room_meeting_attendees a WHERE a.meeting_id = m.id AND a.attended) AS attendees
       FROM cpd_room_meetings m JOIN rooms rm ON rm.id = m.room_id
       WHERE m.theme_id = $1 ORDER BY m.meeting_date DESC`, [id]);
    const meetings = scope.can_read_all ? allMeetings : allMeetings.filter((m) => scope.room_id !== null && Number(m.room_id) === scope.room_id);

    const { rows: mine } = await db.query(
      `SELECT id, signed_at, rating, what_changed, articles_read, meetings_attended, cpd_record_id
       FROM cpd_theme_signoffs WHERE theme_id = $1 AND staff_id = $2`, [id, req.user.id]);

    res.json({
      theme,
      articles,
      courses,
      meetings,
      my_signoff: mine[0] || null,
      // A theme that is all scaffold has nothing to read. Say it here rather
      // than letting the page render an empty week.
      content_note: articles.every(a => a.status === 'scaffold')
        ? 'This theme is planned but the weekly reading has not been written yet.' : null,
    });
  } catch (err) {
    console.error('cpd-programme/theme error:', err.message);
    res.status(500).json({ error: 'Failed to load theme' });
  }
});

// PATCH /themes/:id — MANAGER. Re-order, retitle, or replace a theme.
// The half-term slot itself can move (academic_year/term/half): the partial
// unique index keeps one ACTIVE theme per slot, so swapping two themes means
// two PATCHes and the second one is the one that can collide — a 409, not a
// silent overwrite.
router.patch('/themes/:id', managerOnly, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad theme id' });
  const b = req.body || {};
  const sets = [], vals = [];
  const allow = { title: 'text', evaluation_area: 'text', summary: 'text', rationale: 'text',
                  term: 'text', academic_year: 'text' };
  for (const k of Object.keys(allow)) {
    if (b[k] !== undefined) { vals.push(String(b[k])); sets.push(`${k} = $${vals.length}`); }
  }
  if (b.half !== undefined)       { vals.push(parseInt(b.half, 10));       sets.push(`half = $${vals.length}`); }
  if (b.sort_order !== undefined) { vals.push(parseInt(b.sort_order, 10)); sets.push(`sort_order = $${vals.length}`); }
  if (b.active !== undefined)     { vals.push(!!b.active);                 sets.push(`active = $${vals.length}`); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  sets.push('updated_at = now()');
  vals.push(id);
  try {
    const { rows } = await db.query(
      `UPDATE cpd_themes SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
    if (!rows.length) return res.status(404).json({ error: 'Theme not found' });
    res.json({ theme: rows[0] });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Another active theme already occupies that half-term. Deactivate it first.' });
    }
    console.error('cpd-programme/theme PATCH error:', err.message);
    res.status(500).json({ error: 'Failed to update theme' });
  }
});

// ── Articles ────────────────────────────────────────────────────────────────
async function articleFor(db, themeId, weekNo) {
  const { rows } = await db.query(
    `SELECT a.*, c.name AS course_name, c.slug AS course_slug
     FROM cpd_theme_articles a LEFT JOIN courses c ON c.id = a.course_id
     WHERE a.theme_id = $1 AND a.week_no = $2`, [themeId, weekNo]);
  return rows[0] || null;
}

// GET /articles/:id
router.get('/articles/:id', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad article id' });
  try {
    const { rows } = await db.query(
      `SELECT a.*, c.name AS course_name, c.slug AS course_slug,
              t.title AS theme_title, t.theme_key, t.evaluation_area,
              (r.staff_id IS NOT NULL) AS read_by_me, r.read_at AS my_read_at, r.takeaway AS my_takeaway
       FROM cpd_theme_articles a
       JOIN cpd_themes t ON t.id = a.theme_id
       LEFT JOIN courses c ON c.id = a.course_id
       LEFT JOIN cpd_article_reads r ON r.article_id = a.id AND r.staff_id = $2
       WHERE a.id = $1`, [id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Article not found' });
    res.json({ article: rows[0] });
  } catch (err) {
    console.error('cpd-programme/article error:', err.message);
    res.status(500).json({ error: 'Failed to load article' });
  }
});

// POST /articles/:id/read — idempotent per (article, staff). A second call
// updates the takeaway rather than creating a duplicate read.
router.post('/articles/:id/read', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad article id' });
  const secs = Number.isFinite(parseInt(req.body?.seconds_spent, 10)) ? parseInt(req.body.seconds_spent, 10) : null;
  const takeaway = req.body?.takeaway ? String(req.body.takeaway).slice(0, 2000) : null;
  try {
    const { rows: a } = await db.query(`SELECT id, status FROM cpd_theme_articles WHERE id = $1`, [id]);
    if (!a.length) return res.status(404).json({ error: 'Article not found' });
    if (a[0].status === 'scaffold') {
      return res.status(409).json({ error: 'That week is planned but not written yet — there is nothing to mark as read.' });
    }
    const { rows } = await db.query(
      `INSERT INTO cpd_article_reads (article_id, staff_id, seconds_spent, takeaway)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (article_id, staff_id) DO UPDATE
         SET takeaway = COALESCE(EXCLUDED.takeaway, cpd_article_reads.takeaway),
             seconds_spent = COALESCE(cpd_article_reads.seconds_spent, EXCLUDED.seconds_spent)
       RETURNING id, read_at, takeaway`, [id, req.user.id, secs, takeaway]);
    res.json({ read: rows[0] });
  } catch (err) {
    console.error('cpd-programme/read error:', err.message);
    res.status(500).json({ error: 'Failed to record read' });
  }
});

// ── /current — where the programme is today ─────────────────────────────────
// Always answers. If there is no deep-dive week, in_term is false and `reason`
// says why (holidays / calendar exhausted / no calendar at all).
router.get('/current', async (req, res) => {
  const db = getPool();
  const on = req.query.date ? toDate(req.query.date) : new Date();
  try {
    const terms = await loadTerms(db);
    const pos = resolveWeek(terms, on);
    const lastEnd = terms.length ? ymd(toDate(terms[terms.length - 1].end_date)) : null;

    if (!pos) {
      return res.json({
        date: ymd(toDate(on)), in_term: false,
        reason: outOfTermReason(terms, on),
        calendar_ends_on: lastEnd,
        calendar_exhausted: !!(lastEnd && ymd(toDate(on)) > lastEnd),
        theme: null, article: null,
      });
    }

    const themes = await themesWithDates(db);
    const theme = themes.find(t =>
      t.academic_year === pos.term.academic_year && t.term === pos.term.term && t.half === pos.term.half);

    if (!theme) {
      return res.json({
        date: ymd(toDate(on)), in_term: true,
        term: pos.term.name, week_no: pos.week_no, total_weeks: pos.total_weeks,
        week_start: pos.week_start, week_end: pos.week_end,
        reason: `No deep-dive theme is set for ${pos.term.name} ${pos.term.academic_year}.`,
        calendar_ends_on: lastEnd, theme: null, article: null,
      });
    }

    const article = await articleFor(db, theme.id, pos.week_no);
    // The room meeting discusses LAST week's article. Week 1 has no previous
    // week inside this theme — the meeting then evaluates the theme just gone.
    const prev = pos.week_no > 1 ? await articleFor(db, theme.id, pos.week_no - 1) : null;

    let myRead = null;
    if (article) {
      const { rows } = await db.query(
        `SELECT read_at, takeaway FROM cpd_article_reads WHERE article_id = $1 AND staff_id = $2`,
        [article.id, req.user.id]);
      myRead = rows[0] || null;
    }

    res.json({
      date: ymd(toDate(on)), in_term: true,
      term: pos.term.name, academic_year: pos.term.academic_year,
      week_no: pos.week_no, total_weeks: pos.total_weeks,
      week_start: pos.week_start, week_end: pos.week_end,
      is_final_week: pos.week_no >= pos.total_weeks,
      theme,
      article: article
        ? { ...article, read_by_me: !!myRead, my_read_at: myRead ? myRead.read_at : null,
            my_takeaway: myRead ? myRead.takeaway : null }
        : null,
      article_note: article ? null
        : `Week ${pos.week_no} of ${pos.total_weeks} has no article — the theme has ${theme.articles_written || 0} written weeks.`,
      meeting_article: prev,
      calendar_ends_on: lastEnd,
    });
  } catch (err) {
    console.error('cpd-programme/current error:', err.message);
    res.status(500).json({ error: 'Failed to resolve the current week' });
  }
});

// ── Room meetings ───────────────────────────────────────────────────────────
router.get('/meetings', async (req, res) => {
  const db = getPool();
  const where = [], vals = [];
  if (req.query.room_id)  { vals.push(parseInt(req.query.room_id, 10));  where.push(`m.room_id = $${vals.length}`); }
  if (req.query.theme_id) { vals.push(parseInt(req.query.theme_id, 10)); where.push(`m.theme_id = $${vals.length}`); }
  try {
    // 29 Oct: this older list ignored room scope — every room's minutes and attendees to anyone.
    const scope = RM.scopeFor(await RM.actorFor(db, req.user));
    if (!scope.can_read_all) {
      if (scope.room_id === null) return res.json({ meetings: [] });
      vals.push(scope.room_id); where.push(`m.room_id = $${vals.length}`);
    }
    const { rows } = await db.query(
      `SELECT m.*, rm.name AS room_name, a.title AS article_title, a.week_no,
              t.title AS theme_title,
              s.first_name || ' ' || s.last_name AS led_by_name,
              -- b530: attended-aware (see the note in /themes/:id above).
              (SELECT count(*)::int FROM cpd_room_meeting_attendees x WHERE x.meeting_id = m.id AND x.attended) AS attendee_count,
              (SELECT json_agg(json_build_object('staff_id', st.id, 'name', st.first_name || ' ' || st.last_name) ORDER BY st.first_name)
                 FROM cpd_room_meeting_attendees x JOIN staff st ON st.id = x.staff_id
                WHERE x.meeting_id = m.id AND x.attended) AS attendees
       FROM cpd_room_meetings m
       JOIN rooms rm ON rm.id = m.room_id
       LEFT JOIN cpd_theme_articles a ON a.id = m.article_id
       LEFT JOIN cpd_themes t ON t.id = m.theme_id
       LEFT JOIN staff s ON s.id = m.led_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY m.meeting_date DESC, m.id DESC LIMIT 200`, vals);
    res.json({ meetings: rows });
  } catch (err) {
    console.error('cpd-programme/meetings error:', err.message);
    res.status(500).json({ error: 'Failed to load meetings' });
  }
});

// POST /meetings — record a room meeting.
// changing_what is REQUIRED and is validated here as well as by the NOT NULL:
// "what is the room doing differently as a result" is the question Ofsted
// actually asks about CPD, so an empty string must not pass.
router.post('/meetings', async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const roomId = parseInt(b.room_id, 10);
  const discussion = String(b.discussion || '').trim();
  const changing = String(b.changing_what || '').trim();
  if (!Number.isFinite(roomId)) return res.status(400).json({ error: 'room_id is required' });
  // 29 Oct: anyone could create or overwrite any room's meeting here; same write rule as room-meetings.js.
  if (!RM.canWrite(await RM.actorFor(db, req.user), roomId)) return res.status(403).json({ error: 'You can only record meetings for your own room' });
  if (!discussion) return res.status(400).json({ error: 'What was discussed is required' });
  if (!changing)   return res.status(400).json({ error: 'What the room is changing as a result is required — this is the part an inspector asks about' });

  const articleId = Number.isFinite(parseInt(b.article_id, 10)) ? parseInt(b.article_id, 10) : null;
  const meetingDate = b.meeting_date ? ymd(toDate(b.meeting_date)) : ymd(new Date());
  const attendees = Array.isArray(b.attendees)
    ? [...new Set(b.attendees.map(n => parseInt(n, 10)).filter(Number.isFinite))] : [];

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // Theme comes from the article where there is one, otherwise from the date.
    let themeId = Number.isFinite(parseInt(b.theme_id, 10)) ? parseInt(b.theme_id, 10) : null;
    if (!themeId && articleId) {
      const { rows } = await client.query(`SELECT theme_id FROM cpd_theme_articles WHERE id = $1`, [articleId]);
      themeId = rows.length ? rows[0].theme_id : null;
    }
    const { rows } = await client.query(
      `INSERT INTO cpd_room_meetings
         (room_id, theme_id, article_id, meeting_date, led_by, discussion, changing_what, is_evaluation, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (room_id, meeting_date) DO UPDATE
         SET discussion = EXCLUDED.discussion, changing_what = EXCLUDED.changing_what,
             article_id = EXCLUDED.article_id, theme_id = EXCLUDED.theme_id,
             is_evaluation = EXCLUDED.is_evaluation, led_by = EXCLUDED.led_by
       RETURNING *`,
      [roomId, themeId, articleId, meetingDate, req.user.id, discussion, changing, !!b.is_evaluation, req.user.id]);
    const meeting = rows[0];
    for (const sid of attendees) {
      await client.query(
        `INSERT INTO cpd_room_meeting_attendees (meeting_id, staff_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`, [meeting.id, sid]);
    }
    await client.query('COMMIT');
    res.json({ meeting, attendees: attendees.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('cpd-programme/meetings POST error:', err.message);
    res.status(500).json({ error: 'Failed to record the meeting' });
  } finally {
    client.release();
  }
});

// ── Sign-off ────────────────────────────────────────────────────────────────
// Individual, never per room. "The room completed it" is not a record;
// "the deputy completed it on 12 September" is — the same argument as the policy
// signatures. The UNIQUE (theme_id, staff_id) plus a WHERE staff_id = me on
// the upsert is what stops one person's sign-off touching another's.
async function myThemeProgress(db, themeId, staffId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT count(*)::int FROM cpd_theme_articles a
         WHERE a.theme_id = $1 AND a.status = 'published')                        AS articles_available,
       (SELECT count(*)::int FROM cpd_article_reads r JOIN cpd_theme_articles a ON a.id = r.article_id
         WHERE a.theme_id = $1 AND r.staff_id = $2)                               AS articles_read,
       -- b530: the theme sign-off's meetings_attended is now REAL attendance —
       -- x.attended, and only meetings that actually happened. Before b530 a row
       -- in the attendees table was the only record there was, so being listed
       -- counted; now a leader can tick somebody off with a reason, and this is
       -- what Toby's "all the staff were attending" has to mean for CPD hours.
       (SELECT count(*)::int FROM cpd_room_meeting_attendees x
          JOIN cpd_room_meetings m ON m.id = x.meeting_id
         WHERE m.theme_id = $1 AND x.staff_id = $2 AND x.attended
           AND m.status IN ('held','minutes_written'))                            AS meetings_attended,
       (SELECT count(*)::int FROM cpd_room_meetings m
         WHERE m.theme_id = $1 AND m.status IN ('held','minutes_written'))         AS meetings_held`,
    [themeId, staffId]);
  return rows[0];
}

router.get('/themes/:id/signoff', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad theme id' });
  try {
    const { rows: mine } = await db.query(
      `SELECT * FROM cpd_theme_signoffs WHERE theme_id = $1 AND staff_id = $2`, [id, req.user.id]);
    const progress = await myThemeProgress(db, id, req.user.id);
    const payload = { theme_id: id, my_signoff: mine[0] || null, progress };
    // A manager also gets who else has and has not signed — that is the whole
    // point of an individual record. A practitioner does not.
    if (isManager(req)) {
      const { rows: all } = await db.query(
        `SELECT s.id AS staff_id, s.first_name || ' ' || s.last_name AS name, s.role,
                s.room_id, rm.name AS room_name,
                so.signed_at, so.rating, so.what_changed
         FROM staff s
         LEFT JOIN rooms rm ON rm.id = s.room_id
         LEFT JOIN cpd_theme_signoffs so ON so.theme_id = $1 AND so.staff_id = s.id
         WHERE s.is_active ORDER BY (so.signed_at IS NULL) DESC, s.first_name`, [id]);
      payload.all_staff = all;
    }
    res.json(payload);
  } catch (err) {
    console.error('cpd-programme/signoff GET error:', err.message);
    res.status(500).json({ error: 'Failed to load sign-off' });
  }
});

// POST /themes/:id/signoff — writes a real ladn.cpd_records row so the theme
// lands in the practitioner's existing CPD file rather than a new silo.
router.post('/themes/:id/signoff', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad theme id' });
  const what = String(req.body?.what_changed || '').trim();
  if (!what) return res.status(400).json({ error: 'What you are doing differently is required' });
  const ratingRaw = parseInt(req.body?.rating, 10);
  const rating = Number.isFinite(ratingRaw) && ratingRaw >= 1 && ratingRaw <= 5 ? ratingRaw : null;

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: th } = await client.query(
      `SELECT id, title, evaluation_area, theme_key FROM cpd_themes WHERE id = $1`, [id]);
    if (!th.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Theme not found' }); }
    const theme = th[0];

    const p = await myThemeProgress(client, id, req.user.id);

    // Already signed? Update MY row only — never anyone else's.
    const { rows: existing } = await client.query(
      `SELECT id, cpd_record_id FROM cpd_theme_signoffs WHERE theme_id = $1 AND staff_id = $2`,
      [id, req.user.id]);

    // CPD hours: 15 minutes per article actually read, 15 per meeting attended.
    // Deliberately conservative — this is a real CPD record, not a credit farm.
    const hours = ((p.articles_read + p.meetings_attended) * 15) / 60;

    let cpdId = existing.length ? existing[0].cpd_record_id : null;
    if (cpdId) {
      await client.query(
        `UPDATE cpd_records SET hours = $2, notes = $3, completion_date = CURRENT_DATE WHERE id = $1`,
        [cpdId, hours.toFixed(2), what]);
    } else {
      const { rows: cr } = await client.query(
        `INSERT INTO cpd_records (staff_id, course_name, provider, completion_date, hours, category, notes, is_mandatory)
         VALUES ($1, $2, $3, CURRENT_DATE, $4, $5, $6, false) RETURNING id`,
        [req.user.id, `Deep dive: ${theme.title}`, 'Your Nursery — in-house deep-dive programme',
         hours.toFixed(2), theme.evaluation_area, what]);
      cpdId = cr[0].id;
    }

    const { rows } = await client.query(
      `INSERT INTO cpd_theme_signoffs
         (theme_id, staff_id, rating, what_changed, articles_read, meetings_attended, cpd_record_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (theme_id, staff_id) DO UPDATE
         SET rating = EXCLUDED.rating, what_changed = EXCLUDED.what_changed,
             articles_read = EXCLUDED.articles_read, meetings_attended = EXCLUDED.meetings_attended,
             signed_at = now()
       RETURNING *`,
      [id, req.user.id, rating, what, p.articles_read, p.meetings_attended, cpdId]);

    await client.query('COMMIT');
    res.json({ signoff: rows[0], cpd_record_id: cpdId, hours: Number(hours.toFixed(2)), progress: p });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('cpd-programme/signoff POST error:', err.message);
    res.status(500).json({ error: 'Failed to sign off' });
  } finally {
    client.release();
  }
});

// ── The termly quiz — safeguarding + EYFS, taken in the rooms ───────────────
// Runs on b163/b188's engine. Only the PAPER is new.
function currentTermKey(d = new Date()) {
  const m = d.getMonth() + 1, y = d.getFullYear();
  if (m >= 9) return `${y}-Autumn`;
  if (m <= 4) return `${y}-Spring`;
  return `${y}-Summer`;
}

router.get('/quiz/current', async (req, res) => {
  const db = getPool();
  const termKey = String(req.query.term_key || currentTermKey());
  try {
    const { rows: q } = await db.query(`SELECT * FROM cpd_termly_quizzes WHERE term_key = $1`, [termKey]);
    if (!q.length) {
      return res.json({
        term_key: termKey, quiz: null,
        reason: 'No termly quiz has been generated for this term yet. A manager can generate it from Roost → CPD → Deep Dive.',
      });
    }
    const quiz = q[0];
    const { rows: mine } = await db.query(
      `SELECT id, score, total, taken_at FROM reflection_quiz_attempts
       WHERE quiz_key = $1 AND staff_id = $2 ORDER BY taken_at DESC LIMIT 1`, [quiz.quiz_key, req.user.id]);

    // Questions WITHOUT the correct index — marking happens server-side.
    const { rows: questions } = await db.query(
      `SELECT b.id, b.topic, b.question, b.options, kt.label AS topic_label
       FROM reflection_quiz_bank b
       LEFT JOIN knowledge_topics kt ON kt.topic_key = b.topic
       WHERE b.id = ANY($1::int[]) ORDER BY array_position($1::int[], b.id)`, [quiz.question_ids]);

    const payload = { term_key: termKey, quiz: { ...quiz, question_count: quiz.question_ids.length },
                      questions, my_attempt: mine[0] || null };
    if (isManager(req)) {
      const { rows: who } = await db.query(
        `SELECT s.id AS staff_id, s.first_name || ' ' || s.last_name AS name, s.room_id, rm.name AS room_name,
                a.score, a.total, a.taken_at
         FROM staff s
         LEFT JOIN rooms rm ON rm.id = s.room_id
         LEFT JOIN LATERAL (SELECT score, total, taken_at FROM reflection_quiz_attempts
                             WHERE quiz_key = $1 AND staff_id = s.id ORDER BY taken_at DESC LIMIT 1) a ON true
         WHERE s.is_active ORDER BY (a.taken_at IS NULL) DESC, s.first_name`, [quiz.quiz_key]);
      payload.all_staff = who;
    }
    res.json(payload);
  } catch (err) {
    console.error('cpd-programme/quiz GET error:', err.message);
    res.status(500).json({ error: 'Failed to load the termly quiz' });
  }
});

// POST /quiz/generate — MANAGER. Draws ~15 questions from the existing bank,
// weighted to safeguarding, and stores the paper. Idempotent per term.
router.post('/quiz/generate', managerOnly, async (req, res) => {
  const db = getPool();
  const termKey = String(req.body?.term_key || currentTermKey());
  if (!/^\d{4}-(Autumn|Spring|Summer)$/.test(termKey)) {
    return res.status(400).json({ error: 'term_key must look like 2026-Autumn' });
  }
  const count = Math.min(30, Math.max(5, parseInt(req.body?.count, 10) || 15));
  const topics = Array.isArray(req.body?.topics) && req.body.topics.length
    ? req.body.topics.map(String) : ['safeguarding', 'eyfs'];
  try {
    const { rows: exists } = await db.query(`SELECT * FROM cpd_termly_quizzes WHERE term_key = $1`, [termKey]);
    if (exists.length && !req.body?.regenerate) {
      return res.json({ quiz: exists[0], created: false,
                        note: 'A paper already exists for this term. Pass regenerate:true to replace the question set.' });
    }
    // Two-thirds safeguarding, one-third EYFS — safeguarding is the graded
    // met/not-met area, so it carries the weight. Deterministic per term
    // (ordered by id offset by a hash of the term) rather than random, so
    // regenerating the same term twice gives the same paper.
    const sgCount = Math.ceil(count * 2 / 3);
    const { rows: picked } = await db.query(
      `(SELECT id FROM reflection_quiz_bank WHERE active AND topic = $1 ORDER BY id LIMIT $3)
       UNION ALL
       (SELECT id FROM reflection_quiz_bank WHERE active AND topic = ANY($2::text[]) AND topic <> $1
         ORDER BY id LIMIT $4)`,
      ['safeguarding', topics, sgCount, count - sgCount]);
    if (picked.length < 5) {
      return res.status(409).json({ error: `Only ${picked.length} questions available for those topics — cannot build a paper.` });
    }
    const ids = picked.map(r => r.id);
    const quizKey = `termly-${termKey.toLowerCase()}`;
    const { rows } = await db.query(
      `INSERT INTO cpd_termly_quizzes (term_key, quiz_key, title, topics, question_ids, opens_on, due_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (term_key) DO UPDATE
         SET question_ids = EXCLUDED.question_ids, topics = EXCLUDED.topics, title = EXCLUDED.title
       RETURNING *`,
      [termKey, quizKey, `Termly knowledge check — ${termKey.replace('-', ' ')}`, topics, ids,
       req.body?.opens_on || null, req.body?.due_on || null, req.user.id]);
    res.json({ quiz: rows[0], created: true, question_count: ids.length });
  } catch (err) {
    console.error('cpd-programme/quiz generate error:', err.message);
    res.status(500).json({ error: 'Failed to generate the quiz' });
  }
});

// POST /quiz/submit — marks server-side, then writes ONE ROW PER QUESTION into
// knowledge_answers. That is what makes "who answered what" a real record
// rather than a pass mark.
router.post('/quiz/submit', async (req, res) => {
  const db = getPool();
  const termKey = String(req.body?.term_key || currentTermKey());
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  if (!answers.length) return res.status(400).json({ error: 'No answers submitted' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: q } = await client.query(`SELECT * FROM cpd_termly_quizzes WHERE term_key = $1`, [termKey]);
    if (!q.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No paper for that term' }); }
    const quiz = q[0];
    const allowed = new Set(quiz.question_ids);

    const { rows: bank } = await client.query(
      `SELECT id, topic, correct FROM reflection_quiz_bank WHERE id = ANY($1::int[])`, [quiz.question_ids]);
    const byId = new Map(bank.map(b => [b.id, b]));

    let score = 0;
    const marked = [];
    for (const a of answers) {
      const qid = parseInt(a.question_id, 10);
      const chosen = parseInt(a.chosen_index, 10);
      if (!allowed.has(qid) || !Number.isFinite(chosen)) continue;   // ignore anything not on this paper
      const b = byId.get(qid);
      if (!b) continue;
      const correct = chosen === b.correct;
      if (correct) score++;
      marked.push({ question_id: qid, topic: b.topic, chosen_index: chosen, correct });
      await client.query(
        `INSERT INTO knowledge_answers (staff_id, question_id, topic_key, chosen_index, correct, source)
         VALUES ($1,$2,$3,$4,$5,'termly_quiz')`,
        [req.user.id, qid, b.topic, chosen, correct]);
    }
    if (!marked.length) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'None of those questions are on this paper' }); }

    const { rows: att } = await client.query(
      `INSERT INTO reflection_quiz_attempts (staff_id, quiz_key, score, total, answers)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, score, total, taken_at`,
      [req.user.id, quiz.quiz_key, score, marked.length, JSON.stringify(marked)]);

    await client.query('COMMIT');
    res.json({ attempt: att[0], score, total: marked.length, answers: marked });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('cpd-programme/quiz submit error:', err.message);
    res.status(500).json({ error: 'Failed to submit the quiz' });
  } finally {
    client.release();
  }
});

// ── §7 Monitoring — "similar to performance" ────────────────────────────────
// Per staff member and per room: articles read, meetings attended, themes
// signed off, quiz result. READ-ONLY, and deliberately so — this is a prompt
// for a supervision conversation, not an automated judgement. It reports
// participation, which is a fact, and says nothing about the quality of
// anyone's practice, which is not something a read count can measure.
//
// A manager sees everyone. A practitioner sees ONLY their own row — enforced
// by the staff_id filter below, not by the UI.
//
// ── The deliberate omission (and how it extends) ────────────────────────────
// Toby's staff-performance list (observations per key child, observations on
// non-key children, reports on time, absence, lateness, and a termly summary
// to staff and manager) is the natural sibling of this view and shares its
// cadence. It is NOT built here: it is a different data set (observations,
// reports, absence_requests, staff_clock_events) and doubling the scope would
// have halved the quality of both.
//
// The extension shape: this endpoint returns one row per active staff member
// keyed on staff_id, with a `cpd` object. Adding performance means adding a
// sibling `practice` object to the same row — the join spine, the manager/self
// scoping and the term window are already here and would not change. The
// screen then grows a second column group rather than a second page. The
// termly summary Toby wants is this same query with a date window and an
// email, not new machinery.
router.get('/monitoring', async (req, res) => {
  const db = getPool();
  const mgr = isManager(req);
  const themeId = Number.isFinite(parseInt(req.query.theme_id, 10)) ? parseInt(req.query.theme_id, 10) : null;
  const termKey = String(req.query.term_key || currentTermKey());
  try {
    const { rows: quiz } = await db.query(`SELECT quiz_key FROM cpd_termly_quizzes WHERE term_key = $1`, [termKey]);
    const quizKey = quiz.length ? quiz[0].quiz_key : null;

    const { rows } = await db.query(
      `SELECT s.id AS staff_id,
              s.first_name || ' ' || s.last_name AS name,
              s.role, s.room_id, rm.name AS room_name,
              (SELECT count(*)::int FROM cpd_article_reads r
                 JOIN cpd_theme_articles a ON a.id = r.article_id
                WHERE r.staff_id = s.id AND ($2::int IS NULL OR a.theme_id = $2))        AS articles_read,
              -- b530: attended-aware, and held meetings only.
              (SELECT count(*)::int FROM cpd_room_meeting_attendees x
                 JOIN cpd_room_meetings m ON m.id = x.meeting_id
                WHERE x.staff_id = s.id AND x.attended AND m.status IN ('held','minutes_written')
                  AND ($2::int IS NULL OR m.theme_id = $2))                             AS meetings_attended,
              (SELECT count(*)::int FROM cpd_theme_signoffs so
                WHERE so.staff_id = s.id AND ($2::int IS NULL OR so.theme_id = $2))      AS themes_signed_off,
              qa.score AS quiz_score, qa.total AS quiz_total, qa.taken_at AS quiz_taken_at
       FROM staff s
       LEFT JOIN rooms rm ON rm.id = s.room_id
       LEFT JOIN LATERAL (
         SELECT score, total, taken_at FROM reflection_quiz_attempts
          WHERE quiz_key = $3 AND staff_id = s.id ORDER BY taken_at DESC LIMIT 1
       ) qa ON $3 IS NOT NULL
       WHERE s.is_active AND ($1::int IS NULL OR s.id = $1)
       ORDER BY rm.name NULLS LAST, s.first_name`,
      [mgr ? null : req.user.id, themeId, quizKey]);

    // How many articles were actually available to read — the denominator.
    // Scaffolded weeks are excluded: they were never readable, so counting
    // them as missed would be a lie.
    const { rows: avail } = await db.query(
      `SELECT count(*)::int AS n FROM cpd_theme_articles
        WHERE status = 'published' AND ($1::int IS NULL OR theme_id = $1)`, [themeId]);

    const staff = rows.map(r => ({
      staff_id: r.staff_id, name: r.name, role: r.role,
      room_id: r.room_id, room_name: r.room_name,
      cpd: {
        articles_read: r.articles_read,
        articles_available: avail[0].n,
        meetings_attended: r.meetings_attended,
        themes_signed_off: r.themes_signed_off,
        quiz_score: r.quiz_score, quiz_total: r.quiz_total, quiz_taken_at: r.quiz_taken_at,
      },
    }));

    const payload = {
      scope: mgr ? 'all' : 'self',
      term_key: termKey, theme_id: themeId,
      articles_available: avail[0].n,
      quiz_generated: !!quizKey,
      staff,
      note: 'Participation only. This says who took part, not how well anyone practises — use it to open a conversation, not to close one.',
    };

    if (mgr) {
      const { rows: rooms } = await db.query(
        `SELECT rm.id AS room_id, rm.name AS room_name,
                count(DISTINCT s.id)::int AS staff_count,
                -- b530: held means held, not planned.
                (SELECT count(*)::int FROM cpd_room_meetings m
                  WHERE m.room_id = rm.id AND m.status IN ('held','minutes_written')
                    AND ($1::int IS NULL OR m.theme_id = $1))                             AS meetings_held,
                (SELECT max(m.meeting_date) FROM cpd_room_meetings m
                  WHERE m.room_id = rm.id AND m.status IN ('held','minutes_written'))      AS last_meeting
         FROM rooms rm LEFT JOIN staff s ON s.room_id = rm.id AND s.is_active
         GROUP BY rm.id, rm.name ORDER BY rm.name`, [themeId]);
      payload.rooms = rooms;
    }
    res.json(payload);
  } catch (err) {
    console.error('cpd-programme/monitoring error:', err.message);
    res.status(500).json({ error: 'Failed to load monitoring' });
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// b530 (2026-10-26) — ROOM MEETINGS, owned by the room leader
//
// Toby: "staff meetings are something that need to be organised and led by room
// leaders, and it's their responsibility to make sure they are going ahead and
// all the staff were attending and the meeting minutes are written up."
//
// APPENDED, never a rewrite (ABSOLUTE RULE 2). Everything above is untouched
// except five attendance counts, which now say `x.attended` and "held" — see
// the b530 comments at those five lines.
//
// This is the SAME table as /meetings above (ladn.cpd_room_meetings): the b530
// migration gave it a time, a lifecycle, an agenda, actions and real
// attendance. /meetings is left exactly as it was so the EY deep-dive page and
// scripts/verify-b262.js keep working; it writes a complete record in one go,
// which the status column's DEFAULT ('minutes_written') makes true by itself.
//
//   GET    /room-meetings                      the list, scoped to who you are
//   GET    /room-meetings/schedule             the weekly rhythm, per room
//   PUT    /room-meetings/schedule/:roomId     change it (room leader / manager)
//   GET    /room-meetings/overview             MANAGER — held / missed / outstanding
//   GET    /room-meetings/context               rooms + my scope + who can be an owner
//   POST   /room-meetings                      schedule one
//   GET    /room-meetings/:id                  one meeting, in full
//   PATCH  /room-meetings/:id                  date / time / leader / minutes / status
//   POST   /room-meetings/:id/agenda           add a free agenda item
//   DELETE /room-meetings/:id/agenda/:itemId   remove one (not the CPD read)
//   PUT    /room-meetings/:id/attendance       who came, and why anybody did not
//   POST   /room-meetings/:id/actions          an action with an owner and a date
//   PATCH  /room-meetings/:id/actions/:aid     tick it off / reword it
//   POST   /room-meetings/:id/read             "I've read these"
//
// Every permission decision is src/lib/room-meetings.js's, re-checked on the
// server for every write. The client hiding a button is not a permission.
// ═══════════════════════════════════════════════════════════════════════════

const RM = require('../lib/room-meetings');

/**
 * Which CPD article a room meeting on `date` discusses, and its theme.
 *
 * Exported so the b530 store, the rhythm sweep and the Roost panel all get the
 * answer from THIS maths rather than a second copy of it — b262's half-term
 * arithmetic (weeks of 8/7/6/5/7/8, membership by week overlap) resolved
 * against ladn.school_terms. The meeting discusses LAST week's read, which is
 * the same rule /current already applies as `meeting_article`.
 *
 * Returns null when there is no term, no theme for it, or no article for the
 * week — a meeting with no CPD read is still a meeting.
 */
async function meetingArticleFor(db, date) {
  try {
    const terms = await loadTerms(db);
    const pos = resolveWeek(terms, date ? toDate(date) : new Date());
    if (!pos) return null;
    const themes = await themesWithDates(db);
    const theme = themes.find(t =>
      t.academic_year === pos.term.academic_year && t.term === pos.term.term && t.half === pos.term.half);
    if (!theme) return null;
    // Week 1 has no previous week inside this theme — the meeting then
    // introduces the theme, exactly as /current says.
    const article = pos.week_no > 1 ? await articleFor(db, theme.id, pos.week_no - 1) : null;
    if (!article) return { theme, article: null, week_no: pos.week_no };
    return { theme, article, week_no: pos.week_no };
  } catch (_) {
    return null;
  }
}

// ── errors ──────────────────────────────────────────────────────────────────
// The store throws Errors carrying .status (400 / 403) with a sentence written
// for the person reading it. Anything else is a 500 and a log line.
function rmFail(res, err, where) {
  if (err && (err.status === 400 || err.status === 403)) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`cpd-programme/room-meetings ${where}:`, err && err.message);
  return res.status(500).json({ error: 'Something went wrong with the room meeting — try again.' });
}

// ── GET /room-meetings — the list ───────────────────────────────────────────
router.get('/room-meetings', async (req, res) => {
  try {
    const db = getPool();
    const me = await RM.actorFor(db, req.user);
    res.json(await RM.listMeetings(db, me, req.query));
  } catch (err) { rmFail(res, err, 'list'); }
});

// ── GET /room-meetings/schedule — the rhythm ────────────────────────────────
// Declared BEFORE /:id: Express matches in order, and 'schedule' is a perfectly
// good :id as far as the router is concerned.
router.get('/room-meetings/schedule', async (req, res) => {
  try {
    const db = getPool();
    const me = await RM.actorFor(db, req.user);
    res.json({ schedule: await RM.getSchedule(db), enabled: await RM.isEnabled(db), scope: RM.scopeFor(me) });
  } catch (err) { rmFail(res, err, 'schedule'); }
});

router.put('/room-meetings/schedule/:roomId', async (req, res) => {
  const roomId = parseInt(req.params.roomId, 10);
  if (!Number.isFinite(roomId)) return res.status(400).json({ error: 'Which room?' });
  try {
    const db = getPool();
    const out = await RM.setSchedule(db, await RM.actorFor(db, req.user), roomId, req.body || {});
    if (!out) return res.status(404).json({ error: 'That room has no meeting rhythm row.' });
    res.json({ schedule: out });
  } catch (err) { rmFail(res, err, 'schedule PUT'); }
});

// ── GET /room-meetings/overview — the Roost panel ───────────────────────────
// Manager-level only: it is every room's record at once, which is a
// leadership view. A room leader gets their own room from the list above.
router.get('/room-meetings/overview', async (req, res) => {
  const db = getPool();
  try {
    if (!RM.isManagerLevel(await RM.actorFor(db, req.user))) {
      return res.status(403).json({ error: 'Manager access required — this is every room at once.' });
    }
    const weeks = Math.min(52, Math.max(1, parseInt(req.query.weeks, 10) || 8));
    const data = await RM.overview(db, { weeks, today: req.query.today || undefined });
    data.enabled = await RM.isEnabled(db);
    data.overdue_rooms = await RM.roomsWithoutAMeeting(db, { today: req.query.today || undefined });
    res.json(data);
  } catch (err) { rmFail(res, err, 'overview'); }
});

// ── GET /room-meetings/context — what the page needs to draw itself ─────────
// Rooms, my scope, the next CPD read, and the people an action can be given to
// (the rooms I can write for, so a leader cannot hand work to another room).
router.get('/room-meetings/context', async (req, res) => {
  const db = getPool();
  try {
    const scope = RM.scopeFor(await RM.actorFor(db, req.user));
    const rooms = await RM.rooms(db);
    const visible = scope.can_read_all ? rooms
      : rooms.filter(r => Number(r.id) === scope.room_id);
    const ids = scope.writable_room_ids === 'all'
      ? rooms.map(r => Number(r.id)) : scope.writable_room_ids;
    const { rows: people } = ids.length
      ? await db.query(
          `SELECT id, first_name || ' ' || last_name AS name, job_title, room_id
             FROM staff
            WHERE is_active = true AND coalesce(role,'') <> 'parent' AND room_id = ANY($1::int[])
            ORDER BY first_name, last_name`, [ids])
      : { rows: [] };
    const art = await meetingArticleFor(db, new Date());
    res.json({
      scope,
      rooms: visible,
      writable_room_ids: ids,
      owner_candidates: people,
      schedule: await RM.getSchedule(db),
      enabled: await RM.isEnabled(db),
      cpd_read: art && art.article
        ? { id: art.article.id, title: art.article.title, week_no: art.article.week_no,
            minutes: art.article.minutes, theme_title: art.theme ? art.theme.title : null }
        : null,
      cpd_note: art && art.article ? null
        : 'There is no CPD read for this week — the meeting runs on the room’s own agenda.',
    });
  } catch (err) { rmFail(res, err, 'context'); }
});

// ── POST /room-meetings — schedule one ──────────────────────────────────────
router.post('/room-meetings', async (req, res) => {
  const b = req.body || {};
  const roomId = parseInt(b.room_id, 10);
  if (!Number.isFinite(roomId)) return res.status(400).json({ error: 'Which room is the meeting for?' });
  const db = getPool();
  const me = await RM.actorFor(db, req.user);
  if (!RM.canWrite(me, roomId)) {
    const s = RM.scopeFor(me);
    return res.status(403).json({
      error: s.reason
        || (s.level === 'room_leader'
          ? 'You can read other rooms’ meetings, but you can only run your own room’s.'
          : 'Room meetings are organised by the room leader. You can read your room’s minutes and confirm you have read them.'),
    });
  }
  try {
    const out = await RM.createMeeting(db, me, b);
    const full = await RM.getMeeting(db, me, out.id);
    res.status(out.created ? 201 : 200).json({ ...full, created: out.created });
  } catch (err) { rmFail(res, err, 'create'); }
});

// ── GET /room-meetings/:id ──────────────────────────────────────────────────
router.get('/room-meetings/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad meeting id' });
  try {
    const db = getPool();
    const out = await RM.getMeeting(db, await RM.actorFor(db, req.user), id);
    if (!out) return res.status(404).json({ error: 'That meeting does not exist.' });
    if (out.forbidden) {
      return res.status(403).json({ error: 'That meeting belongs to another room.' });
    }
    res.json(out);
  } catch (err) { rmFail(res, err, 'get'); }
});

// ── PATCH /room-meetings/:id ────────────────────────────────────────────────
router.patch('/room-meetings/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad meeting id' });
  try {
    const db = getPool();
    const me = await RM.actorFor(db, req.user);
    const out = await RM.updateMeeting(db, me, id, req.body || {});
    if (!out) return res.status(404).json({ error: 'That meeting does not exist.' });
    res.json(await RM.getMeeting(db, me, id));
  } catch (err) { rmFail(res, err, 'patch'); }
});

// ── Agenda ──────────────────────────────────────────────────────────────────
router.post('/room-meetings/:id/agenda', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad meeting id' });
  try {
    const db = getPool();
    const out = await RM.addAgendaItem(db, await RM.actorFor(db, req.user), id, req.body || {});
    if (!out) return res.status(404).json({ error: 'That meeting does not exist.' });
    res.status(201).json({ item: out });
  } catch (err) { rmFail(res, err, 'agenda POST'); }
});

router.delete('/room-meetings/:id/agenda/:itemId', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  if (!Number.isFinite(id) || !Number.isFinite(itemId)) return res.status(400).json({ error: 'Bad id' });
  try {
    const db = getPool();
    const out = await RM.removeAgendaItem(db, await RM.actorFor(db, req.user), id, itemId);
    if (!out) return res.status(404).json({ error: 'That agenda item does not exist.' });
    res.json(out);
  } catch (err) { rmFail(res, err, 'agenda DELETE'); }
});

// ── Attendance ──────────────────────────────────────────────────────────────
router.put('/room-meetings/:id/attendance', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad meeting id' });
  try {
    const db = getPool();
    const me = await RM.actorFor(db, req.user);
    const out = await RM.setAttendance(db, me, id, (req.body || {}).attendees);
    if (!out) return res.status(404).json({ error: 'That meeting does not exist.' });
    res.json(await RM.getMeeting(db, me, id));
  } catch (err) { rmFail(res, err, 'attendance'); }
});

// Re-read the rota for this meeting's day and add anybody missing from the
// expected list. Adds only — a leader's ticks are never overwritten.
router.post('/room-meetings/:id/attendance/refresh', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad meeting id' });
  try {
    const db = getPool();
    const me = await RM.actorFor(db, req.user);
    const { rows } = await db.query(`SELECT room_id, meeting_date FROM cpd_room_meetings WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'That meeting does not exist.' });
    if (!RM.canWrite(me, rows[0].room_id)) {
      return res.status(403).json({ error: 'Only this room’s leader, or a manager, can change the list.' });
    }
    const added = await RM.ensureExpected(db, id, rows[0].room_id, rows[0].meeting_date, me);
    const full = await RM.getMeeting(db, me, id);
    res.json({ ...full, prefill: added });
  } catch (err) { rmFail(res, err, 'attendance refresh'); }
});

// ── Actions ─────────────────────────────────────────────────────────────────
router.post('/room-meetings/:id/actions', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad meeting id' });
  try {
    const db = getPool();
    const out = await RM.addAction(db, await RM.actorFor(db, req.user), id, req.body || {});
    if (!out) return res.status(404).json({ error: 'That meeting does not exist.' });
    res.status(201).json({ action: out });
  } catch (err) { rmFail(res, err, 'actions POST'); }
});

router.patch('/room-meetings/:id/actions/:aid', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const aid = parseInt(req.params.aid, 10);
  if (!Number.isFinite(id) || !Number.isFinite(aid)) return res.status(400).json({ error: 'Bad id' });
  try {
    const db = getPool();
    const out = await RM.updateAction(db, await RM.actorFor(db, req.user), id, aid, req.body || {});
    if (!out) return res.status(404).json({ error: 'That action does not exist.' });
    res.json({ action: out });
  } catch (err) { rmFail(res, err, 'actions PATCH'); }
});

// ── "I've read these" ───────────────────────────────────────────────────────
router.post('/room-meetings/:id/read', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'Bad meeting id' });
  try {
    const db = getPool();
    const out = await RM.confirmRead(db, await RM.actorFor(db, req.user), id);
    if (!out) return res.status(404).json({ error: 'That meeting does not exist.' });
    res.json(out);
  } catch (err) { rmFail(res, err, 'read'); }
});

module.exports = router;
// b530 — the store, the rhythm sweep and the Roost panel resolve "which CPD
// read does this meeting discuss" through this one function rather than keeping
// a second copy of b262's half-term arithmetic.
module.exports.meetingArticleFor = meetingArticleFor;
