'use strict';
/**
 * knowledge.js — b188 (2026-08-19). Mounted at /api/knowledge.
 *
 * Staff knowledge pop-quizzes: one short multiple-choice question served to a
 * practitioner at most once per shift on the EY tablet, so that across a term
 * they refresh safeguarding, first aid, curriculum and SEN — and so that
 * "is knowledge actually improving?" becomes a question with a real answer.
 *
 *   GET  /api/knowledge/topics    the four pop-quiz topics
 *   GET  /api/knowledge/next      the next question for me (or why there isn't one)
 *   POST /api/knowledge/answer    { question_id, chosen_index, ms_taken }
 *   POST /api/knowledge/dismiss   { question_id } — "not now", re-offers later today
 *   GET  /api/knowledge/focus     my chosen focus topic for this term
 *   PUT  /api/knowledge/focus     { topic } — set it
 *   GET  /api/knowledge/me        my history: per-topic %, trend, weakest, streak
 *   GET  /api/knowledge/overview  MANAGER — per-topic/per-staff accuracy,
 *                                 most-missed questions, who has answered nothing
 *
 * ── Where the data lives ────────────────────────────────────────────────────
 * The question bank is ladn.reflection_quiz_bank (b163), exposed through the
 * ladn.knowledge_questions view with b188's column names. It is NOT a second
 * bank — see scripts/migrations/2026-08-19-b188-knowledge-quizzes.sql for why
 * that view exists and why course_quiz_questions was the wrong thing to reuse.
 *
 * The longitudinal record is ladn.knowledge_answers — one row per question
 * answered, which is finer-grained than b163's per-attempt reflection_quiz_
 * attempts and is what the trend/most-missed reporting is built on.
 *
 * ── Honesty note ────────────────────────────────────────────────────────────
 * Nothing here is a competence assessment or a disciplinary record. It is a
 * refresher log. /overview says so, and "most-missed questions" is framed as a
 * TRAINING-NEEDS signal about the setting, not a ranking of practitioners.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];
const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, MANAGER_ROLES)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// ── Settings ────────────────────────────────────────────────────────────────
async function setting(db, key, fallback) {
  try {
    const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows.length && rows[0].value != null ? rows[0].value : fallback;
  } catch { return fallback; }
}
async function numSetting(db, key, fallback) {
  const n = parseInt(await setting(db, key, String(fallback)), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * UK academic term containing `d`. Mirrors currentTermKey() in
 * src/routes/reflections.js exactly so b170's termly rotation and b188's termly
 * focus never disagree about which term it is.
 *   Sep–Dec = Autumn (starts 1 Sep) | Jan–Apr = Spring (1 Jan) | May–Aug = Summer (1 May)
 */
function currentTerm(d = new Date()) {
  const m = d.getMonth() + 1, y = d.getFullYear();
  if (m >= 9) return { key: `${y}-Autumn`, start: `${y}-09-01` };
  if (m <= 4) return { key: `${y}-Spring`, start: `${y}-01-01` };
  return { key: `${y}-Summer`, start: `${y}-05-01` };
}

// The four pop-quiz topics, in registry order.
async function popTopics(db) {
  const { rows } = await db.query(`
    SELECT id, topic_key, pop_slug AS slug, label AS name, description, active
    FROM knowledge_topics
    WHERE pop_quiz = true AND active = true AND pop_slug IS NOT NULL
    ORDER BY sort_order`);
  return rows;
}

// GET /api/knowledge/topics
router.get('/topics', async (req, res) => {
  try { res.json({ topics: await popTopics(getPool()) }); }
  catch (err) {
    console.error('knowledge/topics error:', err.message);
    res.status(500).json({ error: 'Failed to load topics' });
  }
});

// ── The practitioner's focus topic for the current term ─────────────────────
async function myFocus(db, staffId, term) {
  const { rows } = await db.query(`
    SELECT f.topic_id, f.topic_key, kt.pop_slug AS slug, kt.label AS name, f.chosen_at
    FROM knowledge_focus f
    JOIN knowledge_topics kt ON kt.id = f.topic_id
    WHERE f.staff_id = $1 AND f.term_start = $2::date`, [staffId, term.start]);
  return rows[0] || null;
}

