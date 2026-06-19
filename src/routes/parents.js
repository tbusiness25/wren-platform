const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');

// ── Option B de-identification (2026-06-12) ───────────────────────────────────
// Parents see their OWN child fully, but any OTHER child's name is redacted to an
// initial in parent-facing free text (obs title/text, diary notes/activities).
// Photos: only obs/diary explicitly shared_with_parents are returned; group-photo
// detection needs staff tagging (not auto-detectable) — see note in /child/:id/gallery.
let _childNames = { at: 0, list: [] };
async function getChildNames(db) {
  if (Date.now() - _childNames.at < 300000 && _childNames.list.length) return _childNames.list;
  try {
    const { rows } = await db.query('SELECT id, first_name, last_name FROM children WHERE is_active=true');
    _childNames = { at: Date.now(), list: rows };
  } catch { /* keep stale cache on error */ }
  return _childNames.list;
}
function redactOthers(text, ownChildId, children) {
  if (!text) return text;
  let out = String(text);
  for (const c of children) {
    if (c.id === ownChildId) continue;
    for (const nm of [c.first_name, c.last_name]) {
      if (!nm || String(nm).trim().length < 3) continue;
      const esc = String(nm).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      out = out.replace(new RegExp('\\b' + esc + '\\b', 'gi'), (String(nm)[0] || '').toUpperCase() + '.');
    }
  }
  return out;
}

// Parent auth middleware — strict audience check
const parentAuth = (req, res, next) => {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : req.headers['x-wren-token'] || '';
  if (!token) return res.status(401).json({ error: 'Unauthorised' });
  try {
    const jwt = require('jsonwebtoken');
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded.aud || decoded.aud !== 'parents') {
      return res.status(401).json({ error: 'Invalid token audience' });
    }
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// GET /settings — public: returns portal configuration for login page mode check
router.get('/settings', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      "SELECT value FROM settings WHERE key='portal_mode'"
    );
    res.json({ portal_mode: rows[0]?.value || 'full' });
  } catch(e) { res.json({ portal_mode: 'full' }); }
});

// All below require parent auth
router.use(parentAuth);

const childGuard = (req, res, next) => {
  const cid = parseInt(req.params.childId);
  if (req.user.role === 'parent' && req.user.child_id !== cid) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
};

