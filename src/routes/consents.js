// Child consent management (photo/media, outings, sunscreen, marketing).
// Admin/staff-facing (authed). Parent-facing read/write lives inline in
// server-unified.js under /welcome/consents/* (CF-Access email scoped).
//
// Storage: child_consents (one row per child+type). Legacy ad-hoc columns
// children.photo_consent / media_consent are kept in sync (dual-write) so
// existing consumers stay correct — see CONSENT_TYPES[].legacy.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

// Canonical consent catalogue. `legacy` maps a type back to a boolean column on
// children so we align with (and keep syncing) the pre-existing fields.
const CONSENT_TYPES = [
  { key: 'photo_media',         label: 'Photographs & videos (nursery use)',
    help: 'Photos/videos of your child used in their learning journey, daily diary, displays and records — kept within the nursery.',
    icon: '📷', legacy: 'photo_consent' },
  { key: 'outings_local_walks', label: 'Local outings & walks',
    help: 'Short supervised walks and outings in the local area (e.g. to the park or shops).',
    icon: '🚶' },
  { key: 'sunscreen',           label: 'Sun cream / sunscreen',
    help: 'Staff may apply sun cream to your child on warm or sunny days.',
    icon: '🧴' },
  { key: 'marketing_face',      label: 'Photos in marketing & social media',
    help: "Your child's face may appear on our website, social media or printed marketing.",
    icon: '📣', legacy: 'media_consent' },
];
const TYPE_KEYS = new Set(CONSENT_TYPES.map(t => t.key));
const LEGACY_BY_KEY = Object.fromEntries(CONSENT_TYPES.filter(t => t.legacy).map(t => [t.key, t.legacy]));

// Merge the stored rows onto the full catalogue so every type is represented
// (granted:null when never set).
function mergeConsents(rows) {
  const byType = Object.fromEntries(rows.map(r => [r.consent_type, r]));
  return CONSENT_TYPES.map(t => {
    const r = byType[t.key];
    return {
      consent_type: t.key,
      label: t.label,
      help: t.help,
      icon: t.icon,
      granted: r ? r.granted : null,
      consent_date: r ? r.consent_date : null,
      source: r ? r.source : null,
      updated_at: r ? r.updated_at : null,
    };
  });
}

// Upsert a single consent and keep the legacy children.* column in sync.
// `updatedBy`: staff id (manager) or 0 (parent). Returns the merged row.
async function setConsent(db, childId, consentType, granted, source, updatedBy) {
  if (!TYPE_KEYS.has(consentType)) throw new Error('Unknown consent_type');
  const g = (granted === null || granted === undefined) ? null : !!granted;
  await db.query(`
    INSERT INTO child_consents (child_id, consent_type, granted, consent_date, source, updated_by, updated_at)
    VALUES ($1,$2,$3::boolean, CASE WHEN $3::boolean IS NULL THEN NULL ELSE CURRENT_DATE END, $4, $5, now())
    ON CONFLICT (child_id, consent_type) DO UPDATE
      SET granted=EXCLUDED.granted, consent_date=EXCLUDED.consent_date,
          source=EXCLUDED.source, updated_by=EXCLUDED.updated_by, updated_at=now()
  `, [childId, consentType, g, source, updatedBy]);
  const legacyCol = LEGACY_BY_KEY[consentType];
  if (legacyCol && g !== null) {
    // legacy columns are NOT NULL-friendly booleans; only mirror an explicit yes/no
    await db.query(`UPDATE children SET ${legacyCol}=$1 WHERE id=$2`, [g, childId]);
  }
}

router.use(authenticate);

const MGR_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher'];

// GET /api/consents/types — the catalogue (labels/help for UIs)
router.get('/types', (_req, res) => res.json(CONSENT_TYPES));

// GET /api/consents/child/:childId — current consents for a child (admin view)
router.get('/child/:childId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'SELECT consent_type, granted, consent_date, source, updated_at FROM child_consents WHERE child_id=$1',
      [parseInt(req.params.childId, 10)]
    );
    res.json({ child_id: parseInt(req.params.childId, 10), consents: mergeConsents(rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/consents/overview — all active children with a compact consent summary
// (manager oversight — one row per child).
router.get('/overview', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.room_id, r.name AS room_name,
             COALESCE(json_agg(json_build_object(
                 'consent_type', cc.consent_type, 'granted', cc.granted
             ) ORDER BY cc.consent_type) FILTER (WHERE cc.consent_type IS NOT NULL), '[]') AS consents
      FROM children c
      LEFT JOIN rooms r ON r.id=c.room_id
      LEFT JOIN child_consents cc ON cc.child_id=c.id
      WHERE COALESCE(c.is_active,true)=true
      GROUP BY c.id, c.first_name, c.last_name, c.room_id, r.name
      ORDER BY c.first_name, c.last_name
    `);
    res.json({ types: CONSENT_TYPES, children: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/consents/child/:childId — manager sets/overrides one consent
// body: { consent_type, granted (bool|null) }
router.put('/child/:childId', async (req, res) => {
  if (!MGR_ROLES.includes(req.user && req.user.role)) {
    return res.status(403).json({ error: 'Manager or deputy only' });
  }
  const childId = parseInt(req.params.childId, 10);
  const { consent_type, granted } = req.body || {};
  if (!TYPE_KEYS.has(consent_type)) return res.status(400).json({ error: 'Unknown consent_type' });
  try {
    const db = getPool();
    await setConsent(db, childId, consent_type, granted, 'manager', req.user.id);
    const { rows } = await db.query(
      'SELECT consent_type, granted, consent_date, source, updated_at FROM child_consents WHERE child_id=$1',
      [childId]
    );
    res.json({ child_id: childId, consents: mergeConsents(rows) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.CONSENT_TYPES = CONSENT_TYPES;
module.exports.TYPE_KEYS = TYPE_KEYS;
module.exports.mergeConsents = mergeConsents;
module.exports.setConsent = setConsent;
