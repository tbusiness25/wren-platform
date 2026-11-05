'use strict';
/* ===========================================================================
 * kids-games.js (route) — b507, 2026-10-18
 *
 * Wren Kids is a public, no-login PWA of free learning games (public/kids/,
 * published to getwren.co.uk/kids). AT HOME IT TALKS TO NOTHING: progress lives
 * in the browser's own storage and no request is ever made. This router exists
 * only for the OTHER mode — a member of staff on the EY portal picks a child on
 * /ey/kids-games, hands the tablet over, and the round the child plays is
 * recorded against that child's learning record.
 *
 *   GET  /games                 the catalogue (slug, title, stage, curriculum)
 *   POST /sessions              record one finished round   (staff, on-site)
 *   GET  /child/:id/summary     the child-profile card: totals + by EYFS area
 *   GET  /child/:id/sessions    the recent rounds, newest first
 *   GET  /child/:id/observation-draft  the suggested text for an observation
 *
 * WHO MAY USE IT
 *   Any signed-in member of staff (not parents — refused at the top, like
 *   key-children.js). 'kids-games' is on server-unified.js's _ONSITE_CHILD_DATA
 *   and OFFSITE_CHILD lists and is deliberately NOT on HR_ALLOW, because a row
 *   here names a child.
 *
 * WHAT IT NEVER DOES
 *   It never creates an observation. The EY "make an observation note" button
 *   opens /ey/observation/new with text pre-filled; a practitioner reads
 *   it, edits it and saves it. Wren does not write a child's learning record on
 *   its own (b507 brief: "Never auto-create an observation").
 *
 * CURRICULUM LINKING
 *   A game declares framework statement CODES (e.g. 'MAT-B4-2'), never ids,
 *   because ids differ between wren, wren_dev and every other setting's schema.
 *   This router resolves codes to ladn.framework_statements.id at write time and
 *   stores BOTH, so the card can group by area even if a framework is re-seeded.
 *
 * TABLE: ladn.kids_game_sessions — migrations/2026-10-18-b507-kids-games.sql
 * =========================================================================== */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const MAX_DURATION_SECS = 60 * 60;     // an hour is already absurd for one round

router.use(authenticate);
router.use((req, res, next) => {
  if (req._portal === 'parents' || (req.user && req.user.role === 'parent')) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
});

function wrap(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch(e => {
    console.error('[kids-games]', req.method, req.path, e.message);
    res.status(e.status || 500).json({ error: e.message });
  });
}

/* ── the catalogue ──────────────────────────────────────────────────────────
 * ONE source: src/content/kids/games.json, which scripts/kids/build-site.py also
 * reads to write the indexable per-game pages. The EY launcher and the child
 * profile card need a game's name and what it practises without loading the game
 * code, so the catalogue is served from here. Codes are fledge statement codes;
 * nc is the national-curriculum reference for the KS1/KS2 games, which have no
 * framework table to point at. */
const CATALOGUE = require('../content/kids/games.json');
const GAMES = CATALOGUE.games.map(g => ({
  slug: g.slug, title: g.title, emoji: g.emoji, stage: g.stage, ages: g.ages,
  area: g.area, subject: g.subject, codes: g.codes || [], elgs: g.elgs || [],
  nc: g.nc || null, plain: g.plain, short: g.short
}));
const BY_SLUG = Object.create(null);
GAMES.forEach(g => { BY_SLUG[g.slug] = g; });

router.get('/games', (req, res) => res.json({ games: GAMES }));

/* resolve fledge statement codes -> ids in THIS schema. Never fails the write. */
async function resolveStatements(pool, codes) {
  if (!Array.isArray(codes) || !codes.length) return [];
  try {
    const { rows } = await pool.query(
      `SELECT id FROM ${SCHEMA()}.framework_statements
        WHERE statement_code = ANY($1::text[]) AND is_active = true`,
      [codes.map(String).slice(0, 20)]
    );
    return rows.map(r => r.id);
  } catch (e) {
    console.warn('[kids-games] statement lookup failed:', e.message);
    return [];
  }
}

