'use strict';
// Visual timetables + now/next boards for SEN/autism support (TEACCH-style).
// Symbols are Mulberry (CC BY-SA) — vendored under public/symbols/mulberry/, license-safe
// to ship. Index at public/symbols/mulberry-index.json (label + keyword + alias search).
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

router.use(authenticate);

// ── Mulberry symbol index (loaded once, searched in-process) ─────────────────
let _idx = null;
function symbolIndex() {
  if (_idx) return _idx;
  try {
    const p = path.join(__dirname, '..', '..', 'public', 'symbols', 'mulberry-index.json');
    _idx = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { _idx = { base: '/symbols/mulberry/', symbols: [], aliases: {} }; }
  return _idx;
}

// GET /symbols?q=lunch — search Mulberry symbols (alias hits first, then label, then keyword)
router.get('/symbols', (req, res) => {
  const idx = symbolIndex();
  const q = String(req.query.q || '').trim().toLowerCase();
  if (!q) return res.json({ base: idx.base, results: [] });
  const out = [];
  const seen = new Set();
  const push = (f, l) => { if (f && !seen.has(f)) { seen.add(f); out.push({ f, l, url: idx.base + f }); } };
  // 1. curated alias (British nursery routine terms)
  for (const [term, file] of Object.entries(idx.aliases || {})) {
    if (term.includes(q)) { const s = (idx.symbols || []).find(x => x.f === file); push(file, s ? s.l : term); }
  }
  // 2. label starts-with, 3. label contains, 4. keyword contains
  const starts = [], contains = [], kw = [];
  for (const s of (idx.symbols || [])) {
    const l = (s.l || '').toLowerCase();
    if (l === q || l.startsWith(q + ' ') || l.startsWith(q)) starts.push(s);
    else if (l.includes(q)) contains.push(s);
    else if ((s.w || []).some(w => w.includes(q))) kw.push(s);
  }
  [...starts, ...contains, ...kw].slice(0, 60).forEach(s => push(s.f, s.l));
  res.json({ base: idx.base, results: out.slice(0, 60) });
});

// GET / — list schedules (optional ?child_id=, ?kind=)
router.get('/', async (req, res) => {
  const { child_id, kind } = req.query;
  const db = getPool();
  let sql = `
    SELECT vs.*, c.first_name || ' ' || c.last_name AS child_name,
           s.first_name || ' ' || s.last_name AS created_by_name
    FROM visual_schedules vs
    LEFT JOIN children c ON c.id = vs.child_id
    LEFT JOIN staff s ON s.id = vs.created_by
    WHERE 1=1`;
  const params = [];
  if (child_id) { params.push(child_id); sql += ` AND vs.child_id = $${params.length}`; }
  if (kind)     { params.push(kind);     sql += ` AND vs.kind = $${params.length}`; }
  sql += ' ORDER BY vs.updated_at DESC LIMIT 200';
  try { const { rows } = await db.query(sql, params); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT vs.*, c.first_name || ' ' || c.last_name AS child_name
      FROM visual_schedules vs LEFT JOIN children c ON c.id = vs.child_id
      WHERE vs.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function normItems(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 40).map(it => ({
    symbol: String(it.symbol || '').slice(0, 120),
    label:  String(it.label || '').slice(0, 80),
    time:   it.time ? String(it.time).slice(0, 10) : null
  })).filter(it => it.symbol || it.label);
}

// POST / — create
router.post('/', async (req, res) => {
  const { child_id, title, kind, items } = req.body;
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title required' });
  const k = (kind === 'now_next') ? 'now_next' : 'timetable';
  try {
    const { rows } = await getPool().query(`
      INSERT INTO visual_schedules (child_id, title, kind, items, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), NOW()) RETURNING *`,
      [child_id || null, String(title).trim(), k, JSON.stringify(normItems(items)), req.user.id]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id — update
router.put('/:id', async (req, res) => {
  const { child_id, title, kind, items } = req.body;
  const k = (kind === 'now_next') ? 'now_next' : (kind === 'timetable' ? 'timetable' : null);
  try {
    const { rows } = await getPool().query(`
      UPDATE visual_schedules SET
        child_id = $1,
        title    = COALESCE($2, title),
        kind     = COALESCE($3, kind),
        items    = COALESCE($4::jsonb, items),
        updated_at = NOW()
      WHERE id = $5 RETURNING *`,
      [child_id || null, title ? String(title).trim() : null, k,
       items ? JSON.stringify(normItems(items)) : null, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id
router.delete('/:id', async (req, res) => {
  try {
    const { rowCount } = await getPool().query('DELETE FROM visual_schedules WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
