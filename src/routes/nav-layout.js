'use strict';
// ===========================================================================
// /api/nav-layout — the sidebar layout for THIS setting (2026-08-20)
//
// Three layers, most specific wins, resolved in wren-shell-v2 _resolveNavGroups():
//   1. window.WREN_NAV_GROUPS   — a build/edition override (rare)
//   2. localStorage wrenNavGroups — the individual's personal tweak, this browser only
//   3. ladn.settings.nav_groups  — THE SETTING'S layout, saved here, everyone sees it
//   4. DEFAULT_NAV_GROUPS        — what Wren ships with
//
// Layer 3 is what this route adds. Before it, a rearranged sidebar lived only in
// one browser's localStorage, so it could not be a setting-wide choice and was lost
// on a new device. Every nursery configures Wren differently — this makes the
// sidebar part of that configuration rather than a per-browser accident.
// ===========================================================================
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

const KEY = 'nav_groups';
// Reads: anyone with a portal session — the shell fetches this on every boot.
// Writes: manager-level only. Changing the sidebar changes it for every member of staff.
const WRITE_ROLES = ['manager', 'deputy_manager', 'admin'];
const canWrite = (req, res, next) => hasRole(req.user, WRITE_ROLES)
  ? next() : res.status(403).json({ error: 'Manager access required to change the sidebar for everyone' });

/** Shape-check: [{label:string, sections:[string]}]. Rejects anything else rather
 *  than letting a malformed layout blank the sidebar for the whole setting. */
function validate(groups) {
  if (!Array.isArray(groups) || !groups.length) return 'Layout must be a non-empty list of menus';
  if (groups.length > 40) return 'Too many menus (max 40)';
  const seen = new Set();
  for (const g of groups) {
    if (!g || typeof g.label !== 'string' || !g.label.trim()) return 'Every menu needs a name';
    if (g.label.length > 60) return `Menu name too long: ${g.label.slice(0, 20)}…`;
    if (!Array.isArray(g.sections)) return `"${g.label}" has no page list`;
    if (g.sections.some(s => typeof s !== 'string')) return `"${g.label}" has an invalid page id`;
    for (const s of g.sections) {
      if (seen.has(s)) return `"${s}" appears in more than one menu`;
      seen.add(s);
    }
  }
  return null;
}

