const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireCapabilityLevel } = require('../lib/capabilities');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);
// b247: make sure the phonics-switch columns exist in THIS edition's schema before
// any handler runs. Registered here, next to authenticate, because Express
// middleware only guards routes declared after it — and the pre-b247 handlers
// below (overview, matrix, group/candidates) now filter on the switch too.
// b247EnsureColumns is declared near the bottom of this file; the body runs at
// request time, long after the module has finished evaluating.
router.use((req, res, next) => { b247EnsureColumns(getPool()).finally(() => next()); });

// ── Wren Phonics content pack (b157) — original scheme, loaded from disk ─────
// wren/content/phonics/*.json — see SPEC.md in that dir for schema + IP rules.
const CONTENT_DIR = path.join(__dirname, '../content/phonics');
const AUDIO_DIR = '/app/uploads/phonics-audio';
// b221: character artwork lives with the content pack (see images/README.md).
const IMAGE_DIR = path.join(CONTENT_DIR, 'images');
const GPC_FILES = [
  'phase2-learning-gpc.json', 'phase3-learning-gpc.json', 'phase4-learning-gpc.json',
  'phase5-school-readiness-gpc.json', 'phase6-school-readiness-gpc.json',
];
const TRICKY_FILES = ['tricky-words-phase2.json', 'tricky-words-phase3.json', 'tricky-words-phase4.json'];