// GET /api/knowledge/focus
router.get('/focus', async (req, res) => {
  const db = getPool();
  try {
    const term = currentTerm();
    const focus = await myFocus(db, req.user.id, term);
    res.json({
      term_key: term.key, term_start: term.start,
      focus,
      needs_choice: !focus,          // drives the "pick your focus" prompt at term start
      topics: await popTopics(db),
    });
  } catch (err) {
    console.error('knowledge/focus GET error:', err.message);
    res.status(500).json({ error: 'Failed to load focus' });
  }
});

// PUT /api/knowledge/focus { topic }  — accepts the pop_slug or the topic_key
router.put('/focus', async (req, res) => {
  const db = getPool();
  const wanted = String(req.body?.topic || '').trim();
  if (!wanted) return res.status(400).json({ error: 'topic is required' });
  try {
    const topics = await popTopics(db);
    const t = topics.find(x => x.slug === wanted || x.topic_key === wanted);
    if (!t) return res.status(400).json({ error: 'Unknown topic', valid: topics.map(x => x.slug) });

    const term = currentTerm();
    await db.query(`
      INSERT INTO knowledge_focus (staff_id, term_start, topic_id, topic_key)
      VALUES ($1, $2::date, $3, $4)
      ON CONFLICT (staff_id, term_start)
      DO UPDATE SET topic_id = EXCLUDED.topic_id, topic_key = EXCLUDED.topic_key, chosen_at = now()`,
      [req.user.id, term.start, t.id, t.topic_key]);

    res.json({ ok: true, term_key: term.key, term_start: term.start, focus: await myFocus(db, req.user.id, term) });
  } catch (err) {
    console.error('knowledge/focus PUT error:', err.message);
    res.status(500).json({ error: 'Failed to save focus' });
  }
});

/* ════════════════════════════ QUESTION SELECTION ═══════════════════════════
 * Weighted random over every eligible question, so two practitioners standing
 * next to each other do not get the same question. Weight = product of:
 *
 *   focus      ×focus_weight (default 3)  if the topic is their termly focus
 *   wrong      ×2.5                       if they got THIS question wrong last time
 *              ×1.6                       if they have never answered it
 *   staleness  ×1 .. ×2.5                 the longer since they last answered
 *                                          ANYTHING in that topic, the higher
 *
 * Hard exclusion: anything answered within knowledge_repeat_days (default 14).
 * That is the brief's "never repeat a question within 14 days" and it is
 * enforced in SQL, not in the weighting, so it cannot be probabilistically
 * violated.
 */
async function pickQuestion(db, staffId) {
  const repeatDays  = await numSetting(db, 'knowledge_repeat_days', 14);
  const focusWeight = await numSetting(db, 'knowledge_focus_weight', 3);
  const term  = currentTerm();
  const focus = await myFocus(db, staffId, term);

  const { rows } = await db.query(`
    WITH mine AS (
      SELECT question_id,
             max(answered_at)                                          AS last_at,
             (array_agg(correct ORDER BY answered_at DESC))[1]          AS last_correct
      FROM knowledge_answers WHERE staff_id = $1 GROUP BY question_id
    ),
    topic_recency AS (
      SELECT topic_key, max(answered_at) AS last_at
      FROM knowledge_answers WHERE staff_id = $1 GROUP BY topic_key
    )
    SELECT q.id, q.topic_id, q.topic_key, q.topic_slug, q.quiz_key, q.question,
           q.options, q.difficulty, kt.label AS topic_name,
           m.last_correct,
           (m.question_id IS NULL)                                      AS never_seen,
           EXTRACT(EPOCH FROM (now() - tr.last_at)) / 86400             AS topic_days_since
    FROM knowledge_questions q
    JOIN knowledge_topics kt   ON kt.id = q.topic_id
    LEFT JOIN mine m           ON m.question_id = q.id
    LEFT JOIN topic_recency tr ON tr.topic_key = q.topic_key
    WHERE q.active = true AND kt.pop_quiz = true AND kt.active = true
      AND (m.last_at IS NULL OR m.last_at < now() - ($2 || ' days')::interval)
  `, [staffId, repeatDays]);

  if (!rows.length) return { question: null, reason: 'no_eligible_questions', focus, term };

  const weighted = rows.map(r => {
    let w = 1;
    if (focus && r.topic_id === focus.topic_id) w *= Math.max(1, focusWeight);
    if (r.never_seen) w *= 1.6;
    else if (r.last_correct === false) w *= 2.5;                 // spaced repetition
    const days = r.topic_days_since == null ? 60 : Number(r.topic_days_since);
    w *= 1 + Math.min(days, 45) / 30;                            // 1.0 .. 2.5
    return { row: r, w };
  });

  const total = weighted.reduce((s, x) => s + x.w, 0);
  let t = Math.random() * total;
  let chosen = weighted[weighted.length - 1].row;
  for (const x of weighted) { t -= x.w; if (t <= 0) { chosen = x.row; break; } }

  return { question: chosen, reason: null, focus, term, pool_size: rows.length };
}