/* ── POST /sessions — one finished round ─────────────────────────────────── */
router.post('/sessions', wrap(async (req, res) => {
  const pool = getPool();
  const b = req.body || {};
  const childId = parseInt(b.child_id, 10);
  const game = BY_SLUG[String(b.game || '')];
  if (!childId || !game) return res.status(400).json({ error: 'child_id and a known game are required' });

  /* the child must exist in THIS setting — a tablet cannot post a stray id */
  const { rows: kid } = await pool.query(
    `SELECT id FROM ${SCHEMA()}.children WHERE id = $1`, [childId]);
  if (!kid.length) return res.status(404).json({ error: 'child_not_found' });

  const level = Math.max(1, Math.min(9, parseInt(b.level, 10) || 1));
  const score = Math.max(0, Math.min(999, parseInt(b.score, 10) || 0));
  const maxScore = Math.max(1, Math.min(999, parseInt(b.max_score, 10) || 1));
  const duration = Math.max(0, Math.min(MAX_DURATION_SECS, parseInt(b.duration_secs, 10) || 0));
  const stars = Math.max(0, Math.min(3, parseInt(b.stars, 10) || 0));
  const codes = Array.isArray(b.statement_codes) ? b.statement_codes.map(String).slice(0, 20) : game.codes;
  const elgs = Array.isArray(b.elg_codes) ? b.elg_codes.map(String).slice(0, 20) : (game.elgs || []);
  /* fledge-off (2026-10-26): the games declare Fledge codes. While Fledge is off no
   * Fledge statement link is written and the session is filed under the setting's
   * framework (Birth to 5) — src/lib/fledge-switch.js is the one switch. The codes
   * themselves stay on the row: they are the game's catalogue entry, not a tag. */
  const FS = require('../lib/fledge-switch');
  const statementIds = await FS.dropFledgeStatementIds(pool, await resolveStatements(pool, codes));
  const sessionFramework = (b.framework && !(FS.isFledgeKey(b.framework) && !(await FS.isFledgeEnabled(pool))))
    ? String(b.framework)
    : await FS.fallbackFramework(pool);
  let startedAt = null;
  if (b.started_at) { const d = new Date(b.started_at); if (!isNaN(d)) startedAt = d.toISOString(); }

  const { rows } = await pool.query(
    `INSERT INTO ${SCHEMA()}.kids_game_sessions
       (child_id, game, game_title, stage, area, level, score, max_score, accuracy,
        duration_secs, stars, framework, statement_codes, statement_ids, elg_codes,
        curriculum_note, staff_id, started_at, ended_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             COALESCE($18::timestamptz, now()), now())
     RETURNING id, created_at`,
    [childId, game.slug, game.title, game.stage, game.area, level, score, maxScore,
     maxScore ? Math.round(1000 * score / maxScore) / 10 : null,
     duration, stars, sessionFramework, codes, statementIds, elgs,
     String(b.curriculum_note || game.plain).slice(0, 400),
     (req.user && req.user.id) || null, startedAt]
  );
  res.status(201).json({ id: rows[0].id, created_at: rows[0].created_at, statements_linked: statementIds.length });
}));