// GET / — the saved layout, or {groups:null} meaning "use the shipped default".
router.get('/', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT value, updated_at FROM settings WHERE key = $1`, [KEY]);
    if (!rows.length) return res.json({ groups: null, source: 'default' });
    let groups = null;
    try { groups = JSON.parse(rows[0].value); } catch { /* corrupt → fall back */ }
    if (!Array.isArray(groups) || !groups.length) return res.json({ groups: null, source: 'default' });
    res.json({ groups, source: 'setting', updated_at: rows[0].updated_at || null });
  } catch (e) {
    // Never 500 the shell's boot fetch — a failure here just means "use the default".
    res.json({ groups: null, source: 'default', error: e.message });
  }
});

// PUT / — save this setting's layout. Manager-level.
router.put('/', canWrite, express.json({ limit: '256kb' }), async (req, res) => {
  const groups = req.body && req.body.groups;
  const err = validate(groups);
  if (err) return res.status(400).json({ error: err });
  try {
    await getPool().query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [KEY, JSON.stringify(groups)]);
    recordAudit({ req, action: 'update', entity_type: 'nav_layout', entity_id: null,
      meta: { menus: groups.length, pages: groups.reduce((a, g) => a + g.sections.length, 0) } });
    res.json({ ok: true, groups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE / — back to the shipped default for the whole setting.
router.delete('/', canWrite, async (req, res) => {
  try {
    await getPool().query(`DELETE FROM settings WHERE key = $1`, [KEY]);
    recordAudit({ req, action: 'delete', entity_type: 'nav_layout', entity_id: null, meta: {} });
    res.json({ ok: true, groups: null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// b242 (2026-08-28) — the role x page navigation MATRIX, per edition
//
// Everything above this line is the 2026-08-20 setting-wide `settings.nav_groups`
// blob: ONE layout, for everyone, on Roost only. It still works and is untouched —
// it remains layer 3 of the shell's precedence. What b242 adds is a finer grain:
// per EDITION and per ROLE, one row per (edition, role, section), carrying
// show/hide + which group + where in that group.
//
// Resolution order at render time (see /resolved below, and _applyNavOverrides
// in public/js/wren-shell-v2.js):
//   0. a row for this edition + role 'staff-<id>'   (one person; 2026-10-21)
//   1. a row for this edition + this role
//   2. a row for this edition + role '*'   (the setting-wide default)
//   3. DEFAULT_NAV_GROUPS in the shell
//
// PRESENTATION, NOT SECURITY. `hidden` changes what a role SEES; it is never what
// stops them REACHING a page. Access control is b237 (/api/permissions). A section
// hidden here stays routable by URL and findable in Ctrl+K for anybody whose
// CAPABILITY still allows it — that separation is deliberate and is asserted by
// scripts/b242-verify-nav-matrix.js.
// ═══════════════════════════════════════════════════════════════════════════

// Manager-only, deliberately stricter than canWrite above. Rearranging the nav for
// a whole role is an owner-level act; approving an absence (deputy work) is not.
// Mirrors _isPermAdmin in src/routes/permissions.js so the two screens agree on
// who is an administrator.
function _isNavAdmin(u) {
  return !!u && (Number(u.id) === 1 || u.role === 'manager' || u.role === 'admin' || u.role === 'headteacher');
}
const navAdmin = (req, res, next) => _isNavAdmin(req.user)
  ? next() : res.status(403).json({ error: 'Manager access required to change the navigation layout' });

// Editions are used as a bare storage key, never interpolated into SQL, but keep
// them to a sane charset so the matrix screen cannot invent junk rows.
const EDITION_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const ROLE_RE    = /^(\*|[a-z0-9][a-z0-9_-]{0,39})$/i;
const SECTION_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// staff.role (what the JWT carries) -> roles.key (what the matrix is keyed by).
// They genuinely differ: staff.role says 'deputy_manager', ladn.roles says 'deputy'.
// permissions.js does the same mapping inline for 'deputy_manager'; this also folds
// underscores to hyphens so HR's 'room_leader' finds ladn.roles' 'room-leader'.
function navRoleKey(role) {
  const r = String(role || '').trim().toLowerCase();
  if (!r) return '';
  if (r === 'deputy_manager') return 'deputy';
  // b271: staff.role 'manager' is the FLOOR manager (ex-deputy) and maps to the
  // 'deputy' matrix row; the owners' 'admin' maps to the top row, still keyed
  // 'manager'. Mirrors ROLE_KEY_ALIASES in src/lib/capabilities.js — keep in step.
  if (r === 'manager') return 'deputy';
  if (r === 'admin' || r === 'owner' || r === 'headteacher') return 'manager';
  return r.replace(/_/g, '-');
}

/** One cell. Returns an error string, or null when it is well-formed. */
function validateCell(c) {
  if (!c || typeof c !== 'object') return 'Each change must be an object';
  if (!EDITION_RE.test(String(c.edition || ''))) return `Invalid edition: ${String(c.edition).slice(0, 20)}`;
  if (!ROLE_RE.test(String(c.role || ''))) return `Invalid role: ${String(c.role).slice(0, 20)}`;
  if (!SECTION_RE.test(String(c.section_id || ''))) return `Invalid page id: ${String(c.section_id).slice(0, 20)}`;
  if (c.group_label != null) {
    if (typeof c.group_label !== 'string' || !c.group_label.trim()) return 'A group needs a name';
    if (c.group_label.length > 60) return `Group name too long: ${c.group_label.slice(0, 20)}…`;
  }
  if (c.sort_order != null && !Number.isInteger(Number(c.sort_order))) return 'sort_order must be a whole number';
  return null;
}

async function upsertCell(db, c, userId) {
  await db.query(
    `INSERT INTO nav_layout (edition, role, section_id, group_label, sort_order, hidden, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (edition, role, section_id) DO UPDATE SET
       group_label = EXCLUDED.group_label,
       sort_order  = EXCLUDED.sort_order,
       hidden      = EXCLUDED.hidden,
       updated_at  = now(),
       updated_by  = EXCLUDED.updated_by`,
    [String(c.edition), String(c.role), String(c.section_id),
     c.group_label == null ? null : String(c.group_label).trim(),
     c.sort_order == null ? null : Number(c.sort_order),
     !!c.hidden, userId == null ? null : Number(userId)]);
}

// ── GET /roles — the columns of the matrix ─────────────────────────────────
// Read from ladn.roles, never hard-coded: the brief was explicit that a setting's
// own roles must appear. '*' is prepended as the "Everyone" default column — it is
// not a role and deliberately has no row in ladn.roles.
router.get('/roles', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT key, display_name, is_built_in FROM roles ORDER BY id`);
    res.json({
      roles: [{ key: '*', display_name: 'Everyone (default)', is_built_in: true, pseudo: true }]
        .concat(rows.map(r => ({ ...r, pseudo: false }))),
    });
  } catch (e) {
    // Never break the screen over this — fall back to the roles we know ship.
    res.json({
      roles: [{ key: '*', display_name: 'Everyone (default)', is_built_in: true, pseudo: true }],
      error: e.message,
    });
  }
});

