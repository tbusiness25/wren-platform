'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b351 — Appearance: a person's own palette, and the setting's default for new sign-ins.
//
//   GET    /api/appearance           { staffId, mine, default }      any signed-in member of staff
//   PUT    /api/appearance           save mine                        refused (422) below WCAG AA
//   DELETE /api/appearance           back to the Wren palette
//   PUT    /api/appearance/default   the setting's default            manager / deputy only, same gate
//   DELETE /api/appearance/default
//
// Per person, not per setting: it is their eyes. Stored in the existing ladn.user_preferences
// (staff_id, preference_key='appearance'); the setting's default is ladn.settings 'appearance_default'.
// Parents are not staff and have no row — the parents app keeps its palette on the device.
//
// THE GATE IS HERE AS WELL AS IN THE BROWSER. The editor checks contrast so a person can see why;
// this file checks it so an API call cannot skip the editor. What is checked is exactly what the
// browser will paint: the base palette read from public/css/wren-tokens.css (the ONLY definition of
// a palette — parsed here, not copied) with the saved inline overrides laid over it, through the same
// public/js/wren-contrast.js the browser uses. Every colour is validated as a colour before it can
// reach a style attribute, and only whitelisted token names are accepted.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const C = require('../../public/js/wren-contrast.js');

const TOKENS = path.join(__dirname, '../../public/css/wren-tokens.css');
const PREF_KEY = 'appearance';
const DEFAULT_KEY = 'appearance_default';
const FAMILIES = { wren: { dark: 'dark', light: 'light' }, contrast: { dark: 'contrast-dark', light: 'contrast-light' } };
const MODES = ['auto', 'light', 'dark'];

// the tokens a person may override (ov) and the tokens boot may apply (inline = ov + derived inks)
const EDITABLE = ['--c-bg', '--c-surface', '--c-text', '--c-muted', '--c-blue', '--c-orange', '--c-ok', '--c-warn', '--c-danger'];
const DERIVED = ['--c-navy', '--c-navy-mid', '--c-navy-light', '--c-surface-2', '--c-surface-solid', '--c-border', '--c-border-strong',
  '--c-on-blue', '--c-on-orange', '--c-on-fill', '--c-blue-dark', '--c-orange-dark', '--c-bar', '--c-on-bar', '--c-focus'];
