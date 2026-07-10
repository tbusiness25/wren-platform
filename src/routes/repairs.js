'use strict';
const express = require('express');
const router  = express.Router();
const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const https   = require('https');
const { getPool }  = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');

router.use(authenticate);

// ── Upload config ─────────────────────────────────────────────────────────────
const UPLOAD_BASE = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'repairs')
  : path.join(__dirname, '../../data/ladn/uploads/repairs');

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(UPLOAD_BASE, String(req.params.id || 'tmp'));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
    cb(null, `photo_${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype));
  },
});

// ── Telegram helper ───────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' });
  return new Promise(resolve => {
    const req = https.request(
      { hostname: 'api.telegram.org', path: `/bot${token}/sendMessage`, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => { res.resume(); resolve(); }
    );
    req.on('error', resolve);
    req.write(body);
    req.end();
  });
}

// ── Notification helper ───────────────────────────────────────────────────────
async function createNotification(db, { recipientType, recipientId, category, title, body, link, priority, relatedId }) {
  try {
    await db.query(
      `INSERT INTO notifications (recipient_type,recipient_id,category,title,body,link,related_table,related_id,priority)
       VALUES ($1,$2,$3,$4,$5,$6,'repairs',$7,$8)`,
      [recipientType, recipientId || null, category || 'repair', title, body || null, link || null, relatedId || null, priority || 'normal']
    );
  } catch { /* notifications are best-effort */ }
}

const SEVERITY_COLOURS = { low: '🟢', normal: '🟡', urgent: '🟠', 'safety-critical': '🔴' };

const REPAIR_SELECT = `
  SELECT r.*,
    rb.first_name || ' ' || rb.last_name AS reported_by_name,
    ab.first_name || ' ' || ab.last_name AS assigned_to_name
  FROM repairs r
  LEFT JOIN staff rb ON rb.id = r.reported_by
  LEFT JOIN staff ab ON ab.id = r.assigned_to
`;

// GET /api/repairs
router.get('/', async (req, res) => {
  try {
    const { status, location, severity, category } = req.query;
    let q = REPAIR_SELECT + ' WHERE 1=1';
    const params = [];
    if (status)   { params.push(status);   q += ` AND r.status = $${params.length}`; }
    if (location) { params.push(location); q += ` AND r.location = $${params.length}`; }
    if (severity) { params.push(severity); q += ` AND r.severity = $${params.length}`; }
    if (category) { params.push(category); q += ` AND r.category = $${params.length}`; }
    q += ` ORDER BY
      CASE WHEN r.severity='safety-critical' THEN 1 WHEN r.severity='urgent' THEN 2
           WHEN r.severity='normal' THEN 3 ELSE 4 END,
      CASE r.priority WHEN 'urgent' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
      r.reported_at DESC LIMIT 200`;
    const { rows } = await getPool().query(q, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/repairs/:id
router.get('/:id', async (req, res) => {
  try {
    const { rows } = await getPool().query(REPAIR_SELECT + ' WHERE r.id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/repairs — any staff member can report
router.post('/', async (req, res) => {
  try {
    const { title, description, location, priority, category, severity } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO repairs(title, description, location, priority, category, severity, reported_by)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [title, description || null, location || null, priority || 'medium',
       category || null, severity || 'normal', req.user.id]
    );
    const r = rows[0];

    // Get reporter name
    const { rows: staffRows } = await db.query(
      'SELECT first_name || \' \' || last_name AS name FROM staff WHERE id=$1', [req.user.id]
    );
    const staffName = staffRows[0]?.name || 'Unknown';

    const isCritical = r.severity === 'safety-critical';
    const prefix = isCritical ? '🚨' : '🔧';
    const severityLabel = r.severity ? ` [${r.severity}]` : '';
    const locationLabel = r.location ? ` in ${r.location}` : '';

    // Telegram to manager
    await sendTelegram(
      `${prefix} *New repair*${severityLabel}: ${r.title}${locationLabel}\nReported by: ${staffName}\n`
    );

    // If safety-critical also notify all managers
    if (isCritical) {
      const { rows: managers } = await db.query(
        `SELECT id FROM staff WHERE role IN ('manager','deputy_manager') AND is_active=true`
      );
      for (const m of managers) {
        if (m.id !== req.user.id) {
          await createNotification(db, {
            recipientType: 'staff', recipientId: m.id, category: 'repair',
            title: `🚨 Safety-critical repair: ${r.title}`,
            body: `${staffName} reported a safety-critical issue${locationLabel}`,
            link: '/repairs.html', priority: 'urgent', relatedId: r.id,
          });
        }
      }
    }

    // In-app notification to managers
    await createNotification(db, {
      recipientType: 'all-managers', category: 'repair',
      title: `${prefix} New repair: ${r.title}`,
      body: `Reported by ${staffName}${locationLabel}${severityLabel}`,
      link: '/repairs.html', priority: isCritical ? 'urgent' : 'normal', relatedId: r.id,
    });

    res.status(201).json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/repairs/:id/photo — multer upload
router.post('/:id/photo', upload.single('photo'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const photoPath = `/data/repairs/${req.params.id}/${req.file.filename}`;
    await getPool().query('UPDATE repairs SET photo_path=$1 WHERE id=$2', [photoPath, req.params.id]);
    res.json({ photo_path: photoPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/repairs/:id — manager only
router.patch('/:id', ...requireRole('manager', 'deputy_manager', 'room_leader'), async (req, res) => {
  try {
    const { title, description, location, priority, category, severity, status,
            assigned_to, resolution_notes, external_contractor, cost_estimate, cost_actual } = req.body;
    const db = getPool();
    const { rows: cur } = await db.query('SELECT * FROM repairs WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const prev = cur[0];

    let resolvedAt = prev.resolved_at;
    let resolvedBy = prev.resolved_by_staff_id;
    if (status === 'resolved' && prev.status !== 'resolved') {
      resolvedAt = new Date();
      resolvedBy = req.user.id;
    }

    const { rows } = await db.query(
      `UPDATE repairs SET
        title=COALESCE($1,title), description=COALESCE($2,description),
        location=COALESCE($3,location), priority=COALESCE($4,priority),
        category=COALESCE($5,category), severity=COALESCE($6,severity),
        status=COALESCE($7,status), assigned_to=COALESCE($8,assigned_to),
        resolution_notes=COALESCE($9,resolution_notes),
        external_contractor=COALESCE($10,external_contractor),
        cost_estimate=COALESCE($11,cost_estimate), cost_actual=COALESCE($12,cost_actual),
        resolved_at=$13, resolved_by_staff_id=$14
       WHERE id=$15 RETURNING *`,
      [title, description, location, priority, category, severity, status,
       assigned_to, resolution_notes, external_contractor,
       cost_estimate !== undefined ? cost_estimate : null,
       cost_actual !== undefined ? cost_actual : null,
       resolvedAt, resolvedBy, req.params.id]
    );
    const updated = rows[0];

    // Notify original reporter if status changed
    if (status && status !== prev.status && prev.reported_by) {
      await createNotification(db, {
        recipientType: 'staff', recipientId: prev.reported_by, category: 'repair',
        title: `Repair update: ${updated.title}`,
        body: `Status changed to ${status}${resolution_notes ? ' — ' + resolution_notes : ''}`,
        link: '/repairs.html', priority: 'normal', relatedId: updated.id,
      });
    }

    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/repairs/:id — kept for backwards-compat
router.put('/:id', ...requireRole('manager', 'deputy_manager', 'room_leader'), async (req, res) => {
  try {
    const { title, description, location, priority, status, assigned_to, resolution_notes } = req.body;
    const db = getPool();
    const { rows: cur } = await db.query('SELECT * FROM repairs WHERE id=$1', [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const r = cur[0];
    const resolvedAt = (status === 'resolved' && r.status !== 'resolved') ? new Date() : r.resolved_at;
    const { rows } = await db.query(
      `UPDATE repairs SET
        title=COALESCE($1,title), description=COALESCE($2,description),
        location=COALESCE($3,location), priority=COALESCE($4,priority),
        status=COALESCE($5,status), assigned_to=COALESCE($6,assigned_to),
        resolution_notes=COALESCE($7,resolution_notes), resolved_at=COALESCE($8,resolved_at)
       WHERE id=$9 RETURNING *`,
      [title, description, location, priority, status, assigned_to, resolution_notes, resolvedAt, req.params.id]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/repairs/:id/resolve
router.post('/:id/resolve', ...requireRole('manager', 'deputy_manager', 'room_leader'), async (req, res) => {
  try {
    const { resolution_notes } = req.body;
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE repairs SET status='resolved', resolved_at=NOW(),
        resolved_by_staff_id=$1, resolution_notes=COALESCE($2,resolution_notes)
       WHERE id=$3 RETURNING *`,
      [req.user.id, resolution_notes || null, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    // Notify reporter
    const r = rows[0];
    if (r.reported_by) {
      await createNotification(db, {
        recipientType: 'staff', recipientId: r.reported_by, category: 'repair',
        title: `Repair resolved: ${r.title}`,
        body: resolution_notes || 'Issue has been resolved',
        link: '/repairs.html', priority: 'normal', relatedId: r.id,
      });
    }
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