// ── GET /matrix?edition=admin — every saved row for one edition ────────────
// Only the OVERRIDES are stored, so this is normally a handful of rows (or none).
// The screen composes them over the shipped default, which only the client knows.
router.get('/matrix', async (req, res) => {
  const edition = String(req.query.edition || 'admin');
  if (!EDITION_RE.test(edition)) return res.status(400).json({ error: 'Invalid edition' });
  try {
    const { rows } = await getPool().query(
      `SELECT role, section_id, group_label, sort_order, hidden, updated_at
         FROM nav_layout WHERE edition = $1
        ORDER BY role, COALESCE(sort_order, 2147483647), section_id`, [edition]);
    res.json({ edition, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /resolved?edition=admin — what THIS user's nav should look like ────
// Called by the shell on boot. Returns the role rows with the '*' rows filled in
// underneath, so the client applies a single flat map. Never 500s: on any failure
// it answers "no overrides", and the shell renders the shipped default.
router.get('/resolved', async (req, res) => {
  const edition = String(req.query.edition || 'admin');
  let roleKey = navRoleKey(req.user && req.user.role);
  // 2026-10-09: the owner (staff id 1 / an owner role) is the top 'manager' row whatever
  // staff.role says. Toby's staff.role is 'manager', which b271 maps to the floor-manager
  // ('deputy') row — so Cockpit, What needs me and Quick actions vanished from his menu once
  // his browser stopped running the old cached shell. Same owner test as capabilities.js.
  try { if (require('../lib/capabilities').isOwnerRole(req.user)) roleKey = 'manager'; } catch (_) {}
  if (!EDITION_RE.test(edition)) return res.json({ edition, role: roleKey, sections: {} });
  // 2026-10-21: a per-person layer on top of the role row, keyed role = 'staff-<id>'.
  // Toby hid Admissions on the 'deputy' row, which is also where the floor managers
  // (the office manager, the admissions lead) land — so they lost it too. A 'staff-<id>' row puts a page back for
  // one person without changing what the rest of their role sees.
  const personKey = req.user && Number.isInteger(Number(req.user.id)) ? `staff-${Number(req.user.id)}` : null;
  try {
    const { rows } = await getPool().query(
      `SELECT role, section_id, group_label, sort_order, hidden
         FROM nav_layout WHERE edition = $1 AND role IN ($2, '*', $3)`, [edition, roleKey || '*', personKey || '*']);
    // '*' first, then the specific role, then this person — most specific wins.
    const sections = {};
    rows.filter(r => r.role === '*').forEach(r => { sections[r.section_id] = r; });
    rows.filter(r => r.role !== '*' && r.role !== personKey).forEach(r => { sections[r.section_id] = r; });
    rows.filter(r => r.role === personKey).forEach(r => { sections[r.section_id] = r; });
    res.json({ edition, role: roleKey, sections });
  } catch (e) {
    res.json({ edition, role: roleKey, sections: {}, error: e.message });
  }
});

// ── PUT /cell — one show/hide toggle. Saves immediately. ───────────────────
router.put('/cell', navAdmin, express.json({ limit: '64kb' }), async (req, res) => {
  const c = req.body || {};
  const err = validateCell(c);
  if (err) return res.status(400).json({ error: err });
  try {
    await upsertCell(getPool(), c, req.user && req.user.id);
    recordAudit({ req, action: 'update', entity_type: 'nav_layout', entity_id: null,
      meta: { edition: c.edition, role: c.role, section: c.section_id, hidden: !!c.hidden, group: c.group_label || null } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /cells — a bulk upsert, for one user-visible ACTION ────────────────
// Move-up, move-to-another-group and rename-group each rewrite several rows at
// once. They are still ONE change with ONE toast — the brief ruled out a giant
// Save button whose failure loses twenty edits, not a single action that happens
// to touch four rows. Wrapped in a transaction so a reorder is all-or-nothing.
router.put('/cells', navAdmin, express.json({ limit: '512kb' }), async (req, res) => {
  const cells = (req.body && req.body.cells) || [];
  if (!Array.isArray(cells) || !cells.length) return res.status(400).json({ error: 'No changes supplied' });
  if (cells.length > 600) return res.status(400).json({ error: 'Too many changes in one request' });
  for (const c of cells) { const e = validateCell(c); if (e) return res.status(400).json({ error: e }); }
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const c of cells) await upsertCell(client, c, req.user && req.user.id);
    await client.query('COMMIT');
    recordAudit({ req, action: 'update', entity_type: 'nav_layout', entity_id: null,
      meta: { edition: cells[0].edition, role: cells[0].role, cells: cells.length } });
    res.json({ ok: true, saved: cells.length });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already gone */ }
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── DELETE /cell — this one page goes back to the shipped default ──────────
router.delete('/cell', navAdmin, async (req, res) => {
  const { edition, role, section_id: sectionId } = req.query;
  if (!EDITION_RE.test(String(edition || '')) || !ROLE_RE.test(String(role || '')) ||
      !SECTION_RE.test(String(sectionId || ''))) return res.status(400).json({ error: 'Invalid cell reference' });
  try {
    await getPool().query(
      `DELETE FROM nav_layout WHERE edition=$1 AND role=$2 AND section_id=$3`,
      [String(edition), String(role), String(sectionId)]);
    recordAudit({ req, action: 'delete', entity_type: 'nav_layout', entity_id: null,
      meta: { edition, role, section: sectionId } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /reset — one role (or one whole edition) back to the default ──────
// Deletes only ladn.nav_layout rows, which are pure presentation overrides. It
// cannot touch a capability, a page or a child record. Absence of a row IS the
// default, so this is the honest "reset" rather than writing a default layout in.
router.post('/reset', navAdmin, express.json({ limit: '16kb' }), async (req, res) => {
  const { edition, role } = req.body || {};
  if (!EDITION_RE.test(String(edition || ''))) return res.status(400).json({ error: 'Invalid edition' });
  if (role != null && !ROLE_RE.test(String(role))) return res.status(400).json({ error: 'Invalid role' });
  try {
    const q = role == null
      ? await getPool().query(`DELETE FROM nav_layout WHERE edition=$1`, [String(edition)])
      : await getPool().query(`DELETE FROM nav_layout WHERE edition=$1 AND role=$2`, [String(edition), String(role)]);
    recordAudit({ req, action: 'delete', entity_type: 'nav_layout', entity_id: null,
      meta: { edition, role: role == null ? 'ALL' : role, removed: q.rowCount } });
    res.json({ ok: true, removed: q.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});


module.exports = router;
module.exports.navRoleKey = navRoleKey;
