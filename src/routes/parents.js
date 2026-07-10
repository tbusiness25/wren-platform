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
// Waitlist gating middleware – restrict waitlist parents to allowed endpoints only
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

// GET /waitlist/status – returns waiting‑list info for the authenticated parent
router.get('/waitlist/status', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT waiting_list_id, access_level FROM parent_portal_access WHERE lower(email)=lower($1) AND is_active=true`,
      [req.user.email]
    );
    if (!rows.length) return res.status(404).json({ error: 'Parent not found' });
    const { waiting_list_id, access_level } = rows[0];
    // Fetch waiting list details (room wanted, position) – simplified example
    const wl = await db.query(
      `SELECT room_name, position FROM waiting_list WHERE id=$1`,
      [waiting_list_id]
    );
    const info = wl.rows[0] || {};
    res.json({ access_level, waiting_list_id, ...info });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
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

// Waitlist gating middleware – restrict waitlist parents to allowed endpoints only
router.use((req, res, next) => {
  const accessLevel = req.user && req.user.access_level;
  if (accessLevel !== 'waitlist') return next();
  // Allowed paths for waitlist parents
  const allowed = [
    '/waitlist/status',
    '/messages', // placeholder for messaging endpoint if exists
    '/funding'   // placeholder for funding declarations endpoint
  ];
  if (allowed.some(p => req.path.startsWith(p))) return next();
  return res.status(403).json({ error: 'Forbidden: waitlist access limited' });
});

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

// GET /child/:childId/timeline — unified EyLog-style feed: published diary + observations
// (+ their photos), newest first. Diary entries carry a `finalised` flag: draft = live/
// provisional times during the day, finalised = locked at sign-out. Other children's names
// are redacted in free text. Parents see only their own child (childGuard) and only items
// staff have shared (shared_with_parents=true).
router.get('/child/:childId/timeline', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const cid = parseInt(req.params.childId, 10);
    const [diary, obs] = await Promise.all([
      db.query(`
        SELECT id, date, mood, meals, lunch, naps, sleep_from, sleep_to, nappy, nappy_time,
               milk_amount_ml, milk_time, activities, notes, photo_urls, finalised_at
        FROM daily_diary
        WHERE child_id=$1 AND shared_with_parents=true
        ORDER BY date DESC LIMIT 60
      `, [cid]),
      db.query(`
        SELECT o.id, o.title, o.observation_text, o.eyfs_areas, o.photo_urls, o.created_at,
               s.first_name AS staff_first_name
        FROM observations o LEFT JOIN staff s ON s.id = o.staff_id
        WHERE o.child_id=$1 AND o.shared_with_parents=true
        ORDER BY o.created_at DESC LIMIT 60
      `, [cid]),
    ]);
    const names = await getChildNames(db);
    const items = [];
    for (const d of diary.rows) {
      items.push({
        kind: 'diary', id: d.id, at: d.date, finalised: !!d.finalised_at,
        mood: d.mood, meals: d.meals, lunch: d.lunch, naps: d.naps,
        sleep_from: d.sleep_from, sleep_to: d.sleep_to,
        nappy: d.nappy, nappy_time: d.nappy_time,
        milk_amount_ml: d.milk_amount_ml, milk_time: d.milk_time,
        activities: redactOthers(d.activities, cid, names),
        notes: redactOthers(d.notes, cid, names),
        photo_urls: d.photo_urls || [],
      });
    }
    for (const o of obs.rows) {
      items.push({
        kind: 'observation', id: o.id, at: o.created_at,
        title: redactOthers(o.title, cid, names),
        text: redactOthers(o.observation_text, cid, names),
        eyfs_areas: o.eyfs_areas || [], staff: o.staff_first_name || null,
        photo_urls: o.photo_urls || [],
      });
    }
    items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
    res.json(items.slice(0, 80));
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

// ── Parent-facing reports — list reports shared by staff ─────────────
// GET /report — all reports (from both reports + parent_reports tables)
// shared_with the parent's child. Parents see shared_with_parents=true
// on the reports table, or draft/finalised status on parent_reports.
router.get('/report', async (req, res) => {
  try {
    const db = getPool();
    const ownChildId = req.user.child_id || (req.user.child_ids && req.user.child_ids[0]);
    if (!ownChildId) return res.json({ reports: [] });

    // Gather child IDs the parent can see
    const allowedChildren = req.user.child_ids || (req.user.child_id ? [req.user.child_id] : []);
    const placeholders = allowedChildren.map((_, i) => `$${i + 1}`).join(',');

    // Reports table (staff-facing)
    const r1 = await db.query(`
      SELECT r.id, r.report_type, r.created_at, r.shared_with_parents,
             'staff' as _source
      FROM reports r
      WHERE r.shared_with_parents = true
        AND r.child_id IN (${placeholders})
    `, allowedChildren).catch(() => ({ rows: [] }));

    // Parent reports table (parent-facing workflow)
    const r2 = await db.query(`
      SELECT pr.id, pr.report_type, pr.generated_at as created_at,
             pr.status, pr.finalised_at,
             'parent' as _source
      FROM parent_reports pr
      WHERE pr.child_id IN (${placeholders})
    `, allowedChildren).catch(() => ({ rows: [] }));

    // Merge and de-duplicate by ID
    const seen = new Set();
    const all = [...r1.rows.map(r => ({
      ...r,
      child_id: ownChildId,
      acknowledged_at: r.shared_with_parents ? null : r.shared_with_parents,
    })), ...r2.rows.map(r => ({
      id: r.id,
      report_type: r.report_type,
      created_at: r.created_at,
      status: r.status,
      finalised_at: r.finalised_at,
      child_id: ownChildId,
      _source: r._source,
      ack: r.status === 'sent' || r.status === 'finalised',
    }))];

    res.json({ reports: all.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /child/:childId/home-log – quick log entries from home
router.post('/child/:childId/home-log', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { entry_type, data, source = 'home' } = req.body;
    await db.query(`INSERT INTO daily_diary (child_id, date, entry_type, notes, source) VALUES ($1, NOW(), $2, $3, $4)`,
      [req.params.childId, entry_type, JSON.stringify(data), source]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/home-log – list home log entries
router.get('/child/:childId/home-log', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { from, to } = req.query;
    let query = `SELECT * FROM daily_diary WHERE child_id=$1 AND source='home'`;
    const params = [req.params.childId];
    if (from) { query += ` AND date >= $${params.length+1}`; params.push(from); }
    if (to) { query += ` AND date <= $${params.length+1}`; params.push(to); }
    const { rows } = await db.query(query, params);
    res.json({ entries: rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── About Me: parent-editable (build 75c, 2026-07-09) ─────────────────────────
// Parents read/update the soft "all about me" fields for their OWN child only.
// Medical/contact data is NOT editable here — that goes through change requests.
const ABOUT_ME_PARENT_FIELDS = [
  'comforter', 'interests', 'skills', 'fears', 'comforts', 'sleep_pattern', 'sleep_routine',
  'sleep_location', 'milk_type', 'milk_amount_ml', 'feeds_per_day', 'words_they_use',
  'toileting_stage', 'potty_training', 'nappy_size', 'nappy_type', 'food_preferences',
  'special_days', 'first_language', 'other_languages',
];

router.get('/child/:childId/about-me', childGuard, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT ${ABOUT_ME_PARENT_FIELDS.join(',')}, last_updated_at FROM child_about_me WHERE child_id=$1`,
      [req.params.childId]);
    res.json(rows[0] || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/child/:childId/about-me', childGuard, async (req, res) => {
  const sets = [], vals = [];
  for (const k of ABOUT_ME_PARENT_FIELDS) {
    if (k in (req.body || {})) { vals.push(req.body[k] === '' ? null : req.body[k]); sets.push(`${k}=$${vals.length}`); }
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  try {
    const db = getPool();
    vals.push(req.params.childId);
    const { rowCount } = await db.query(
      `UPDATE child_about_me SET ${sets.join(',')}, last_updated_at=now() WHERE child_id=$${vals.length}`, vals);
    if (!rowCount) {
      await db.query(
        `INSERT INTO child_about_me (child_id, ${sets.map(s => s.split('=')[0]).join(',')}, last_updated_at)
         VALUES ($${vals.length}, ${sets.map((_, i) => '$' + (i + 1)).join(',')}, now())`, vals);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Change requests: allergy / details — never applied silently (build 75d) ───
router.post('/child/:childId/change-request', childGuard, async (req, res) => {
  const { kind, detail } = req.body || {};
  if (!['allergy_add', 'allergy_remove', 'details_change'].includes(kind) || !detail || typeof detail !== 'object') {
    return res.status(400).json({ error: 'kind (allergy_add|allergy_remove|details_change) and detail required' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO parent_change_requests (child_id, parent_email, kind, detail)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`,
      [req.params.childId, req.user.email || null, kind, JSON.stringify(detail)]);
    // Tell staff a request is waiting (best-effort).
    try {
      await db.query(
        `INSERT INTO notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
         VALUES ('all-staff', NULL, 'parent_request', $1, $2, '/app.html#children', 'parent_change_requests', $3, $4)`,
        [`Parent change request (${kind.replace('_', ' ')})`,
         `A parent submitted a ${kind.replace('_', ' ')} request — review it in Roost.`,
         rows[0].id, kind === 'allergy_add' ? 'high' : 'normal']);
    } catch (nErr) { console.error('[parents/change-request] notification failed (non-fatal):', nErr.message); }
    res.status(201).json({ ok: true, id: rows[0].id, status: 'pending' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/child/:childId/change-requests', childGuard, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, kind, detail, status, created_at, decided_at FROM parent_change_requests
       WHERE child_id=$1 ORDER BY created_at DESC LIMIT 20`, [req.params.childId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /child/:childId/medicine-consent — parent submits medicine consent/request
router.post('/child/:childId/medicine-consent', childGuard, async (req, res) => {
  try {
    const db = getPool();
    const { medicine_name, dose, reason, valid_from, valid_to } = req.body;
    if (!medicine_name || !dose || !reason || !valid_from || !valid_to) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    const { rows } = await db.query(`
      INSERT INTO parent_medicine_consents (child_id, parent_email, medicine_name, dose, reason, valid_from, valid_to)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `, [req.params.childId, req.user.email, medicine_name, dose, reason, valid_from, valid_to]);

    // Raise all-staff notification
    const child = await db.query('SELECT first_name, last_name FROM children WHERE id=$1', [req.params.childId]);
    const childName = child.rows[0] ? `${child.rows[0].first_name} ${child.rows[0].last_name}` : 'Child';
    await db.query(`
      INSERT INTO notifications (recipient_type, recipient_id, category, title, body, related_table, related_id)
      SELECT 'staff', id, 'medicine', $1, $2, 'parent_medicine_consents', $3
      FROM staff WHERE is_active=true
    `, [
      'Parent Medicine Consent Submitted',
      `${childName}: ${medicine_name} - ${reason}`,
      rows[0].id
    ]);

    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /child/:childId/medicine-consents — parent views their submitted consents
router.get('/child/:childId/medicine-consents', childGuard, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, medicine_name, dose, reason, valid_from, valid_to, status, created_at, acknowledged_at
      FROM parent_medicine_consents
      WHERE child_id=$1
      ORDER BY created_at DESC
    `, [req.params.childId]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;

