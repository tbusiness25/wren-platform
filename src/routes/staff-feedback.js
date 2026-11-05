'use strict';
/**
 * staff-feedback.js — b360 (2026-09-29). Mounted at /api/staff-feedback.
 *
 * Toby: "Create a final survey for staff … In fact call it a Staff Feedback Page
 * instead of a survey page. It can be used at any time and used multiple times."
 *
 * So the page is not a survey and this router does not own one. What it owns is
 * the four things around the saying-something that had nowhere to live:
 *
 *   ── anyone signed in, about themselves ─────────────────────────────────────
 *   GET    /meta                  the area picker, the current term, the More
 *                                 menu as a checklist, what I have already said
 *   GET    /mine                  my own reports, newest first (mine only)
 *   GET    /survey                MY answers to this term's questions
 *   PUT    /survey                upsert one or more answers (no submit gate)
 *   POST   /survey/submit         stamp submitted_at — a courtesy, not a gate
 *   GET    /more-hidden           the More tiles I have hidden
 *   PUT    /more-hidden           hide / restore, by nav_key
 *   POST   /more-hidden/restore-all
 *   GET    /deep-dive             every deep-dive theme + MY review of each
 *   PUT    /deep-dive/:themeId    upsert my review of one theme
 *
 *   ── management (manager-tier role AND the Roost person allowlist) ──────────
 *   GET    /summary               the aggregate: this term's answers, which More
 *                                 items nobody uses, the deep dive per topic
 *
 * ── WHERE THE WORDS ACTUALLY GO ─────────────────────────────────────────────
 * NOT HERE. A bug or an idea typed on the Staff Feedback page is POSTed by the
 * page to /api/feedback — the same endpoint the floating 🐞 widget has used
 * since 2026-07-09 — and lands as one ladn.feedback_reports row. That table is
 * the b197 'staff-app' source of ladn.reports_inbox, so it is on the bugs board
 * with everything else the moment it is saved. The brief is explicit ("Do not
 * build a second bug store") and this file honours it by not having a POST for
 * a report at all. GET /mine below reads that same table back.
 *
 * ── STAFF OPINIONS ARE PERSONAL DATA ────────────────────────────────────────
 * Attributed by design, the same contract as the b312 handbook consultation and
 * deliberately NOT the b345 anonymous box:
 *   • every aggregate is behind managerOnly()
 *   • a practitioner can read their OWN answers and nobody else's. There is no
 *     staff_id parameter on any read or write a practitioner can reach; the
 *     owner is always taken from the login token.
 *   • a manager cannot edit what a practitioner wrote — every UPDATE here is
 *     `WHERE staff_id = <token owner>`, so a manager PUTting somebody else's
 *     row gets their own row back, not theirs.
 *   • nothing from these tables is ever put in an AI prompt. There is no /ai
 *     endpoint here and no summariser; Roost shows the words people wrote.
 * The page says all of this on screen, and points at the anonymous box for
 * anything somebody would rather not put their name to.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { isRoostAllowed } = require('../lib/roost-allowlist');
const moreMenu = require('../lib/more-menu');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// A parent token has no business here; the parents portal has its own feedback
// widget (b129) and its own store.
router.use((req, res, next) =>
  req.user && req.user.role === 'parent' ? res.status(403).json({ error: 'Staff only' }) : next());

// Same gate, same reasoning, as src/routes/staff-voice.js: a manager-tier ROLE
// and the Roost person allowlist. Role alone treats every deputy as manager-
// equivalent, and the aggregate here contains named opinions about how the
// nursery is run. isRoostAllowed() fails OPEN on a schema with no such setting
// (the demo and school editions), which is why the role test stays as well.
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];
const isManager = req => Number(req.user.id) === 1 || hasRole(req.user, MANAGER_ROLES);
const managerOnly = async (req, res, next) => {
  const no = () => res.status(403).json({ error: 'Management access required' });
  if (!isManager(req)) return no();
  let ok;
  try { ok = await isRoostAllowed(req.user.id); } catch { ok = Number(req.user.id) === 1; }
  return ok ? next() : no();
};

// A migration that has not been applied reads as "not applied", not as a 500.
const schemaMissing = e => e && (e.code === '42P01' || e.code === '42703');
function notApplied(res) {
  return res.status(503).json({
    error: 'schema_not_applied',
    message: 'The staff feedback tables are not present. Apply migrations/2026-09-29-b360-staff-feedback.sql.',
  });
}
const fail = (res, e) => (schemaMissing(e) ? notApplied(res) : res.status(500).json({ error: e.message }));

const TEXT_MAX = 4000;
const clip = (v, n) => (v == null || v === '' ? null : String(v).slice(0, n || TEXT_MAX));

// ── The area picker ─────────────────────────────────────────────────────────
// What a practitioner would say their report is ABOUT, in their words, not in
// portal names. Written here rather than derived from the More menu because a
// report is often about something that is not a menu tile ("the tablet", "the
// login"), and because the list wants to be short enough to scan on a phone.
// Stored on feedback_reports.wren_area as the `key`.
const AREAS = [
  { key: 'diary',         label: 'Daily diary' },
  { key: 'observations',  label: 'Observations & next steps' },
  { key: 'termly',        label: 'Termly updates & reports' },
  { key: 'register',      label: 'Register, sign in & out' },
  { key: 'safeguarding',  label: 'Safeguarding, accidents & medicine' },
  { key: 'planning',      label: 'Planning & curriculum' },
  { key: 'kitchen',       label: 'Kitchen & food' },
  { key: 'messages',      label: 'Messages & email' },
  { key: 'cpd',           label: 'Training, CPD & deep dive' },
  { key: 'rota',          label: 'Rota, shifts & clocking in' },
  { key: 'parents',       label: 'What parents see' },
  { key: 'tablet',        label: 'The tablet itself (slow, logged out, frozen)' },
  { key: 'login',         label: 'Logging in, PINs & fobs' },
  { key: 'other',         label: 'Something else' },
];
const AREA_KEYS = AREAS.map(a => a.key);

// ── Which term's questions are open ─────────────────────────────────────────
// ladn.school_terms holds HALF-terms ('Autumn 1', 'Autumn 2'). The questionnaire
// is once a TERM, not once a half-term — six rounds a year is nagging, three is
// a rhythm — so the key drops the number: '2026-2027-autumn'.
//
// Out of term (the holidays) the most recently ENDED term stays open, so
// somebody catching up in the week after half-term answers the term they have
// just lived through rather than opening a term that has not started.
async function currentTerm(db) {
  const fallback = { key: 'undated', name: 'This term', academic_year: null };
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT name, academic_year, start_date, end_date FROM school_terms
        WHERE current_date BETWEEN start_date AND end_date
        ORDER BY start_date DESC LIMIT 1`));
    if (!rows.length) {
      ({ rows } = await db.query(
        `SELECT name, academic_year, start_date, end_date FROM school_terms
          WHERE end_date < current_date ORDER BY end_date DESC LIMIT 1`));
    }
    if (!rows.length) {
      ({ rows } = await db.query(
        `SELECT name, academic_year, start_date, end_date FROM school_terms
          ORDER BY start_date LIMIT 1`));
    }
  } catch (e) {
    if (!schemaMissing(e)) throw e;
    return fallback;
  }
  if (!rows.length) return fallback;
  const t = rows[0];
  const base = String(t.name || '').replace(/\s*\d+\s*$/, '').trim() || 'Term';
  return {
    key: `${t.academic_year || 'na'}-${base.toLowerCase()}`.replace(/\s+/g, '-'),
    name: `${base} ${t.academic_year || ''}`.trim(),
    academic_year: t.academic_year || null,
    half_term: t.name,
  };
}

// My survey row for a term, created empty on first read so the page always has
// something to PUT into. ON CONFLICT DO NOTHING, so two tablets opening the page
// at once cannot make two rows.
async function mySurvey(db, staffId, termKey) {
  await db.query(
    `INSERT INTO staff_feedback_surveys (staff_id, term_key) VALUES ($1,$2)
     ON CONFLICT (staff_id, term_key) DO NOTHING`, [staffId, termKey]);
  const { rows } = await db.query(
    `SELECT id, term_key, working_well, not_working, one_change, never_use_keys,
            overall_rating, submitted_at, updated_at
       FROM staff_feedback_surveys WHERE staff_id=$1 AND term_key=$2`, [staffId, termKey]);
  return rows[0] || null;
}

// ── GET /meta ───────────────────────────────────────────────────────────────
// Everything the page needs to draw itself in one round-trip.
router.get('/meta', async (req, res) => {
  const db = getPool();
  try {
    const term = await currentTerm(db);
    const survey = await mySurvey(db, req.user.id, term.key);
    const { rows: hidden } = await db.query(
      `SELECT nav_key FROM staff_more_hidden WHERE staff_id=$1 AND hidden = true`, [req.user.id]);
    res.json({
      areas: AREAS,
      term,
      survey,
      more_groups: moreMenu.groups(),
      never_hideable: moreMenu.NEVER_HIDEABLE,
      hidden: hidden.map(r => r.nav_key),
      me: { id: req.user.id, name: req.user.name || null, is_manager: isManager(req) },
    });
  } catch (e) { fail(res, e); }
});

// ── GET /mine — what I have already reported ────────────────────────────────
// Read straight out of ladn.feedback_reports, the store the 🐞 widget writes and
// the bugs board reads. `submitted_by = <token owner>` is the whole access rule:
// there is no parameter that could widen it, so this endpoint cannot show one
// person another's report even to a manager.
router.get('/mine', async (req, res) => {
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  try {
    const { rows } = await getPool().query(
      `SELECT r.id, r.kind, r.title, r.body, r.status, r.wren_area, r.page_path, r.created_at,
              (r.screenshot_path IS NOT NULL) AS has_screenshot,
              (SELECT count(*)::int FROM feedback_report_shots s WHERE s.report_id = r.id) AS shot_count,
              -- 2026-10-17: where it is on Toby's bug board (reports_triage), so staff can see progress
              t.status AS board_status, t.fixed_at AS board_fixed_at, t.updated_at AS board_updated_at
         FROM feedback_reports r
         LEFT JOIN reports_triage t ON t.source = 'staff-app' AND t.source_id = r.id
        WHERE r.submitted_by = $1
        ORDER BY r.created_at DESC LIMIT $2`, [req.user.id, limit]);
    res.json({ reports: rows });
  } catch (e) { fail(res, e); }
});

// ── GET /survey ─────────────────────────────────────────────────────────────
router.get('/survey', async (req, res) => {
  const db = getPool();
  try {
    const term = await currentTerm(db);
    res.json({ term, survey: await mySurvey(db, req.user.id, term.key),
               more_groups: moreMenu.groups() });
  } catch (e) { fail(res, e); }
});

// ── PUT /survey ─────────────────────────────────────────────────────────────
// Every field is optional and saved on its own, the b312 lesson: there is no
// "submit the form" step that can lose what somebody typed, and no validation
// that can refuse a half-finished answer. A field the caller did not send is
// left exactly as it was (COALESCE on a sentinel, not on the value — so sending
// an empty string genuinely clears an answer).
router.put('/survey', express.json({ limit: '64kb' }), async (req, res) => {
  const b = req.body || {};
  const db = getPool();
  try {
    const term = await currentTerm(db);
    await mySurvey(db, req.user.id, term.key);

    const sets = [];
    const params = [req.user.id, term.key];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };

    if ('working_well' in b) set('working_well', clip(b.working_well));
    if ('not_working' in b)  set('not_working',  clip(b.not_working));
    if ('one_change' in b)   set('one_change',   clip(b.one_change));
    if ('overall_rating' in b) {
      const n = parseInt(b.overall_rating, 10);
      set('overall_rating', Number.isInteger(n) && n >= 1 && n <= 5 ? n : null);
    }
    if ('never_use_keys' in b) {
      // Only real tiles, and never more than the menu holds. An unknown key is
      // dropped rather than 400ing the whole save: the checklist is built from a
      // page that changes, and a stale tab must not cost somebody their answers.
      const known = moreMenu.byKey();
      const keys = Array.isArray(b.never_use_keys) ? b.never_use_keys : [];
      set('never_use_keys', keys.map(String).filter(k => known[k]).slice(0, 200));
    }
    if (!sets.length) return res.json({ ok: true, unchanged: true });

    const { rows } = await db.query(
      `UPDATE staff_feedback_surveys SET ${sets.join(', ')}, updated_at = now()
        WHERE staff_id = $1 AND term_key = $2
        RETURNING id, term_key, working_well, not_working, one_change,
                  never_use_keys, overall_rating, submitted_at, updated_at`, params);
    res.json({ ok: true, survey: rows[0] || null });
  } catch (e) { fail(res, e); }
});

// ── POST /survey/submit ─────────────────────────────────────────────────────
// Idempotent, and a courtesy rather than a gate: every answer already counted
// the moment it was typed. This only tells Toby to stop chasing.
router.post('/survey/submit', async (req, res) => {
  const db = getPool();
  try {
    const term = await currentTerm(db);
    await mySurvey(db, req.user.id, term.key);
    const { rows } = await db.query(
      `UPDATE staff_feedback_surveys
          SET submitted_at = COALESCE(submitted_at, now()), updated_at = now()
        WHERE staff_id=$1 AND term_key=$2 RETURNING submitted_at`, [req.user.id, term.key]);
    res.json({ ok: true, submitted_at: rows.length ? rows[0].submitted_at : null });
  } catch (e) { fail(res, e); }
});

// ── GET /more-hidden ────────────────────────────────────────────────────────
router.get('/more-hidden', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT nav_key, hidden_at FROM staff_more_hidden
        WHERE staff_id=$1 AND hidden = true ORDER BY hidden_at`, [req.user.id]);
    const byKey = moreMenu.byKey();
    res.json({
      hidden: rows.map(r => ({
        key: r.nav_key,
        label: byKey[r.nav_key] ? byKey[r.nav_key].label : r.nav_key,
        group: byKey[r.nav_key] ? byKey[r.nav_key].group : null,
        hidden_at: r.hidden_at,
      })),
      never_hideable: moreMenu.NEVER_HIDEABLE,
    });
  } catch (e) { fail(res, e); }
});

// ── PUT /more-hidden ────────────────────────────────────────────────────────
// { hide: [navKey…], show: [navKey…] }
//
// PER PERSON, SERVER-SIDE. The tablets in the rooms are shared — two people sign
// into the same browser one after the other — so localStorage would hide a practitioner's
// tiles from the room leader. staff_id comes from the token; there is no parameter for it.
//
// PRESENTATION, NEVER PERMISSION. A hidden tile's URL still works and the API
// gate is untouched. And a tile on NEVER_HIDEABLE is refused outright: hiding the
// route to recording a safeguarding concern is not a preference.
//
// Nothing is DELETEd — `hidden` is flipped to false, per the migration's note.
router.put('/more-hidden', express.json({ limit: '32kb' }), async (req, res) => {
  const b = req.body || {};
  const hide = (Array.isArray(b.hide) ? b.hide : []).map(String).slice(0, 200);
  const show = (Array.isArray(b.show) ? b.show : []).map(String).slice(0, 200);
  const refused = hide.filter(k => !moreMenu.isHideable(k));
  const ok = hide.filter(k => moreMenu.isHideable(k));
  const db = getPool();
  try {
    for (const key of ok) {
      await db.query(
        `INSERT INTO staff_more_hidden (staff_id, nav_key, hidden, hidden_at, updated_at)
         VALUES ($1,$2,true,now(),now())
         ON CONFLICT (staff_id, nav_key)
         DO UPDATE SET hidden = true, hidden_at = now(), updated_at = now()`,
        [req.user.id, key]);
    }
    if (show.length) {
      await db.query(
        `UPDATE staff_more_hidden SET hidden = false, updated_at = now()
          WHERE staff_id = $1 AND nav_key = ANY($2::text[])`, [req.user.id, show]);
    }
    const { rows } = await db.query(
      `SELECT nav_key FROM staff_more_hidden WHERE staff_id=$1 AND hidden = true`, [req.user.id]);
    res.json({ ok: true, hidden: rows.map(r => r.nav_key), refused });
  } catch (e) { fail(res, e); }
});

// ── POST /more-hidden/restore-all ───────────────────────────────────────────
router.post('/more-hidden/restore-all', async (req, res) => {
  try {
    const { rowCount } = await getPool().query(
      `UPDATE staff_more_hidden SET hidden = false, updated_at = now()
        WHERE staff_id = $1 AND hidden = true`, [req.user.id]);
    res.json({ ok: true, restored: rowCount });
  } catch (e) { fail(res, e); }
});

// ── GET /deep-dive ──────────────────────────────────────────────────────────
// Every theme in the current academic year (or all of them, ?all=1) with MY
// review attached. Themes come from ladn.cpd_themes, the b262 table the
// programme already runs on — this build adds no second list of topics.
router.get('/deep-dive', async (req, res) => {
  const db = getPool();
  try {
    const all = String(req.query.all || '') === '1';
    const { rows } = await db.query(
      `SELECT t.id, t.theme_key, t.title, t.summary, t.evaluation_area,
              t.academic_year, t.term, t.half, t.sort_order,
              r.topic_useful, r.timing_verdict, r.meeting_verdict, r.comment,
              r.suggestion, r.updated_at AS reviewed_at
         FROM cpd_themes t
         LEFT JOIN cpd_theme_reviews r ON r.theme_id = t.id AND r.staff_id = $1
        WHERE t.active = true
          ${all ? '' : `AND t.academic_year = (SELECT max(academic_year) FROM cpd_themes WHERE active = true)`}
        ORDER BY t.academic_year, t.sort_order, t.id`, [req.user.id]);
    res.json({ themes: rows });
  } catch (e) { fail(res, e); }
});

const TIMING = ['right', 'too_long', 'too_short', 'wrong_time'];
const MEETING = ['useful', 'too_long', 'too_short', 'not_happening'];

// ── PUT /deep-dive/:themeId ─────────────────────────────────────────────────
// One theme's review, upserted. staff_id is the token owner, so a manager
// PUTting this writes their OWN review of that theme, never somebody else's.
//
// PARTIAL, like PUT /survey above and for the same reason: a field the caller
// did not mention keeps whatever it had. The Review screen sends all five at
// once so it makes no difference there — but a PUT that silently wiped the
// paragraph somebody typed because a later call only changed a thumbs-up is the
// kind of data loss nobody notices until the aggregate is empty. Sending an
// explicit null clears a field; leaving it out does not.
router.put('/deep-dive/:themeId', express.json({ limit: '32kb' }), async (req, res) => {
  const themeId = parseInt(req.params.themeId, 10);
  if (!Number.isInteger(themeId) || themeId <= 0) return res.status(400).json({ error: 'bad theme id' });
  const b = req.body || {};
  const useful = b.topic_useful === true ? true : (b.topic_useful === false ? false : null);
  const timing = TIMING.indexOf(String(b.timing_verdict)) !== -1 ? String(b.timing_verdict) : null;
  const meeting = MEETING.indexOf(String(b.meeting_verdict)) !== -1 ? String(b.meeting_verdict) : null;
  const db = getPool();
  try {
    await db.query(
      `INSERT INTO cpd_theme_reviews
         (staff_id, theme_id, topic_useful, timing_verdict, meeting_verdict, comment, suggestion)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (staff_id, theme_id) DO NOTHING`,
      [req.user.id, themeId, useful, timing, meeting, clip(b.comment, 2000), clip(b.suggestion, 2000)]);

    const sets = [];
    const params = [req.user.id, themeId];
    const set = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
    if ('topic_useful' in b)    set('topic_useful', useful);
    if ('timing_verdict' in b)  set('timing_verdict', timing);
    if ('meeting_verdict' in b) set('meeting_verdict', meeting);
    if ('comment' in b)         set('comment', clip(b.comment, 2000));
    if ('suggestion' in b)      set('suggestion', clip(b.suggestion, 2000));

    const { rows } = await db.query(
      `UPDATE cpd_theme_reviews SET ${sets.length ? sets.join(', ') + ', ' : ''}updated_at = now()
        WHERE staff_id = $1 AND theme_id = $2
        RETURNING theme_id, topic_useful, timing_verdict, meeting_verdict, comment, suggestion, updated_at`,
      params);
    res.json({ ok: true, review: rows[0] });
  } catch (e) {
    if (e && e.code === '23503') return res.status(404).json({ error: 'No such deep-dive theme' });
    fail(res, e);
  }
});

// ── GET /summary — MANAGER ──────────────────────────────────────────────────
// Everything aggregated, plus the words people actually wrote. No summariser and
// no AI: Toby reads what was typed.
router.get('/summary', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const term = await currentTerm(db);
    const termKey = String(req.query.term || term.key);

    // Who was asked. Active staff, nobody excluded by role — an apprentice's
    // answer is worth as much as a room leader's, and the cook has an opinion
    // about the kitchen screen.
    const { rows: audience } = await db.query(
      `SELECT count(*)::int AS n FROM staff WHERE is_active = true`);

    const { rows: answers } = await db.query(
      `SELECT s.staff_id, st.first_name, st.last_name, st.role,
              s.working_well, s.not_working, s.one_change, s.overall_rating,
              s.never_use_keys, s.submitted_at, s.updated_at
         FROM staff_feedback_surveys s
         JOIN staff st ON st.id = s.staff_id
        WHERE s.term_key = $1
          AND (s.working_well IS NOT NULL OR s.not_working IS NOT NULL
               OR s.one_change IS NOT NULL OR s.overall_rating IS NOT NULL
               OR array_length(s.never_use_keys, 1) > 0)
        ORDER BY s.updated_at DESC`, [termKey]);

    // Which More items people say they will never use — the count, and who.
    const { rows: neverUse } = await db.query(
      `SELECT k AS nav_key, count(*)::int AS n
         FROM staff_feedback_surveys s, unnest(s.never_use_keys) k
        WHERE s.term_key = $1
        GROUP BY k ORDER BY n DESC, k`, [termKey]);

    // What people have actually hidden for themselves — a truer signal than the
    // checklist, because it costs them nothing to say it and something to do it.
    const { rows: actuallyHidden } = await db.query(
      `SELECT nav_key, count(*)::int AS n FROM staff_more_hidden
        WHERE hidden = true GROUP BY nav_key ORDER BY n DESC, nav_key`);

    const byKey = moreMenu.byKey();
    const name = k => (byKey[k] ? byKey[k].label : k);
    const group = k => (byKey[k] ? byKey[k].group : null);

    // The deep dive, per topic.
    const { rows: deepDive } = await db.query(
      `SELECT t.id, t.title, t.academic_year, t.term, t.half, t.evaluation_area,
              count(r.id)::int                                            AS reviews,
              count(*) FILTER (WHERE r.topic_useful IS TRUE)::int         AS useful,
              count(*) FILTER (WHERE r.topic_useful IS FALSE)::int        AS not_useful,
              count(*) FILTER (WHERE r.timing_verdict = 'right')::int     AS timing_right,
              count(*) FILTER (WHERE r.timing_verdict = 'too_long')::int  AS timing_too_long,
              count(*) FILTER (WHERE r.timing_verdict = 'too_short')::int AS timing_too_short,
              count(*) FILTER (WHERE r.timing_verdict = 'wrong_time')::int AS timing_wrong_time,
              count(*) FILTER (WHERE r.meeting_verdict = 'useful')::int   AS meeting_useful,
              count(*) FILTER (WHERE r.meeting_verdict = 'too_long')::int AS meeting_too_long,
              count(*) FILTER (WHERE r.meeting_verdict = 'too_short')::int AS meeting_too_short,
              count(*) FILTER (WHERE r.meeting_verdict = 'not_happening')::int AS meeting_not_happening
         FROM cpd_themes t
         LEFT JOIN cpd_theme_reviews r ON r.theme_id = t.id
        WHERE t.active = true
        GROUP BY t.id
        ORDER BY t.academic_year, t.sort_order, t.id`);

    const { rows: deepDiveWords } = await db.query(
      `SELECT r.theme_id, st.first_name, st.last_name, r.comment, r.suggestion, r.updated_at
         FROM cpd_theme_reviews r JOIN staff st ON st.id = r.staff_id
        WHERE r.comment IS NOT NULL OR r.suggestion IS NOT NULL
        ORDER BY r.updated_at DESC LIMIT 300`);

    // Reports filed from the page / the widget this term — counts only. The
    // reports themselves are the bugs board's job, not this one's; linking there
    // rather than copying them keeps one board.
    let reports = { total: 0, by_kind: {}, by_area: [] };
    try {
      const { rows: byKind } = await db.query(
        `SELECT kind, count(*)::int n FROM feedback_reports
          WHERE created_at >= now() - interval '120 days' GROUP BY kind`);
      byKind.forEach(r => { reports.by_kind[r.kind] = r.n; reports.total += r.n; });
      const { rows: byArea } = await db.query(
        `SELECT wren_area, count(*)::int n FROM feedback_reports
          WHERE wren_area IS NOT NULL AND created_at >= now() - interval '120 days'
          GROUP BY wren_area ORDER BY n DESC`);
      reports.by_area = byArea.map(r => ({
        key: r.wren_area, n: r.n,
        label: (AREAS.find(a => a.key === r.wren_area) || {}).label || r.wren_area,
      }));
    } catch (e) { if (!schemaMissing(e)) throw e; }

    res.json({
      term: { ...term, key: termKey },
      audience: audience[0].n,
      answered: answers.length,
      answers,
      never_use: neverUse.map(r => ({ ...r, label: name(r.nav_key), group: group(r.nav_key) })),
      actually_hidden: actuallyHidden.map(r => ({ ...r, label: name(r.nav_key), group: group(r.nav_key) })),
      deep_dive: deepDive,
      deep_dive_words: deepDiveWords,
      reports,
      areas: AREAS,
    });
  } catch (e) { fail(res, e); }
});

module.exports = router;
module.exports.AREAS = AREAS;
module.exports.AREA_KEYS = AREA_KEYS;