/**
 * GET /api/knowledge/next
 *
 * Returns at most one question. "Once per shift" is implemented as once per
 * CALENDAR DAY in Europe/London — the setting runs a single 8am–6pm session, so
 * a day is a shift. If split shifts are ever introduced this is the one place
 * that needs revisiting.
 *
 * Always 200 with question:null and a machine-readable `reason` rather than an
 * error status — the shell polls this on every page load and must never see a
 * failure it would log as a bug.
 */
router.get('/next', async (req, res) => {
  const db = getPool();
  try {
    if ((await setting(db, 'knowledge_popup_enabled', 'on')) !== 'on') {
      return res.json({ question: null, reason: 'disabled' });
    }

    const perShift = await numSetting(db, 'knowledge_popup_per_shift', 1);
    const { rows: [todayRow] } = await db.query(`
      SELECT count(*)::int AS n FROM knowledge_answers
      WHERE staff_id = $1 AND source = 'popup'
        AND (answered_at AT TIME ZONE 'Europe/London')::date
            = (now() AT TIME ZONE 'Europe/London')::date`, [req.user.id]);
    if (todayRow.n >= perShift) {
      return res.json({ question: null, reason: 'done_this_shift', answered_today: todayRow.n });
    }

    // A dismissal is a cooldown, not an opt-out — it re-offers later the same day.
    const cooldown = await numSetting(db, 'knowledge_dismiss_minutes', 90);
    const { rows: [dis] } = await db.query(`
      SELECT max(dismissed_at) AS last FROM knowledge_dismissals
      WHERE staff_id = $1
        AND dismissed_at > now() - ($2 || ' minutes')::interval`, [req.user.id, cooldown]);
    if (dis && dis.last) {
      return res.json({
        question: null, reason: 'dismissed_recently',
        retry_after: new Date(new Date(dis.last).getTime() + cooldown * 60000).toISOString(),
      });
    }

    const { question, reason, focus, term } = await pickQuestion(db, req.user.id);
    if (!question) return res.json({ question: null, reason });

    res.json({
      term_key: term.key,
      focus: focus ? { slug: focus.slug, name: focus.name } : null,
      needs_focus_choice: !focus,
      question: {
        id: question.id,
        quiz_key: question.quiz_key,
        topic: question.topic_slug,
        topic_name: question.topic_name,
        question: question.question,
        options: question.options,
        difficulty: question.difficulty,
        // correct_index / explanation / source_ref are deliberately withheld
        // until the answer is posted.
      },
    });
  } catch (err) {
    console.error('knowledge/next error:', err.message);
    res.status(500).json({ error: 'Failed to pick a question' });
  }
});

// POST /api/knowledge/answer { question_id, chosen_index, ms_taken }
router.post('/answer', async (req, res) => {
  const db = getPool();
  const qid = parseInt(req.body?.question_id, 10);
  const choice = parseInt(req.body?.chosen_index, 10);
  const msRaw = parseInt(req.body?.ms_taken, 10);
  const ms = Number.isFinite(msRaw) && msRaw >= 0 && msRaw < 3600000 ? msRaw : null;
  const source = ['popup', 'focus_picker', 'api'].includes(req.body?.source) ? req.body.source : 'popup';

  if (!Number.isInteger(qid)) return res.status(400).json({ error: 'question_id is required' });
  try {
    const { rows } = await db.query(`
      SELECT q.id, q.topic_key, q.topic_slug, q.options, q.correct_index, q.explanation, q.source_ref,
             kt.label AS topic_name
      FROM knowledge_questions q JOIN knowledge_topics kt ON kt.id = q.topic_id
      WHERE q.id = $1 AND q.active = true`, [qid]);
    const q = rows[0];
    if (!q) return res.status(404).json({ error: 'Unknown question' });

    const nOpts = Array.isArray(q.options) ? q.options.length : 0;
    if (!Number.isInteger(choice) || choice < 0 || choice >= nOpts) {
      return res.status(400).json({ error: 'Invalid chosen_index' });
    }

    const correct = choice === q.correct_index;
    const { rows: [ins] } = await db.query(`
      INSERT INTO knowledge_answers (staff_id, question_id, topic_key, chosen_index, correct, ms_taken, source)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, answered_at`,
      [req.user.id, q.id, q.topic_key, choice, correct, ms, source]);

    // Clear any dismissal cooldown — they have engaged, so the next offer is
    // governed by the per-shift cap alone.
    await db.query('DELETE FROM knowledge_dismissals WHERE staff_id = $1', [req.user.id]);

    res.json({
      ok: true, answer_id: ins.id, answered_at: ins.answered_at,
      correct, correct_index: q.correct_index,
      explanation: q.explanation, source_ref: q.source_ref,
      topic: q.topic_slug, topic_name: q.topic_name,
    });
  } catch (err) {
    console.error('knowledge/answer error:', err.message);
    res.status(500).json({ error: 'Failed to record answer' });
  }
});

