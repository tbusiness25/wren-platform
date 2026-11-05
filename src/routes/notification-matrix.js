'use strict';

/**
 * b212 — one screen for every notification, every portal, every member of staff.
 *
 * Preferences were spread over three tables and no single screen showed them:
 *   user_notification_prefs   (staff_id, category, mode)   — does anything happen, does push fire
 *   notification_preferences  (staff_id, event_category, channels[], enabled, scope)
 *                                                          — telegram, and room/key-child scoping
 *   user_notification_settings(staff_id, quiet_hours_*)    — when to stay silent
 *
 * This route reads and writes all three as one object so the UI does not have to
 * know they are separate. It deliberately does NOT merge or drop the tables: the
 * dispatcher reads both, and collapsing them is a migration, not a settings screen.
 *
 * b230 (2026-08-25): the WRITE moved into ../services/notification-prefs-store,
 * which is now the only code that touches these tables. This route was already
 * the newest and most complete design, so it stayed the shape everything else
 * converts into — the older /api/notifications/prefs* and /my-settings writers
 * translate their payloads and call the same function. Reads are unchanged.
 *
 * Access: a member of staff may always read and write their OWN preferences.
 * Only manager/deputy_manager may touch somebody else's.
 */

const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const {
  CATEGORIES, CATEGORY_KEYS, PORTAL_LABELS,
  portalForCategory, isComplianceLocked, defaultModeForCategory,
} = require('../services/notification-categories');
const { savePreferences } = require('../services/notification-prefs-store');

const MODES  = ['off', 'inapp', 'inapp_push', 'digest'];
const SCOPES = ['all', 'my_room', 'my_keychildren'];
const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin']);

const isManager = (req) => MANAGER_ROLES.has(req.user?.role);

/** Which staff row is this request about, and is the caller allowed to touch it? */
function resolveTarget(req, raw) {
  const me = Number(req.user?.id || req.user?.staff_id);
  const asked = Number(raw);
  if (!Number.isFinite(asked) || asked === me) return { id: me, ok: true };
  return { id: asked, ok: isManager(req) };
}

// ── GET /api/notification-matrix?staff_id=N ──────────────────────────────────
router.get('/', authenticate, async (req, res) => {
  const db = getPool();
  const t = resolveTarget(req, req.query.staff_id);
  if (!t.ok) return res.status(403).json({ error: 'forbidden', message: 'Managers only for other staff' });

  try {
    const [who, modes, prefs, quiet] = await Promise.all([
      db.query(`SELECT id, first_name, last_name, role FROM staff WHERE id=$1`, [t.id]),
      db.query(`SELECT category, mode FROM user_notification_prefs WHERE staff_id=$1`, [t.id]),
      db.query(`SELECT event_category, channels, enabled, scope FROM notification_preferences WHERE staff_id=$1`, [t.id]),
      db.query(`SELECT quiet_hours_enabled, quiet_hours_start, quiet_hours_end
                  FROM user_notification_settings WHERE staff_id=$1`, [t.id]),
    ]);
    if (!who.rows.length) return res.status(404).json({ error: 'no_such_staff' });

    const modeBy = Object.fromEntries(modes.rows.map(r => [r.category, r.mode]));
    const prefBy = Object.fromEntries(prefs.rows.map(r => [r.event_category, r]));

    // Managers get the staff picker; everyone else only ever sees themselves.
    let staffList = [];
    if (isManager(req)) {
      const { rows } = await db.query(
        `SELECT id, first_name, last_name, role FROM staff
          WHERE is_active = true AND role <> 'parent'
          ORDER BY first_name, last_name`);
      staffList = rows.map(r => ({ id: r.id, name: `${r.first_name} ${r.last_name}`, role: r.role }));
    }

    const portals = Object.entries(PORTAL_LABELS).map(([key, meta]) => ({
      key, label: meta.label, hint: meta.hint,
      categories: CATEGORY_KEYS
        .filter(k => portalForCategory(k) === key)
        .map(k => {
          const meta = CATEGORIES[k] || {};
          const p = prefBy[k];
          return {
            key: k,
            label: meta.label || k,
            urgent: !!meta.urgent,
            manager_only: !!meta.managerOnly,
            // The DB enforces this too (user_notification_prefs_compliance_lock);
            // sending it down lets the UI disable "Off" rather than fail on save.
            locked: isComplianceLocked(k),
            mode: modeBy[k] || defaultModeForCategory(k),
            telegram: Array.isArray(p?.channels) ? p.channels.includes('telegram') : false,
            scope: p?.scope || 'all',
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label)),
    }));

    res.json({
      staff: {
        id: who.rows[0].id,
        name: `${who.rows[0].first_name} ${who.rows[0].last_name}`,
        role: who.rows[0].role,
      },
      is_self: t.id === Number(req.user?.id || req.user?.staff_id),
      can_edit_others: isManager(req),
      staff_list: staffList,
      quiet_hours: quiet.rows[0] || { quiet_hours_enabled: true, quiet_hours_start: '20:00:00', quiet_hours_end: '07:00:00' },
      portals,
      modes: MODES,
      scopes: SCOPES,
    });
  } catch (e) {
    console.error('[notification-matrix] load failed:', e.message);
    res.status(500).json({ error: 'load_failed', message: e.message });
  }
});

// ── PUT /api/notification-matrix ─────────────────────────────────────────────
// Body: { staff_id, quiet_hours: {...}, categories: [{ key, mode, telegram, scope }] }
// Partial by design — the UI sends only rows the user actually changed.
router.put('/', authenticate, express.json({ limit: '256kb' }), async (req, res) => {
  const db = getPool();
  const body = req.body || {};
  const t = resolveTarget(req, body.staff_id);
  if (!t.ok) return res.status(403).json({ error: 'forbidden', message: 'Managers only for other staff' });

  const rows = Array.isArray(body.categories) ? body.categories : [];
  // b230: the write itself lives in ../services/notification-prefs-store — the
  // ONE path that keeps user_notification_prefs and notification_preferences in
  // step. PUT /api/notifications/prefs, PUT /api/notifications/prefs/:staffId
  // and PUT /api/notifications/my-settings all go through the same function, so
  // whichever screen a member of staff uses, the two tables agree afterwards.
  // Partial by design — the UI sends only rows the user actually changed.
  try {
    const result = await savePreferences(db, t.id, {
      categories: rows,
      quiet_hours: body.quiet_hours,
    });
    res.json({ ok: true, saved: result.saved, rejected: result.rejected });
  } catch (e) {
    console.error('[notification-matrix] save failed:', e.message);
    res.status(500).json({ error: 'save_failed', message: e.message });
  }
});

module.exports = router;
