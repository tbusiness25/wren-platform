'use strict';
/**
 * framework-builder.js — b180 (2026-08-19): Custom Framework Builder wizard.
 *
 * Birth to 5 Matters is no longer shipped as content (its 2026 licence forbids
 * commercial reproduction). Instead each setting builds its OWN framework from
 * the principles: Wren ships the wizard, not the copyrighted statements.
 *
 * Flow: the client walks six wizard steps, calls POST /generate-area once per
 * curriculum area (small calls — one giant request is what makes local-model
 * JSON unreliable), reviews/edits the draft grid, then POSTs /save.
 *
 * Nothing is written to framework_statements until /save. A generation pass
 * that comes back short reports its gaps instead of padding them with filler —
 * an obviously-incomplete grid the manager can fix beats junk in the tracker.
 *
 * Writes sub-area -> sub_area and band -> age_range (b180 migration); `aspect`
 * is left NULL because it means different things in different shipped
 * frameworks and is not safe to overload again.
 */
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { getPool } = require('../db/pool');
const ai = require('../lib/ai-models');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

const MGR_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];

router.use(authenticate);
router.use((req, res, next) => {
  if (!req.user || !hasRole(req.user, MGR_ROLES)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

// ── Slug rules ───────────────────────────────────────────────────────────────
// framework_statements.framework is varchar(30). The 'custom_' prefix keeps the
// slug compatible with src/routes/custom-frameworks.js isCustom(), so a wizard
// framework can also be edited/deleted through that older route.
const SLUG_PREFIX = 'custom_';
const SLUG_MAX = 30;

function slugify(name) {
  const body = String(name || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, SLUG_MAX - SLUG_PREFIX.length);
  return body ? SLUG_PREFIX + body : '';
}

function isBuilderSlug(slug) {
  return typeof slug === 'string' && slug.startsWith(SLUG_PREFIX) && slug.length <= SLUG_MAX;
}

// ── Wizard defaults (step 4/5 starting points — all user-editable) ───────────
// EYFS statutory area and strand headings (Crown copyright / OGL), used purely
// as structure. No Birth to 5 Matters content is reproduced anywhere here.
const DEFAULT_AREAS = [
  { name: 'Communication and Language',                  sub_areas: ['Listening, Attention and Understanding', 'Speaking'] },
  { name: 'Personal, Social and Emotional Development',  sub_areas: ['Self-Regulation', 'Managing Self', 'Building Relationships'] },
  { name: 'Physical Development',                        sub_areas: ['Gross Motor Skills', 'Fine Motor Skills'] },
  { name: 'Literacy',                                    sub_areas: ['Comprehension', 'Word Reading', 'Writing'] },
  { name: 'Mathematics',                                 sub_areas: ['Number', 'Numerical Patterns'] },
  { name: 'Understanding the World',                     sub_areas: ['Past and Present', 'People, Culture and Communities', 'The Natural World'] },
  { name: 'Expressive Arts and Design',                  sub_areas: ['Creating with Materials', 'Being Imaginative and Expressive'] },
];

const DEFAULT_BANDS = [
  { label: 'Step 1', age_span: 'Birth–18 months' },
  { label: 'Step 2', age_span: '16–26 months' },
  { label: 'Step 3', age_span: '22–36 months' },
  { label: 'Step 4', age_span: '30–50 months' },
  { label: 'Step 5', age_span: '48–60+ months' },
];

const INFLUENCES = [
  { key: 'montessori',        label: 'Montessori',            hint: 'child-led choice, prepared environment, real tools, uninterrupted work cycles' },
  { key: 'froebel',           label: 'Froebel',               hint: 'play as the highest form of learning, gifts and occupations, unity with nature' },
  { key: 'reggio',            label: 'Reggio Emilia',         hint: 'the hundred languages, project work, documentation, environment as third teacher' },
  { key: 'curiosity',         label: 'Curiosity Approach',    hint: 'authentic and open-ended resources, calm homely spaces, awe and wonder' },
  { key: 'forest_school',     label: 'Forest School',         hint: 'sustained outdoor learning, managed risk, seasons and the natural world' },
  { key: 'pikler',            label: 'Pikler',                hint: 'free movement, uninterrupted floor play, respectful care routines' },
  { key: 'play_based',        label: 'Play-based',            hint: 'learning through freely chosen, self-directed and intrinsically motivated play' },
  { key: 'school_readiness',  label: 'School-readiness weighted', hint: 'explicit preparation for the Reception classroom and the ELGs' },
];

const WIZARD_STEPS = ['profile', 'demographics', 'stance', 'structure', 'progression', 'priorities'];

// GET /defaults — everything the wizard needs to render its starting state.
router.get('/defaults', (req, res) => {
  res.json({
    areas: DEFAULT_AREAS,
    bands: DEFAULT_BANDS,
    influences: INFLUENCES,
    steps: WIZARD_STEPS,
    slug_prefix: SLUG_PREFIX,
    slug_max: SLUG_MAX,
  });
});

// ── Ollama (interactive path: reads OLLAMA_HOST directly, per ollama-pick.js
//    "interactive routes must never require() this file") ─────────────────────
const OLLAMA_HOST  = () => ai.host();
// Building a full custom framework is careful long-form JSON → ai-models.js role
// 'heavy', resolved per call. (b333: was FRAMEWORK_BUILDER_MODEL / qwen3.6:35b-a3b.)
const BUILDER_MODEL = () => ai.model('heavy');
const GEN_TIMEOUT_MS = parseInt(process.env.FRAMEWORK_BUILDER_TIMEOUT_MS || '240000', 10);

// GET /health — lets the wizard warn BEFORE the manager fills six steps in.
router.get('/health', async (req, res) => {
  const model = BUILDER_MODEL();
  try {
    const r = await fetch(`${OLLAMA_HOST()}/api/tags`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`tags ${r.status}`);
    const data = await r.json();
    const names = (data.models || []).map(m => m.name);
    res.json({ ok: true, host: OLLAMA_HOST(), model, model_present: names.includes(model), models: names });
  } catch (e) {
    res.json({ ok: false, host: OLLAMA_HOST(), model, error: e.message });
  }
});

/** Strip reasoning-model wrappers and code fences, then parse. Returns null on failure. */
function parseModelJson(raw) {
  if (!raw) return null;
  let s = String(raw)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (_) { /* fall through to brace-slice */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a !== -1 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (_) {} }
  return null;
}

async function ollamaJson(systemPrompt, userPrompt) {
  const resp = await fetch(`${OLLAMA_HOST()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: BUILDER_MODEL(),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ],
      stream: false,
      format: 'json',
      think: false, // reasoning models otherwise burn the budget before emitting JSON
      options: ai.options({ temperature: 0.4, num_predict: 4096 }, 'long'),
    }),
    signal: AbortSignal.timeout(GEN_TIMEOUT_MS),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
  const data = await resp.json();
  return parseModelJson(data.message && data.message.content);
}

/** Compact, human-readable summary of the wizard answers — this is the grounding. */
function describeAnswers(a) {
  a = a || {};
  const p = a.profile || {}, d = a.demographics || {}, s = a.stance || {};
  const lines = [];
  if (p.setting_name)   lines.push(`Setting: ${p.setting_name}`);
  if (p.age_ranges)     lines.push(`Ages served: ${p.age_ranges}`);
  if (p.rooms)          lines.push(`Rooms: ${p.rooms}`);
  if (p.group_sizes)    lines.push(`Group sizes: ${p.group_sizes}`);
  if (p.day_type)       lines.push(`Sessions: ${p.day_type}`);
  if (d.eal_pct != null && d.eal_pct !== '')   lines.push(`EAL: ${d.eal_pct}%`);
  if (d.home_languages) lines.push(`Main home languages: ${d.home_languages}`);
  if (d.send_pct != null && d.send_pct !== '') lines.push(`SEND: ${d.send_pct}%`);
  if (d.funded_pct != null && d.funded_pct !== '') lines.push(`On funded entitlements: ${d.funded_pct}%`);
  if (d.deprivation)    lines.push(`Deprivation context: ${d.deprivation}`);
  if (d.culture)        lines.push(`Cultural make-up: ${d.culture}`);
  if (d.transience)     lines.push(`Transience / rurality: ${d.transience}`);

  const infl = Array.isArray(s.influences) ? s.influences.filter(i => i && i.key && Number(i.weight) > 0) : [];
  if (infl.length) {
    const byKey = Object.fromEntries(INFLUENCES.map(i => [i.key, i]));
    lines.push('Pedagogical influences (weight 1–5): ' + infl
      .sort((x, y) => Number(y.weight) - Number(x.weight))
      .map(i => `${(byKey[i.key] || {}).label || i.key} (${i.weight}) — ${(byKey[i.key] || {}).hint || ''}`)
      .join('; '));
  }
  if (a.priorities) lines.push(`What matters most to our children this year: ${a.priorities}`);
  return lines.join('\n');
}

const SYSTEM_PROMPT = [
  'You are an experienced UK early years curriculum designer helping a setting write its OWN',
  'curriculum framework. You write original developmental statements in the setting\'s voice.',
  '',
  'HARD RULES:',
  '- Never copy or paraphrase statements from Birth to 5 Matters, Development Matters or any',
  '  other published framework. Every statement must be original wording.',
  '- One statement per requested cell. A statement describes what a child is doing/showing —',
  '  observable, present tense, 8-30 words, no bullet points, no numbering, no quotation marks.',
  '- Statements must get progressively more advanced across the bands, in order.',
  '- Reflect the setting profile, demographics, pedagogical influences and priorities you are given.',
  '- British English.',
  '- Reply with JSON only, matching the requested shape exactly.',
].join('\n');

function cellKey(sub, band) { return `${String(sub).toLowerCase().trim()}||${String(band).toLowerCase().trim()}`; }

/** Ask the model for a specific list of cells. Returns Map(cellKey -> statement text). */
async function generateCells(answersText, areaName, cells) {
  const shape = '{"statements":[{"sub_area":"...","band":"...","statement":"..."}]}';
  const user = [
    'SETTING CONTEXT',
    answersText || '(no context given)',
    '',
    `CURRICULUM AREA: ${areaName}`,
    '',
    `Write exactly ${cells.length} statement(s) — one for each of these sub-area x band cells:`,
    ...cells.map((c, i) => `${i + 1}. sub_area="${c.sub_area}" | band="${c.band}"${c.age_span ? ` (typically ${c.age_span})` : ''}`),
    '',
    `Return JSON in exactly this shape: ${shape}`,
    'Use the sub_area and band strings exactly as written above so they can be matched.',
  ].join('\n');

  const parsed = await ollamaJson(SYSTEM_PROMPT, user);
  const out = new Map();
  if (!parsed) return out;
  const list = Array.isArray(parsed) ? parsed : (parsed.statements || parsed.items || parsed.results || []);
  if (!Array.isArray(list)) return out;

  // Match loosely (case/whitespace) but only ever against cells we actually asked
  // for — a hallucinated sub-area or band is dropped rather than saved.
  const wanted = new Map(cells.map(c => [cellKey(c.sub_area, c.band), c]));
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const text = String(item.statement || item.text || item.statement_text || '').trim().replace(/\s+/g, ' ');
    const k = cellKey(item.sub_area || item.subArea || '', item.band || item.age_range || '');
    if (!wanted.has(k)) continue;
    if (text.length < 10 || text.length > 400) continue;
    if (!out.has(k)) out.set(k, text);
  }
  return out;
}

// POST /generate-area — draft one area. Body: {answers, area:{name,sub_areas[]}, bands:[{label,age_span}]}
// Returns only the cells the model actually filled, plus an explicit `missing` list.
router.post('/generate-area', async (req, res) => {
  const { answers, area, bands } = req.body || {};
  const areaName = area && String(area.name || '').trim();
  const subAreas = (area && Array.isArray(area.sub_areas) ? area.sub_areas : [])
    .map(s => String(s || '').trim()).filter(Boolean);
  const bandList = (Array.isArray(bands) ? bands : [])
    .map(b => ({ label: String((b && b.label) || '').trim(), age_span: String((b && b.age_span) || '').trim() }))
    .filter(b => b.label);

  if (!areaName)        return res.status(400).json({ error: 'area.name required' });
  if (!subAreas.length) return res.status(400).json({ error: 'area.sub_areas must have at least one entry' });
  if (!bandList.length) return res.status(400).json({ error: 'bands required' });

  const cells = [];
  subAreas.forEach(sa => bandList.forEach(b => cells.push({ sub_area: sa, band: b.label, age_span: b.age_span })));

  const answersText = describeAnswers(answers);
  const filled = new Map();
  const attempts = [];

  try {
    // Pass 1: the whole area. Pass 2: only the cells that came back missing.
    for (let pass = 1; pass <= 2; pass++) {
      const todo = cells.filter(c => !filled.has(cellKey(c.sub_area, c.band)));
      if (!todo.length) break;
      let got = new Map();
      let err = null;
      try {
        got = await generateCells(answersText, areaName, todo);
      } catch (e) {
        err = e.message;
      }
      attempts.push({ pass, requested: todo.length, returned: got.size, error: err });
      for (const [k, v] of got) if (!filled.has(k)) filled.set(k, v);
      if (err && pass === 1 && !got.size) continue; // one retry even on a hard failure
    }
  } catch (e) {
    return res.status(502).json({ error: `Generation failed: ${e.message}`, attempts });
  }

  const statements = [];
  const missing = [];
  cells.forEach(c => {
    const text = filled.get(cellKey(c.sub_area, c.band));
    if (text) {
      statements.push({ area: areaName, sub_area: c.sub_area, band: c.band, band_age_span: c.age_span, statement: text });
    } else {
      missing.push({ area: areaName, sub_area: c.sub_area, band: c.band, band_age_span: c.age_span });
    }
  });

  if (!statements.length) {
    return res.status(502).json({
      error: `The model returned nothing usable for "${areaName}". Check Ollama (see the AI status line) and try again.`,
      area: areaName, statements: [], missing, attempts, model: BUILDER_MODEL(),
    });
  }
  res.json({ area: areaName, statements, missing, attempts, model: BUILDER_MODEL(), cells: cells.length });
});

// ── Persistence ──────────────────────────────────────────────────────────────

function codeFor(areaIdx, subIdx, bandIdx, n) {
  return `A${areaIdx + 1}.S${subIdx + 1}.B${bandIdx + 1}.${n}`.slice(0, 50);
}

/**
 * Insert a whole draft. Codes are derived from position so they are unique by
 * construction (framework_statements' unique constraint can't help here — it
 * includes `aspect`, which we deliberately leave NULL).
 */
async function writeStatements(client, slug, statements, model) {
  const areaOrder = [], subOrder = new Map(), bandOrder = new Map();
  statements.forEach(s => {
    if (!areaOrder.includes(s.area)) areaOrder.push(s.area);
    const sk = `${s.area}||${s.sub_area}`;
    if (!subOrder.has(sk)) subOrder.set(sk, subOrder.size);
    if (!bandOrder.has(s.band)) bandOrder.set(s.band, bandOrder.size);
  });

  let ordinal = 0, written = 0;
  const seen = new Set();
  for (const s of statements) {
    const areaIdx = areaOrder.indexOf(s.area);
    const subIdx  = subOrder.get(`${s.area}||${s.sub_area}`);
    const bandIdx = bandOrder.get(s.band);
    ordinal += 1;
    let code = codeFor(areaIdx, subIdx, bandIdx, 1);
    let bump = 1;
    while (seen.has(code)) code = codeFor(areaIdx, subIdx, bandIdx, ++bump);
    seen.add(code);

    await client.query(
      `INSERT INTO framework_statements
         (framework, area, sub_area, aspect, age_range, statement_code, statement_text, ordinal, metadata)
       VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8)`,
      [
        slug,
        String(s.area).slice(0, 100),
        String(s.sub_area).slice(0, 120),
        String(s.band).slice(0, 50),
        code,
        String(s.statement).trim(),
        ordinal,
        JSON.stringify({
          band_age_span: s.band_age_span || null,
          band_index: bandIdx + 1,
          generated_by: s.source === 'manual' ? 'manual' : 'wizard',
          model: s.source === 'manual' ? null : (model || null),
          builder: 'b180',
        }),
      ]
    );
    written += 1;
  }
  return written;
}

/** Shared validation for save/update. Returns {statements} or {error}. */
function validateDraft(raw) {
  if (!Array.isArray(raw) || !raw.length) return { error: 'statements array required' };
  const clean = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const area = String(s.area || '').trim();
    const sub  = String(s.sub_area || '').trim();
    const band = String(s.band || s.age_range || '').trim();
    const text = String(s.statement || s.statement_text || '').trim();
    // Acceptance requires every saved row to carry area + sub_area + age_range +
    // statement_text, so an incomplete row is rejected rather than half-written.
    if (!area || !sub || !band || !text) continue;
    clean.push({ area, sub_area: sub, band, band_age_span: String(s.band_age_span || '').trim(), statement: text, source: s.source });
  }
  if (!clean.length) return { error: 'No complete statements supplied (each needs area, sub_area, band and text)' };
  return { statements: clean };
}

// POST /save — create a new framework from the reviewed draft.
router.post('/save', async (req, res) => {
  const { name, description, answers, statements, model } = req.body || {};
  const displayName = String(name || '').trim();
  if (!displayName) return res.status(400).json({ error: 'name required' });

  const slug = slugify(displayName);
  if (!slug) return res.status(400).json({ error: 'name must contain letters or numbers' });

  const v = validateDraft(statements);
  if (v.error) return res.status(400).json({ error: v.error });

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: clash } = await client.query(
      'SELECT 1 FROM framework_statements WHERE framework=$1 LIMIT 1', [slug]);
    if (clash.length) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `A framework named "${displayName}" already exists (${slug}). Rename it or edit the existing one.`, framework: slug });
    }
    const written = await writeStatements(client, slug, v.statements, model);
    await client.query(
      `INSERT INTO framework_meta (framework, display_name, description, created_by, is_custom, wizard_answers)
       VALUES ($1,$2,$3,$4,true,$5)
       ON CONFLICT (framework) DO UPDATE
         SET display_name=EXCLUDED.display_name, description=EXCLUDED.description,
             wizard_answers=EXCLUDED.wizard_answers, updated_at=now()`,
      [slug, displayName, String(description || '').trim() || null, req.user.id, JSON.stringify(answers || {})]
    );
    await client.query('COMMIT');
    res.status(201).json({ ok: true, framework: slug, display_name: displayName, statements: written });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[framework-builder] save:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// PUT /:slug — replace an existing wizard framework's statements + answers.
router.put('/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!isBuilderSlug(slug)) return res.status(400).json({ error: 'Only wizard-built frameworks can be edited here' });
  const { name, description, answers, statements, model } = req.body || {};
  const v = validateDraft(statements);
  if (v.error) return res.status(400).json({ error: v.error });

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // framework_tracker/next_steps/sen_targets FK onto these ids — refuse rather
    // than orphan real assessment data.
    const { rows: used } = await client.query(
      `SELECT COUNT(*)::int AS n FROM framework_tracker ft
        JOIN framework_statements fs ON fs.id = ft.statement_id
        WHERE fs.framework = $1`, [slug]);
    if (used[0] && used[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `This framework already has ${used[0].n} assessment(s) recorded against it, so its statements can't be replaced wholesale.` });
    }
    await client.query('DELETE FROM framework_statements WHERE framework=$1', [slug]);
    const written = await writeStatements(client, slug, v.statements, model);
    await client.query(
      `INSERT INTO framework_meta (framework, display_name, description, created_by, is_custom, wizard_answers)
       VALUES ($1,$2,$3,$4,true,$5)
       ON CONFLICT (framework) DO UPDATE
         SET display_name=COALESCE(EXCLUDED.display_name, framework_meta.display_name),
             description=EXCLUDED.description, wizard_answers=EXCLUDED.wizard_answers, updated_at=now()`,
      [slug, String(name || slug).trim(), String(description || '').trim() || null, req.user.id, JSON.stringify(answers || {})]
    );
    await client.query('COMMIT');
    res.json({ ok: true, framework: slug, statements: written });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[framework-builder] update:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// GET / — wizard-built frameworks, newest first, with live statement counts.
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT m.framework, m.display_name, m.description, m.created_at, m.updated_at, m.is_custom,
             COALESCE(c.n, 0)::int AS statement_count,
             (SELECT value FROM settings WHERE key='default_framework') = m.framework AS is_default
      FROM framework_meta m
      LEFT JOIN (SELECT framework, COUNT(*) AS n FROM framework_statements GROUP BY framework) c
             ON c.framework = m.framework
      ORDER BY m.updated_at DESC`);
    res.json({ frameworks: rows });
  } catch (e) {
    console.error('[framework-builder] list:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /:slug — meta + wizard_answers (pre-fill) + the saved statements.
router.get('/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const db = getPool();
    const [{ rows: meta }, { rows: stmts }] = await Promise.all([
      db.query('SELECT * FROM framework_meta WHERE framework=$1', [slug]),
      db.query(`SELECT id, area, sub_area, age_range AS band, statement_code, statement_text, ordinal, metadata
                  FROM framework_statements WHERE framework=$1 ORDER BY ordinal, id`, [slug]),
    ]);
    if (!meta.length && !stmts.length) return res.status(404).json({ error: 'Framework not found' });
    res.json({
      framework: slug,
      meta: meta[0] || null,
      answers: (meta[0] && meta[0].wizard_answers) || null,
      statements: stmts.map(s => ({
        id: s.id, area: s.area, sub_area: s.sub_area, band: s.band,
        band_age_span: (s.metadata && s.metadata.band_age_span) || '',
        statement: s.statement_text, statement_code: s.statement_code, ordinal: s.ordinal,
      })),
    });
  } catch (e) {
    console.error('[framework-builder] get:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// DELETE /:slug — wizard frameworks only, and only while unused.
router.delete('/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!isBuilderSlug(slug)) return res.status(400).json({ error: 'Only wizard-built frameworks can be deleted here' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows: used } = await client.query(
      `SELECT COUNT(*)::int AS n FROM framework_tracker ft
        JOIN framework_statements fs ON fs.id = ft.statement_id
        WHERE fs.framework = $1`, [slug]);
    if (used[0] && used[0].n > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `In use — ${used[0].n} assessment(s) reference this framework.` });
    }
    const r = await client.query('DELETE FROM framework_statements WHERE framework=$1', [slug]);
    await client.query('DELETE FROM framework_meta WHERE framework=$1', [slug]);
    await client.query('COMMIT');
    res.json({ ok: true, framework: slug, deleted: r.rowCount });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[framework-builder] delete:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