// POST /api/knowledge/dismiss { question_id } — "not now"
router.post('/dismiss', async (req, res) => {
  const db = getPool();
  const qid = parseInt(req.body?.question_id, 10);
  try {
    await db.query('INSERT INTO knowledge_dismissals (staff_id, question_id) VALUES ($1,$2)',
      [req.user.id, Number.isInteger(qid) ? qid : null]);
    const cooldown = await numSetting(db, 'knowledge_dismiss_minutes', 90);
    res.json({ ok: true, retry_after_minutes: cooldown });
  } catch (err) {
    console.error('knowledge/dismiss error:', err.message);
    res.status(500).json({ error: 'Failed to record dismissal' });
  }
});

/* ══════════════════════════════ MY HISTORY ═════════════════════════════════ */

// Shared by /me and by the report-engine summary line.
async function staffKnowledge(db, staffId) {
  const topics = await popTopics(db);

  const { rows: perTopic } = await db.query(`
    SELECT topic_key,
           count(*)::int                              AS answered,
           count(*) FILTER (WHERE correct)::int       AS correct,
           max(answered_at)                           AS last_at
    FROM knowledge_answers WHERE staff_id = $1 GROUP BY topic_key`, [staffId]);
  const byTopic = Object.fromEntries(perTopic.map(r => [r.topic_key, r]));

  // Trend: calendar months, oldest first. Twelve points is enough to see a
  // direction without pretending a handful of answers is a statistic.
  const { rows: trend } = await db.query(`
    SELECT to_char(date_trunc('month', answered_at AT TIME ZONE 'Europe/London'), 'YYYY-MM') AS month,
           count(*)::int                        AS answered,
           count(*) FILTER (WHERE correct)::int AS correct
    FROM knowledge_answers
    WHERE staff_id = $1 AND answered_at > now() - interval '12 months'
    GROUP BY 1 ORDER BY 1`, [staffId]);

  // Streak: consecutive correct answers, most recent first.
  const { rows: recent } = await db.query(`
    SELECT correct FROM knowledge_answers
    WHERE staff_id = $1 ORDER BY answered_at DESC LIMIT 100`, [staffId]);
  let streak = 0;
  for (const r of recent) { if (r.correct) streak++; else break; }

  const per_topic = topics.map(t => {
    const r = byTopic[t.topic_key] || { answered: 0, correct: 0, last_at: null };
    return {
      topic: t.slug, topic_key: t.topic_key, name: t.name,
      answered: r.answered, correct: r.correct,
      // No data means no percentage. Never report 0% for "not yet asked".
      pct: r.answered ? Math.round((r.correct / r.answered) * 100) : null,
      last_at: r.last_at,
    };
  });

  const scored = per_topic.filter(t => t.answered >= 3);      // 1–2 answers is noise
  const weakest = scored.length
    ? scored.reduce((a, b) => (b.pct < a.pct ? b : a))
    : null;

  const answered = per_topic.reduce((s, t) => s + t.answered, 0);
  const correct  = per_topic.reduce((s, t) => s + t.correct, 0);

  return {
    answered_total: answered,
    correct_total: correct,
    pct_overall: answered ? Math.round((correct / answered) * 100) : null,
    streak,
    per_topic,
    weakest_topic: weakest ? { topic: weakest.topic, name: weakest.name, pct: weakest.pct } : null,
    weakest_note: scored.length ? null : 'Not enough answers yet to name a weakest topic (needs 3+ in a topic).',
    trend: trend.map(t => ({
      month: t.month, answered: t.answered, correct: t.correct,
      pct: Math.round((t.correct / t.answered) * 100),
    })),
  };
}

