'use strict';
/**
 * Wren — First-run Setup Wizard API  (prompt 67, 2026-07-04)
 *
 * Orchestration only. This route is UNAUTHENTICATED (it runs before any account
 * exists on a fresh instance) but SELF-GATED: every mutating endpoint refuses
 * once `settings.setup_complete = 'true'`. The edition server also gates the
 * `/setup` HTML page on the same flag.
 *
 * Reuse, don't rebuild:
 *   - settings table (key/value)                → all wizard answers
 *   - wren_settings key='modules' (JSONB)       → the SAME module-toggle store
 *                                                  read by it-settings.isModuleEnabled
 *   - settings key='phonics_scheme'             → the SAME key GET/PUT /api/phonics/scheme use
 *   - PHONICS_SCHEMES exported from phonics.js   → the canonical 14-scheme DfE list
 *   - framework_statements DISTINCT framework    → which overlay trackers are seeded
 *   - staff / rooms / children tables            → same columns as the authed routes
 *
 * The rich Tapestry/CTF/BrightHR importers stay behind auth in import-wizard.js
 * (System → Import Wizard, post-login). The wizard offers a simple CSV bootstrap
 * for the common first-run case and a "skip — import later" path for the rest.
 */

const express = require('express');
const router  = express.Router();
const bcrypt  = require('bcryptjs');
const { getPool } = require('../db/pool');

// Canonical phonics scheme list — reused from phonics.js (exported additively).
let PHONICS_SCHEMES = [];
try { PHONICS_SCHEMES = require('./phonics').PHONICS_SCHEMES || []; } catch (_) { PHONICS_SCHEMES = []; }

const EDITION   = (process.env.WREN_EDITION || '').toLowerCase();
const PG_SCHEMA = (process.env.PG_SCHEMA   || '').toLowerCase();

const MANAGER_ROLES = ['manager', 'deputy_manager', 'headteacher', 'admin', 'business_manager'];
const STEP_NAMES    = ['welcome', 'framework', 'phonics', 'staff', 'rooms', 'children', 'modules', 'review'];

function editionFamily() {
  // Explicit override (2026-07-09): a nursery on the 4-portal ht image (e.g.
  // Children's Corner) must get the EYFS wizard, not the school one.
  const fam = (process.env.WREN_EDITION_FAMILY || '').toLowerCase();
  if (['eyfs', 'primary', 'secondary'].includes(fam)) return fam;
  if (EDITION === 'secondary' || PG_SCHEMA.includes('secondary')) return 'secondary';
  if (EDITION === 'primary' || EDITION === 'ht' || PG_SCHEMA.includes('primary')) return 'primary';
  return 'eyfs'; // eyfs / ladn / demo_eyfs / nursery
}

// ── Statutory framework confirm-map + optional overlays (spec §2) ──────────────
const FRAMEWORK_MAP = {
  eyfs: {
    statutory: [
      { key: 'eyfs_statutory', label: 'EYFS Statutory Framework' },
      { key: 'elg',            label: 'Early Learning Goals (end-of-year assessment)' },
    ],
    overlays: [
      { key: 'birth_to_5',          label: 'Birth to 5 Matters',                 default: true  },
      { key: 'development_matters',  label: 'Development Matters',                default: false },
      { key: 'coel',                 label: 'Characteristics of Effective Learning', default: false },
      { key: 'leuven',               label: 'Leuven Wellbeing & Involvement',     default: false },
      { key: 'ecers_3',              label: 'ECERS-3 environment quality',        default: false },
      { key: 'iters_3',              label: 'ITERS-3 environment quality',        default: false },
      { key: 'send',                 label: 'SEND Code of Practice',              default: false },
    ],
  },
  primary: {
    statutory: [
      { key: 'national_curriculum', label: 'National Curriculum (KS1 & KS2)' },
      { key: 'eyfs_profile',        label: 'EYFS Profile (Reception)' },
    ],
    overlays: [
      { key: 'development_matters',  label: 'Development Matters (Reception)', default: true  },
      { key: 'birth_to_5',           label: 'Birth to 5 Matters (Reception)', default: false },
      { key: 'send',                 label: 'SEND Code of Practice',          default: false },
    ],
  },
  secondary: {
    statutory: [
      { key: 'national_curriculum', label: 'National Curriculum (KS3 & KS4)' },
    ],
    overlays: [
      { key: 'send', label: 'SEND Code of Practice', default: false },
    ],
  },
};

