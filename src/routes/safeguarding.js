const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');

// ── Parents portal: deny everything ──────────────────────────────────────────
router.use((req, res, next) => {
  if (req._portal === 'parents') return res.status(403).json({ error: 'Forbidden' });
  next();
});

// ── Role helpers ──────────────────────────────────────────────────────────────
function isDSL(req) {
  return ['manager','deputy_manager','admin','headteacher'].includes(req.user?.role);
}

function requireSafeguardingViewer(req, res, next) {
  if (!['manager','room_leader','headteacher'].includes(req.user?.role)) {
    return res.status(403).json({ error: 'Safeguarding records are restricted to DSL and room leaders' });
  }
  next();
}

// ── Photo upload setup ────────────────────────────────────────────────────────
const SG_UPLOAD_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'safeguarding')
  : path.join(__dirname, '../../data/ladn/uploads/safeguarding');

const _sgStorage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(SG_UPLOAD_DIR, { recursive: true });
    cb(null, SG_UPLOAD_DIR);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `sg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
  },
});
const _sgUpload = multer({
  storage: _sgStorage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  },
});

// ── POST /upload — safeguarding photo upload ──────────────────────────────────
router.post('/upload', authenticate, _sgUpload.array('photos', 5), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
  const files = req.files.map(f => ({
    url: `/api/safeguarding/photo/${f.filename}`,
    filename: f.filename,
    size: f.size,
    mime_type: f.mimetype,
    uploaded_by: req.user.id,
  }));
  res.json({ files });
});

// ── GET /photo/:filename — serve uploaded photos ──────────────────────────────
router.get('/photo/:filename', authenticate, requireSafeguardingViewer, (req, res) => {
  const name = path.basename(req.params.filename);
  const full = path.join(SG_UPLOAD_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(full);
});

// ── GET /categories — all safeguarding categories ─────────────────────────────
router.get('/categories', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id, label, group_name, description, is_statutory
      FROM safeguarding_categories
      ORDER BY is_statutory DESC, label ASC
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET / — list concerns ─────────────────────────────────────────────────────
router.get('/', authenticate, requireSafeguardingViewer, async (req, res) => {
  try {
    const db = getPool();
    const { status, child_id, limit = 100 } = req.query;

    const conditions = [];
    const params = [];
    let pi = 1;

    if (status) { conditions.push(`sc.status=$${pi++}`); params.push(status); }
    if (child_id) { conditions.push(`sc.child_id=$${pi++}`); params.push(parseInt(child_id)); }

    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

    const { rows } = await db.query(`
      SELECT sc.*,
        c.first_name || ' ' || c.last_name as child_name,
        c.date_of_birth as child_dob,
        r.first_name || ' ' || r.last_name as reporter_name,
        d.first_name || ' ' || d.last_name as dsl_name,
        (SELECT COUNT(*) FROM safeguarding_concerns sc2
          WHERE sc2.child_id = sc.child_id
          AND sc2.concern_date > NOW() - INTERVAL '30 days') as concerns_30d
      FROM safeguarding_concerns sc
      LEFT JOIN children c ON c.id = sc.child_id
      LEFT JOIN staff r ON r.id = sc.reported_by
      LEFT JOIN staff d ON d.id = sc.dsl_reviewed_by
      ${where}
      ORDER BY sc.concern_date DESC
      LIMIT $${pi}
    `, [...params, parseInt(limit)]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /stats — dashboard stats ─────────────────────────────────────────────
router.get('/stats', authenticate, requireSafeguardingViewer, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='new') as new_count,
        COUNT(*) FILTER (WHERE status='under_review') as under_review_count,
        COUNT(*) FILTER (WHERE status='action_taken') as action_taken_count,
        COUNT(*) FILTER (WHERE status='referred') as referred_count,
        COUNT(*) FILTER (WHERE status NOT IN ('closed')) as open_count,
        COUNT(*) as total_count
      FROM safeguarding_concerns
    `);
    const { rows: cpRows } = await db.query(`
      SELECT COUNT(*) as cp_count FROM cp_register WHERE is_active=true
    `);
    res.json({ ...rows[0], cp_count: cpRows[0].cp_count });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /cp-register — CP register ───────────────────────────────────────────
