const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// searxng runs on the docker bridge network published at host :8082 — not
// resolvable by container name from wren-net, so go via the host.
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://100.126.215.7:8082';
const DRIVE_MIRROR_DIR = process.env.DRIVE_MIRROR_DIR || '/home/toby/drive-mirror';

// Rate limit: 30 requests per minute per staff
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Rate limit exceeded' },
  standardHeaders: true,
  legacyHeaders: false,
});

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.ASSISTANT_MODEL || 'qwen3.6:35b-a3b';
const RESEARCH_ALLOWLIST = (process.env.RESEARCH_DOMAIN_ALLOWLIST || 'twinkl.co.uk,gov.uk,foundationyears.org.uk,early-education.org.uk,nhs.uk').split(',').map(d=>d.trim());

// Helper to call Ollama with system prompt and user message
async function callOllama(messages, systemPrompt) {
  const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: false,
      think: false,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw new Error(`Ollama error ${response.status}`);
  const data = await response.json();
  return (data.message?.content || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// POST /api/staff-research/chat
router.post('/chat', authenticate, limiter, async (req, res) => {
  const staffId = req.user.id; // auth middleware sets req.user
  const { message, session_id } = req.body;
  if (!message) return res.status(400).json({ error: 'Missing message' });

  try {
    // 1. Query SearXNG (internal container name wren-searxng)
    const searxRes = await fetch(`${SEARXNG_URL}/search?q=${encodeURIComponent(message)}&format=json&categories=general&language=en`, {
      timeout: 15000,
    }).catch(() => ({ ok: false }));
    const searxData = await searxRes.ok ? await searxRes.json() : { results: [] };
    const topResults = (searxData.results || []).slice(0, 6).map(r => ({ title: r.title, url: r.url, snippet: r.content }));

    // 2. Search local Twinkl drive mirror (simple filename match)
    const driveMatches = [];
    // naive search: look for message words in filenames (case-insensitive)
    const words = message.toLowerCase().split(/\s+/).filter(w=>w.length>2);
    const { readdir } = fs.promises;
    async function walk(dir) {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (words.some(w=>e.name.toLowerCase().includes(w))) {
          driveMatches.push({ title: e.name, path: full, url: `/api/staff-research/fetch?path=${encodeURIComponent(full)}` });
        }
      }
    }
    // drive-mirror is a HOST path — only searchable if bind-mounted into the container
    if (fs.existsSync(DRIVE_MIRROR_DIR)) await walk(DRIVE_MIRROR_DIR);

    // 3. Build system prompt for Ollama
    const systemPrompt = `You are a helpful research assistant for Little Angels Day Nursery staff. Use the provided SearXNG results and any matching Twinkl files to answer the user's question. Cite sources as [SearXNG] or [Twinkl] with title and URL. If you cannot find an answer, say so honestly.`;
    const userContent = `Question: ${message}\n\nSearXNG results:\n${JSON.stringify(topResults, null, 2)}\n\nTwinkl matches:\n${JSON.stringify(driveMatches, null, 2)}`;
    const reply = await callOllama([{ role: 'user', content: userContent }], systemPrompt);

    // 4. Log to DB
    const pool = getPool();
    await pool.query('INSERT INTO staff_research_log (staff_id, query, urls, fetched_files) VALUES ($1, $2, $3, $4)', [staffId, message, topResults.map(r=>r.url), driveMatches.map(m=>m.path)]);

    res.json({ reply, sources: { searx: topResults, twinkl: driveMatches } });
  } catch (err) {
    console.error('staff-research chat error', err);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/staff-research/fetch
router.post('/fetch', authenticate, limiter, async (req, res) => {
  const { url } = req.body; // allow either url or path param
  const staffId = req.user.id;
  if (!url) return res.status(400).json({ error: 'Missing url' });
  try {
    // Determine if it's a remote URL or local path
    let fetchedPath;
    if (url.startsWith('http')) {
      const hostname = new URL(url).hostname;
      if (!RESEARCH_ALLOWLIST.some(d => hostname.endsWith(d))) {
        return res.status(403).json({ error: 'Domain not allowed' });
      }
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Fetch failed');
      const buffer = await resp.buffer();
      const fname = path.basename(new URL(url).pathname) || 'download';
      const outDir = '/home/toby/uploads/research-fetches';
      await require('fs').promises.mkdir(outDir, { recursive: true });
      fetchedPath = path.join(outDir, `${Date.now()}_${fname}`);
      await require('fs').promises.writeFile(fetchedPath, buffer);
    } else {
      // treat as local path inside drive-mirror
      const resolved = path.resolve(DRIVE_MIRROR_DIR, url);
      if (!resolved.startsWith(DRIVE_MIRROR_DIR)) return res.status(400).json({ error: 'Invalid path' });
      const stat = await require('fs').promises.stat(resolved);
      if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
      fetchedPath = resolved;
    }
    // Log fetch
    const pool = getPool();
    await pool.query('INSERT INTO staff_research_log (staff_id, query, urls, fetched_files) VALUES ($1, $2, $3, $4)', [staffId, 'fetch', [url], [fetchedPath]]);
    // Return downloadable link (served via static express folder elsewhere)
    const downloadUrl = `/uploads/research-fetches/${path.basename(fetchedPath)}`;
    res.json({ downloadUrl });
  } catch (e) {
    console.error('fetch error', e);
    res.status(500).json({ error: 'Fetch failed' });
  }
});

// GET /api/staff-research/log (manager only)
router.get('/log', authenticate, async (req, res) => {
  if (req.user.role !== 'manager') return res.status(403).json({ error: 'Forbidden' });
  const pool = getPool();
  const { rows } = await pool.query('SELECT * FROM staff_research_log ORDER BY created_at DESC LIMIT 100');
  res.json(rows);
});

module.exports = router;
