'use strict';

const http  = require('http');
const https = require('https');

const OLLAMA_BASE  = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = 'qwen2.5-coder:27b';
const TIMEOUT_MS   = 120_000;

const VALID_TYPES = new Set([
  'teacher_unavailable', 'teacher_no_back_to_back',
  'subject_prefer_early', 'subject_prefer_late',
  'parallel_block', 'room_locked', 'min_days_between',
  'pair_lock', 'lunch_protected',
]);

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildSystem(ctx) {
  const teacherLines = (ctx.teachers || [])
    .map(t => `  ${t.name}`)
    .join('\n') || '  (none defined)';

  const subjectLines = (ctx.subjects || [])
    .map(s => `  ${s.name} (code: ${s.code || s.name})`)
    .join('\n') || '  (none defined)';

  const years = (ctx.years || []).join(', ') || '7, 8, 9, 10, 11';

  return `You are a school timetable constraint extractor. Read the text and extract scheduling constraints.
Return ONLY valid JSON — no markdown fences, no explanation, nothing else.

SCHOOL CONTEXT (use these exact names — do not invent names):
Teachers:
${teacherLines}

Subjects:
${subjectLines}

Year groups: ${years}
Days: 1=Mon  2=Tue  3=Wed  4=Thu  5=Fri
Periods per day: 1 (morning) through 6 (last afternoon). Afternoon = periods 4-6.

OUTPUT FORMAT — return exactly this structure:
{"constraints":[{"type":"...","params":{...},"confidence":0.0,"sourceText":"..."}]}

CONSTRAINT TYPES AND PARAMS:

teacher_unavailable — teacher blocked from a day or specific periods
  {"teacher_name":"Mrs Patel","day":3,"periods":[4,5,6]}
  Omit "periods" for full-day block.

teacher_no_back_to_back — avoid consecutive-period lessons for a teacher
  {"teacher_name":"Mr Thompson"}

subject_prefer_early — schedule subject in morning (periods 1-3)
  {"subject_code":"MA","year_groups":[7,8]}

subject_prefer_late — schedule subject in afternoon (periods 4-6)
  {"subject_code":"PE","year_groups":[10,11]}

parallel_block — listed year-groups run same-subject activities at the same time (option blocks, set blocks)
  {"label":"Year 11 maths sets","year_groups":[11],"subject_code":"MA"}

room_locked — subject must always use a specific room
  {"subject_name":"Chemistry","room_name":"Lab 1"}

min_days_between — minimum days between consecutive lessons of a subject
  {"subject_code":"PE","min_days":2}

pair_lock — two lessons of a subject must fall on the same day (double-period equivalent)
  {"subject_code":"Science","year_group":9}

lunch_protected — no teaching in the lunch window
  {"start_period":4,"end_period":4}

CONFIDENCE:
1.0  = teacher/subject name is in the school context AND constraint is explicit and unambiguous
0.85-0.99 = name matches, slight interpretation needed
0.70-0.84 = reasonable interpretation, minor ambiguity
0.40-0.69 = name NOT in school context (possible hallucination) OR meaning unclear
<0.40 = off-topic input or cannot extract any constraint

If no constraints found, return exactly: {"constraints":[]}`;
}

// ── Ollama HTTP call ──────────────────────────────────────────────────────────

function ollamaGenerate(systemPrompt, userPrompt) {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${OLLAMA_BASE}/api/generate`);
    const payload = JSON.stringify({
      model:   OLLAMA_MODEL,
      system:  systemPrompt,
      prompt:  userPrompt,
      stream:  false,
      options: { temperature: 0.05, num_predict: 1024, top_p: 0.9 },
    });

    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400)
            return reject(new Error(json.error || `Ollama HTTP ${res.statusCode}`));
          resolve(json.response || '');
        } catch {
          reject(new Error('Invalid JSON from Ollama'));
        }
      });
    });

    req.on('error', err => reject(new Error('Qwen/Ollama unreachable: ' + err.message)));
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Qwen timeout (${TIMEOUT_MS / 1000}s)`));
    });

    req.write(payload);
    req.end();
  });
}

// ── JSON extraction + validation ──────────────────────────────────────────────

function extractJson(text) {
  const trimmed = (text || '').trim();
  try { return JSON.parse(trimmed); } catch {}

  // Strip markdown fences
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch {} }

  // Grab outermost {...} block
  const obj = trimmed.match(/\{[\s\S]*\}/);
  if (obj) { try { return JSON.parse(obj[0]); } catch {} }

  return null;
}

function sanitise(constraints) {
  if (!Array.isArray(constraints)) return [];
  return constraints
    .filter(c => c && typeof c === 'object' && VALID_TYPES.has(c.type))
    .map(c => ({
      type:       c.type,
      params:     (c.params && typeof c.params === 'object') ? c.params : {},
      confidence: (typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1)
                    ? +c.confidence.toFixed(2)
                    : 0.5,
      sourceText: typeof c.sourceText === 'string' ? c.sourceText.slice(0, 500) : '',
    }));
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Parse free-text scheduling constraints using Qwen on Z420.
 *
 * @param {{ text: string, schoolContext: { teachers, subjects, years } }} opts
 * @returns {{ constraints: Array, raw: string }}
 * @throws  on Ollama connectivity failure
 */
async function parseConstraints({ text, schoolContext = {} }) {
  const system = buildSystem(schoolContext);
  const user   = `Extract scheduling constraints from this text:\n\n${text}`;

  const raw = await ollamaGenerate(system, user);

  let parsed = extractJson(raw);

  // One retry if the response wasn't valid JSON
  if (!parsed || !Array.isArray(parsed.constraints)) {
    const retryUser = `Your response was not valid JSON. Return ONLY the JSON object, nothing else.\n\nOriginal request: ${user}`;
    try {
      const raw2 = await ollamaGenerate(system, retryUser);
      parsed = extractJson(raw2);
    } catch { /* swallow retry errors — fall through to empty result */ }
  }

  const constraints = sanitise((parsed || {}).constraints || []);
  return { constraints, raw };
}

module.exports = { parseConstraints };