// GET /child/:childId/diary
router.get('/child/:childId/diary', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT d.date, d.mood, d.meals, d.naps, d.activities, d.notes, d.photo_urls
      FROM daily_diary d
      WHERE d.child_id=$1 AND d.shared_with_parents=true
      ORDER BY d.date DESC LIMIT 30
    `, [req.params.childId]);
    const own = parseInt(req.params.childId, 10);
    const names = await getChildNames(db);
    res.json(rows.map(r => ({
      ...r,
      notes: redactOthers(r.notes, own, names),
      activities: redactOthers(r.activities, own, names),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/observations
router.get('/child/:childId/observations', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT o.id, o.title, o.observation_text, o.eyfs_areas, o.photo_urls,
             o.created_at, s.first_name as staff_first_name
      FROM observations o
      LEFT JOIN staff s ON s.id = o.staff_id
      WHERE o.child_id=$1 AND o.shared_with_parents=true
      ORDER BY o.created_at DESC LIMIT 50
    `, [req.params.childId]);
    const own = parseInt(req.params.childId, 10);
    const names = await getChildNames(db);
    res.json(rows.map(r => ({
      ...r,
      title: redactOthers(r.title, own, names),
      observation_text: redactOthers(r.observation_text, own, names),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/gallery — photos from diary + observations
router.get('/child/:childId/gallery', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const [diary, obs] = await Promise.all([
      db.query(`SELECT photo_urls, date as created_at FROM daily_diary WHERE child_id=$1 AND shared_with_parents=true AND array_length(photo_urls,1)>0 ORDER BY date DESC LIMIT 50`, [req.params.childId]),
      db.query(`SELECT photo_urls, created_at FROM observations WHERE child_id=$1 AND shared_with_parents=true AND array_length(photo_urls,1)>0 ORDER BY created_at DESC LIMIT 50`, [req.params.childId])
    ]);
    res.json({ diary: diary.rows, observations: obs.rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/profile — child info shown to parent
router.get('/child/:childId/profile', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT c.first_name, c.last_name, c.preferred_name, c.date_of_birth,
             c.funded_hours, c.funded_hours_type, c.start_date,
             c.allergies, c.dietary_requirements, c.medical_notes,
             c.photo_url, c.collection_password,
             r.name as room_name,
             s.first_name as key_person_first, s.last_name as key_person_last,
             s.profile_photo as key_person_photo
      FROM children c
      LEFT JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = c.key_person_id
      WHERE c.id = $1
    `, [req.params.childId]);
    res.json(rows[0] || null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/attendance — attendance summary (last 60 records)
router.get('/child/:childId/attendance', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT date, session, absent, absence_reason, notes
      FROM attendance
      WHERE child_id = $1
      ORDER BY date DESC
      LIMIT 60
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/funding — funding info
router.get('/child/:childId/funding', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT funded_hours, funded_hours_type, start_date,
             pupil_premium, send_needs, looked_after
      FROM children WHERE id = $1
    `, [req.params.childId]);
    res.json(rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /announcements — recent newsletters as announcements
router.get('/announcements', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id, subject as title, created_at, left(manager_intro, 200) as preview
      FROM newsletters WHERE status='sent'
      ORDER BY sent_at DESC LIMIT 5
    `);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /menu — current week's menu
router.get('/menu', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT mg.id as group_id, mg.name, mg.date_from, mg.date_to,
             mi.id as item_id, mi.day_of_week, mi.meal_type, mi.description, mi.allergens
      FROM menu_groups mg
      LEFT JOIN menu_items mi ON mi.menu_group_id=mg.id
      WHERE mg.is_active=true AND mg.date_from <= CURRENT_DATE + 7 AND mg.date_to >= CURRENT_DATE - 7
      ORDER BY mg.date_from DESC, mi.day_of_week, mi.meal_type
    `);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /articles — published resources
router.get('/articles', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, title, content_html, category, source_url, created_at FROM resources WHERE published=true ORDER BY created_at DESC LIMIT 20`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /resources — returns folder tree from gdrive via rclone
router.get('/resources', async (req, res) => {
  const { exec } = require('child_process');
  exec('rclone lsjson gdrive:MASTER/PARENTS/ --recursive --files-only --max-depth 3',
    { timeout: 15000 },
    (err, stdout) => {
      if (err) return res.status(500).json({ error: 'Drive unavailable', detail: err.message });
      try {
        const files = JSON.parse(stdout);
        const folders = {};
        files.forEach(f => {
          const parts = f.Path.split('/');
          const folder = parts.length > 1 ? parts[0] : 'General';
          const subfolder = parts.length > 2 ? parts[1] : null;
          const key = subfolder ? `${folder} / ${subfolder}` : folder;
          if (!folders[key]) folders[key] = [];
          folders[key].push({
            name: f.Name,
            path: f.Path,
            size: f.Size,
            modified: f.ModTime,
            mimeType: f.MimeType || ''
          });
        });
        const sorted = {};
        if (folders['Articles']) sorted['Articles'] = folders['Articles'];
        Object.keys(folders).sort().forEach(k => { if (k !== 'Articles') sorted[k] = folders[k]; });
        res.json({ folders: sorted, total: files.length });
      } catch (e) { res.status(500).json({ error: 'Parse error' }); }
    }
  );
});

// GET /resources/file?path=X — stream file from gdrive
router.get('/resources/file', async (req, res) => {
  const { spawn } = require('child_process');
  const filePath = req.query.path;
  if (!filePath || !/^[A-Za-z0-9 ._/-]+$/.test(filePath) || filePath.startsWith('/') || filePath.includes('//')) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const name = filePath.split('/').pop();
  const ext = name.split('.').pop().toLowerCase();
  const mimeMap = {
    pdf: 'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc: 'application/msword',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png'
  };
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Content-Type', mimeMap[ext] || 'application/octet-stream');
  const dl = spawn('rclone', ['cat', `gdrive:MASTER/PARENTS/${filePath}`]);
  dl.stdout.pipe(res);
  dl.stderr.on('data', d => console.error('rclone err:', d.toString()));
  dl.on('error', () => res.status(500).end());
});

// POST /contact — saves as message thread
router.post('/contact', async (req, res) => {
  const { subject, body, recipient_type } = req.body;
  if (!subject || !body) return res.status(400).json({ error: 'subject and body required' });
  const db = getPool();
  try {
    const { rows: [child] } = await db.query(
      'SELECT id, key_person_id FROM children WHERE id=$1', [req.user.child_id]
    );
    if (!child) return res.status(404).json({ error: 'Child not found' });

    let recipientStaffId = null;
    if (recipient_type === 'key_person' && child.key_person_id) {
      recipientStaffId = child.key_person_id;
    } else if (recipient_type === 'manager') {
      const { rows } = await db.query(`SELECT id FROM staff WHERE role='manager' AND is_active=true LIMIT 1`);
      if (rows.length) recipientStaffId = rows[0].id;
    }

    const { rows: [thread] } = await db.query(
      `INSERT INTO message_threads (child_id, subject, recipient_type, recipient_staff_id)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [child.id, subject, recipient_type || 'nursery', recipientStaffId]
    );
    await db.query(
      `INSERT INTO messages (thread_id, sender_type, parent_email, body)
       VALUES ($1,'parent',$2,$3)`,
      [thread.id, req.user.name, body]
    );
    res.json({ ok: true, thread_id: thread.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /weekly-menu — from weekly_menus table or menu_groups/items
router.get('/weekly-menu', async (req, res) => {
  try {
    const db = getPool();
    // Try weekly_menus custom table first
    let rows = [];
    try {
      const r = await db.query(`
        SELECT day_of_week, meal_type, description, allergens
        FROM weekly_menus
        WHERE week_start >= CURRENT_DATE - 7
        ORDER BY CASE day_of_week WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3 WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 ELSE 6 END,
          CASE meal_type WHEN 'Breakfast' THEN 1 WHEN 'Morning Snack' THEN 2 WHEN 'Lunch' THEN 3 WHEN 'Afternoon Snack' THEN 4 ELSE 5 END
      `);
      rows = r.rows;
    } catch {
      // Fallback to menu_groups/menu_items
      const r = await db.query(`
        SELECT mi.day_of_week, mi.meal_type, mi.description, mi.allergens
        FROM menu_groups mg
        LEFT JOIN menu_items mi ON mi.menu_group_id=mg.id
        WHERE mg.is_active=true AND mg.date_from <= CURRENT_DATE + 7 AND mg.date_to >= CURRENT_DATE - 7
        ORDER BY mi.day_of_week, mi.meal_type
      `);
      rows = r.rows;
    }
    res.json({ menu: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /child/:childId/invoices — invoices for a specific child
router.get('/child/:childId/invoices', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*, c.first_name || ' ' || c.last_name as child_name
      FROM invoices i
      JOIN children c ON c.id = i.child_id
      WHERE i.child_id = $1
      ORDER BY i.period_start DESC NULLS LAST, i.created_at DESC
      LIMIT 24
    `, [req.params.childId]).catch(() => ({ rows: [] }));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Update childGuard to support child_ids array
const childGuardMulti = (req, res, next) => {
  const cid = parseInt(req.params.childId);
  if (req.user.role === 'parent') {
    const allowedIds = req.user.child_ids || (req.user.child_id ? [req.user.child_id] : []);
    if (!allowedIds.includes(cid) && req.user.child_id !== cid) {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }
  next();
};

module.exports = router;