router.get('/cp-register', authenticate, requireSafeguardingViewer, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT cp.*, c.first_name || ' ' || c.last_name as child_name,
        c.date_of_birth, r.name as room_name,
        CASE WHEN cp.review_date <= CURRENT_DATE + 14 THEN true ELSE false END as review_due_soon,
        CASE WHEN cp.review_date < CURRENT_DATE THEN true ELSE false END as review_overdue
      FROM cp_register cp
      LEFT JOIN children c ON c.id = cp.child_id
      LEFT JOIN rooms r ON r.id = c.room_id
      WHERE cp.is_active = true
      ORDER BY cp.review_date ASC NULLS LAST
    `);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /cp-register ─────────────────────────────────────────────────────────
router.post('/cp-register', authenticate, async (req, res) => {
  if (!isDSL(req)) return res.status(403).json({ error: 'DSL only' });
  const { child_id, plan_type, start_date, review_date, social_worker_name,
    social_worker_email, social_worker_phone, health_visitor_name, notes } = req.body;
  if (!child_id || !plan_type || !start_date) {
    return res.status(400).json({ error: 'child_id, plan_type and start_date required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO cp_register (child_id,plan_type,start_date,review_date,social_worker_name,
        social_worker_email,social_worker_phone,health_visitor_name,notes,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *
    `, [child_id,plan_type,start_date,review_date||null,social_worker_name||null,
        social_worker_email||null,social_worker_phone||null,health_visitor_name||null,
        notes||null,req.user.id]);
    res.status(201).json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /child/:childId/timeline ──────────────────────────────────────────────
router.get('/child/:childId/timeline', authenticate, requireSafeguardingViewer, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sc.*, r.first_name || ' ' || r.last_name as reporter_name,
        (SELECT COUNT(*) FROM safeguarding_concerns sc2
          WHERE sc2.child_id = $1 AND sc2.concern_date > NOW() - INTERVAL '30 days') as concerns_30d
      FROM safeguarding_concerns sc
      LEFT JOIN staff r ON r.id = sc.reported_by
      WHERE sc.child_id = $1
      ORDER BY sc.concern_date DESC
    `, [req.params.childId]);
    res.json(rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id — single concern ─────────────────────────────────────────────────
router.get('/:id', authenticate, requireSafeguardingViewer, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sc.*,
        c.first_name || ' ' || c.last_name as child_name,
        c.date_of_birth as child_dob, c.room_id,
        r.first_name || ' ' || r.last_name as reporter_name,
        d.first_name || ' ' || d.last_name as dsl_name,
        w.first_name || ' ' || w.last_name as witness_name,
        cl.first_name || ' ' || cl.last_name as closer_name
      FROM safeguarding_concerns sc
      LEFT JOIN children c ON c.id = sc.child_id
      LEFT JOIN staff r ON r.id = sc.reported_by
      LEFT JOIN staff d ON d.id = sc.dsl_reviewed_by
      LEFT JOIN staff w ON w.id = sc.witnessed_by
      LEFT JOIN staff cl ON cl.id = sc.closed_by
      WHERE sc.id = $1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });

    const concern = rows[0];
    const { rows: actions } = await db.query(`
      SELECT sa.*, s.first_name || ' ' || s.last_name as staff_name
      FROM safeguarding_actions sa
      LEFT JOIN staff s ON s.id = sa.action_by
      WHERE sa.concern_id = $1 ORDER BY sa.created_at
    `, [req.params.id]);

    res.json({ ...concern, actions });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST / — log new concern (any authenticated staff) ────────────────────────
router.post('/', authenticate, async (req, res) => {
  const {
    child_id, category, category_ids, subcategory, description, immediate_action,
    witnessed_by, is_referral, referral_agency, referral_date, referral_reference,
    is_confidential, concern_date, body_map_data, severity, attachments, requires_lado,
    is_multi_child, persons_involved,
  } = req.body;

  // Accept either legacy `category` string or new `category_ids[]` array
  const resolvedCategoryIds = category_ids && category_ids.length ? category_ids : (category ? [category] : null);
  const resolvedCategory = category || (resolvedCategoryIds && resolvedCategoryIds[0]) || null;

  if (!child_id || !resolvedCategory || !description) {
    return res.status(400).json({ error: 'child_id, category (or category_ids) and description required' });
  }

  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO safeguarding_concerns
        (child_id, reported_by, category, category_ids, subcategory, description,
         immediate_action, witnessed_by, is_referral, referral_agency, referral_date,
         referral_reference, is_confidential, status, concern_date, body_map_data,
         severity, attachments, requires_lado, is_multi_child)
      VALUES ($1,$2,$3,$4::text[],$5,$6,$7,$8,$9,$10,$11,$12,$13,'new',$14,$15::jsonb,$16,$17::jsonb,$18,$19)
      RETURNING *
    `, [
      child_id, req.user.id, resolvedCategory,
      resolvedCategoryIds || null,
      subcategory || null, description,
      immediate_action || null, witnessed_by || null,
      is_referral || false, referral_agency || null, referral_date || null,
      referral_reference || null, is_confidential !== false,
      concern_date || new Date().toISOString(),
      body_map_data ? JSON.stringify(body_map_data) : null,
      ['standard','serious','critical'].includes(severity) ? severity : 'standard',
      attachments ? JSON.stringify(attachments) : null,
      requires_lado || false,
      is_multi_child || false,
    ]);

    const concern = rows[0];

    // If multi-child, write additional concern_persons rows
    if (persons_involved && Array.isArray(persons_involved) && persons_involved.length) {
      for (const person of persons_involved) {
        await db.query(
          'INSERT INTO safeguarding_concern_persons (concern_id, name, person_type, notes) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [concern.id, person.name || person, person.type || 'other', person.notes || null]
        ).catch(() => {});
      }
    }

    // Notify via Telegram (existing global chat)
    const child = await db.query('SELECT first_name,last_name FROM children WHERE id=$1', [child_id]);
    const childName = child.rows[0] ? `${child.rows[0].first_name} ${child.rows[0].last_name}` : 'Unknown child';
    const BOT = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT = process.env.TELEGRAM_CHAT_ID;
    if (BOT && CHAT) {
      const sevLabel = severity === 'critical' ? '🔴 CRITICAL' : severity === 'urgent' ? '🟠 Urgent' : '🟡 Standard';
      fetch(`https://api.telegram.org/bot${BOT}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CHAT, parse_mode: 'HTML',
          text: `🚨 <b>New Safeguarding Concern</b>\n\nChild: <b>${childName}</b>\nCategory: ${resolvedCategory}\nSeverity: ${sevLabel}\nReported by: ${req.user.name || req.user.first_name}\nRef: #${concern.id}\n\n<i>Log in to Wren to review immediately.</i>`,
        })
      }).catch(() => {});
    }

    notify('safeguarding_logged', 'all-managers', null,
      `Safeguarding concern: ${childName}`,
      `Category: ${resolvedCategory}. Severity: ${severity || 'standard'}. Reported by ${req.user.first_name || req.user.name}. Ref #${concern.id}.`,
      { priority: 'urgent', relatedTable: 'safeguarding_concerns', relatedId: concern.id, link: '/admin/safeguarding/concerns' }
    );

    res.status(201).json(concern);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /:id — update concern ─────────────────────────────────────────────────
