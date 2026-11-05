const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { operationalChildFilter, ensureEnrolmentMiddleware } = require('../utils/enrolment'); // b96
const CAL = require('../lib/school-calendar');   // b217 — Ealing school term calendar
const FUNDP = require('../lib/funding-periods'); // b298 — which funding_terms rows are EyLog history
const planStatus = require('../lib/plan-status');// b290 — draft vs published
// b302 (2026-09-10) — the ONE reader for a term_plans row. Roost and EY each
// read `intentions` (jsonb) while the parents surfaces read learning_intentions
// (text[]), so the two staff screens showed an empty intentions section against
// a complete uploaded plan. Everything now resolves through this module.
const TPV = require('../lib/term-plan-view');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
router.use(ensureEnrolmentMiddleware(getPool));

// 27 Oct 2026 — the parents portal may only use this router's public read routes. Found while testing the live
// parents plan: authenticate() checks a token's audience against the portal, so a parent's own Wren JWT
// (aud "parents", obtainable from /api/auth/cf-auto-login) was accepted on the parents host by every
// authenticate()-gated route here — GET /termly/plan returned a DRAFT half-term plus child_evaluations
// (named children). Parents use only the unauthenticated reads below (and their drafts are filtered by
// parentPlanGate / b290); everything else is staff-only, so on the parents host it is refused here, before any
// handler. Staff portals are unaffected.
const PARENT_PORTAL_OK = /^\/(today|weekly|activities|term|terms|long-term|weeks|for-newsletter|preferences|medium-term)\/?$/;
router.use((req, res, next) => {
  if (req._portal !== 'parents') return next();
  if ((req.method === 'GET' || req.method === 'HEAD') && PARENT_PORTAL_OK.test(req.path)) return next();
  return res.status(403).json({ error: 'Not available here' });
});

// ── b290 — the parents-portal gate ───────────────────────────────────────────
// Four read endpoints in this file (/term, /terms, /long-term, /for-newsletter)
// are deliberately UNAUTHENTICATED and are mounted on every portal, because
// CLAUDE.md rule 3 says planning and curriculum must stay reachable from the
// parents portal. Staff plan in drafts; parents must not see them. So the gate
// is applied by PORTAL rather than by adding auth (which would break the parents
// portal) or by filtering everywhere (which would hide staff drafts from staff).
//
// req._portal is set by editions/ladn/server-unified.js hostname dispatch. An
// unknown portal is treated as staff, which is correct: the only host that
// resolves to 'parents' is parents.example-nursery.co.uk, and that is the
// only place a parent's browser can reach these routes.
async function parentPlanGate(req, db, alias) {
  if (req._portal !== 'parents') return '';
  return planStatus.publishedOnlySql(db, alias);
}

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

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

// Roles permitted to create/edit plans. Practitioners plan in the EY portal,
// managers/room leaders in Roost. (b-planedit 2026-08-03: +practitioner so EY
// practitioners can add card-picked activities and edit the term plan.)
const PLAN_EDIT_ROLES = ['manager','deputy_manager', 'admin','room_leader','practitioner'];

async function callPlanningAI(prompt, systemPrompt) {
  // 2026-10-08: demo editions (AI_PROVIDER=groq) plan with Groq — the hosted-model key
  // was retired, and demos run on synthetic data, so the fast hosted model is fine there.
  if (String(process.env.AI_PROVIDER || '').toLowerCase() === 'groq' && process.env.GROQ_API_KEY) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        max_tokens: 3000,
        temperature: 0.4,
        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!r.ok) throw new Error(`Groq error ${r.status}`);
    const d = await r.json();
    return d.choices?.[0]?.message?.content || '';
  }
  // 2026-10-08: these prompts carry children's first names, recent observation text
  // and SEN needs. On a sovereign edition (LADN prod: AI_PROVIDER=ollama) they must
  // never reach a cloud model (CLAUDE.md rule 8, AI split decided 2026-05-14) — use the
  // local-only helper, which refuses any non-private host. Demo editions keep the
  // hosted model (synthetic data).
  if (String(process.env.AI_PROVIDER || '').toLowerCase() === 'ollama') {
    return require('../lib/sovereign-model').generate({
      system: systemPrompt, prompt, temperature: 0.3, numPredict: 3000, long: true, timeoutMs: 180000,
    });
  }
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

// login-20261023: through the one Telegram sender (src/lib/notifications.js) — same text and format,
// plus its dev/MAIL_DISABLED guard, which this private copy never had.
async function sendTelegram(msg) { return require('../lib/notifications').sendTelegramNow({ text: msg, parse_mode: null }); }

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

// b404 (2026-10-06) — a half-term planned through the Termly tab (termly_plan_days,
// b245) was invisible here. This route read ONLY weekly_plans — the OLD store this
// page's "+ Add activity" button still writes to — so a room planned entirely via
// the newer per-day flow (Baby Room's whole 2026-2027 year, loaded under b245) showed
// "No activities" Mon–Fri in Week view while the SAME week showed full content on the
// Termly tab. Two stores feeding one grid, and this route only ever looked at one.
// Resolve the week against termly_plan_days too (via termly_plan_weeks, which carries
// the real week_commencing a plan's week_no maps to) and fold its rows in, shaped
// exactly like a weekly_plans row so the existing client renders them unchanged.
// Gated the same way term_plans drafts already are elsewhere in this file (b290):
// a draft half-term must never reach a parent, so a termly_plan_days row is only
// folded in when its owning term_plans.status is 'published' or the caller is staff.
async function termlyDayRowsAsWeekly(db, roomId, weekCommencing, parentsOnly) {
  if (!roomId || !weekCommencing) return [];
  const { rows: wk } = await db.query(
    `SELECT w.plan_id, w.week_no, p.status
       FROM termly_plan_weeks w
       JOIN term_plans p ON p.id = w.plan_id
      WHERE w.room_id = $1 AND w.week_commencing = $2
      LIMIT 1`,
    [roomId, weekCommencing]
  );
  if (!wk.length) return [];
  if (parentsOnly && wk[0].status !== 'published') return [];   // b290 — drafts stop here
  const { rows: days } = await db.query(
    `SELECT * FROM termly_plan_days WHERE plan_id=$1 AND week_no=$2 AND room_id=$3 ORDER BY weekday`,
    [wk[0].plan_id, wk[0].week_no, roomId]
  );
  if (!days.length) return [];
  const actIds = [...new Set(days.flatMap(d => asIntArray(d.activity_ids)))];
  const areasById = new Map();
  if (actIds.length) {
    const { rows: acts } = await db.query(
      `SELECT id, eyfs_areas FROM curriculum_activities WHERE id = ANY($1::int[])`, [actIds]);
    acts.forEach(a => areasById.set(a.id, a.eyfs_areas || []));
  }
  const DAY_NAME = { 1: 'monday', 2: 'tuesday', 3: 'wednesday', 4: 'thursday', 5: 'friday' };
  return days.map(d => {
    const ids = asIntArray(d.activity_ids);
    const areas = [...new Set(ids.flatMap(id => areasById.get(id) || []))];
    return {
      id: 'tpd-' + d.id,          // b404 — own id space, never a real weekly_plans row
      room_id: roomId, week_commencing: weekCommencing, day: DAY_NAME[d.weekday] || null,
      activity_type: d.category_slug, activity_title: d.title,
      role_of_adult: d.role_of_adult, resources: null,
      eyfs_areas: areas, eyfs_area: areas[0] || null,
      differentiation: [], ai_generated: false,
      source: 'termly_plan_days', readonly: true,
    };
  });
}

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
    const extra = await termlyDayRowsAsWeekly(db, room_id, week, req._portal === 'parents');
    res.json(rows.concat(extra));
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
    const gate = await parentPlanGate(req, db, '');            // b290
    const { rows } = await db.query(
      `SELECT * FROM term_plans
        WHERE room_id=$1 AND term_name=$2 AND academic_year=$3${gate} LIMIT 1`,
      [room_id, term, year || '2025-2026']
    );
    // b302 — same resolved shape as /termly/plan carries, added alongside the
    // raw row so the parents PWA (which reads .learning_intentions) is untouched
    // while anything new reads .view and gets the plan whichever column holds it.
    const row = rows[0] || null;
    res.json(row ? Object.assign({}, row, { view: TPV.planView(row, {}) }) : null);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /terms ───────────────────────────────────────────────────────────────
