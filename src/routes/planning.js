const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT  = process.env.TELEGRAM_CHAT_ID  || '';

const EYFS_AREAS = [
  'Communication & Language',
  'Physical Development',
  'PSED',
  'Literacy',
  'Mathematics',
  'Understanding the World',
  'Expressive Arts & Design'
];

const TERMS = ['Autumn 1','Autumn 2','Spring 1','Spring 2','Summer 1','Summer 2'];

async function callPlanningAI(prompt, systemPrompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: prompt }]
    }),
    signal: AbortSignal.timeout(45000)
  });
  if (!r.ok) {
    const err = await r.text();
    throw new Error(`Anthropic error ${r.status}: ${err}`);
  }
  const data = await r.json();
  return data.content?.[0]?.text || '';
}

function parseJSON(text) {
  const m = text.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON found in AI response');
  return JSON.parse(m[0]);
}

async function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: msg })
  }).catch(() => {});
}

function dayName(d) {
  return ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'][d.getDay()];
}

function weekOf(d) {
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1 - day);
  const mon = new Date(d);
  mon.setDate(d.getDate() + diff);
  return mon.toISOString().slice(0, 10);
}

// ─── GET /today ───────────────────────────────────────────────────────────────
router.get('/today', async (req, res) => {
  try {
    const db = getPool();
    const roomId = req.query.room_id;
    const now = new Date();
    const today = dayName(now);
    const wc = weekOf(now);
    const { rows } = await db.query(
      `SELECT * FROM weekly_plans WHERE room_id=$1 AND week_commencing=$2 AND day=$3 ORDER BY id LIMIT 1`,
      [roomId, wc, today]
    );
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /weekly ──────────────────────────────────────────────────────────────
router.get('/weekly', async (req, res) => {
  try {
    const db = getPool();
    const { room_id, week } = req.query;
    const { rows } = await db.query(
      `SELECT * FROM weekly_plans WHERE room_id=$1 AND week_commencing=$2
       ORDER BY CASE day WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 ELSE 6 END, id`,
      [room_id, week]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /activities — grouped by day ─────────────────────────────────────────
router.get('/activities', async (req, res) => {
  try {
    const db = getPool();
    const { room_id, week } = req.query;
    const { rows } = await db.query(
      `SELECT * FROM weekly_plans WHERE room_id=$1 AND week_commencing=$2
       ORDER BY CASE day WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 ELSE 6 END, id`,
      [room_id, week]
    );
    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.day]) grouped[r.day] = [];
      grouped[r.day].push(r);
    });
    res.json(grouped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /term ────────────────────────────────────────────────────────────────
router.get('/term', async (req, res) => {
  try {
    const db = getPool();
    const { room_id, term, year } = req.query;
    const { rows } = await db.query(
      `SELECT * FROM term_plans WHERE room_id=$1 AND term_name=$2 AND academic_year=$3 LIMIT 1`,
      [room_id, term, year || '2025-2026']
    );
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /terms ───────────────────────────────────────────────────────────────
router.get('/terms', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, room_id, term_name, academic_year, theme FROM term_plans ORDER BY academic_year, term_name`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /long-term — all 6 terms for a room ─────────────────────────────────
router.get('/long-term', async (req, res) => {
  try {
    const db = getPool();
    const { room_id, year } = req.query;
    const { rows } = await db.query(
      `SELECT term_name, theme, eyfs_grid FROM term_plans WHERE room_id=$1 AND academic_year=$2`,
      [room_id, year || '2025-2026']
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /term-cell — save one EYFS area cell in a term ─────────────────────
router.post('/term-cell', authenticate, async (req, res) => {
  const { room_id, term, year, area, text } = req.body;
  if (!room_id || !term || !area) return res.status(400).json({ error: 'room_id, term, area required' });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO term_plans (room_id, term_name, academic_year, theme, eyfs_grid, learning_intentions, key_books, songs)
       VALUES ($1,$2,$3,$4, jsonb_build_object($5::text, $6::text), ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[])
       ON CONFLICT (room_id, term_name, academic_year) DO UPDATE SET
         eyfs_grid = term_plans.eyfs_grid || jsonb_build_object($5::text, $6::text),
         theme = COALESCE(NULLIF(term_plans.theme,''), $4)`,
      [room_id, term, year || '2025-2026', text, area, text]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /weeks ───────────────────────────────────────────────────────────────
router.get('/weeks', async (req, res) => {
  try {
    const db = getPool();
    const { room_id } = req.query;
    const { rows } = await db.query(
      `SELECT week_commencing, MIN(theme) as theme,
        json_agg(json_build_object(
          'id', id, 'day', day, 'activity_type', activity_type,
          'activity_title', activity_title, 'role_of_adult', role_of_adult,
          'resources', resources, 'eyfs_areas', eyfs_areas, 'eyfs_area', eyfs_area
        ) ORDER BY CASE day WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 ELSE 6 END, id) as days
       FROM weekly_plans WHERE room_id=$1
       GROUP BY week_commencing ORDER BY week_commencing`,
      [room_id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /for-newsletter ──────────────────────────────────────────────────────
router.get('/for-newsletter', async (req, res) => {
  try {
    const db = getPool();
    const { term, year, room_id } = req.query;
    const [termRow, weeksRows] = await Promise.all([
      db.query(`SELECT * FROM term_plans WHERE term_name=$1 AND academic_year=$2 AND room_id=$3 LIMIT 1`, [term, year || '2025-2026', room_id]),
      db.query(
        `SELECT week_commencing, MIN(theme) as theme,
          json_agg(json_build_object('day',day,'activity_type',activity_type,'activity_title',activity_title)
            ORDER BY CASE day WHEN 'monday' THEN 1 WHEN 'tuesday' THEN 2 WHEN 'wednesday' THEN 3 WHEN 'thursday' THEN 4 WHEN 'friday' THEN 5 ELSE 6 END) as days
         FROM weekly_plans WHERE room_id=$1
         GROUP BY week_commencing ORDER BY week_commencing`,
        [room_id]
      )
    ]);
    res.json({ term: termRow.rows[0] || null, weeks: weeksRows.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /preferences ─────────────────────────────────────────────────────────
router.get('/preferences', async (req, res) => {
  try {
    const db = getPool();
    const { room_id } = req.query;
    const { rows } = await db.query(
      `SELECT * FROM planning_preferences WHERE room_id=$1 LIMIT 1`,
      [room_id]
    );
    res.json(rows[0] || { planning_levels: ['long_term','medium_term','weekly'], differentiate_sen: true, preferred_frameworks: ['eyfs'] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /preferences ────────────────────────────────────────────────────────
router.post('/preferences', authenticate, async (req, res) => {
  const { room_id, planning_levels, ai_auto_plan, differentiate_sen, preferred_frameworks } = req.body;
  if (!room_id) return res.status(400).json({ error: 'room_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO planning_preferences (room_id, planning_levels, ai_auto_plan, differentiate_sen, preferred_frameworks, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (room_id) DO UPDATE SET
         planning_levels=EXCLUDED.planning_levels, ai_auto_plan=EXCLUDED.ai_auto_plan,
         differentiate_sen=EXCLUDED.differentiate_sen, preferred_frameworks=EXCLUDED.preferred_frameworks,
         updated_at=NOW()
       RETURNING *`,
      [room_id, JSON.stringify(planning_levels || ['long_term','medium_term','weekly']),
       ai_auto_plan || false, differentiate_sen !== false,
       preferred_frameworks || ['eyfs']]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /medium-term ─────────────────────────────────────────────────────────
router.get('/medium-term', async (req, res) => {
  try {
    const db = getPool();
    const { room_id, term, year } = req.query;
    const { rows } = await db.query(
      `SELECT * FROM medium_term_plans WHERE room_id=$1 AND term_name=$2 AND academic_year=$3 LIMIT 1`,
      [room_id, term, year || '2025-2026']
    );
    res.json(rows[0] || null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /medium-term ────────────────────────────────────────────────────────
router.post('/medium-term', authenticate, async (req, res) => {
  const { room_id, term_name, academic_year, theme, learning_intentions, key_vocab } = req.body;
  if (!room_id || !term_name) return res.status(400).json({ error: 'room_id, term_name required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO medium_term_plans (room_id, term_name, academic_year, theme, learning_intentions, key_vocab, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (room_id, term_name, academic_year) DO UPDATE SET
         theme=EXCLUDED.theme, learning_intentions=EXCLUDED.learning_intentions,
         key_vocab=EXCLUDED.key_vocab, updated_at=NOW()
       RETURNING *`,
      [room_id, term_name, academic_year || '2025-2026', theme,
       JSON.stringify(learning_intentions || {}), JSON.stringify(key_vocab || {}),
       req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /weekly — insert new activity card ──────────────────────────────────
router.post('/weekly', authenticate, async (req, res) => {
  const { role } = req.user;
  if (!['manager','deputy_manager','room_leader'].includes(role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { room_id, week_commencing, day, activity_type, activity_title, activity_description,
          role_of_adult, resources, eyfs_areas, eyfs_area, theme, differentiation, ai_generated, learning_intention_id } = req.body;
  if (!room_id || !week_commencing || !day || !activity_title) {
    return res.status(400).json({ error: 'room_id, week_commencing, day, activity_title required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO weekly_plans
         (room_id, week_commencing, day, theme, activity_type, activity_title, role_of_adult,
          resources, eyfs_areas, eyfs_area, differentiation, ai_generated, learning_intention_id, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
       RETURNING *`,
      [room_id, week_commencing, day, theme, activity_type, activity_title, role_of_adult,
       resources, eyfs_areas || [], eyfs_area,
       JSON.stringify(differentiation || []), ai_generated || false,
       learning_intention_id || null, req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /weekly/:id ────────────────────────────────────────────────────────
router.patch('/weekly/:id', authenticate, async (req, res) => {
  const { role } = req.user;
  if (!['manager','deputy_manager','room_leader'].includes(role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { activity_type, activity_title, activity_description, role_of_adult,
          resources, eyfs_areas, eyfs_area, theme, differentiation } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE weekly_plans SET
         activity_type=$1, activity_title=$2, role_of_adult=$3, resources=$4,
         eyfs_areas=$5, eyfs_area=$6, theme=$7, differentiation=$8, updated_at=NOW()
       WHERE id=$9 RETURNING *`,
      [activity_type, activity_title, role_of_adult, resources,
       eyfs_areas || [], eyfs_area, theme,
       JSON.stringify(differentiation || []), req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /weekly/:id ───────────────────────────────────────────────────────
router.delete('/weekly/:id', authenticate, async (req, res) => {
  const { role } = req.user;
  if (!['manager','deputy_manager','room_leader'].includes(role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  try {
    const db = getPool();
    await db.query(`DELETE FROM weekly_plans WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /ai-day ─────────────────────────────────────────────────────────────
router.post('/ai-day', authenticate, async (req, res) => {
  const { role } = req.user;
  if (!['manager','deputy_manager','room_leader'].includes(role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { room_id, date, learning_intentions } = req.body;
  if (!room_id || !date) return res.status(400).json({ error: 'room_id, date required' });

  try {
    const db = getPool();
    const week = weekOf(new Date(date + 'T00:00:00'));
    const dayStr = dayName(new Date(date + 'T00:00:00'));

    // Fetch room info
    const roomRow = await db.query(`SELECT name, min_age_months, max_age_months FROM rooms WHERE id=$1`, [room_id]);
    const room = roomRow.rows[0] || { name: 'Room', min_age_months: 24, max_age_months: 60 };
    const ageRange = `${Math.floor(room.min_age_months/12)}-${Math.floor(room.max_age_months/12)} years`;

    // Fetch recent observations
    const obsRows = await db.query(
      `SELECT o.title, o.observation_text, o.next_steps, o.eyfs_areas, c.first_name
       FROM observations o JOIN children c ON c.id=o.child_id
       WHERE c.room_id=$1 AND o.created_at > NOW()-INTERVAL '14 days'
       ORDER BY o.created_at DESC LIMIT 20`,
      [room_id]
    );

    // Fetch SEN children
    const senRows = await db.query(
      `SELECT c.id, c.first_name, s.primary_need, s.support_plan, s.targets
       FROM sen_register s JOIN children c ON c.id=s.child_id
       WHERE c.room_id=$1 AND s.is_active=true AND c.is_active=true`,
      [room_id]
    );

    const obsText = obsRows.rows.length
      ? obsRows.rows.map(o => `- ${o.first_name}: ${o.observation_text?.slice(0,120)} (next steps: ${o.next_steps?.slice(0,80) || 'none'})`).join('\n')
      : 'No recent observations available.';

    const senText = senRows.rows.length
      ? senRows.rows.map(s => `- ${s.first_name}: ${s.primary_need}, support: ${s.support_plan?.slice(0,100) || 'see plan'}`).join('\n')
      : 'No children with active SEN.';

    const intentText = learning_intentions
      ? `Medium-term learning intentions: ${typeof learning_intentions === 'object' ? JSON.stringify(learning_intentions) : learning_intentions}`
      : '';

    const systemPrompt = `You are an expert EYFS curriculum planner for UK nurseries (ages 0-5). You generate practical, engaging activity plans following the EYFS Statutory Framework 2024. Always specify resources commonly found in nurseries. Return only valid JSON, no explanation text.`;

    const prompt = `Generate a full day of activities for ${room.name} (ages ${ageRange}) for ${dayStr.charAt(0).toUpperCase()+dayStr.slice(1)} ${date}.

Recent observations (last 14 days):
${obsText}

Children with SEN:
${senText}

${intentText}

Generate 5 activities spread across different EYFS areas. For any child listed with SEN, add a specific differentiation note to the most relevant activity.

Return ONLY a JSON array in this exact format (no markdown, no explanation):
[
  {
    "eyfs_area": "Communication & Language",
    "activity_title": "Short title",
    "activity_description": "2-3 sentence description of the activity",
    "role_of_adult": "How the adult will facilitate",
    "resources": "Comma-separated list of resources",
    "differentiation": []
  }
]

Where differentiation (only if SEN children are listed) is:
[{"child_id": 123, "note": "Specific adaptation for this child"}]

EYFS areas to choose from: Communication & Language, Physical Development, PSED, Literacy, Mathematics, Understanding the World, Expressive Arts & Design`;

    const raw = await callPlanningAI(prompt, systemPrompt);
    let activities;
    try { activities = parseJSON(raw); } catch(e) { return res.status(500).json({ error: 'AI returned invalid JSON', raw }); }

    // Save activities to weekly_plans
    const saved = [];
    for (const act of activities) {
      const { rows } = await db.query(
        `INSERT INTO weekly_plans
           (room_id, week_commencing, day, eyfs_area, eyfs_areas, activity_title, role_of_adult,
            resources, differentiation, ai_generated, created_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10,NOW())
         RETURNING *`,
        [room_id, week, dayStr, act.eyfs_area,
         [act.eyfs_area], act.activity_title, act.role_of_adult,
         act.resources, JSON.stringify(act.differentiation || []), req.user.id]
      );
      saved.push(rows[0]);
    }

    const senCount = activities.filter(a => a.differentiation && a.differentiation.length).length;
    const roomName = room.name;
    sendTelegram(`📋 AI planned ${dayStr.charAt(0).toUpperCase()+dayStr.slice(1)} for ${roomName} — ${saved.length} activities generated${senCount ? `, ${senCount} with SEN differentiation` : ''}`);

    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /ai-medium-term ─────────────────────────────────────────────────────
router.post('/ai-medium-term', authenticate, async (req, res) => {
  const { room_id, term_name, academic_year, theme } = req.body;
  if (!room_id || !theme) return res.status(400).json({ error: 'room_id, theme required' });
  try {
    const db = getPool();
    const roomRow = await db.query(`SELECT name, min_age_months, max_age_months FROM rooms WHERE id=$1`, [room_id]);
    const room = roomRow.rows[0] || { name: 'Room', min_age_months: 24, max_age_months: 60 };
    const ageRange = `${Math.floor(room.min_age_months/12)}-${Math.floor(room.max_age_months/12)} years`;

    const systemPrompt = `You are an expert EYFS curriculum planner for UK nurseries. Generate medium-term plans (half-term) following EYFS 2024. Return only valid JSON.`;

    const prompt = `Generate a medium-term plan for ${room.name} (ages ${ageRange}) for the half-term "${term_name || ''}".
Theme: "${theme}"

For each of the 7 EYFS areas, provide:
1. 2-4 specific learning intentions (what children will be working towards)
2. Key vocabulary (5-8 words/phrases children will encounter)

Return ONLY a JSON object in this exact format:
{
  "learning_intentions": {
    "Communication & Language": ["intention 1", "intention 2"],
    "Physical Development": ["intention 1", "intention 2"],
    "PSED": ["intention 1", "intention 2"],
    "Literacy": ["intention 1", "intention 2"],
    "Mathematics": ["intention 1", "intention 2"],
    "Understanding the World": ["intention 1", "intention 2"],
    "Expressive Arts & Design": ["intention 1", "intention 2"]
  },
  "key_vocab": {
    "Communication & Language": "word1, word2, word3",
    "Physical Development": "word1, word2, word3",
    "PSED": "word1, word2, word3",
    "Literacy": "word1, word2, word3",
    "Mathematics": "word1, word2, word3",
    "Understanding the World": "word1, word2, word3",
    "Expressive Arts & Design": "word1, word2, word3"
  }
}`;

    const raw = await callPlanningAI(prompt, systemPrompt);
    let plan;
    try { plan = parseJSON(raw); } catch(e) { return res.status(500).json({ error: 'AI returned invalid JSON', raw }); }

    // Upsert medium_term_plans
    const { rows } = await db.query(
      `INSERT INTO medium_term_plans (room_id, term_name, academic_year, theme, learning_intentions, key_vocab, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (room_id, term_name, academic_year) DO UPDATE SET
         theme=EXCLUDED.theme, learning_intentions=EXCLUDED.learning_intentions,
         key_vocab=EXCLUDED.key_vocab, updated_at=NOW()
       RETURNING *`,
      [room_id, term_name, academic_year || '2025-2026', theme,
       JSON.stringify(plan.learning_intentions || {}), JSON.stringify(plan.key_vocab || {}),
       req.user.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /ai-long-term-suggest ───────────────────────────────────────────────
router.post('/ai-long-term-suggest', authenticate, async (req, res) => {
  const { room_id, term, eyfs_area } = req.body;
  if (!term || !eyfs_area) return res.status(400).json({ error: 'term, eyfs_area required' });
  try {
    const db = getPool();
    const roomRow = await db.query(`SELECT name, min_age_months, max_age_months FROM rooms WHERE id=$1`, [room_id]);
    const room = roomRow.rows[0] || { min_age_months: 24, max_age_months: 60 };
    const ageRange = `${Math.floor(room.min_age_months/12)}-${Math.floor(room.max_age_months/12)} years`;

    const systemPrompt = `You are an expert EYFS curriculum planner. Suggest engaging half-term themes for UK nurseries. Return only valid JSON.`;

    const prompt = `Suggest 3 engaging themes for the EYFS area "${eyfs_area}" for ${term} in a UK nursery (ages ${ageRange}).

Each theme should be:
- Age-appropriate and hands-on
- Linked to seasonal events or children's interests
- Easy to resource in a typical nursery

Return ONLY a JSON array of 3 strings:
["Theme 1 — brief description", "Theme 2 — brief description", "Theme 3 — brief description"]`;

    const raw = await callPlanningAI(prompt, systemPrompt);
    let suggestions;
    try { suggestions = parseJSON(raw); } catch(e) { return res.status(500).json({ error: 'AI returned invalid JSON', raw }); }
    res.json({ suggestions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /ai-activity ────────────────────────────────────────────────────────
router.post('/ai-activity', authenticate, async (req, res) => {
  const { eyfs_area, learning_intention, age_range, room_id, child_ids } = req.body;
  if (!eyfs_area) return res.status(400).json({ error: 'eyfs_area required' });
  try {
    const db = getPool();
    let senText = '';
    if (child_ids && child_ids.length && room_id) {
      const senRows = await db.query(
        `SELECT c.id, c.first_name, s.primary_need, s.support_plan
         FROM sen_register s JOIN children c ON c.id=s.child_id
         WHERE c.id=ANY($1) AND s.is_active=true`,
        [child_ids]
      );
      senText = senRows.rows.map(s => `- ${s.first_name}: ${s.primary_need}`).join('\n');
    }

    const systemPrompt = `You are an expert EYFS practitioner. Generate one practical nursery activity. Return only valid JSON.`;

    const prompt = `Generate one nursery activity for EYFS area: "${eyfs_area}"
Age range: ${age_range || '2-5 years'}
${learning_intention ? `Learning intention: ${learning_intention}` : ''}
${senText ? `Children with SEN in this group:\n${senText}` : ''}

Return ONLY a JSON object:
{
  "activity_title": "...",
  "activity_description": "2-3 sentences",
  "role_of_adult": "...",
  "resources": "comma-separated list",
  "differentiation": [{"child_id": 123, "note": "..."}]
}`;

    const raw = await callPlanningAI(prompt, systemPrompt);
    let activity;
    try { activity = parseJSON(raw); } catch(e) { return res.status(500).json({ error: 'AI returned invalid JSON', raw }); }
    activity.eyfs_area = eyfs_area;
    res.json(activity);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
