'use strict';
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const OLLAMA_HOST  = process.env.OLLAMA_HOST  || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:27b';

router.use(authenticate);

async function aiCall(prompt, systemPrompt, maxTokens) {
  const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      system: systemPrompt || '',
      prompt,
      stream: false, think: false,
      options: { num_predict: maxTokens || 1000, temperature: 0.7 }
    }),
    signal: AbortSignal.timeout(120000)
  });
  if (!r.ok) throw new Error(`Ollama ${r.status}`);
  const data = await r.json();
  let text = (data.response || '').trim();
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return text;
}

function parseJSON(text) {
  const m = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in AI response');
  return JSON.parse(m[0]);
}

// ── GET / — list with filters ─────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const {
    age_group, eyfs_area, difficulty, tag, search,
    edition, age_band, group_size, setting, source,
    limit = 50, offset = 0
  } = req.query;
  try {
    const db = getPool();
    const params = [];
    const conditions = [];

    if (age_group)   { params.push(age_group);   conditions.push(`age_group=$${params.length}`); }
    if (difficulty)  { params.push(difficulty);  conditions.push(`difficulty=$${params.length}`); }
    if (eyfs_area)   { params.push(eyfs_area);   conditions.push(`$${params.length}=ANY(eyfs_areas)`); }
    if (tag)         { params.push(tag);          conditions.push(`$${params.length}=ANY(tags)`); }
    if (edition)     { params.push(edition);      conditions.push(`$${params.length}=ANY(edition)`); }
    if (age_band)    { params.push(age_band);     conditions.push(`$${params.length}=ANY(age_band)`); }
    if (group_size)  { params.push(group_size);   conditions.push(`group_size=$${params.length}`); }
    if (setting)     { params.push(setting);      conditions.push(`$${params.length}=ANY(setting)`); }
    if (source)      { params.push(source);       conditions.push(`source=$${params.length}`); }
    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await db.query(`
      SELECT id, title, description, age_group, duration_minutes, eyfs_areas,
        difficulty, tags, times_used, last_used_at, favourited_by, created_at,
        edition, age_band, source, group_size, setting, area_of_learning, subject,
        curriculum_links, is_public, share_to_community,
        ARRAY_LENGTH(photo_paths, 1) as photo_count
      FROM planning_activities
      ${where}
      ORDER BY times_used DESC, created_at DESC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);

    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) FROM planning_activities ${where}`,
      params.slice(0, -2)
    );
    res.json({ activities: rows, total: parseInt(countRows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /filters — available filter options ────────────────────────────────────
router.get('/filters', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT
        ARRAY_AGG(DISTINCT age_group ORDER BY age_group) FILTER (WHERE age_group IS NOT NULL) as age_groups,
        ARRAY_AGG(DISTINCT difficulty ORDER BY difficulty) FILTER (WHERE difficulty IS NOT NULL) as difficulties,
        ARRAY_AGG(DISTINCT source ORDER BY source) FILTER (WHERE source IS NOT NULL) as sources,
        (SELECT ARRAY_AGG(DISTINCT e ORDER BY e) FROM planning_activities, UNNEST(eyfs_areas) e) as eyfs_areas,
        (SELECT ARRAY_AGG(DISTINCT t ORDER BY t) FROM planning_activities, UNNEST(tags) t) as all_tags,
        (SELECT ARRAY_AGG(DISTINCT ed ORDER BY ed) FROM planning_activities, UNNEST(edition) ed) as editions,
        (SELECT ARRAY_AGG(DISTINCT ab ORDER BY ab) FROM planning_activities, UNNEST(age_band) ab) as age_bands
      FROM planning_activities
    `);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id ───────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM planning_activities WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST / — create activity ───────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const {
    title, description, age_group, duration_minutes, eyfs_areas, learning_objectives,
    materials_needed, setup_instructions, step_by_step, extension_ideas,
    sen_adaptations, risk_notes, tags, difficulty,
    edition, age_band, source, group_size, setting, area_of_learning,
    subject, curriculum_links, is_public
  } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO planning_activities (
        title, description, age_group, duration_minutes, eyfs_areas, learning_objectives,
        materials_needed, setup_instructions, step_by_step, extension_ideas,
        sen_adaptations, risk_notes, tags, difficulty, created_by,
        edition, age_band, source, group_size, setting, area_of_learning,
        subject, curriculum_links, is_public
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
      RETURNING *
    `, [
      title, description, age_group, duration_minutes || null,
      eyfs_areas || null, learning_objectives || null,
      materials_needed || null, setup_instructions, step_by_step,
      extension_ideas, sen_adaptations, risk_notes,
      tags || null, difficulty || 'moderate',
      req.user.username || `${req.user.first_name || ''} ${req.user.last_name || ''}`.trim(),
      edition || ['eyfs'], age_band || ['2-5'], source || 'school-created',
      group_size || null, setting || ['either'], area_of_learning || null,
      subject || null, curriculum_links || null, is_public !== false
    ]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /:id ───────────────────────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const fields = [
    'title', 'description', 'age_group', 'duration_minutes', 'eyfs_areas',
    'learning_objectives', 'materials_needed', 'setup_instructions', 'step_by_step',
    'extension_ideas', 'sen_adaptations', 'risk_notes', 'tags', 'difficulty',
    'edition', 'age_band', 'source', 'group_size', 'setting',
    'area_of_learning', 'subject', 'curriculum_links', 'is_public', 'share_to_community'
  ];
  const updates = [], vals = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) { vals.push(req.body[f]); updates.push(`${f}=$${vals.length}`); }
  });
  if (!updates.length) return res.status(400).json({ error: 'No fields' });
  updates.push('updated_at=NOW()');
  vals.push(req.params.id);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE planning_activities SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /:id ────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  if (!['manager', 'deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
  try {
    await getPool().query('DELETE FROM planning_activities WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/use — increment times_used ──────────────────────────────────────
router.post('/:id/use', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE planning_activities
      SET times_used=times_used+1, last_used_at=NOW(), updated_at=NOW()
      WHERE id=$1 RETURNING times_used
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, times_used: rows[0].times_used });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/favourite — toggle ──────────────────────────────────────────────
router.post('/:id/favourite', async (req, res) => {
  const username = req.user.username || String(req.user.id);
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT favourited_by FROM planning_activities WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const favs = rows[0].favourited_by || [];
    const isFav = favs.includes(username);
    const newFavs = isFav ? favs.filter(f => f !== username) : [...favs, username];
    await db.query('UPDATE planning_activities SET favourited_by=$1 WHERE id=$2', [newFavs, req.params.id]);
    res.json({ ok: true, favourited: !isFav });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/share — toggle community share ───────────────────────────────────
router.post('/:id/share', async (req, res) => {
  if (!['manager', 'deputy_manager'].includes(req.user.role)) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE planning_activities SET share_to_community=NOT COALESCE(share_to_community,false), updated_at=NOW() WHERE id=$1 RETURNING share_to_community',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, share_to_community: rows[0].share_to_community });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /ai-suggest — generate activity from prompt ─────────────────────────
router.post('/ai-suggest', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  const sys = `You are an experienced Early Years educator creating detailed activity plans for a UK nursery.
The nursery has: Baby Room (6m-2yr) and Pre-school (2-5yr).
EYFS areas: Communication and Language, Physical Development, Personal Social Emotional Development, Literacy, Mathematics, Understanding the World, Expressive Arts and Design.
Return ONLY valid JSON, no commentary, no markdown.`;

  const fullPrompt = `User request: ${prompt}

Return a single activity as JSON:
{
  "title": "...",
  "description": "...",
  "age_group": "baby|toddler|preschool|mixed",
  "age_band": ["2-5"],
  "duration_minutes": 20,
  "eyfs_areas": ["Communication and Language"],
  "area_of_learning": ["Communication and Language"],
  "learning_objectives": ["objective 1"],
  "materials_needed": ["item 1"],
  "setup_instructions": "...",
  "step_by_step": "Step 1: ...\\nStep 2: ...",
  "extension_ideas": "...",
  "sen_adaptations": "...",
  "risk_notes": "...",
  "tags": ["sensory","outdoor"],
  "difficulty": "easy|moderate|challenging",
  "group_size": "individual|small|whole-class",
  "setting": ["indoor|outdoor|either"]
}`;
  try {
    const text = await aiCall(fullPrompt, sys, 1200);
    const activity = parseJSON(text);
    res.json(activity);
  } catch (e) { res.status(503).json({ error: 'AI unavailable', detail: e.message }); }
});

// ── POST /:id/variations — AI generates 3 variations ─────────────────────────
router.post('/:id/variations', async (req, res) => {
  const { variation_type } = req.body;
  // variation_type: 'simpler'|'older'|'outdoor'|'maths'|'literacy'|'group'
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM planning_activities WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const act = rows[0];

    const varMap = {
      simpler:  'Make this activity simpler and more accessible for younger or less-developed children',
      older:    'Adapt this activity to be more challenging and engaging for older or more advanced children',
      outdoor:  'Adapt this activity to work outdoors, making use of natural materials and the outdoor environment',
      maths:    'Add a mathematics element to this activity, linking to EYFS Maths area',
      literacy: 'Add a literacy/language element, linking to EYFS Literacy and Communication areas',
      group:    'Adapt this for a larger group or whole-class activity'
    };
    const instruction = varMap[variation_type] || `Create a variation of this activity: ${variation_type}`;

    const sys = `You are an expert EYFS practitioner. Generate activity variations. Return only valid JSON.`;
    const prompt = `Original activity:
Title: ${act.title}
Description: ${act.description}
EYFS Areas: ${(act.eyfs_areas || []).join(', ')}
Duration: ${act.duration_minutes} minutes
Resources: ${(act.materials_needed || []).join(', ')}

Task: ${instruction}

Return a JSON object for the varied activity:
{
  "title": "...",
  "description": "2-3 sentences describing the variation",
  "eyfs_areas": [...],
  "duration_minutes": 20,
  "materials_needed": [...],
  "setup_instructions": "...",
  "extension_ideas": "...",
  "sen_adaptations": "...",
  "group_size": "individual|small|whole-class",
  "setting": ["indoor|outdoor|either"],
  "variation_of": ${act.id},
  "variation_type": "${variation_type || 'custom'}"
}`;

    const text = await aiCall(prompt, sys, 900);
    const variation = parseJSON(text);
    res.json(variation);
  } catch (e) { res.status(503).json({ error: 'AI unavailable', detail: e.message }); }
});

// ── POST /from-url — parse activity from a URL ────────────────────────────────
router.post('/from-url', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WrenBot/1.0)' },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return res.status(400).json({ error: `Could not fetch URL: ${r.status}` });
    const html = await r.text();
    // Strip HTML tags for basic text extraction
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 3000);

    const sys = `You are an EYFS practitioner. Extract activity information from web page text. Return only valid JSON.`;
    const prompt = `Extract an activity from this web page text and format it as a nursery activity plan:

${text}

Return JSON:
{
  "title": "...",
  "description": "...",
  "age_group": "baby|toddler|preschool|mixed",
  "eyfs_areas": [...],
  "duration_minutes": 20,
  "materials_needed": [...],
  "setup_instructions": "...",
  "extension_ideas": "...",
  "tags": [...],
  "difficulty": "easy|moderate|challenging"
}`;

    const aiText = await aiCall(prompt, sys, 800);
    const activity = parseJSON(aiText);
    activity.source = 'doc-import';
    res.json(activity);
  } catch (e) { res.status(503).json({ error: 'Could not parse URL', detail: e.message }); }
});

module.exports = router;
