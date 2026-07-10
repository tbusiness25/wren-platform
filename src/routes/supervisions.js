const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ── Recording constants ────────────────────────────────────────────────────────
const OLLAMA_HELPER_URL   = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
// Ascent (your-ollama-host) model. qwen3.6:27b is NOT loaded on the Ascent — use 35b-a3b.
const OLLAMA_HELPER_MODEL = process.env.OLLAMA_HELPER_MODEL || 'qwen3.6:35b-a3b';
// Data root: inside the container this is /app/data (host bind /app/data/ladn).
// Fall back to the host path for any out-of-container use.
const DATA_ROOT  = fs.existsSync('/app/data') ? '/app/data' : '/app/data/ladn';
const AUDIO_BASE = path.join(DATA_ROOT, 'supervision-audio');

// Chunk upload storage
const chunkStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(AUDIO_BASE, req.params.sid);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const n = req.body.chunk_index != null
      ? String(req.body.chunk_index).padStart(4, '0')
      : Date.now();
    cb(null, `chunk-${n}.webm`);
  }
});
const chunkUpload = multer({ storage: chunkStorage, limits: { fileSize: 10 * 1024 * 1024 } });

// Keyword → question ordinal mapping (from seeded templates)
const QUESTION_KEYWORDS = {
  1:  ['since last', 'last time', 'last supervision', 'how have you been'],
  2:  ['wellbeing', 'stress', 'workload', 'home life', 'tired', 'overwhelmed'],
  3:  ['key children', 'key child', 'observation', 'parent comms', 'worry', 'worrying about'],
  4:  ['safeguarding', 'safeguard', 'concern', 'disclosure', 'worried about', 'cpoms'],
  5:  ['cpd', 'training', 'course', 'learning', 'qualification'],
  6:  ['goals', 'targets from last', 'progress on', 'blockers'],
  7:  ['team', 'room dynamics', 'colleagues', 'working with', 'team dynamic'],
  8:  ['equipment', 'resources', 'environment', 'supplies needed'],
  9:  ['parents', 'parent relationship', 'family', 'difficult parent'],
  10: ['personal development', 'want to learn', 'career', 'aspiration'],
  11: ['health', 'wellbeing check', 'feeling physically', 'sick', 'medical'],
  12: ['goals for next', 'next period', 'next steps', 'objectives'],
  13: ['i have noticed', 'i noticed', 'i have observed', 'my feedback'],
  14: ['action', 'action items', 'agreed', 'action points', 'will do'],
};

function detectTopics(transcript) {
  if (!transcript) return [];
  const lower = transcript.toLowerCase();
  const detected = [];
  for (const [qId, kws] of Object.entries(QUESTION_KEYWORDS)) {
    if (kws.some(kw => lower.includes(kw))) detected.push(Number(qId));
  }
  return detected;
}

async function transcribeChunk(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const blob = new Blob([buffer], { type: 'audio/webm' });
    const form = new FormData();
    form.append('audio_file', blob, path.basename(filePath));
    const resp = await fetch('http://wren-whisper:9876/asr?output=txt&task=transcribe', {
      method: 'POST', body: form, signal: AbortSignal.timeout(60000)
    });
    if (!resp.ok) return null;
    return (await resp.text()).trim();
  } catch { return null; }
}