/**
 * GET /api/knowledge/me[?staff_id=N]
 * staff_id is honoured for managers only — it is how the Roost staff
 * performance board shows one practitioner's card.
 */
router.get('/me', async (req, res) => {
  const db = getPool();
  try {
    let staffId = req.user.id;
    if (req.query.staff_id) {
      const asked = parseInt(req.query.staff_id, 10);
      if (!Number.isInteger(asked)) return res.status(400).json({ error: 'Invalid staff_id' });
      if (asked !== req.user.id && !hasRole(req.user, MANAGER_ROLES)) {
        return res.status(403).json({ error: 'You can only view your own knowledge history' });
      }
      staffId = asked;
    }
    const term = currentTerm();
    const [data, focus] = await Promise.all([
      staffKnowledge(db, staffId),
      myFocus(db, staffId, term),
    ]);
    res.json({
      staff_id: staffId, term_key: term.key, term_start: term.start,
      focus: focus ? { topic: focus.slug, name: focus.name, chosen_at: focus.chosen_at } : null,
      needs_focus_choice: !focus,
      ...data,
    });
  } catch (err) {
    console.error('knowledge/me error:', err.message);
    res.status(500).json({ error: 'Failed to load knowledge history' });
  }
});

/* ═════════════════════════ MANAGER OVERVIEW ════════════════════════════════ */

/**
 * GET /api/knowledge/overview?days=N
 *
 * most_missed is the point of this endpoint: a question the whole team gets
 * wrong is a gap in TRAINING, not a fault in four individuals. It is returned
 * first and the UI surfaces it first.
 */