router.get('/terms', async (req, res) => {
  try {
    const db = getPool();
    const gate = await parentPlanGate(req, db, '');            // b290
    const { rows } = await db.query(
      `SELECT id, room_id, term_name, academic_year, theme FROM term_plans
        WHERE true${gate} ORDER BY academic_year, term_name`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /long-term — all 6 terms for a room ─────────────────────────────────
router.get('/long-term', async (req, res) => {
  try {
    const db = getPool();
    const { room_id, year } = req.query;
    const gate = await parentPlanGate(req, db, '');            // b290
    const { rows } = await db.query(
      `SELECT term_name, theme, eyfs_grid FROM term_plans
        WHERE room_id=$1 AND academic_year=$2${gate}`,
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

// ─── PUT /term-plan — edit theme + learning intentions (b-planedit 2026-08-03) ─
// Editable termly plan: theme title + add/edit/remove/reorder learning-intention
// lines. Keyed on room+term+year (existing term_plans UNIQUE constraint). Upsert;
// preserves key_books/songs/eyfs_grid/events on update. Manager/practitioner gated.
router.put('/term-plan', authenticate, async (req, res) => {
  const { role } = req.user;
  if (!PLAN_EDIT_ROLES.includes(role)) return res.status(403).json({ error: 'Insufficient permissions' });
  const { room_id, term, year, theme, learning_intentions } = req.body;
  if (!room_id || !term) return res.status(400).json({ error: 'room_id, term required' });
  // Order of the array IS the display order — reorder is just saving a new order.
  const intentions = Array.isArray(learning_intentions)
    ? learning_intentions.map(s => String(s == null ? '' : s).trim()).filter(Boolean)
    : [];
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO term_plans (room_id, term_name, academic_year, theme, learning_intentions, key_books, songs)
       VALUES ($1,$2,$3,$4,$5::text[], ARRAY[]::text[], ARRAY[]::text[])
       ON CONFLICT (room_id, term_name, academic_year) DO UPDATE SET
         theme = EXCLUDED.theme,
         learning_intentions = EXCLUDED.learning_intentions
       RETURNING *`,
      [room_id, term, year || '2025-2026', theme || '', intentions]
    );
    res.json(rows[0]);
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
    const gate = await parentPlanGate(req, db, '');            // b290
    const [termRow, weeksRows] = await Promise.all([
      db.query(`SELECT * FROM term_plans
                 WHERE term_name=$1 AND academic_year=$2 AND room_id=$3${gate} LIMIT 1`,
               [term, year || '2025-2026', room_id]),
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
  if (!PLAN_EDIT_ROLES.includes(role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { room_id, week_commencing, day, activity_type, activity_title, activity_description,
          role_of_adult, resources, eyfs_areas, eyfs_area, theme, differentiation, ai_generated, learning_intention_id,
          // b170 — resource-card attachment (Fledge/EYFS-linked curriculum cards, src/content/resource-cards/*.json)
          resource_card_slug, resource_card_title, resource_card_areas } = req.body;
  if (!room_id || !week_commencing || !day || !activity_title) {
    return res.status(400).json({ error: 'room_id, week_commencing, day, activity_title required' });
  }
  // b217 — a week that is wholly a school break carries no planning. Refuse it
  // with the reason rather than saving an activity nobody will ever deliver.
  // A week the calendar simply does not cover (no dates seeded for that year)
  // is still allowed: an unseeded calendar must never block planning.
  try {
    const wcYmd = CAL.cleanYmd(String(week_commencing).slice(0, 10));
    if (wcYmd) {
      const cal = await CAL.loadCalendar(getPool(), null);
      const wk = CAL.resolveWeek(wcYmd, cal.terms, cal.breaks);
      if (!wk.plannable) {
        return res.status(409).json({
          error: wk.message, reason: wk.status,
          week_commencing: wk.week_commencing,
          break: wk.break, half_term: wk.half_term,
        });
      }
    }
  } catch (e) { /* calendar unavailable — never block planning on it */ }
  // Carry the card's Fledge/EYFS areas through onto the plan slot when a card is attached
  // and the caller didn't already specify explicit eyfs_areas.
  const finalEyfsAreas = (eyfs_areas && eyfs_areas.length) ? eyfs_areas
    : (resource_card_slug && Array.isArray(resource_card_areas)) ? resource_card_areas
    : [];
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO weekly_plans
         (room_id, week_commencing, day, theme, activity_type, activity_title, role_of_adult,
          resources, eyfs_areas, eyfs_area, differentiation, ai_generated, learning_intention_id, created_by, updated_at,
          resource_card_slug, resource_card_title, resource_card_areas, activity_description)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),$15,$16,$17,$18)
       RETURNING *`,
      [room_id, week_commencing, day, theme, activity_type, activity_title, role_of_adult,
       resources, finalEyfsAreas, eyfs_area,
       JSON.stringify(differentiation || []), ai_generated || false,
       learning_intention_id || null, req.user.id,
       resource_card_slug || null, resource_card_title || null,
       resource_card_slug ? (resource_card_areas || []) : null,
       // E3b: /ey/planning has always sent activity_description and this INSERT never
       // read it, so the Description box was typed into and thrown away. The page reads
       // act.activity_description straight back, so no client change is needed.
       activity_description || null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PATCH /weekly/:id ────────────────────────────────────────────────────────
router.patch('/weekly/:id', authenticate, async (req, res) => {
  const { role } = req.user;
  if (!PLAN_EDIT_ROLES.includes(role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }
  const { activity_type, activity_title, activity_description, role_of_adult,
          resources, eyfs_areas, eyfs_area, theme, differentiation,
          // b170 — resource-card attachment; pass resource_card_slug: null to detach
          resource_card_slug, resource_card_title, resource_card_areas } = req.body;
  const finalEyfsAreas = (eyfs_areas && eyfs_areas.length) ? eyfs_areas
    : (resource_card_slug && Array.isArray(resource_card_areas)) ? resource_card_areas
    : [];
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE weekly_plans SET
         activity_type=$1, activity_title=$2, role_of_adult=$3, resources=$4,
         eyfs_areas=$5, eyfs_area=$6, theme=$7, differentiation=$8, updated_at=NOW(),
         resource_card_slug=$9, resource_card_title=$10, resource_card_areas=$11,
         -- E3b: activity_description was destructured out of the body above and then
         -- never written, so editing an activity silently discarded the Description.
         -- COALESCE, so a caller that does not know the field cannot wipe it.
         activity_description=COALESCE($13, activity_description)
       WHERE id=$12 RETURNING *`,
      [activity_type, activity_title, role_of_adult, resources,
       finalEyfsAreas, eyfs_area, theme,
       JSON.stringify(differentiation || []),
       resource_card_slug || null, resource_card_title || null,
       resource_card_slug ? (resource_card_areas || []) : null,
       req.params.id,
       activity_description === undefined ? null : activity_description]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /weekly/:id ───────────────────────────────────────────────────────
router.delete('/weekly/:id', authenticate, async (req, res) => {
  const { role } = req.user;
  if (!PLAN_EDIT_ROLES.includes(role)) {
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
  if (!PLAN_EDIT_ROLES.includes(role)) {
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
       WHERE c.room_id=$1 AND s.is_active=true AND ${operationalChildFilter('c')}`,
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

// ═══════════════════════════════════════════════════════════════════════════
// b181 (2026-08-19) — Termly + 6-week planning flow
// ═══════════════════════════════════════════════════════════════════════════
// APPENDED, not rewritten: every route above this line is untouched. The flow is
//
//   1 · Termly plan   term → theme → 1–3 learning intentions per area (picked
//                     from the setting's ACTIVE framework, grouped area →
//                     sub-area) → books + songs → tick calendar events that fall
//                     inside the term's date range.
//   2 · Weekly        6 weeks per term. Per week AND per playroom: resource
//                     cards (continuous provision) + activity-bank cards
//                     (planned activities). Same two libraries are reachable
//                     from the next-steps UI (see src/routes/next-steps.js).
//   3 · Evaluation    last week of term → notification (the EXISTING
//                     scripts/termly-review-nudge.js cron, extended — no second
//                     cron) → group evaluation (one per term per room) +
//                     individual evaluation per child against that child's own
//                     planned activities.
//
// Storage: ladn.term_plans (extended additively) + ladn.termly_plan_weeks +
// ladn.termly_child_evaluations. See scripts/migrations/2026-08-19-b181-*.sql.

const TERM_WEEKS = 6;                       // 6 weeks per term, per the spec
const MAX_INTENTIONS_PER_AREA = 3;          // "1–3 per area"

// b245 — the weekday rhythm the baby room actually runs. A week is five named
// days, each with its own kind of provision, not an undifferentiated bag of
// activities. Stored per row in termly_plan_days so a room that runs a
// different rhythm needs no schema change; this is the DEFAULT the UI offers.
const WEEKDAY_NAMES = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday' };
const DAY_RHYTHM = [
  { weekday: 1, weekday_name: 'Monday',    category: 'Sensory',               category_slug: 'sensory' },
  { weekday: 2, weekday_name: 'Tuesday',   category: 'Maths/Physical',        category_slug: 'maths_physical' },
  { weekday: 3, weekday_name: 'Wednesday', category: 'Art/Design',            category_slug: 'art_design' },
  { weekday: 4, weekday_name: 'Thursday',  category: 'Small World/Role Play', category_slug: 'small_world' },
  { weekday: 5, weekday_name: 'Friday',    category: 'Book Focus',            category_slug: 'book_focus' },
];

// The setting's ACTIVE framework. settings.default_framework is what the
// Framework Builder (b180) writes when a setting adopts its own curriculum.
async function activeFramework(db) {
  const { rows } = await db.query(
    `SELECT value FROM settings WHERE key = 'default_framework' LIMIT 1`);
  return (rows[0] && rows[0].value) || 'birth_to_5';
}

// term_plans is keyed (room_id, term_name, academic_year) by an existing UNIQUE
// constraint. Derive those from the funding_terms row so the b181 flow and the
// legacy /term view address the SAME row rather than forking the data.
// b217: a half-term is now the FIRST-CLASS planning period. Its name
// ('Autumn 1') and academic_year ('2026-2027') drop straight into the existing
// UNIQUE key, so a half-term plan and the legacy /term view address one row.
// Funding-term periods keep their old behaviour so nothing already saved moves.
function termKey(term) {
  if (term && term.kind === 'half_term') {
    return { term_name: term.name, academic_year: term.academic_year };
  }
  return {
    term_name: term.name,
    academic_year: term.year ? String(term.year) : '2025-2026',
  };
}

// b328 (2026-09-11) — THE way to find a room's plan for a period. There were
// three copies of this lookup. One (GET /termly/plan, fixed 2026-09-09) keyed on
// school_term_id; the other two — loadPlanBundle, which builds the planning PDF,
// and plan-drafts' apply — still matched the half-term's DISPLAY NAME. The
// half-terms were renamed "Autumn 1 26/27" on 2026-09-09 while every plan stores
// term_name "Autumn 1", so the PDF reported "Nothing has been planned" for a room
// with a published plan (Toby, "Download planning doesn't download"), and
// applying a draft would have found no existing plan and made a second one.
// A display string is not an identity: match the half-term id first, and keep
// the name path only for older rows that predate school_term_id.
async function findTermPlan(db, roomId, term) {
  const { term_name, academic_year } = termKey(term);
  const { rows } = await db.query(
    `SELECT * FROM term_plans
      WHERE room_id = $1
        AND ( ($2::int IS NOT NULL AND school_term_id = $2::int)
              OR (school_term_id IS NULL AND term_name = $3 AND academic_year = $4) )
      ORDER BY (school_term_id IS NOT NULL) DESC
      LIMIT 1`,
    [roomId, term && term.kind === 'half_term' ? term.id : null, term_name, academic_year]);
  return rows[0] || null;
}

async function loadTerm(db, termId) {
  const { rows } = await db.query(
    `SELECT id, name, year, start_date, end_date, is_current
       FROM funding_terms WHERE id = $1 LIMIT 1`, [termId]);
  return rows[0] || null;
}

// b217 — one planning period, from either source. `half_term_id` selects a real
// TEACHING half-term out of ladn.school_terms; `term_id` still selects a
// funding period, because plans saved before b217 are keyed off one. The two
// are never the same thing and are never silently swapped: the caller picks.
async function resolvePeriod(db, q) {
  const htId = parseInt(q.half_term_id, 10);
  if (Number.isInteger(htId)) {
    const ht = await CAL.loadHalfTermById(db, htId);
    if (!ht) return null;
    return {
      kind: 'half_term',
      id: ht.id, name: ht.name, academic_year: ht.academic_year,
      term: ht.term, half: ht.half, year: parseInt(ht.academic_year.slice(0, 4), 10),
      start_date: ht.start_date, end_date: ht.end_date,
      notes: ht.notes, source: ht.source,
    };
  }
  const tId = parseInt(q.term_id, 10);
  if (!Number.isInteger(tId)) return null;
  const t = await loadTerm(db, tId);
  return t ? Object.assign({ kind: 'funding' }, t) : null;
}

// The week rows a period should show. A half-term uses the real calendar (break
// weeks removed, part weeks flagged); a funding period keeps the old fixed six.
async function periodWeeks(db, period) {
  if (period && period.kind === 'half_term') {
    const breaks = await CAL.loadBreaks(db, null);
    return CAL.halfTermWeeks(period, breaks);
  }
  return termWeekDates(period).map((wc, i) => ({
    week_no: i + 1, week_commencing: wc, first_day: wc,
    last_day: CAL.addDays(wc, 4), partial: false, closures: [],
  }));
}

function requireCalendarEdit(req, res) {
  const ok = ['manager', 'deputy_manager', 'admin', 'headteacher'];
  if (!hasRole(req.user, ok)) {
    res.status(403).json({ error: 'Only a manager can edit the term calendar' });
    return false;
  }
  return true;
}

// The 6 week-commencing Mondays of a term, starting from the first Monday on or
// after start_date and stopping at end_date (a short term simply yields fewer).
function termWeekDates(term, count = TERM_WEEKS) {
  const out = [];
  if (!term || !term.start_date) return out;
  const start = new Date(term.start_date);
  const end   = term.end_date ? new Date(term.end_date) : null;
  const day   = start.getUTCDay();
  const first = new Date(start);
  first.setUTCDate(start.getUTCDate() + (day === 1 ? 0 : (day === 0 ? 1 : 8 - day)));
  for (let i = 0; i < count; i++) {
    const d = new Date(first);
    d.setUTCDate(first.getUTCDate() + i * 7);
    if (end && d > end) break;
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function asIntArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n));
}
function asSlugArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(s => String(s == null ? '' : s).trim())
          .filter(s => /^[a-z0-9-]+$/.test(s));
}
function asTextArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map(s => String(s == null ? '' : s).trim()).filter(Boolean);
}

// Resource-card titles come from the JSON card files, not the DB — reuse the
// loader the resource-cards route already exposes rather than re-reading disk.
function cardIndex() {
  try { return require('./resource-cards')._loadCards(); }
  catch { return { bySlug: {}, index: [] }; }
}
function hydrateCards(slugs) {
  const { bySlug } = cardIndex();
  return slugs.map(slug => {
    const c = bySlug[slug];
    return {
      slug,
      title:     c ? (c.title || slug) : slug,
      areas:     c && Array.isArray(c.areas) ? c.areas : [],
      age_range: c ? (c.age_range || null) : null,
      missing:   !c,
    };
  });
}

function requirePlanEdit(req, res) {
  if (!hasRole(req.user, PLAN_EDIT_ROLES)) {
    res.status(403).json({ error: 'Insufficient permissions' });
    return false;
  }
  return true;
}

// ─── GET /termly/context ─────────────────────────────────────────────────────
// One call for everything the termly form needs to render its pickers: real
// terms, rooms, the active framework, and the autocomplete suggestions drawn
// from PREVIOUS terms (themes / books / songs).
router.get('/termly/context', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const framework = await activeFramework(db);
    // b217 — the planning periods are the HALF-TERMS. funding_terms is still
    // returned (older plans point at one) but is labelled for what it is.
    const today = CAL.cleanYmd(req.query.date, CAL.todayYmd());
    const cal = await CAL.loadCalendar(db, null);
    const [terms, rooms, themes, books, songs] = await Promise.all([
      // b298 — the 17 "EyMan term N" rows imported from EyLog carry 1970-01-01
      // dates and exist only as funding history. They are never a planning
      // period, so they are not offered below; they stay in the table (the
      // child_funding rows pointing at them must survive) and are shown,
      // read-only, on Settings → Funding dates. No term_plan references one.
      db.query(`SELECT id, name, year,
                       to_char(start_date,'YYYY-MM-DD') AS start_date,
                       to_char(end_date,'YYYY-MM-DD')   AS end_date,
                       is_current, source, eylog_term_id
                  FROM funding_terms ORDER BY start_date DESC`),
      db.query(`SELECT id, name FROM rooms ORDER BY id`),
      db.query(`SELECT DISTINCT theme FROM term_plans
                 WHERE theme IS NOT NULL AND theme <> '' ORDER BY theme`),
      db.query(`SELECT DISTINCT unnest(key_books) AS v FROM term_plans
                 WHERE key_books IS NOT NULL ORDER BY v`),
      db.query(`SELECT DISTINCT unnest(songs) AS v FROM term_plans
                 WHERE songs IS NOT NULL ORDER BY v`),
    ]);
    res.json({
      framework,
      term_weeks: TERM_WEEKS,
      max_plan_weeks: CAL.MAX_PLAN_WEEKS,
      max_intentions_per_area: MAX_INTENTIONS_PER_AREA,
      // b217 — half_terms is what the term picker should offer. `terms` is the
      // FUNDING period list, kept only so pre-b217 plans stay reachable.
      half_terms: cal.terms.map(t => Object.assign({}, t, {
        weeks: CAL.halfTermWeeks(t, cal.breaks).length,
      })),
      breaks: cal.breaks,
      today: CAL.resolveDay(today, cal.terms, cal.breaks),
      today_week: CAL.resolveWeek(today, cal.terms, cal.breaks),
      terms: FUNDP.classify(terms.rows).periods,
      historic_funding_terms: FUNDP.classify(terms.rows).historic,
      funding_terms_note: 'Funding periods (1 Sep–31 Dec, 1 Jan–31 Mar, 1 Apr–31 Aug) are NOT school terms.',
      rooms: rooms.rows,
      suggestions: {
        themes: themes.rows.map(r => r.theme),
        books:  books.rows.map(r => r.v).filter(Boolean),
        songs:  songs.rows.map(r => r.v).filter(Boolean),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /termly/framework ───────────────────────────────────────────────────
// The active framework's statements grouped area → sub-area, which is exactly
// how the intentions picker displays them. sub_area is the b180 column; where a
// framework has none we fall back to `aspect`, and failing that to a single
// unnamed group, so older frameworks still group sensibly.
router.get('/termly/framework', authenticate, async (req, res) => {
  try {
    const db = getPool();
    let framework = req.query.framework || await activeFramework(db);
    // fledge-off (2026-10-26): while the one Fledge switch is off (src/lib/fledge-switch.js)
    // a request for Fledge — the termly plan's intention picker asks for it by name —
    // gets the setting's own framework (Birth to 5 Matters) instead.
    {
      const FS = require('../lib/fledge-switch');
      if (FS.isFledgeKey(framework) && !(await FS.isFledgeEnabled(db))) framework = await FS.effectiveDefaultFramework(db);
    }
    // b332 — a retired statement is not offered. The Fledge Profile (19
    // statements nobody has ever used) is retired by flag, not deleted, so it
    // still renders in the printed framework and still resolves through
    // profile_refs; it simply stops appearing in the picker.
    const { rows } = await db.query(
      `SELECT id, area, sub_area, aspect, age_range, statement_code, statement_text
         FROM framework_statements
        WHERE framework = $1
          AND is_active
        ORDER BY area, COALESCE(sub_area, aspect, ''), ordinal NULLS LAST, id`,
      [framework]);

    const areas = [];
    const areaIdx = new Map();
    for (const r of rows) {
      if (!areaIdx.has(r.area)) {
        areaIdx.set(r.area, { area: r.area, sub_areas: [], _sub: new Map() });
        areas.push(areaIdx.get(r.area));
      }
      const a = areaIdx.get(r.area);
      const subName = r.sub_area || r.aspect || '';
      if (!a._sub.has(subName)) {
        a._sub.set(subName, { sub_area: subName || null, statements: [] });
        a.sub_areas.push(a._sub.get(subName));
      }
      a._sub.get(subName).statements.push({
        id: r.id, code: r.statement_code, text: r.statement_text,
        age_range: r.age_range, area: r.area, sub_area: r.sub_area || null,
      });
    }
    areas.forEach(a => delete a._sub);
    res.json({ framework, areas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /termly/events ──────────────────────────────────────────────────────
// Calendar events falling inside the term's date range, for the "tick which
// events belong in this plan" step. Reads the EXISTING ladn.events calendar.
router.get('/termly/events', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const term = await resolvePeriod(db, req.query);   // b217 — half-term or funding period
    if (!term) return res.status(404).json({ error: 'Term not found' });
    const { rows } = await db.query(
      `SELECT id, title, description, event_date, start_time, location, audience
         FROM events
        WHERE event_date >= $1::date AND event_date <= $2::date
        ORDER BY event_date, COALESCE(start_time, ''), id`,
      [term.start_date, term.end_date]);
    res.json({ term, events: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /termly/plan ────────────────────────────────────────────────────────
// The whole plan for a term+room: header, intentions, books/songs, chosen
// events (hydrated), and the 6 weeks with their cards resolved to titles.
router.get('/termly/plan', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const roomId = parseInt(req.query.room_id, 10);
    if (!roomId) return res.status(400).json({ error: 'room_id required' });
    // b217 — half_term_id is the real planning period; term_id (funding) still
    // resolves so plans saved before b217 open unchanged.
    const term = await resolvePeriod(db, req.query);
    if (!term) return res.status(400).json({ error: 'half_term_id (or legacy term_id) required' });
    const { term_name, academic_year } = termKey(term);

    // Match on the half-term's ID first, and only fall back to the name.
    //
    // The name match alone was fragile and it broke the moment the half-terms
    // were renamed to carry the year (2026-09-09): the picker offered
    // "Autumn 1 26/27" while every existing plan stored term_name "Autumn 1",
    // so a room with a perfectly good plan reported "No plan yet for this term".
    // A display string is not an identity. term_plans.school_term_id already
    // holds the real link (12 of 14 rows), so use it, and keep the name path for
    // the older rows that predate it.
    const plan = await findTermPlan(db, roomId, term);   // b328 — the one lookup

    // b217 — the plan's weeks now come from the term calendar: break weeks are
    // not offered at all, and a part week (a term starting on a Wednesday) says so.
    const planWeeks = await periodWeeks(db, term);
    const weekDates = planWeeks.map(w => w.week_commencing);
    const cal = term.kind === 'half_term' ? await CAL.loadCalendar(db, null) : null;
    const today = CAL.todayYmd();
    const calendar = cal ? {
      today: CAL.resolveDay(today, cal.terms, cal.breaks),
      today_week: CAL.resolveWeek(today, cal.terms, cal.breaks),
      is_draft: term.start_date > today,          // planning a half-term that hasn't started
      is_finished: term.end_date < today,
    } : null;
    // b302 — the room's own name, for the read-only view's heading. One extra
    // lookup on a screen that already runs five; a plan headed "Room 2" is not
    // the plan Toby uploaded.
    const { rows: roomRows } = await db.query(
      `SELECT id, name FROM rooms WHERE id = $1`, [roomId]);
    const room = roomRows[0] || { id: roomId, name: null };

    if (!plan) {
      return res.json({ term, plan: null, weeks: [], days: [], week_dates: weekDates,
                        plan_weeks: planWeeks, calendar, events: [], child_evaluations: [],
                        view: TPV.planView(null, { term, room }) });
    }

    const eventIds = asIntArray(plan.event_ids);
    const [weeksQ, eventsQ, evalsQ, daysQ] = await Promise.all([
      db.query(
        `SELECT w.*, r.name AS room_name
           FROM termly_plan_weeks w
           LEFT JOIN rooms r ON r.id = w.room_id
          WHERE w.plan_id = $1
          ORDER BY w.week_no, w.room_id`, [plan.id]),
      eventIds.length
        ? db.query(`SELECT id, title, event_date, location FROM events
                     WHERE id = ANY($1::int[]) ORDER BY event_date`, [eventIds])
        : Promise.resolve({ rows: [] }),
      db.query(
        `SELECT e.*, c.first_name, c.last_name
           FROM termly_child_evaluations e
           JOIN children c ON c.id = e.child_id
          WHERE e.plan_id = $1
          ORDER BY c.first_name, c.last_name`, [plan.id]),
      // b245 — the DAY rows. The baby room plans a fixed weekday rhythm
      // (Mon sensory, Tue maths/physical, Wed art, Thu small world, Fri book),
      // so a week is five named days, not one bag of cards. Weeks with no day
      // rows return none and the page falls back to the pre-b245 week view.
      db.query(
        `SELECT d.*, r.name AS room_name
           FROM termly_plan_days d
           LEFT JOIN rooms r ON r.id = d.room_id
          WHERE d.plan_id = $1
          ORDER BY d.week_no, d.room_id, d.weekday`, [plan.id]),
    ]);

    // Resolve every activity id used across the weeks AND days in one query.
    const allActivityIds = [...new Set([
      ...weeksQ.rows.flatMap(w => asIntArray(w.activity_ids)),
      ...daysQ.rows.flatMap(d => asIntArray(d.activity_ids)),
    ])];
    const actById = new Map();
    if (allActivityIds.length) {
      const { rows: acts } = await db.query(
        `SELECT id, name, description, eyfs_areas, age_range, category
           FROM curriculum_activities WHERE id = ANY($1::int[])`, [allActivityIds]);
      acts.forEach(a => actById.set(a.id, a));
    }

    const weeks = weeksQ.rows.map(w => ({
      id: w.id, week_no: w.week_no, room_id: w.room_id, room_name: w.room_name,
      week_commencing: w.week_commencing, notes: w.notes,
      // b332 — the adult's role, for rooms that plan in weeks rather than in
      // named days. The baby room has had this per day since b245.
      role_of_adult: w.role_of_adult || null,
      resource_cards: hydrateCards(asSlugArray(w.resource_card_ids)),
      activities: asIntArray(w.activity_ids).map(id => actById.get(id) || { id, name: `Activity #${id}`, missing: true }),
    }));

    // b245 — days, hydrated the same way weeks are so the page renders both
    // from one shape.
    const days = daysQ.rows.map(d => ({
      id: d.id, week_no: d.week_no, room_id: d.room_id, room_name: d.room_name,
      weekday: d.weekday, weekday_name: WEEKDAY_NAMES[d.weekday] || null,
      category: d.category, category_slug: d.category_slug,
      title: d.title, role_of_adult: d.role_of_adult, staff_note: d.staff_note,
      description: d.description, intention: d.intention,   // ps-autumn2-20261030
      block_no: d.block_no, notes: d.notes, source: d.source,
      resource_cards: hydrateCards(asSlugArray(d.resource_card_ids)),
      activities: asIntArray(d.activity_ids)
        .map(id => actById.get(id) || { id, name: `Activity #${id}`, missing: true }),
    }));

    // b302 — `view` is the plan as every portal should render it: intentions
    // resolved from whichever column holds them, plus the books, songs, events
    // and — new here — the ACTIVITIES, which the termly screens never surfaced
    // even though they were already loaded three statements above. `plan` is
    // still the raw row, so nothing that read it before changes.
    const view = TPV.planView(plan, {
      weeks, days, events: eventsQ.rows, term, room,
    });

    res.json({ term, plan, weeks, days, rhythm: DAY_RHYTHM,
               week_dates: weekDates, plan_weeks: planWeeks, calendar,
               events: eventsQ.rows, child_evaluations: evalsQ.rows, view });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /termly/plan ────────────────────────────────────────────────────────
// Upsert step 1. Reuses the existing term_plans UNIQUE (room_id, term_name,
// academic_year) constraint, and keeps the LEGACY learning_intentions text[] in
// sync (flattened) so the older term view keeps rendering.
router.put('/termly/plan', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const { half_term_id, term_id, room_id, theme, intentions, books, songs, event_ids,
          learning_intentions } = req.body;
  if (!room_id) return res.status(400).json({ error: 'room_id required' });
  if (!half_term_id && !term_id) {
    return res.status(400).json({ error: 'half_term_id (or legacy term_id) required' });
  }
  try {
    const db = getPool();
    const term = await resolvePeriod(db, { half_term_id, term_id });   // b217
    if (!term) return res.status(404).json({ error: 'Term not found' });
    const { term_name, academic_year } = termKey(term);
    const framework = await activeFramework(db);

    // intentions: { "<area>": [ {statement_id, code, text, sub_area} ] }, capped
    // at MAX_INTENTIONS_PER_AREA. Anything not shaped like that is dropped
    // rather than stored half-formed.
    const cleanIntentions = {};
    const flat = [];
    if (intentions && typeof intentions === 'object' && !Array.isArray(intentions)) {
      for (const [area, list] of Object.entries(intentions)) {
        if (!Array.isArray(list) || !list.length) continue;
        const picked = list.slice(0, MAX_INTENTIONS_PER_AREA).map(it => ({
          statement_id: it && it.statement_id != null ? parseInt(it.statement_id, 10) : null,
          code:         it && it.code ? String(it.code) : null,
          text:         String((it && it.text) || '').trim(),
          sub_area:     it && it.sub_area ? String(it.sub_area) : null,
          area,
        })).filter(it => it.text);
        if (picked.length) {
          cleanIntentions[area] = picked;
          picked.forEach(p => flat.push(`${area}: ${p.text}`));
        }
      }
    }

    // ── b302 — THE IMPORTED INTENTIONS ARE NOT COLLATERAL ─────────────────────
    // Until now this route derived learning_intentions from the ticked framework
    // statements and wrote the result unconditionally. On a plan imported from
    // Toby's own paper planning — five sentences in learning_intentions, nothing
    // ticked — opening the screen and pressing Save for any other reason (a
    // theme tweak, one more book) derived an EMPTY array and wiped all five. The
    // parents app, the public curriculum page and the termly update all read
    // that column, so a save on a staff screen silently emptied the plan three
    // portals show. Nobody would have connected the two.
    //
    // Three cases now, and only the third writes:
    //   • an explicit list in the body  → authoritative, including [] to clear
    //   • statements were ticked        → derived, exactly as before
    //   • neither                       → the stored array is LEFT ALONE
    const explicitFlat = Array.isArray(learning_intentions)
      ? learning_intentions.map(v => String(v == null ? '' : v).trim()).filter(Boolean)
      : null;
    const flatOut = explicitFlat !== null ? explicitFlat : flat;
    const keepStoredFlat = explicitFlat === null && !flat.length;

    // b217 — school_term_id records the HALF-TERM; term_id keeps recording the
    // funding period, and COALESCE means saving a half-term plan never wipes a
    // funding link an older save put there.
    const schoolTermId = term.kind === 'half_term' ? term.id : null;
    const fundingTermId = term.kind === 'funding' ? term.id : null;
    const { rows } = await db.query(
      `INSERT INTO term_plans
         (room_id, term_name, academic_year, term_id, framework, theme,
          intentions, learning_intentions, key_books, songs, event_ids, created_by, updated_at,
          school_term_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::text[],$9::text[],$10::text[],$11::jsonb,$12, now(),$13)
       ON CONFLICT (room_id, term_name, academic_year) DO UPDATE SET
         term_id             = COALESCE(EXCLUDED.term_id, term_plans.term_id),
         school_term_id      = COALESCE(EXCLUDED.school_term_id, term_plans.school_term_id),
         framework           = EXCLUDED.framework,
         theme               = EXCLUDED.theme,
         intentions          = EXCLUDED.intentions,
         learning_intentions = CASE WHEN $14::boolean
                                 THEN term_plans.learning_intentions
                                 ELSE EXCLUDED.learning_intentions END,
         key_books           = EXCLUDED.key_books,
         songs               = EXCLUDED.songs,
         event_ids           = EXCLUDED.event_ids,
         updated_at          = now()
       RETURNING *`,
      [room_id, term_name, academic_year, fundingTermId, framework, String(theme || '').trim(),
       JSON.stringify(cleanIntentions), flatOut, asTextArray(books), asTextArray(songs),
       JSON.stringify(asIntArray(event_ids)), req.user.id || null, schoolTermId,
       keepStoredFlat]);

    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /termly/week ────────────────────────────────────────────────────────
// Upsert one (week, room) row of step 2. resource_card_ids are card SLUGS
// (continuous provision), activity_ids are curriculum_activities ids.
router.put('/termly/week', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const { plan_id, week_no, room_id, week_commencing, resource_card_ids, activity_ids, notes } = req.body;
  const wk = parseInt(week_no, 10);
  if (!plan_id || !room_id) return res.status(400).json({ error: 'plan_id and room_id required' });
  // b217 — a real half-term is 5–8 weeks, not a fixed 6. The ceiling is the
  // termly_plan_weeks CHECK constraint (1–12), so the DB and the API agree.
  if (!Number.isInteger(wk) || wk < 1 || wk > CAL.MAX_PLAN_WEEKS) {
    return res.status(400).json({ error: `week_no must be 1–${CAL.MAX_PLAN_WEEKS}` });
  }
  try {
    const db = getPool();
    const { rows: planRows } = await db.query(`SELECT id FROM term_plans WHERE id = $1`, [plan_id]);
    if (!planRows.length) return res.status(404).json({ error: 'Plan not found' });

    const { rows } = await db.query(
      `INSERT INTO termly_plan_weeks
         (plan_id, week_no, room_id, week_commencing, resource_card_ids, activity_ids, notes, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8, now())
       ON CONFLICT (plan_id, week_no, room_id) DO UPDATE SET
         week_commencing   = EXCLUDED.week_commencing,
         resource_card_ids = EXCLUDED.resource_card_ids,
         activity_ids      = EXCLUDED.activity_ids,
         notes             = EXCLUDED.notes,
         updated_at        = now()
       RETURNING *`,
      [plan_id, wk, room_id, week_commencing || null,
       JSON.stringify(asSlugArray(resource_card_ids)),
       JSON.stringify(asIntArray(activity_ids)),
       notes == null ? null : String(notes), req.user.id || null]);

    const row = rows[0];
    res.json({
      ...row,
      resource_cards: hydrateCards(asSlugArray(row.resource_card_ids)),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /termly/week/:id ─────────────────────────────────────────────────
router.delete('/termly/week/:id', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  try {
    const db = getPool();
    const { rowCount } = await db.query(`DELETE FROM termly_plan_weeks WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b290 — PUBLISH / UNPUBLISH
// ═══════════════════════════════════════════════════════════════════════════
// Toby: "add all the planning to wren as drafts — for the whole year, then the
// staff can edit and then publish."
//
// ONE HALF-TERM AT A TIME. The body carries a plan_id, and a term_plans row IS
// one room's one half-term (UNIQUE (room_id, term_name, academic_year)). There
// is deliberately no "publish the year" button: the whole reason b284 was wrong
// is that a year went live in one motion without anyone reading it. Publishing
// the Pre-school's Spring 1 does not publish the Baby Room's, and does not
// publish Spring 2.
//
// Both directions are recorded — publishing is the moment planning reaches
// parents, and unpublishing is the moment it stops, which is the one someone
// will later need to explain.

/** Load a plan and refuse politely if it is not there. */
async function loadPlanForPublish(db, planId) {
  const { rows } = await db.query(
    `SELECT id, room_id, term_name, academic_year, theme, status,
            key_books, songs, learning_intentions, plan_source
       FROM term_plans WHERE id = $1`, [planId]);
  return rows[0] || null;
}

async function logPublish(db, planId, action, staffId, from, to, note) {
  try {
    await db.query(
      `INSERT INTO term_plan_publish_log (plan_id, action, staff_id, from_status, to_status, note)
       VALUES ($1,$2,$3,$4,$5,$6)`, [planId, action, staffId || null, from, to, note || null]);
  } catch (e) {
    // The log is evidence, not a gate: a plan that has been published must not
    // fail to publish because the history table is missing on this schema.
    console.error('[planning] publish log:', e.message);
  }
}

// ─── POST /termly/publish ────────────────────────────────────────────────────
router.post('/termly/publish', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const planId = parseInt(req.body && req.body.plan_id, 10);
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  try {
    const db = getPool();
    if (!await planStatus.hasStatusColumn(db)) {
      return res.status(409).json({ error: 'This database has no draft/publish column yet — run migrations/2026-09-08-b290-plan-drafts.sql' });
    }
    const plan = await loadPlanForPublish(db, planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    // An EMPTY plan may not be published. b276 writes a deliberately blank row
    // for a half-term the paper planning does not cover, flagged
    // plan_source='not-planned:…', and publishing that would put a heading with
    // nothing under it in front of parents — the exact thing the public
    // curriculum page goes out of its way to avoid saying.
    const emptyish = !String(plan.theme || '').trim()
      || /^not-planned/i.test(String(plan.plan_source || ''));
    if (emptyish) {
      return res.status(400).json({
        error: 'There is nothing in this half-term to publish yet — give it a theme first.',
      });
    }

    if (plan.status === 'published') {
      return res.json({ ok: true, already: true, plan });
    }

    const { rows } = await db.query(
      `UPDATE term_plans
          SET status = 'published', published_at = now(), published_by = $2, updated_at = now()
        WHERE id = $1
        RETURNING id, room_id, term_name, academic_year, theme, status, published_at, published_by`,
      [planId, req.user.id || null]);
    await logPublish(db, planId, 'publish', req.user.id, plan.status, 'published',
      `${plan.term_name} ${plan.academic_year} · room ${plan.room_id}`);

    res.json({ ok: true, plan: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /termly/unpublish ──────────────────────────────────────────────────
// Back to draft. published_by/published_at are CLEARED, because they describe the
// live state ("this is in front of parents, put there by X"); who published it
// last time stays in term_plan_publish_log, which is where history belongs.
router.post('/termly/unpublish', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const planId = parseInt(req.body && req.body.plan_id, 10);
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  try {
    const db = getPool();
    if (!await planStatus.hasStatusColumn(db)) {
      return res.status(409).json({ error: 'This database has no draft/publish column yet — run migrations/2026-09-08-b290-plan-drafts.sql' });
    }
    const plan = await loadPlanForPublish(db, planId);
    if (!plan) return res.status(404).json({ error: 'Plan not found' });
    if (plan.status === 'draft') return res.json({ ok: true, already: true, plan });

    const { rows } = await db.query(
      `UPDATE term_plans
          SET status = 'draft', published_at = NULL, published_by = NULL, updated_at = now()
        WHERE id = $1
        RETURNING id, room_id, term_name, academic_year, theme, status, published_at, published_by`,
      [planId]);
    await logPublish(db, planId, 'unpublish', req.user.id, plan.status, 'draft',
      String((req.body && req.body.reason) || '').slice(0, 300) || null);

    res.json({ ok: true, plan: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /termly/publish-log ─────────────────────────────────────────────────
// Who published this half-term, and when. Staff-facing; shown under the Publish
// button so "when did this go live?" is answerable on the screen it happened on.
router.get('/termly/publish-log', authenticate, async (req, res) => {
  const planId = parseInt(req.query.plan_id, 10);
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT l.id, l.action, l.from_status, l.to_status, l.note, l.created_at,
              s.first_name, s.last_name
         FROM term_plan_publish_log l
         LEFT JOIN staff s ON s.id = l.staff_id
        WHERE l.plan_id = $1
        ORDER BY l.created_at DESC LIMIT 20`, [planId]);
    res.json(rows);
  } catch (e) {
    if (e.code === '42P01') return res.json([]);      // un-migrated schema: no history, not an error
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /termly/evaluation — step 3, GROUP ──────────────────────────────────
// One evaluation per term per room, which is exactly one term_plans row. Stored
// on the plan itself rather than in a side table so it can never orphan.
router.put('/termly/evaluation', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  // b217 — carry_forward is the other half of an end-of-half-term review: what
  // moves into the next half-term. Omitting it leaves whatever is already there.
  const { plan_id, evaluation, carry_forward } = req.body;
  if (!plan_id) return res.status(400).json({ error: 'plan_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE term_plans
          SET evaluation    = $2,
              evaluated_at  = CASE WHEN COALESCE(NULLIF($2,''), NULL) IS NULL THEN NULL ELSE now() END,
              evaluated_by  = $3,
              carry_forward = COALESCE($4, carry_forward),
              updated_at    = now()
        WHERE id = $1
        RETURNING id, room_id, term_name, academic_year, evaluation, carry_forward,
                  evaluated_at, evaluated_by`,
      [plan_id, evaluation == null ? '' : String(evaluation), req.user.id || null,
       carry_forward == null ? null : String(carry_forward)]);
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /termly/plan/:id/children — step 3, INDIVIDUAL ──────────────────────
// Each child in the plan's room together with THAT CHILD'S OWN planned
// activities — planned_activities rows carrying their child_id, plus next steps
// that were written from the activity library. Deliberately NOT the whole
// room's group plan: the individual evaluation is against the child's own
// planned activities only.
router.get('/termly/plan/:id/children', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows: planRows } = await db.query(
      `SELECT p.*,
              COALESCE(s.start_date, t.start_date) AS start_date,
              COALESCE(s.end_date,   t.end_date)   AS end_date
         FROM term_plans p
         LEFT JOIN funding_terms t ON t.id = p.term_id
         LEFT JOIN school_terms  s ON s.id = p.school_term_id   -- b217
        WHERE p.id = $1 LIMIT 1`, [req.params.id]);
    if (!planRows.length) return res.status(404).json({ error: 'Plan not found' });
    const plan = planRows[0];
    const from = plan.start_date || '1900-01-01';
    const to   = plan.end_date   || '2999-12-31';

    const { rows: children } = await db.query(
      `SELECT id, first_name, last_name, room_id
         FROM children
        WHERE is_active = true AND room_id = $1
          AND ${operationalChildFilter('children')}
        ORDER BY first_name, last_name`, [plan.room_id]);

    const ids = children.map(c => c.id);
    let plannedByChild = new Map();
    let evalByChild = new Map();
    if (ids.length) {
      const [{ rows: planned }, { rows: evals }] = await Promise.all([
        db.query(
          `SELECT pa.id, pa.child_id, pa.plan_date, pa.status,
                  COALESCE(pa.title, pa.custom_title, ca.name) AS name,
                  ca.id AS activity_id, ca.eyfs_areas
             FROM planned_activities pa
             LEFT JOIN curriculum_activities ca ON ca.id = pa.activity_id
            WHERE pa.child_id = ANY($1::int[])
              AND pa.plan_date >= $2::date AND pa.plan_date <= $3::date
            ORDER BY pa.plan_date`, [ids, from, to]),
        db.query(
          `SELECT * FROM termly_child_evaluations WHERE plan_id = $1 AND child_id = ANY($2::int[])`,
          [plan.id, ids]),
      ]);
      planned.forEach(p => {
        if (!plannedByChild.has(p.child_id)) plannedByChild.set(p.child_id, []);
        plannedByChild.get(p.child_id).push(p);
      });
      evals.forEach(e => evalByChild.set(e.child_id, e));
    }

    res.json({
      plan_id: plan.id,
      room_id: plan.room_id,
      children: children.map(c => ({
        ...c,
        planned_activities: plannedByChild.get(c.id) || [],
        evaluation: evalByChild.get(c.id) || null,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /termly/child-evaluation — step 3, INDIVIDUAL save ──────────────────
router.put('/termly/child-evaluation', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const { plan_id, child_id, evaluation, next_focus, activity_ids } = req.body;
  if (!plan_id || !child_id) return res.status(400).json({ error: 'plan_id and child_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO termly_child_evaluations
         (plan_id, child_id, evaluation, next_focus, activity_ids, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6, now())
       ON CONFLICT (plan_id, child_id) DO UPDATE SET
         evaluation   = EXCLUDED.evaluation,
         next_focus   = EXCLUDED.next_focus,
         activity_ids = EXCLUDED.activity_ids,
         updated_at   = now()
       RETURNING *`,
      [plan_id, child_id, evaluation == null ? null : String(evaluation),
       next_focus == null ? null : String(next_focus),
       JSON.stringify(asIntArray(activity_ids)), req.user.id || null]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /termly/due — which plans are in their evaluation window ────────────
// Shared by the UI banner and by scripts/termly-review-nudge.js so the "is it
// the last week of term" rule lives in exactly one place.
router.get('/termly/due', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const days = parseInt(req.query.window, 10) || 7;
    const { rows } = await db.query(
      `SELECT p.id AS plan_id, p.room_id, r.name AS room_name, p.theme,
              p.term_name, p.academic_year, p.evaluation, p.carry_forward, p.evaluated_at,
              COALESCE(p.school_term_id, p.term_id)        AS term_id,
              COALESCE(s.name, t.name)                     AS term_label,
              CASE WHEN s.id IS NOT NULL THEN 'half_term' ELSE 'funding' END AS period_kind,
              COALESCE(s.end_date, t.end_date)             AS end_date,
              (SELECT count(*) FROM termly_child_evaluations e WHERE e.plan_id = p.id) AS child_evaluations
         FROM term_plans p
         LEFT JOIN funding_terms t ON t.id = p.term_id
         LEFT JOIN school_terms  s ON s.id = p.school_term_id   -- b217
         LEFT JOIN rooms r ON r.id = p.room_id
        WHERE COALESCE(s.end_date, t.end_date) >= CURRENT_DATE
          AND COALESCE(s.end_date, t.end_date) <= CURRENT_DATE + ($1 || ' days')::interval
        ORDER BY COALESCE(s.end_date, t.end_date), p.room_id`, [String(days)]);
    res.json(rows.map(r => ({ ...r, evaluation_outstanding: !r.evaluation })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// b217 (2026-08-24) — the school term calendar
// ═══════════════════════════════════════════════════════════════════════════
// APPENDED, not rewritten. Planning runs on the local (Ealing) school rhythm:
// Autumn 1 · half term · Autumn 2 · Christmas · Spring 1 … The dates live in
// ladn.school_terms + ladn.school_breaks and a manager edits them here, so next
// year's dates and the setting's own INSET days need no deploy.
//
// ⚠️ ladn.funding_terms is a DIFFERENT thing: the free-entitlement claim windows
// (1 Sep–31 Dec, 1 Jan–31 Mar, 1 Apr–31 Aug). A funding period is not a school
// term and the two must never be conflated. Nothing below touches funding_terms.

// ─── GET /calendar — the whole calendar for a year ───────────────────────────
router.get('/calendar', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const date = CAL.cleanYmd(req.query.date, CAL.todayYmd());
    const year = req.query.academic_year || null;      // omit for every year
    const [terms, breaks] = await Promise.all([
      CAL.loadHalfTerms(db, year), CAL.loadBreaks(db, year),
    ]);
    const all = year ? await CAL.loadCalendar(db, null) : { terms, breaks };
    res.json({
      academic_year: year || CAL.academicYearOf(date),
      terms: terms.map(t => Object.assign({}, t, {
        weeks: CAL.halfTermWeeks(t, all.breaks).length,
        label: t.name + ' · ' + CAL.fmtRange(t.start_date, t.end_date),
      })),
      breaks: breaks.map(b => Object.assign({}, b, {
        label: b.name + ' · ' + CAL.fmtRange(b.start_date, b.end_date),
      })),
      break_kinds: CAL.BREAK_KINDS,
      today: CAL.resolveDay(date, all.terms, all.breaks),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /calendar/current — where are we in the school year today? ──────────
// ?date=YYYY-MM-DD overrides "today" (used by the pages and to test a date
// inside a half term without waiting for October).
router.get('/calendar/current', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const date = CAL.cleanYmd(req.query.date, CAL.todayYmd());
    const { terms, breaks } = await CAL.loadCalendar(db, null);
    const day = CAL.resolveDay(date, terms, breaks);
    const week = CAL.resolveWeek(date, terms, breaks);
    res.json(Object.assign({}, day, {
      academic_year: CAL.academicYearOf(date),
      week,
      // Which half-term the pages should open on, and why.
      open_on: week.plannable && day.half_term ? day.half_term
             : (day.previous_half_term || day.next_half_term || null),
      open_reason: week.plannable && day.half_term ? 'current'
                 : (day.previous_half_term ? 'evaluate_previous'
                 : (day.next_half_term ? 'prepare_next' : 'none')),
      half_terms: terms,
      breaks,
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /calendar/week — is this week plannable, and which half-term is it? ─
router.get('/calendar/week', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const anchor = CAL.cleanYmd(req.query.week) || CAL.cleanYmd(req.query.date, CAL.todayYmd());
    const { terms, breaks } = await CAL.loadCalendar(db, null);
    res.json(CAL.resolveWeek(anchor, terms, breaks));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /calendar/half-term/:id/weeks — the plannable weeks of a half-term ──
router.get('/calendar/half-term/:id/weeks', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const ht = await CAL.loadHalfTermById(db, req.params.id);
    if (!ht) return res.status(404).json({ error: 'Half-term not found' });
    const breaks = await CAL.loadBreaks(db, null);
    res.json({ half_term: ht, weeks: CAL.halfTermWeeks(ht, breaks) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function validRange(body, res) {
  const start = CAL.cleanYmd(body.start_date);
  const end   = CAL.cleanYmd(body.end_date) || start;
  if (!start || !end) { res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD' }); return null; }
  if (end < start)    { res.status(400).json({ error: 'end_date is before start_date' }); return null; }
  return { start, end };
}

// ─── POST /calendar/term — add or edit one half-term (manager) ───────────────
router.post('/calendar/term', authenticate, async (req, res) => {
  if (!requireCalendarEdit(req, res)) return;
  const { id, academic_year, term, half, notes, source } = req.body;
  const range = validRange(req.body, res); if (!range) return;
  const h = parseInt(half, 10);
  if (!academic_year || !/^\d{4}-\d{4}$/.test(String(academic_year))) {
    return res.status(400).json({ error: "academic_year must look like '2026-2027'" });
  }
  if (!CAL.TERM_ORDER[term]) return res.status(400).json({ error: 'term must be Autumn, Spring or Summer' });
  if (h !== 1 && h !== 2)    return res.status(400).json({ error: 'half must be 1 or 2' });
  const name = String(req.body.name || (term + ' ' + h)).trim();
  try {
    const db = getPool();
    if (id) {
      // b298 — `source` is what makes a year read "provisional". Editing a
      // generated date by hand is exactly how a provisional year stops being
      // provisional, so a caller may replace it. Omit it and it is untouched,
      // which is what every pre-b298 caller does.
      const { rows } = await db.query(
        `UPDATE school_terms
            SET academic_year=$2, term=$3, half=$4, name=$5,
                start_date=$6::date, end_date=$7::date, notes=$8,
                source=COALESCE($9, source), updated_at=now()
          WHERE id=$1 RETURNING id`, [parseInt(id, 10), academic_year, term, h, name,
                                      range.start, range.end, notes == null ? null : String(notes),
                                      source ? String(source) : null]);
      if (!rows.length) return res.status(404).json({ error: 'Half-term not found' });
    } else {
      await db.query(
        `INSERT INTO school_terms (academic_year, term, half, name, start_date, end_date, source, notes, created_by)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8,$9)
         ON CONFLICT (academic_year, term, half) DO UPDATE SET
           name=EXCLUDED.name, start_date=EXCLUDED.start_date, end_date=EXCLUDED.end_date,
           notes=EXCLUDED.notes, updated_at=now()`,
        [academic_year, term, h, name, range.start, range.end,
         source || 'edited in Wren', notes == null ? null : String(notes), req.user.id || null]);
    }
    const ht = (await CAL.loadHalfTerms(db, academic_year)).find(t => t.term === term && t.half === h);
    res.json(ht || { ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /calendar/term/:id ───────────────────────────────────────────────
// Refused while a plan still points at the half-term — deleting it would orphan
// the plan rather than tidy anything up.
router.delete('/calendar/term/:id', authenticate, async (req, res) => {
  if (!requireCalendarEdit(req, res)) return;
  try {
    const db = getPool();
    const { rows: used } = await db.query(
      `SELECT count(*)::int AS n FROM term_plans WHERE school_term_id = $1`, [req.params.id]);
    if (used[0].n > 0) {
      return res.status(409).json({ error: `${used[0].n} plan(s) still use this half-term — edit its dates instead of deleting it.` });
    }
    const { rowCount } = await db.query(`DELETE FROM school_terms WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /calendar/break — half term, holiday, bank holiday, INSET… ────────
// This is where Toby adds the 5 INSET + 3 occasional days: Ealing does not
// publish them centrally, so they can only come from the setting itself.
router.post('/calendar/break', authenticate, async (req, res) => {
  if (!requireCalendarEdit(req, res)) return;
  const { id, academic_year, name, kind, notes, source } = req.body;
  const range = validRange(req.body, res); if (!range) return;
  if (!String(name || '').trim()) return res.status(400).json({ error: 'name required' });
  const k = String(kind || 'holiday');
  if (!CAL.BREAK_KINDS.includes(k)) {
    return res.status(400).json({ error: 'kind must be one of ' + CAL.BREAK_KINDS.join(', ') });
  }
  const year = academic_year && /^\d{4}-\d{4}$/.test(String(academic_year))
    ? String(academic_year) : CAL.academicYearOf(range.start);
  try {
    const db = getPool();
    if (id) {
      const { rows } = await db.query(
        `UPDATE school_breaks
            SET academic_year=$2, name=$3, kind=$4, start_date=$5::date, end_date=$6::date,
                notes=$7, source=COALESCE($8, source), updated_at=now()
          WHERE id=$1 RETURNING id`,
        [parseInt(id, 10), year, String(name).trim(), k, range.start, range.end,
         notes == null ? null : String(notes), source ? String(source) : null]);
      if (!rows.length) return res.status(404).json({ error: 'Break not found' });
      const all = await CAL.loadBreaks(db, null);
      return res.json(all.find(b => b.id === parseInt(id, 10)) || { ok: true });
    }
    await db.query(
      `INSERT INTO school_breaks (academic_year, name, kind, start_date, end_date, source, notes, created_by)
       VALUES ($1,$2,$3,$4::date,$5::date,$6,$7,$8)
       ON CONFLICT (academic_year, name, start_date) DO UPDATE SET
         kind=EXCLUDED.kind, end_date=EXCLUDED.end_date, notes=EXCLUDED.notes, updated_at=now()`,
      [year, String(name).trim(), k, range.start, range.end,
       source || 'added in Wren', notes == null ? null : String(notes), req.user.id || null]);
    const all = await CAL.loadBreaks(db, null);
    res.json(all.find(b => b.academic_year === year && b.name === String(name).trim()
                        && b.start_date === range.start) || { ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /calendar/break/:id ──────────────────────────────────────────────
router.delete('/calendar/break/:id', authenticate, async (req, res) => {
  if (!requireCalendarEdit(req, res)) return;
  try {
    const db = getPool();
    const { rowCount } = await db.query(`DELETE FROM school_breaks WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /calendar/impact — what a date change would do to existing plans ────
// b298 (2026-09-10). A term date is not a label: ladn.term_plans links on
// school_term_id and ladn.termly_plan_weeks numbers its weeks from the
// half-term's start, so moving a date silently changes which weeks a plan
// covers — and shortening one strands weeks staff have already written.
// On 2026-09-09 the half-terms were briefly rewritten to funding boundaries and
// the breaks went with them. This endpoint is what makes the next such edit ask
// first. It writes NOTHING; it answers "who is affected, and how".
//
// Four shapes, all read-only:
//   ?term_id=N&start_date=&end_date=      move a half-term
//   ?break_id=N&start_date=&end_date=     move a break
//   ?break_id=N&remove=1                  delete a break
//   ?new_break_start=&new_break_end=      add a break
router.get('/calendar/impact', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { terms, breaks } = await CAL.loadCalendar(db, null);
    const start = CAL.cleanYmd(req.query.start_date);
    const end   = CAL.cleanYmd(req.query.end_date) || start;
    const termId  = req.query.term_id  ? parseInt(req.query.term_id, 10)  : null;
    const breakId = req.query.break_id ? parseInt(req.query.break_id, 10) : null;
    const removing = String(req.query.remove || '') === '1';
    const newBreakStart = CAL.cleanYmd(req.query.new_break_start);
    const newBreakEnd   = CAL.cleanYmd(req.query.new_break_end) || newBreakStart;

    // ── build the "after" calendar without touching the database ────────────
    let afterTerms = terms, afterBreaks = breaks, change = null;
    if (termId) {
      const before = terms.find(t => t.id === termId);
      if (!before) return res.status(404).json({ error: 'Half-term not found' });
      if (!start || !end) return res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD' });
      if (end < start)    return res.status(400).json({ error: 'end_date is before start_date' });
      afterTerms = terms.map(t => t.id === termId
        ? Object.assign({}, t, { start_date: start, end_date: end }) : t);
      change = { kind: 'term', id: termId, name: before.name, academic_year: before.academic_year,
                 from: { start_date: before.start_date, end_date: before.end_date },
                 to:   { start_date: start, end_date: end },
                 moved: before.start_date !== start || before.end_date !== end };
    } else if (breakId && removing) {
      const before = breaks.find(b => b.id === breakId);
      if (!before) return res.status(404).json({ error: 'Break not found' });
      afterBreaks = breaks.filter(b => b.id !== breakId);
      change = { kind: 'break_removed', id: breakId, name: before.name,
                 academic_year: before.academic_year,
                 from: { start_date: before.start_date, end_date: before.end_date }, to: null, moved: true };
    } else if (breakId) {
      const before = breaks.find(b => b.id === breakId);
      if (!before) return res.status(404).json({ error: 'Break not found' });
      if (!start || !end) return res.status(400).json({ error: 'start_date and end_date must be YYYY-MM-DD' });
      if (end < start)    return res.status(400).json({ error: 'end_date is before start_date' });
      afterBreaks = breaks.map(b => b.id === breakId
        ? Object.assign({}, b, { start_date: start, end_date: end }) : b);
      change = { kind: 'break', id: breakId, name: before.name, academic_year: before.academic_year,
                 from: { start_date: before.start_date, end_date: before.end_date },
                 to:   { start_date: start, end_date: end },
                 moved: before.start_date !== start || before.end_date !== end };
    } else if (newBreakStart) {
      if (newBreakEnd < newBreakStart) return res.status(400).json({ error: 'end is before start' });
      afterBreaks = breaks.concat([{ id: -1, name: String(req.query.new_break_name || 'New break'),
        kind: String(req.query.new_break_kind || 'holiday'),
        academic_year: CAL.academicYearOf(newBreakStart),
        start_date: newBreakStart, end_date: newBreakEnd }]);
      change = { kind: 'break_added', id: null, name: String(req.query.new_break_name || 'New break'),
                 academic_year: CAL.academicYearOf(newBreakStart), from: null,
                 to: { start_date: newBreakStart, end_date: newBreakEnd }, moved: true };
    } else {
      return res.status(400).json({ error: 'Give term_id, break_id or new_break_start' });
    }

    // ── which half-terms actually change shape ──────────────────────────────
    const wk = (list, brks) => list.map(t => ({
      id: t.id, name: t.name, academic_year: t.academic_year,
      weeks: CAL.halfTermWeeks(t, brks).map(w => w.week_commencing),
      start_date: t.start_date, end_date: t.end_date,
    }));
    const nowMap    = new Map(wk(terms, breaks).map(t => [t.id, t]));
    const afterMap  = new Map(wk(afterTerms, afterBreaks).map(t => [t.id, t]));
    const changed = [];
    for (const [id, before] of nowMap) {
      const after = afterMap.get(id);
      if (!after) continue;
      const same = before.weeks.length === after.weeks.length
                && before.weeks.every((w, i) => w === after.weeks[i])
                && before.start_date === after.start_date && before.end_date === after.end_date;
      if (!same) changed.push({ before, after });
    }

    // ── the plans standing on those half-terms ──────────────────────────────
    const ids = changed.map(c => c.before.id);
    let plans = [];
    if (ids.length) {
      const { rows } = await db.query(
        `SELECT p.id, p.school_term_id, p.term_name, p.academic_year, p.theme, p.status,
                p.room_id, r.name AS room_name,
                COALESCE(p.evaluation,'') <> '' AS evaluated,
                (SELECT count(*)::int FROM termly_plan_weeks w WHERE w.plan_id = p.id) AS week_rows,
                (SELECT max(w.week_no)   FROM termly_plan_weeks w WHERE w.plan_id = p.id) AS max_week_no
           FROM term_plans p
           LEFT JOIN rooms r ON r.id = p.room_id
          WHERE p.school_term_id = ANY($1::int[])
          ORDER BY p.academic_year, p.term_name, r.name NULLS LAST, p.id`, [ids]);
      plans = rows;
    }
    // The written weeks, so "week 6 would fall off the end" can name week 6.
    let weekRows = [];
    if (plans.length) {
      const { rows } = await db.query(
        `SELECT plan_id, week_no, to_char(week_commencing,'YYYY-MM-DD') AS week_commencing
           FROM termly_plan_weeks WHERE plan_id = ANY($1::int[])
          ORDER BY plan_id, week_no`, [plans.map(p => p.id)]);
      weekRows = rows;
    }
    const byPlan = new Map();
    for (const w of weekRows) {
      if (!byPlan.has(w.plan_id)) byPlan.set(w.plan_id, []);
      byPlan.get(w.plan_id).push(w);
    }
    const changeOf = new Map(changed.map(c => [c.before.id, c]));

    const affected = plans.map(p => {
      const c = changeOf.get(p.school_term_id);
      const written = byPlan.get(p.id) || [];
      const afterWeeks = c ? c.after.weeks : [];
      // A week nobody can reach any more: its number is past the end of the
      // half-term as it would then be. That work is not deleted, but it stops
      // being shown, which is the same thing to the person who wrote it.
      const stranded = written.filter(w => w.week_no > afterWeeks.length)
                              .map(w => ({ week_no: w.week_no, week_commencing: w.week_commencing }));
      // A week that survives but lands on a different Monday.
      const moved = written.filter(w => w.week_no <= afterWeeks.length
                                     && w.week_commencing && w.week_commencing !== afterWeeks[w.week_no - 1])
                           .map(w => ({ week_no: w.week_no, from: w.week_commencing, to: afterWeeks[w.week_no - 1] }));
      return Object.assign({}, p, {
        weeks_before: c ? c.before.weeks.length : null,
        weeks_after:  c ? c.after.weeks.length  : null,
        stranded_weeks: stranded,
        moved_weeks: moved,
        // Worth stopping for: written work disappears, or a published plan moves.
        serious: stranded.length > 0 || (p.status === 'published' && moved.length > 0),
      });
    });

    const strandedTotal = affected.reduce((n, a) => n + a.stranded_weeks.length, 0);
    res.json({
      change,
      changed_half_terms: changed.map(c => ({
        id: c.before.id, name: c.before.name, academic_year: c.before.academic_year,
        weeks_before: c.before.weeks.length, weeks_after: c.after.weeks.length,
        start_before: c.before.start_date, start_after: c.after.start_date,
        end_before: c.before.end_date, end_after: c.after.end_date,
      })),
      affected_plans: affected,
      plan_count: affected.length,
      stranded_week_count: strandedTotal,
      needs_confirmation: affected.length > 0,
      serious: affected.some(a => a.serious),
      summary: !affected.length
        ? 'No plan is standing on these dates — safe to save.'
        : `${affected.length} plan${affected.length === 1 ? '' : 's'} `
          + `stand${affected.length === 1 ? 's' : ''} on these dates`
          + (strandedTotal ? `, and ${strandedTotal} written week${strandedTotal === 1 ? '' : 's'} would fall outside the half-term.` : '.'),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /calendar/years — the term calendar grouped by academic year ────────
// b298. What Settings → Term dates renders: every year Wren holds, its six
// half-terms and its breaks interleaved in date order, each half-term carrying
// its plannable week count and how many plans stand on it, and the year flagged
// provisional when its dates were generated rather than published by Ealing.
router.get('/calendar/years', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { terms, breaks } = await CAL.loadCalendar(db, null);
    // b299 — every edition has its own authority, so the copy on the screen has
    // to come from a setting rather than saying "Ealing" to a school in Bristol.
    const { rows: laRows } = await db.query(
      `SELECT value FROM settings WHERE key = 'local_authority' LIMIT 1`);
    const localAuthority = (laRows[0] && String(laRows[0].value || '').trim()) || null;
    const { rows: planCounts } = await db.query(
      `SELECT school_term_id, count(*)::int AS n,
              count(*) FILTER (WHERE status = 'published')::int AS published
         FROM term_plans WHERE school_term_id IS NOT NULL GROUP BY school_term_id`);
    const plansBy = new Map(planCounts.map(r => [r.school_term_id, r]));

    const years = new Map();
    const year = y => {
      if (!years.has(y)) years.set(y, { academic_year: y, terms: [], breaks: [], provisional: false });
      return years.get(y);
    };
    for (const t of terms) {
      const p = plansBy.get(t.id) || { n: 0, published: 0 };
      year(t.academic_year).terms.push(Object.assign({}, t, {
        weeks: CAL.halfTermWeeks(t, breaks).length,
        plan_count: p.n, published_plan_count: p.published,
        label: CAL.fmtRange(t.start_date, t.end_date),
        // The 2026/27 dates came from ealing.gov.uk. Later years were generated
        // from the same rhythm with a computed Easter and WILL move when Ealing
        // publishes — a plan built on one is standing on a guess.
        provisional: /provisional|generated/i.test(t.source || ''),
      }));
    }
    for (const b of breaks) {
      year(b.academic_year).breaks.push(Object.assign({}, b, {
        label: CAL.fmtRange(b.start_date, b.end_date),
        provisional: /provisional|generated/i.test(b.source || ''),
      }));
    }
    const out = Array.from(years.values()).sort((a, b) => a.academic_year < b.academic_year ? -1 : 1);
    for (const y of out) {
      y.provisional = y.terms.length > 0 && y.terms.every(t => t.provisional);
      y.some_provisional = y.terms.some(t => t.provisional) || y.breaks.some(b => b.provisional);
      y.plan_count = y.terms.reduce((n, t) => n + t.plan_count, 0);
      // Terms and breaks in one date-ordered list — the way the year actually
      // runs, and the way the planner already shows it.
      y.timeline = y.terms.map(t => Object.assign({ row: 'term' }, t))
        .concat(y.breaks.map(b => Object.assign({ row: 'break' }, b)))
        .sort((a, b) => a.start_date < b.start_date ? -1 : (a.start_date > b.start_date ? 1 : 0));
    }
    res.json({
      today: CAL.todayYmd(),
      current_academic_year: CAL.academicYearOf(CAL.todayYmd()),
      years: out,
      break_kinds: CAL.BREAK_KINDS,
      can_edit: hasRole(req.user, ['manager', 'deputy_manager', 'admin', 'headteacher']),
      // null when unset, so the screen can say "your local authority" instead of
      // naming the wrong one.
      local_authority: localAuthority,
      // Whether this edition has any calendar at all. The screen shows a
      // different thing to a setting with nothing than to one mid-year.
      has_calendar: out.length > 0,
      current_year_exists: out.some(y => y.academic_year === CAL.academicYearOf(CAL.todayYmd())),
      what_this_is: 'Used for planning: half-terms, weekly plans and the breaks in between.',
      not_this: 'These are NOT the funding periods. Entitlement hours and rates live on Settings → Funding dates.',
      funding_dates_href: '/funding-dates.html',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /calendar/year/generate — start an academic year from nothing ─────
// b299. Every edition has to be able to set its own term dates, the way EyLog
// and Nursery in a Box let a setting do it. Until now a fresh tenant (htps,
// childrenscorner) opened Settings → Term dates on an empty page and had to
// hand-type six half-terms and six breaks before it showed anything, because the
// only generator was a host script hard-coded to the ladn schema.
//
// This writes the standard English six-half-term year — the same rhythm
// src/lib/school-calendar.js has always produced, now shared rather than copied.
// Everything it creates is marked PROVISIONAL: Easter moves, and every local
// authority publishes its own dates. The point is to give a setting a year to
// correct, not to tell it what its year is.
//
// It REFUSES a year that already holds half-terms. Overwriting a published
// calendar because somebody clicked the wrong year is exactly the accident this
// screen exists to prevent.
//
// Body: { academic_year: '2026-2027' } or { start_year: 2026 }
router.post('/calendar/year/generate', authenticate, async (req, res) => {
  if (!requireCalendarEdit(req, res)) return;
  const body = req.body || {};
  let startYear = parseInt(body.start_year, 10);
  if (!Number.isFinite(startYear)) {
    const m = /^(\d{4})-(\d{4})$/.exec(String(body.academic_year || ''));
    if (!m) return res.status(400).json({ error: "academic_year must look like '2026-2027'" });
    if (Number(m[2]) !== Number(m[1]) + 1) {
      return res.status(400).json({ error: 'an academic year runs across two consecutive years' });
    }
    startYear = Number(m[1]);
  }
  if (startYear < 2000 || startYear > 2100) {
    return res.status(400).json({ error: 'start_year is out of range' });
  }

  const plan = CAL.generateAcademicYear(startYear);
  const source = `generated-provisional ${CAL.todayYmd()}`;

  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT count(*)::int AS n FROM school_terms WHERE academic_year = $1`, [plan.academic_year]);
    if (existing[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: `${plan.academic_year} already has ${existing[0].n} half-term(s). `
             + 'Edit those dates rather than generating over them.',
        code: 'year_exists',
      });
    }

    for (const t of plan.terms) {
      await client.query(
        `INSERT INTO school_terms (academic_year, term, half, name, start_date, end_date, source, created_by)
         VALUES ($1,$2,$3,$4,$5::date,$6::date,$7,$8)
         ON CONFLICT (academic_year, term, half) DO NOTHING`,
        [plan.academic_year, t.term, t.half, t.name, t.start_date, t.end_date, source, req.user.id || null]);
    }
    // A break is matched on its NAME within the year — school_breaks has no
    // unique key to conflict on, and inserting blind would double every break
    // the moment anyone retried a half-failed request.
    let breaksAdded = 0;
    for (const b of plan.breaks) {
      const { rows: dup } = await client.query(
        `SELECT 1 FROM school_breaks WHERE academic_year = $1 AND name = $2 LIMIT 1`,
        [plan.academic_year, b.name]);
      if (dup.length) continue;
      await client.query(
        `INSERT INTO school_breaks (academic_year, name, kind, start_date, end_date, source)
         VALUES ($1,$2,$3,$4::date,$5::date,$6)`,
        [plan.academic_year, b.name, b.kind, b.start_date, b.end_date, source]);
      breaksAdded++;
    }
    await client.query('COMMIT');

    res.json({
      ok: true,
      academic_year: plan.academic_year,
      terms_created: plan.terms.length,
      breaks_created: breaksAdded,
      provisional: true,
      source,
      note: 'These dates are a working approximation of the usual English school year, '
          + 'with Easter computed. Check them against what your local authority publishes '
          + 'and correct whatever moved — editing a date is what stops it being provisional.',
    });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already rolled back */ }
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ─── POST /calendar/year/source — "these are Ealing's real dates now" ───────
// b298. 2026/27 came from ealing.gov.uk; 2027/28 onwards were generated from
// the same rhythm with a computed Easter and are flagged provisional. When
// Ealing publishes a year, Toby corrects whichever dates moved and then says so
// here — one write to `source` across the year, which is the only thing that
// makes the screens stop calling it a guess. Dates are NOT touched.
router.post('/calendar/year/source', authenticate, async (req, res) => {
  if (!requireCalendarEdit(req, res)) return;
  const academicYear = String(req.body.academic_year || '');
  if (!/^\d{4}-\d{4}$/.test(academicYear)) {
    return res.status(400).json({ error: "academic_year must look like '2027-2028'" });
  }
  const source = String(req.body.source || '').trim()
    || ('ealing.gov.uk ' + academicYear.replace('-', '/') + ' (confirmed in Wren)');
  if (/provisional|generated/i.test(source)) {
    return res.status(400).json({ error: 'That source still reads as provisional — say where the dates came from.' });
  }
  try {
    const db = getPool();
    const a = await db.query(`UPDATE school_terms  SET source=$2, updated_at=now() WHERE academic_year=$1`, [academicYear, source]);
    const b = await db.query(`UPDATE school_breaks SET source=$2, updated_at=now() WHERE academic_year=$1`, [academicYear, source]);
    if (!a.rowCount && !b.rowCount) return res.status(404).json({ error: 'No calendar rows for ' + academicYear });
    res.json({ ok: true, academic_year: academicYear, source, terms: a.rowCount, breaks: b.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});



// b223 — the termly-plan internals the plan drafter signs off THROUGH. Exposed
// rather than duplicated so an accepted draft lands in ladn.term_plans by the
// same rules PUT /termly/plan uses (same key, same cap, same framework).
router._resolvePeriod          = resolvePeriod;
router._termKey                = termKey;
router._periodWeeks            = periodWeeks;
router._activeFramework        = activeFramework;
router._hydrateCards           = hydrateCards;
// ─── PUT /termly/day ─────────────────────────────────────────────────────────
// b245 — upsert ONE day of one week. This is what "tap a day and add a card"
// posts. Deliberately narrow: a practitioner standing in the baby room changes
// one day at a time, so the request is one day and the reply is that day.
//
// resource_card_ids are card SLUGS and activity_ids are curriculum_activities
// ids — the same conventions termly_plan_weeks already uses.
//
// Editing an imported day flips source to 'staff', which is what stops a
// re-import of the source PDFs from overwriting the room's own changes.
router.put('/termly/day', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const { plan_id, week_no, room_id, weekday, category, category_slug,
          title, role_of_adult, staff_note, resource_card_ids, activity_ids, notes } = req.body;
  const wk = parseInt(week_no, 10);
  const wd = parseInt(weekday, 10);
  if (!plan_id || !room_id) return res.status(400).json({ error: 'plan_id and room_id required' });
  if (!Number.isInteger(wk) || wk < 1 || wk > CAL.MAX_PLAN_WEEKS) {
    return res.status(400).json({ error: `week_no must be 1–${CAL.MAX_PLAN_WEEKS}` });
  }
  if (!Number.isInteger(wd) || wd < 1 || wd > 5) {
    return res.status(400).json({ error: 'weekday must be 1 (Monday) – 5 (Friday)' });
  }
  try {
    const db = getPool();
    const { rows: planRows } = await db.query(`SELECT id FROM term_plans WHERE id = $1`, [plan_id]);
    if (!planRows.length) return res.status(404).json({ error: 'Plan not found' });

    // Default the slot's category from the rhythm so a day created by tapping an
    // empty slot is still labelled correctly without the client having to say so.
    const slot = DAY_RHYTHM.find(d => d.weekday === wd) || {};
    const cat     = category      != null ? String(category)      : slot.category || null;
    const catSlug = category_slug != null ? String(category_slug) : slot.category_slug || null;

    // This is a PARTIAL update. "Tap Wednesday, add a book" posts cards and
    // nothing else, and that must not blank out the day's activity title or the
    // role of the adult. A field is written only when the caller actually sent
    // it; an absent key leaves what is already there alone. Sending an explicit
    // null still clears the field, so "remove the title" remains expressible.
    const has = k => Object.prototype.hasOwnProperty.call(req.body, k);
    const txt = v => (v == null ? null : String(v).trim());

    const { rows } = await db.query(
      `INSERT INTO termly_plan_days
         (plan_id, week_no, room_id, weekday, category, category_slug, title,
          role_of_adult, staff_note, resource_card_ids, activity_ids, notes,
          source, created_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,'staff',$13, now())
       ON CONFLICT (plan_id, week_no, room_id, weekday) DO UPDATE SET
         category          = CASE WHEN $14 THEN EXCLUDED.category          ELSE termly_plan_days.category END,
         category_slug     = CASE WHEN $14 THEN EXCLUDED.category_slug     ELSE termly_plan_days.category_slug END,
         title             = CASE WHEN $15 THEN EXCLUDED.title             ELSE termly_plan_days.title END,
         role_of_adult     = CASE WHEN $16 THEN EXCLUDED.role_of_adult     ELSE termly_plan_days.role_of_adult END,
         staff_note        = CASE WHEN $17 THEN EXCLUDED.staff_note        ELSE termly_plan_days.staff_note END,
         resource_card_ids = CASE WHEN $18 THEN EXCLUDED.resource_card_ids ELSE termly_plan_days.resource_card_ids END,
         activity_ids      = CASE WHEN $19 THEN EXCLUDED.activity_ids      ELSE termly_plan_days.activity_ids END,
         notes             = CASE WHEN $20 THEN EXCLUDED.notes             ELSE termly_plan_days.notes END,
         source            = 'staff',
         updated_at        = now()
       RETURNING *`,
      [plan_id, wk, room_id, wd, cat, catSlug, txt(title), txt(role_of_adult), txt(staff_note),
       JSON.stringify(asSlugArray(resource_card_ids)),
       JSON.stringify(asIntArray(activity_ids)),
       notes == null ? null : String(notes), req.user.id || null,
       has('category') || has('category_slug'), has('title'), has('role_of_adult'),
       has('staff_note'), has('resource_card_ids'), has('activity_ids'), has('notes')]);

    const row = rows[0];
    const actIds = asIntArray(row.activity_ids);
    let acts = [];
    if (actIds.length) {
      const { rows: a } = await db.query(
        `SELECT id, name, description, eyfs_areas, age_range, category
           FROM curriculum_activities WHERE id = ANY($1::int[])`, [actIds]);
      acts = actIds.map(id => a.find(x => x.id === id) || { id, name: `Activity #${id}`, missing: true });
    }
    res.json({
      ...row,
      weekday_name: WEEKDAY_NAMES[row.weekday] || null,
      resource_cards: hydrateCards(asSlugArray(row.resource_card_ids)),
      activities: acts,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── DELETE /termly/day/:id ──────────────────────────────────────────────────
// Clears a day back to empty. The row goes rather than being blanked, so the
// week reads as "nothing planned Thursday" instead of "an empty Thursday".
router.delete('/termly/day/:id', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  try {
    const db = getPool();
    const { rowCount } = await db.query(`DELETE FROM termly_plan_days WHERE id = $1`, [req.params.id]);
    res.json({ ok: true, deleted: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


// ═══════════════════════════════════════════════════════════════════════════
// b293 (2026-09-08) — the planning as a printable PDF
// ═══════════════════════════════════════════════════════════════════════════
// APPENDED. Nothing above this line is touched.
//
// Toby sends the planning out through EyLog, so it has to be able to leave Wren
// as a file. Two shapes, one route:
//
//   GET /termly/pdf?room_id=1&half_term_id=1          → one half-term
//   GET /termly/pdf?room_id=1&academic_year=2026-2027&scope=year
//                                                     → the whole year, with a
//                                                       cover and one section
//                                                       per half-term
//   …&inline=1                                        → same file, opened in the
//                                                       browser viewer rather
//                                                       than downloaded
//
// Layout and the draft watermark live in src/lib/plan-pdf.js; this file only
// gathers the data.
//
// WHY loadPlanBundle EXISTS RATHER THAN CALLING GET /termly/plan
// ---------------------------------------------------------------------------
// The queries it needs are inlined inside that route's own callback, and the
// absolute rule for this build is that an existing route is not rewritten. So
// the reads are repeated here in one small function instead of refactoring the
// handler out from under a page that works. If the two ever need to diverge,
// they can — but today they are deliberately the same reads.
//
// DRAFTS
// A half-term whose term_plans.status is not 'published' (b290) is watermarked
// on every page, flagged in its coloured band, and flagged in the running
// footer. The filename gains -DRAFT too, so a file that has been saved and
// forwarded still says so.

const planPdfLib = require('../lib/plan-pdf');

// The reads behind one half-term of plan: the plan row, its weeks, its days
// (b245 baby-room rhythm), and the calendar events it ticked.
async function loadPlanBundle(db, roomId, term) {
  const plan = await findTermPlan(db, roomId, term);   // b328 — was a name match; broke the PDF
  const planWeeks = await periodWeeks(db, term);
  if (!plan) return { term, plan: null, weeks: planWeeks, days: [], events: [] };

  const eventIds = asIntArray(plan.event_ids);
  const [weeksQ, daysQ, eventsQ] = await Promise.all([
    db.query(`SELECT * FROM termly_plan_weeks WHERE plan_id = $1 ORDER BY week_no, room_id`, [plan.id]),
    db.query(`SELECT * FROM termly_plan_days  WHERE plan_id = $1 ORDER BY week_no, room_id, weekday`, [plan.id]),
    eventIds.length
      ? db.query(`SELECT id, title, event_date, location FROM events
                   WHERE id = ANY($1::int[]) ORDER BY event_date`, [eventIds])
      : Promise.resolve({ rows: [] }),
  ]);

  const allActivityIds = [...new Set([
    ...weeksQ.rows.flatMap(w => asIntArray(w.activity_ids)),
    ...daysQ.rows.flatMap(d => asIntArray(d.activity_ids)),
  ])];
  const actById = new Map();
  if (allActivityIds.length) {
    const { rows: acts } = await db.query(
      `SELECT id, name, description, eyfs_areas, age_range, category
         FROM curriculum_activities WHERE id = ANY($1::int[])`, [allActivityIds]);
    acts.forEach(a => actById.set(a.id, a));
  }
  const hydrate = ids => asIntArray(ids).map(id => actById.get(id)).filter(Boolean);

  // The week rows the plan actually has, merged onto the calendar's week list so
  // a week_commencing is present even where no plan row was ever saved.
  const savedByNo = new Map(weeksQ.rows.map(w => [w.week_no, w]));
  const weeks = planWeeks.map(pw => {
    const w = savedByNo.get(pw.week_no);
    return {
      week_no: pw.week_no,
      week_commencing: pw.week_commencing,
      notes: w ? w.notes : null,
      role_of_adult: w ? (w.role_of_adult || null) : null,   // b332
      resource_cards: w ? hydrateCards(asSlugArray(w.resource_card_ids)) : [],
      activities: w ? hydrate(w.activity_ids) : [],
    };
  });
  // A saved week outside the calendar's range (a plan written before b217 moved
  // the periods) would otherwise vanish from the print. Keep it.
  for (const w of weeksQ.rows) {
    if (weeks.some(x => x.week_no === w.week_no)) continue;
    weeks.push({
      week_no: w.week_no, week_commencing: w.week_commencing, notes: w.notes,
      role_of_adult: w.role_of_adult || null,                // b332
      resource_cards: hydrateCards(asSlugArray(w.resource_card_ids)),
      activities: hydrate(w.activity_ids),
    });
  }
  weeks.sort((a, b) => a.week_no - b.week_no);

  const days = daysQ.rows.map(d => ({
    week_no: d.week_no, weekday: d.weekday,
    weekday_name: WEEKDAY_NAMES[d.weekday] || null,
    category: d.category, title: d.title,
    role_of_adult: d.role_of_adult, staff_note: d.staff_note,
    description: d.description, intention: d.intention,   // ps-autumn2-20261030
    resource_cards: hydrateCards(asSlugArray(d.resource_card_ids)),
    activities: hydrate(d.activity_ids),
  }));

  return { term, plan, weeks, days, events: eventsQ.rows };
}

async function settingFooter(db) {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings
        WHERE key IN ('setting_name','setting_address','setting_phone','setting_email')`);
    const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
    return { name: m.setting_name, address: m.setting_address, phone: m.setting_phone, email: m.setting_email };
  } catch { return {}; }
}

// ─── GET /termly/pdf ─────────────────────────────────────────────────────────
router.get('/termly/pdf', authenticate, async (req, res) => {
  // Staff only, and never from the parents host: this route prints DRAFTS, which
  // is exactly what b290's portal gate exists to keep away from parents.
  if (req._portal === 'parents') return res.status(403).json({ error: 'Not available here' });
  try {
    const db = getPool();
    const roomId = parseInt(req.query.room_id, 10);
    if (!roomId) return res.status(400).json({ error: 'room_id required' });

    const { rows: roomRows } = await db.query(`SELECT id, name FROM rooms WHERE id = $1`, [roomId]);
    if (!roomRows.length) return res.status(404).json({ error: 'Room not found' });
    const roomName = roomRows[0].name;

    const wantYear = String(req.query.scope || '') === 'year';
    let terms = [];
    let academicYear = String(req.query.academic_year || '').trim();

    if (wantYear) {
      /* The Roost planner's picker still holds FUNDING periods (b217 moved EY to
         teaching half-terms; that page was not converted), so the academic_year
         it can offer for a legacy plan is a bare '2026'. Derive the real one
         from whatever period is selected rather than refusing the button. */
      if (!/^\d{4}-\d{4}$/.test(academicYear)) {
        const sel = await resolvePeriod(db, req.query);
        const start = sel && planPdfLib.ymd(sel.start_date);
        if (start) academicYear = CAL.academicYearOf(start);
      }
      if (!/^\d{4}-\d{4}$/.test(academicYear)) {
        return res.status(400).json({
          error: 'Choose a half-term first, or pass academic_year (e.g. 2026-2027).' });
      }
      const hts = await CAL.loadHalfTerms(db, academicYear);
      if (!hts.length) return res.status(404).json({ error: `No half-terms in the calendar for ${academicYear}` });
      terms = hts.map(ht => ({
        kind: 'half_term', id: ht.id, name: ht.name, academic_year: ht.academic_year,
        term: ht.term, half: ht.half, year: parseInt(ht.academic_year.slice(0, 4), 10),
        start_date: ht.start_date, end_date: ht.end_date,
      }));
    } else {
      const term = await resolvePeriod(db, req.query);
      if (!term) return res.status(400).json({ error: 'half_term_id (or legacy term_id) required' });
      terms = [term];
      academicYear = termKey(term).academic_year;
    }

    const bundles = [];
    for (const t of terms) bundles.push(await loadPlanBundle(db, roomId, t));

    // "Draft" here means: at least one half-term in this pack is not published.
    // A pack is only clean when every half-term in it is.
    const anyDraft = bundles.some(b => !b.plan || b.plan.status !== 'published');
    const withPlans = bundles.filter(b => b.plan && String(b.plan.theme || '').trim());
    if (!withPlans.length) {
      return res.status(404).json({
        error: wantYear
          ? `Nothing has been planned for ${roomName} in ${academicYear} yet.`
          : `Nothing has been planned for ${roomName} in ${terms[0].name} yet.`,
      });
    }

    const doc = {
      roomName, academicYear, scope: wantYear ? 'year' : 'term',
      anyDraft, terms: bundles, setting: await settingFooter(db),
      // b332 — the year pack's cover carries the room's curriculum intent, and
      // only ever the PUBLISHED one: a draft paragraph must not leave the
      // building inside a file somebody forwards to a parent.
      intent: await publishedIntent(db, roomId, academicYear),
    };

    const buf = await planPdfLib.planPdf(doc);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', buf.length);
    // ?inline=1 opens it in the browser's viewer instead of downloading — handy
    // for checking a plan reads well before sending it anywhere.
    res.setHeader('Content-Disposition',
      `${String(req.query.inline || '') === '1' ? 'inline' : 'attachment'}; ` +
      `filename="${planPdfLib.pdfFilename(doc)}"`);
    res.end(buf);
  } catch (e) {
    console.error('[planning] termly/pdf:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// b332 (2026-09-15) — intent, sequence, the adult's role, and the join
// ═══════════════════════════════════════════════════════════════════════════
// APPENDED. Nothing above this line is rewritten; the three edits made up there
// are one added field each (weeks now carry role_of_adult) and one added
// `AND is_active` on the statement picker.
//
// From wren-docs/research/reports/2026-09-10-fledge-curriculum-or-checklist.md:
//
//   "Fledge sits in one place describing outcomes; the planning sits in another
//    describing teaching; and nothing joins them."
//
// Four things live here, and they are the four halves of that sentence:
//   1. INTENT + SEQUENCE   the year-level paragraphs the planning hangs off
//   2. ROLE OF THE ADULT   the pedagogy the pre-school plan never had a field for
//   3. INTENTION LINKS     this sentence is aiming at these Fledge statements
//   4. IMPACT              what the children actually did against those statements
//
// Everything is counts-only where children are involved: the impact endpoint
// returns numbers, never a child, a name, or a line of an observation.

const ACADEMIC_YEAR_RE = /^\d{4}-\d{4}$/;

/** The PUBLISHED intent for a room+year, or null. Used by the PDF and parents. */
async function publishedIntent(db, roomId, academicYear) {
  if (!roomId || !ACADEMIC_YEAR_RE.test(String(academicYear || ''))) return null;
  try {
    const { rows } = await db.query(
      `SELECT intent, sequence_rationale, published_at
         FROM curriculum_intent
        WHERE room_id = $1 AND academic_year = $2 AND status = 'published'`,
      [roomId, academicYear]);
    const r = rows[0];
    if (!r) return null;
    const intent = String(r.intent || '').trim();
    const seq = String(r.sequence_rationale || '').trim();
    if (!intent && !seq) return null;
    return { intent, sequence_rationale: seq, published_at: r.published_at };
  } catch (e) {
    // A database without the b332 migration must not take the PDF down with it.
    if (e.code === '42P01' || e.code === '42703') return null;
    throw e;
  }
}
router._publishedIntent = publishedIntent;

/** 42P01/42703 → "the migration has not been applied", not a 500. */
function b332SchemaMissing(e) { return e && (e.code === '42P01' || e.code === '42703'); }
function b332NotApplied(res) {
  return res.status(503).json({
    error: 'schema_not_applied',
    message: 'Apply migrations/2026-09-15-b332-fledge-recommendations.sql.',
  });
}

// ─── GET /termly/intent ──────────────────────────────────────────────────────
// The room's year: its intent, its sequence rationale, and the six half-terms
// with their themes — which is the "year view" the intent is written against.
// You cannot say why Autumn 1 comes before Autumn 2 on a screen that will not
// show you what is in either of them.
router.get('/termly/intent', authenticate, async (req, res) => {
  const db = getPool();
  const roomId = parseInt(req.query.room_id, 10);
  const year = String(req.query.academic_year || '').trim();
  if (!roomId) return res.status(400).json({ error: 'room_id required' });
  if (!ACADEMIC_YEAR_RE.test(year)) {
    return res.status(400).json({ error: 'academic_year required, e.g. 2026-2027' });
  }
  try {
    const [{ rows: intentRows }, { rows: planRows }, { rows: roomRows }] = await Promise.all([
      db.query(
        `SELECT ci.*, ps.first_name AS published_by_first, ps.last_name AS published_by_last,
                us.first_name AS updated_by_first, us.last_name AS updated_by_last
           FROM curriculum_intent ci
           LEFT JOIN staff ps ON ps.id = ci.published_by
           LEFT JOIN staff us ON us.id = ci.updated_by
          WHERE ci.room_id = $1 AND ci.academic_year = $2`, [roomId, year]),
      db.query(
        `SELECT id, term_name, theme, status, plan_source,
                coalesce(array_length(learning_intentions, 1), 0) AS intention_count
           FROM term_plans WHERE room_id = $1 AND academic_year = $2`, [roomId, year]),
      db.query(`SELECT id, name FROM rooms WHERE id = $1`, [roomId]),
    ]);

    // The half-terms in calendar order, each carrying whatever plan exists for
    // it. A half-term with no row at all still appears — the gap is the point.
    const halfTerms = await CAL.loadHalfTerms(db, year);
    const planByName = new Map(planRows.map(p => [p.term_name, p]));
    const terms = (halfTerms.length ? halfTerms.map(ht => ({ name: ht.name, start_date: ht.start_date, end_date: ht.end_date }))
                                    : TERMS.map(n => ({ name: n, start_date: null, end_date: null })))
      .map(t => {
        const p = planByName.get(t.name) || null;
        return {
          ...t,
          plan_id: p ? p.id : null,
          theme: p ? p.theme : null,
          status: p ? p.status : null,
          intention_count: p ? Number(p.intention_count) : 0,
          not_planned: !p || /^not-planned/i.test(String(p.plan_source || '')) || !String(p && p.theme || '').trim(),
        };
      });

    const row = intentRows[0] || null;
    res.json({
      room: roomRows[0] || { id: roomId, name: null },
      academic_year: year,
      intent: row ? {
        id: row.id,
        intent: row.intent || '',
        sequence_rationale: row.sequence_rationale || '',
        status: row.status,
        published_at: row.published_at,
        published_by: [row.published_by_first, row.published_by_last].filter(Boolean).join(' ') || null,
        updated_at: row.updated_at,
        updated_by: [row.updated_by_first, row.updated_by_last].filter(Boolean).join(' ') || null,
      } : null,
      terms,
      can_edit: hasRole(req.user, PLAN_EDIT_ROLES),
    });
  } catch (e) {
    if (b332SchemaMissing(e)) return b332NotApplied(res);
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /termly/intent ──────────────────────────────────────────────────────
// Upsert the two paragraphs. Saving NEVER publishes: a save on a published
// intent moves it back to draft, because the paragraph parents are reading
// should not change under them without somebody deciding that it should.
router.put('/termly/intent', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const db = getPool();
  const roomId = parseInt(req.body && req.body.room_id, 10);
  const year = String((req.body && req.body.academic_year) || '').trim();
  if (!roomId) return res.status(400).json({ error: 'room_id required' });
  if (!ACADEMIC_YEAR_RE.test(year)) {
    return res.status(400).json({ error: 'academic_year required, e.g. 2026-2027' });
  }
  const intent = String((req.body && req.body.intent) || '').trim().slice(0, 8000);
  const sequence = String((req.body && req.body.sequence_rationale) || '').trim().slice(0, 8000);
  try {
    const { rows } = await db.query(
      `INSERT INTO curriculum_intent
         (room_id, academic_year, intent, sequence_rationale, status, created_by, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, 'draft', $5, $5, now())
       ON CONFLICT (room_id, academic_year) DO UPDATE
         SET intent             = EXCLUDED.intent,
             sequence_rationale = EXCLUDED.sequence_rationale,
             status             = 'draft',
             published_at       = NULL,
             published_by       = NULL,
             updated_by         = EXCLUDED.updated_by,
             updated_at         = now()
       RETURNING id, status, updated_at`,
      [roomId, year, intent || null, sequence || null, req.user.id || null]);
    res.json({ ok: true, intent: rows[0],
      note: 'Saved as a draft. Parents see it only once it is published.' });
  } catch (e) {
    if (b332SchemaMissing(e)) return b332NotApplied(res);
    res.status(500).json({ error: e.message });
  }
});

// ─── POST /termly/intent/publish ─────────────────────────────────────────────
// { room_id, academic_year, publish: true | false }. Same shape and the same
// meaning as b290's plan publish: published is the state in which parents can
// read it and the year pack prints it.
router.post('/termly/intent/publish', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const db = getPool();
  const roomId = parseInt(req.body && req.body.room_id, 10);
  const year = String((req.body && req.body.academic_year) || '').trim();
  const publish = req.body ? req.body.publish !== false : true;
  if (!roomId || !ACADEMIC_YEAR_RE.test(year)) {
    return res.status(400).json({ error: 'room_id and academic_year required' });
  }
  try {
    const { rows: cur } = await db.query(
      `SELECT intent, sequence_rationale FROM curriculum_intent
        WHERE room_id = $1 AND academic_year = $2`, [roomId, year]);
    if (!cur.length) return res.status(404).json({ error: 'Write the intent first.' });
    if (publish && !String(cur[0].intent || '').trim()) {
      return res.status(400).json({ error: 'There is nothing to publish — the intent is empty.' });
    }
    const { rows } = await db.query(
      `UPDATE curriculum_intent
          SET status = $3,
              published_at = CASE WHEN $3 = 'published' THEN now() ELSE NULL END,
              -- $4::int explicitly: inside a CASE, pg infers the parameter from
              -- the other branch (NULL) and lands on text, which the column
              -- refuses. It fails at publish time, not at deploy time.
              published_by = CASE WHEN $3 = 'published' THEN $4::int ELSE NULL END,
              updated_at = now()
        WHERE room_id = $1 AND academic_year = $2
        RETURNING id, status, published_at`,
      [roomId, year, publish ? 'published' : 'draft', req.user.id || null]);
    res.json({ ok: true, intent: rows[0] });
  } catch (e) {
    if (b332SchemaMissing(e)) return b332NotApplied(res);
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /termly/week/role-of-adult ──────────────────────────────────────────
// Its own route rather than a field on PUT /termly/week, for two reasons:
//   · that route is an upsert of the whole week row, and the card picker posts
//     it without a role_of_adult — so folding this in would have every card
//     edit quietly blank the pedagogy;
//   · the plans are written a fortnight at a time (b329), so this writes the
//     PAIR by default and the PDF can print it once per fortnight.
// { plan_id, week_no, room_id, role_of_adult, pair? = true }
router.put('/termly/week/role-of-adult', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const db = getPool();
  const planId = parseInt(req.body && req.body.plan_id, 10);
  const roomId = parseInt(req.body && req.body.room_id, 10);
  const weekNo = parseInt(req.body && req.body.week_no, 10);
  const pair = req.body ? req.body.pair !== false : true;
  const text = req.body && req.body.role_of_adult != null
    ? String(req.body.role_of_adult).trim().slice(0, 4000) : '';
  if (!planId || !roomId) return res.status(400).json({ error: 'plan_id and room_id required' });
  if (!Number.isInteger(weekNo) || weekNo < 1 || weekNo > CAL.MAX_PLAN_WEEKS) {
    return res.status(400).json({ error: `week_no must be 1–${CAL.MAX_PLAN_WEEKS}` });
  }
  try {
    const { rows: planRows } = await db.query(
      `SELECT id, room_id FROM term_plans WHERE id = $1`, [planId]);
    if (!planRows.length) return res.status(404).json({ error: 'Plan not found' });

    // The fortnight this week belongs to: weeks 1+2, 3+4, 5+6 …
    const block = Math.ceil(weekNo / 2);
    const weeks = pair ? [block * 2 - 1, block * 2].filter(n => n <= CAL.MAX_PLAN_WEEKS) : [weekNo];

    const saved = [];
    for (const wk of weeks) {
      // UPDATE-then-INSERT rather than a blind upsert: a week row that does not
      // exist yet has no week_commencing to invent, and inventing one would put
      // a wrong date on the printed plan.
      const { rows } = await db.query(
        `UPDATE termly_plan_weeks SET role_of_adult = $4, updated_at = now()
          WHERE plan_id = $1 AND week_no = $2 AND room_id = $3
          RETURNING id, week_no, role_of_adult`,
        [planId, wk, roomId, text || null]);
      if (rows.length) { saved.push(rows[0]); continue; }
      if (!text) continue;                       // nothing to say, nothing to create
      const { rows: ins } = await db.query(
        `INSERT INTO termly_plan_weeks (plan_id, week_no, room_id, role_of_adult, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (plan_id, week_no, room_id) DO UPDATE
           SET role_of_adult = EXCLUDED.role_of_adult, updated_at = now()
         RETURNING id, week_no, role_of_adult`,
        [planId, wk, roomId, text, req.user.id || null]);
      saved.push(ins[0]);
    }
    res.json({ ok: true, weeks: saved });
  } catch (e) {
    if (b332SchemaMissing(e)) return b332NotApplied(res);
    res.status(500).json({ error: e.message });
  }
});

// ── the join ────────────────────────────────────────────────────────────────
/**
 * Every link this plan has, as intention text → statement rows.
 *
 * TWO SOURCES, deliberately:
 *   · term_plan_intention_links — b332. An intention in the room's own words,
 *     tagged with the statements it is aiming at.
 *   · term_plans.intentions      — b181. A statement a manager TICKED, which the
 *     picker copied into learning_intentions as a sentence. That sentence IS
 *     the statement, so it is already linked and must count as linked.
 * Ignoring the second would tell a manager who ticked ten statements that
 * nothing is linked.
 */
async function intentionLinkMap(db, plan) {
  const out = new Map();                       // intention text → [statement]
  const add = (text, st) => {
    const key = String(text || '').trim();
    if (!key || !st || !st.id) return;
    const list = out.get(key) || [];
    if (!list.some(x => x.id === st.id)) list.push(st);
    out.set(key, list);
  };

  const grouped = TPV.groupedIntentions(plan);
  const tickedIds = [];
  for (const list of Object.values(grouped)) {
    for (const it of list) if (it.statement_id) tickedIds.push(it.statement_id);
  }

  const { rows: links } = await db.query(
    `SELECT intention_text, statement_id FROM term_plan_intention_links WHERE plan_id = $1`,
    [plan.id]);

  const ids = [...new Set([...tickedIds, ...links.map(l => l.statement_id)])];
  if (!ids.length) return out;
  const { rows: sts } = await db.query(
    `SELECT id, framework, area, sub_area, age_range, statement_code, statement_text, is_active
       FROM framework_statements WHERE id = ANY($1::int[])`, [ids]);
  const byId = new Map(sts.map(s => [s.id, s]));

  for (const list of Object.values(grouped)) {
    for (const it of list) if (it.statement_id) add(it.text, byId.get(it.statement_id));
  }
  for (const l of links) add(l.intention_text, byId.get(l.statement_id));
  return out;
}

// ─── GET /termly/intention-links?plan_id= ────────────────────────────────────
router.get('/termly/intention-links', authenticate, async (req, res) => {
  const db = getPool();
  const planId = parseInt(req.query.plan_id, 10);
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  try {
    const { rows } = await db.query(`SELECT * FROM term_plans WHERE id = $1`, [planId]);
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    const plan = rows[0];
    const map = await intentionLinkMap(db, plan);
    const intentions = TPV.intentionList(plan);
    res.json({
      plan_id: planId,
      intentions: intentions.map(text => ({
        text,
        statements: (map.get(text) || []).map(s => ({
          id: s.id, code: s.statement_code, text: s.statement_text,
          area: s.area, sub_area: s.sub_area, age_range: s.age_range,
          retired: s.is_active === false,
        })),
      })),
      // A link whose sentence has since been edited. Shown rather than hidden,
      // because a silently vanishing link is how people stop trusting the join.
      orphaned: [...map.keys()].filter(k => !intentions.includes(k)).length,
    });
  } catch (e) {
    if (b332SchemaMissing(e)) return b332NotApplied(res);
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /termly/intention-links ─────────────────────────────────────────────
// { plan_id, intention_text, statement_ids: [] } — the whole set for ONE
// intention, replaced. Sending [] clears that intention's links and nothing
// else: this only ever touches rows for the intention named in the body.
router.put('/termly/intention-links', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const db = getPool();
  const planId = parseInt(req.body && req.body.plan_id, 10);
  const text = String((req.body && req.body.intention_text) || '').trim();
  const ids = Array.isArray(req.body && req.body.statement_ids)
    ? [...new Set(req.body.statement_ids.map(Number).filter(Number.isFinite))].slice(0, 20)
    : [];
  if (!planId || !text) return res.status(400).json({ error: 'plan_id and intention_text required' });
  try {
    const { rows: planRows } = await db.query(`SELECT id FROM term_plans WHERE id = $1`, [planId]);
    if (!planRows.length) return res.status(404).json({ error: 'Plan not found' });

    if (ids.length) {
      // Only statements that exist and are still offered. A retired statement
      // cannot be newly linked; one linked before it was retired is left alone.
      const { rows: ok } = await db.query(
        `SELECT id FROM framework_statements WHERE id = ANY($1::int[]) AND is_active`, [ids]);
      const valid = ok.map(r => r.id);
      if (!valid.length) return res.status(400).json({ error: 'no such statements' });
      await db.query(
        `DELETE FROM term_plan_intention_links
          WHERE plan_id = $1 AND intention_text = $2 AND NOT (statement_id = ANY($3::int[]))`,
        [planId, text, valid]);
      await db.query(
        `INSERT INTO term_plan_intention_links (plan_id, intention_text, statement_id, created_by)
         SELECT $1, $2, s, $4 FROM unnest($3::int[]) AS s
         ON CONFLICT (plan_id, intention_text, statement_id) DO NOTHING`,
        [planId, text, valid, req.user.id || null]);
    } else {
      await db.query(
        `DELETE FROM term_plan_intention_links WHERE plan_id = $1 AND intention_text = $2`,
        [planId, text]);
    }
    const { rows } = await db.query(
      `SELECT l.statement_id, fs.statement_code, fs.statement_text, fs.area, fs.sub_area, fs.age_range
         FROM term_plan_intention_links l
         JOIN framework_statements fs ON fs.id = l.statement_id
        WHERE l.plan_id = $1 AND l.intention_text = $2
        ORDER BY fs.ordinal NULLS LAST, fs.id`, [planId, text]);
    res.json({ ok: true, intention_text: text, statements: rows });
  } catch (e) {
    if (b332SchemaMissing(e)) return b332NotApplied(res);
    res.status(500).json({ error: e.message });
  }
});

// ─── GET /termly/impact?plan_id= ─────────────────────────────────────────────
// "What is the impact of your curriculum" — the question the September 2026
// inspection toolkit is built around — answered from the two things Wren
// already holds: what we said we were teaching, and what we wrote down about
// the children while we taught it.
//
// COUNTS ONLY. No child, no name, no observation text, no author. The numbers
// are per INTENTION, which is the grain the plan is written in.
//
// The window is the half-term so far: its start date to today, or to its end
// date once it is over. "Evidence so far" is a live number, not a final one.
//
// A room is the child's CURRENT room (children.room_id). A child who moved
// rooms mid-term therefore counts in the room they are in now — recorded here
// because it is a real limitation, not because it is the ideal.
router.get('/termly/impact', authenticate, async (req, res) => {
  const db = getPool();
  const planId = parseInt(req.query.plan_id, 10);
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  try {
    const { rows: planRows } = await db.query(`SELECT * FROM term_plans WHERE id = $1`, [planId]);
    if (!planRows.length) return res.status(404).json({ error: 'Plan not found' });
    const plan = planRows[0];

    // The half-term's dates. school_term_id is the real link; fall back to the
    // name for plans written before b217.
    let term = null;
    if (plan.school_term_id) term = await CAL.loadHalfTermById(db, plan.school_term_id);
    if (!term) {
      const hts = await CAL.loadHalfTerms(db, plan.academic_year);
      term = hts.find(t => t.name === plan.term_name) || null;
    }
    const today = CAL.todayYmd();
    const from = term ? planPdfLib.ymd(term.start_date) : null;
    const to = term ? (planPdfLib.ymd(term.end_date) < today ? planPdfLib.ymd(term.end_date) : today) : today;

    const map = await intentionLinkMap(db, plan);
    const intentions = TPV.intentionList(plan);

    // One statement-set query, reused per intention. Counts only.
    async function evidence(ids) {
      if (!ids.length || !from) return { observations: 0, children: 0 };
      const { rows } = await db.query(
        `SELECT count(DISTINCT o.id)::int AS observations,
                count(DISTINCT o.child_id)::int AS children
           FROM observations o
           JOIN children c ON c.id = o.child_id
          WHERE c.room_id = $1
            AND o.created_at >= $2::date
            AND o.created_at < ($3::date + 1)
            AND (o.linked_framework_ids && $4::int[]
                 OR EXISTS (SELECT 1 FROM observation_statements os
                             WHERE os.observation_id = o.id AND os.statement_id = ANY($4::int[])))`,
        [plan.room_id, from, to, ids]);
      return rows[0] || { observations: 0, children: 0 };
    }

    const rows = [];
    for (const text of intentions) {
      const sts = map.get(text) || [];
      const ids = sts.map(s => s.id);
      const ev = await evidence(ids);
      rows.push({
        intention: text,
        statements: sts.map(s => ({ id: s.id, code: s.statement_code, area: s.area })),
        linked: ids.length,
        observations: ev.observations,
        children: ev.children,
      });
    }

    // The half-term in the round: how much was written in this room at all, and
    // how much of it is tagged against ANY statement of the active framework.
    // The gap between those two is the honest measure of whether the join is
    // being used — and today, on production, it is nearly the whole of it.
    let total = { observations: 0, tagged: 0 };
    if (from) {
      const framework = await activeFramework(db);
      const { rows: t } = await db.query(
        `SELECT count(DISTINCT o.id)::int AS observations,
                count(DISTINCT o.id) FILTER (
                  WHERE o.linked_framework_ids && (SELECT coalesce(array_agg(id), '{}') FROM framework_statements WHERE framework = $4 AND is_active)
                     OR EXISTS (SELECT 1 FROM observation_statements os
                                 JOIN framework_statements fs ON fs.id = os.statement_id
                                WHERE os.observation_id = o.id AND fs.framework = $4)
                )::int AS tagged
           FROM observations o
           JOIN children c ON c.id = o.child_id
          WHERE c.room_id = $1 AND o.created_at >= $2::date AND o.created_at < ($3::date + 1)`,
        [plan.room_id, from, to, framework]);
      total = t[0] || total;
      total.framework = framework;
    }

    res.json({
      plan_id: planId,
      room_id: plan.room_id,
      term_name: plan.term_name,
      academic_year: plan.academic_year,
      window: { from, to },
      intentions: rows,
      linked_intentions: rows.filter(r => r.linked > 0).length,
      total_intentions: rows.length,
      totals: total,
      note: 'Counts only. Room is the child’s current room; the window is this half-term so far.',
    });
  } catch (e) {
    if (b332SchemaMissing(e)) return b332NotApplied(res);
    res.status(500).json({ error: e.message });
  }
});

router._loadPlanBundle = loadPlanBundle;
router._findTermPlan  = findTermPlan;   // b328 — plan-drafts uses the same lookup   // used by scripts/b293-plan-pdf-verify.js

router._MAX_INTENTIONS_PER_AREA = MAX_INTENTIONS_PER_AREA;
router._DAY_RHYTHM              = DAY_RHYTHM;

// ═══════════════════════════════════════════════════════════════════════════
// b368 (2026-10-01) — FOCUS BLOCKS: a fortnightly carpet input + a full
// continuous-provision grid, per room.
// ═══════════════════════════════════════════════════════════════════════════
// APPENDED. Nothing above this line is touched.
//
// Toby: "slow it down and do weekly rather than daily... maybe even biweekly
// so it gets ingrained into kids who just do 1 or 2 days." A focus block is N
// consecutive weeks (settings.planning_block_weeks, default 2) of ONE term
// plan — EXTENDS term_plans/termly_plan_weeks (ladn.plan_blocks, migrations/
// 2026-10-01-b368-focus-blocks.sql). The old termly_plan_days/weeks rows are
// read-only from here and are never written by this section.
//
// PERMISSIONS deliberately differ from PLAN_EDIT_ROLES above (which also lets
// a practitioner edit the old day-by-day plan). Toby's brief asks for the
// key-children.js rule instead: a room_leader may create/edit/publish/
// evaluate the blocks for THEIR OWN room; manager/deputy_manager/admin/
// headteacher may do so for every room; everyone else — practitioner
// included — may only view. See src/routes/key-children.js for the pattern
// this copies (editableRooms/canEditRoom).
//
// No child data anywhere in this feature — it plans provision, not a child's
// programme — so "Draft this block" can send its whole context to the local
// model with nothing to redact.

const PD = require('../lib/plan-draft'); // b223's drafting engine — probe/callModel/parseModelJson reused, not re-implemented

const BLOCK_ALL_ROOMS_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher'];

function blockPortalGate(req, res) {
  if (req._portal === 'parents') { res.status(403).json({ error: 'Not available here' }); return false; }
  return true;
}

async function blockMyStaff(db, userId) {
  const { rows } = await db.query(`SELECT id, role, room_id FROM staff WHERE id = $1`, [userId]);
  return rows[0] || null;
}
function blockEditableRooms(user, me) {
  const role = (user && user.role) || (me && me.role);
  if (BLOCK_ALL_ROOMS_ROLES.includes(role)) return 'all';
  if (role === 'room_leader' && me && me.room_id) return [Number(me.room_id)];
  return [];
}
const canEditBlockRoom = (editable, roomId) =>
  editable === 'all' || (roomId != null && editable.includes(Number(roomId)));

// ── Default areas, per room band. Toby's list from the HTPS review — editable
// per room via PUT /focus-block-settings, which is why these are only a seed. ─
const DEFAULT_PRESCHOOL_AREAS = [
  'Mark-making & writing', 'Maths', 'Books & listening', 'Creative / art',
  'Construction', 'Small world', 'Role play / home corner',
  'Sand, water & playdough (sensory & messy)', 'Investigation / Understanding the World',
  'Music & movement', 'Fine motor / manipulative', 'Outdoors / physical',
];
const DEFAULT_BABY_AREAS = [
  'Treasure basket / heuristic play', 'Sensory / messy', 'Books & songs',
  'Physical (tummy time, cruising, climbing)', 'Mark-making (big & messy)',
  'Small world / cause & effect', 'Music & sound', 'Outdoors',
];
const roomBand = (room) => (/baby/i.test((room && room.name) || '') ? 'baby' : 'preschool');
const minAreasForPublish = (band) => (band === 'baby' ? 6 : 8);

async function blockSetting(db, key) {
  const { rows } = await db.query(`SELECT value FROM settings WHERE key = $1`, [key]);
  if (!rows.length) return {};
  try { const v = JSON.parse(rows[0].value); return (v && typeof v === 'object') ? v : {}; }
  catch { return {}; }
}
async function weeksForRoom(db, roomId) {
  const s = await blockSetting(db, 'planning_block_weeks');
  const v = parseInt(s[String(roomId)], 10);
  return (v === 1 || v === 2) ? v : 2;
}
async function areasForRoom(db, room) {
  const s = await blockSetting(db, 'planning_block_areas');
  const custom = s[String(room.id)];
  if (Array.isArray(custom) && custom.filter(Boolean).length) return asTextArray(custom);
  return roomBand(room) === 'baby' ? DEFAULT_BABY_AREAS.slice() : DEFAULT_PRESCHOOL_AREAS.slice();
}

// b371 (2026-10-01) — the switch-over setting ("the EY Planning entry opens
// the half-term view; the old day-by-day view stays reachable"). Same
// per-room-keyed-JSON convention as the two settings above. Default OFF: a
// room with no key (or an un-parseable one) is treated as not yet switched
// over — this is what keeps prod on the old view until Toby turns a room on.
async function blocksEnabledForRoom(db, roomId) {
  const s = await blockSetting(db, 'planning_blocks_enabled');
  return s[String(roomId)] === true;
}

// The half-term a plan belongs to, as a periodWeeks()-ready object. Plans made
// before b217 have no school_term_id — those rooms have no real week dates to
// block against, so a block made on one simply carries no week_commencing.
async function weeksForPlan(db, plan) {
  if (!plan.school_term_id) return [];
  const { rows } = await db.query(
    `SELECT id, name, to_char(start_date,'YYYY-MM-DD') AS start_date,
            to_char(end_date,'YYYY-MM-DD') AS end_date
       FROM school_terms WHERE id = $1`, [plan.school_term_id]);
  if (!rows.length) return [];
  return periodWeeks(db, Object.assign({ kind: 'half_term', academic_year: plan.academic_year }, rows[0]));
}

// The plan a room is in RIGHT NOW, by the school calendar — same lookup b328
// standardised for the half-term that owns today.
async function currentPlanForRoom(db, roomId) {
  const cal = await CAL.loadCalendar(db, null);
  const today = CAL.todayYmd();
  const day = CAL.resolveDay(today, cal.terms, cal.breaks);
  const term = day.half_term || day.previous_half_term || day.next_half_term || null;
  if (!term) return null;
  return findTermPlan(db, roomId, Object.assign({ kind: 'half_term' }, term));
}

// Counts only, never names — the interests/next-steps hint on the block header.
// Framework area per settings.default_framework, for current children in the room.
async function areaNextStepCounts(db, roomId) {
  const framework = await activeFramework(db);
  const { rows } = await db.query(`
    SELECT fs.area AS area, count(*)::int AS n
      FROM next_steps ns
      JOIN children c ON c.id = ns.child_id
      LEFT JOIN framework_statements fs ON fs.id = ns.framework_statement_id AND fs.framework = $2
     WHERE ns.status = 'pending' AND c.room_id = $1
       AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)
     GROUP BY fs.area
     ORDER BY n DESC`, [roomId, framework]);
  return rows.map(r => ({ area: r.area || 'Unassigned', count: r.n }));
}

// pg returns a DATE column as a local-midnight JS Date, not a string — format
// it explicitly rather than let JSON.stringify emit a UTC timestamp that reads
// a day early/late in the browser (memory/reference_pg_date_ymd_trap.md).
function blockYmd(d) {
  if (d == null) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shapeBlock(row) {
  return {
    id: row.id, plan_id: row.plan_id, room_id: row.room_id, block_no: row.block_no,
    week_from: row.week_from, week_to: row.week_to, week_commencing: blockYmd(row.week_commencing),
    status: row.status,
    focus_statements: asIntArray(row.focus_statements),
    core_text: row.core_text || null,
    supporting_texts: asTextArray(row.supporting_texts),
    key_vocabulary: asTextArray(row.key_vocabulary),
    song_rhyme: row.song_rhyme || null,
    number_focus: row.number_focus || null,
    sound_focus: row.sound_focus || null,
    interests_next_steps: row.interests_next_steps || null,
    input: row.input || {},
    provision_grid: Array.isArray(row.provision_grid) ? row.provision_grid : [],
    evaluation: row.evaluation || null,
    evaluated_at: row.evaluated_at, evaluated_by: row.evaluated_by,
    created_by: row.created_by, created_at: row.created_at, updated_at: row.updated_at,
    published_at: row.published_at, published_by: row.published_by,
  };
}

async function loadBlockRow(db, id) {
  const { rows } = await db.query(`SELECT * FROM plan_blocks WHERE id = $1`, [id]);
  return rows[0] || null;
}

// ─── GET /focus-block-settings?room_id= ─────────────────────────────────────
router.get('/focus-block-settings', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const { rows: rooms } = await db.query(`SELECT id, name FROM rooms ORDER BY id`);
    const weeksS = await blockSetting(db, 'planning_block_weeks');
    const areasS = await blockSetting(db, 'planning_block_areas');
    const out = await Promise.all(rooms.map(async r => ({
      room_id: r.id, room_name: r.name, band: roomBand(r),
      weeks: await weeksForRoom(db, r.id),
      areas: await areasForRoom(db, r),
      areas_is_custom: Array.isArray(areasS[String(r.id)]) && areasS[String(r.id)].length > 0,
      blocks_enabled: await blocksEnabledForRoom(db, r.id),
    })));
    res.json({
      rooms: out,
      defaults: { baby: DEFAULT_BABY_AREAS, preschool: DEFAULT_PRESCHOOL_AREAS },
      can_edit_settings: hasRole(req.user, BLOCK_ALL_ROOMS_ROLES),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PUT /focus-block-settings — manager-tier only (structural, not per-room) ─
router.put('/focus-block-settings', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  if (!hasRole(req.user, BLOCK_ALL_ROOMS_ROLES)) {
    return res.status(403).json({ error: 'Only a manager can change block settings' });
  }
  const roomId = parseInt(req.body.room_id, 10);
  if (!Number.isInteger(roomId)) return res.status(400).json({ error: 'room_id required' });
  try {
    const db = getPool();
    if (req.body.weeks !== undefined) {
      const weeks = parseInt(req.body.weeks, 10);
      if (weeks !== 1 && weeks !== 2) return res.status(400).json({ error: 'weeks must be 1 or 2' });
      const s = await blockSetting(db, 'planning_block_weeks');
      s[String(roomId)] = weeks;
      await db.query(
        `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('planning_block_weeks', $1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify(s), req.user.id]);
    }
    if (req.body.areas !== undefined) {
      const areas = asTextArray(req.body.areas);
      const s = await blockSetting(db, 'planning_block_areas');
      if (areas.length) s[String(roomId)] = areas; else delete s[String(roomId)];
      await db.query(
        `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('planning_block_areas', $1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify(s), req.user.id]);
    }
    // b371 — the half-term/fortnight view switch-over, per room.
    if (req.body.blocks_enabled !== undefined) {
      const s = await blockSetting(db, 'planning_blocks_enabled');
      if (req.body.blocks_enabled) s[String(roomId)] = true; else delete s[String(roomId)];
      await db.query(
        `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('planning_blocks_enabled', $1, $2, now())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [JSON.stringify(s), req.user.id]);
    }
    const { rows: roomRows } = await db.query(`SELECT id, name FROM rooms WHERE id = $1`, [roomId]);
    const room = roomRows[0];
    res.json({ room_id: roomId, weeks: await weeksForRoom(db, roomId), areas: room ? await areasForRoom(db, room) : [],
      blocks_enabled: await blocksEnabledForRoom(db, roomId) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /focus-blocks?room_id=&plan_id= ────────────────────────────────────
// Lists the blocks for a plan (explicit plan_id) or for a room's CURRENT plan.
router.get('/focus-blocks', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const roomId = parseInt(req.query.room_id, 10);
    const planId = parseInt(req.query.plan_id, 10);
    if (!Number.isInteger(roomId) && !Number.isInteger(planId)) {
      return res.status(400).json({ error: 'room_id or plan_id required' });
    }
    let plan;
    if (Number.isInteger(planId)) {
      const { rows } = await db.query(`SELECT * FROM term_plans WHERE id = $1`, [planId]);
      plan = rows[0];
    } else {
      plan = await currentPlanForRoom(db, roomId);
    }
    const { rows: roomRows } = await db.query(`SELECT id, name FROM rooms WHERE id = $1`, [plan ? plan.room_id : roomId]);
    const room = roomRows[0] || null;
    if (!plan || !room) {
      return res.json({
        room, plan: null, weeks: [], blocks: [], block_weeks: room ? await weeksForRoom(db, room.id) : 2,
        can_edit: false,
        note: 'No term plan found for this room/period yet — create one on the Termly Planning page first.',
      });
    }
    const me = await blockMyStaff(db, req.user.id);
    const editable = blockEditableRooms(req.user, me);
    const [{ rows: blockRows }, weeks] = await Promise.all([
      db.query(`SELECT * FROM plan_blocks WHERE plan_id = $1 ORDER BY block_no`, [plan.id]),
      weeksForPlan(db, plan),
    ]);
    res.json({
      room,
      plan: { id: plan.id, term_name: plan.term_name, academic_year: plan.academic_year, theme: plan.theme,
               key_books: plan.key_books || [], songs: plan.songs || [], status: plan.status },
      weeks,
      block_weeks: await weeksForRoom(db, room.id),
      blocks: blockRows.map(shapeBlock),
      can_edit: canEditBlockRoom(editable, room.id),
      old_day_view: `/ey/termly-plan?room_id=${room.id}`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /focus-blocks/:id — full detail, hydrated ──────────────────────────
router.get('/focus-blocks/:id', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const [{ rows: roomRows }, { rows: planRows }, me] = await Promise.all([
      db.query(`SELECT id, name FROM rooms WHERE id = $1`, [row.room_id]),
      db.query(`SELECT id, term_name, academic_year, theme, key_books, songs FROM term_plans WHERE id = $1`, [row.plan_id]),
      blockMyStaff(db, req.user.id),
    ]);
    const room = roomRows[0] || null;
    const editable = blockEditableRooms(req.user, me);

    const statementIds = asIntArray(row.focus_statements);
    const { rows: statements } = statementIds.length
      ? await db.query(`SELECT id, area, aspect, statement_code, statement_text FROM framework_statements WHERE id = ANY($1::int[])`, [statementIds])
      : { rows: [] };

    const grid = (Array.isArray(row.provision_grid) ? row.provision_grid : []).map(g => g || {});
    const activityIds = asIntArray(grid.map(g => g.activity_id).filter(v => v != null));
    const cardSlugs = asSlugArray(grid.map(g => g.resource_card_slug).filter(Boolean));
    const { rows: activityRows } = activityIds.length
      ? await db.query(`SELECT id, name, category FROM curriculum_activities WHERE id = ANY($1::int[])`, [activityIds])
      : { rows: [] };
    const actById = new Map(activityRows.map(a => [a.id, a]));
    const cardsBySlug = new Map(hydrateCards(cardSlugs).map(c => [c.slug, c]));
    const hydratedGrid = grid.map(g => Object.assign({}, g, {
      activity: (g.activity_id != null && actById.has(parseInt(g.activity_id, 10)))
        ? actById.get(parseInt(g.activity_id, 10)) : null,
      resource_card: g.resource_card_slug ? (cardsBySlug.get(g.resource_card_slug) || null) : null,
    }));

    const [prevRow, nextStepHints] = await Promise.all([
      db.query(`SELECT id, block_no, evaluation, evaluated_at FROM plan_blocks
                  WHERE plan_id = $1 AND block_no < $2 ORDER BY block_no DESC LIMIT 1`, [row.plan_id, row.block_no])
        .then(r => r.rows[0] || null),
      areaNextStepCounts(db, row.room_id),
    ]);

    res.json(Object.assign(shapeBlock(row), {
      room, plan: planRows[0] || null,
      focus_statements_detail: statements,
      provision_grid: hydratedGrid,
      areas: room ? await areasForRoom(db, room) : [],
      next_step_hints: nextStepHints,
      previous_block: prevRow,
      can_edit: canEditBlockRoom(editable, row.room_id),
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /focus-blocks — create the next block of a plan ───────────────────
router.post('/focus-blocks', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  const planId = parseInt(req.body.plan_id, 10);
  if (!Number.isInteger(planId)) return res.status(400).json({ error: 'plan_id required' });
  try {
    const db = getPool();
    const { rows: planRows } = await db.query(`SELECT * FROM term_plans WHERE id = $1`, [planId]);
    const plan = planRows[0];
    if (!plan) return res.status(404).json({ error: 'Plan not found' });

    const me = await blockMyStaff(db, req.user.id);
    const editable = blockEditableRooms(req.user, me);
    if (!canEditBlockRoom(editable, plan.room_id)) {
      return res.status(403).json({ error: editable === 'all' || editable.length
        ? 'You can only create blocks in your own room' : 'Only room leaders and managers can create blocks' });
    }

    const weeksPerBlock = await weeksForRoom(db, plan.room_id);
    const { rows: existing } = await db.query(
      `SELECT COALESCE(MAX(block_no), 0) AS n, COALESCE(MAX(week_to), 0) AS wk FROM plan_blocks WHERE plan_id = $1`, [planId]);
    const blockNo = existing[0].n + 1;
    const weekFrom = Number.isInteger(parseInt(req.body.week_from, 10)) ? parseInt(req.body.week_from, 10) : existing[0].wk + 1;
    const weekTo = Number.isInteger(parseInt(req.body.week_to, 10)) ? parseInt(req.body.week_to, 10) : weekFrom + weeksPerBlock - 1;
    if (weekTo < weekFrom) return res.status(400).json({ error: 'week_to must be >= week_from' });

    const weeks = await weeksForPlan(db, plan);
    const wc = (weeks.find(w => w.week_no === weekFrom) || {}).week_commencing || null;

    const { rows } = await db.query(
      `INSERT INTO plan_blocks (plan_id, room_id, block_no, week_from, week_to, week_commencing, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [planId, plan.room_id, blockNo, weekFrom, weekTo, wc, req.user.id || null]);
    res.json(shapeBlock(rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That block already exists' });
    res.status(500).json({ error: e.message });
  }
});

// ─── PUT /focus-blocks/:id — partial update of the header/input/grid ────────
// Same "only the fields sent are changed" convention as PUT /termly/day.
router.put('/focus-blocks/:id', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const me = await blockMyStaff(db, req.user.id);
    const editable = blockEditableRooms(req.user, me);
    if (!canEditBlockRoom(editable, row.room_id)) {
      return res.status(403).json({ error: editable === 'all' || editable.length
        ? 'You can only edit blocks in your own room' : 'Only room leaders and managers can edit blocks' });
    }
    if (row.status === 'published' && req.body.force !== true) {
      return res.status(409).json({ error: 'This block is published. Edit it anyway with force:true, or evaluate instead.' });
    }

    const has = k => Object.prototype.hasOwnProperty.call(req.body, k);
    const b = req.body || {};
    const sets = [], vals = [];
    const set = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };

    if (has('focus_statements')) set('focus_statements', JSON.stringify(asIntArray(b.focus_statements).slice(0, 4)));
    if (has('core_text'))        set('core_text', b.core_text == null ? null : String(b.core_text).trim());
    if (has('supporting_texts')) set('supporting_texts', asTextArray(b.supporting_texts));
    if (has('key_vocabulary'))   set('key_vocabulary', asTextArray(b.key_vocabulary).slice(0, 8));
    if (has('song_rhyme'))       set('song_rhyme', b.song_rhyme == null ? null : String(b.song_rhyme).trim());
    if (has('number_focus'))     set('number_focus', b.number_focus == null ? null : String(b.number_focus).trim());
    if (has('sound_focus'))      set('sound_focus', b.sound_focus == null ? null : String(b.sound_focus).trim());
    if (has('interests_next_steps')) set('interests_next_steps', b.interests_next_steps == null ? null : String(b.interests_next_steps).trim());
    if (has('input'))            set('input', JSON.stringify(b.input && typeof b.input === 'object' ? b.input : {}));
    if (has('provision_grid'))   set('provision_grid', JSON.stringify(Array.isArray(b.provision_grid) ? b.provision_grid : []));
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE plan_blocks SET ${sets.join(', ')}, updated_at = now() WHERE id = $${vals.length} RETURNING *`, vals);
    res.json(shapeBlock(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /focus-blocks/:id/publish ─────────────────────────────────────────
router.post('/focus-blocks/:id/publish', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const me = await blockMyStaff(db, req.user.id);
    const editable = blockEditableRooms(req.user, me);
    if (!canEditBlockRoom(editable, row.room_id)) {
      return res.status(403).json({ error: 'Only room leaders and managers can publish a block' });
    }
    const vocab = asTextArray(row.key_vocabulary);
    if (vocab.length < 6) {
      return res.status(400).json({ error: `Key vocabulary needs 6–8 words before publishing (has ${vocab.length}).` });
    }
    if (vocab.length > 8) {
      return res.status(400).json({ error: `Key vocabulary has ${vocab.length} words — trim to 6–8 before publishing.` });
    }
    const { rows: roomRows } = await db.query(`SELECT id, name FROM rooms WHERE id = $1`, [row.room_id]);
    const room = roomRows[0];
    const areas = room ? await areasForRoom(db, room) : [];
    const grid = Array.isArray(row.provision_grid) ? row.provision_grid : [];
    const enhanced = grid.filter(g => g && String(g.enhancement || '').trim()).length;
    const warnings = [];
    const minNeeded = minAreasForPublish(roomBand(room || {}));
    if (enhanced < minNeeded) {
      warnings.push(`Only ${enhanced} of ${areas.length} areas have an enhancement — ${minNeeded}+ is the usual bar for ${room ? room.name : 'this room'}.`);
    }
    const { rows } = await db.query(
      `UPDATE plan_blocks SET status = 'published', published_at = now(), published_by = $2, updated_at = now()
        WHERE id = $1 RETURNING *`, [req.params.id, req.user.id || null]);
    res.json(Object.assign(shapeBlock(rows[0]), { warnings }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /focus-blocks/:id/evaluate ────────────────────────────────────────
router.post('/focus-blocks/:id/evaluate', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const me = await blockMyStaff(db, req.user.id);
    const editable = blockEditableRooms(req.user, me);
    if (!canEditBlockRoom(editable, row.room_id)) {
      return res.status(403).json({ error: 'Only room leaders and managers can evaluate a block' });
    }
    if (row.status !== 'published') {
      return res.status(409).json({ error: 'Publish the block before evaluating it.' });
    }
    const b = req.body || {};
    const ALLOWED_TICK = new Set(['busy', 'some', 'unused']);
    const areasTick = {};
    if (b.areas && typeof b.areas === 'object') {
      for (const [area, tick] of Object.entries(b.areas)) {
        if (ALLOWED_TICK.has(tick)) areasTick[area] = tick;
      }
    }
    const evaluation = {
      areas: areasTick,
      worked: b.worked == null ? null : String(b.worked).trim(),
      not_worked: b.not_worked == null ? null : String(b.not_worked).trim(),
      carry_forward: b.carry_forward == null ? null : String(b.carry_forward).trim(),
      by: me ? `${req.user.name || ''}`.trim() || null : null,
    };
    const { rows } = await db.query(
      `UPDATE plan_blocks SET evaluation = $2::jsonb, evaluated_at = now(), evaluated_by = $3, updated_at = now()
        WHERE id = $1 RETURNING *`, [req.params.id, JSON.stringify(evaluation), req.user.id || null]);

    // Roll the block evaluations up onto the term plan's own `evaluation` text
    // field (point 5 of the brief) — a short summary, never overwriting a
    // manager's own written term evaluation, only appended once per block.
    try {
      const { rows: allBlocks } = await db.query(
        `SELECT block_no, evaluation FROM plan_blocks WHERE plan_id = $1 AND evaluation IS NOT NULL ORDER BY block_no`,
        [row.plan_id]);
      const rollup = allBlocks.map(bl => `Block ${bl.block_no}: ${(bl.evaluation && bl.evaluation.worked) || '—'}`).join('\n');
      await db.query(
        `UPDATE term_plans SET carry_forward = $2, updated_at = now() WHERE id = $1`,
        [row.plan_id, rollup]);
    } catch (_) { /* best-effort rollup only */ }

    res.json(shapeBlock(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// b371 (2026-10-01) — which curriculum_activities CATEGORY lands on which
// provision AREA, per room band. Built from what Autumn 2's real plans
// actually contain (construction/art/role_play/sensory for Pre-school;
// sensory/maths/art/role_play/literacy for Baby Room) — deliberately a small
// static map rather than a fuzzy text match, because the category vocabulary
// is small and clean and a wrong "from your plan" tag would be worse than a
// missed one. An area with no mapped category just stays a "new idea".
const PRESCHOOL_CATEGORY_AREA = {
  construction: 'Construction',
  art: 'Creative / art',
  role_play: 'Role play / home corner',
  sensory: 'Sand, water & playdough (sensory & messy)',
  messy: 'Sand, water & playdough (sensory & messy)',
  maths: 'Maths',
  literacy: 'Books & listening',
  phonics_book: 'Books & listening',
  phonics_game: 'Books & listening',
  music: 'Music & movement',
  physical: 'Outdoors / physical',
  outdoor: 'Outdoors / physical',
};
const BABY_CATEGORY_AREA = {
  sensory: 'Sensory / messy',
  messy: 'Sensory / messy',
  art: 'Mark-making (big & messy)',
  role_play: 'Small world / cause & effect',
  literacy: 'Books & songs',
  phonics_book: 'Books & songs',
  music: 'Music & sound',
  maths: 'Music & sound',
  physical: 'Physical (tummy time, cruising, climbing)',
  outdoor: 'Outdoors',
  construction: 'Treasure basket / heuristic play',
};

// The activities already sitting in THIS plan's termly_plan_weeks/days for the
// block's week range — the "+ the term's existing activities for those weeks"
// half of the brief. Deduplicated by activity id.
async function planActivitiesForWeeks(db, planId, roomId, weekFrom, weekTo) {
  const [{ rows: weeks }, { rows: days }] = await Promise.all([
    db.query(`SELECT activity_ids FROM termly_plan_weeks WHERE plan_id = $1 AND room_id = $2 AND week_no BETWEEN $3 AND $4`,
      [planId, roomId, weekFrom, weekTo]),
    db.query(`SELECT activity_ids FROM termly_plan_days WHERE plan_id = $1 AND room_id = $2 AND week_no BETWEEN $3 AND $4`,
      [planId, roomId, weekFrom, weekTo]),
  ]);
  const ids = [...new Set(asIntArray([...weeks, ...days].flatMap(r => Array.isArray(r.activity_ids) ? r.activity_ids : [])))];
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT id, name, description, category FROM curriculum_activities WHERE id = ANY($1::int[])`, [ids]);
  return rows;
}

// ─── POST /focus-blocks/:id/draft — "Draft with Wren" (local model only) ────
// Ascent-or-nothing, same contract as b223: never reaches a cloud model, and a
// failed/offline model returns a DEGRADED response rather than an empty 500 —
// but b371 makes "degraded" still useful: the areas that come straight from
// the existing term plan need no model at all, so they are filled in either
// way. Nothing is written — the client reviews the suggestion and PUTs what
// it keeps. There is no child data to redact: this plans provision, not a
// child.
router.post('/focus-blocks/:id/draft', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const me = await blockMyStaff(db, req.user.id);
    const editable = blockEditableRooms(req.user, me);
    if (!canEditBlockRoom(editable, row.room_id)) {
      return res.status(403).json({ error: 'Only room leaders and managers can draft a block' });
    }

    const [{ rows: roomRows }, { rows: planRows }, prev] = await Promise.all([
      db.query(`SELECT id, name FROM rooms WHERE id = $1`, [row.room_id]),
      db.query(`SELECT theme, key_books, songs FROM term_plans WHERE id = $1`, [row.plan_id]),
      db.query(`SELECT evaluation FROM plan_blocks WHERE plan_id = $1 AND block_no < $2 ORDER BY block_no DESC LIMIT 1`,
                [row.plan_id, row.block_no]).then(r => r.rows[0] || null),
    ]);
    const room = roomRows[0], plan = planRows[0] || {};
    const areas = room ? await areasForRoom(db, room) : [];
    const band = roomBand(room || {});

    // ── "From your plan": lock in areas the plan already has an activity for,
    // unless last block's check ticked that area "unused" — then it is let go
    // to the model for a fresh idea instead (the draft.html "carry" callout).
    const carryUnused = new Set(
      Object.entries((prev && prev.evaluation && prev.evaluation.areas) || {})
        .filter(([, v]) => v === 'unused').map(([k]) => k));
    const planActs = await planActivitiesForWeeks(db, row.plan_id, row.room_id, row.week_from, row.week_to);
    const catMap = band === 'baby' ? BABY_CATEGORY_AREA : PRESCHOOL_CATEGORY_AREA;
    const areaToActivity = new Map();
    for (const a of planActs) {
      const area = catMap[a.category];
      if (area && areas.includes(area) && !areaToActivity.has(area)) areaToActivity.set(area, a);
    }
    const fromPlanGrid = [];
    const newAreas = [];
    for (const area of areas) {
      const act = areaToActivity.get(area);
      if (act && !carryUnused.has(area)) {
        fromPlanGrid.push({
          area, enhancement: act.name + (act.description ? ' — ' + act.description : ''),
          prompt: '', fledge_statement_ids: [], challenge: '', simplify: '',
          activity_id: act.id, resource_card_slug: null, from_plan: true, alternates: [],
        });
      } else {
        newAreas.push(area);
      }
    }
    const carryNote = carryUnused.size
      ? `From last fortnight's check: ${[...carryUnused].join(', ')} ${carryUnused.size === 1 ? 'was' : 'were'} barely used, so Wren has suggested something new for ${carryUnused.size === 1 ? 'it' : 'them'}.`
      : null;

    const [{ rows: bankCount }, cardCount] = await Promise.all([
      db.query(`SELECT count(*)::int AS n FROM curriculum_activities`),
      Promise.resolve(cardIndex().index.length),
    ]);
    const context = {
      theme: plan.theme || null,
      weeks_label: row.week_from === row.week_to ? `week ${row.week_from}` : `weeks ${row.week_from} and ${row.week_to}`,
      from_plan_areas: fromPlanGrid.map(g => g.area),
      bank_activities: bankCount[0].n, bank_cards: cardCount,
      carry_note: carryNote,
    };

    const statementIds = asIntArray(row.focus_statements);
    const { rows: statements } = statementIds.length
      ? await db.query(`SELECT statement_text FROM framework_statements WHERE id = ANY($1::int[])`, [statementIds])
      : { rows: [] };

    const reachable = await PD.probe(4000);
    if (!reachable) {
      // Still genuinely useful degraded: the from-plan areas need no model.
      return res.json({
        degraded: true, reason: `The local model on ${PD.OLLAMA_HOST()} did not answer — only the areas already in your plan were filled in.`,
        context,
        draft: { core_text: null, supporting_texts: [], key_vocabulary: [], song_rhyme: null, number_focus: null, sound_focus: null,
          input: { hook: '', read_model: '', questions: [], vocabulary_use: '', maths_sound_moment: '', provision_tour: '' },
          provision_grid: fromPlanGrid },
      });
    }

    const system = 'You are an EYFS/early-years planning assistant for a UK day nursery. '
      + 'You only choose and arrange what you are given — never invent a fact about a real child, '
      + 'because none is in this prompt. Reply with ONE JSON object and nothing else.';
    const prompt = [
      `Room: ${room ? room.name : 'unknown'} (${band === 'baby' ? 'under 2s' : '2-5 year olds'})`,
      `Term theme: ${plan.theme || 'none set'}`,
      plan.key_books && plan.key_books.length ? `Term's key books: ${plan.key_books.join(', ')}` : null,
      plan.songs && plan.songs.length ? `Term's songs: ${plan.songs.join(', ')}` : null,
      statements.length ? `Focus statements for this block:\n- ${statements.map(s => s.statement_text).join('\n- ')}` : null,
      prev && prev.evaluation ? `Previous block — what worked: ${prev.evaluation.worked || 'n/a'}; carry forward: ${prev.evaluation.carry_forward || 'n/a'}` : null,
      carryNote,
      newAreas.length
        ? `Provision areas to plan for (the rest already have an idea from the existing term plan — do not suggest these): ${newAreas.join(', ')}`
        : 'Every provision area already has an idea from the existing term plan — return an empty provision_grid array.',
      '',
      'Return JSON with exactly these keys:',
      '{"core_text": "one picture book title", "supporting_texts": ["..."], ',
      '"key_vocabulary": ["6 to 8 single words or short phrases"], "song_rhyme": "...", ',
      '"number_focus": "a number and what to do with it, e.g. \'3 — subitise, count, more/fewer\'", ',
      '"sound_focus": "one phonological-awareness aspect (environmental sounds / instrumental sounds / body percussion / rhythm and rhyme / alliteration / voice sounds / oral blending)", ',
      '"input": {"hook": "...", "read_model": "...", "questions": ["3 to 5 short questions"], ',
      '"vocabulary_use": "...", "maths_sound_moment": "...", "provision_tour": "..."}, ',
      `"provision_grid": [{"area": "<one of the areas listed, verbatim>", "enhancement": "what is put out", "prompt": "one question + the target words", "challenge": "...", "simplify": "...", "alternates": [{"enhancement":"a different idea for this area","prompt":"..."},{"enhancement":"a second different idea","prompt":"..."}]}] — one entry per area listed, each with exactly 2 alternates for the Swap button.`,
    ].filter(Boolean).join('\n');

    // b371: alternates roughly double what each new area asks for (vs b368's
    // single suggestion), and a truncated reply is an invalid-JSON degrade —
    // seen in testing on an 8-new-area room at the old 2200 cap. Raised, not
    // tuned to a guarantee: the degraded path below is what actually keeps
    // this safe, not the token budget.
    let out;
    try { out = await PD.callModel(prompt, { system, maxTokens: 3200 }); }
    catch (e) { return res.json({ degraded: true, reason: `The local model failed: ${e.message}`, context, draft: { provision_grid: fromPlanGrid } }); }

    let parsed;
    try { parsed = PD.parseModelJson(out.text); }
    catch (e) { return res.json({ degraded: true, reason: `The model's reply was not usable JSON (${e.message}).`, model: out.model, context, draft: { provision_grid: fromPlanGrid } }); }

    const newAreaSet = new Set(newAreas);
    const aiGrid = (Array.isArray(parsed.provision_grid) ? parsed.provision_grid : [])
      .filter(g => g && newAreaSet.has(g.area))
      .map(g => ({
        area: g.area, enhancement: String(g.enhancement || '').trim(), prompt: String(g.prompt || '').trim(),
        fledge_statement_ids: [], challenge: String(g.challenge || '').trim(), simplify: String(g.simplify || '').trim(),
        activity_id: null, resource_card_slug: null, from_plan: false,
        alternates: (Array.isArray(g.alternates) ? g.alternates : []).slice(0, 2)
          .map(a => ({ enhancement: String((a && a.enhancement) || '').trim(), prompt: String((a && a.prompt) || '').trim() }))
          .filter(a => a.enhancement),
      }));

    const draft = {
      core_text: String(parsed.core_text || '').trim() || null,
      supporting_texts: asTextArray(parsed.supporting_texts).slice(0, 4),
      key_vocabulary: asTextArray(parsed.key_vocabulary).slice(0, 8),
      song_rhyme: String(parsed.song_rhyme || '').trim() || null,
      number_focus: String(parsed.number_focus || '').trim() || null,
      sound_focus: String(parsed.sound_focus || '').trim() || null,
      input: {
        hook: String((parsed.input || {}).hook || '').trim(),
        read_model: String((parsed.input || {}).read_model || '').trim(),
        questions: asTextArray((parsed.input || {}).questions).slice(0, 5),
        vocabulary_use: String((parsed.input || {}).vocabulary_use || '').trim(),
        maths_sound_moment: String((parsed.input || {}).maths_sound_moment || '').trim(),
        provision_tour: String((parsed.input || {}).provision_tour || '').trim(),
      },
      provision_grid: fromPlanGrid.concat(aiGrid),
    };
    res.json({ degraded: false, model: out.model, host: out.host, context, draft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── GET /focus-blocks/:id/parent-text — copy-ready, NEVER auto-sent ────────
router.get('/focus-blocks/:id/parent-text', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const { rows: roomRows } = await db.query(`SELECT name FROM rooms WHERE id = $1`, [row.room_id]);
    const roomName = (roomRows[0] || {}).name || 'your child\'s room';
    const vocab = asTextArray(row.key_vocabulary);
    const lines = [`This fortnight in ${roomName}`];
    if (row.core_text) lines.push(`Our book: ${row.core_text}`);
    if (vocab.length) lines.push(`Words we're using: ${vocab.join(', ')}`);
    if (row.song_rhyme) lines.push(`Our song/rhyme: ${row.song_rhyme}`);
    const homeIdea = (row.input && row.input.provision_tour)
      ? `Try at home: talk about ${row.core_text || 'our story'} together, and sing ${row.song_rhyme || 'our song'} at bedtime.`
      : `Try at home: ask your child about ${row.core_text || 'what we have been reading'} and practise the words above together.`;
    lines.push(homeIdea);
    res.json({ text: lines.join('\n'), block_id: row.id, never_sent: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /focus-blocks/:id/newsletter-draft — offer it as a DRAFT section ──
// Never sends anything. Attaches to the most recent parents newsletter that is
// still status='draft'; if none is open, says so rather than creating one —
// a whole newsletter is a bigger decision than this button should make.
router.post('/focus-blocks/:id/newsletter-draft', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const me = await blockMyStaff(db, req.user.id);
    const editable = blockEditableRooms(req.user, me);
    if (!canEditBlockRoom(editable, row.room_id)) {
      return res.status(403).json({ error: 'Only room leaders and managers can offer this to the newsletter' });
    }
    const { rows: nlRows } = await db.query(
      `SELECT id FROM newsletters WHERE audience = 'parents' AND status = 'draft' ORDER BY updated_at DESC LIMIT 1`);
    if (!nlRows.length) {
      return res.json({ ok: false, reason: 'No draft newsletter is open — start one on the Newsletter page, then try again.' });
    }
    const nlId = nlRows[0].id;
    const { rows: roomRows } = await db.query(`SELECT name FROM rooms WHERE id = $1`, [row.room_id]);
    const roomName = (roomRows[0] || {}).name || 'Room';
    const textResp = await (async () => {
      const vocab = asTextArray(row.key_vocabulary);
      const lines = [];
      if (row.core_text) lines.push(`Our book: ${row.core_text}`);
      if (vocab.length) lines.push(`Words we're using: ${vocab.join(', ')}`);
      if (row.song_rhyme) lines.push(`Our song/rhyme: ${row.song_rhyme}`);
      return lines.join('\n');
    })();
    const { rows: existingSection } = await db.query(
      `SELECT id FROM newsletter_sections WHERE newsletter_id = $1 AND section_type = 'focus_block' AND title = $2`,
      [nlId, `This fortnight — ${roomName}`]);
    let section;
    if (existingSection.length) {
      const { rows } = await db.query(
        `UPDATE newsletter_sections SET raw_notes = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [existingSection[0].id, textResp]);
      section = rows[0];
    } else {
      const { rows: mx } = await db.query(
        `SELECT COALESCE(MAX(section_order), -1) + 1 AS next FROM newsletter_sections WHERE newsletter_id = $1`, [nlId]);
      const { rows } = await db.query(
        `INSERT INTO newsletter_sections (newsletter_id, section_type, title, raw_notes, metadata, section_order)
         VALUES ($1,'focus_block',$2,$3,$4,$5) RETURNING *`,
        [nlId, `This fortnight — ${roomName}`, textResp, JSON.stringify({ plan_block_id: row.id }), mx[0].next]);
      section = rows[0];
    }
    res.json({ ok: true, newsletter_id: nlId, section_id: section.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router._focusBlockAreasForRoom = areasForRoom;
router._focusBlockWeeksForRoom = weeksForRoom;

// ═══════════════════════════════════════════════════════════════════════════
// b371 (2026-10-01) — PLANNING IN FORTNIGHTS, finished out to match the demo
// (editions/ladn/public/ey/planning-demo/): "This half term" overview,
// "Today's input" run sheet, "Send to the deputy to check" + its reminder,
// and the per-room switch-over setting. APPENDED — the b368 section above is
// unchanged except for two small, explicitly-marked patches (focus-block-
// settings now also carries blocks_enabled; POST .../draft now locks in
// areas the term plan already covers and offers 2 alternates per new area).
// ═══════════════════════════════════════════════════════════════════════════

// Due the Wednesday before the fortnight starts — draft.html's "Room leader,
// Wednesday 11 November" drafting the fortnight that starts the next Monday.
function blockDueDate(weekCommencing) {
  if (!weekCommencing) return null;
  const d = new Date(weekCommencing + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 5);
  return blockYmd(d);
}

// The three pills half-term.html shows: Ready (published) / Wren draft, needs
// a look (draft with something in it) / Not started (no block, or an empty one).
function blockStatusInfo(row) {
  if (!row) return { status: 'not_started', status_label: 'Not started' };
  const grid = Array.isArray(row.provision_grid) ? row.provision_grid : [];
  const hasContent = !!row.core_text || grid.some(g => g && String(g.enhancement || '').trim());
  if (row.status === 'published') {
    return row.deputy_checked_at
      ? { status: 'ready_checked', status_label: 'Ready · checked by the deputy' }
      : { status: 'ready', status_label: 'Ready' };
  }
  return hasContent
    ? { status: 'needs_look', status_label: 'Wren draft, needs a look' }
    : { status: 'not_started', status_label: 'Not started' };
}

async function notifyDeputies(db, { title, body, link, relatedId }) {
  const { rows } = await db.query(`SELECT id FROM staff WHERE role IN ('deputy_manager','manager')`);
  await Promise.all(rows.map(r => db.query(
    `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
     VALUES ('staff',$1,'planning',$2,$3,$4,'plan_blocks',$5,'normal')`,
    [r.id, title, body, link, relatedId]).catch(() => {})));
}

// ─── GET /half-term?room_id= — "This half term": the theme, the term's dates,
// and the N fortnights of this plan as status cards (block rows that don't
// exist yet are shown as "Not started" placeholders, not hidden). ───────────
router.get('/half-term', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const planIdQ = parseInt(req.query.plan_id, 10);
    let roomId = parseInt(req.query.room_id, 10);
    if (!Number.isInteger(roomId) && !Number.isInteger(planIdQ)) return res.status(400).json({ error: 'room_id or plan_id required' });

    let plan = null;
    if (Number.isInteger(planIdQ)) {
      const { rows } = await db.query(`SELECT * FROM term_plans WHERE id = $1`, [planIdQ]);
      plan = rows[0] || null;
      if (plan) roomId = plan.room_id;
    }
    const { rows: roomRows } = await db.query(`SELECT id, name FROM rooms WHERE id = $1`, [roomId]);
    const room = roomRows[0];
    if (!room) return res.status(404).json({ error: 'Room not found' });

    if (!plan) plan = await currentPlanForRoom(db, roomId);
    if (!plan) {
      return res.json({
        room, plan: null, term: null, fortnights: [], can_edit: false,
        note: 'No term plan found for this room/period yet — create one on the Termly Planning page first.',
      });
    }
    const me = await blockMyStaff(db, req.user.id);
    const editable = blockEditableRooms(req.user, me);
    const canEdit = canEditBlockRoom(editable, room.id);

    const [weeks, { rows: blockRows }, areas, weeksPerBlock] = await Promise.all([
      weeksForPlan(db, plan),
      db.query(`SELECT * FROM plan_blocks WHERE plan_id = $1 ORDER BY block_no`, [plan.id]),
      areasForRoom(db, room),
      weeksForRoom(db, room.id),
    ]);

    let term = null;
    if (plan.school_term_id) {
      const { rows } = await db.query(
        `SELECT name, academic_year, to_char(start_date,'YYYY-MM-DD') AS start_date, to_char(end_date,'YYYY-MM-DD') AS end_date
           FROM school_terms WHERE id = $1`, [plan.school_term_id]);
      term = rows[0] || null;
    }

    const totalWeeks = weeks.length || 6;
    const totalFortnights = Math.max(1, Math.ceil(totalWeeks / weeksPerBlock));
    const byBlockNo = new Map(blockRows.map(b => [b.block_no, b]));
    const fortnights = [];
    for (let n = 1; n <= totalFortnights; n++) {
      const weekFrom = (n - 1) * weeksPerBlock + 1;
      const weekTo = Math.min(weekFrom + weeksPerBlock - 1, totalWeeks);
      const row = byBlockNo.get(n) || null;
      const wc = row ? blockYmd(row.week_commencing) : ((weeks.find(w => w.week_no === weekFrom) || {}).week_commencing || null);
      const grid = row && Array.isArray(row.provision_grid) ? row.provision_grid : [];
      const info = blockStatusInfo(row);
      fortnights.push({
        block_id: row ? row.id : null,
        block_no: n, week_from: weekFrom, week_to: weekTo, week_commencing: wc,
        label: weeksPerBlock === 1 ? `Week ${weekFrom}` : `Weeks ${weekFrom}–${weekTo}`,
        status: info.status, status_label: info.status_label,
        core_text: row ? row.core_text : null,
        song_rhyme: row ? row.song_rhyme : null,
        key_vocabulary: row ? asTextArray(row.key_vocabulary) : [],
        areas_planned: grid.filter(g => g && String(g.enhancement || '').trim()).length,
        areas_total: areas.length,
        from_plan_count: grid.filter(g => g && g.activity_id != null).length,
        due_date: wc ? blockDueDate(wc) : null,
        deputy_check_requested_at: row ? row.deputy_check_requested_at : null,
      });
    }

    res.json({
      room, can_edit: canEdit,
      plan: {
        id: plan.id, term_name: plan.term_name, academic_year: plan.academic_year, theme: plan.theme,
        key_books: plan.key_books || [], songs: plan.songs || [],
        learning_intentions: plan.learning_intentions || [], status: plan.status,
      },
      term, weeks_total: totalWeeks, weeks_per_block: weeksPerBlock, areas, fortnights,
      old_day_view: `/ey/termly-plan?room_id=${room.id}`,
      focus_block_href: `/ey/focus-block?room_id=${room.id}`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── day-of-the-fortnight maths (weekdays only — Mon-Fri) ────────────────────
const STAGE_NAMES = ['Introduce', 'Revisit and retell', 'Act it out', 'Children lead', 'Celebrate and check'];
function addWeekdays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  let added = 0;
  while (added < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) added++;
  }
  return blockYmd(d);
}
function dayIndexFor(wc, totalDays, todayYmd) {
  if (!wc) return 1;
  if (todayYmd <= wc) return 1;
  const last = addWeekdays(wc, totalDays - 1);
  if (todayYmd >= last) return totalDays;
  let idx = 1;
  const d = new Date(wc + 'T00:00:00Z');
  const t = new Date(todayYmd + 'T00:00:00Z');
  while (d < t) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) idx++;
  }
  return Math.min(idx, totalDays);
}
function stageForDay(dayIndex, totalDays) {
  const i = Math.min(4, Math.floor(((dayIndex - 1) / totalDays) * 5));
  return { index: i, name: STAGE_NAMES[i] };
}
// Older group gets the full ~10-minute input; Baby Room's is ≤5 minutes — same
// split focus-block.html's Input tab already writes (older.notes/younger.notes).
function runSheetFor(row, band) {
  const inp = row.input || {};
  if (band === 'baby') {
    return [
      { key: 'song', label: 'Song', minutes: 1, text: row.song_rhyme || '' },
      { key: 'book', label: row.core_text ? `Book: ${row.core_text}` : 'Book', minutes: 2, text: inp.read_model || '' },
      { key: 'vocab', label: 'Words in use', minutes: 1, text: inp.vocabulary_use || '' },
      { key: 'tour', label: 'Provision tour', minutes: 1, text: inp.provision_tour || '' },
    ];
  }
  return [
    { key: 'song', label: 'Song', minutes: 1, text: row.song_rhyme || '' },
    { key: 'book', label: row.core_text ? `Book: ${row.core_text}` : 'Book', minutes: 4, text: inp.read_model || '', questions: asTextArray(inp.questions) },
    { key: 'vocab', label: 'Words in use', minutes: 1, text: inp.vocabulary_use || '' },
    { key: 'number', label: 'Number / sound moment', minutes: 2, text: inp.maths_sound_moment || '' },
    { key: 'tour', label: 'Provision tour', minutes: 2, text: inp.provision_tour || '' },
  ];
}

// ─── GET /focus-blocks/:id/today — "Today's input": day N of the fortnight,
// the stage, and a tappable run sheet. View-only data; everyone can see it,
// per the demo's "Who does what → Everyone" (prompt cards, key words). ──────
router.get('/focus-blocks/:id/today', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const { rows: roomRows } = await db.query(`SELECT id, name FROM rooms WHERE id = $1`, [row.room_id]);
    const room = roomRows[0] || null;
    const band = roomBand(room || {});

    const wc = blockYmd(row.week_commencing);
    const totalDays = Math.max(1, (row.week_to - row.week_from + 1) * 5);
    const today = CAL.todayYmd();
    const dayIndex = dayIndexFor(wc, totalDays, today);
    const stage = stageForDay(dayIndex, totalDays);
    const log = Array.isArray(row.daily_log) ? row.daily_log : [];
    const mine = log.find(l => l && l.day === dayIndex) || null;

    res.json({
      block_id: row.id, room, band, status: row.status,
      day: dayIndex, total_days: totalDays, date: today,
      stage: stage.name, stage_index: stage.index,
      core_text: row.core_text, song_rhyme: row.song_rhyme,
      key_vocabulary: asTextArray(row.key_vocabulary),
      group_notes: band === 'baby' ? ((row.input || {}).younger || {}).notes || '' : ((row.input || {}).older || {}).notes || '',
      run_sheet: runSheetFor(row, band),
      today_check: mine,
      half_term_href: `/ey/planning-half-term?room_id=${row.room_id}`,
      block_href: `/ey/focus-block?room_id=${row.room_id}&block=${row.id}`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /focus-blocks/:id/today-check — "How did it go?" (open to anyone —
// this is a 1-tap note, not a plan edit; see the demo's "Everyone" row). ────
router.post('/focus-blocks/:id/today-check', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const day = parseInt(req.body.day, 10);
    const went = String(req.body.went || '').trim();
    if (!Number.isInteger(day) || day < 1) return res.status(400).json({ error: 'day required' });
    if (!['well', 'ok', 'hard'].includes(went)) return res.status(400).json({ error: 'went must be well, ok or hard' });
    const entry = { day, date: CAL.todayYmd(), went, by: (req.user.name || '').trim() || null, at: new Date().toISOString() };
    const log = (Array.isArray(row.daily_log) ? row.daily_log : []).filter(l => !(l && l.day === day));
    log.push(entry);
    const { rows } = await db.query(
      `UPDATE plan_blocks SET daily_log = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING daily_log`,
      [req.params.id, JSON.stringify(log)]);
    res.json({ ok: true, daily_log: rows[0].daily_log });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /focus-blocks/:id/send-to-deputy — draft.html's "Send to the
// deputy to check" → a notification, never an email/text. ──────────────────
router.post('/focus-blocks/:id/send-to-deputy', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  try {
    const db = getPool();
    const row = await loadBlockRow(db, req.params.id);
    if (!row) return res.status(404).json({ error: 'Block not found' });
    const me = await blockMyStaff(db, req.user.id);
    const editable = blockEditableRooms(req.user, me);
    if (!canEditBlockRoom(editable, row.room_id)) {
      return res.status(403).json({ error: 'Only room leaders and managers can send a block to be checked' });
    }
    const { rows: roomRows } = await db.query(`SELECT name FROM rooms WHERE id = $1`, [row.room_id]);
    const roomName = (roomRows[0] || {}).name || 'a room';
    const due = blockDueDate(blockYmd(row.week_commencing));
    const { rows } = await db.query(
      `UPDATE plan_blocks SET deputy_check_requested_at = now(), deputy_check_requested_by = $2, updated_at = now()
        WHERE id = $1 RETURNING *`, [req.params.id, req.user.id || null]);
    await notifyDeputies(db, {
      title: `Check the fortnight plan — ${roomName}`,
      body: `Block ${row.block_no}${row.core_text ? ' — ' + row.core_text : ''} is ready to check` + (due ? ` by ${due}.` : '.'),
      link: `/ey/focus-block?room_id=${row.room_id}&block=${row.id}`,
      relatedId: row.id,
    });
    res.json(Object.assign(shapeBlock(rows[0]), { ok: true, due_date: due }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── POST /focus-blocks/:id/mark-checked — the deputy/manager's own tap,
// manager-tier only. Turns the half-term pill into "Ready · checked by the
// deputy". ────────────────────────────────────────────────────────────────
router.post('/focus-blocks/:id/mark-checked', authenticate, async (req, res) => {
  if (!blockPortalGate(req, res)) return;
  if (!hasRole(req.user, BLOCK_ALL_ROOMS_ROLES)) {
    return res.status(403).json({ error: 'Only a manager or deputy can mark a block as checked' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE plan_blocks SET deputy_checked_at = now(), deputy_checked_by = $2, updated_at = now()
        WHERE id = $1 RETURNING *`, [req.params.id, req.user.id || null]);
    if (!rows.length) return res.status(404).json({ error: 'Block not found' });
    res.json(shapeBlock(rows[0]));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
// b521 — THE PLANNING SHEET (Kat's format)
// ═══════════════════════════════════════════════════════════════════════════════
// Toby, 2026-10-20: "it doesn't look like the most recent pre-school planning I
// gave you from Kat, like a week or two ago. I wanted it in that exact format. It
// was quite pretty, A4, with light autumn colours."
//
// Kat's sheet is an A4 portrait page: a centred half-term title, then a stack of
// coloured activity cards, each headed with the activity name and carrying four
// labelled lines — Intent, Implementation, Impact, Adult Role. The cards live in
// term_plans.focus_activities (b521 migration); where nobody has typed them yet
// the reader derives one per provision-grid area, so an existing plan already
// prints in this format. The resolution is in src/lib/term-plan-view.js
// (focusSheet) so Roost, EY, the parents view and the PDF read one thing.
//
// Two routes only, and NEITHER duplicates an existing mount:
//   GET  /termly/sheet            — the cards for one half-term
//   PUT  /termly/sheet            — replace the cards for one half-term
// The plan itself is still written by the existing /termly routes; this only ever
// touches the one new column.

const SHEET_MAX_CARDS = 40;
const SHEET_MAX_FIELD = 2000;

// The card shape, validated here rather than trusting the body: the reader is
// tolerant by design (it has to cope with hand-written JSON), and tolerance in a
// reader is not a reason to store rubbish.
function sheetCardFromBody(a, i) {
  if (!a || typeof a !== 'object') return null;
  const clean = v => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, SHEET_MAX_FIELD);
  const card = { title: clean(a.title || a.name || a.activity) };
  for (const f of TPV.FOCUS_FIELDS) {
    const v = clean(a[f]);
    if (v) card[f] = v;
  }
  const colour = String(a.colour == null ? '' : a.colour).trim().toLowerCase();
  if (/^[a-z]{3,12}$/.test(colour)) card.colour = colour;   // a palette NAME, never a hex literal
  if (!card.title && !TPV.FOCUS_FIELDS.some(f => card[f])) return null;
  if (!card.title) card.title = 'Activity ' + (i + 1);
  return card;
}

// GET /termly/sheet?plan_id=NN   (or ?room_id=&half_term_id= / &term_id=)
router.get('/termly/sheet', authenticate, async (req, res) => {
  // Same gate as the rest of the termly planner: a sheet can be a DRAFT, and a
  // draft must never reach the parents host (b290).
  if (req._portal === 'parents') return res.status(403).json({ error: 'Not available here' });
  try {
    const db = getPool();
    let row = null;
    const planId = parseInt(req.query.plan_id, 10);
    if (planId) {
      const { rows } = await db.query(`SELECT * FROM term_plans WHERE id = $1`, [planId]);
      row = rows[0] || null;
    } else {
      const roomId = parseInt(req.query.room_id, 10);
      if (!roomId) return res.status(400).json({ error: 'plan_id, or room_id with a period, required' });
      const term = await resolvePeriod(db, req.query);
      if (!term) return res.status(400).json({ error: 'half_term_id or term_id required' });
      row = await findTermPlan(db, roomId, term);
    }
    if (!row) return res.json({ plan_id: null, source: 'none', cards: [], status: null });
    const sheet = TPV.focusSheet(row);
    res.json({
      plan_id: row.id,
      room_id: row.room_id,
      term_name: row.term_name,
      academic_year: row.academic_year,
      theme: row.theme || null,
      status: row.status || null,
      source: sheet.source,     // 'typed' | 'grid' | 'none'
      cards: sheet.cards,
    });
  } catch (e) {
    console.error('[planning] termly/sheet GET:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// PUT /termly/sheet  { plan_id, cards: [ {title,intent,implementation,impact,adult_role,colour?} ] }
// Replaces the sheet for that half-term. Sending [] clears the typed cards, which
// puts the plan back on the grid-derived sheet — it does NOT empty the plan.
router.put('/termly/sheet', authenticate, async (req, res) => {
  if (!requirePlanEdit(req, res)) return;
  const planId = parseInt(req.body && req.body.plan_id, 10);
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  const raw = req.body && req.body.cards;
  if (!Array.isArray(raw)) return res.status(400).json({ error: 'cards must be an array' });
  if (raw.length > SHEET_MAX_CARDS) {
    return res.status(400).json({ error: `at most ${SHEET_MAX_CARDS} cards` });
  }
  const cards = raw.map(sheetCardFromBody).filter(Boolean);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE term_plans SET focus_activities = $2::jsonb, updated_at = now()
        WHERE id = $1
        RETURNING id, room_id, term_name, academic_year, status`,
      // Empty array -> NULL, not '[]': NULL is "nobody has written the sheet", which
      // is what puts the plan back on the grid-derived one. '[]' would mean "the
      // sheet is deliberately empty" and would print a blank page.
      [planId, cards.length ? JSON.stringify(cards) : null]);
    if (!rows.length) return res.status(404).json({ error: 'Plan not found' });
    const sheet = TPV.focusSheet({ focus_activities: cards.length ? cards : null,
                                   provision_grid: null });
    res.json({ ok: true, plan: rows[0], saved: cards.length, source: sheet.source });
  } catch (e) {
    // The column arrives with migrations/2026-10-20-b521-focus-activities.sql.
    if (e.code === '42703') {
      return res.status(503).json({ error: 'b521 migration not applied (term_plans.focus_activities)' });
    }
    console.error('[planning] termly/sheet PUT:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

// 27 Oct 2026 — exposed (read-only) for src/lib/parents-planning-live.js, so the parents' live planning view
// reads a plan through the SAME loader the planning PDF uses instead of a fourth copy of it.
router.loadPlanBundle = loadPlanBundle;
