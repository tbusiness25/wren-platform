const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const authenticate = require('../middleware/auth');
const { syncCFAllowlist } = require('../../scripts/sync-cf-allowlist');
const { recordAudit } = require('../utils/audit');

router.use(authenticate);

const { buildScopeSQL } = require('../middleware/scope-filter');

// Validate :id is a positive integer — returns 404 for strings like "list"
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(404).json({ error: 'Not found' });
  next();
});

const CHILD_SELECT = `
  SELECT c.*, r.name as room_name,
    s.first_name || ' ' || s.last_name as key_person_name,
    (c.start_date IS NULL OR c.start_date <= CURRENT_DATE) AS started
  FROM children c
  LEFT JOIN rooms r ON r.id = c.room_id
  LEFT JOIN staff s ON s.id = c.key_person_id
`;

// GET / — all active children (scope-filtered if applicable)
router.get('/', async (req, res) => {
  try {
    const db = getPool();
    const sf = req.scopeFilter;
    let sql = CHILD_SELECT + ' WHERE c.is_active=true';
    let params = [];
    if (sf) {
      sql += ` AND c.${sf.sql}`;
      params = sf.params;
    }
    sql += ' ORDER BY c.first_name, c.last_name';
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /by-room/:roomId
router.get('/by-room/:roomId', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      CHILD_SELECT + ' WHERE c.is_active=true AND c.room_id=$1 ORDER BY c.first_name',
      [req.params.roomId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /attendance/today — today's attendance with sign-in status
router.get('/attendance/today', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.room_id,
             r.name as room_name, c.allergies, c.medical_notes,
             a.sign_in_time, a.sign_out_time, a.absent, a.absence_reason,
             a.id as attendance_id,
             CASE WHEN sr.id IS NOT NULL AND sr.is_active=true THEN true ELSE false END as is_on_sen_register,
             sr.sen_type
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN attendance a ON a.child_id=c.id AND a.date=CURRENT_DATE AND a.session='full_day'
      LEFT JOIN sen_register sr ON sr.child_id = c.id
      WHERE c.is_active=true
      ORDER BY c.first_name
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/timeline — staff timeline view. Merged diary + observations for one child,
// newest first. Unlike the parent-facing timeline, staff see everything (no shared_with_parents
// filter) including drafts. Parent timelines filter; staff see all live/finalised.
router.get('/:id/timeline', async (req, res) => {
  try {
    const db = getPool();
    const cid = parseInt(req.params.id, 10);

    // Check if finalised_at column exists (may differ between DB schemas)
    const colCheck = await db.query(
      `SELECT count(*) > 0 AS has_col FROM information_schema.columns WHERE table_schema='ladn' AND table_name='daily_diary' AND column_name='finalised_at'`
    ).catch(() => ({ rows: [{ has_col: false }] }));
    const hasFinalised = colCheck.rows[0]?.has_col ?? false;
    const finCol = hasFinalised ? ', finalised_at' : '';

    const [diary, obs] = await Promise.all([
      db.query(`
        SELECT id, date, mood, meals, lunch, naps, sleep_from, sleep_to, nappy, nappy_time,
               milk_amount_ml, milk_time, activities, notes, photo_urls${finCol}
        FROM daily_diary
        WHERE child_id=$1
        ORDER BY date DESC LIMIT 60
      `, [cid]),
      db.query(`
        SELECT o.id, o.title, o.observation_text, o.eyfs_areas, o.photo_urls, o.created_at,
               s.first_name || ' ' || s.last_name AS staff_name
        FROM observations o
        LEFT JOIN staff s ON s.id = o.staff_id
        WHERE o.child_id=$1
        ORDER BY o.created_at DESC LIMIT 60
      `, [cid]),
    ]);

    const items = [];
    for (const d of diary.rows) {
      items.push({
        kind: 'diary', id: d.id, at: d.date, finalised: hasFinalised ? !!d.finalised_at : null,
        mood: d.mood, meals: d.meals, lunch: d.lunch, naps: d.naps,
        sleep_from: d.sleep_from, sleep_to: d.sleep_to,
        nappy: d.nappy, nappy_time: d.nappy_time,
        milk_amount_ml: d.milk_amount_ml, milk_time: d.milk_time,
        activities: d.activities, notes: d.notes,
        photo_urls: d.photo_urls || [],
      });
    }
    for (const o of obs.rows) {
      items.push({
        kind: 'observation', id: o.id, at: o.created_at,
        title: o.title, text: o.observation_text,
        eyfs_areas: o.eyfs_areas || [], staff: o.staff_name || null,
        photo_urls: o.photo_urls || [],
      });
    }

    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    res.json(items.slice(0, 100));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id
router.get('/:id', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      CHILD_SELECT + ' WHERE c.id=$1', [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const CHILD_WRITE_ROLES = ['manager','deputy_manager','admin','senior_practitioner','room_leader'];

// POST / — create child
router.post('/', async (req, res) => {
  if (!CHILD_WRITE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const { first_name, last_name, date_of_birth, room_id, key_person_id,
          parent_1_name, parent_1_email, parent_1_phone, allergies,
          medical_notes, photo_consent, funded_hours } = req.body;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO children (first_name, last_name, date_of_birth, room_id, key_person_id,
        parent_1_name, parent_1_email, parent_1_phone, allergies, medical_notes,
        photo_consent, funded_hours)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [first_name, last_name, date_of_birth, room_id, key_person_id,
        parent_1_name, parent_1_email, parent_1_phone, allergies,
        medical_notes, photo_consent || false, funded_hours || 0]);
    recordAudit({ req, action: 'create', entity_type: 'child', entity_id: rows[0].id });
    res.status(201).json(rows[0]);
    // sync CF allowlist after child creation
    syncCFAllowlist().catch(e => console.error('CF sync:', e.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/profile — practitioner view (non-sensitive)
router.get('/:id/profile', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
        c.photo_url, c.room_id, r.name as room_name,
        s.first_name as key_person_first, s.last_name as key_person_last,
        c.collection_password, c.allergies, c.dietary_requirements, c.medical_notes,
        c.parent_1_name, c.parent_1_phone, c.parent_2_name, c.parent_2_phone,
        c.emergency_contact_1_name, c.emergency_contact_1_phone,
        c.funded_hours, c.funded_hours_type, c.notes, c.send_needs,
        CASE WHEN sr.id IS NOT NULL AND sr.is_active=true THEN true ELSE false END as is_on_sen_register,
        sr.sen_type, sr.primary_need
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = c.key_person_id
      LEFT JOIN sen_register sr ON sr.child_id = c.id
      WHERE c.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const child = rows[0];
    // Today's diary summary
    const { rows: diary } = await db.query(
      'SELECT mood, meals, activities, notes FROM daily_diary WHERE child_id=$1 AND date=CURRENT_DATE',
      [req.params.id]
    );
    child.today_diary_summary = diary[0] || null;
    res.json(child);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id
router.put('/:id', async (req, res) => {
  if (!CHILD_WRITE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const fields = ['first_name','last_name','date_of_birth','room_id','key_person_id',
    'parent_1_name','parent_1_email','parent_1_phone','parent_2_name','parent_2_email',
    'parent_2_phone','allergies','dietary_requirements','medical_notes','photo_consent',
    'media_consent','funded_hours','funded_hours_type','is_active','notes',
    'emergency_contact_1_name','emergency_contact_1_phone','send_needs','collection_password',
    'start_date','postcode','emergency_contact_2_name','emergency_contact_2_phone',
    'court_order','court_order_details','social_worker_name','social_worker_phone'];
  const updates = [];
  const vals = [];
  fields.forEach(f => {
    if (req.body[f] !== undefined) {
      vals.push(req.body[f]);
      updates.push(`${f}=$${vals.length}`);
    }
  });
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
  vals.push(req.params.id);
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE children SET ${updates.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    recordAudit({ req, action: 'update', entity_type: 'child', entity_id: req.params.id,
      meta: { fields_changed: Object.keys(req.body).filter(k => fields.includes(k)) } });
    res.json(rows[0]);
    // sync CF allowlist after child update (email may have changed)
    syncCFAllowlist().catch(e => console.error('CF sync:', e.message));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Tags ──────────────────────────────────────────────────────────────────────

const TAG_BOOL_MAP = {
  'SEND': { table: 'children', col: 'send_needs' },
  'LAC': { table: 'children', col: 'looked_after' },
  'Pupil Premium': { table: 'children', col: 'pupil_premium' },
  '15hr Funded': { table: 'children', col: 'funded_hours_15' },
  '30hr Funded': { table: 'children', col: 'funded_hours_30' },
  '2yr Funded': { table: 'children', col: 'two_year_funded' },
  'EAL': { table: 'about_me', col: 'eal' },
  'IEP': { table: 'about_me', col: 'individual_education_plan' },
  'IBP': { table: 'about_me', col: 'individual_behaviour_plan' },
  'Safeguarding': { table: 'about_me', col: 'safeguarding_flag' },
  'Children of Concern': { table: 'about_me', col: 'children_of_concern' },
  '1:1 Care': { table: 'about_me', col: 'one_to_one_care' },
};

// GET /api/tags/definitions — must come before /:id to avoid route conflict
router.get('/tags/definitions', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM tag_definitions WHERE is_active=true ORDER BY category, tag'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /:id/tags
router.get('/:id/tags', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT ct.id, ct.tag, ct.tag_category, ct.added_at,
             td.colour, td.description, td.category
      FROM child_tags ct
      LEFT JOIN tag_definitions td ON td.tag=ct.tag
      WHERE ct.child_id=$1 ORDER BY ct.tag_category, ct.tag
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/tags
router.post('/:id/tags', async (req, res) => {
  const { role } = req.user;
  if (!['manager','deputy_manager','admin','room_leader','senior_practitioner'].includes(role))
    return res.status(403).json({ error: 'Insufficient role' });
  const { tag } = req.body;
  if (!tag) return res.status(400).json({ error: 'tag required' });
  const db = getPool();
  try {
    // Get tag definition for category
    const { rows: [def] } = await db.query('SELECT * FROM tag_definitions WHERE tag=$1', [tag]);
    await db.query(
      `INSERT INTO child_tags (child_id, tag, tag_category, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [req.params.id, tag, def?.category || 'general', req.user.id]
    );
    // Sync boolean fields
    const m = TAG_BOOL_MAP[tag];
    if (m) {
      if (m.table === 'children') {
        await db.query(`UPDATE children SET ${m.col}=true WHERE id=$1`, [req.params.id]);
      } else if (m.table === 'about_me') {
        await db.query(
          `INSERT INTO child_about_me (child_id, ${m.col}) VALUES ($1, true)
           ON CONFLICT (child_id) DO UPDATE SET ${m.col}=true, last_updated_at=NOW()`,
          [req.params.id]
        );
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id/tags/:tag
router.delete('/:id/tags/:tag', async (req, res) => {
  const { role } = req.user;
  if (!['manager','deputy_manager','admin','room_leader','senior_practitioner'].includes(role))
    return res.status(403).json({ error: 'Insufficient role' });
  try {
    await getPool().query(
      'DELETE FROM child_tags WHERE child_id=$1 AND tag=$2',
      [req.params.id, req.params.tag]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── About Me ─────────────────────────────────────────────────────────────────

// GET /:id/about-me
router.get('/:id/about-me', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      'SELECT * FROM child_about_me WHERE child_id=$1', [req.params.id]
    );
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /:id/about-me (upsert)
router.put('/:id/about-me', async (req, res) => {
  if (!CHILD_WRITE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const db = getPool();
  const d = req.body;
  const fields = [
    'religion','first_language','other_languages','special_days','lives_with',
    'weekly_schedule','other_childcare_setting','key_person_other_setting',
    'interests','skills','fears','comforts','sleep_pattern','sleep_location','comforter',
    'nappy_size','nappy_type','potty_training',
    'breakfast_source','breakfast_notes','lunch_source','lunch_notes',
    'tea_source','tea_notes','milk_type','dietary_requirements','food_allergies',
    'food_preferences','medication','medical_notes',
    'gender_identity','pronouns','ethnicity','eal','send',
    'under_2_funded','two_year_funded','three_four_year_funded','thirty_hour_funded',
    'one_to_one_care','looked_after','pupil_premium','children_of_concern',
    'safeguarding_flag','individual_behaviour_plan','individual_education_plan'
  ];
  const setClauses = fields.filter(f => d[f] !== undefined).map((f, i) => `${f}=$${i + 2}`);
  const vals = [req.params.id, ...fields.filter(f => d[f] !== undefined).map(f => d[f])];

  // Detect substantial content for completed_at
  const hasContent = ['interests','skills','lives_with','first_language'].some(f => d[f]);

  try {
    const existing = await db.query('SELECT id, completed_at FROM child_about_me WHERE child_id=$1', [req.params.id]);
    if (!existing.rows.length) {
      const flds = ['child_id', ...fields.filter(f => d[f] !== undefined)];
      const placeholders = flds.map((_,i) => `$${i+1}`).join(',');
      const insertVals = [req.params.id, ...fields.filter(f => d[f] !== undefined).map(f => d[f])];
      if (hasContent) { flds.push('completed_at', 'completed_by'); insertVals.push(new Date(), req.user?.role || 'staff'); }
      const { rows } = await db.query(
        `INSERT INTO child_about_me (${flds.join(',')}) VALUES (${flds.map((_,i)=>`$${i+1}`).join(',')}) RETURNING *`,
        insertVals
      );
      return res.json(rows[0]);
    }
    if (!setClauses.length) return res.json(existing.rows[0]);
    const extra = hasContent && !existing.rows[0].completed_at
      ? `, completed_at=NOW(), completed_by='${req.user?.role || 'staff'}'` : '';
    const { rows } = await db.query(
      `UPDATE child_about_me SET ${setClauses.join(',')}, last_updated_at=NOW()${extra} WHERE child_id=$1 RETURNING *`,
      vals
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /:id/photo — upload a child profile photo (2026-07-11; staff-portal only,
// served from /uploads/child-photos which is already GDPR-gated to admin/EY).
const _childPhotoDir = '/app/uploads/child-photos';
const _childPhotoUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb){ fs.mkdirSync(_childPhotoDir, { recursive: true }); cb(null, _childPhotoDir); },
    filename(req, file, cb){ const ext = (path.extname(file.originalname).toLowerCase()||'.jpg').replace('.jpeg','.jpg'); cb(null, String(req.params.id)+ext); },
  }),
  limits: { fileSize: 8*1024*1024 },
  fileFilter(req, file, cb){ cb(null, /^image\/(jpeg|png|webp)$/.test(file.mimetype)); },
});
router.post('/:id/photo', _childPhotoUpload.single('photo'), async (req, res) => {
  if (!CHILD_WRITE_ROLES.includes(req.user.role)) return res.status(403).json({ error: 'Insufficient role' });
  if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
  const url = '/uploads/child-photos/' + req.file.filename;
  try {
    await getPool().query('UPDATE children SET photo_url=$1, updated_at=NOW() WHERE id=$2', [url, req.params.id]);
    res.json({ photo_url: url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Carer Restrictions (s06) ──────────────────────────────────────────────────

// GET /:id/restrictions — list all restrictions for a child
router.get('/:id/restrictions', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT r.*, s.first_name || ' ' || s.last_name as created_by_name
      FROM carer_restrictions r
      LEFT JOIN staff s ON s.id = r.created_by
      WHERE r.child_id=$1
      ORDER BY r.active DESC, r.created_at DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/restrictions — add a new restriction
router.post('/:id/restrictions', async (req, res) => {
  if (!CHILD_WRITE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const { restricted_person_name, restriction_type, court_order_ref, details } = req.body;
  if (!restricted_person_name || !restriction_type) {
    return res.status(400).json({ error: 'restricted_person_name and restriction_type required' });
  }
  const validTypes = ['no_collect','no_contact','court_order','other'];
  if (!validTypes.includes(restriction_type)) {
    return res.status(400).json({ error: 'Invalid restriction_type' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO carer_restrictions
        (child_id, restricted_person_name, restriction_type, court_order_ref, details, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
    `, [req.params.id, restricted_person_name, restriction_type, court_order_ref || null, details || null, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'carer_restriction', entity_id: rows[0].id,
      meta: { child_id: req.params.id, restricted_person_name, restriction_type } });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /:id/restrictions/:restrictionId — deactivate/reactivate a restriction
router.put('/:id/restrictions/:restrictionId', async (req, res) => {
  if (!CHILD_WRITE_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Insufficient role' });
  }
  const { active } = req.body;
  if (active === undefined) {
    return res.status(400).json({ error: 'active field required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE carer_restrictions SET active=$1 WHERE id=$2 AND child_id=$3 RETURNING *',
      [active, req.params.restrictionId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    recordAudit({ req, action: 'update', entity_type: 'carer_restriction', entity_id: req.params.restrictionId,
      meta: { child_id: req.params.id, active } });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