router.get('/overview', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const daysRaw = parseInt(req.query.days, 10);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(daysRaw, 1095) : 180;
    const topics = await popTopics(db);

    const [byTopic, byStaff, missed, never, totals] = await Promise.all([
      db.query(`
        SELECT topic_key, count(*)::int AS answered,
               count(*) FILTER (WHERE correct)::int AS correct,
               count(DISTINCT staff_id)::int AS staff_answering
        FROM knowledge_answers
        WHERE answered_at > now() - ($1 || ' days')::interval
        GROUP BY topic_key`, [days]),

      db.query(`
        SELECT s.id AS staff_id, s.first_name, s.last_name,
               s.first_name || ' ' || s.last_name AS name, s.role,
               count(a.id)::int                              AS answered,
               count(a.id) FILTER (WHERE a.correct)::int     AS correct,
               max(a.answered_at)                            AS last_at
        FROM staff s
        LEFT JOIN knowledge_answers a
               ON a.staff_id = s.id AND a.answered_at > now() - ($1 || ' days')::interval
        WHERE s.is_active = true
        GROUP BY s.id, s.first_name, s.last_name, s.role
        ORDER BY s.first_name, s.last_name`, [days]),

      // Most-missed: needs at least 3 attempts before it means anything.
      db.query(`
        SELECT a.question_id, q.question, q.topic_slug, q.source_ref, kt.label AS topic_name,
               count(*)::int                                  AS attempts,
               count(*) FILTER (WHERE NOT a.correct)::int     AS wrong,
               count(DISTINCT a.staff_id)::int                AS staff_attempting
        FROM knowledge_answers a
        JOIN knowledge_questions q ON q.id = a.question_id
        JOIN knowledge_topics kt   ON kt.id = q.topic_id
        WHERE a.answered_at > now() - ($1 || ' days')::interval
        GROUP BY a.question_id, q.question, q.topic_slug, q.source_ref, kt.label
        HAVING count(*) >= 3 AND count(*) FILTER (WHERE NOT a.correct) > 0
        ORDER BY (count(*) FILTER (WHERE NOT a.correct))::numeric / count(*) DESC,
                 count(*) DESC
        LIMIT 10`, [days]),

      // Answered nothing AT ALL — not just nothing in the window.
      db.query(`
        SELECT s.id AS staff_id, s.first_name || ' ' || s.last_name AS name, s.role
        FROM staff s
        WHERE s.is_active = true
          AND NOT EXISTS (SELECT 1 FROM knowledge_answers a WHERE a.staff_id = s.id)
        ORDER BY s.first_name, s.last_name`),

      db.query(`
        SELECT count(*)::int AS answered,
               count(*) FILTER (WHERE correct)::int AS correct,
               count(DISTINCT staff_id)::int AS staff_answering
        FROM knowledge_answers WHERE answered_at > now() - ($1 || ' days')::interval`, [days]),
    ]);

    const topicRows = Object.fromEntries(byTopic.rows.map(r => [r.topic_key, r]));
    const t = totals.rows[0];

    res.json({
      window_days: days,
      generated_at: new Date().toISOString(),
      term_key: currentTerm().key,
      totals: {
        answered: t.answered, correct: t.correct,
        pct: t.answered ? Math.round((t.correct / t.answered) * 100) : null,
        staff_answering: t.staff_answering,
      },

      // Surfaced first: this is the training-needs signal.
      most_missed: missed.rows.map(r => ({
        question_id: r.question_id, question: r.question,
        topic: r.topic_slug, topic_name: r.topic_name,
        attempts: r.attempts, wrong: r.wrong,
        wrong_pct: Math.round((r.wrong / r.attempts) * 100),
        staff_attempting: r.staff_attempting,
        source_ref: r.source_ref,
      })),
      most_missed_note:
        'A question most of the team gets wrong is a gap in training, not four individual failings. ' +
        'Only questions attempted 3+ times in the window are listed.',

      by_topic: topics.map(x => {
        const r = topicRows[x.topic_key] || { answered: 0, correct: 0, staff_answering: 0 };
        return {
          topic: x.slug, topic_key: x.topic_key, name: x.name,
          answered: r.answered, correct: r.correct,
          pct: r.answered ? Math.round((r.correct / r.answered) * 100) : null,
          staff_answering: r.staff_answering,
        };
      }),

      by_staff: byStaff.rows.map(r => ({
        staff_id: r.staff_id, name: r.name, first_name: r.first_name, role: r.role,
        answered: r.answered, correct: r.correct,
        pct: r.answered ? Math.round((r.correct / r.answered) * 100) : null,
        last_at: r.last_at,
      })),

      never_answered: never.rows,
      disclaimer:
        'A refresher log, not a competence assessment. Percentages are only meaningful ' +
        'where a practitioner has answered several questions in a topic.',
    });
  } catch (err) {
    console.error('knowledge/overview error:', err.message);
    res.status(500).json({ error: 'Failed to build knowledge overview' });
  }
});

/**
 * One line for the monthly staff report / manager digest. Exported rather than
 * duplicated so scripts/report-engine-nightly.js says exactly what the API says.
 * Returns null when there is nothing honest to report.
 */
async function summaryLine(db, days = 30) {
  const { rows: [t] } = await db.query(`
    SELECT count(*)::int AS answered,
           count(*) FILTER (WHERE correct)::int AS correct,
           count(DISTINCT staff_id)::int AS staff_answering
    FROM knowledge_answers WHERE answered_at > now() - ($1 || ' days')::interval`, [days]);
  if (!t || !t.answered) {
    return `Knowledge refreshers: no questions answered in the last ${days} days.`;
  }
  const { rows: [active] } = await db.query(
    'SELECT count(*)::int AS n FROM staff WHERE is_active = true');
  const { rows: weak } = await db.query(`
    SELECT kt.label AS name,
           count(*)::int AS answered,
           round(count(*) FILTER (WHERE a.correct)::numeric / count(*) * 100) AS pct
    FROM knowledge_answers a JOIN knowledge_topics kt ON kt.topic_key = a.topic_key
    WHERE a.answered_at > now() - ($1 || ' days')::interval
    GROUP BY kt.label HAVING count(*) >= 5
    ORDER BY 3 ASC LIMIT 1`, [days]);

  const pct = Math.round((t.correct / t.answered) * 100);
  let line = `Knowledge refreshers (${days}d): ${t.answered} answered by ${t.staff_answering}` +
             `/${active.n} staff, ${pct}% correct.`;
  if (weak.length) line += ` Weakest topic: ${weak[0].name} (${weak[0].pct}%).`;
  return line;
}

module.exports = router;
module.exports.staffKnowledge = staffKnowledge;
module.exports.summaryLine = summaryLine;
module.exports.currentTerm = currentTerm;