async function generateStructuredNotes(transcript) {
  const schema = `{
  "q1_lastsupervision": "...",
  "q2_wellbeing": "...",
  "q3_keychildren": "...",
  "q4_safeguarding": "...",
  "q5_cpd": "...",
  "q6_goals_prev": "...",
  "q7_team": "...",
  "q8_resources": "...",
  "q9_parents": "...",
  "q10_development": "...",
  "q11_health": "...",
  "q12_goals_next": "...",
  "q13_manager_feedback": "...",
  "q14_action_items": [{"item": "...", "owner": "...", "due_date": "YYYY-MM-DD or null"}],
  "overall_summary": "3-4 sentences",
  "sentiment_flags": ["concerning patterns if any"]
}`;
  const prompt = `Summarise this nursery staff supervision recording. Extract structured notes per question. Use direct quotes where clear. Write "Not covered" if a topic was absent.

Transcript:
${transcript}

Return ONLY valid JSON matching this schema exactly:
${schema}`;
  try {
    const resp = await fetch(`${OLLAMA_HELPER_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: OLLAMA_HELPER_MODEL, prompt, stream: false, think: false, options: { temperature: 0.3 } }),
      signal: AbortSignal.timeout(180000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = (data.response || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch { return null; }
}

// ── Targeted RAG: summarise transcript against the KNOWN question set ───────────
// Loads the standard question set and builds a prompt that explicitly lists every
// question, so the model summarises every supervision into the SAME structure.
async function loadQuestionSet() {
  const db = getPool();
  const { rows } = await db.query(
    `SELECT ordinal, question_key, category, question_text, is_required
     FROM supervision_question_templates
     WHERE template_name='standard' AND is_active=true
     ORDER BY ordinal`
  );
  return rows;
}

async function generateTargetedSummary(transcript, questions) {
  if (!transcript || !questions || !questions.length) return null;

  const questionBlock = questions
    .map(q => `- ${q.question_key} (${q.category}): ${q.question_text}`)
    .join('\n');

  // Build the exact JSON shape the model must return, keyed by question_key.
  const shapeLines = questions.map(q => {
    if (q.question_key === 'wellbeing')
      return `  "wellbeing": { "summary": "...", "rag": "green|amber|red" }`;
    if (q.question_key === 'safeguarding')
      return `  "safeguarding": { "summary": "...", "flag": true|false }`;
    if (q.question_key === 'targets_new')
      return `  "targets_new": { "summary": "...", "targets": ["SMART target 1", "..."] }`;
    return `  "${q.question_key}": { "summary": "..." }`;
  });
  const shape = `{\n${shapeLines.join(',\n')},\n  "overall_summary": "3-4 sentence plain summary",\n  "concerns": ["any concerning patterns"]\n}`;

  const prompt = `You are a UK nursery manager's supervision assistant. A 1:1 staff supervision has just been recorded and transcribed.

You ALREADY KNOW the fixed supervision agenda. These are the questions that were meant to be covered:
${questionBlock}

Read the transcript below and, for EACH question key, write a concise factual summary of what was said about that topic. If a topic was not discussed, set its summary to "Not covered". Quote or paraphrase the practitioner where it adds clarity. Do not invent content.

Special fields:
- "wellbeing.rag": rate the practitioner's wellbeing as "green" (fine), "amber" (some strain), or "red" (struggling / needs support). If not discussed, use "green".
- "safeguarding.flag": set true ONLY if any safeguarding or child-protection concern or disclosure was raised; otherwise false.
- "targets_new.targets": an array of the SMART targets agreed for next period (empty array if none).

Transcript:
${transcript}

Return ONLY valid JSON matching this exact schema (same keys, every key present):
${shape}`;

  try {
    const resp = await fetch(`${OLLAMA_HELPER_URL}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // NOTE: do NOT set format:'json' — qwen3.6:35b-a3b is a thinking model and returns
      // an empty `response` field when JSON-constrained. We extract the JSON object instead.
      body: JSON.stringify({ model: OLLAMA_HELPER_MODEL, prompt, stream: false, think: false, options: { temperature: 0.2 } }),
      signal: AbortSignal.timeout(240000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const raw = (data.response || '').trim();
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch { return null; }
}

// Persist a targeted-summary object into supervision_structured (one row per question_key)
async function persistStructured(supervisionId, staffId, questions, summaryObj) {
  if (!summaryObj) return;
  const db = getPool();
  for (const q of questions) {
    const entry = summaryObj[q.question_key];
    if (entry === undefined) continue;
    let summaryText = null, rag = null, flag = false;
    if (typeof entry === 'string') {
      summaryText = entry;
    } else if (entry && typeof entry === 'object') {
      summaryText = entry.summary != null ? String(entry.summary) : null;
      if (entry.rag) rag = String(entry.rag).toLowerCase();
      if (entry.flag === true) flag = true;
      if (Array.isArray(entry.targets) && entry.targets.length) {
        summaryText = (summaryText ? summaryText + ' ' : '') + 'Targets: ' + entry.targets.join('; ');
      }
    }
    await db.query(`
      INSERT INTO supervision_structured
        (supervision_id, staff_id, question_key, category, summary_text, rag, flag, ordinal)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (supervision_id, question_key) DO UPDATE SET
        summary_text=EXCLUDED.summary_text, rag=EXCLUDED.rag,
        flag=EXCLUDED.flag, category=EXCLUDED.category, ordinal=EXCLUDED.ordinal
    `, [supervisionId, staffId, q.question_key, q.category, summaryText, rag, flag, q.ordinal]);
  }
}

// Audio retention cleanup — runs daily at 03:00 via setInterval
function scheduleAudioCleanup() {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const RETAIN_DAYS = 30;

  function cleanup() {
    const cutoff = Date.now() - RETAIN_DAYS * MS_PER_DAY;
    if (!fs.existsSync(AUDIO_BASE)) return;
    for (const sid of fs.readdirSync(AUDIO_BASE)) {
      const dir = path.join(AUDIO_BASE, sid);
      if (!fs.statSync(dir).isDirectory()) continue;
      let allOld = true;
      for (const file of fs.readdirSync(dir)) {
        const fp = path.join(dir, file);
        if (fs.statSync(fp).mtimeMs > cutoff) { allOld = false; break; }
      }
      if (allOld) {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`[supervision-audio] deleted old session dir: ${sid}`);
      }
    }
  }

  // Run at next 03:00, then daily
  const now = new Date();
  const next3am = new Date(now);
  next3am.setHours(3, 0, 0, 0);
  if (next3am <= now) next3am.setDate(next3am.getDate() + 1);
  const msUntil3am = next3am - now;
  setTimeout(() => { cleanup(); setInterval(cleanup, MS_PER_DAY); }, msUntil3am);
}
scheduleAudioCleanup();

// Whisper transcription helper (wren-whisper on port 9876, Node 20 native FormData)
async function transcribeAudio(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const blob = new Blob([buffer], { type: 'audio/webm' });
    const form = new FormData();
    form.append('audio_file', blob, path.basename(filePath));
    const resp = await fetch('http://wren-whisper:9876/asr?output=txt&task=transcribe', {
      method: 'POST', body: form,
      signal: AbortSignal.timeout(120000)
    });
    if (!resp.ok) return null;
    return (await resp.text()).trim();
  } catch { return null; }
}

// qwen3.5:27b on z420 for AI summary
async function generateAISummary(transcript, supervisionType) {
  try {
    const prompt = `You are a nursery management assistant. A staff supervision has just been conducted (type: ${supervisionType}).

Here is the transcript:
${transcript}

Extract a structured summary with these EXACT JSON fields:
{
  "key_discussion_points": ["point 1", "point 2"],
  "action_items": [{"description": "...", "due_date": "YYYY-MM-DD or null", "assigned_to": "staff name or null"}],
  "concerns_raised": ["concern 1"],
  "wellbeing_notes": "brief wellbeing observation",
  "follow_ups": ["follow-up 1"]
}
Return ONLY valid JSON, no commentary.`;

    const resp = await fetch(`${process.env.OLLAMA_HOST||'http://localhost:11434'}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3.5:27b', prompt, stream: false, think: false, options: { temperature: 0.3 } }),
      signal: AbortSignal.timeout(120000)
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const text = (data.response || '').trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch { return null; }
}

// Storage for audio uploads
const audioStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = `/app/data/supervisions/${req.params.id}`;
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, 'audio.webm')
});
const upload = multer({ storage: audioStorage, limits: { fileSize: 200 * 1024 * 1024 } });

// Public: pre-supervision form (token-gated, no JWT)
router.post('/form/submit', async (req, res) => {
  const { token, responses } = req.body;
  if (!token || !responses) return res.status(400).json({ error: 'token and responses required' });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const { supervision_id, staff_id } = payload;
    const db = getPool();
    const stars = Object.values(responses).filter(v => typeof v === 'number');
    const score = stars.length ? stars.reduce((a,b)=>a+b,0)/stars.length : null;
    const { rows } = await db.query(`
      UPDATE supervisions SET pre_questionnaire_responses=$1, wellbeing_score=$2
      WHERE id=$3 AND staff_id=$4 RETURNING id
    `, [JSON.stringify(responses), score, supervision_id, staff_id]);
    if (!rows.length) return res.status(404).json({ error: 'Supervision not found' });
    console.log(`Pre-supervision form submitted for supervision ${supervision_id}`);
    res.json({ ok: true, message: 'Thank you! Your responses have been saved.' });
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

// Public: get form by token
router.get('/form/:token', async (req, res) => {
  try {
    const payload = jwt.verify(req.params.token, process.env.JWT_SECRET);
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.scheduled_date, s.type, st.first_name, st.last_name, sv.pre_questionnaire_responses
      FROM supervisions s
      JOIN staff st ON st.id = s.staff_id
      LEFT JOIN staff sv ON sv.id = s.supervisor_id
      WHERE s.id=$1`, [payload.supervision_id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ...rows[0], token: req.params.token });
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
});

router.use(authenticate);

// GET /compliance — staff overdue, missing signoffs, outstanding actions
router.get('/compliance', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({error:'Forbidden'});
  try {
    const db = getPool();
    const [overdueRes, signoffRes, actionsRes] = await Promise.all([
      // Staff overdue for supervision (monthly = >35 days since last)
      db.query(`
        SELECT s.id, s.first_name, s.last_name, s.role,
          MAX(sv.conducted_date) as last_supervision,
          EXTRACT(DAY FROM NOW() - MAX(sv.conducted_date)) as days_since
        FROM staff s
        LEFT JOIN supervisions sv ON sv.staff_id=s.id AND sv.status='completed'
        WHERE s.is_active=true AND s.role != 'admin'
        GROUP BY s.id, s.first_name, s.last_name, s.role
        HAVING MAX(sv.conducted_date) IS NULL OR MAX(sv.conducted_date) < NOW() - INTERVAL '35 days'
        ORDER BY days_since DESC NULLS FIRST
      `),
      // Missing signoffs
      db.query(`
        SELECT sv.id, sv.scheduled_date, sv.type,
          st.first_name || ' ' || st.last_name as staff_name,
          sv.staff_signoff, sv.supervisor_signoff
        FROM supervisions sv
        JOIN staff st ON st.id=sv.staff_id
        WHERE sv.status='completed' AND (sv.staff_signoff=false OR sv.supervisor_signoff=false)
        ORDER BY sv.conducted_date DESC
      `),
      // Outstanding action items past due
      db.query(`
        SELECT sv.id as supervision_id, sv.scheduled_date,
          st.first_name || ' ' || st.last_name as staff_name,
          ai.value->>'description' as action_desc,
          ai.value->>'due_date' as due_date,
          ai.value->>'status' as status
        FROM supervisions sv
        JOIN staff st ON st.id=sv.staff_id,
        LATERAL jsonb_array_elements(COALESCE(sv.action_items,'[]')) ai
        WHERE (ai.value->>'status' IS NULL OR ai.value->>'status' NOT IN ('completed','cancelled'))
          AND (ai.value->>'due_date') IS NOT NULL
          AND (ai.value->>'due_date')::date < NOW()::date
        ORDER BY (ai.value->>'due_date')::date ASC
      `)
    ]);
    res.json({
      overdue_supervisions: overdueRes.rows,
      missing_signoffs: signoffRes.rows,
      overdue_actions: actionsRes.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET / — list all supervisions
router.get('/', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  try {
    const db = getPool();
    let q = `
      SELECT sv.*, st.first_name || ' ' || st.last_name as staff_name,
        s2.first_name || ' ' || s2.last_name as supervisor_name,
        (SELECT COUNT(*) FROM supervision_targets t WHERE t.supervision_id=sv.id AND t.achieved=false) as outstanding_targets
      FROM supervisions sv
      JOIN staff st ON st.id = sv.staff_id
      LEFT JOIN staff s2 ON s2.id = sv.supervisor_id
    `;
    if (!isManager) q += ` WHERE sv.staff_id=$1`;
    q += ' ORDER BY sv.scheduled_date DESC LIMIT 200';
    const params = isManager ? [] : [req.user.id];
    const { rows } = await db.query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /staff-list — all staff with supervision status
router.get('/staff-list', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({error:'Forbidden'});
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.role,
        (SELECT MAX(conducted_date) FROM supervisions WHERE staff_id=s.id AND status='completed') as last_supervision,
        (SELECT MIN(scheduled_date) FROM supervisions WHERE staff_id=s.id AND status='scheduled') as next_supervision,
        (SELECT COUNT(*) FROM supervision_targets WHERE staff_id=s.id AND achieved=false) as outstanding_targets,
        (SELECT id FROM supervisions WHERE staff_id=s.id AND status='scheduled' ORDER BY scheduled_date LIMIT 1) as next_supervision_id,
        EXTRACT(DAY FROM NOW() - (SELECT MAX(conducted_date) FROM supervisions WHERE staff_id=s.id AND status='completed')) as days_since_last
      FROM staff s
      WHERE s.is_active=true
      ORDER BY s.last_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /question-templates — question list for UI (must be before /:id)
router.get('/question-templates', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, ordinal, question_key, category, question_text, is_required, keywords
       FROM supervision_question_templates
       WHERE template_name='standard' AND is_active=true
       ORDER BY ordinal`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /overview — all-staff structured matrix (registered before /:id so it is not shadowed)
router.get('/overview', (req, res) => overviewHandler(req, res));

// GET /:id
router.get('/:id', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sv.*, st.first_name || ' ' || st.last_name as staff_name,
        s2.first_name || ' ' || s2.last_name as supervisor_name,
        st.role as staff_role
      FROM supervisions sv
      JOIN staff st ON st.id = sv.staff_id
      LEFT JOIN staff s2 ON s2.id = sv.supervisor_id
      WHERE sv.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // IDOR guard: non-managers can only view their own supervision
    if (!isManager && Number(rows[0].staff_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden — not your supervision' });
    }
    const { rows: targets } = await db.query(
      'SELECT * FROM supervision_targets WHERE supervision_id=$1 ORDER BY due_date', [req.params.id]
    );
    res.json({ ...rows[0], targets });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST / — schedule supervision
router.post('/', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({error:'Forbidden'});
  const { staff_id, scheduled_date, type, agenda_items } = req.body;
  if (!staff_id || !scheduled_date) return res.status(400).json({ error: 'staff_id and scheduled_date required' });
  try {
    const db = getPool();
    const token = jwt.sign({ supervision_id: 0, staff_id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const { rows } = await db.query(`
      INSERT INTO supervisions (staff_id, scheduled_date, supervisor_id, status, form_token, type, agenda_items)
      VALUES ($1,$2,$3,'scheduled',$4,$5,$6) RETURNING *
    `, [staff_id, scheduled_date, req.user.id, token, type||'monthly_1to1', JSON.stringify(agenda_items||[])]);
    const sid = rows[0].id;
    const realToken = jwt.sign({ supervision_id: sid, staff_id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    await db.query('UPDATE supervisions SET form_token=$1 WHERE id=$2', [realToken, sid]);
    rows[0].form_token = realToken;
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — update supervision (IDOR guard: manager or staff for own wellbeing fields)
router.put('/:id', async (req, res) => {
  const isManager = ['manager','deputy_manager'].includes(req.user.role);
  try {
    const db = getPool();
    // IDOR guard: check who owns this supervision
    const { rows: svRows } = await db.query('SELECT staff_id FROM supervisions WHERE id=$1', [req.params.id]);
    if (!svRows.length) return res.status(404).json({ error: 'Not found' });
    if (!isManager && Number(svRows[0].staff_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: 'Forbidden — not your supervision' });
    }
    // Staff may only update wellbeing/notes fields; managers get full update
    if (!isManager) {
      const allowedStaff = ['wellbeing_score'];
      const disallowed = Object.keys(req.body).filter(f => !allowedStaff.includes(f));
      if (disallowed.length) {
        return res.status(403).json({ error: `Forbidden — staff can only update: ${allowedStaff.join(', ')}` });
      }
    }

    const fields = ['manager_notes','discussion_notes','transcript','ai_summary','wellbeing_rag',
      'wellbeing_rag_reason','agreed_targets','manager_actions','action_items','agenda_items',
      'status','type','conducted_date','next_supervision_date','wellbeing_score','audio_url',
      'audio_recording_path','staff_signature_at','manager_signature_at',
      'staff_signoff','supervisor_signoff','ai_summary_generated_at'];
    const jsonFields = ['agreed_targets','manager_actions','action_items','agenda_items'];
    const updates=[], vals=[];
    fields.forEach(f=>{
      if(req.body[f]!==undefined){
        vals.push(jsonFields.includes(f)?JSON.stringify(req.body[f]):req.body[f]);
        updates.push(`${f}=$${vals.length}`);
      }
    });
    if(!updates.length) return res.status(400).json({error:'No fields'});
    updates.push(`updated_at=NOW()`);
    vals.push(req.params.id);
    const { rows } = await db.query(
      `UPDATE supervisions SET ${updates.join(',')} WHERE id=$${vals.length} RETURNING *`, vals
    );
    // Sync agreed_targets to supervision_targets table
    if (req.body.agreed_targets && Array.isArray(req.body.agreed_targets)) {
      const staffRow = await db.query('SELECT staff_id FROM supervisions WHERE id=$1', [req.params.id]);
      const staffId = staffRow.rows[0]?.staff_id;
      for (const t of req.body.agreed_targets) {
        if (t.text) {
          await db.query(`
            INSERT INTO supervision_targets (staff_id, supervision_id, target_text, area, due_date)
            VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING
          `, [staffId, req.params.id, t.text, t.area||null,
              t.deadline_weeks ? new Date(Date.now() + t.deadline_weeks*7*24*3600000).toISOString().split('T')[0] : null]);
        }
      }
    }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/audio-upload — upload WebM audio file
router.post('/:id/audio-upload', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });
  const filePath = req.file.path;
  const relPath = `supervisions/${req.params.id}/audio.webm`;
  try {
    const db = getPool();
    await db.query('UPDATE supervisions SET audio_recording_path=$1 WHERE id=$2', [relPath, req.params.id]);
    res.json({ ok: true, path: relPath, queued_transcription: true });
    // Transcribe async (non-blocking)
    transcribeAudio(filePath).then(async transcript => {
      if (!transcript) return;
      await db.query('UPDATE supervisions SET transcript=$1, updated_at=NOW() WHERE id=$2', [transcript, req.params.id]);
      // Get supervision type for AI summary
      const { rows } = await db.query('SELECT type FROM supervisions WHERE id=$1', [req.params.id]);
      const svType = rows[0]?.type || 'monthly_1to1';
      const summary = await generateAISummary(transcript, svType);
      if (summary) {
        await db.query(`UPDATE supervisions SET
          ai_summary=$1, ai_summary_generated_at=NOW(), updated_at=NOW()
          WHERE id=$2`, [JSON.stringify(summary), req.params.id]);
      }
    }).catch(()=>{});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/audio — legacy: accept URL reference
router.post('/:id/audio', async (req, res) => {
  const { audio_url } = req.body;
  if (!audio_url) return res.status(400).json({ error: 'audio_url required' });
  try {
    const db = getPool();
    await db.query('UPDATE supervisions SET audio_url=$1 WHERE id=$2', [audio_url, req.params.id]);
    res.json({ ok: true, audio_url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/ai-summary — trigger AI summary from existing transcript
router.post('/:id/ai-summary', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role)) return res.status(403).json({error:'Forbidden'});
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT transcript, discussion_notes, type FROM supervisions WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const text = rows[0].transcript || rows[0].discussion_notes;
    if (!text) return res.status(400).json({ error: 'No transcript or discussion notes to summarise' });
    const summary = await generateAISummary(text, rows[0].type || 'monthly_1to1');
    if (!summary) return res.status(503).json({ error: 'AI service unavailable' });
    await db.query('UPDATE supervisions SET ai_summary=$1, ai_summary_generated_at=NOW() WHERE id=$2',
      [JSON.stringify(summary), req.params.id]);
    res.json({ ok: true, summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/signoff — PIN-confirmed signoff
router.post('/:id/signoff', async (req, res) => {
  const { role, pin } = req.body; // role: 'staff' or 'supervisor'
  if (!['staff','supervisor'].includes(role)) return res.status(400).json({ error: 'role must be staff or supervisor' });
  try {
    const db = getPool();
    // Verify PIN
    const { rows: pinRows } = await db.query(
      'SELECT id FROM staff WHERE id=$1 AND pin_hash=crypt($2, pin_hash)',
      [req.user.id, pin]
    );
    if (!pinRows.length) return res.status(401).json({ error: 'Incorrect PIN' });
    const field = role === 'staff' ? 'staff_signoff' : 'supervisor_signoff';
    const sigField = role === 'staff' ? 'staff_signature_at' : 'manager_signature_at';
    await db.query(
      `UPDATE supervisions SET ${field}=true, ${sigField}=NOW(), updated_at=NOW() WHERE id=$1`,
      [req.params.id]
    );
    res.json({ ok: true, signed: role });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/audio — serve audio file
router.get('/:id/audio', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query('SELECT audio_recording_path FROM supervisions WHERE id=$1', [req.params.id]);
    if (!rows.length || !rows[0].audio_recording_path) return res.status(404).json({ error: 'No audio' });
    const fullPath = `/app/data/${rows[0].audio_recording_path}`;
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    res.setHeader('Content-Type', 'audio/webm');
    fs.createReadStream(fullPath).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /targets/:targetId — update a target (IDOR guard)
router.put('/targets/:targetId', async (req, res) => {
  const { achieved, achieved_date, progress_notes } = req.body;
  try {
    const db = getPool();
    // IDOR guard: verify target's supervision belongs to this user or user is manager
    const isManager = ['manager','deputy_manager'].includes(req.user.role);
    if (!isManager) {
      const { rows: tRows } = await db.query(
        `SELECT sv.staff_id FROM supervision_targets t JOIN supervisions sv ON sv.id=t.supervision_id WHERE t.id=$1`,
        [req.params.targetId]
      );
      if (!tRows.length) return res.status(404).json({ error: 'Target not found' });
      if (Number(tRows[0].staff_id) !== Number(req.user.id)) {
        return res.status(403).json({ error: 'Forbidden — not your target' });
      }
    }
    const { rows } = await db.query(`
      UPDATE supervision_targets
      SET achieved=COALESCE($1,achieved), achieved_date=COALESCE($2,achieved_date),
          progress_notes=COALESCE($3,progress_notes)
      WHERE id=$4 RETURNING *
    `, [achieved, achieved_date||null, progress_notes, req.params.targetId]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Voice Recording Routes ─────────────────────────────────────────────────────

// POST /recording/start — create draft supervision session for voice recording
router.post('/recording/start', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager role required' });
  const { staff_id } = req.body;
  if (!staff_id) return res.status(400).json({ error: 'staff_id required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO supervisions
        (staff_id, scheduled_date, supervisor_id, status, type, mode, created_at, updated_at)
      VALUES ($1, NOW()::date, $2, 'draft', 'monthly_1to1', 'voice', NOW(), NOW())
      RETURNING id
    `, [staff_id, req.user.id]);
    const sid = rows[0].id;
    fs.mkdirSync(path.join(AUDIO_BASE, String(sid)), { recursive: true });
    res.json({ session_id: sid, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /recording/:sid/audio-chunk — receive 20s webm chunk, transcribe, detect topics
router.post('/recording/:sid/audio-chunk',
  chunkUpload.single('chunk'),
  async (req, res) => {
    if (!['manager','deputy_manager'].includes(req.user.role))
      return res.status(403).json({ error: 'Manager role required' });
    if (!req.file) return res.status(400).json({ error: 'No chunk uploaded' });

    const sid = req.params.sid;
    const db = getPool();

    // Verify session belongs to this manager
    const { rows: svRows } = await db.query(
      'SELECT id, transcript FROM supervisions WHERE id=$1 AND supervisor_id=$2',
      [sid, req.user.id]
    );
    if (!svRows.length) return res.status(403).json({ error: 'Session not found or not yours' });

    // Transcribe this chunk
    const chunkTranscript = await transcribeChunk(req.file.path);

    // Append to running transcript
    const prevTranscript = svRows[0].transcript || '';
    const fullTranscript = prevTranscript
      ? prevTranscript + '\n' + (chunkTranscript || '')
      : (chunkTranscript || '');

    // Count total duration from chunk files
    const sessionDir = path.join(AUDIO_BASE, String(sid));
    const chunks = fs.existsSync(sessionDir)
      ? fs.readdirSync(sessionDir).filter(f => f.endsWith('.webm'))
      : [];
    const totalDurationSeconds = chunks.length * 20;

    await db.query(`
      UPDATE supervisions
      SET transcript=$1, duration_seconds=$2, updated_at=NOW()
      WHERE id=$3
    `, [fullTranscript || null, totalDurationSeconds, sid]);

    res.json({
      partial_transcript: chunkTranscript || '',
      total_transcript: fullTranscript,
      total_duration_seconds: totalDurationSeconds,
      detected_topics: detectTopics(fullTranscript),
      chunk_index: chunks.length,
    });
  }
);

// POST /recording/:sid/finalize — re-transcribe all, generate AI notes, set finalized
router.post('/recording/:sid/finalize', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager role required' });

  const sid = req.params.sid;
  const { manually_ticked_question_ids = [], custom_questions = [], action_items_text = '' } = req.body;
  const db = getPool();

  const { rows: svRows } = await db.query(
    'SELECT id, transcript, supervisor_id FROM supervisions WHERE id=$1',
    [sid]
  );
  if (!svRows.length) return res.status(404).json({ error: 'Session not found' });
  if (svRows[0].supervisor_id !== req.user.id && req.user.role !== 'manager')
    return res.status(403).json({ error: 'Not your session' });

  // Concatenate all chunks for full re-transcription
  const sessionDir = path.join(AUDIO_BASE, String(sid));
  let fullTranscript = svRows[0].transcript || '';

  if (fs.existsSync(sessionDir)) {
    const chunks = fs.readdirSync(sessionDir)
      .filter(f => f.endsWith('.webm'))
      .sort();

    // For full re-transcription, transcribe each chunk fresh and join
    if (chunks.length > 0) {
      const parts = await Promise.all(
        chunks.map(c => transcribeChunk(path.join(sessionDir, c)))
      );
      const joined = parts.filter(Boolean).join('\n');
      if (joined) fullTranscript = joined;
    }
  }

  // Append action_items_text hint if provided
  const transcriptForAI = action_items_text
    ? fullTranscript + '\n[Action items noted: ' + action_items_text + ']'
    : fullTranscript;

  // Generate structured notes via Ollama
  let notesJson = await generateStructuredNotes(transcriptForAI);
  if (!notesJson) {
    notesJson = {
      overall_summary: 'AI generation unavailable. Transcript saved.',
      q14_action_items: [],
      sentiment_flags: [],
    };
  }

  // Merge manual custom questions into notes
  if (custom_questions.length) {
    notesJson.custom_questions = custom_questions;
  }
  notesJson.manually_covered_questions = manually_ticked_question_ids;

  const audioPath = `ladn/supervision-audio/${sid}`;
  const chunks2 = fs.existsSync(sessionDir)
    ? fs.readdirSync(sessionDir).filter(f => f.endsWith('.webm'))
    : [];

  await db.query(`
    UPDATE supervisions
    SET status='finalized', finalized_at=NOW(), transcript=$1,
        notes_json=$2, audio_path=$3, duration_seconds=$4,
        updated_at=NOW()
    WHERE id=$5
  `, [fullTranscript, JSON.stringify(notesJson), audioPath, chunks2.length * 20, sid]);

  res.json({ ok: true, supervision_id: sid, notes_json: notesJson });
});

// GET /:id/recording — structured recording data for review
router.get('/:id/recording', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager role required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sv.transcript, sv.notes_json, sv.audio_path,
             sv.duration_seconds, sv.finalized_at, sv.mode,
             st.first_name || ' ' || st.last_name as staff_name
      FROM supervisions sv
      JOIN staff st ON st.id = sv.staff_id
      WHERE sv.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const row = rows[0];
    const audioDir = row.audio_path ? path.join('/app/data', row.audio_path) : null;
    const audioAvailable = audioDir && fs.existsSync(audioDir) &&
      fs.readdirSync(audioDir).some(f => f.endsWith('.webm'));
    res.json({ ...row, audio_available: audioAvailable });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/recording-notes — manager edits AI notes and confirms
router.put('/:id/recording-notes', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager role required' });
  const { notes_json, status } = req.body;
  if (!notes_json) return res.status(400).json({ error: 'notes_json required' });
  const allowedStatus = ['confirmed','draft','finalized'];
  const newStatus = allowedStatus.includes(status) ? status : 'confirmed';
  try {
    const db = getPool();
    await db.query(`
      UPDATE supervisions
      SET notes_json=$1, status=$2, updated_at=NOW()
      WHERE id=$3
    `, [JSON.stringify(notes_json), newStatus, req.params.id]);
    res.json({ ok: true, status: newStatus });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Manager single-blob record + targeted-RAG summary ──────────────────────────
// POST /record — manager records a whole supervision in one go.
// multipart: audio (blob) + staff_id. Runs whisper → targeted summary → structured store.
const recordStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(AUDIO_BASE, 'rec-' + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    req._recDir = dir;
    cb(null, dir);
  },
  filename: (req, file, cb) => cb(null, 'audio.webm')
});
const recordUpload = multer({ storage: recordStorage, limits: { fileSize: 200 * 1024 * 1024 } });

router.post('/record', recordUpload.single('audio'), async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager role required' });
  const staffId = parseInt(req.body.staff_id, 10);
  if (!staffId) return res.status(400).json({ error: 'staff_id required' });
  if (!req.file) return res.status(400).json({ error: 'No audio file' });

  const db = getPool();
  try {
    // Create supervision record
    const { rows } = await db.query(`
      INSERT INTO supervisions
        (staff_id, scheduled_date, conducted_date, supervisor_id, status, type, mode, created_at, updated_at)
      VALUES ($1, NOW()::date, NOW()::date, $2, 'draft', 'monthly_1to1', 'voice', NOW(), NOW())
      RETURNING id
    `, [staffId, req.user.id]);
    const sid = rows[0].id;
    const relPath = path.relative(DATA_ROOT, req.file.path);
    await db.query('UPDATE supervisions SET audio_recording_path=$1 WHERE id=$2', [relPath, sid]);

    // Respond immediately; process async
    res.status(202).json({ ok: true, supervision_id: sid, status: 'processing' });

    (async () => {
      const transcript = await transcribeAudio(req.file.path);
      if (!transcript) {
        await db.query("UPDATE supervisions SET status='draft', updated_at=NOW() WHERE id=$1", [sid]);
        return;
      }
      await db.query('UPDATE supervisions SET transcript=$1, updated_at=NOW() WHERE id=$2', [transcript, sid]);

      const questions = await loadQuestionSet();
      const structured = await generateTargetedSummary(transcript, questions);
      if (structured) {
        await persistStructured(sid, staffId, questions, structured);
        // Pull a wellbeing RAG + safeguarding flag onto the supervision row for quick filters
        const wb = structured.wellbeing && structured.wellbeing.rag ? String(structured.wellbeing.rag).toLowerCase() : null;
        const sgFlag = !!(structured.safeguarding && structured.safeguarding.flag);
        await db.query(`
          UPDATE supervisions
          SET notes_json=$1, ai_summary=$2, ai_summary_generated_at=NOW(),
              wellbeing_rag=COALESCE($3, wellbeing_rag),
              status='finalized', finalized_at=NOW(), updated_at=NOW()
          WHERE id=$4
        `, [JSON.stringify({ ...structured, safeguarding_flag: sgFlag }),
            structured.overall_summary || null, wb, sid]);
      } else {
        await db.query("UPDATE supervisions SET status='draft', updated_at=NOW() WHERE id=$1", [sid]);
      }
    })().catch(e => console.error('[supervision/record] async error', e.message));

  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// GET /:id/structured — structured topic rows for one supervision (must be after /:id routes? it's distinct path)
router.get('/:id/structured', async (req, res) => {
  if (!['manager','deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager role required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT question_key, category, summary_text, rag, flag, ordinal
       FROM supervision_structured WHERE supervision_id=$1 ORDER BY ordinal`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /overview — all-staff structured matrix (one row per staff member)
// NOTE: registered via explicit router below so it is not shadowed by GET /:id.
async function overviewHandler(req, res) {
  if (!['manager','deputy_manager'].includes(req.user.role))
    return res.status(403).json({ error: 'Manager role required' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      WITH last_sup AS (
        SELECT DISTINCT ON (staff_id) staff_id, id AS supervision_id, conducted_date, finalized_at, created_at
        FROM supervisions
        WHERE status IN ('finalized','completed','confirmed')
        ORDER BY staff_id, COALESCE(conducted_date, finalized_at::date, created_at::date) DESC, id DESC
      )
      SELECT
        s.id AS staff_id,
        s.first_name || ' ' || s.last_name AS staff_name,
        s.role,
        ls.supervision_id,
        COALESCE(ls.conducted_date, ls.finalized_at::date, ls.created_at::date) AS last_supervision,
        (SELECT summary_text FROM supervision_structured st WHERE st.supervision_id=ls.supervision_id AND st.question_key='wellbeing')      AS wellbeing,
        (SELECT rag          FROM supervision_structured st WHERE st.supervision_id=ls.supervision_id AND st.question_key='wellbeing')      AS wellbeing_rag,
        (SELECT summary_text FROM supervision_structured st WHERE st.supervision_id=ls.supervision_id AND st.question_key='key_children')   AS key_children,
        (SELECT summary_text FROM supervision_structured st WHERE st.supervision_id=ls.supervision_id AND st.question_key='parents')        AS parents,
        (SELECT summary_text FROM supervision_structured st WHERE st.supervision_id=ls.supervision_id AND st.question_key='sen')            AS sen,
        (SELECT summary_text FROM supervision_structured st WHERE st.supervision_id=ls.supervision_id AND st.question_key='workload')       AS workload,
        (SELECT summary_text FROM supervision_structured st WHERE st.supervision_id=ls.supervision_id AND st.question_key='cpd_review')     AS cpd,
        (SELECT summary_text FROM supervision_structured st WHERE st.supervision_id=ls.supervision_id AND st.question_key='targets_new')    AS smart_targets,
        COALESCE((SELECT bool_or(flag) FROM supervision_structured st WHERE st.supervision_id=ls.supervision_id AND st.question_key='safeguarding'), false) AS safeguarding_flag,
        (SELECT COUNT(*) FROM supervision_targets t WHERE t.staff_id=s.id AND t.achieved=false) AS outstanding_targets,
        EXTRACT(DAY FROM NOW() - COALESCE(ls.conducted_date, ls.finalized_at::date, ls.created_at::date)::timestamp) AS days_since
      FROM staff s
      LEFT JOIN last_sup ls ON ls.staff_id = s.id
      WHERE s.is_active=true
      ORDER BY safeguarding_flag DESC, days_since DESC NULLS FIRST, s.last_name
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
}

module.exports = router;
module.exports.overviewHandler = overviewHandler;