// ── Optional modules (toggleable) + always-on statutory modules (locked) ───────
const OPTIONAL_MODULES = [
  { key: 'kitchen',     label: 'Kitchen & Food Safety (SFBB)' },
  { key: 'points',      label: 'Wren Points (rewards)' },
  { key: 'phonics',     label: 'Phonics Tracker' },
  { key: 'outings',     label: 'Outings & Trips' },
  { key: 'repairs',     label: 'Repairs & Maintenance' },
  { key: 'newsletters', label: 'Newsletters' },
  { key: 'surveys',     label: 'Parent Surveys' },
];
const LOCKED_MODULES = [
  { key: 'safeguarding', label: 'Safeguarding' },
  { key: 'incidents',    label: 'Incidents & Accidents' },
  { key: 'medicine',     label: 'Medicine' },
];

// ── settings helpers (schema resolved by the pool's search_path) ───────────────
async function getSetting(db, key) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key=$1', [key]);
  return rows[0] ? rows[0].value : null;
}
async function setSetting(db, key, value) {
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
    [key, value]
  );
}

// ── wren_settings key='modules' — the SAME toggle store it-settings uses ───────
async function ensureWrenSettings(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS wren_settings (
    key VARCHAR(100) PRIMARY KEY,
    value JSONB NOT NULL DEFAULT 'null'::jsonb,
    updated_at TIMESTAMPTZ DEFAULT NOW())`);
}
async function getModulesToggle(db) {
  await ensureWrenSettings(db);
  const { rows } = await db.query("SELECT value FROM wren_settings WHERE key='modules'");
  return (rows[0] && rows[0].value) || {};
}
async function setModulesToggle(db, obj) {
  await ensureWrenSettings(db);
  await db.query(
    `INSERT INTO wren_settings (key, value, updated_at) VALUES ('modules', $1::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value=$1::jsonb, updated_at=NOW()`,
    [JSON.stringify(obj)]
  );
}

async function isComplete(db) {
  return String(await getSetting(db, 'setup_complete')).toLowerCase() === 'true';
}
async function managerCount(db) {
  const { rows } = await db.query(
    'SELECT COUNT(*)::int AS n FROM staff WHERE is_active=true AND role = ANY($1)', [MANAGER_ROLES]);
  return rows[0].n;
}
async function stepsDone(db) {
  const v = await getSetting(db, 'setup_steps_done');
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
}
async function markStep(db, name) {
  const done = await stepsDone(db);
  if (!done.includes(name)) done.push(name);
  await setSetting(db, 'setup_steps_done', JSON.stringify(done));
  return done;
}

// ── Gate: block all mutations once setup is complete ───────────────────────────
async function requireIncomplete(req, res, next) {
  try {
    if (await isComplete(getPool())) {
      return res.status(403).json({ error: 'setup_already_complete',
        message: 'Setup is already complete. Re-run individual sections from System.' });
    }
    next();
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// ── GET /status — tells the wizard where to resume ─────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const db = getPool();
    const fam = editionFamily();
    res.json({
      setup_complete: await isComplete(db),
      edition:        EDITION || 'unknown',
      edition_family: fam,
      schema:         PG_SCHEMA || null,
      setting_name:   await getSetting(db, 'setting_name'),
      steps_done:     await stepsDone(db),
      manager_count:  await managerCount(db),
      phonics_enabled: fam !== 'secondary',
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /frameworks — statutory (confirm-only) + available overlays ────────────
router.get('/frameworks', async (req, res) => {
  try {
    const db  = getPool();
    const fam = editionFamily();
    const map = FRAMEWORK_MAP[fam];
    let available = [];
    try {
      const { rows } = await db.query('SELECT DISTINCT framework FROM framework_statements');
      available = rows.map(r => r.framework);
    } catch (_) { available = []; }
    let selected = [];
    try { selected = JSON.parse(await getSetting(db, 'framework_overlays') || '[]'); } catch (_) {}
    const overlays = map.overlays.map(o => ({
      key: o.key,
      label: o.label,
      available: available.length === 0 ? true : available.includes(o.key),
      checked: selected.length ? selected.includes(o.key) : o.default,
    }));
    res.json({ edition_family: fam, statutory: map.statutory, overlays });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /phonics-schemes — reuse the canonical picker list + current value ─────
router.get('/phonics-schemes', async (req, res) => {
  try {
    const db = getPool();
    res.json({ scheme: await getSetting(db, 'phonics_scheme') || null, schemes: PHONICS_SCHEMES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /modules — optional (with current enabled state) + locked always-on ────
router.get('/modules', async (req, res) => {
  try {
    const toggle = await getModulesToggle(getPool());
    const optional = OPTIONAL_MODULES.map(m => ({ key: m.key, label: m.label, enabled: toggle[m.key] !== false }));
    res.json({ optional, locked: LOCKED_MODULES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /step/:name — persist a step's answers into settings ──────────────────
router.post('/step/:name', requireIncomplete, async (req, res) => {
  const name = String(req.params.name || '').toLowerCase();
  if (!STEP_NAMES.includes(name)) return res.status(400).json({ error: 'unknown_step' });
  const db = getPool();
  const b = req.body || {};
  try {
    if (name === 'welcome') {
      if (b.setting_name) await setSetting(db, 'setting_name', String(b.setting_name).slice(0, 200));
      if (b.timezone)     await setSetting(db, 'timezone', String(b.timezone).slice(0, 100));
      if (b.term_dates)   await setSetting(db, 'term_dates',
        typeof b.term_dates === 'string' ? b.term_dates : JSON.stringify(b.term_dates));
      if (b.logo && String(b.logo).startsWith('data:image'))
        await setSetting(db, 'setup_logo', String(b.logo).slice(0, 2000000));
    } else if (name === 'framework') {
      const overlays = Array.isArray(b.overlays) ? b.overlays.map(String) : [];
      await setSetting(db, 'framework_overlays', JSON.stringify(overlays));
    } else if (name === 'phonics') {
      const scheme = String(b.scheme || '');
      if (scheme) {
        const valid = PHONICS_SCHEMES.length === 0 || PHONICS_SCHEMES.some(s => s.id === scheme);
        if (!valid) return res.status(400).json({ error: 'unknown_scheme' });
        await setSetting(db, 'phonics_scheme', scheme);
      }
    } else if (name === 'modules') {
      const sel = (b.modules && typeof b.modules === 'object') ? b.modules : {};
      const toggle = await getModulesToggle(db);
      OPTIONAL_MODULES.forEach(m => { toggle[m.key] = !!sel[m.key]; });
      LOCKED_MODULES.forEach(m => { toggle[m.key] = true; });   // statutory — always on
      await setModulesToggle(db, toggle);
      await setSetting(db, 'modules_enabled', JSON.stringify(toggle));
    }
    // welcome/framework/phonics/modules/review are recorded here; staff/rooms/children
    // are recorded by their own endpoints below (they may be skipped).
    const done = await markStep(db, name);
    res.json({ ok: true, step: name, steps_done: done });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /staff — bootstrap staff (manual add or client-parsed CSV rows) ───────
// Same columns as the authenticated POST /api/staff. Must create the first manager.
router.post('/staff', requireIncomplete, async (req, res) => {
  const db = getPool();
  const list = Array.isArray(req.body && req.body.staff) ? req.body.staff : [];
  if (!list.length) return res.status(400).json({ error: 'no_staff' });
  const created = [], errors = [];
  for (let i = 0; i < list.length; i++) {
    const s = list[i] || {};
    const first = String(s.first_name || '').trim();
    const last  = String(s.last_name  || '').trim();
    if (!first || !last) { errors.push({ row: i, error: 'name_required' }); continue; }
    const role = String(s.role || 'practitioner').trim();
    const pin  = s.pin != null ? String(s.pin).trim() : '';
    if (pin && (!/^\d+$/.test(pin) || (pin.length !== 4 && pin.length !== 6))) {
      errors.push({ row: i, error: 'bad_pin' }); continue;
    }
    let pinHash = null, pinLength = 4;
    if (pin) { pinHash = await bcrypt.hash(pin, 10); pinLength = pin.length; }
    try {
      const { rows } = await db.query(`
        INSERT INTO staff
          (first_name, last_name, preferred_name, email, role, room_id,
           pin_hash, pin_length, is_active, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,NOW(),NOW())
        RETURNING id, first_name, last_name, role, email`,
        [first, last, String(s.preferred_name || '').trim() || null,
         String(s.email || '').trim() || null, role,
         (s.room_id != null && s.room_id !== '') ? parseInt(s.room_id, 10) : null,
         pinHash, pinLength]);
      created.push(rows[0]);
    } catch (e) { errors.push({ row: i, error: e.message }); }
  }
  if (created.length) await markStep(db, 'staff');
  res.json({ ok: true, created, errors, manager_count: await managerCount(db) });
});

// ── POST /rooms — quick add rooms/classes (manual or client-parsed CSV) ────────
router.post('/rooms', requireIncomplete, async (req, res) => {
  const db = getPool();
  const list = Array.isArray(req.body && req.body.rooms) ? req.body.rooms : [];
  if (!list.length) return res.status(400).json({ error: 'no_rooms' });
  const created = [], errors = [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i] || {};
    const name = String(r.name || '').trim();
    if (!name) { errors.push({ row: i, error: 'name_required' }); continue; }
    const capacity = (r.capacity != null && r.capacity !== '') ? parseInt(r.capacity, 10) : null;
    const minA = (r.min_age_months != null && r.min_age_months !== '') ? parseInt(r.min_age_months, 10) : null;
    const maxA = (r.max_age_months != null && r.max_age_months !== '') ? parseInt(r.max_age_months, 10) : null;
    try {
      const { rows } = await db.query(`
        INSERT INTO rooms (name, display_name, capacity, min_age_months, max_age_months, year_group, key_stage, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
        RETURNING id, name, capacity`,
        [name, String(r.display_name || name).trim(),
         Number.isFinite(capacity) ? capacity : null,
         Number.isFinite(minA) ? minA : null,
         Number.isFinite(maxA) ? maxA : null,
         String(r.year_group || '').trim() || null,
         String(r.key_stage || '').trim() || null]);
      created.push(rows[0]);
    } catch (e) { errors.push({ row: i, error: e.message }); }
  }
  if (created.length) await markStep(db, 'rooms');
  res.json({ ok: true, created, errors });
});

// ── POST /children — simple CSV bootstrap (rich importers stay in System) ──────
router.post('/children', requireIncomplete, async (req, res) => {
  const db = getPool();
  const list = Array.isArray(req.body && req.body.children) ? req.body.children : [];
  if (!list.length) return res.status(400).json({ error: 'no_children' });
  const created = [], errors = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i] || {};
    const first = String(c.first_name || '').trim();
    const last  = String(c.last_name  || '').trim();
    if (!first || !last) { errors.push({ row: i, error: 'name_required' }); continue; }
    const dob = String(c.date_of_birth || '').trim() || null;
    try {
      const { rows } = await db.query(`
        INSERT INTO children (first_name, last_name, date_of_birth, room_id, year_group, is_active, start_date)
        VALUES ($1,$2,$3,$4,$5,true,NOW())
        RETURNING id, first_name, last_name`,
        [first, last, dob,
         (c.room_id != null && c.room_id !== '') ? parseInt(c.room_id, 10) : null,
         String(c.year_group || '').trim() || null]);
      created.push(rows[0]);
    } catch (e) { errors.push({ row: i, error: e.message }); }
  }
  if (created.length) await markStep(db, 'children');
  res.json({ ok: true, created, errors });
});

// ── POST /finish — validate ≥1 manager, lock the wizard, return login redirect ─
router.post('/finish', requireIncomplete, async (req, res) => {
  const db = getPool();
  try {
    if (await managerCount(db) < 1) {
      return res.status(400).json({ error: 'no_manager',
        message: 'Create at least one manager account before finishing.' });
    }
    await markStep(db, 'review');
    await setSetting(db, 'setup_complete', 'true');
    await setSetting(db, 'setup_finished_at', new Date().toISOString());
    res.json({ ok: true, redirect: '/login.html' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
