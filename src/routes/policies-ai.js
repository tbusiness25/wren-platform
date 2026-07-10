// ─────────────────────────────────────────────────────────────────────────────
// Policies engine — AI clarify + rewrite, per-tenant policy source.  (2026-07-07)
//
// The AI operates ONLY on:
//   • the tenant's OWN policy text (this schema's `policies` table), and
//   • PUBLIC statutory reference (public.gov_corpus_documents — DfE/Ofsted, OGL).
// It NEVER reproduces a third-party vendor's copyrighted template as shipped
// content, and rewrites are always returned as DRAFTS for a manager to review —
// nothing here auto-publishes (publish stays the manual, versioned action in
// the existing policies module). Same review gate as report translation.
//
//   GET  /api/policies-ai/source           — current policy source choice
//   POST /api/policies-ai/source           — set it (manager)
//   POST /api/policies-ai/:id/clarify      — answer a question about a policy
//   POST /api/policies-ai/:id/rewrite      — draft a rewrite (manager; not saved)
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

const MGR = new Set(['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager']);
const manager = (req, res, next) => MGR.has(req.user?.role) ? next() : res.status(403).json({ error: 'Manager access required' });

const OLLAMA = process.env.OLLAMA_HOST || process.env.OLLAMA_URL || 'http://localhost:11434';
const MODEL = process.env.POLICIES_AI_MODEL || process.env.OLLAMA_HELPER_MODEL || 'qwen3.6:35b-a3b';
const SOURCES = ['own', 'eya', 'dfe_ofsted'];

async function ask(system, user, { json = false, timeout = 120000 } = {}) {
  const resp = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL, stream: false, think: false,
      ...(json ? { format: 'json' } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) throw new Error(`Ollama ${resp.status}`);
  const d = await resp.json();
  return (d.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Pull a little relevant statutory reference (public, OGL) to ground answers.
async function statutoryContext(db, topic) {
  try {
    const { rows } = await db.query(
      `SELECT title, category, source_url,
              left(coalesce((SELECT string_agg(text, ' ') FROM public.gov_corpus_chunks c
                             WHERE c.document_id = d.id), ''), 1500) AS excerpt
       FROM public.gov_corpus_documents d
       WHERE d.is_current = true
         AND (d.title ILIKE '%'||$1||'%' OR d.category ILIKE '%'||$1||'%'
              OR $1 ILIKE '%'||split_part(d.title,' ',1)||'%')
       LIMIT 2`, [topic.slice(0, 40)]);
    return rows;
  } catch { return []; }
}

async function getPolicy(db, id) {
  const { rows } = await db.query('SELECT id, title, content, category, version FROM policies WHERE id=$1', [id]);
  return rows[0];
}

// ── source choice (per tenant, stored in settings) ───────────────────────────
router.get('/source', async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT value FROM settings WHERE key='policy_source'`);
    res.json({ source: rows[0]?.value || 'own', options: SOURCES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/source', manager, async (req, res) => {
  const src = String(req.body?.source || '');
  if (!SOURCES.includes(src)) return res.status(400).json({ error: 'invalid source' });
  try {
    await getPool().query(
      `INSERT INTO settings (key, value) VALUES ('policy_source', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [src]);
    res.json({ ok: true, source: src });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── clarify: answer a question grounded in THIS policy + statutory text ───────
router.post('/:id/clarify', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  try {
    const db = getPool();
    const p = await getPolicy(db, req.params.id);
    if (!p) return res.status(404).json({ error: 'Policy not found' });
    const stat = await statutoryContext(db, p.title);
    const statText = stat.map(s => `[${s.title}] ${s.excerpt}`).join('\n\n') || '(no statutory excerpt matched)';
    const sys = `You are a UK early-years policy assistant for a nursery manager. Answer ONLY from the setting's own policy text and the statutory reference provided. If the policy is silent or unclear on the question, say so plainly and note what the statutory guidance expects. Never invent policy content. Be concise and practical. Cite "your policy" vs "[statutory doc name]".`;
    const usr = `SETTING'S OWN POLICY — "${p.title}":\n${(p.content || '').slice(0, 8000)}\n\nSTATUTORY REFERENCE:\n${statText}\n\nQUESTION: ${question}`;
    const answer = await ask(sys, usr);
    res.json({ answer, policy: { id: p.id, title: p.title }, statutory_used: stat.map(s => s.title) });
  } catch (e) { console.error('[policies-ai clarify]', e.message); res.status(500).json({ error: 'AI unavailable' }); }
});

// ── rewrite: draft an improved version (manager; returned, NOT saved) ─────────
router.post('/:id/rewrite', manager, async (req, res) => {
  const instruction = String(req.body?.instruction || 'Modernise and clarify while keeping our setting-specific details.').trim();
  try {
    const db = getPool();
    const p = await getPolicy(db, req.params.id);
    if (!p) return res.status(404).json({ error: 'Policy not found' });
    const stat = await statutoryContext(db, p.title);
    const statText = stat.map(s => `[${s.title}] ${s.excerpt}`).join('\n\n') || '';
    const sys = `You are drafting a rewrite of a UK nursery's OWN policy for a MANAGER TO REVIEW — this is a draft, never final. Keep every setting-specific detail (names, room names, procedures, contact points) intact. Align with the statutory reference where relevant. Do NOT copy any third-party template verbatim; write in the setting's own plain voice. Return the rewritten policy body only, as clean text — no preamble, no commentary.`;
    const usr = `CURRENT POLICY — "${p.title}":\n${(p.content || '').slice(0, 8000)}\n\nSTATUTORY REFERENCE:\n${statText}\n\nMANAGER'S INSTRUCTION: ${instruction}`;
    const draft = await ask(sys, usr, { timeout: 150000 });
    res.json({
      draft, policy: { id: p.id, title: p.title, current_version: p.version },
      note: 'DRAFT for manager review — not saved. Review, edit, then publish via the policies module (which versions + re-collects acknowledgements).',
      statutory_used: stat.map(s => s.title),
    });
  } catch (e) { console.error('[policies-ai rewrite]', e.message); res.status(500).json({ error: 'AI unavailable' }); }
});

module.exports = router;
