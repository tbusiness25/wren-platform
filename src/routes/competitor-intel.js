'use strict';
// Competitor intelligence (Wren Intelligence submodule).
// PUBLIC-DATA ONLY: competitor websites, Ofsted, and public search results via the
// local SearXNG. Local Ollama (Ascent) extracts structured fields + scores sentiment.
// It NEVER contacts a competitor pretending to be a parent — pricing gaps are surfaced
// for Toby to act on himself.

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://100.126.215.7:8082';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://100.109.248.102:11434';
// gpt-oss:120b returns clean structured JSON fast; reasoning models (qwen3.6) burn
// their token budget on hidden thinking and return empty. Keep think:false too.
const MODEL = process.env.COMPETITOR_MODEL || 'gpt-oss:120b';
const OUR_TERMS = ['"Little Angels Day Nursery" Ealing', 'littleangelsealing reviews'];

router.use(authenticate);
router.use((req, res, next) => {
  if (!['manager', 'deputy_manager'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
});

// ── helpers ───────────────────────────────────────────────────────────────────
async function searxng(query, { timeout = 12000 } = {}) {
  try {
    const r = await fetch(`${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`,
      { signal: AbortSignal.timeout(timeout) });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.results || []).map(x => ({ title: x.title, url: x.url, snippet: x.content || '', engine: x.engine }));
  } catch { return []; }
}

async function ollamaJSON(prompt, { timeout = 45000 } = {}) {
  try {
    const r = await fetch(`${OLLAMA_HOST}/api/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false, options: { temperature: 0.1, num_predict: 700 } }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const m = (d.response || '').match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    return m ? JSON.parse(m[0]) : null;
  } catch { return null; }
}

async function fetchPageText(url, { timeout = 12000 } = {}) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WrenIntel/1.0)' } });
    if (!r.ok) return '';
    const html = await r.text();
    return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
  } catch { return ''; }
}

// ── OUR nursery stats (all real DB data) ─────────────────────────────────────
router.get('/us', async (req, res) => {
  try {
    const db = getPool();
    const rooms = (await db.query(
      `SELECT name, capacity, monthly_fee_pence, min_age_months, max_age_months FROM rooms ORDER BY id`)).rows;
    const staff = (await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE qualification_level >= 3)::int AS level3,
             COUNT(*) FILTER (WHERE qualification_level >= 2)::int AS level2plus
      FROM staff WHERE is_active=true AND COALESCE(role,'') <> 'parent'`)).rows[0];
    const pfa = (await db.query(`
      SELECT COUNT(DISTINCT staff_id)::int AS n FROM mandatory_training
      WHERE training_type ILIKE '%first_aid%'
        AND (expiry_date >= CURRENT_DATE OR (expiry_date IS NULL AND completed_date >= CURRENT_DATE - INTERVAL '3 years'))`)).rows[0];
    res.json({
      name: 'Little Angels Day Nursery',
      rooms: rooms.map(r => ({
        name: r.name, capacity: r.capacity,
        monthly_fee: r.monthly_fee_pence != null ? '£' + (r.monthly_fee_pence / 100).toFixed(0) : null,
        age_range: `${r.min_age_months}–${r.max_age_months}m`,
      })),
      staff: { total: staff.total, level3: staff.level3, level2plus: staff.level2plus, first_aiders: pfa.n },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── competitors CRUD ──────────────────────────────────────────────────────────
router.get('/competitors', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT c.*, (SELECT count(*) FROM competitor_intel ci WHERE ci.competitor_id=c.id)::int AS intel_count
      FROM competitors c WHERE active=true ORDER BY name`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/competitors', express.json(), async (req, res) => {
  const { name, postcode, website, ofsted_urn, distance_note, notes } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await getPool().query(
      `INSERT INTO competitors (name, postcode, website, ofsted_urn, distance_note, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, postcode || null, website || null, ofsted_urn || null, distance_note || null, notes || null, req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/competitors/:id', express.json(), async (req, res) => {
  const { name, postcode, website, ofsted_urn, distance_note, notes } = req.body || {};
  try {
    const { rows } = await getPool().query(
      `UPDATE competitors SET name=COALESCE($2,name), postcode=$3, website=$4, ofsted_urn=$5,
         distance_note=$6, notes=$7, updated_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id, name || null, postcode || null, website || null, ofsted_urn || null, distance_note || null, notes || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/competitors/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(`UPDATE competitors SET active=false WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/competitors/:id/intel', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT * FROM competitor_intel WHERE competitor_id=$1 ORDER BY kind, captured_at DESC`, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── refresh a competitor: website extraction + Ofsted lookup ──────────────────
router.post('/competitors/:id/refresh', async (req, res) => {
  try {
    const db = getPool();
    const { rows: cr } = await db.query(`SELECT * FROM competitors WHERE id=$1`, [req.params.id]);
    if (!cr.length) return res.status(404).json({ error: 'Not found' });
    const c = cr[0];
    const added = [];

    // 1) Website: fetch + LLM-extract fees/ages/rooms/consumables.
    if (c.website) {
      const text = await fetchPageText(c.website);
      if (text) {
        const ext = await ollamaJSON(
          `From this UK day-nursery website text, extract what you can as JSON with keys: ` +
          `"fees" (array of short strings like "Full day £75"), "age_range" (string), ` +
          `"rooms" (array of room names), "consumables_included" (string: what's included e.g. meals/nappies). ` +
          `Only include facts stated in the text. If unknown, use null/empty.\n\nTEXT:\n${text}`);
        if (ext) {
          const push = (kind, label, value) => value && added.push({ kind, label, value, source_url: c.website, confidence: 'low' });
          const feeStr = f => (f && typeof f === 'object')
            ? [f.type || f.label || f.name, f.price || f.amount || f.value].filter(Boolean).join(' ')
            : String(f);
          (ext.fees || []).slice(0, 8).forEach(f => push('fee', 'fee', feeStr(f)));
          push('age', 'age range', ext.age_range);
          (ext.rooms || []).slice(0, 8).forEach(r => push('rooms', 'room', String(r)));
          push('consumables', 'consumables', ext.consumables_included);
        }
      }
    }

    // 2) Ofsted rating via public search.
    const oq = await searxng(`${c.name} ${c.postcode || ''} Ofsted rating early years`);
    const ofstedHit = oq.find(r => /ofsted|reports\.ofsted/i.test(r.url + r.title));
    if (ofstedHit) {
      const grade = (ofstedHit.snippet.match(/\b(Outstanding|Good|Requires improvement|Inadequate)\b/i) || [])[0];
      if (grade) added.push({ kind: 'ofsted', label: 'Ofsted', value: grade, source_url: ofstedHit.url, confidence: 'medium' });
    }

    // Store (replace this competitor's intel with the fresh snapshot).
    await db.query(`DELETE FROM competitor_intel WHERE competitor_id=$1`, [c.id]);
    for (const a of added) {
      await db.query(
        `INSERT INTO competitor_intel (competitor_id, kind, label, value, source_url, confidence)
         VALUES ($1,$2,$3,$4,$5,$6)`, [c.id, a.kind, a.label, a.value, a.source_url, a.confidence]);
    }
    await db.query(`UPDATE competitors SET updated_at=now() WHERE id=$1`, [c.id]);
    res.json({ ok: true, added: added.length, intel: added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── social mentions of US ─────────────────────────────────────────────────────
router.get('/mentions', async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT * FROM social_mentions ORDER BY captured_at DESC LIMIT 100`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/mentions/refresh', async (req, res) => {
  try {
    const db = getPool();
    let found = 0, added = 0;
    for (const term of OUR_TERMS) {
      const results = await searxng(term);
      for (const r of results.slice(0, 10)) {
        found++;
        if (!r.url) continue;
        // sentiment via local model (best-effort)
        let sentiment = 'unknown';
        const s = await ollamaJSON(
          `Classify the sentiment of this search result about a nursery as JSON {"sentiment":"positive|neutral|negative"}.\nTITLE: ${r.title}\nTEXT: ${r.snippet}`,
          { timeout: 20000 });
        if (s && s.sentiment) sentiment = s.sentiment;
        const ins = await db.query(
          `INSERT INTO social_mentions (source, url, title, snippet, sentiment, matched_term)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (url) DO UPDATE SET snippet=EXCLUDED.snippet, sentiment=EXCLUDED.sentiment, captured_at=now()
           RETURNING (xmax=0) AS inserted`,
          [r.engine || 'web', r.url, r.title || '', r.snippet || '', sentiment, term]);
        if (ins.rows[0]?.inserted) added++;
      }
    }
    res.json({ ok: true, searched: OUR_TERMS.length, found, new: added });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
