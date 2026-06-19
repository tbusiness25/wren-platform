'use strict';

const express  = require('express');
const router   = express.Router();
const fs       = require('fs');
const path     = require('path');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const DATA_DIR       = path.join(__dirname, '../../data');
const FRAMEWORKS_FILE = path.join(DATA_DIR, 'framework-versions.json');
const FIELDS_FILE     = path.join(DATA_DIR, 'field-config.json');
const THEME_CSS_PATH  = path.join(__dirname, '../../public/theme.css');
const PUBLIC_IMG_DIR  = path.join(__dirname, '../../public/img');

router.use(authenticate);

// ── Manager/IT guard ─────────────────────────────────────────────────────────
const managerOnly = (req, res, next) => {
  if (!['manager', 'deputy_manager', 'admin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// ── Ensure wren_settings table exists ────────────────────────────────────────
async function ensureTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS wren_settings (
      key        VARCHAR(100) PRIMARY KEY,
      value      JSONB NOT NULL DEFAULT 'null'::jsonb,
      updated_at TIMESTAMPTZ  DEFAULT NOW()
    )
  `);
}

async function getSetting(db, key) {
  await ensureTable(db);
  const { rows } = await db.query('SELECT value FROM wren_settings WHERE key=$1', [key]);
  return rows[0]?.value ?? null;
}

async function setSetting(db, key, value) {
  await ensureTable(db);
  await db.query(`
    INSERT INTO wren_settings (key, value, updated_at)
    VALUES ($1, $2::jsonb, NOW())
    ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, updated_at=NOW()
  `, [key, JSON.stringify(value)]);
}

// ── GET /api/frameworks ───────────────────────────────────────────────────────
router.get('/frameworks', async (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(FRAMEWORKS_FILE, 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Cannot read framework data' });
  }
});

// ── Modules ───────────────────────────────────────────────────────────────────
router.get('/modules', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const val = await getSetting(db, 'modules');
    res.json(val || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/modules', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    await setSetting(db, 'modules', req.body);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Fields / Dropdowns ────────────────────────────────────────────────────────
router.get('/fields', managerOnly, (req, res) => {
  try {
    const data = JSON.parse(fs.readFileSync(FIELDS_FILE, 'utf8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Cannot read field config' });
  }
});

router.post('/fields', managerOnly, (req, res) => {
  try {
    // Validate basic structure
    const incoming = req.body;
    if (typeof incoming !== 'object' || Array.isArray(incoming)) {
      return res.status(400).json({ error: 'Invalid payload' });
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FIELDS_FILE, JSON.stringify(incoming, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Branding ──────────────────────────────────────────────────────────────────
router.get('/branding', managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const val = await getSetting(db, 'branding');
    res.json(val || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/branding', managerOnly, async (req, res) => {
  try {
    const db  = getPool();
    const { setting_name, manager_name, contact_email, primary_color, logo_url } = req.body;
    const branding = { setting_name, manager_name, contact_email, primary_color, logo_url };
    await setSetting(db, 'branding', branding);
    generateThemeCss(branding);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Logo upload (base64) ──────────────────────────────────────────────────────
router.post('/logo', managerOnly, async (req, res) => {
  try {
    const { data, mimeType } = req.body;
    if (!data) return res.status(400).json({ error: 'No image data provided' });

    const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
    const filename = `setting-logo.${ext}`;
    fs.mkdirSync(PUBLIC_IMG_DIR, { recursive: true });
    fs.writeFileSync(path.join(PUBLIC_IMG_DIR, filename), Buffer.from(data, 'base64'));

    const logoUrl = `/img/${filename}`;
    const db = getPool();
    const existing = await getSetting(db, 'branding') || {};
    existing.logo_url = logoUrl;
    await setSetting(db, 'branding', existing);
    generateThemeCss(existing);

    res.json({ ok: true, url: logoUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Framework check (spawn) ───────────────────────────────────────────────────
router.post('/check-frameworks', managerOnly, (req, res) => {
  try {
    const { spawn } = require('child_process');
    const script = path.join(__dirname, '../../scripts/framework-checker.js');
    spawn('node', [script], { detached: true, stdio: 'ignore' }).unref();
    res.json({ started: true, message: 'Framework check started — refresh in ~30 seconds' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Module state helper (for external use) ────────────────────────────────────
router.isModuleEnabled = async function (moduleName) {
  try {
    const db = getPool();
    const val = await getSetting(db, 'modules');
    if (!val) return true; // default all enabled
    return val[moduleName] !== false;
  } catch {
    return true; // fail open
  }
};

// ── Internal: regenerate theme.css ───────────────────────────────────────────
function generateThemeCss(branding) {
  const color    = /^#[0-9a-fA-F]{6}$/.test(branding.primary_color || '')
    ? branding.primary_color : null;
  const logoUrl  = branding.logo_url || null;

  let css = '/* Wren theme.css — auto-generated by IT Settings. Do not edit manually. */\n:root {\n';
  if (color) {
    css += `  --c-blue: ${color};\n`;
    css += `  --c-blue-dark: ${darken(color, 20)};\n`;
    css += `  --primary-blue: ${color};\n`;
  }
  css += '}\n';

  if (logoUrl) {
    css += `\n/* Setting logo injected via branding */\n`;
    css += `#wren-setting-logo { display:block !important; }\n`;
  }

  fs.mkdirSync(path.dirname(THEME_CSS_PATH), { recursive: true });
  fs.writeFileSync(THEME_CSS_PATH, css);
}

/** Darken a hex colour by `amount` (0–255). */
function darken(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, (n >> 16) - amount);
  const g = Math.max(0, ((n >> 8) & 0xff) - amount);
  const b = Math.max(0, (n & 0xff) - amount);
  return `#${[r,g,b].map(v => v.toString(16).padStart(2,'0')).join('')}`;
}

module.exports = router;