router.put('/:id', authenticate, async (req, res) => {
  const { status, dsl_notes, close_reason, immediate_action } = req.body;
  const isManager = isDSL(req);

  if (status && !isManager) return res.status(403).json({ error: 'Only DSL can change status' });

  try {
    const db = getPool();
    const updates = [];
    const params = [];
    let pi = 1;

    if (status) {
      updates.push(`status=$${pi++}`); params.push(status);
      if (status === 'closed') {
        updates.push(`closed_by=$${pi++}`); params.push(req.user.id);
        updates.push(`closed_at=NOW()`);
        updates.push(`close_reason=$${pi++}`); params.push(close_reason || null);
      }
      if (isManager) {
        updates.push(`dsl_reviewed_by=$${pi++}`); params.push(req.user.id);
        updates.push(`dsl_reviewed_at=NOW()`);
      }
    }
    if (dsl_notes !== undefined && isManager) { updates.push(`dsl_notes=$${pi++}`); params.push(dsl_notes); }
    if (immediate_action !== undefined) { updates.push(`immediate_action=$${pi++}`); params.push(immediate_action); }
    updates.push('updated_at=NOW()');
    params.push(req.params.id);

    const { rows } = await db.query(
      `UPDATE safeguarding_concerns SET ${updates.join(',')} WHERE id=$${pi} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/actions — add action ────────────────────────────────────────────
router.post('/:id/actions', authenticate, async (req, res) => {
  const { action_text, due_date } = req.body;
  if (!action_text) return res.status(400).json({ error: 'action_text required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      'INSERT INTO safeguarding_actions (concern_id,action_by,action_text,due_date) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.id, req.user.id, action_text, due_date || null]
    );
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /:id/actions/:actionId — complete action ──────────────────────────────
router.put('/:id/actions/:actionId', authenticate, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      'UPDATE safeguarding_actions SET completed_at=NOW() WHERE id=$1 AND concern_id=$2 RETURNING *',
      [req.params.actionId, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GET /:id/lado-data — assemble pre-fill data for the LADO referral form ─────
// DSL-only. Pulls concern + child + subject staff + referrer (current user) + org +
// area-configurable LADO office details (settings). Subject staff comes from the
// subject_staff_id column or a concern_persons row (role alleged_perpetrator/subject).
router.get('/:id/lado-data', authenticate, async (req, res) => {
  if (!isDSL(req)) return res.status(403).json({ error: 'LADO referrals are restricted to the DSL / management' });
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT sc.*,
        c.first_name||' '||c.last_name AS child_name, c.date_of_birth AS child_dob,
        c.address_line1 AS child_addr1, c.postcode AS child_postcode,
        c.ethnicity AS child_ethnicity, c.gender AS child_gender,
        CASE WHEN c.sen_needs IS NOT NULL AND c.sen_needs <> '' THEN c.sen_needs
             WHEN c.send_needs THEN 'Yes (SEND)' ELSE '' END AS child_sen,
        c.looked_after AS child_looked_after,
        r.first_name||' '||r.last_name AS reporter_name
      FROM safeguarding_concerns sc
      LEFT JOIN children c ON c.id = sc.child_id
      LEFT JOIN staff r ON r.id = sc.reported_by
      WHERE sc.id = $1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const c = rows[0];

    // Subject of allegation (a staff member): explicit column, else concern_persons fallback
    let subject = null;
    let subjId = c.subject_staff_id;
    if (!subjId) {
      try {
        const { rows: pr } = await db.query(
          `SELECT person_id FROM safeguarding_concern_persons
           WHERE concern_id=$1 AND person_type='staff' AND role IN ('alleged_perpetrator','subject')
           ORDER BY (role='alleged_perpetrator') DESC LIMIT 1`, [req.params.id]);
        if (pr.length) subjId = pr[0].person_id;
      } catch (_) { /* persons table optional */ }
    }
    if (subjId) {
      const { rows: sr } = await db.query(
        `SELECT first_name||' '||last_name AS name, role, date_of_birth, phone,
                COALESCE(address_line1,'')||CASE WHEN address_line2 IS NOT NULL THEN ', '||address_line2 ELSE '' END||
                CASE WHEN postcode IS NOT NULL THEN ', '||postcode ELSE '' END AS address,
                contract_start, employment_type
         FROM staff WHERE id=$1`, [subjId]);
      if (sr.length) subject = sr[0];
    }
    if (!subject && c.subject_other_name) subject = { name: c.subject_other_name };

    // Referrer = the DSL generating the form (current user)
    let referrer = { name: req.user?.name || '', job_title: req.user?.role || '', email: '', phone: '' };
    if (req.user?.id) {
      const { rows: ur } = await db.query(
        `SELECT first_name||' '||last_name AS name, role, email, phone FROM staff WHERE id=$1`, [req.user.id]);
      if (ur.length) referrer = { name: ur[0].name, job_title: ur[0].role, email: ur[0].email || '', phone: ur[0].phone || '' };
    }

    // Org + LADO office details from settings (area-configurable)
    const { rows: sett } = await db.query(
      `SELECT key, value FROM settings WHERE key IN
       ('nursery_name','address','nursery_address','phone','nursery_phone','contact_email','safeguarding_lead',
        'lado_authority','lado_name','lado_phone','lado_email','lado_form_note')`);
    const S = {}; sett.forEach(r => { S[r.key] = r.value; });

    res.json({
      concern: {
        id: c.id,
        incident_date: c.concern_date || c.created_at,
        referral_date: c.lado_referral_date || c.referral_date || null,
        category: c.lado_category || c.category || c.subcategory || '',
        allegation: c.description || c.concern_description || '',
        immediate_action: c.immediate_action || '',
        safeguarding_lead: S.safeguarding_lead || '',
      },
      child: {
        name: c.child_name || '', dob: c.child_dob || null,
        address: [c.child_addr1, c.child_postcode].filter(Boolean).join(', '),
        ethnicity: c.child_ethnicity || '', gender: c.child_gender || '',
        sen: c.child_sen || '', looked_after: !!c.child_looked_after,
      },
      subject: subject || null,
      referrer,
      org: {
        name: S.nursery_name || 'Little Angels Day Nursery',
        address: S.address || S.nursery_address || '',
        phone: S.phone || S.nursery_phone || '',
        email: S.contact_email || '',
      },
      lado: {
        authority: S.lado_authority || '', name: S.lado_name || '',
        phone: S.lado_phone || '', email: S.lado_email || '', note: S.lado_form_note || '',
      },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