const INLINE_OK = new Set([...EDITABLE, ...DERIVED]);
const COLOUR_RE = /^(#[0-9a-f]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i;

// ── the palettes, parsed from the CSS (cached until the file changes) ────────────────────────────
let _cache = null;
function palettes() {
  const st = fs.statSync(TOKENS);
  if (_cache && _cache.mtime === st.mtimeMs) return _cache;
  const css = fs.readFileSync(TOKENS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const base = {}, themes = {};
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const props = {};
    m[2].split(';').forEach((d) => { const i = d.indexOf(':'); if (i > 0) { const k = d.slice(0, i).trim(); if (k.startsWith('--')) props[k] = d.slice(i + 1).trim(); } });
    for (const sel of m[1].split(',').map((s) => s.trim())) {
      let t;
      if (sel === ':root' || sel === '[data-wren-scope="dark"]') Object.assign(base, props);
      else if ((t = /data-wren-(?:theme|scope)="([a-z-]+)"/.exec(sel))) themes[t[1]] = Object.assign(themes[t[1]] || {}, props);
    }
  }
  _cache = { mtime: st.mtimeMs, base, themes };
  return _cache;
}
function paletteOf(theme) {
  const { base, themes } = palettes();
  const t = Object.assign({}, base, theme === 'dark' ? {} : (themes[theme] || {}));
  Object.keys(t).forEach((k) => { const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(t[k]); if (m && t[m[1]]) t[k] = t[m[1]]; });
  return t;
}

// ── validation ───────────────────────────────────────────────────────────────────────────────────
function cleanMap(obj, allowed, max) {
  const out = {};
  if (obj == null) return out;
  if (typeof obj !== 'object' || Array.isArray(obj)) throw new Error('not an object');
  const keys = Object.keys(obj);
  if (keys.length > max) throw new Error('too many entries');
  for (const k of keys) {
    if (!allowed.has(k)) throw new Error('unknown colour "' + String(k).slice(0, 40) + '"');
    const v = String(obj[k]).trim();
    if (v.length > 48 || !COLOUR_RE.test(v) || !C.parse(v)) throw new Error('"' + k + '" is not a colour');
    out[k] = v.toLowerCase();
  }
  return out;
}
/** → { prefs } or throws Error(message). Never trusts the client's shape. */
function sanitize(body) {
  if (!body || typeof body !== 'object') throw new Error('nothing to save');
  if (body.v !== 2) throw new Error('unsupported version');
  if (!MODES.includes(body.mode)) throw new Error('mode must be auto, light or dark');
  if (!FAMILIES[body.palette]) throw new Error('unknown palette');
  const editable = new Set(EDITABLE);
  const prefs = { v: 2, mode: body.mode, palette: body.palette, ov: {}, inline: {}, at: new Date().toISOString() };
  for (const s of ['dark', 'light']) {
    prefs.ov[s] = cleanMap(body.ov && body.ov[s], editable, EDITABLE.length);
    prefs.inline[s] = cleanMap(body.inline && body.inline[s], INLINE_OK, INLINE_OK.size);
  }
  return prefs;
}
/** every scheme this mode can paint, checked as the browser would paint it */
function gate(prefs) {
  const schemes = prefs.mode === 'auto' ? ['dark', 'light'] : [prefs.mode];
  const failures = [];
  for (const s of schemes) {
    const tokens = Object.assign({}, paletteOf(FAMILIES[prefs.palette][s]), prefs.inline[s]);
    const r = C.check(tokens);
    r.failures.forEach((f) => failures.push({ scheme: s, id: f.id, label: f.label, ratio: f.ratio, min: f.min, message: C.explain(f) }));
    if (r.missing.length === C.PAIRS.length) failures.push({ scheme: s, id: 'unreadable-palette', label: 'palette', ratio: 0, min: 0, message: 'the palette could not be read' });
  }
  return failures;
}
function refusal(failures, mode) {
  // in Auto the person has two looks, so always say which one failed
  const first = failures.slice(0, 3).map((f) => (mode === 'auto' ? (f.scheme === 'dark' ? 'Dark look: ' : 'Light look: ') : '') + f.message).join(' ');
  return { error: 'contrast', message: first + (failures.length > 3 ? ' (+' + (failures.length - 3) + ' more)' : ''), failures };
}

function notParent(req, res, next) {
  if (req.user && req.user.role === 'parent') return res.status(403).json({ error: 'staff only' });
  next();
}
const managerGuard = requireRole('manager', 'deputy_manager');
const parse = (t) => { try { const o = JSON.parse(t); return o && o.v === 2 ? o : null; } catch (e) { return null; } };

router.get('/', authenticate, notParent, async (req, res) => {
  try {
    const db = getPool();
    const mine = await db.query('SELECT preference_value FROM user_preferences WHERE staff_id=$1 AND preference_key=$2', [req.user.id, PREF_KEY]);
    const def = await db.query('SELECT value FROM settings WHERE key=$1', [DEFAULT_KEY]);
    res.json({ staffId: req.user.id, mine: mine.rows[0] ? parse(mine.rows[0].preference_value) : null, default: def.rows[0] ? parse(def.rows[0].value) : null });
  } catch (e) { res.status(500).json({ error: 'could not read appearance' }); }
});

router.put('/', authenticate, notParent, async (req, res) => {
  let prefs;
  try { prefs = sanitize(req.body); } catch (e) { return res.status(400).json({ error: 'invalid', message: e.message }); }
  const failures = gate(prefs);
  if (failures.length) return res.status(422).json(refusal(failures, prefs.mode));
  try {
    await getPool().query(
      `INSERT INTO user_preferences (staff_id, preference_key, preference_value, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (staff_id, preference_key) DO UPDATE SET preference_value=EXCLUDED.preference_value, updated_at=now()`,
      [req.user.id, PREF_KEY, JSON.stringify(prefs)]);
    res.json({ ok: true, mine: prefs });
  } catch (e) { res.status(500).json({ error: 'could not save appearance' }); }
});

// "Back to the Wren palette" blanks the value rather than deleting the row — additive-only against ladn.*
// (parse() reads '' as "no preference"), and the unique (staff_id, preference_key) keeps it one row per person.
router.delete('/', authenticate, notParent, async (req, res) => {
  try {
    await getPool().query(
      `INSERT INTO user_preferences (staff_id, preference_key, preference_value, updated_at) VALUES ($1,$2,'',now())
       ON CONFLICT (staff_id, preference_key) DO UPDATE SET preference_value='', updated_at=now()`, [req.user.id, PREF_KEY]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'could not reset appearance' }); }
});

router.put('/default', authenticate, notParent, ...managerGuard, async (req, res) => {
  let prefs;
  try { prefs = sanitize(req.body); } catch (e) { return res.status(400).json({ error: 'invalid', message: e.message }); }
  const failures = gate(prefs);
  if (failures.length) return res.status(422).json(refusal(failures, prefs.mode));
  try {
    await getPool().query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,$2,$3,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
      [DEFAULT_KEY, JSON.stringify(prefs), req.user.id]);
    res.json({ ok: true, default: prefs });
  } catch (e) { res.status(500).json({ error: 'could not save the default' }); }
});

router.delete('/default', authenticate, notParent, ...managerGuard, async (req, res) => {
  try {
    await getPool().query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ($1,'',$2,now())
       ON CONFLICT (key) DO UPDATE SET value='', updated_by=EXCLUDED.updated_by, updated_at=now()`, [DEFAULT_KEY, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'could not clear the default' }); }
});

module.exports = router;
module.exports._test = { sanitize, gate, paletteOf, palettes, FAMILIES };
