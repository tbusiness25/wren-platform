const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

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
      `SELECT * FROM ladn.phonics_sounds ${where} ORDER BY phase, position_in_phase, id`,
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
      UPDATE ladn.phonics_sounds
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
    const db = getPool();
    const { rows } = await db.query(`
      SELECT ps.id as sound_id, ps.phase, ps.sound_code, ps.sound_type,
             ps.example_words, ps.pronunciation_guide, ps.rwi_action, ps.position_in_phase,
             cpp.id as progress_id, cpp.confidence, cpp.last_assessed_at, cpp.assessed_by, cpp.notes
      FROM ladn.phonics_sounds ps
      LEFT JOIN ladn.child_phonics_progress cpp
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
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO ladn.child_phonics_progress (child_id, sound_id, confidence, assessed_by, notes, last_assessed_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      ON CONFLICT (child_id, sound_id) DO UPDATE SET
        confidence = EXCLUDED.confidence,
        assessed_by = EXCLUDED.assessed_by,
        notes = CASE WHEN $5 IS NOT NULL THEN $5 ELSE ladn.child_phonics_progress.notes END,
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
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE ladn.child_phonics_progress SET notes = $1
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
        INSERT INTO ladn.child_phonics_progress (child_id, sound_id, confidence, assessed_by, last_assessed_at)
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
    const db = getPool();
    const { rows } = await db.query(
      'SELECT date_of_birth FROM ladn.children WHERE id=$1',
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
      FROM ladn.children c
      LEFT JOIN ladn.child_phonics_progress cpp ON cpp.child_id = c.id
      WHERE c.is_active=true ${roomFilter}
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
      FROM ladn.phonics_sounds ps
      LEFT JOIN ladn.child_phonics_progress cpp ON cpp.sound_id = ps.id
      GROUP BY ps.id ORDER BY ps.phase, ps.position_in_phase
    `);
    // Total active children
    const childCount = await db.query(
      'SELECT COUNT(*) as total FROM ladn.children WHERE is_active=true'
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
        FROM ladn.children WHERE is_active=true
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
        'SELECT * FROM ladn.phonics_sounds WHERE phase=$1 ORDER BY position_in_phase',
        [phase || 2]
      ),
      db.query(
        'SELECT id, first_name, last_name, date_of_birth FROM ladn.children WHERE is_active=true ORDER BY first_name'
      ),
      db.query(`
        SELECT cpp.child_id, cpp.sound_id, cpp.confidence
        FROM ladn.child_phonics_progress cpp
        JOIN ladn.phonics_sounds ps ON ps.id = cpp.sound_id
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
      INSERT INTO ladn.phonics_game_sessions
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
    const db = getPool();
    const { rows } = await db.query(`
      SELECT * FROM ladn.phonics_game_sessions
      WHERE child_id=$1 ORDER BY played_at DESC LIMIT 50
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Legacy backward-compat (phonics_tracker) ─────────────────────────────────

router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT * FROM ladn.phonics_tracker WHERE child_id=$1 ORDER BY phase, sound',
      [req.params.childId]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/child/:childId/sound', async (req, res) => {
  const { sound, phase, status } = req.body;
  if (!sound || !status) return res.status(400).json({ error: 'sound and status required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO ladn.phonics_tracker (child_id, sound, phase, status, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (child_id, sound) DO UPDATE SET status=$4, updated_by=$5, updated_at=NOW()
      RETURNING *
    `, [req.params.childId, sound, phase || 2, status, req.user.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