/* ── GET /child/:id/summary — the child-profile card ─────────────────────── */
router.get('/child/:id/summary', wrap(async (req, res) => {
  const pool = getPool();
  const childId = parseInt(req.params.id, 10);
  if (!childId) return res.status(400).json({ error: 'bad child id' });

  const { rows: totals } = await pool.query(
    `SELECT count(*)::int AS rounds,
            COALESCE(sum(duration_secs), 0)::int AS seconds,
            COALESCE(sum(score), 0)::int AS score,
            COALESCE(sum(max_score), 0)::int AS max_score,
            max(created_at) AS last_played,
            count(DISTINCT game)::int AS games
       FROM ${SCHEMA()}.kids_game_sessions WHERE child_id = $1`, [childId]);

  /* by EYFS area, which is how a key person reads a child's week */
  const { rows: areas } = await pool.query(
    `SELECT area,
            count(*)::int AS rounds,
            COALESCE(sum(duration_secs), 0)::int AS seconds,
            COALESCE(sum(score), 0)::int AS score,
            COALESCE(sum(max_score), 0)::int AS max_score
       FROM ${SCHEMA()}.kids_game_sessions
      WHERE child_id = $1 AND area IS NOT NULL
      GROUP BY area ORDER BY rounds DESC`, [childId]);

  const { rows: games } = await pool.query(
    `SELECT game, game_title, stage, count(*)::int AS rounds, max(level)::int AS best_level,
            max(stars)::int AS best_stars, max(created_at) AS last_played,
            COALESCE(sum(score), 0)::int AS score, COALESCE(sum(max_score), 0)::int AS max_score
       FROM ${SCHEMA()}.kids_game_sessions
      WHERE child_id = $1 GROUP BY game, game_title, stage
      ORDER BY max(created_at) DESC`, [childId]);

  const t = totals[0] || {};
  res.json({
    child_id: childId,
    rounds: t.rounds || 0,
    minutes: Math.round((t.seconds || 0) / 60),
    accuracy: t.max_score ? Math.round(100 * t.score / t.max_score) : null,
    games_played: t.games || 0,
    last_played: t.last_played || null,
    areas: areas.map(a => Object.assign({}, a, {
      accuracy: a.max_score ? Math.round(100 * a.score / a.max_score) : null,
      minutes: Math.round(a.seconds / 60)
    })),
    games
  });
}));

/* ── GET /child/:id/sessions — recent rounds ─────────────────────────────── */
router.get('/child/:id/sessions', wrap(async (req, res) => {
  const pool = getPool();
  const childId = parseInt(req.params.id, 10);
  if (!childId) return res.status(400).json({ error: 'bad child id' });
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
  const { rows } = await pool.query(
    `SELECT s.id, s.game, s.game_title, s.stage, s.area, s.level, s.score, s.max_score,
            s.accuracy, s.duration_secs, s.stars, s.curriculum_note, s.created_at,
            NULLIF(TRIM(CONCAT_WS(' ', st.first_name, LEFT(st.last_name, 1))), '') AS staff_name
       FROM ${SCHEMA()}.kids_game_sessions s
       LEFT JOIN ${SCHEMA()}.staff st ON st.id = s.staff_id
      WHERE s.child_id = $1
      ORDER BY s.created_at DESC LIMIT $2`, [childId, limit]);
  res.json({ sessions: rows });
}));

/* ── GET /child/:id/observation-draft — text only, never a saved observation ─ */
router.get('/child/:id/observation-draft', wrap(async (req, res) => {
  const pool = getPool();
  const childId = parseInt(req.params.id, 10);
  if (!childId) return res.status(400).json({ error: 'bad child id' });
  const sessionId = parseInt(req.query.session, 10) || null;

  const { rows } = await pool.query(
    `SELECT s.*, c.first_name
       FROM ${SCHEMA()}.kids_game_sessions s
       JOIN ${SCHEMA()}.children c ON c.id = s.child_id
      WHERE s.child_id = $1 ${sessionId ? 'AND s.id = $2' : ''}
      ORDER BY s.created_at DESC LIMIT 1`,
    sessionId ? [childId, sessionId] : [childId]);
  if (!rows.length) return res.status(404).json({ error: 'no_sessions' });

  const s = rows[0];
  const name = s.first_name || 'They';
  const text =
    `${name} played ${s.game_title} on the tablet and got ${s.score} out of ${s.max_score} right ` +
    `at level ${s.level}. ${s.curriculum_note}\n\n` +
    `What I saw: `;
  res.json({
    session_id: s.id,
    text,
    statement_ids: s.statement_ids || [],
    note: 'A draft only. Read it, edit it and save it yourself — Wren does not write observations.'
  });
}));

module.exports = router;