let _contentCache = null;
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(path.join(CONTENT_DIR, file), 'utf8')); }
  catch (e) { return null; }
}
function loadContentPack() {
  if (_contentCache) return _contentCache;
  const gpc = GPC_FILES.flatMap(f => readJSON(f) || []);
  const tricky_words = TRICKY_FILES.flatMap(f => readJSON(f) || []);
  const phase1_aspects = readJSON('phase1-introduction.json') || [];
  const characters = (readJSON('characters.json') || {}).characters || [];
  const _games = readJSON('games.json') || [];
  const games = Array.isArray(_games) ? _games : (_games.games || []);
  _contentCache = { phase1_aspects, gpc, tricky_words, characters, games };
  return _contentCache;
}
// ── b221: character artwork ──────────────────────────────────────────────────
// Characters ship with `image: null` until a real illustration exists. Resolution
// runs per-request rather than inside the cached content pack, so dropping a file
// into src/content/phonics/images/ takes effect without restarting the server.
function characterImageUrl(c) {
  const img = c && c.image;
  if (!img) return null;
  if (/^(https?:)?\/\//.test(img) || img.startsWith('/')) return img;  // external or already absolute
  const safe = path.basename(String(img));                             // no traversal out of IMAGE_DIR
  if (!fs.existsSync(path.join(IMAGE_DIR, safe))) return null;         // named but not supplied yet
  return `/api/phonics/content/characters/${encodeURIComponent(c.id)}/image`;
}
function resolveCharacters() {
  return loadContentPack().characters.map(c => ({ ...c, image_url: characterImageUrl(c) }));
}
// The cast of one story, resolved from its `characters` ids, so a reader can show
// the illustration (or fall back to the generated motif icon) without a second call.
function castFor(story) {
  const byId = new Map(resolveCharacters().map(c => [c.id, c]));
  return (story.characters || []).map(id => byId.get(id)).filter(Boolean).map(c => ({
    id: c.id, name: c.name, motif: c.motif,
    image_url: c.image_url, image_alt: c.image_alt || null,
  }));
}

// GPC catalog ordered by phase then position — used to suggest "what's next".
function nextGraphemeAfter(grapheme) {
  const gpc = loadContentPack().gpc.slice()
    .sort((a, b) => (a.phase - b.phase) || ((a.position_in_phase || 0) - (b.position_in_phase || 0)));
  const idx = gpc.findIndex(g => g.grapheme === grapheme);
  if (idx === -1 || idx === gpc.length - 1) return null;
  return gpc[idx + 1];
}

// ── Helper: calculate expected phase from date of birth ──────────────────────
function expectedPhaseFromDob(dob) {
  if (!dob) return 1;
  const birth = new Date(dob);
  const now = new Date();
  const ageMonths = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (ageMonths < 48) return 1;   // under 4 years
  if (ageMonths < 54) return 2;   // 4–4.5
  if (ageMonths < 60) return 3;   // 4.5–5
  if (ageMonths < 72) return 4;   // 5–6
  if (ageMonths < 84) return 5;   // 6–7
  return 6;
}

// ── Sound catalog ────────────────────────────────────────────────────────────

// GET /sounds — list all sounds (?phase=N&type=X)
router.get('/sounds', async (req, res) => {
  try {
    const db = getPool();
    const wheres = [];
    const params = [];
    if (req.query.phase) { params.push(parseInt(req.query.phase)); wheres.push(`phase=$${params.length}`); }
    if (req.query.type)  { params.push(req.query.type); wheres.push(`sound_type=$${params.length}`); }
    const where = wheres.length ? 'WHERE ' + wheres.join(' AND ') : '';
    const { rows } = await db.query(
      `SELECT * FROM phonics_sounds ${where} ORDER BY phase, position_in_phase, id`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /sounds/:id — update a sound (admin)
router.put('/sounds/:id', async (req, res) => {
  const { example_words, pronunciation_guide, rwi_action, position_in_phase } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE phonics_sounds
      SET example_words = COALESCE($1, example_words),
          pronunciation_guide = COALESCE($2, pronunciation_guide),
          rwi_action = COALESCE($3, rwi_action),
          position_in_phase = COALESCE($4, position_in_phase)
      WHERE id = $5 RETURNING *
    `, [example_words || null, pronunciation_guide || null, rwi_action || null,
        position_in_phase || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Child progress ───────────────────────────────────────────────────────────

// GET /child/:childId/progress — full progress for one child
router.get('/child/:childId/progress', async (req, res) => {
  try {
    if (!await b247RequireSwitch(req, res)) return;   // b247
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ps.id as sound_id, ps.phase, ps.sound_code, ps.sound_type,
             ps.example_words, ps.pronunciation_guide, ps.rwi_action, ps.position_in_phase,
             cpp.id as progress_id, cpp.confidence, cpp.last_assessed_at, cpp.assessed_by, cpp.notes
      FROM phonics_sounds ps
      LEFT JOIN child_phonics_progress cpp
        ON cpp.sound_id = ps.id AND cpp.child_id = $1
      ORDER BY ps.phase, ps.position_in_phase, ps.id
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /child/:childId/progress — upsert one sound's progress
router.put('/child/:childId/progress', async (req, res) => {
  const { sound_id, confidence, notes } = req.body;
  if (!sound_id || !confidence) return res.status(400).json({ error: 'sound_id and confidence required' });
  const assessedBy = req.user
    ? (req.user.first_name || '') + ' ' + (req.user.last_name || '')
    : 'Staff';
  try {
    if (!await b247RequireSwitch(req, res)) return;   // b247 — no phonics for a child whose switch is off
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO child_phonics_progress (child_id, sound_id, confidence, assessed_by, notes, last_assessed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (child_id, sound_id) DO UPDATE SET
        confidence = EXCLUDED.confidence,
        assessed_by = EXCLUDED.assessed_by,
        notes = CASE WHEN $5 IS NOT NULL THEN $5 ELSE child_phonics_progress.notes END,
        last_assessed_at = NOW()
      RETURNING *
    `, [req.params.childId, sound_id, confidence, assessedBy.trim(), notes || null]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId/progress/note — update note only
router.post('/child/:childId/progress/note', async (req, res) => {
  const { sound_id, notes } = req.body;
  if (!sound_id) return res.status(400).json({ error: 'sound_id required' });
  try {
    if (!await b247RequireSwitch(req, res)) return;   // b247 — no phonics for a child whose switch is off
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE child_phonics_progress SET notes = $1
      WHERE child_id = $2 AND sound_id = $3 RETURNING *
    `, [notes, req.params.childId, sound_id]);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /bulk-progress — bulk: same sound_id, many children
// body: { sound_id, updates: [{child_id, confidence}] }
router.post('/bulk-progress', async (req, res) => {
  const { sound_id, updates } = req.body;
  if (!sound_id || !Array.isArray(updates)) return res.status(400).json({ error: 'sound_id and updates[] required' });
  const assessedBy = req.user
    ? ((req.user.first_name || '') + ' ' + (req.user.last_name || '')).trim()
    : 'Staff';
  try {
    const db = getPool();
    const results = [];
    for (const u of updates) {
      if (!u.child_id || !u.confidence) continue;
      const { rows } = await db.query(`
        INSERT INTO child_phonics_progress (child_id, sound_id, confidence, assessed_by, last_assessed_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (child_id, sound_id) DO UPDATE SET
          confidence = EXCLUDED.confidence,
          assessed_by = EXCLUDED.assessed_by,
          last_assessed_at = NOW()
        RETURNING *
      `, [u.child_id, sound_id, u.confidence, assessedBy]);
      results.push(rows[0]);
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /expected-phase/:childId — expected phase from age
router.get('/expected-phase/:childId', async (req, res) => {
  try {
    if (!await b247RequireSwitch(req, res)) return;   // b247 — no phonics for a child whose switch is off
    const db = getPool();
    const { rows } = await db.query(
      'SELECT date_of_birth FROM children WHERE id=$1',
      [req.params.childId]
    );
    if (!rows.length) return res.status(404).json({ error: 'Child not found' });
    const phase = expectedPhaseFromDob(rows[0].date_of_birth);
    res.json({ child_id: parseInt(req.params.childId), expected_phase: phase, dob: rows[0].date_of_birth });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Overview / reports ────────────────────────────────────────────────────────

// GET /overview — room summary using new progress table
router.get('/overview', async (req, res) => {
  const { room_id } = req.query;
  try {
    const db = getPool();
    const params = room_id ? [room_id] : [];
    const roomFilter = room_id ? 'AND c.room_id=$1' : '';
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.date_of_birth,
        COUNT(cpp.id) FILTER (WHERE cpp.confidence=3) as confident,
        COUNT(cpp.id) FILTER (WHERE cpp.confidence=2) as recognising,
        COUNT(cpp.id) FILTER (WHERE cpp.confidence=1) as introduced,
        COUNT(cpp.id) as total_assessed
      FROM children c
      LEFT JOIN child_phonics_progress cpp ON cpp.child_id = c.id
      WHERE c.is_active=true AND c.phonics_enabled ${roomFilter}
      GROUP BY c.id ORDER BY c.first_name
    `, params);
    rows.forEach(r => { r.expected_phase = expectedPhaseFromDob(r.date_of_birth); });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /cohort — cohort analysis for admin report view
router.get('/cohort', async (req, res) => {
  try {
    const db = getPool();
    // Per-sound average confidence + count of children who have data
    const soundStats = await db.query(`
      SELECT ps.id, ps.phase, ps.sound_code, ps.sound_type, ps.position_in_phase,
        COUNT(cpp.id) as child_count,
        ROUND(AVG(cpp.confidence)::numeric, 2) as avg_confidence,
        COUNT(cpp.id) FILTER (WHERE cpp.confidence=3) as confident_count,
        COUNT(cpp.id) FILTER (WHERE cpp.confidence=2) as recognising_count,
        COUNT(cpp.id) FILTER (WHERE cpp.confidence=1) as introduced_count
      FROM phonics_sounds ps
      LEFT JOIN child_phonics_progress cpp ON cpp.sound_id = ps.id
      GROUP BY ps.id ORDER BY ps.phase, ps.position_in_phase
    `);
    // Total active children
    const childCount = await db.query(
      'SELECT COUNT(*) as total FROM children WHERE is_active=true AND is_demo=false'
    );
    // Phase distribution
    const phaseDist = await db.query(`
      SELECT expected_phase, count FROM (
        SELECT
          CASE
            WHEN extract(year from age(date_of_birth))*12 + extract(month from age(date_of_birth)) < 48 THEN 1
            WHEN extract(year from age(date_of_birth))*12 + extract(month from age(date_of_birth)) < 54 THEN 2
            WHEN extract(year from age(date_of_birth))*12 + extract(month from age(date_of_birth)) < 60 THEN 3
            WHEN extract(year from age(date_of_birth))*12 + extract(month from age(date_of_birth)) < 72 THEN 4
            ELSE 5
          END as expected_phase,
          COUNT(*) as count
        FROM children WHERE is_active=true AND is_demo=false
        GROUP BY 1
      ) t ORDER BY expected_phase
    `);
    res.json({
      sounds: soundStats.rows,
      total_children: parseInt(childCount.rows[0].total),
      phase_distribution: phaseDist.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /matrix — all children × all sounds for bulk assessment view
router.get('/matrix', async (req, res) => {
  const { phase } = req.query;
  try {
    const db = getPool();
    const [sounds, children, progress] = await Promise.all([
      db.query(
        'SELECT * FROM phonics_sounds WHERE phase=$1 ORDER BY position_in_phase',
        [phase || 2]
      ),
      db.query(
        // b247: a child whose phonics switch is off is not a column on the
        // phonics matrix. Nothing about phonics appears for them anywhere.
        'SELECT id, first_name, last_name, date_of_birth FROM children WHERE is_active=true AND is_demo=false AND phonics_enabled ORDER BY first_name'
      ),
      db.query(`
        SELECT cpp.child_id, cpp.sound_id, cpp.confidence
        FROM child_phonics_progress cpp
        JOIN phonics_sounds ps ON ps.id = cpp.sound_id
        WHERE ps.phase = $1
      `, [phase || 2])
    ]);
    // Build lookup: {child_id: {sound_id: confidence}}
    const lookup = {};
    progress.rows.forEach(r => {
      if (!lookup[r.child_id]) lookup[r.child_id] = {};
      lookup[r.child_id][r.sound_id] = r.confidence;
    });
    res.json({
      sounds: sounds.rows,
      children: children.rows.map(c => ({
        ...c,
        expected_phase: expectedPhaseFromDob(c.date_of_birth)
      })),
      progress: lookup
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Game sessions ─────────────────────────────────────────────────────────────

// POST /game-session — record a game session
router.post('/game-session', async (req, res) => {
  const { child_id, game_type, phase, score, duration_seconds,
          sounds_practiced, correct_count, attempted_count } = req.body;
  if (!child_id) return res.status(400).json({ error: 'child_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO phonics_game_sessions
        (child_id, game_type, phase, score, duration_seconds,
         sounds_practiced, correct_count, attempted_count)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [child_id, game_type, phase, score, duration_seconds,
        sounds_practiced || null, correct_count, attempted_count]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /game-sessions/:childId — recent game sessions for a child
router.get('/game-sessions/:childId', async (req, res) => {
  try {
    if (!await b247RequireSwitch(req, res)) return;   // b247 — no phonics for a child whose switch is off
    const db = getPool();
    const { rows } = await db.query(`
      SELECT * FROM phonics_game_sessions
      WHERE child_id=$1 ORDER BY played_at DESC LIMIT 50
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy backward-compat (phonics_tracker) ─────────────────────────────────

router.get('/child/:childId', async (req, res) => {
  try {
    if (!await b247RequireSwitch(req, res)) return;   // b247 — no phonics for a child whose switch is off
    const db = getPool();
    // (was hard-coded phonics_tracker — 2026-07-04: schema-unqualified so
    //  demo/HT editions read their own schema via search_path)
    const { rows } = await db.query(
      'SELECT * FROM phonics_tracker WHERE child_id=$1 ORDER BY phase, sound',
      [req.params.childId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/child/:childId/sound', async (req, res) => {
  const { sound, phase, status } = req.body;
  if (!sound || !status) return res.status(400).json({ error: 'sound and status required' });
  try {
    if (!await b247RequireSwitch(req, res)) return;   // b247 — no phonics for a child whose switch is off
    const db = getPool();
    // (was hard-coded phonics_tracker — 2026-07-04: schema-unqualified so demo
    //  editions write to their own schema via search_path, never into production)
    const { rows } = await db.query(`
      INSERT INTO phonics_tracker (child_id, sound, phase, status, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (child_id, sound) DO UPDATE SET status=$4, updated_by=$5, updated_at=NOW()
      RETURNING *
    `, [req.params.childId, sound, phase || 2, status, req.user.id]);
    // b157: reaching 'secure' on a sound auto-suggests the next GPC in sequence
    // as a next step (skips silently if the child already has an open one, or
    // the sound isn't in the Wren GPC catalog — e.g. it's a Phase 1 aspect).
    if (status === 'secure') {
      const next = nextGraphemeAfter(sound);
      if (next) {
        const desc = `Introduce the next phonics sound: "${next.grapheme}" (${next.character?.name || ''}) — ${next.mnemonic || ''}`.trim();
        const existing = await db.query(
          `SELECT id FROM next_steps WHERE child_id=$1 AND status IN ('open','pending') AND description ILIKE $2 LIMIT 1`,
          [req.params.childId, `%"${next.grapheme}"%`]
        );
        if (!existing.rows.length) {
          await db.query(
            `INSERT INTO next_steps (child_id, staff_id, description, status) VALUES ($1,$2,$3,'pending')`,
            [req.params.childId, req.user.id, desc.slice(0, 500)]
          );
        }
      }
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── School phonics scheme (induction setting, 2026-07-04) ────────────────────
// The scheme a setting follows is a SCHOOL-level choice, stored in settings
// (key 'phonics_scheme') per edition schema — not per-device localStorage.
// PHONICS_SCHEMES is the canonical picker list (DfE-validated SSPs researched
// 2026-07-04 + legacy L&S + other) served to the wizard/pages.
const PHONICS_SCHEMES = [
  { id: 'wren_phonics',    name: 'Wren Phonics (free, built-in)', validated: true, recommended: true },
  { id: 'little_wandle',   name: 'Little Wandle Letters and Sounds Revised', validated: true },
  { id: 'read_write_inc',  name: 'Read Write Inc. Phonics (Ruth Miskin)',    validated: true },
  { id: 'jolly_phonics',   name: 'Jolly Phonics',                            validated: true },
  { id: 'sounds_write',    name: 'Sounds-Write',                             validated: true },
  { id: 'twinkl_phonics',  name: 'Twinkl Phonics',                           validated: true },
  { id: 'bug_club',        name: 'Bug Club Phonics (Pearson)',               validated: true },
  { id: 'els',             name: 'Essential Letters and Sounds',             validated: true },
  { id: 'floppys_phonics', name: "Floppy's Phonics (Oxford)",                validated: true },
  { id: 'monster_phonics', name: 'Monster Phonics',                          validated: true },
  { id: 'rocket_phonics',  name: 'Reading Planet Rocket Phonics',            validated: true },
  { id: 'letterland',      name: 'Letterland Phonics',                       validated: true },
  { id: 'song_of_sounds',  name: 'Song of Sounds',                           validated: true },
  { id: 'letters_sounds',  name: 'Letters and Sounds 2007 (legacy, not DfE-validated)', validated: false },
  { id: 'other',           name: 'Other / own scheme',                       validated: false },
];

// GET /scheme — current school scheme + the full picker list
router.get('/scheme', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM settings WHERE key='phonics_scheme'");
    res.json({ scheme: rows[0]?.value || null, schemes: PHONICS_SCHEMES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /scheme — manager sets the school scheme {scheme: '<id>'}
router.put('/scheme', async (req, res) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin']) && Number(req.user?.id) !== 1) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  const { scheme } = req.body || {};
  if (!PHONICS_SCHEMES.some(s => s.id === scheme)) {
    return res.status(400).json({ error: 'unknown_scheme', valid: PHONICS_SCHEMES.map(s => s.id) });
  }
  try {
    await getPool().query(`
      INSERT INTO settings (key, value, updated_by, updated_at)
      VALUES ('phonics_scheme', $1, $2, NOW())
      ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=NOW()
    `, [scheme, Number(req.user.id) || null]);
    res.json({ ok: true, scheme });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Wren Phonics content pack API (b157) ──────────────────────────────────────

// GET /content — the full original scheme: Phase 1 aspects+games, GPC catalog
// (phase2-6, each with mnemonic/character/formation_cue/action), tricky words,
// and the 6-character story cast. Static content, cached in memory per process.
router.get('/content', (req, res) => {
  res.json({ ...loadContentPack(), characters: resolveCharacters() });
});

// GET /content/characters — the story cast, each with a resolved image_url
// (null until artwork exists) plus the art brief in image_alt. b221.
router.get('/content/characters', (req, res) => {
  res.json(resolveCharacters());
});

// GET /content/characters/:id/image — serves that character's illustration. b221.
router.get('/content/characters/:id/image', (req, res) => {
  const c = loadContentPack().characters.find(x => x.id === req.params.id);
  if (!c || !c.image) return res.status(404).json({ error: 'no_image' });
  const safe = path.basename(String(c.image));
  const file = path.join(IMAGE_DIR, safe);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no_image' });
  res.sendFile(file);
});

// ── b248: page illustrations ────────────────────────────────────────────────
// Rendered SVG lives beside the content pack (illustrations/<slug>-p<N>.svg,
// built by scripts/phonics/render-illustrations.js). Read from an index the
// renderer writes, cached per process like the rest of the content pack. A book
// with no scene file simply has no illustrations and still reads exactly as
// before — the art is additive, never required.
const ART_DIR = path.join(CONTENT_DIR, 'illustrations');
let _artCache = null;
function loadArtIndex() {
  if (_artCache) return _artCache;
  try { _artCache = JSON.parse(fs.readFileSync(path.join(ART_DIR, 'index.json'), 'utf8')); }
  catch (e) { _artCache = {}; }
  return _artCache;
}
// Inlined rather than linked: one request carries the whole book, which is the
// difference between a book opening instantly on a room tablet and it opening
// one picture at a time over the nursery wifi. Each page is a few KB.
function artFor(slug) {
  const pages = loadArtIndex()[slug];
  if (!Array.isArray(pages)) return null;
  const out = {};
  for (const p of pages) {
    try { out[p.page] = { svg: fs.readFileSync(path.join(ART_DIR, path.basename(p.file)), 'utf8'), alt: p.alt }; }
    catch (e) { /* a missing file just means that page has no picture */ }
  }
  return Object.keys(out).length ? out : null;
}

function listStoryFiles() {
  try { return fs.readdirSync(path.join(CONTENT_DIR, 'stories')).filter(f => f.endsWith('.json')); }
  catch (e) { return []; }
}

// GET /content/stories — metadata only (list view)
router.get('/content/stories', (req, res) => {
  const stories = listStoryFiles().map(f => {
    const s = readJSON(path.join('stories', f));
    if (!s) return null;
    return { slug: s.slug, title: s.title, checkpoint: s.checkpoint, wren_phase: s.wren_phase,
             // b182: numeric phase + read-aloud flag so the list can be filtered by
             // phase (Introduction books have no GPCs and are read TO the child), and
             // an art-brief count so it is visible which books are ready to illustrate.
             phase: s.phase || null, read_aloud: s.read_aloud === true,
             listening_aspects: s.listening_aspects || null,
             illustrations: (s.pages || []).filter(p => p && p.illustration).length,
             // b248: art_briefs is how many pages WANT a picture; illustrated is
             // how many actually have one, so the gap is visible in the list.
             illustrated: (loadArtIndex()[s.slug] || []).length,
             gpcs_required: s.gpcs_required, characters: s.characters, cast: castFor(s), pages: (s.pages || []).length };
  }).filter(Boolean);
  // b182: stories are now numbered across six phases — order them so the list reads
  // as a progression instead of by whatever order readdir happened to return.
  stories.sort((a, b) => (a.phase || 99) - (b.phase || 99) || a.slug.localeCompare(b.slug));
  if (req.query.phase)      return res.json(stories.filter(s => String(s.phase) === String(req.query.phase)));
  if (req.query.wren_phase) return res.json(stories.filter(s => s.wren_phase === req.query.wren_phase));
  res.json(stories);
});

const BOOK_ART_DIR = path.join(__dirname, '../../public/phonics-books');
// GET /content/stories/:slug — full story (pages, print-ready)
router.get('/content/stories/:slug', (req, res) => {
  const s = listStoryFiles().map(f => readJSON(path.join('stories', f))).find(x => x && x.slug === req.params.slug);
  if (!s) return res.status(404).json({ error: 'not_found' });
  // b248: hand each page its illustration and that illustration's alt text, so a
  // reader (or the PDF builder) needs no second call and no knowledge of paths.
  const art = artFor(s.slug);
  const pages = (s.pages || []).map((p, i) => {
    const a = art && art[i + 1];
    const out = a ? { ...p, illustration_svg: a.svg, illustration_alt: a.alt } : { ...p };
    // 2026-10-09: the reviewed page painting — the same art as the printed booklets and the free app —
    // copied phone-sized into public/phonics-books/ by build-phonics-site.py. Preferred over the SVG.
    const rel = `${s.slug}/p${i + 1}.jpg`;
    try {
      const st = fs.statSync(path.join(BOOK_ART_DIR, rel));
      out.illustration_url = `/phonics-books/${rel}?v=${Math.floor(st.mtimeMs / 1000)}`;
      if (!out.illustration_alt) out.illustration_alt = p.illustration || '';
    } catch (e) { /* not painted yet — SVG or cast icon */ }
    return out;
  });
  res.json({ ...s, pages, illustrated: art ? Object.keys(art).length : 0, cast: castFor(s) });
});

// ── Real pronunciation recording (b157) — TTS gets pure sounds wrong ("muh" not
// /m/), so we ship a record-in-browser slot instead of synthesised audio. A
// manager/staff member records the correct sound once; it's then served to
// everyone. Mirrors the multer pattern in src/routes/voice-notes.js.
const audioStorage = multer.diskStorage({
  destination(req, file, cb) { fs.mkdirSync(AUDIO_DIR, { recursive: true }); cb(null, AUDIO_DIR); },
  filename(req, file, cb) {
    const g = String(req.params.grapheme || 'x').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
    const mt = file.mimetype || '';
    const ext = mt.includes('mp4') ? 'mp4' : mt.includes('ogg') ? 'ogg' : mt.includes('wav') ? 'wav' : 'webm';
    cb(null, `${g}.${ext}`);
  },
});
const audioUpload = multer({ storage: audioStorage, limits: { fileSize: 3 * 1024 * 1024 } });

// POST /audio/:grapheme — manager/staff records the pure sound (multipart field "audio")
router.post('/audio/:grapheme', audioUpload.single('audio'), (req, res) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'room_leader', 'senior_practitioner', 'practitioner'])
      && Number(req.user?.id) !== 1) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(403).json({ error: 'Staff access required' });
  }
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  res.json({ ok: true, grapheme: req.params.grapheme, filename: req.file.filename });
});

// GET /audio/:grapheme — plays back the recorded sound, 404 if not recorded yet
router.get('/audio/:grapheme', (req, res) => {
  const g = String(req.params.grapheme).toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  let files = [];
  try { files = fs.readdirSync(AUDIO_DIR).filter(f => f.startsWith(g + '.')); } catch (e) { /* dir not created yet */ }
  if (!files.length) return res.status(404).json({ error: 'not_recorded' });
  res.sendFile(path.join(AUDIO_DIR, files[0]));
});

// GET /audio — which graphemes already have a recording (for a staff "record missing" list)
router.get('/audio', (req, res) => {
  let files = [];
  try { files = fs.readdirSync(AUDIO_DIR); } catch (e) { /* dir not created yet */ }
  res.json({ recorded: files.map(f => f.replace(/\.[a-z0-9]+$/i, '')) });
});

// ── b430 (2026-10-08): cue + creature pictures for the EY "Show on the board"
// viewer. Reuses the same ComfyUI picture bank the printables engine uses
// (picture-bank.js GRAPHEME_CUE/iconSvg) and the shared creature pool
// (same pictures scripts/phonics/build-assessment.js draws from for the PSC
// practice checks) — no new art drawn for this build.
//
// The pictures live on the host at /app-media/illustrations/
// creatures-final — fine for build-time scripts (build-assessment.js,
// build-phonics-site.py) which run directly on the host, but neither
// wren-ladn nor wren-ladn-dev bind-mounts wren-media, so a LIVE route reading
// that path would 404 forever. Same fix build-phonics-site.py already uses
// for the free app (copies into a served static dir instead of mounting
// wren-media live): the 40 PNGs are copied once into public/phonics-creatures
// (public/ is already bind-mounted in both containers) and read from there.
const CREATURE_DIR = path.join(__dirname, '../../public/phonics-creatures');

// GET /content/cue/:grapheme — the picture-bank's designated cue picture for
// one grapheme, as inline SVG. 404 if that grapheme has no assigned cue.
router.get('/content/cue/:grapheme', (req, res) => {
  const id = pictureBank.GRAPHEME_CUE && pictureBank.GRAPHEME_CUE[req.params.grapheme];
  if (!id) return res.status(404).json({ error: 'no_cue' });
  try { res.json({ grapheme: req.params.grapheme, svg: pictureBank.iconSvg(id, { size: 220 }) }); }
  catch (e) { res.status(404).json({ error: 'no_cue' }); }
});

// GET /content/creatures — the shared "made-up creature" picture pool (ids
// only — the real filenames are served, never guessed, by the route below).
router.get('/content/creatures', (req, res) => {
  let files = [];
  try { files = fs.readdirSync(CREATURE_DIR).filter((f) => /^creature-\d+\.png$/.test(f)).sort(); }
  catch (e) { files = []; }
  res.json({ creatures: files.map((f) => f.replace(/\.png$/, '')) });
});

// GET /content/creatures/:id/image — one creature picture. path.basename +
// the same filename pattern as the list above guards against traversal.
router.get('/content/creatures/:id/image', (req, res) => {
  const safe = path.basename(String(req.params.id));
  if (!/^creature-\d+$/.test(safe)) return res.status(404).json({ error: 'not_found' });
  const file = path.join(CREATURE_DIR, `${safe}.png`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'not_found' });
  res.sendFile(file);
});

// GET /content/handwriting — Wren Write's letter families, formation cue and
// rhyme for every letter, from src/content/phonics/programme/handwriting/
// letters.json. Same transform as scripts/build-phonics-site.py's `write`
// block (the free app's copy) — one source file, two readers.
const HANDWRITING_FILE = path.join(CONTENT_DIR, 'programme', 'handwriting', 'letters.json');
let _handwritingCache = null;
router.get('/content/handwriting', (req, res) => {
  if (!_handwritingCache) {
    try {
      const letters = JSON.parse(fs.readFileSync(HANDWRITING_FILE, 'utf8'));
      const families = (letters.families?.lowercase || [])
        .map((fam) => ({ name: fam.name, letters: letters.lowercase.filter((l) => l.family === fam.key).map((l) => l.grapheme) }))
        .filter((f) => f.letters.length);
      const all = [...letters.lowercase, ...(letters.capitals || [])];
      _handwritingCache = {
        families,
        cues: Object.fromEntries(all.map((l) => [l.grapheme, l.cue || ''])),
        rhymes: Object.fromEntries(all.filter((l) => l.rhyme).map((l) => [l.grapheme, l.rhyme])),
      };
    } catch (e) { _handwritingCache = { families: [], cues: {}, rhymes: {} }; }
  }
  res.json(_handwritingCache);
});


// ═══════════════════════════════════════════════════════════════════════════
// b182 — Small-group phonics activities + framework linkage
// ═══════════════════════════════════════════════════════════════════════════
// Flow: planned activity → select children → run the activity → evaluate.
//
// Group observations follow the b183 convention exactly: finishing a run writes
// ONE observation ROW PER CHILD, every row carrying the SAME group_uuid (the
// session's). Staff performance counts COUNT(DISTINCT group_uuid), so a 4-child
// group activity is ONE practitioner event, while each child still gets the
// entry on their own learning journey. See src/lib/report-card.js OBS_EFFORT_KEY
// and scripts/migrations/2026-08-18-obs-group-uuid.sql.

const { randomUUID } = require('crypto');
const {
  seedPhonicsFrameworkMap, getActiveFramework,
} = require('../lib/phonics-framework-map');

const ASSESSMENTS = new Set(['secure', 'developing', 'needs_support']);
// Quick-assess → phonics_tracker.status (the existing b157 vocabulary).
const ASSESSMENT_TO_TRACKER = {
  secure: 'secure', developing: 'recognising', needs_support: 'introduced',
};
const ASSESSMENT_LABEL = {
  secure: 'secure', developing: 'developing', needs_support: 'needs support',
};

function isManagerish(user) {
  return hasRole(user, ['manager', 'deputy_manager', 'admin', 'headteacher', 'room_leader', 'senior_practitioner']) || Number(user?.id) === 1;
}

// ── Activity picker ──────────────────────────────────────────────────────────
// The 24 phonics games from the content pack PLUS the setting's own activity
// bank (curriculum_activities). Both are offerable as a small-group activity;
// the run screen shows whichever content the chosen one carries.
router.get('/group/activities', async (req, res) => {
  const { phase, wren_phase, q } = req.query;
  const games = loadContentPack().games
    .filter(g => !phase      || String(g.phase) === String(phase))
    .filter(g => !wren_phase || g.wren_phase === wren_phase)
    .filter(g => !q          || (g.name + ' ' + (g.format || '')).toLowerCase().includes(String(q).toLowerCase()))
    .map(g => ({
      source: 'game', ref: g.id, name: g.name,
      phase: g.phase, wren_phase: g.wren_phase,
      duration_mins: g.duration_mins, format: g.format,
      gpc_focus: g.gpc_focus, how_to_play: g.how_to_play,
      materials: g.materials, players: g.players, why_it_helps: g.why_it_helps,
    }));

  let bank = [];
  try {
    const params = [];
    let sql = `SELECT id, name, description, category, age_range, resources_needed, parent_tip
                 FROM curriculum_activities WHERE category ILIKE '%litera%'`;
    if (q) { params.push('%' + q + '%'); sql += ` AND (name ILIKE $${params.length} OR description ILIKE $${params.length})`; }
    sql += ' ORDER BY name LIMIT 60';
    const { rows } = await getPool().query(sql, params);
    bank = rows.map(a => ({
      source: 'activity_bank', ref: String(a.id), name: a.name,
      phase: null, wren_phase: null, duration_mins: null,
      format: a.category, how_to_play: a.description,
      materials: a.resources_needed, players: null, why_it_helps: a.parent_tip,
      age_range: a.age_range,
    }));
  } catch (e) { /* activity bank is optional — the games library always works */ }

  res.json({ games, activity_bank: bank, total: games.length + bank.length });
});

// ── Child multi-select: room-filtered, key children first ────────────────────
router.get('/group/candidates', async (req, res) => {
  const { room_id } = req.query;
  const params = [req.user.id];
  let sql = `
    SELECT c.id, c.first_name, c.last_name, c.room_id, r.name AS room_name,
           c.date_of_birth, c.key_person_id,
           (c.key_person_id = $1) IS TRUE AS is_key_child,
           pt.phase AS phonics_phase
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN LATERAL (
        SELECT max(phase) AS phase FROM phonics_tracker
         WHERE child_id = c.id AND status IN ('introduced','recognising','secure','mastered')
      ) pt ON true
     WHERE COALESCE(c.status,'active') = 'active'
       AND (c.leave_date IS NULL OR c.leave_date > CURRENT_DATE)
       -- b247: turning the switch on IS what starts a child joining sessions, so
       -- a child whose switch is off is not offered as a candidate for one.
       AND c.phonics_enabled`;
  if (room_id) { params.push(room_id); sql += ` AND c.room_id = $${params.length}`; }
  // Key children first, then alphabetical — the order a practitioner scans in.
  // `IS TRUE` not `= $1`: a NULL key_person_id yields NULL, and NULLs sort FIRST
  // under DESC in Postgres, which put non-key children at the top.
  sql += ` ORDER BY ((c.key_person_id = $1) IS TRUE) DESC, c.first_name, c.last_name`;
  try {
    const { rows } = await getPool().query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Recent / listable sessions ───────────────────────────────────────────────
router.get('/group/sessions', async (req, res) => {
  const { room_id, status, limit = 30 } = req.query;
  const params = [];
  let sql = `
    SELECT s.*, r.name AS room_name,
           st.first_name || ' ' || st.last_name AS led_by_name,
           (SELECT count(*)::int FROM phonics_group_participants p WHERE p.session_id = s.id) AS child_count
      FROM phonics_group_sessions s
      LEFT JOIN rooms r  ON r.id = s.room_id
      LEFT JOIN staff st ON st.id = s.led_by
     WHERE 1=1`;
  if (room_id) { params.push(room_id); sql += ` AND s.room_id = $${params.length}`; }
  if (status)  { params.push(status);  sql += ` AND s.status = $${params.length}`; }
  params.push(Math.min(parseInt(limit) || 30, 200));
  sql += ` ORDER BY s.started_at DESC LIMIT $${params.length}`;
  try {
    const { rows } = await getPool().query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── One child's group-activity history + evaluations (readable per child) ────
router.get('/group/child/:childId', async (req, res) => {
  try {
    if (!await b247RequireSwitch(req, res)) return;   // b247 — no phonics for a child whose switch is off
    const { rows } = await getPool().query(`
      SELECT s.id AS session_id, s.activity_name, s.phase, s.wren_phase, s.focus_gpcs,
             s.started_at, s.finished_at, s.status, s.notes,
             s.what_worked, s.what_to_repeat, s.evaluated_at,
             st.first_name || ' ' || st.last_name AS led_by_name,
             p.assessment, p.child_note, p.next_step, p.observation_id, p.next_step_id
        FROM phonics_group_participants p
        JOIN phonics_group_sessions s ON s.id = p.session_id
        LEFT JOIN staff st ON st.id = s.led_by
       WHERE p.child_id = $1
       ORDER BY s.started_at DESC
       LIMIT 100`, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /group/heatmap?room_id= — children × GPCs, one call (b408). Powers the
// class heatmap — every active (optionally room-filtered) child against every
// GPC. Declared here, with the other literal /group/* paths, so it isn't
// swallowed by /group/:id below (same reason /group/start is here, per the
// comment above it).
router.get('/group/heatmap', async (req, res) => {
  const { room_id } = req.query;
  try {
    const db = getPool();
    const params = [];
    let sql = `SELECT id, first_name, last_name, room_id FROM children
                WHERE COALESCE(status,'active')='active' AND (leave_date IS NULL OR leave_date > CURRENT_DATE)`;
    if (room_id) { params.push(room_id); sql += ` AND room_id=$${params.length}`; }
    sql += ' ORDER BY first_name, last_name';
    const { rows: children } = await db.query(sql, params);
    if (!children.length) return res.json({ gpcs: assessLib.gpcsOrdered().map((g) => g.grapheme), children: [], matrix: {} });

    const ids = children.map((c) => c.id);
    const { rows: items } = await db.query(`
      SELECT DISTINCT ON (pa.child_id, ai.ref) pa.child_id, ai.ref, ai.correct
        FROM phonics_assessment_items ai
        JOIN phonics_assessments pa ON pa.id = ai.assessment_id
       WHERE ai.item_type = 'gpc' AND pa.child_id = ANY($1::int[])
       ORDER BY pa.child_id, ai.ref, pa.assessed_at DESC, ai.id DESC`, [ids]);
    const matrix = {};
    for (const c of children) matrix[c.id] = {};
    for (const r of items) matrix[r.child_id][r.ref] = r.correct ? 'secure' : 'not_secure';

    res.json({
      gpcs: assessLib.gpcsOrdered().map((g) => ({ grapheme: g.grapheme, phase: g.phase })),
      children: children.map((c) => ({ id: c.id, first_name: c.first_name, last_name: c.last_name, room_id: c.room_id })),
      matrix,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Start a run ──────────────────────────────────────────────────────────────
// Declared AFTER the literal /group/* paths above so they aren't swallowed by
// /group/:id below.
router.post('/group/start', async (req, res) => {
  const {
    activity_source, activity_ref, activity_name,
    phase, wren_phase, room_id, child_ids, planned_activity_id, focus_gpcs,
  } = req.body || {};

  const ids = Array.from(new Set((child_ids || []).map(n => parseInt(n, 10)).filter(Boolean)));
  if (!ids.length) return res.status(400).json({ error: 'child_ids required — pick at least one child' });

  const source = ['game', 'activity_bank', 'custom'].includes(activity_source) ? activity_source : 'game';

  // Snapshot the activity content at run time so a later edit to the games pack
  // or the activity bank doesn't silently rewrite what was actually run.
  let snapshot = null, name = activity_name || null, ph = phase || null, wp = wren_phase || null;
  if (source === 'game' && activity_ref) {
    const g = loadContentPack().games.find(x => x.id === activity_ref);
    if (g) {
      snapshot = { how_to_play: g.how_to_play, materials: g.materials, players: g.players,
                   gpc_focus: g.gpc_focus, why_it_helps: g.why_it_helps, format: g.format,
                   duration_mins: g.duration_mins };
      name = name || g.name; ph = ph || g.phase; wp = wp || g.wren_phase;
    }
  } else if (source === 'activity_bank' && activity_ref) {
    try {
      const { rows } = await getPool().query(
        'SELECT name, description, resources_needed, parent_tip, age_range FROM curriculum_activities WHERE id=$1',
        [parseInt(activity_ref, 10)]);
      if (rows.length) {
        snapshot = { how_to_play: rows[0].description, materials: rows[0].resources_needed,
                     why_it_helps: rows[0].parent_tip, age_range: rows[0].age_range };
        name = name || rows[0].name;
      }
    } catch (e) { /* fall through with whatever the client sent */ }
  }
  if (!name) return res.status(400).json({ error: 'activity_name required' });

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO phonics_group_sessions
        (group_uuid, activity_source, activity_ref, activity_name, activity_snapshot,
         phase, wren_phase, focus_gpcs, room_id, led_by, planned_activity_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'running')
      RETURNING *`,
      [randomUUID(), source, activity_ref ? String(activity_ref) : null, name,
       snapshot ? JSON.stringify(snapshot) : null,
       ph || null, wp || null, focus_gpcs || [], room_id || null,
       req.user.id, planned_activity_id || null]);
    const session = rows[0];

    for (const cid of ids) {
      await client.query(
        `INSERT INTO phonics_group_participants (session_id, child_id)
         VALUES ($1,$2) ON CONFLICT (session_id, child_id) DO NOTHING`, [session.id, cid]);
    }
    await client.query('COMMIT');
    res.status(201).json(await loadSession(db, session.id));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Shared loader: session + its children (with names) + the activity content.
async function loadSession(db, id) {
  const { rows } = await db.query(`
    SELECT s.*, r.name AS room_name,
           st.first_name || ' ' || st.last_name AS led_by_name
      FROM phonics_group_sessions s
      LEFT JOIN rooms r  ON r.id = s.room_id
      LEFT JOIN staff st ON st.id = s.led_by
     WHERE s.id = $1`, [id]);
  if (!rows.length) return null;
  const session = rows[0];
  const { rows: kids } = await db.query(`
    SELECT p.*, c.first_name, c.last_name, c.room_id, c.key_person_id
      FROM phonics_group_participants p
      JOIN children c ON c.id = p.child_id
     WHERE p.session_id = $1
     ORDER BY c.first_name, c.last_name`, [id]);
  return { ...session, children: kids };
}

router.get('/group/:id', async (req, res) => {
  try {
    const s = await loadSession(getPool(), req.params.id);
    if (!s) return res.status(404).json({ error: 'not_found' });
    res.json(s);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Run screen: per-child quick assess + note ────────────────────────────────
router.patch('/group/:id/child/:childId', async (req, res) => {
  const { assessment, child_note } = req.body || {};
  if (assessment && !ASSESSMENTS.has(assessment))
    return res.status(400).json({ error: 'assessment must be secure | developing | needs_support' });
  try {
    const { rows } = await getPool().query(`
      UPDATE phonics_group_participants
         SET assessment  = COALESCE($1, assessment),
             child_note  = COALESCE($2, child_note),
             assessed_at = CASE WHEN $1 IS NULL THEN assessed_at ELSE now() END
       WHERE session_id = $3 AND child_id = $4
       RETURNING *`,
      [assessment || null, child_note ?? null, req.params.id, req.params.childId]);
    if (!rows.length) return res.status(404).json({ error: 'not_in_session' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Shared notes box — saved as you type, so a finish that fails doesn't lose them.
router.patch('/group/:id', async (req, res) => {
  const { notes, focus_gpcs } = req.body || {};
  try {
    const { rows } = await getPool().query(`
      UPDATE phonics_group_sessions
         SET notes = COALESCE($1, notes), focus_gpcs = COALESCE($2, focus_gpcs)
       WHERE id = $3 RETURNING *`,
      [notes ?? null, focus_gpcs || null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// The framework statements a phonics phase maps to in the ACTIVE framework.
// Only 'exact' rows are linked automatically — a heuristic/unmatched row means
// the framework genuinely has no counterpart, and inventing one would put an
// unearned tick on a child's tracker.
async function frameworkStatementsForPhase(db, phase) {
  if (!phase) return [];
  try {
    const framework = await getActiveFramework(db);
    const { rows } = await db.query(`
      SELECT statement_id FROM phonics_framework_map
       WHERE framework = $1 AND phonics_ref IN ($2, $3)
         AND match_quality = 'exact' AND statement_id IS NOT NULL`,
      [framework, `phase:${phase}:reading`, `phase:${phase}:writing`]);
    return rows.map(r => r.statement_id);
  } catch (e) { return []; }
}

// ── Finish the run → ONE group observation event ─────────────────────────────
// login-20261023: same gate as POST /api/observations — this also creates observations, and apprentices (Toby: no observations until they are signed off as ready) got through it.
router.post('/group/:id/finish', requireCapabilityLevel('observations.create', 'edit'), async (req, res) => {
  const {
    notes, observation_text, title, eyfs_areas, shared_with_parents,
    update_phonics_tracker,
  } = req.body || {};

  const db = getPool();
  const session = await loadSession(db, req.params.id).catch(() => null);
  if (!session) return res.status(404).json({ error: 'not_found' });
  if (session.status !== 'running')
    return res.status(409).json({ error: 'already_finished', status: session.status });
  if (!session.children.length)
    return res.status(400).json({ error: 'no_children_in_session' });

  const sharedNotes = notes ?? session.notes ?? '';
  const baseText = (observation_text && String(observation_text).trim())
    || `Small-group phonics: ${session.activity_name}.` + (sharedNotes ? ` ${sharedNotes}` : '');
  const obsTitle = (title && String(title).trim()) || `Phonics group — ${session.activity_name}`;
  const statementIds = await frameworkStatementsForPhase(db, session.phase);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const written = [];

    for (const kid of session.children) {
      // Per-child text = the shared account of the activity + this child's own
      // quick-assess and note. One event, N journeys.
      const bits = [baseText];
      if (kid.assessment) {
        bits.push(`${kid.first_name} was ${ASSESSMENT_LABEL[kid.assessment]} with the sounds in this activity.`);
      }
      if (kid.child_note && kid.child_note.trim()) bits.push(kid.child_note.trim());
      const text = bits.join(' ');

      const { rows } = await client.query(`
        INSERT INTO observations
          (group_uuid, child_id, staff_id, title, observation_text, observation_type,
           eyfs_areas, planned_activity, obs_tags, linked_framework_ids,
           shared_with_parents, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,'planned_activity',$6,true,
                ARRAY['planned_activity','phonics_group']::text[], $7, $8, NOW(), NOW())
        RETURNING id`,
        [session.group_uuid, kid.child_id, req.user.id, obsTitle, text,
         eyfs_areas && eyfs_areas.length ? eyfs_areas : ['Literacy'],
         statementIds, shared_with_parents === true]);
      const obsId = rows[0].id;
      written.push({ child_id: kid.child_id, observation_id: obsId });

      await client.query(
        'UPDATE phonics_group_participants SET observation_id=$1 WHERE session_id=$2 AND child_id=$3',
        [obsId, session.id, kid.child_id]);

      // Surface it on the child's framework tracker (same upsert shape as
      // src/routes/observations.js so both paths produce identical rows).
      for (const sid of statementIds) {
        try {
          const { rows: st } = await client.query(
            'SELECT framework, area, aspect, age_range, statement_text FROM framework_statements WHERE id=$1', [sid]);
          if (!st.length) continue;
          const s = st[0];
          await client.query(`
            INSERT INTO framework_tracker
              (child_id, framework, area, aspect, age_range, statement, statement_id,
               status, linked_observation_id, assessed_by, assessed_at, created_at, updated_at)
            VALUES ($1,$2,COALESCE($3,''),COALESCE($4,''),$5,$6,$7,'emerging',$8,$9,NOW(),NOW(),NOW())
            ON CONFLICT (child_id, framework, area, aspect, statement) DO UPDATE
              SET statement_id=EXCLUDED.statement_id,
                  status=CASE WHEN framework_tracker.status='not_yet' THEN 'emerging' ELSE framework_tracker.status END,
                  linked_observation_id=COALESCE($8, framework_tracker.linked_observation_id),
                  assessed_by=$9, assessed_at=NOW(), updated_at=NOW()`,
            [kid.child_id, s.framework, s.area, s.aspect, s.age_range, s.statement_text, sid,
             obsId, req.user.id]);
        } catch (e) { /* best-effort: the observation is already saved */ }
      }

      // Roll the quick-assess into the phonics tracker for the focus GPCs.
      if (update_phonics_tracker !== false && kid.assessment && (session.focus_gpcs || []).length) {
        const status = ASSESSMENT_TO_TRACKER[kid.assessment];
        for (const g of session.focus_gpcs) {
          try {
            await client.query(`
              INSERT INTO phonics_tracker (child_id, sound, phase, status, updated_by, updated_at)
              VALUES ($1,$2,$3,$4,$5,now())
              ON CONFLICT (child_id, sound) DO UPDATE
                SET status = EXCLUDED.status, phase = COALESCE(EXCLUDED.phase, phonics_tracker.phase),
                    updated_by = EXCLUDED.updated_by, updated_at = now()`,
              [kid.child_id, g, session.phase || null, status, req.user.id]);
          } catch (e) { /* best-effort */ }
        }
      }
    }

    await client.query(`
      UPDATE phonics_group_sessions
         SET status='completed', finished_at=now(), notes=COALESCE($1, notes)
       WHERE id=$2`, [notes ?? null, session.id]);

    // Close the loop back to the planned activity that started this.
    if (session.planned_activity_id && written.length) {
      await client.query(`
        UPDATE planned_activities
           SET status='happened', happened_observation_id=$1
         WHERE id=$2`, [written[0].observation_id, session.planned_activity_id]);
    }

    await client.query('COMMIT');
    res.json({
      ok: true,
      group_uuid: session.group_uuid,
      observations: written,
      observation_count: written.length,
      distinct_group_events: 1,
      linked_statement_ids: statementIds,
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── Evaluation step ──────────────────────────────────────────────────────────
// What worked, what to repeat, and a next step per child. Per-child next steps
// become real ladn.next_steps rows so they flow into the existing planning loop
// rather than dead-ending in a phonics-only table.
router.post('/group/:id/evaluate', async (req, res) => {
  const { what_worked, what_to_repeat, children } = req.body || {};
  const db = getPool();
  const session = await loadSession(db, req.params.id).catch(() => null);
  if (!session) return res.status(404).json({ error: 'not_found' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const row of (children || [])) {
      const cid = parseInt(row.child_id, 10);
      if (!cid) continue;
      const text = (row.next_step || '').trim();
      let nsId = null;
      if (text) {
        const kid = session.children.find(k => k.child_id === cid);
        const { rows } = await client.query(`
          INSERT INTO next_steps (observation_id, child_id, staff_id, description, status, created_at, updated_at)
          VALUES ($1,$2,$3,$4,'pending',NOW(),NOW()) RETURNING id`,
          [kid && kid.observation_id ? kid.observation_id : null, cid, req.user.id, text]);
        nsId = rows[0].id;
      }
      await client.query(`
        UPDATE phonics_group_participants
           SET next_step = COALESCE($1, next_step),
               next_step_id = COALESCE($2, next_step_id),
               assessment = COALESCE($3, assessment)
         WHERE session_id = $4 AND child_id = $5`,
        [text || null, nsId, ASSESSMENTS.has(row.assessment) ? row.assessment : null,
         session.id, cid]);
    }
    const { rows: sRows } = await client.query(`
      UPDATE phonics_group_sessions
         SET what_worked   = COALESCE($1, what_worked),
             what_to_repeat= COALESCE($2, what_to_repeat),
             evaluated_by  = $3,
             evaluated_at  = now(),
             status        = 'evaluated'
       WHERE id = $4 RETURNING *`,
      [what_worked ?? null, what_to_repeat ?? null, req.user.id, session.id]);
    await client.query('COMMIT');
    res.json(await loadSession(db, sRows[0].id));
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── Phonics ↔ framework map ──────────────────────────────────────────────────

// GET /framework-map?framework=&kind=&phase= — defaults to the ACTIVE framework.
router.get('/framework-map', async (req, res) => {
  const db = getPool();
  try {
    const framework = req.query.framework || await getActiveFramework(db);
    const params = [framework];
    let sql = `SELECT * FROM phonics_framework_map WHERE framework = $1`;
    if (req.query.kind)  { params.push(req.query.kind);  sql += ` AND phonics_kind = $${params.length}`; }
    if (req.query.phase) { params.push(req.query.phase); sql += ` AND phase = $${params.length}`; }
    sql += ' ORDER BY phase NULLS LAST, phonics_kind, phonics_ref';
    const { rows } = await db.query(sql, params);
    res.json({ framework, active_framework: await getActiveFramework(db), rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /framework-map/seed — (re)build the map. Run after b180 creates a custom
// framework, or after a setting switches its active framework.
router.post('/framework-map/seed', async (req, res) => {
  if (!isManagerish(req.user)) return res.status(403).json({ error: 'Manager access required' });
  try {
    const frameworks = Array.isArray(req.body?.frameworks) && req.body.frameworks.length
      ? req.body.frameworks : null;
    const summary = await seedPhonicsFrameworkMap(getPool(), frameworks ? { frameworks } : {});
    res.json({ ok: true, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/framework-progress — phonics progress expressed against the
// ACTIVE framework, for the child's framework tracker.
router.get('/child/:childId/framework-progress', async (req, res) => {
  const db = getPool();
  try {
    if (!await b247RequireSwitch(req, res)) return;   // b247 — no phonics for a child whose switch is off
    const framework = req.query.framework || await getActiveFramework(db);
    const { rows: prog } = await db.query(`
      SELECT phase,
             count(*)::int                                                        AS sounds,
             count(*) FILTER (WHERE status IN ('secure','mastered'))::int          AS secure,
             count(*) FILTER (WHERE status = 'recognising')::int                   AS recognising,
             count(*) FILTER (WHERE status = 'introduced')::int                    AS introduced,
             max(updated_at)                                                       AS last_updated
        FROM phonics_tracker
       WHERE child_id = $1 AND status <> 'not_introduced'
       GROUP BY phase ORDER BY phase`, [req.params.childId]);

    const { rows: map } = await db.query(`
      SELECT phase, strand, area, sub_area, age_range, statement_id, match_quality, label
        FROM phonics_framework_map
       WHERE framework = $1 AND phonics_kind = 'phase'
       ORDER BY phase, strand`, [framework]);

    const byPhase = new Map(prog.map(p => [Number(p.phase), p]));
    const areas = [];
    for (const m of map) {
      const p = byPhase.get(Number(m.phase));
      areas.push({
        phase: m.phase, strand: m.strand,
        area: m.area, sub_area: m.sub_area, age_range: m.age_range,
        statement_id: m.statement_id, match_quality: m.match_quality, label: m.label,
        sounds: p ? p.sounds : 0, secure: p ? p.secure : 0,
        recognising: p ? p.recognising : 0, introduced: p ? p.introduced : 0,
        last_updated: p ? p.last_updated : null,
      });
    }

    // Group activities this child has taken part in — the practitioner evidence
    // behind the numbers above.
    const { rows: sessions } = await db.query(`
      SELECT s.id, s.activity_name, s.phase, s.started_at, s.status,
             p.assessment, p.next_step, p.observation_id
        FROM phonics_group_participants p
        JOIN phonics_group_sessions s ON s.id = p.session_id
       WHERE p.child_id = $1
       ORDER BY s.started_at DESC LIMIT 20`, [req.params.childId]);

    res.json({ framework, child_id: Number(req.params.childId), phases: prog, framework_areas: areas, group_sessions: sessions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b247 (2026-08-28) — a switch per child, and a tracker that stays basic
//
// Toby: "this can be a switch on child profile accessible from EY tablet. When
// they switch it on is when the child starts joining sessions. ... and basic
// (AND I MEAN VERY BASIC) phonics tracker - just ticking off the sounds they
// are confident in, or colour coded red orange green. then oldest kids up to
// decoding cvc words."
//
// The capitals are the specification, so read what this DOES NOT add:
//   • no new table — the grid writes to phonics_tracker, which b157 created and
//     which is the one holding real rows (32 on dev; child_phonics_progress: 0)
//   • no new status vocabulary — not yet / red / amber / green are four of the
//     five values the phonics_tracker CHECK constraint already allows
//   • no percentages, charts, progress bars or sub-levels anywhere below
//   • no phonics card type — a book or game goes home as an ACTIVITY-BANK card
//     on next_steps.library_activity_id, which b181 already built
//
// WHAT IS NEW is the switch. Everything phonics in every portal now asks the
// child's switch first, and answers nothing when it is off.
// ═══════════════════════════════════════════════════════════════════════════

// The four states, IN TAP ORDER. Green is one tap from "not yet" on purpose:
// the brief asked for the tap count to mark a sound green and the answer had to
// be one. Marking confidence is overwhelmingly what a practitioner is doing when
// they touch this grid ("just ticking off the sounds they are confident in") —
// red and amber are the exception, so they cost the extra taps, not green.
const { recordAudit } = require('../utils/audit');
const { operationalChildFilter } = require('../utils/enrolment');   // b96 — one definition of "here today"

const B247_CYCLE = ['not_yet', 'green', 'amber', 'red'];
// state -> the phonics_tracker.status value b157 already defined. No migration.
const B247_STATUS_OF = {
  not_yet: 'not_introduced',
  green:   'secure',
  amber:   'recognising',
  red:     'introduced',
};
// ...and back. 'mastered' is a legacy b157 value (2 rows on dev) with no place in
// a four-state grid; it reads as green rather than being rewritten, so nothing
// already recorded is lost or silently downgraded.
const B247_STATE_OF = {
  not_introduced: 'not_yet',
  introduced:     'red',
  recognising:    'amber',
  secure:         'green',
  mastered:       'green',
};

// The reserved phonics_tracker.sound for the one extra row the oldest band gets.
// phonics_tracker.sound is free text keyed unique per (child_id, sound) and every
// real GPC is a lowercase grapheme, so a hyphenated key cannot collide with one.
const B247_CVC_SOUND = 'cvc-decoding';
// "the oldest kids" — 4+, which is also where expectedPhaseFromDob() above already
// puts the school-readiness boundary, so the two agree rather than drifting.
const B247_CVC_MIN_MONTHS = 48;

// The nursery's sounds: phases 2 and 3, graphemes/digraphs/trigraphs only.
// Not tricky words (not sounds), not Phase 1 aspects (listening, not GPCs), not
// phases 4-6 (adjacent consonants and alternative spellings — school work, and
// 92 more chips). 49 sounds is a grid; 141 is a spreadsheet.
const B247_PHASES = [2, 3];
const B247_SOUND_TYPES = ['grapheme', 'digraph', 'trigraph'];

// pg hands a DATE back as a local-midnight JS Date, so JSON.stringify's
// toISOString() can shift phonics_started_on back a day under BST. Same fix as
// src/lib/report-cycle.js: read LOCAL getters and carry the date as a string.
function b247Ymd(v) {
  if (!v) return null;
  const d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d)) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Lazy, idempotent, per-process: this router is SHARED by every edition
// (ladn, demo_eyfs, demo_primary, htps, childrenscorner…) and the b247 migration
// only reached ladn. Without this, adding `c.phonics_enabled` to a shared query
// 500s the demo editions instead of degrading. Same pattern, and the same reason,
// as ensureEnrolmentColumn in src/utils/enrolment.js.
let _b247Ensured = false;
async function b247EnsureColumns(db) {
  if (_b247Ensured) return;
  try {
    await db.query(`ALTER TABLE children ADD COLUMN IF NOT EXISTS phonics_enabled boolean NOT NULL DEFAULT false`);
    await db.query(`ALTER TABLE children ADD COLUMN IF NOT EXISTS phonics_started_on date`);
    await db.query(`ALTER TABLE children ADD COLUMN IF NOT EXISTS phonics_enabled_by integer`);
    await db.query(`ALTER TABLE children ADD COLUMN IF NOT EXISTS phonics_enabled_at timestamptz`);
    await db.query(`ALTER TABLE curriculum_activities ADD COLUMN IF NOT EXISTS content_ref text`);
    // b420 — b408/b411's tables only ever reached ladn (their migrations were
    // never run against the demo/htps/childrenscorner schemas this router is
    // also mounted under). Same lazy, per-schema, unqualified pattern as the
    // ALTERs above, so /programme/groups etc. degrade to real tables instead
    // of a 500 wherever this router runs.
    await db.query(`CREATE TABLE IF NOT EXISTS phonics_assessments (
      id                serial PRIMARY KEY,
      child_id          integer NOT NULL REFERENCES children(id),
      assessment_type   text NOT NULL CHECK (assessment_type IN ('placement', 'half_term', 'psc_practice')),
      year_key          text CHECK (year_key IN ('reception', 'year1')),
      half_term         text,
      global_week       integer,
      nonsense_correct  integer,
      nonsense_total    integer,
      fluency_wpm       numeric(6,1),
      fluency_passage   text,
      starting_week     integer,
      notes             text,
      assessed_by       integer REFERENCES staff(id),
      assessed_at       timestamptz NOT NULL DEFAULT now(),
      created_at        timestamptz NOT NULL DEFAULT now()
    )`);
    await db.query(`CREATE TABLE IF NOT EXISTS phonics_assessment_items (
      id              serial PRIMARY KEY,
      assessment_id   integer NOT NULL REFERENCES phonics_assessments(id) ON DELETE CASCADE,
      item_type       text NOT NULL CHECK (item_type IN ('gpc', 'tricky_word', 'word', 'nonsense_word')),
      ref             text NOT NULL,
      correct         boolean,
      notes           text
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_phonics_assessments_child ON phonics_assessments(child_id, assessed_at DESC)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_phonics_assessment_items_aid ON phonics_assessment_items(assessment_id)`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_phonics_assessment_items_ref ON phonics_assessment_items(item_type, ref)`);
    await db.query(`CREATE TABLE IF NOT EXISTS phonics_lessons_taught (
      id          serial PRIMARY KEY,
      room_id     integer NOT NULL REFERENCES rooms(id),
      year_key    text NOT NULL CHECK (year_key IN ('reception', 'year1')),
      week_slug   text NOT NULL,
      day         text NOT NULL CHECK (day IN ('Mon','Tue','Wed','Thu','Fri')),
      taught_on   date NOT NULL DEFAULT CURRENT_DATE,
      taught_by   integer REFERENCES staff(id),
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT phonics_lessons_taught_uq UNIQUE (room_id, week_slug, day, taught_on)
    )`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_phonics_lessons_taught_room ON phonics_lessons_taught(room_id, taught_on DESC)`);
    _b247Ensured = true;
  } catch (e) {
    console.error('[b247] ensure phonics columns failed:', e.message);
  }
}
function b247AgeMonths(dob) {
  if (!dob) return null;
  const b = new Date(dob);
  if (isNaN(b)) return null;
  const now = new Date();
  let m = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
  if (now.getDate() < b.getDate()) m -= 1;
  return m;
}

/** The child, with their switch. Returns null when there is no such child. */
async function b247LoadChild(db, childId) {
  const id = parseInt(childId, 10);
  if (!Number.isInteger(id)) return null;
  const { rows } = await db.query(`
    SELECT c.id, c.first_name, c.last_name, c.date_of_birth, c.room_id,
           c.phonics_enabled, c.phonics_started_on, c.phonics_enabled_at, c.phonics_enabled_by,
           COALESCE(s.preferred_name, s.first_name) AS enabled_by_name
      FROM children c
      LEFT JOIN staff s ON s.id = c.phonics_enabled_by
     WHERE c.id = $1`, [id]);
  return rows[0] || null;
}

/** The switch, plus the two things every phonics screen needs to know about it. */
function b247SwitchPayload(child) {
  const ageMonths = b247AgeMonths(child.date_of_birth);
  return {
    child_id: child.id,
    enabled: !!child.phonics_enabled,
    started_on: b247Ymd(child.phonics_started_on),
    enabled_at: child.phonics_enabled_at || null,
    enabled_by: child.phonics_enabled_by || null,
    enabled_by_name: child.enabled_by_name || null,
    age_months: ageMonths,
    // Whether the CVC-decoding row applies to this child. Sent even when the
    // switch is off so the child-profile card can explain what turning it on gets.
    cvc_eligible: ageMonths != null && ageMonths >= B247_CVC_MIN_MONTHS,
  };
}

// ── GET /child/:childId/switch — is this child in phonics? ─────────────────
router.get('/child/:childId/switch', async (req, res) => {
  try {
    const child = await b247LoadChild(getPool(), req.params.childId);
    if (!child) return res.status(404).json({ error: 'Child not found' });
    res.json(b247SwitchPayload(child));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /child/:childId/switch {enabled:boolean} ───────────────────────────
// Flipping this ON is the moment the child starts joining phonics sessions, so
// it records who did it and when. phonics_started_on is set once and then left
// alone: a child who pauses for a term and comes back has not started again, and
// "when did they start phonics?" has to keep having one answer.
router.put('/child/:childId/switch', async (req, res) => {
  const enabled = req.body && req.body.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false' });
  const db = getPool();
  try {
    const before = await b247LoadChild(db, req.params.childId);
    if (!before) return res.status(404).json({ error: 'Child not found' });
    const staffId = Number(req.user && req.user.id) || null;
    await db.query(`
      UPDATE children
         SET phonics_enabled    = $2,
             phonics_enabled_by = $3,
             phonics_enabled_at = NOW(),
             phonics_started_on = CASE WHEN $2 THEN COALESCE(phonics_started_on, CURRENT_DATE)
                                       ELSE phonics_started_on END
       WHERE id = $1`, [before.id, enabled, staffId]);
    try {
      recordAudit({ req, action: 'update', entity_type: 'child_phonics_switch', entity_id: before.id,
        meta: { enabled, was: !!before.phonics_enabled } });
    } catch (_) { /* auditing must never fail the switch */ }
    const after = await b247LoadChild(db, before.id);
    res.json(b247SwitchPayload(after));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/** Every phonics read/write for one child goes through here first. */
async function b247RequireSwitch(req, res) {
  const child = await b247LoadChild(getPool(), req.params.childId);
  if (!child) { res.status(404).json({ error: 'Child not found' }); return null; }
  if (!child.phonics_enabled) {
    // 409, not 403: this is not a permission problem, it is a child who is not in
    // phonics. The screens branch on `phonics_off` to show the switch instead.
    res.status(409).json({ error: 'phonics_off', child_id: child.id,
      message: 'This child is not in phonics yet. Turn phonics on from their profile to start.' });
    return null;
  }
  return child;
}

// ── GET /child/:childId/tracker — the whole grid, in one call ──────────────
// Sounds, their state, and (for the oldest band only) the CVC decoding row.
// No counts, no percentages, no "next sound" suggestion — the grid is the screen.
router.get('/child/:childId/tracker', async (req, res) => {
  try {
    const child = await b247RequireSwitch(req, res);
    if (!child) return;
    const db = getPool();
    const { rows: sounds } = await db.query(`
      SELECT phase, sound_code, sound_type, example_words, position_in_phase
        FROM phonics_sounds
       WHERE phase = ANY($1::int[]) AND sound_type = ANY($2::text[])
       ORDER BY phase, position_in_phase, id`, [B247_PHASES, B247_SOUND_TYPES]);
    const { rows: marks } = await db.query(
      'SELECT sound, status, updated_at FROM phonics_tracker WHERE child_id = $1', [child.id]);
    const bySound = new Map(marks.map(m => [m.sound, m]));

    const grid = sounds.map(s => {
      const m = bySound.get(s.sound_code);
      return {
        sound: s.sound_code,
        phase: s.phase,
        // Kept because the chip shows one example word under the letters. That is
        // the sound saying what it is, not a legend.
        example: Array.isArray(s.example_words) && s.example_words.length ? s.example_words[0] : null,
        state: (m && B247_STATE_OF[m.status]) || 'not_yet',
        updated_at: m ? m.updated_at : null,
      };
    });

    const payload = b247SwitchPayload(child);
    payload.phases = B247_PHASES;
    payload.sounds = grid;
    payload.cvc = null;
    if (payload.cvc_eligible) {
      const m = bySound.get(B247_CVC_SOUND);
      payload.cvc = {
        sound: B247_CVC_SOUND,
        label: 'Decoding CVC words',
        // cat, pin, sun. The ceiling for this age group, said out loud so the row
        // cannot be read as "and then longer words next".
        example: 'c-a-t, p-i-n, s-u-n',
        state: (m && B247_STATE_OF[m.status]) || 'not_yet',
        updated_at: m ? m.updated_at : null,
      };
    }
    res.json(payload);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /child/:childId/tracker {sound, state} ─────────────────────────────
// One tap = one call. `state` is what the chip should now be; the server maps it
// onto the phonics_tracker vocabulary and upserts. Deliberately NOT the b157
// PUT /child/:childId/sound handler above: that one also writes a "next GPC"
// next step every time a sound reaches secure, which would fire on the first tap
// of every chip here and bury the child's real next steps.
router.put('/child/:childId/tracker', async (req, res) => {
  const { sound, state } = req.body || {};
  if (!sound || typeof sound !== 'string') return res.status(400).json({ error: 'sound required' });
  if (!B247_STATUS_OF[state]) {
    return res.status(400).json({ error: 'state must be one of ' + B247_CYCLE.join(', ') });
  }
  try {
    const child = await b247RequireSwitch(req, res);
    if (!child) return;
    const db = getPool();
    let phase = null;
    if (sound === B247_CVC_SOUND) {
      if (!b247SwitchPayload(child).cvc_eligible) {
        return res.status(409).json({ error: 'cvc_not_applicable',
          message: 'CVC decoding is only tracked for the oldest children.' });
      }
      phase = 3;                                    // blending CVC sits with Phase 3 work
    } else {
      const { rows } = await db.query(
        `SELECT phase FROM phonics_sounds
          WHERE sound_code = $1 AND phase = ANY($2::int[]) AND sound_type = ANY($3::text[])
          ORDER BY phase LIMIT 1`, [sound, B247_PHASES, B247_SOUND_TYPES]);
      if (!rows.length) return res.status(400).json({ error: 'unknown_sound', sound });
      phase = rows[0].phase;
    }
    const { rows } = await db.query(`
      INSERT INTO phonics_tracker (child_id, sound, phase, status, updated_by, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (child_id, sound) DO UPDATE
        SET status = EXCLUDED.status, phase = EXCLUDED.phase,
            updated_by = EXCLUDED.updated_by, updated_at = NOW()
      RETURNING sound, status, phase, updated_at`,
      [child.id, sound, phase, B247_STATUS_OF[state], Number(req.user && req.user.id) || null]);
    res.json({ sound: rows[0].sound, phase: rows[0].phase,
               state: B247_STATE_OF[rows[0].status], updated_at: rows[0].updated_at });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Books and games that go home ───────────────────────────────────────────
// Reusing the ACTIVITY-CARD type rather than inventing a phonics card: the books
// and games are rows in curriculum_activities (seeded by
// scripts/b247-seed-phonics-cards.js from the same content pack the reader uses),
// and a next step points at one through next_steps.library_activity_id, which
// b181 already added and which the termly update, the planner and the child
// profile already render. Nothing downstream needs to learn a new shape.
const B247_BOOK_PREFIX = 'phonics-story:';
const B247_GAME_PREFIX = 'phonics-game:';

function b247CardKind(ref) {
  if (!ref) return null;
  if (ref.startsWith(B247_BOOK_PREFIX)) return 'book';
  if (ref.startsWith(B247_GAME_PREFIX)) return 'game';
  return null;
}

// GET /home-cards[?kind=book|game][?phase=2] — what a practitioner can send home.
router.get('/home-cards', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, name, description, category, age_range, resources_needed, parent_tip,
             interests, content_ref
        FROM curriculum_activities
       WHERE content_ref LIKE 'phonics-%'`);
    let cards = rows.map(r => ({
      activity_id: r.id,
      kind: b247CardKind(r.content_ref),
      ref: String(r.content_ref).split(':').slice(1).join(':'),
      name: r.name,
      description: r.description,
      age_range: r.age_range,
      resources_needed: r.resources_needed,
      parent_tip: r.parent_tip,
      // The seed tags the phase as 'phase-N' in `interests` (curriculum_activities
      // has no phase column and did not need one for this).
      phase: (() => {
        const t = (r.interests || []).find(x => /^phase-\d+$/.test(x));
        return t ? parseInt(t.slice(6), 10) : null;
      })(),
    })).filter(c => c.kind);
    if (req.query.kind)  cards = cards.filter(c => c.kind === String(req.query.kind));
    if (req.query.phase) cards = cards.filter(c => String(c.phase) === String(req.query.phase));
    // Books read as a progression, so order by phase first — alphabetical would put
    // a Phase 5 book at the top of the picker, which is the wrong first suggestion.
    cards.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'book' ? -1 : 1)
      || ((a.phase || 99) - (b.phase || 99)) || a.name.localeCompare(b.name));
    res.json({ cards, seeded: cards.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId/home-step {activity_id, note?} — send one home.
// Writes an ordinary next step. The ONLY phonics-specific thing about it is the
// card on the end of it, and that card is an activity-bank card like any other.
router.post('/child/:childId/home-step', async (req, res) => {
  const activityId = parseInt((req.body || {}).activity_id, 10);
  if (!Number.isInteger(activityId)) return res.status(400).json({ error: 'activity_id required' });
  try {
    const child = await b247RequireSwitch(req, res);
    if (!child) return;
    const db = getPool();
    const { rows: act } = await db.query(
      `SELECT id, name, content_ref FROM curriculum_activities WHERE id = $1`, [activityId]);
    if (!act.length || !b247CardKind(act[0].content_ref)) {
      return res.status(400).json({ error: 'not_a_phonics_card', activity_id: activityId });
    }
    const kind = b247CardKind(act[0].content_ref);
    // Don't stack the same card on the same child twice while it is still open.
    const { rows: dup } = await db.query(
      `SELECT id FROM next_steps
        WHERE child_id = $1 AND library_activity_id = $2 AND status IN ('pending','planned') LIMIT 1`,
      [child.id, activityId]);
    if (dup.length) return res.json({ id: dup[0].id, duplicate: true });

    const note = (req.body.note || '').toString().trim();
    const desc = (kind === 'book'
      ? `Phonics book to share at home: “${act[0].name}”`
      : `Phonics game to play at home: “${act[0].name}”`) + (note ? ` — ${note}` : '');
    const { rows } = await db.query(`
      INSERT INTO next_steps (child_id, staff_id, description, status, library_activity_id, created_at, updated_at)
      VALUES ($1, $2, $3, 'pending', $4, NOW(), NOW())
      RETURNING id, description, status, library_activity_id`,
      [child.id, Number(req.user && req.user.id) || null, desc.slice(0, 500), activityId]);
    res.status(201).json({ ...rows[0], kind });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/home-steps — what has already been sent home, so the
// practitioner is not guessing. Open steps only; closed ones are history.
router.get('/child/:childId/home-steps', async (req, res) => {
  try {
    const child = await b247RequireSwitch(req, res);
    if (!child) return;
    const { rows } = await getPool().query(`
      SELECT n.id, n.description, n.status, n.created_at,
             ca.id AS activity_id, ca.name AS activity_name, ca.content_ref
        FROM next_steps n
        JOIN curriculum_activities ca ON ca.id = n.library_activity_id
       WHERE n.child_id = $1 AND ca.content_ref LIKE 'phonics-%'
       ORDER BY n.created_at DESC LIMIT 30`, [child.id]);
    res.json(rows.map(r => ({
      id: r.id, description: r.description, status: r.status, created_at: r.created_at,
      activity_id: r.activity_id, name: r.activity_name,
      kind: b247CardKind(r.content_ref),
      ref: String(r.content_ref).split(':').slice(1).join(':'),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /enrolled — the children whose switch is on ────────────────────────
// What the tracker's child picker lists. A child whose switch is off is not in
// this list, which is the whole point: phonics does not exist for them.
router.get('/enrolled', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT c.id, c.first_name, c.last_name, c.room_id, r.name AS room_name,
             c.phonics_started_on, c.date_of_birth
        FROM children c
        LEFT JOIN rooms r ON r.id = c.room_id
       WHERE c.phonics_enabled
         AND ${operationalChildFilter('c')}
       ORDER BY c.first_name, c.last_name`);
    res.json(rows.map(c => {
      const age = b247AgeMonths(c.date_of_birth);
      return {
        id: c.id, first_name: c.first_name, last_name: c.last_name,
        room_id: c.room_id, room_name: c.room_name,
        started_on: b247Ymd(c.phonics_started_on),
        cvc_eligible: age != null && age >= B247_CVC_MIN_MONTHS,
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b408 (2026-10-08) — Full-programme assessment pack + individual tracker
//
// A DIFFERENT, bigger thing from b247's "VERY BASIC" switch tracker above
// (phonics_tracker, Phase 2/3 only, red/amber/green chips): this is the
// Reception→Year 1 programme assessment the b406 spine (schedule.json,
// programme/banks/*.json, book-plan.json) needs — half-term checks, a
// placement check for a new starter, a GPC heatmap, a same-day boost list and
// book matching. Stored in its own tables (phonics_assessments +
// phonics_assessment_items, migrations/2026-10-08-b408-phonics-assessments.sql)
// so neither tracker has to bend to fit the other's shape. Not gated behind
// b247RequireSwitch — that switch is specifically the nursery Phase 2/3 grid;
// this assessment pack is for the full programme and any child on it.
// ═══════════════════════════════════════════════════════════════════════════

const assessLib = require('../../scripts/phonics/assessment-content');
const lessonData = require('../../scripts/phonics/lesson-data');
const pictureBank = require('../../scripts/printables/picture-bank'); // b430 — cue pictures, reused not redrawn

const B408_ITEM_TYPES = new Set(['gpc', 'tricky_word', 'word', 'nonsense_word']);
const B408_ASSESSMENT_TYPES = new Set(['placement', 'half_term', 'psc_practice']);

// Every (item_type, ref) pair this child has ever been tested on, keeping only
// the most recent result per pair (a GPC re-taught and re-tested later should
// read by its latest result, not its first). `ref` is matched case-sensitively
// as stored — callers that need case-insensitive matching (tricky words) lower
// it themselves.
async function b408LatestItems(db, childId, itemType) {
  const { rows } = await db.query(`
    SELECT DISTINCT ON (ai.ref) ai.ref, ai.correct, pa.assessed_at
      FROM phonics_assessment_items ai
      JOIN phonics_assessments pa ON pa.id = ai.assessment_id
     WHERE pa.child_id = $1 AND ai.item_type = $2
     ORDER BY ai.ref, pa.assessed_at DESC, ai.id DESC`, [childId, itemType]);
  return rows;
}
async function b408SecureSet(db, childId, itemType, { lower = false } = {}) {
  const rows = await b408LatestItems(db, childId, itemType);
  const out = new Set();
  for (const r of rows) if (r.correct === true) out.add(lower ? String(r.ref).toLowerCase() : r.ref);
  return out;
}

// ── Half-term/placement content (what to test) ──────────────────────────────

// GET /assessment/half-terms — the 12 half-terms, each with its review week
// and end-of-half-term cumulative GPC/tricky-word sets (for a year/half-term picker).
router.get('/assessment/half-terms', (req, res) => {
  try { res.json(assessLib.halfTerms()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /assessment/half-terms/:slug — what THIS half-term's assessment should
// test: its own new GPCs/alternatives/tricky words, plus already-validated
// words/nonsense-words/a sentence pulled straight from its own banks.
router.get('/assessment/half-terms/:slug', (req, res) => {
  try {
    const ht = assessLib.halfTermBySlug(req.params.slug);
    if (!ht) return res.status(404).json({ error: 'not_found' });
    res.json({ ...ht, ...assessLib.halfTermAssessmentContent(ht.year_key, ht.half_term) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /assessment/placement-content — the full 108-GPC catalog (phase 2-6 +
// the 6 Phase 5b alternative-spelling graphemes) and the full tricky-word
// list, for a placement check's GPC-recognition grid and word/tricky-word lists.
router.get('/assessment/placement-content', (req, res) => {
  try {
    res.json({ gpcs: assessLib.gpcsOrdered(), tricky_words: assessLib.trickyWordsOrdered() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Recording an assessment ──────────────────────────────────────────────────

// POST /child/:childId/assessment — record one assessment (placement,
// half_term or psc_practice), item by item. Placement assessments compute and
// store a starting_week from the GPC items marked correct — the whole point
// of a placement check.
// body: { assessment_type, year_key?, half_term?, global_week?, items:[{item_type,ref,correct,notes?}],
//         nonsense_correct?, nonsense_total?, fluency_wpm?, fluency_passage?, notes? }
router.post('/child/:childId/assessment', async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'invalid_child_id' });
  const body = req.body || {};
  if (!B408_ASSESSMENT_TYPES.has(body.assessment_type)) {
    return res.status(400).json({ error: 'assessment_type must be one of ' + [...B408_ASSESSMENT_TYPES].join(', ') });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  for (const it of items) {
    if (!B408_ITEM_TYPES.has(it.item_type) || !it.ref) {
      return res.status(400).json({ error: 'each item needs a valid item_type and a ref' });
    }
  }
  const db = getPool();
  const { rows: kids } = await db.query('SELECT id FROM children WHERE id=$1', [childId]).catch(() => ({ rows: [] }));
  if (!kids.length) return res.status(404).json({ error: 'Child not found' });

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`
      INSERT INTO phonics_assessments
        (child_id, assessment_type, year_key, half_term, global_week,
         nonsense_correct, nonsense_total, fluency_wpm, fluency_passage, notes, assessed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING *`,
      [childId, body.assessment_type, body.year_key || null, body.half_term || null,
       body.global_week || null, body.nonsense_correct ?? null, body.nonsense_total ?? null,
       body.fluency_wpm ?? null, body.fluency_passage || null, body.notes || null,
       Number(req.user && req.user.id) || null]);
    const assessment = rows[0];

    for (const it of items) {
      await client.query(`
        INSERT INTO phonics_assessment_items (assessment_id, item_type, ref, correct, notes)
        VALUES ($1,$2,$3,$4,$5)`,
        [assessment.id, it.item_type, String(it.ref), it.correct === true, it.notes || null]);
    }

    // Placement result: score the GPC items just submitted (not the child's
    // whole history — a placement check is a one-off snapshot) and store
    // where the schedule says to start teaching.
    if (body.assessment_type === 'placement') {
      const secure = new Set(items.filter((it) => it.item_type === 'gpc' && it.correct === true).map((it) => it.ref));
      const result = assessLib.computeStartingWeek(secure);
      const { rows: updated } = await client.query(
        'UPDATE phonics_assessments SET starting_week=$1 WHERE id=$2 RETURNING *',
        [result.global_week, assessment.id]);
      await client.query('COMMIT');
      return res.status(201).json({ ...updated[0], starting_week_result: result, item_count: items.length });
    }

    await client.query('COMMIT');
    res.status(201).json({ ...assessment, item_count: items.length });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// GET /child/:childId/assessments — this child's assessment history (summary only).
router.get('/child/:childId/assessments', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT pa.*, st.first_name || ' ' || st.last_name AS assessed_by_name,
             (SELECT count(*)::int FROM phonics_assessment_items ai WHERE ai.assessment_id = pa.id) AS item_count,
             (SELECT count(*)::int FROM phonics_assessment_items ai WHERE ai.assessment_id = pa.id AND ai.correct = true) AS correct_count
        FROM phonics_assessments pa
        LEFT JOIN staff st ON st.id = pa.assessed_by
       WHERE pa.child_id = $1
       ORDER BY pa.assessed_at DESC`, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/assessment/:id — one assessment, with its items.
router.get('/child/:childId/assessment/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT pa.*, st.first_name || ' ' || st.last_name AS assessed_by_name
        FROM phonics_assessments pa LEFT JOIN staff st ON st.id = pa.assessed_by
       WHERE pa.id = $1 AND pa.child_id = $2`, [req.params.id, req.params.childId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const { rows: items } = await db.query(
      'SELECT * FROM phonics_assessment_items WHERE assessment_id=$1 ORDER BY item_type, id', [req.params.id]);
    res.json({ ...rows[0], items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Heatmap ───────────────────────────────────────────────────────────────────

// GET /child/:childId/heatmap — every catalog GPC against this child's latest
// result for it: secure / not_secure (tested, not yet right) / not_assessed.
router.get('/child/:childId/heatmap', async (req, res) => {
  try {
    const db = getPool();
    const latest = await b408LatestItems(db, req.params.childId, 'gpc');
    const byRef = new Map(latest.map((r) => [r.ref, r]));
    const gpcs = assessLib.gpcsOrdered().map((g) => {
      const m = byRef.get(g.grapheme);
      return {
        grapheme: g.grapheme, phase: g.phase, sound_type: g.sound_type,
        status: !m ? 'not_assessed' : (m.correct ? 'secure' : 'not_secure'),
        last_assessed_at: m ? m.assessed_at : null,
      };
    });
    const secure = gpcs.filter((g) => g.status === 'secure').length;
    res.json({ child_id: parseInt(req.params.childId, 10), gpcs, secure_count: secure, total: gpcs.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Same-day boost ────────────────────────────────────────────────────────────

// GET /child/:childId/boost — GPCs/tricky words to boost from this child's
// LATEST half-term assessment (the ones marked not-correct there).
router.get('/child/:childId/boost', async (req, res) => {
  try {
    const db = getPool();
    const { rows: latest } = await db.query(`
      SELECT * FROM phonics_assessments
       WHERE child_id=$1 AND assessment_type='half_term'
       ORDER BY assessed_at DESC LIMIT 1`, [req.params.childId]);
    if (!latest.length) return res.json({ child_id: parseInt(req.params.childId, 10), assessment: null, boost: [] });
    const { rows: items } = await db.query(`
      SELECT item_type, ref FROM phonics_assessment_items
       WHERE assessment_id=$1 AND correct=false ORDER BY item_type, ref`, [latest[0].id]);
    res.json({ child_id: parseInt(req.params.childId, 10), assessment: latest[0], boost: items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /boost-list?room_id= — which children (across a room) need a same-day
// boost from their latest half-term assessment, and what on.
router.get('/boost-list', async (req, res) => {
  const { room_id } = req.query;
  try {
    const db = getPool();
    const params = [];
    let childSql = `SELECT id, first_name, last_name, room_id FROM children
                      WHERE COALESCE(status,'active')='active' AND (leave_date IS NULL OR leave_date > CURRENT_DATE)`;
    if (room_id) { params.push(room_id); childSql += ` AND room_id=$${params.length}`; }
    const { rows: children } = await db.query(childSql, params);
    if (!children.length) return res.json([]);
    const ids = children.map((c) => c.id);
    const { rows } = await db.query(`
      WITH latest AS (
        SELECT DISTINCT ON (child_id) id, child_id, assessed_at, half_term, year_key
          FROM phonics_assessments
         WHERE assessment_type='half_term' AND child_id = ANY($1::int[])
         ORDER BY child_id, assessed_at DESC
      )
      SELECT l.child_id, l.half_term, l.year_key, l.assessed_at, ai.item_type, ai.ref
        FROM latest l JOIN phonics_assessment_items ai ON ai.assessment_id = l.id
       WHERE ai.correct = false
       ORDER BY l.child_id`, [ids]);
    const byChild = new Map(children.map((c) => [c.id, { ...c, half_term: null, year_key: null, assessed_at: null, boost: [] }]));
    for (const r of rows) {
      const entry = byChild.get(r.child_id);
      if (!entry) continue;
      entry.half_term = r.half_term; entry.year_key = r.year_key; entry.assessed_at = r.assessed_at;
      entry.boost.push({ item_type: r.item_type, ref: r.ref });
    }
    res.json([...byChild.values()].filter((c) => c.boost.length));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Book match ────────────────────────────────────────────────────────────────

// b420 — one place, one version (was copied verbatim into /programme/groups).
function b408BookCatalog() {
  const bp = lessonData.bookPlan();
  const byFile = new Map(bp.existing_books.map((b) => [b.file, b]));
  return listStoryFiles().map((f) => {
    const s = readJSON(path.join('stories', f));
    if (!s) return null;
    const meta = byFile.get(f);
    return {
      slug: s.slug, title: s.title, phase: s.phase,
      gpcs_available: s.gpcs_available || [],
      tricky_words_available: s.tricky_words_available || [],
      assigned_global_week: meta ? meta.assigned_global_week : null,
    };
  }).filter(Boolean);
}
function b408MatchBooks(stories, secureGpc, secureTricky) {
  const matches = stories.filter((s) =>
    s.gpcs_available.every((g) => secureGpc.has(g)) &&
    s.tricky_words_available.every((t) => secureTricky.has(String(t).toLowerCase())));
  // 2026-10-09: wordless / read-aloud books carry assigned_global_week 999 ("any time") and decode with no
  // sounds at all, so they sorted FIRST as the "most demanding" match. A book with real words always wins.
  const wk = (s) => (s.gpcs_available.length && s.assigned_global_week !== 999 ? s.assigned_global_week || 0 : -1);
  matches.sort((a, b) => wk(b) - wk(a));
  return matches;
}
// Batched version of b408SecureSet for a whole room at once — /programme/groups
// was running 2 queries per child; this runs 2 queries total regardless of room size.
async function b408SecureSetsForChildren(db, childIds, itemType, { lower = false } = {}) {
  const out = new Map(childIds.map((id) => [id, new Set()]));
  if (!childIds.length) return out;
  const { rows } = await db.query(`
    SELECT DISTINCT ON (pa.child_id, ai.ref) pa.child_id, ai.ref, ai.correct, pa.assessed_at
      FROM phonics_assessment_items ai
      JOIN phonics_assessments pa ON pa.id = ai.assessment_id
     WHERE pa.child_id = ANY($1) AND ai.item_type = $2
     ORDER BY pa.child_id, ai.ref, pa.assessed_at DESC, ai.id DESC`, [childIds, itemType]);
  for (const r of rows) {
    if (r.correct === true) out.get(r.child_id).add(lower ? String(r.ref).toLowerCase() : r.ref);
  }
  return out;
}

// GET /child/:childId/book-match — the shipped decodable books whose
// gpcs_available/tricky_words_available are fully covered by this child's
// secure set — "the right book" for reading practice and home. Most
// demanding fully-decodable book first (closest to their actual level).
router.get('/child/:childId/book-match', async (req, res) => {
  try {
    const db = getPool();
    const secureGpc = await b408SecureSet(db, req.params.childId, 'gpc');
    const secureTricky = await b408SecureSet(db, req.params.childId, 'tricky_word', { lower: true });
    const stories = b408BookCatalog();
    const matches = b408MatchBooks(stories, secureGpc, secureTricky);
    res.json({
      child_id: parseInt(req.params.childId, 10),
      secure_gpc_count: secureGpc.size,
      secure_tricky_count: secureTricky.size,
      recommended: matches[0] || null,
      matches,
      total_books: stories.length,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b411 (2026-10-08) — Programme hub: which week each room/class is on, today's
// lesson (read from the b406/b407 per-day lesson JSON, no PDF/puppeteer
// involved — see reference_puppeteer_cannot_run_in_wren_image), reading
// groups by matched book, and assessments due. Read-only except the two
// manager settings and "mark taught" below. The room's own pacing lives in
// ladn.settings as small JSON blobs (see migration b411-phonics-programme-hub)
// — not a column on ladn.rooms, which has year_group/key_stage used by other
// unrelated features.
// ═══════════════════════════════════════════════════════════════════════════

const PROGRAMME_DIR = path.join(CONTENT_DIR, 'programme');

function b411IsManager(req) {
  // b420 — was its own diverging, hard-coded-id check; now delegates to the
  // file's canonical isManagerish() (l.645) plus rolesHeldBy() for 'owner',
  // which isManagerish doesn't cover.
  return isManagerish(req.user) || authenticate.rolesHeldBy(req.user?.role).includes('manager');
}

// Europe/London "today", independent of the container/DB's own timezone (which
// is UTC) — getDay()/toISOString() go a day wrong between 00:00 and 01:00 BST.
function b411LondonDayName(date) {
  const wd = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', weekday: 'short' }).format(date || new Date());
  return lessonData.DAY_ORDER.includes(wd) ? wd : null; // null for Sat/Sun
}
function b411LondonYmd(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date || new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// All 72 weeks (Reception + Year 1), each tagged with its half-term NAME (not
// just the slug lesson-data.js's own allWeeks() returns) — needed to resolve
// the on-disk lesson file path.
function b411AllWeeksWithHalfTerm() {
  const s = lessonData.schedule();
  const out = [];
  for (const yearKey of ['reception', 'year1']) {
    for (const ht of s[yearKey].half_terms) {
      for (const w of ht.weeks) {
        out.push({
          global_week: w.global_week, year_key: yearKey, half_term: ht.name, week: w.week,
          slug: lessonData.weekSlug(yearKey, ht.name, w.week),
          role: w.role, focus: w.focus,
          is_settling_week: !!w.is_settling_week, is_consolidation_week: !!w.is_consolidation_week,
          is_review_week: !!w.is_review_week, is_psc_review_block: !!w.is_psc_review_block,
        });
      }
    }
  }
  return out;
}
let _b411WeekIndex = null;
function b411WeekMeta(globalWeek) {
  if (!_b411WeekIndex) {
    _b411WeekIndex = new Map(b411AllWeeksWithHalfTerm().map((w) => [w.global_week, w]));
  }
  return _b411WeekIndex.get(globalWeek) || null;
}
function b411TotalWeeks() {
  const s = lessonData.schedule();
  return ['reception', 'year1'].reduce((n, yk) =>
    n + s[yk].half_terms.reduce((m, ht) => m + ht.weeks.length, 0), 0);
}
function b411LessonFilePath(yearKey, halfTermName, weekNum) {
  return path.join(PROGRAMME_DIR, 'lessons', yearKey, lessonData.halfTermSlug(halfTermName), `week-${weekNum}.json`);
}
function b411ReadLessonWeek(yearKey, halfTermName, weekNum) {
  const file = b411LessonFilePath(yearKey, halfTermName, weekNum);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

// ── School settings (ladn.settings key/value, same pattern as phonics_scheme) ─

async function b411GetSettings(db) {
  const { rows } = await db.query(
    `SELECT key, value FROM settings WHERE key IN ('phonics_programme_reception_start','phonics_programme_rooms')`);
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  let rooms = {};
  try { rooms = JSON.parse(byKey.phonics_programme_rooms || '{}'); } catch (e) { rooms = {}; }
  return { reception_start: byKey.phonics_programme_reception_start || null, rooms };
}

// Best-effort "if Reception started on this date, counting real term weeks
// (skipping holidays via ladn.school_terms), they'd theoretically be on week
// N now" — a helper suggestion only. The authoritative value is whatever a
// manager has actually set per room via PUT /programme/rooms/:roomId.
async function b411SuggestedWeek(db, startDateStr) {
  const startDate = new Date(startDateStr);
  if (isNaN(startDate.getTime())) return { method: 'none', note: 'Invalid start date.' };
  const { rows: terms } = await db.query(
    `SELECT name, start_date, end_date FROM school_terms ORDER BY start_date`);
  if (!terms.length) {
    return { method: 'none', note: 'No term dates set (Settings → Term dates) — cannot suggest a week yet.' };
  }
  const today = new Date();
  let weeksElapsed = 0;
  let touched = false;
  for (const t of terms) {
    const htStart = new Date(t.start_date);
    const htEnd = new Date(t.end_date);
    if (htEnd < startDate) continue;          // half-term entirely before the start date
    if (htStart > today) break;               // not reached yet
    touched = true;
    const effectiveStart = htStart < startDate ? startDate : htStart;
    const cappedToday = today < htEnd ? today : htEnd;
    const daysElapsed = Math.floor((cappedToday - effectiveStart) / 86400000);
    weeksElapsed += Math.min(6, Math.max(0, Math.floor(daysElapsed / 7) + 1));
    if (today <= htEnd) break;                // currently inside this half-term
  }
  if (!touched) return { method: 'none', note: 'Start date is in the future, or outside the configured term dates.' };
  const globalWeek = Math.min(Math.max(1, weeksElapsed), b411TotalWeeks());
  const meta = b411WeekMeta(globalWeek);
  return {
    method: 'school_terms', global_week: globalWeek,
    year_key: meta ? meta.year_key : null, half_term: meta ? meta.half_term : null, week: meta ? meta.week : null,
  };
}

// How many FULL term-weeks (school_terms, holidays excluded) have elapsed
// since a room's week was last set — so "Today's lesson" advances on its own
// every Monday instead of staying wherever a manager last left it.
async function b411TermWeeksElapsedSince(db, sinceDateStr) {
  const since = new Date(sinceDateStr);
  if (isNaN(since.getTime())) return 0;
  const { rows: terms } = await db.query(`SELECT start_date, end_date FROM school_terms ORDER BY start_date`);
  if (!terms.length) return 0;
  const today = new Date();
  let weeks = 0;
  for (const t of terms) {
    const htStart = new Date(t.start_date), htEnd = new Date(t.end_date);
    if (htEnd < since) continue;
    if (htStart > today) break;
    const effectiveStart = htStart < since ? since : htStart;
    const cappedToday = today < htEnd ? today : htEnd;
    const daysElapsed = Math.floor((cappedToday - effectiveStart) / 86400000);
    weeks += Math.max(0, Math.floor(daysElapsed / 7));
    if (today <= htEnd) break;
  }
  return weeks;
}
// The room's stored global_week, advanced by however many full term-weeks
// have passed since `set_on` (older rows with no set_on are returned as-is —
// back-compat with programme values saved before this field existed).
async function b411EffectiveGlobalWeek(db, programme) {
  if (!programme.set_on) return programme.global_week;
  const elapsed = await b411TermWeeksElapsedSince(db, programme.set_on);
  return Math.min(programme.global_week + elapsed, b411TotalWeeks());
}
// The half-term whose REVIEW week has most recently been reached for this
// year_key — i.e. the half-term an assessment is actually due for right now.
// null before the first half-term's review week.
function b411ReviewHalfTermFor(yearKey, effectiveGlobalWeek) {
  let candidate = null;
  for (const w of b411AllWeeksWithHalfTerm()) {
    if (w.year_key === yearKey && w.is_review_week && w.global_week <= effectiveGlobalWeek) candidate = w;
  }
  return candidate;
}

// GET /programme/weeks — the 72-week picker list (schedule.json only, no lesson JSON reads).
router.get('/programme/weeks', (req, res) => {
  try { res.json(b411AllWeeksWithHalfTerm()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /programme/rooms — every room, its phonics-enabled child count, and its
// current {year_key, global_week} if a manager has set one.
router.get('/programme/rooms', async (req, res) => {
  try {
    const db = getPool();
    const settings = await b411GetSettings(db);
    const { rows } = await db.query(`
      SELECT r.id, r.name, r.display_name,
             (SELECT COUNT(*)::int FROM children c
               WHERE c.room_id = r.id AND c.phonics_enabled AND ${operationalChildFilter('c')}) AS phonics_children
        FROM rooms r ORDER BY r.id`);
    const rooms = [];
    for (const r of rows) {
      const programme = settings.rooms[String(r.id)] || null;
      rooms.push({
        ...r, programme,
        effective_global_week: programme ? await b411EffectiveGlobalWeek(db, programme) : null,
      });
    }
    res.json({ reception_start: settings.reception_start, rooms });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /programme/suggested-week — the "Reception starts on <date>" helper.
router.get('/programme/suggested-week', async (req, res) => {
  try {
    const db = getPool();
    const settings = await b411GetSettings(db);
    if (!settings.reception_start) return res.json({ method: 'none', note: 'Set "Reception starts on" first.' });
    res.json(await b411SuggestedWeek(db, settings.reception_start));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /programme/reception-start — manager sets the helper's start date. {date:'YYYY-MM-DD'}
router.put('/programme/reception-start', async (req, res) => {
  if (!b411IsManager(req)) return res.status(403).json({ error: 'Manager access required' });
  const date = String((req.body || {}).date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  try {
    await getPool().query(`
      INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('phonics_programme_reception_start',$1,$2,NOW())
      ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=NOW()`,
      [date, Number(req.user.id) || null]);
    res.json({ ok: true, reception_start: date });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /programme/rooms/:roomId — manager sets which week this room/class is
// on. {year_key:'reception'|'year1', global_week:1-72}
router.put('/programme/rooms/:roomId', async (req, res) => {
  if (!b411IsManager(req)) return res.status(403).json({ error: 'Manager access required' });
  const roomId = parseInt(req.params.roomId, 10);
  const { year_key } = req.body || {};
  const globalWeek = parseInt((req.body || {}).global_week, 10);
  if (!['reception', 'year1'].includes(year_key)) return res.status(400).json({ error: "year_key must be 'reception' or 'year1'" });
  const total = b411TotalWeeks();
  if (!Number.isInteger(globalWeek) || globalWeek < 1 || globalWeek > total) {
    return res.status(400).json({ error: `global_week must be between 1 and ${total}` });
  }
  const meta = b411WeekMeta(globalWeek);
  if (!meta || meta.year_key !== year_key) return res.status(400).json({ error: 'global_week does not belong to that year_key' });
  try {
    const db = getPool();
    const { rows: roomRows } = await db.query('SELECT id FROM rooms WHERE id=$1', [roomId]);
    if (!roomRows.length) return res.status(404).json({ error: 'Room not found' });
    // set_on drives b411EffectiveGlobalWeek's auto-advance. jsonb_set on the
    // stored value, inside one UPDATE, so two managers saving two different
    // rooms at once can't clobber each other (was a JS read-modify-write).
    const entry = { year_key, global_week: globalWeek, set_on: b411LondonYmd() };
    await db.query(`
      INSERT INTO settings (key, value, updated_by, updated_at)
      VALUES ('phonics_programme_rooms', jsonb_build_object($1::text, $2::jsonb)::text, $3, NOW())
      ON CONFLICT (key) DO UPDATE SET
        value = jsonb_set(COALESCE(settings.value::jsonb, '{}'::jsonb), ARRAY[$1::text], $2::jsonb, true)::text,
        updated_by = $3, updated_at = NOW()`,
      [String(roomId), JSON.stringify(entry), Number(req.user.id) || null]);
    res.json({ ok: true, room_id: roomId, programme: entry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /programme/lesson/:yearKey/:weekSlug — one full week's day-by-day lesson
// JSON, straight off disk — the in-page "slides" viewer reads this directly
// rather than rendering a PDF (nothing here needs puppeteer/pdfkit at request time).
router.get('/programme/lesson/:yearKey/:weekSlug', (req, res) => {
  const { yearKey, weekSlug } = req.params;
  if (!['reception', 'year1'].includes(yearKey)) return res.status(400).json({ error: 'invalid year_key' });
  try {
    const meta = b411AllWeeksWithHalfTerm().find((w) => w.year_key === yearKey && w.slug === weekSlug);
    if (!meta) return res.status(404).json({ error: 'not_found' });
    const lesson = b411ReadLessonWeek(yearKey, meta.half_term, meta.week);
    if (!lesson) return res.status(404).json({ error: 'lesson_not_generated' });
    res.json({ ...lesson, half_term: meta.half_term });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /programme/today?room_id= — the Today's Lesson card: this room's
// current week + today's specific day (Mon-Fri) + whether it's already been
// marked taught today.
router.get('/programme/today', async (req, res) => {
  const roomId = parseInt(req.query.room_id, 10);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'room_id required' });
  try {
    const db = getPool();
    const settings = await b411GetSettings(db);
    const programme = settings.rooms[String(roomId)];
    if (!programme) {
      return res.json({ room_id: roomId, programme: null, message: 'No phonics week set for this room yet — set one above.' });
    }
    // b420 — was the manager's stale stored global_week forever; now advances
    // on its own by however many full term-weeks have passed (#7), and uses
    // Europe/London for "today" rather than the container's UTC (#15) — both
    // matter most on a weekend/Monday-morning boundary.
    const effectiveWeek = await b411EffectiveGlobalWeek(db, programme);
    const meta = b411WeekMeta(effectiveWeek);
    if (!meta) return res.status(500).json({ error: 'week_not_found', global_week: effectiveWeek });
    const weekLesson = b411ReadLessonWeek(meta.year_key, meta.half_term, meta.week);

    const todayName = b411LondonDayName();
    const isWeekend = todayName == null;
    const dayName = isWeekend ? 'Mon' : todayName; // weekend preview: the upcoming Monday, already on the advanced week
    const day = weekLesson ? (weekLesson.days || []).find((d) => d.day === dayName) || null : null;

    let taught = false;
    if (!isWeekend) {
      const { rows } = await db.query(
        `SELECT 1 FROM phonics_lessons_taught WHERE room_id=$1 AND week_slug=$2 AND day=$3 AND taught_on=$4`,
        [roomId, meta.slug, dayName, b411LondonYmd()]);
      taught = rows.length > 0;
    }

    const b439Sheet = b439PictureSheetFor(meta.year_key, effectiveWeek);

    res.json({
      room_id: roomId,
      programme: { ...programme, effective_global_week: effectiveWeek },
      week: { ...meta, matched_book: weekLesson ? weekLesson.matched_book : null, week_focus: weekLesson ? weekLesson.focus : meta.focus },
      is_weekend: isWeekend,
      day_name: dayName,
      day,
      taught,
      picture_sheets_url: b439Sheet ? b439PictureSheetUrl(b439Sheet) : null,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /programme/lesson-taught — mark a specific room/week/day as taught
// today. Idempotent (ON CONFLICT DO NOTHING on room+week+day+date).
router.post('/programme/lesson-taught', async (req, res) => {
  const b = req.body || {};
  const roomId = parseInt(b.room_id, 10);
  if (!Number.isInteger(roomId) || !['reception', 'year1'].includes(b.year_key) ||
      !b.week_slug || !lessonData.DAY_ORDER.includes(b.day)) {
    return res.status(400).json({ error: 'room_id, year_key, week_slug and a valid day are required' });
  }
  // b420 — didn't check week_slug actually belongs to year_key, and let a
  // weekend "Mark taught" (the UI always sent day:'Mon' on Sat/Sun — #15)
  // post a Saturday taught_on for a lesson that was never shown.
  const weekMeta = b411AllWeeksWithHalfTerm().find((w) => w.year_key === b.year_key && w.slug === b.week_slug);
  if (!weekMeta) return res.status(400).json({ error: 'Unknown week_slug for that year_key' });
  if (b411LondonDayName() == null) return res.status(400).json({ error: 'There is no lesson to mark taught over the weekend' });
  try {
    await getPool().query(`
      INSERT INTO phonics_lessons_taught (room_id, year_key, week_slug, day, taught_on, taught_by)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (room_id, week_slug, day, taught_on) DO NOTHING`,
      [roomId, b.year_key, b.week_slug, b.day, b411LondonYmd(), Number(req.user.id) || null]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Reading groups: matched book per child + its session card ───────────────

const B411_SESSION_CARDS_FILE = path.join(PROGRAMME_DIR, 'reading-practice', 'session-cards.json');
let _b411SessionCardsCache = null;
let _b411SessionCardsMtime = 0;
function b411SessionCards() {
  // b420 — cached forever (never refreshed); a regenerated session-cards.json
  // (new books, fixed cards) needed a process restart to show up. Keyed on
  // mtime instead, same idea as b408EnsureColumns's "cheap check every call".
  let mtime = 0;
  try { mtime = fs.statSync(B411_SESSION_CARDS_FILE).mtimeMs; } catch (e) { /* file missing */ }
  if (_b411SessionCardsCache && mtime === _b411SessionCardsMtime) return _b411SessionCardsCache;
  try {
    const data = JSON.parse(fs.readFileSync(B411_SESSION_CARDS_FILE, 'utf8'));
    _b411SessionCardsCache = data.cards || [];
    _b411SessionCardsMtime = mtime;
  } catch (e) { _b411SessionCardsCache = []; }
  return _b411SessionCardsCache;
}

// GET /programme/reading-session/:slug — the reading-practice session card
// (comprehension questions, pre-teach vocab, prosody focus) for one book.
router.get('/programme/reading-session/:slug', (req, res) => {
  const card = b411SessionCards().find((c) => c.slug === req.params.slug);
  if (!card) return res.status(404).json({ error: 'not_found' });
  res.json(card);
});

// GET /programme/groups?room_id= — phonics-enabled children in the room,
// grouped by their matched decodable book (same matching rule as
// /child/:childId/book-match), each group flagged with whether a
// reading-practice session card already exists for that book.
router.get('/programme/groups', async (req, res) => {
  const roomId = parseInt(req.query.room_id, 10);
  try {
    const db = getPool();
    const params = [];
    let where = `WHERE c.phonics_enabled AND ${operationalChildFilter('c')}`;
    if (Number.isInteger(roomId)) { params.push(roomId); where += ` AND c.room_id=$${params.length}`; }
    const { rows: children } = await db.query(
      `SELECT c.id, c.first_name, c.last_name, c.room_id FROM children c ${where} ORDER BY c.first_name`, params);

    const stories = b408BookCatalog();
    const cardSlugs = new Set(b411SessionCards().map((c) => c.slug));
    const childIds = children.map((c) => c.id);
    const secureGpcByChild = await b408SecureSetsForChildren(db, childIds, 'gpc');
    const secureTrickyByChild = await b408SecureSetsForChildren(db, childIds, 'tricky_word', { lower: true });

    const groups = new Map();
    for (const child of children) {
      const matches = b408MatchBooks(stories, secureGpcByChild.get(child.id), secureTrickyByChild.get(child.id));
      const best = matches[0] || null;
      const key = best ? best.slug : '__none__';
      if (!groups.has(key)) {
        groups.set(key, { book: best, has_session_card: best ? cardSlugs.has(best.slug) : false, children: [] });
      }
      groups.get(key).children.push({ id: child.id, first_name: child.first_name, last_name: child.last_name });
    }
    res.json([...groups.values()]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /programme/assessments-due?room_id= — phonics-enabled children in this
// room with no half_term assessment recorded yet for the room's CURRENT
// half-term. A thin, honest "who's due" list — not a rebuild of the existing
// assessment/heatmap/boost pages, which this links to instead.
router.get('/programme/assessments-due', async (req, res) => {
  const roomId = parseInt(req.query.room_id, 10);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'room_id required' });
  try {
    const db = getPool();
    const settings = await b411GetSettings(db);
    const programme = settings.rooms[String(roomId)];
    if (!programme) return res.json({ room_id: roomId, half_term: null, due: [] });
    // b420 — was due from week 1 of the current half-term (the assessment
    // actually happens in that half-term's review week); now the "due"
    // half-term is whichever one's review week was most recently reached —
    // carrying over from a previous half-term if that one's still missing.
    const effectiveWeek = await b411EffectiveGlobalWeek(db, programme);
    const reviewHt = b411ReviewHalfTermFor(programme.year_key, effectiveWeek);
    if (!reviewHt) return res.json({ room_id: roomId, year_key: programme.year_key, half_term: null, due: [], note: 'No half-term review reached yet.' });
    const halfTerm = reviewHt.half_term;
    const { rows: children } = await db.query(
      `SELECT c.id, c.first_name, c.last_name FROM children c
        WHERE c.phonics_enabled AND c.room_id=$1 AND ${operationalChildFilter('c')}`, [roomId]);
    const due = [];
    for (const child of children) {
      const { rows } = await db.query(
        `SELECT 1 FROM phonics_assessments WHERE child_id=$1 AND assessment_type='half_term' AND half_term=$2 AND year_key=$3`,
        [child.id, halfTerm, programme.year_key]);
      if (!rows.length) due.push(child);
    }
    res.json({ room_id: roomId, year_key: programme.year_key, half_term: halfTerm, due });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
// Reused by the first-run setup wizard (src/routes/setup.js) — additive export.
module.exports.PHONICS_SCHEMES = PHONICS_SCHEMES;

// b247 — the content pack, for the PARENT-side handlers in
// editions/*/server-unified.js. Those live outside this router (a parent has no
// staff JWT, so they are gated by requireParentIdentity instead of authenticate),
// and they must resolve exactly the same book and game a practitioner sent home.
// Exported rather than re-implemented so there is one reader of these files.
module.exports.b247 = {
  BOOK_PREFIX: B247_BOOK_PREFIX,
  GAME_PREFIX: B247_GAME_PREFIX,
  cardKind: b247CardKind,
  /** One decodable story by slug, with its cast resolved. null when unknown. */
  story(slug) {
    const s = listStoryFiles().map(f => readJSON(path.join('stories', f)))
      .find(x => x && x.slug === slug);
    return s ? { ...s, cast: castFor(s) } : null;
  },
  /** One game by its content-pack id. null when unknown. */
  game(id) {
    return loadContentPack().games.find(g => g && g.id === id) || null;
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// b430 (2026-10-08) — exported for src/routes/parents.js ("Phonics at home"
// card) and the EY board-mode viewer. Same reuse rule as module.exports.b247
// above: one reader of the room-programme/lesson/book files, never a second
// implementation of the matching logic.
// ═══════════════════════════════════════════════════════════════════════════

// Same shape /programme/today builds (room's current week + today's day),
// plus the week-level new_gpcs/new_alternatives/new_tricky_words that route
// doesn't need but a parent "this week's sounds" card does. A standalone
// function rather than a refactor of that already-reviewed route handler.
async function b430TodayForRoom(db, roomId) {
  const settings = await b411GetSettings(db);
  const programme = settings.rooms[String(roomId)];
  if (!programme) return { programme: null };
  const effectiveWeek = await b411EffectiveGlobalWeek(db, programme);
  const meta = b411WeekMeta(effectiveWeek);
  if (!meta) return { programme: null };
  const weekLesson = b411ReadLessonWeek(meta.year_key, meta.half_term, meta.week);
  const todayName = b411LondonDayName();
  const isWeekend = todayName == null;
  const dayName = isWeekend ? 'Mon' : todayName;
  const day = weekLesson ? (weekLesson.days || []).find((d) => d.day === dayName) || null : null;
  return {
    programme: { ...programme, effective_global_week: effectiveWeek },
    week: {
      ...meta,
      matched_book: weekLesson ? weekLesson.matched_book : null,
      week_focus: weekLesson ? weekLesson.focus : meta.focus,
      new_gpcs: weekLesson ? weekLesson.new_gpcs : [],
      new_alternatives: weekLesson ? weekLesson.new_alternatives : [],
      new_tricky_words: weekLesson ? weekLesson.new_tricky_words : [],
    },
    is_weekend: isWeekend,
    day_name: dayName,
    day,
  };
}

// The weekly home-slip PDFs (b421) — manifest keyed by slug, looked up here by
// (year_key, global_week) since that's what a room/child resolves to.
const B430_HOME_SLIPS_MANIFEST = path.join(PROGRAMME_DIR, 'home-slips', 'manifest.json');
let _b430SlipsCache = null;
function b430HomeSlips() {
  if (_b430SlipsCache) return _b430SlipsCache;
  try { _b430SlipsCache = JSON.parse(fs.readFileSync(B430_HOME_SLIPS_MANIFEST, 'utf8')).slips || []; }
  catch (e) { _b430SlipsCache = []; }
  return _b430SlipsCache;
}
// The manifest entry for a (year_key, global_week). 2026-10-09 (Claude's b430 review): the slips are
// generic weekly sheets (no child data), reviewed and PUBLISHED on getwren.co.uk/phonics-programme/ by
// build-phonics-site.py — Wren links to that one published copy. build/ is not in the prod image, so the
// old "stream it from build/" route could never work on prod.
function b430HomeSlipFor(yearKey, globalWeek) {
  return b430HomeSlips().find((s) => s.year_key === yearKey && s.global_week === globalWeek) || null;
}
function b430HomeSlipUrl(entry) { return 'https://getwren.co.uk/phonics-programme/' + entry.path; }

// The weekly picture-sheet PDFs (b439, 2026-10-10) — same manifest/lookup/URL pattern as the
// home slips above (generic weekly sheets, no child data, published by build-phonics-site.py).
const B439_PICTURE_SHEETS_MANIFEST = path.join(PROGRAMME_DIR, 'picture-sheets', 'manifest.json');
let _b439SheetsCache = null;
function b439PictureSheets() {
  if (_b439SheetsCache) return _b439SheetsCache;
  try { _b439SheetsCache = JSON.parse(fs.readFileSync(B439_PICTURE_SHEETS_MANIFEST, 'utf8')).sheets || []; }
  catch (e) { _b439SheetsCache = []; }
  return _b439SheetsCache;
}
function b439PictureSheetFor(yearKey, globalWeek) {
  return b439PictureSheets().find((s) => s.year_key === yearKey && s.global_week === globalWeek) || null;
}
function b439PictureSheetUrl(entry) { return 'https://getwren.co.uk/phonics-programme/' + entry.path; }

module.exports.b430 = {
  bookCatalog: b408BookCatalog,
  matchBooks: b408MatchBooks,
  secureSet: b408SecureSet,
  todayForRoom: b430TodayForRoom,
  sessionCardFor: (slug) => b411SessionCards().find((c) => c.slug === slug),
  homeSlipFor: b430HomeSlipFor,
  homeSlipUrl: b430HomeSlipUrl,
  pictureSheetFor: b439PictureSheetFor,
  pictureSheetUrl: b439PictureSheetUrl,
};
