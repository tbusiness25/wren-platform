'use strict';
/**
 * consultation.js — b312 (2026-09-10). Mounted at /api/consultation.
 *
 * The staff handbook consultation. The booklet itself is static
 * (public/js/wren-handbook-content.js); this router owns the answers.
 *
 *   GET   /                       the open consultation: questions, MY answers,
 *                                 MY progress. The only endpoint the EY page needs.
 *   PUT   /progress               { last_chapter_key, chapters_read[] }
 *   PUT   /answer                 { question_id, choice, free_text } — upsert
 *   POST  /submit                 stamp submitted_at (idempotent)
 *   POST  /printed                stamp printed_at — "somebody took paper"
 *   GET   /facts                  the real numbers chapter 14 quotes, computed live
 *   GET   /summary                MANAGER — who answered, the split per question,
 *                                 every free-text answer, who has not started
 *   POST  /nudge                  MANAGER — in-app nudge to whoever has not
 *                                 submitted. Never email. Capped.
 *
 * ── WHY THE LAST ATTEMPT GOT NOTHING, AND WHAT THAT MEANS FOR THIS FILE ─────
 * Fledge was published with an open invitation to comment and got zero replies.
 * The lesson taken here is not "ask harder", it is that the cost of starting
 * has to be one tap and the cost of stopping has to be zero. So:
 *
 *   • PUT /answer takes ONE question. There is no "submit the form" step that
 *     can lose thirteen chapters of work, and no validation that can refuse a
 *     half-finished answer.
 *   • Progress is a separate row from the answers, so closing the tab mid-
 *     chapter loses nothing at all — not even the scroll position.
 *   • POST /submit is a courtesy, not a gate. Every answer already counted the
 *     moment it was tapped; submitting only tells Toby to stop chasing.
 *
 * ── STAFF OPINIONS ARE PERSONAL DATA ────────────────────────────────────────
 * Attributed by design (see the migration for why), and therefore:
 *   • every aggregate is behind isManager()
 *   • a non-manager can read their OWN answers and nobody else's — there is no
 *     staff_id parameter on any read a practitioner can reach
 *   • nothing from this table is ever put in an AI prompt. There is no /ai
 *     endpoint here and no summariser; the Roost view shows Toby the words
 *     people actually wrote.
 *   • the nudge body carries a COUNT, never an opinion, never a question, and
 *     never another person's name.
 *
 * ── AND NEVER BY EMAIL ──────────────────────────────────────────────────────
 * The nudge goes through notify() with category 'consultation_nudge'. That
 * category is on NEITHER email list in src/services/notification-dispatcher.js,
 * and that allowlist fails CLOSED — so email is refused by the dispatcher even
 * if somebody later ticks "email" against it in their preferences. It is
 * belt-and-braces on top of the brief's rule, not a re-statement of it.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const { recordAudit } = require('../utils/audit');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const SLUG = 'wren-handbook-2026';

// Manager-equivalent roles. Kept as its own list rather than imported so this
// router's answer to "who may read staff opinions" is visible in this file.
// 'manager' after b271 is the FLOOR manager, and a floor manager runs the room
// meetings this consultation is largely about — they are in.
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'owner', 'headteacher'];
const isManager = req => Number(req.user.id) === 1 || hasRole(req.user, MANAGER_ROLES);
const managerOnly = (req, res, next) =>
  isManager(req) ? next() : res.status(403).json({ error: 'Manager access required' });

// A migration that has not been applied should read as "not applied", not as a
// 500. Same shape the b306 provisioning routes use.
function schemaMissing(e) {
  return e && (e.code === '42P01' || e.code === '42703');
}
function notApplied(res) {
  return res.status(503).json({
    error: 'schema_not_applied',
    message: 'The consultation tables are not present. Apply migrations/2026-09-10-b312-consultation.sql.',
  });
}

// ── Who is expected to answer ───────────────────────────────────────────────
// Active staff. Nobody is excluded by role: an apprentice's answer to "should
// pop-up CPD be announced" is worth exactly as much as a room leader's, and a
// cook has an opinion about the kitchen chapter. Toby is included because he is
// staff — the Roost view shows him his own row like anyone else's.
const AUDIENCE_SQL = `
  SELECT id, first_name, last_name, role, room_id
    FROM staff
   WHERE is_active = true
   ORDER BY lower(coalesce(first_name,'')), lower(coalesce(last_name,''))`;

async function loadConsultation(db) {
  const { rows } = await db.query(
    `SELECT id, slug, title, subtitle, intro, status, opens_at, closes_at
       FROM consultations WHERE slug = $1`, [SLUG]);
  return rows[0] || null;
}

// ── GET / — everything the booklet page needs, in one call ──────────────────
router.get('/', async (req, res) => {
  const db = getPool();
  try {
    const c = await loadConsultation(db);
    if (!c) return res.status(404).json({ error: 'not_found', message: 'No handbook consultation is set up.' });

    const { rows: questions } = await db.query(
      `SELECT id, chapter_key, sort_order, prompt, kind, options, free_text_label
         FROM consultation_questions WHERE consultation_id = $1 ORDER BY sort_order, id`,
      [c.id]);

    const { rows: mine } = await db.query(
      `SELECT question_id, choice, free_text, answered_at
         FROM consultation_responses WHERE consultation_id = $1 AND staff_id = $2`,
      [c.id, req.user.id]);

    // Opening the booklet is the ONE thing that stamps opened_at, and it is
    // stamped before the row is read back so the caller sees the truth.
    // Everything else that writes to this table (a nudge, a print, a submit)
    // deliberately leaves it alone: "who has not started" is the question the
    // Roost view exists to answer, and inferring it from the presence of a row
    // reported 23 nudged people as having opened it. COALESCE keeps the FIRST
    // open rather than the latest.
    await db.query(
      `INSERT INTO consultation_progress (consultation_id, staff_id, opened_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (consultation_id, staff_id) DO UPDATE
         SET opened_at  = COALESCE(consultation_progress.opened_at, now()),
             updated_at = now()`,
      [c.id, req.user.id]).catch(() => { /* never block the booklet on bookkeeping */ });

    const { rows: prog } = await db.query(
      `SELECT last_chapter_key, chapters_read, started_at, opened_at, submitted_at, printed_at
         FROM consultation_progress WHERE consultation_id = $1 AND staff_id = $2`,
      [c.id, req.user.id]);

    res.json({
      consultation: c,
      questions,
      // Keyed by question id so the page never has to search an array.
      my_answers: Object.fromEntries(mine.map(r => [r.question_id, r])),
      my_progress: prog[0] || null,
      // The page prints "you are answering as …" above the first question. It
      // is the honesty requirement, and it comes from the token so it cannot
      // disagree with what is actually stored against the answers.
      me: { id: req.user.id, name: req.user.name || null },
      is_manager: isManager(req),
    });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    console.error('[consultation] GET / failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /progress — where I got to ──────────────────────────────────────────
router.put('/progress', async (req, res) => {
  const db = getPool();
  const { last_chapter_key, chapters_read } = req.body || {};
  const read = Array.isArray(chapters_read)
    ? [...new Set(chapters_read.filter(k => typeof k === 'string' && k.length <= 60))].slice(0, 200)
    : null;
  const chapter = (typeof last_chapter_key === 'string' && last_chapter_key.length <= 60)
    ? last_chapter_key : null;
  try {
    const c = await loadConsultation(db);
    if (!c) return res.status(404).json({ error: 'not_found' });
    // COALESCE on the excluded value: a call that sends only a position must not
    // wipe the read set, and vice versa.
    const { rows } = await db.query(
      `INSERT INTO consultation_progress
         (consultation_id, staff_id, last_chapter_key, chapters_read, updated_at)
       VALUES ($1, $2, $3, COALESCE($4::jsonb, '[]'::jsonb), now())
       ON CONFLICT (consultation_id, staff_id) DO UPDATE
         SET last_chapter_key = COALESCE(EXCLUDED.last_chapter_key, consultation_progress.last_chapter_key),
             chapters_read    = COALESCE($4::jsonb, consultation_progress.chapters_read),
             updated_at       = now()
       RETURNING last_chapter_key, chapters_read, started_at, opened_at, submitted_at, printed_at`,
      [c.id, req.user.id, chapter, read ? JSON.stringify(read) : null]);
    res.json({ ok: true, progress: rows[0] });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    console.error('[consultation] PUT /progress failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── PUT /answer — one question, upserted ────────────────────────────────────
router.put('/answer', async (req, res) => {
  const db = getPool();
  const questionId = parseInt(req.body && req.body.question_id, 10);
  if (!Number.isFinite(questionId)) return res.status(400).json({ error: 'question_id required' });

  // Empty string means "I cleared the box", which is different from "I did not
  // send the field" (leave it alone). null is the stored form of cleared.
  const hasChoice = Object.prototype.hasOwnProperty.call(req.body, 'choice');
  const hasText   = Object.prototype.hasOwnProperty.call(req.body, 'free_text');
  const choice    = hasChoice ? (req.body.choice ? String(req.body.choice).slice(0, 40) : null) : undefined;
  const freeText  = hasText   ? (req.body.free_text ? String(req.body.free_text).slice(0, 4000) : null) : undefined;
  if (choice === undefined && freeText === undefined) {
    return res.status(400).json({ error: 'nothing to save' });
  }

  try {
    const c = await loadConsultation(db);
    if (!c) return res.status(404).json({ error: 'not_found' });
    if (c.status === 'closed') {
      return res.status(409).json({ error: 'closed', message: 'This consultation has closed.' });
    }

    const { rows: q } = await db.query(
      `SELECT id, kind, options FROM consultation_questions
        WHERE id = $1 AND consultation_id = $2`, [questionId, c.id]);
    if (!q.length) return res.status(404).json({ error: 'no such question' });

    // A choice must be one of the offered keys. Rejecting an unknown key is
    // what keeps the per-question split in the Roost view countable.
    if (choice) {
      const keys = (q[0].options || []).map(o => o && o.key);
      if (!keys.includes(choice)) {
        return res.status(400).json({ error: 'invalid choice', allowed: keys });
      }
    }

    const { rows } = await db.query(
      `INSERT INTO consultation_responses
         (consultation_id, question_id, staff_id, choice, free_text, answered_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (question_id, staff_id) DO UPDATE
         SET choice      = CASE WHEN $6 THEN EXCLUDED.choice    ELSE consultation_responses.choice END,
             free_text   = CASE WHEN $7 THEN EXCLUDED.free_text ELSE consultation_responses.free_text END,
             answered_at = now()
       RETURNING question_id, choice, free_text, answered_at`,
      [c.id, questionId, req.user.id,
       choice === undefined ? null : choice,
       freeText === undefined ? null : freeText,
       choice !== undefined, freeText !== undefined]);

    // Answering is also starting: somebody who taps A on chapter 1 and never
    // touches the position endpoint must still count as started.
    await db.query(
      `INSERT INTO consultation_progress (consultation_id, staff_id, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (consultation_id, staff_id) DO UPDATE SET updated_at = now()`,
      [c.id, req.user.id]);

    res.json({ ok: true, answer: rows[0] });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    console.error('[consultation] PUT /answer failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /submit — "I'm done", idempotent ───────────────────────────────────
router.post('/submit', async (req, res) => {
  const db = getPool();
  try {
    const c = await loadConsultation(db);
    if (!c) return res.status(404).json({ error: 'not_found' });
    const { rows } = await db.query(
      `INSERT INTO consultation_progress (consultation_id, staff_id, submitted_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (consultation_id, staff_id) DO UPDATE
         SET submitted_at = COALESCE(consultation_progress.submitted_at, now()),
             updated_at   = now()
       RETURNING submitted_at`,
      [c.id, req.user.id]);
    const { rows: n } = await db.query(
      `SELECT count(*)::int AS answered FROM consultation_responses
        WHERE consultation_id = $1 AND staff_id = $2
          AND (choice IS NOT NULL OR nullif(btrim(free_text),'') IS NOT NULL)`,
      [c.id, req.user.id]);
    res.json({ ok: true, submitted_at: rows[0].submitted_at, answered: n[0].answered });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    console.error('[consultation] POST /submit failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /printed — somebody took paper ─────────────────────────────────────
// Recorded because "nobody engaged" and "four people printed it and wrote on
// paper" are different problems, and without this the second one is invisible.
router.post('/printed', async (req, res) => {
  const db = getPool();
  try {
    const c = await loadConsultation(db);
    if (!c) return res.status(404).json({ error: 'not_found' });
    await db.query(
      `INSERT INTO consultation_progress (consultation_id, staff_id, printed_at, updated_at)
       VALUES ($1, $2, now(), now())
       ON CONFLICT (consultation_id, staff_id) DO UPDATE
         SET printed_at = now(), updated_at = now()`,
      [c.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /facts — the numbers chapter 14 quotes, computed rather than typed ──
// The handbook states "177 statements, 0 with a characteristic of effective
// learning". A number typed into a booklet is true on the day it is typed. This
// endpoint recomputes it, so the page can show the live figure next to the
// written one and a practitioner is never told something the database disagrees
// with. AGGREGATES ONLY — counts, never a row about a child.
router.get('/facts', async (req, res) => {
  const db = getPool();
  const out = { fledge: null, plans: null, areas: [], generated_at: new Date().toISOString() };
  // fledge-off (2026-10-26): while Fledge is off the handbook must not count it —
  // out.fledge stays null and the page leaves that row out.
  const _fledgeOn = await require('../lib/fledge-switch').isFledgeEnabled(db);
  if (_fledgeOn) try {
    const { rows: f } = await db.query(
      `SELECT count(*)::int AS statements,
              count(coalesce(coel_characteristic,''))
                FILTER (WHERE nullif(btrim(coalesce(coel_characteristic,'')),'') IS NOT NULL)::int AS with_coel,
              count(DISTINCT area)::int      AS areas,
              count(DISTINCT age_range)::int AS bands
         FROM framework_statements WHERE framework = 'fledge'`);
    out.fledge = f[0] || null;
  } catch (e) { if (schemaMissing(e)) return notApplied(res); }

  try {
    const { rows: p } = await db.query(
      `SELECT count(*)::int AS plans,
              count(*) FILTER (WHERE theme IS NOT NULL)::int AS with_theme,
              count(*) FILTER (WHERE coalesce(array_length(learning_intentions,1),0) > 0)::int AS with_intentions,
              count(*) FILTER (WHERE coalesce(array_length(key_books,1),0) > 0)::int AS with_books,
              count(*) FILTER (WHERE status = 'published')::int AS published
         FROM term_plans
        WHERE academic_year = (SELECT max(academic_year) FROM term_plans)`);
    out.plans = p[0] || null;
  } catch (_) { /* a fact that cannot be computed is omitted, not faked */ }

  try {
    // Which areas of learning we actually wrote observations against. Counts
    // only — no child, no author, no text. The report's own recommendation:
    // "people engage with their own practice in a way they never engage with a
    // framework."
    const { rows: a } = await db.query(
      `SELECT unnest(eyfs_areas) AS area, count(*)::int AS n
         FROM observations
        WHERE created_at >= now() - interval '180 days'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 12`);
    out.areas = a;
  } catch (_) { out.areas = []; }

  res.json(out);
});

// ── GET /my-practice — b332: YOUR numbers, and nobody else's ────────────────
// Report §6: "show them their own numbers — which areas they actually wrote
// observations against last term, which intentions went untouched — because
// people engage with their own practice in a way they never engage with a
// framework."
//
// THE PRIVACY SHAPE, because it is the whole design:
//   · there is no staff_id parameter. It reads req.user.id and nothing else, so
//     there is no version of this URL that returns somebody else's practice —
//     not for a practitioner, and not for a manager either.
//   · it is COUNTS. Areas and totals. No child, no name, no observation text,
//     no title, not even an id.
//   · it is computed live at request time and stored nowhere, so answering the
//     question does not file a report on how much anybody wrote.
//
// "Last term" is the most recent half-term that has ENDED. Mid-September that
// is the summer, and a quiet summer is a true answer rather than a flattering
// one; where the calendar cannot say, the payload names the window it used.
router.get('/my-practice', async (req, res) => {
  const db = getPool();
  const CAL = require('../lib/school-calendar');
  const me = Number(req.user.id);
  try {
    const today = CAL.todayYmd();
    let term = null;
    try {
      const cal = await CAL.loadCalendar(db, null);
      const ended = (cal.terms || []).filter(t => String(t.end_date).slice(0, 10) < today);
      ended.sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)));
      term = ended.length ? ended[ended.length - 1] : null;
    } catch (_) { /* fall through to the rolling window */ }

    const from = term ? String(term.start_date).slice(0, 10)
                      : new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
    const to = term ? String(term.end_date).slice(0, 10) : today;
    const label = term ? term.name : 'the last four months';

    const [mine, areas, mineTagged] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS observations, count(DISTINCT child_id)::int AS children
           FROM observations
          WHERE staff_id = $1 AND created_at >= $2::date AND created_at < ($3::date + 1)`,
        [me, from, to]),
      db.query(
        `SELECT unnest(eyfs_areas) AS area, count(*)::int AS n
           FROM observations
          WHERE staff_id = $1 AND created_at >= $2::date AND created_at < ($3::date + 1)
            AND eyfs_areas IS NOT NULL
          GROUP BY 1 ORDER BY 2 DESC`,
        [me, from, to]),
      db.query(
        `SELECT count(DISTINCT o.id)::int AS n
           FROM observations o
          WHERE o.staff_id = $1 AND o.created_at >= $2::date AND o.created_at < ($3::date + 1)
            AND (coalesce(array_length(o.linked_framework_ids, 1), 0) > 0
                 OR EXISTS (SELECT 1 FROM observation_statements os WHERE os.observation_id = o.id))`,
        [me, from, to]),
    ]);

    // The areas of the setting's framework, so an area you wrote NOTHING against
    // still appears — with a nought against it. An area missing from a list
    // reads as "no data"; a nought reads as a fact, and the noughts are the
    // interesting half.
    let allAreas = [];
    try {
      const { rows: fw } = await db.query(
        `SELECT value FROM settings WHERE key = 'default_framework' LIMIT 1`);
      // fledge-off (2026-10-26): was `|| 'fledge'`. The switch now decides — no row, or a
      // row still saying 'fledge' while Fledge is off, both read as Birth to 5 Matters.
      void fw;
      const framework = await require('../lib/fledge-switch').effectiveDefaultFramework(db);
      const { rows } = await db.query(
        `SELECT DISTINCT area FROM framework_statements WHERE framework = $1 AND is_active ORDER BY area`,
        [framework]);
      allAreas = rows.map(r => r.area);
    } catch (_) { /* older schema: show only what they wrote */ }

    const norm = a => String(a || '').toLowerCase()
      .replace(/&/g, 'and').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
    const normed = new Map();
    for (const r of areas.rows) normed.set(norm(r.area), (normed.get(norm(r.area)) || 0) + r.n);

    const list = (allAreas.length ? allAreas : areas.rows.map(r => r.area))
      .map(a => ({ area: a, n: normed.get(norm(a)) || 0 }));
    // Anything written against an area the framework does not have (an older
    // area name, an import) is kept rather than silently dropped.
    for (const r of areas.rows) {
      if (!list.some(x => norm(x.area) === norm(r.area))) list.push({ area: r.area, n: r.n });
    }
    list.sort((a, b) => b.n - a.n || String(a.area).localeCompare(String(b.area)));

    res.json({
      window: { from, to, label },
      me: { id: me, name: req.user.name || null },
      observations: mine.rows[0].observations,
      children: mine.rows[0].children,
      tagged: mineTagged.rows[0].n,
      areas: list,
      untouched_areas: list.filter(a => a.n === 0).map(a => a.area),
      note: 'Your own observations only. Counts, not records — no child is named here, and nobody else can see this.',
    });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    console.error('[consultation] GET /my-practice failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── GET /summary — MANAGER: who, what, and who has not started ──────────────
router.get('/summary', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const c = await loadConsultation(db);
    if (!c) return res.status(404).json({ error: 'not_found' });

    const { rows: audience }  = await db.query(AUDIENCE_SQL);
    const { rows: questions } = await db.query(
      `SELECT id, chapter_key, sort_order, prompt, kind, options, free_text_label
         FROM consultation_questions WHERE consultation_id = $1 ORDER BY sort_order, id`,
      [c.id]);
    const { rows: progress }  = await db.query(
      `SELECT staff_id, last_chapter_key, chapters_read, started_at, opened_at, updated_at,
              submitted_at, printed_at, nudge_count, last_nudged_at
         FROM consultation_progress WHERE consultation_id = $1`, [c.id]);
    const { rows: answers }   = await db.query(
      `SELECT r.question_id, r.staff_id, r.choice, r.free_text, r.answered_at,
              s.first_name, s.last_name, s.role
         FROM consultation_responses r JOIN staff s ON s.id = r.staff_id
        WHERE r.consultation_id = $1
        ORDER BY r.question_id, r.answered_at`, [c.id]);

    const progById = new Map(progress.map(p => [p.staff_id, p]));
    const answeredBy = new Map();   // staff_id -> count of real answers
    for (const a of answers) {
      const real = a.choice != null || (a.free_text && a.free_text.trim());
      if (!real) continue;
      answeredBy.set(a.staff_id, (answeredBy.get(a.staff_id) || 0) + 1);
    }

    // Per person: not started / started / submitted, and how far in.
    const people = audience.map(s => {
      const p = progById.get(s.id) || null;
      const answered = answeredBy.get(s.id) || 0;
      // The four states, in the order they can only be reached:
      //   submitted    they pressed the button
      //   in_progress  they answered something, or marked a chapter read
      //   opened       they LOADED the booklet and did nothing — opened_at, not
      //                "a row exists". A nudge creates a row; it must not make
      //                somebody look like they had a look and walked away.
      //   not_started  never opened it. The row this screen is really for.
      let state = 'not_started';
      if (p && p.submitted_at) state = 'submitted';
      else if (answered > 0 || (p && Array.isArray(p.chapters_read) && p.chapters_read.length)) state = 'in_progress';
      else if (p && p.opened_at) state = 'opened';
      return {
        staff_id: s.id,
        name: `${s.first_name || ''} ${s.last_name || ''}`.trim(),
        role: s.role,
        state,
        answered,
        of: questions.length,
        chapters_read: p && Array.isArray(p.chapters_read) ? p.chapters_read.length : 0,
        last_chapter_key: p ? p.last_chapter_key : null,
        opened_at: p ? p.opened_at : null,
        last_seen_at: p ? p.updated_at : null,
        submitted_at: p ? p.submitted_at : null,
        printed_at: p ? p.printed_at : null,
        nudge_count: p ? p.nudge_count : 0,
        last_nudged_at: p ? p.last_nudged_at : null,
      };
    });

    // Per question: the split, and every free-text answer with a name on it.
    const byQuestion = questions.map(q => {
      const mine = answers.filter(a => a.question_id === q.id);
      const counts = {};
      for (const o of (q.options || [])) counts[o.key] = 0;
      for (const a of mine) if (a.choice && Object.prototype.hasOwnProperty.call(counts, a.choice)) counts[a.choice]++;
      const total = Object.values(counts).reduce((x, y) => x + y, 0);
      return {
        ...q,
        counts,
        total_choices: total,
        // A split of nothing is not a 50/50, so the percentage is null rather
        // than 0 when nobody has answered — the screen renders "no answers yet".
        split: Object.fromEntries(Object.entries(counts).map(
          ([k, n]) => [k, total ? Math.round((n / total) * 100) : null])),
        free_text: mine
          .filter(a => a.free_text && a.free_text.trim())
          .map(a => ({
            staff_id: a.staff_id,
            name: `${a.first_name || ''} ${a.last_name || ''}`.trim(),
            role: a.role,
            text: a.free_text,
            at: a.answered_at,
            // What they chose, alongside what they wrote — a comment reads
            // completely differently depending on which side it is defending.
            choice: a.choice,
          })),
      };
    });

    // The cap, so the Roost view can say "nobody can be nudged more than N
    // times" with the real number rather than a hard-coded word.
    let nudgeCap = 2;
    try {
      const { rows } = await db.query("SELECT value FROM settings WHERE key='consultation_max_nudges'");
      if (rows.length) nudgeCap = Math.max(0, Math.min(10, parseInt(rows[0].value, 10) || 0));
    } catch (_) { /* keep the default */ }

    res.json({
      consultation: c,
      nudge_cap: nudgeCap,
      totals: {
        audience: people.length,
        submitted:   people.filter(p => p.state === 'submitted').length,
        in_progress: people.filter(p => p.state === 'in_progress').length,
        opened:      people.filter(p => p.state === 'opened').length,
        not_started: people.filter(p => p.state === 'not_started').length,
        printed:     people.filter(p => p.printed_at).length,
        free_text_answers: byQuestion.reduce((n, q) => n + q.free_text.length, 0),
      },
      people,
      questions: byQuestion,
    });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    console.error('[consultation] GET /summary failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ── POST /nudge — MANAGER: in-app only, and never to somebody who is done ───
// The brief: "An in-app nudge to non-starters. Never email." Two guards, in the
// SQL rather than in the caller, because a guard in the caller is a guard
// somebody removes:
//
//   submitted_at IS NULL   — somebody who has submitted is never nudged again.
//   nudge_count  < cap     — the cap is a setting (consultation_max_nudges),
//                            default 2, and 0 switches nudging off entirely.
//
// The body carries a COUNT and nothing else. No opinion, no question text, no
// other person's name — staff opinions never appear in a notification body.
router.post('/nudge', managerOnly, async (req, res) => {
  const db = getPool();
  const onlyIds = Array.isArray(req.body && req.body.staff_ids)
    ? req.body.staff_ids.map(Number).filter(Number.isFinite) : null;
  try {
    const c = await loadConsultation(db);
    if (!c) return res.status(404).json({ error: 'not_found' });
    if (c.status !== 'open') {
      return res.status(409).json({ error: 'not_open', message: 'Only an open consultation can be nudged.' });
    }

    let cap = 2;
    try {
      const { rows } = await db.query("SELECT value FROM settings WHERE key='consultation_max_nudges'");
      if (rows.length) cap = Math.max(0, Math.min(10, parseInt(rows[0].value, 10) || 0));
    } catch (_) { /* keep the default */ }
    if (cap === 0) return res.json({ ok: true, nudged: [], skipped: [], reason: 'nudging is switched off' });

    const { rows: candidates } = await db.query(
      `SELECT s.id, s.first_name,
              coalesce(p.nudge_count, 0)   AS nudge_count,
              p.submitted_at,
              (SELECT count(*)::int FROM consultation_responses r
                WHERE r.consultation_id = $1 AND r.staff_id = s.id
                  AND (r.choice IS NOT NULL OR nullif(btrim(r.free_text),'') IS NOT NULL)) AS answered
         FROM staff s
         LEFT JOIN consultation_progress p
                ON p.consultation_id = $1 AND p.staff_id = s.id
        WHERE s.is_active = true
          AND s.id <> $2
          AND p.submitted_at IS NULL
          AND coalesce(p.nudge_count, 0) < $3
        ORDER BY s.id`,
      [c.id, req.user.id, cap]);

    const { rows: qn } = await db.query(
      'SELECT count(*)::int AS n FROM consultation_questions WHERE consultation_id = $1', [c.id]);
    const totalQuestions = qn[0].n;

    const targets = onlyIds ? candidates.filter(r => onlyIds.includes(Number(r.id))) : candidates;
    const nudged = [];
    for (const t of targets) {
      const left = Math.max(0, totalQuestions - Number(t.answered || 0));
      const body = Number(t.answered) === 0
        ? `The handbook is on the EY portal under More. Eighteen short chapters, one question each — the first one takes about two minutes.`
        : `You have answered ${t.answered} of ${totalQuestions}. ${left} left, and it picks up where you stopped.`;
      // In-app only, and that is a property of the CATEGORY rather than of this
      // call — notify() takes its channels from the recipient's preference row
      // and ignores anything passed here, so asking for ['inapp'] in the
      // options would look like a control and be none. What actually holds it:
      //   • 'consultation_nudge' is registered non-urgent in
      //     src/services/notification-categories.js, so every generated role
      //     preset gives it ['inapp'] — never telegram.
      //   • a person with no preference row for it defaults to ['inapp'].
      //   • the email allowlist in the dispatcher fails CLOSED and this
      //     category is on neither list, so email is refused outright.
      notify('consultation_nudge', 'staff', t.id, 'The Wren Handbook', body, {
        link: '/ey/handbook',
      });
      await db.query(
        `INSERT INTO consultation_progress (consultation_id, staff_id, nudge_count, last_nudged_at, updated_at)
         VALUES ($1, $2, 1, now(), now())
         ON CONFLICT (consultation_id, staff_id) DO UPDATE
           SET nudge_count = consultation_progress.nudge_count + 1,
               last_nudged_at = now(), updated_at = now()`,
        [c.id, t.id]);
      nudged.push({ staff_id: t.id, answered: Number(t.answered), left });
    }

    recordAudit({
      req, action: 'create', entity_type: 'consultation', entity_id: c.id,
      // Ids, never names, never anybody's answers.
      meta: { change: 'consultation_nudge_sent', staff_ids: nudged.map(n => n.staff_id), cap },
    });

    res.json({
      ok: true, nudged,
      cap,
      // Named so the screen can say WHY somebody was not nudged rather than
      // silently showing a smaller number than the manager expected.
      note: 'Anyone who has submitted, or who has already had the maximum number of nudges, is not included. Nothing is emailed.',
    });
  } catch (e) {
    if (schemaMissing(e)) return notApplied(res);
    console.error('[consultation] POST /nudge failed:', e.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
