'use strict';
const express      = require('express');
const router       = express.Router();
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');

const VIEW_ROLES = new Set(['manager', 'deputy_manager', 'admin', 'room_leader']);
const EDIT_ROLES = new Set(['manager', 'deputy_manager', 'admin']);

router.use(authenticate);

function viewOnly(req, res, next) {
  if (!VIEW_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Access denied' });
  next();
}

function editOnly(req, res, next) {
  if (!EDIT_ROLES.has(req.user?.role)) return res.status(403).json({ error: 'Manager access required' });
  next();
}

// ── GET /parent-permissions — full matrix with overrides applied ──────────────
router.get('/', viewOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT m.*,
             o.portal   AS override_portal,
             o.api      AS override_api,
             o.ics      AS override_ics,
             o.email    AS override_email,
             o.changed_by, o.changed_at, o.reason,
             s.first_name || ' ' || s.last_name AS changed_by_name,
             COALESCE(o.portal, m.default_portal) AS effective_portal,
             COALESCE(o.api,    m.default_api)    AS effective_api,
             COALESCE(o.ics,    m.default_ics)    AS effective_ics,
             COALESCE(o.email,  m.default_email)  AS effective_email
      FROM parent_permissions_matrix m
      LEFT JOIN parent_permissions_overrides o ON o.attribute_key = m.attribute_key
      LEFT JOIN staff s ON s.id = o.changed_by
      ORDER BY m.sort_order, m.category, m.attribute_key
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /parent-permissions/:key — set override for one attribute ───────────
router.patch('/:key', editOnly, async (req, res) => {
  const db = getPool();
  const { portal, api, ics, email, reason } = req.body;
  try {
    const { rows: [attr] } = await db.query(
      'SELECT attribute_key FROM parent_permissions_matrix WHERE attribute_key=$1', [req.params.key]
    );
    if (!attr) return res.status(404).json({ error: 'Attribute not found' });

    // All nulls = reset to default (delete override)
    if (portal == null && api == null && ics == null && email == null) {
      await db.query('DELETE FROM parent_permissions_overrides WHERE attribute_key=$1', [req.params.key]);
      return res.json({ ok: true, reset: true });
    }

    const { rows } = await db.query(`
      INSERT INTO parent_permissions_overrides
        (attribute_key, portal, api, ics, email, changed_by, changed_at, reason)
      VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7)
      ON CONFLICT (attribute_key) DO UPDATE SET
        portal=$2, api=$3, ics=$4, email=$5, changed_by=$6, changed_at=NOW(), reason=$7
      RETURNING *
    `, [req.params.key, portal ?? null, api ?? null, ics ?? null, email ?? null, req.user.id, reason || null]);

    // Audit log
    await db.query(`
      INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, meta)
      VALUES ('staff', $1, 'update', 'parent_permission', $2, $3)
    `, [req.user.id, req.params.key, JSON.stringify({ portal, api, ics, email, reason })]).catch(() => {});

    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /parent-permissions/presets/:preset — apply a preset ────────────────
router.post('/presets/:preset', editOnly, async (req, res) => {
  const db = getPool();
  const { preset } = req.params;

  // Preset definitions
  const PRESETS = {
    'hide-api': { api: false },                          // cautious: no API at all
    'match-portal': null,                                 // relaxed: delete all overrides
    'lock-finance': { portal: false, api: false, ics: false, email: false },
  };

  if (!PRESETS.hasOwnProperty(preset)) return res.status(400).json({ error: 'Unknown preset' });

  try {
    if (preset === 'match-portal') {
      // Delete all overrides → everything reverts to default
      await db.query('DELETE FROM parent_permissions_overrides');
    } else if (preset === 'hide-api') {
      // Set api=false on every attribute
      const { rows: all } = await db.query('SELECT attribute_key FROM parent_permissions_matrix');
      for (const row of all) {
        await db.query(`
          INSERT INTO parent_permissions_overrides (attribute_key, api, changed_by, reason)
          VALUES ($1, false, $2, 'preset:hide-api')
          ON CONFLICT (attribute_key) DO UPDATE SET api=false, changed_by=$2, changed_at=NOW(), reason='preset:hide-api'
        `, [row.attribute_key, req.user.id]);
      }
    } else if (preset === 'lock-finance') {
      const financeKeys = ['fees', 'invoices', 'payments'];
      for (const key of financeKeys) {
        await db.query(`
          INSERT INTO parent_permissions_overrides (attribute_key, portal, api, ics, email, changed_by, reason)
          VALUES ($1, false, false, false, false, $2, 'preset:lock-finance')
          ON CONFLICT (attribute_key) DO UPDATE SET portal=false, api=false, ics=false, email=false, changed_by=$2, changed_at=NOW(), reason='preset:lock-finance'
        `, [key, req.user.id]);
      }
    }

    await db.query(`
      INSERT INTO audit_log (actor_type, actor_id, action, entity_type, meta)
      VALUES ('staff', $1, 'update', 'parent_permissions_preset', $2)
    `, [req.user.id, JSON.stringify({ preset })]).catch(() => {});

    res.json({ ok: true, preset });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /parent-permissions/child-overrides/:childId ─────────────────────────
router.get('/child-overrides/:childId', viewOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT co.*, s.first_name || ' ' || s.last_name AS changed_by_name
      FROM parent_permissions_child_overrides co
      LEFT JOIN staff s ON s.id = co.changed_by
      WHERE co.child_id = $1
      ORDER BY co.attribute_key
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PATCH /parent-permissions/child-overrides/:childId/:key ──────────────────
router.patch('/child-overrides/:childId/:key', editOnly, async (req, res) => {
  const db = getPool();
  const { portal, api, reason } = req.body;
  try {
    if (portal == null && api == null) {
      await db.query('DELETE FROM parent_permissions_child_overrides WHERE child_id=$1 AND attribute_key=$2',
        [req.params.childId, req.params.key]);
      return res.json({ ok: true, reset: true });
    }
    const { rows } = await db.query(`
      INSERT INTO parent_permissions_child_overrides (child_id, attribute_key, portal, api, changed_by, reason)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (child_id, attribute_key) DO UPDATE SET portal=$3, api=$4, changed_by=$5, changed_at=NOW(), reason=$6
      RETURNING *
    `, [req.params.childId, req.params.key, portal ?? null, api ?? null, req.user.id, reason || null]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
