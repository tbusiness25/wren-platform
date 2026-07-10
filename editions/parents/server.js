// Load .env only as fallback — container env vars take priority
require('dotenv').config({ path: __dirname + '/.env', override: false });
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const app = express();
app.set('trust proxy', 1);

app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(require('cors')({ origin: process.env.ALLOWED_ORIGIN || false, credentials: true }));
app.use(require('helmet')({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    }
  }
}));
app.get('/', (req, res) => res.redirect('/welcome'));
// no-cache for /js/wren-shell.js and /js/wren-module-renderer.js — these change often during development
app.use((req, res, next) => {
  if (req.path === '/js/wren-shell.js' || req.path === '/js/wren-module-renderer.js') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, '../../public')));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth',      require('../../src/routes/auth'));
app.use('/api/parents',   require('../../src/routes/parents'));
app.use('/api/planning',  require('../../src/routes/planning'));
app.use('/api/messages',  require('../../src/routes/messages'));
app.use('/api/survey',    require('../../src/routes/survey'));
app.use('/api/ai',        require('../../src/routes/ai'));

// ── Prompt 13 — memory box (parent read-only, scoped to CF email) ────────────
app.get('/api/memory-box', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(
      'SELECT child_id FROM ladn.parent_portal_access WHERE lower(email)=$1 AND is_active=true',
      [email]
    );
    const childIds = childRes.rows.map(r => r.child_id);
    if (!childIds.length) return res.json({ entries: [], children: [] });
    const { rows } = await pool.query(`
      SELECT mb.id, mb.child_id, mb.title, mb.description, mb.happened_on,
             mb.milestone_type, mb.created_at,
             c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as added_by_name
      FROM ladn.memory_box_entries mb
      LEFT JOIN ladn.children c ON c.id = mb.child_id
      LEFT JOIN ladn.staff s ON s.id = mb.added_by
      WHERE mb.child_id = ANY($1::int[]) AND mb.is_shared_with_parent = true
      ORDER BY mb.happened_on DESC, mb.created_at DESC
    `, [childIds]);
    const cRes = await pool.query(
      'SELECT id, first_name, last_name FROM ladn.children WHERE id = ANY($1::int[])',
      [childIds]
    );
    res.json({ entries: rows, children: cRes.rows });
  } catch (e) {
    console.error('parents memory-box:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.use('/api/modules',        require('../../src/routes/modules'));
app.use('/api/study',          require('../../src/routes/study'));
app.use('/api/menus',          require('../../src/routes/menus'));
app.use('/api/notifications',  require('../../src/routes/notifications'));

// ── PDF export (Prompt 08) — parent-scoped (role=parent guard in route) ──────
app.use('/api/export',         require('../../src/routes/export'));

// Parents-portal: scope /api/module-uploads/:id to the authenticated parent's children only.
// Must be registered before the shared uploadsHandler so next() chains through correctly.
app.get('/api/module-uploads/:id', async (req, res, next) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).send('Not authenticated');
  const pool = require('../../src/db/pool').getPool();
  try {
    const uploadRes = await pool.query(`
      SELECT u.record_id, r.entity_type, r.entity_id, r.related_ids, m.portals
      FROM ladn.module_uploads u
      LEFT JOIN ladn.module_records r ON r.id = u.record_id
      LEFT JOIN ladn.modules m ON m.id = r.module_id
      WHERE u.id = $1
    `, [req.params.id]);
    if (!uploadRes.rows.length) return res.status(404).send('Not found');
    const { entity_type, entity_id, related_ids, portals } = uploadRes.rows[0];
    if (!portals || !Array.isArray(portals) || !portals.includes('parents')) return res.status(403).send('Forbidden');
    const childRes = await pool.query(
      'SELECT child_id FROM ladn.parent_portal_access WHERE lower(email) = $1 AND is_active = true',
      [email]
    );
    const childIds = childRes.rows.map(r => r.child_id);
    if (!childIds.length) return res.status(403).send('Forbidden');
    const isChildRec = entity_type === 'child' && childIds.includes(parseInt(entity_id));
    const isRelated = related_ids && Array.isArray(related_ids.child) &&
                      related_ids.child.some(id => childIds.includes(parseInt(id)));
    if (!isChildRec && !isRelated) return res.status(403).send('Forbidden');
    next();
  } catch (e) {
    console.error('upload-scope error:', e.message);
    res.status(500).send('Internal error');
  }
});
app.use('/api/module-uploads', require('../../src/routes/modules').uploadsHandler);

app.get('/api/edition', (req, res) => res.json({ edition: 'parents', schema: 'ladn', demo: false }));
app.get('/health', (req, res) => res.json({ ok: true, edition: 'parents' }));

// ── /welcome area — served before catch-all ──────────────────────────────
const fs = require('fs');
const WELCOME = path.join(__dirname, 'welcome');

app.get('/welcome', (req, res) => res.sendFile(path.join(WELCOME, 'home.html')));
app.get('/welcome/planning', (req, res) => res.sendFile(path.join(WELCOME, 'planning.html')));
app.get('/welcome/surveys', (req, res) => res.sendFile(path.join(WELCOME, 'surveys.html')));
app.get('/welcome/newsletter', (req, res) => res.sendFile(path.join(WELCOME, 'newsletter.html')));
app.get('/welcome/menu', (req, res) => res.sendFile(path.join(WELCOME, 'menu.html')));
app.get('/welcome/memory-box', (req, res) => res.sendFile(path.join(WELCOME, 'memory-box.html')));

// ── Study module routes ───────────────────────────────────────────────────────
app.get('/welcome/study', (req, res) => res.sendFile(path.join(WELCOME, 'study.html')));
app.get('/welcome/study/rewards', (req, res) => res.sendFile(path.join(WELCOME, 'study-rewards.html')));
app.get('/welcome/study/:slug/completed', (req, res) => res.sendFile(path.join(WELCOME, 'study-completed.html')));
app.get('/welcome/study/:slug', (req, res) => res.sendFile(path.join(WELCOME, 'study-module.html')));

app.get('/welcome/surveys/annual', (req, res) => {
  const email = req.headers['cf-access-authenticated-user-email'] || '';
  fs.readFile(path.join(WELCOME, 'survey-annual.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Survey unavailable');
    res.type('html').send(html.replace('__CF_EMAIL__', email));
  });
});

app.get('/welcome/surveys/eylog', (req, res) => {
  const email = req.headers['cf-access-authenticated-user-email'] || '';
  fs.readFile(path.join(WELCOME, 'survey-eylog.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Survey unavailable');
    res.type('html').send(html.replace('__CF_EMAIL__', email));
  });
});

// Dynamic template-driven survey renderer — must come after literal /annual and /eylog routes
app.get('/welcome/surveys/:slug', (req, res) => {
  res.sendFile(path.join(WELCOME, 'survey-render.html'));
});

// ── Resources: parents folder mirrored from gdrive (read-only) ───────────
const RESOURCES_ROOT = process.env.RESOURCES_ROOT || '/app/parents-resources';

function safeResourcePath(req) {
  const raw = (req.query.path || '').toString();
  if (raw.includes('..') || raw.includes('\\')) return null;
  const clean = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  const abs = path.join(RESOURCES_ROOT, clean);
  if (!abs.startsWith(RESOURCES_ROOT)) return null;
  return abs;
}

app.get('/welcome/homework', (req, res) => res.sendFile(path.join(WELCOME, 'homework.html')));
app.get('/welcome/calendar', (req, res) => res.sendFile(path.join(WELCOME, 'calendar.html')));
app.get('/welcome/action-plans', (req, res) => res.sendFile(path.join(WELCOME, 'action-plans.html')));
app.get('/welcome/phonics', (req, res) => res.sendFile(path.join(WELCOME, 'phonics.html')));
app.get('/welcome/records', (req, res) => res.sendFile(path.join(WELCOME, 'records.html')));
app.get('/welcome/payments', (req, res) => res.sendFile(path.join(WELCOME, 'payments.html')));
app.get('/welcome/dd-setup', (req, res) => res.sendFile(path.join(WELCOME, 'dd-setup.html')));
app.get('/welcome/resources', (req, res) => res.sendFile(path.join(WELCOME, 'resources.html')));

// GET /welcome/resources/api/tree — full folder hierarchy (no files)
app.get('/welcome/resources/api/tree', (req, res) => {
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return []; }
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({
        name: e.name,
        children: walk(path.join(dir, e.name))
      }));
  }
  try {
    res.json(walk(RESOURCES_ROOT));
  } catch (e) {
    res.status(500).json({ error: 'Resources unavailable' });
  }
});

// GET /welcome/resources/api/list?path=folder/sub — folders + files at given path
app.get('/welcome/resources/api/list', (req, res) => {
  const abs = safeResourcePath(req);
  if (!abs) return res.status(400).json({ error: 'Bad path' });
  fs.readdir(abs, { withFileTypes: true }, (err, entries) => {
    if (err) return res.status(404).json({ error: 'Not found' });
    const folders = [];
    const files = [];
    entries
      .filter(e => !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(e => {
        if (e.isDirectory()) {
          let itemCount = 0;
          try {
            itemCount = fs.readdirSync(path.join(abs, e.name)).filter(n => !n.startsWith('.')).length;
          } catch (_) {}
          folders.push({ name: e.name, itemCount });
        } else if (e.isFile()) {
          let size = 0;
          try { size = fs.statSync(path.join(abs, e.name)).size; } catch (_) {}
          files.push({ name: e.name, size });
        }
      });
    res.json({ folders, files });
  });
});

// GET /welcome/resources/file?path=folder/file.pdf — stream a file inline
app.get('/welcome/resources/file', (req, res) => {
  const abs = safeResourcePath(req);
  if (!abs) return res.status(400).send('Bad path');
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) return res.status(404).send('Not found');
    // sensible inline display; browsers that can't preview will download
    res.setHeader('Content-Disposition', 'inline; filename="' + path.basename(abs).replace(/"/g, '') + '"');
    res.sendFile(abs);
  });
});


// ── /welcome/memory-box ──────────────────────────────────────────────────────

app.get('/welcome/phonics', (req, res) => res.sendFile(path.join(WELCOME, 'phonics.html')));

// ── Phonics — parent-scoped endpoints ────────────────────────────────────────

function expectedPhaseFromDob(dob) {
  if (!dob) return 1;
  const birth = new Date(dob);
  const now = new Date();
  const ageMonths = (now.getFullYear() - birth.getFullYear()) * 12 + (now.getMonth() - birth.getMonth());
  if (ageMonths < 48) return 1;
  if (ageMonths < 54) return 2;
  if (ageMonths < 60) return 3;
  if (ageMonths < 72) return 4;
  if (ageMonths < 84) return 5;
  return 6;
}

app.get('/api/phonics/parent/overview', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(
      `SELECT c.id, c.first_name, c.last_name, c.date_of_birth
       FROM ladn.parent_portal_access pa
       JOIN ladn.children c ON c.id = pa.child_id
       WHERE lower(pa.email)=$1 AND pa.is_active=true
       ORDER BY c.first_name LIMIT 1`,
      [email]
    );
    if (!childRes.rows.length) return res.json({ child: null, progress: [], expected_phase: 1 });
    const child = childRes.rows[0];
    const expectedPhase = expectedPhaseFromDob(child.date_of_birth);

    const progressRes = await pool.query(`
      SELECT ps.id as sound_id, ps.phase, ps.sound_code, ps.sound_type,
             ps.example_words, ps.pronunciation_guide, ps.rwi_action, ps.position_in_phase,
             cpp.confidence, cpp.last_assessed_at, cpp.notes
      FROM ladn.phonics_sounds ps
      LEFT JOIN ladn.child_phonics_progress cpp
        ON cpp.sound_id = ps.id AND cpp.child_id = $1
      WHERE ps.phase <= $2
      ORDER BY ps.phase, ps.position_in_phase
    `, [child.id, expectedPhase + 1]);

    res.json({ child, progress: progressRes.rows, expected_phase: expectedPhase });
  } catch(e) {
    console.error('phonics parent overview:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.post('/api/phonics/parent/game-session', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(
      'SELECT child_id FROM ladn.parent_portal_access WHERE lower(email)=$1 AND is_active=true LIMIT 1',
      [email]
    );
    if (!childRes.rows.length) return res.status(403).json({ error: 'Forbidden' });
    const childId = childRes.rows[0].child_id;
    const { game_type, phase, score, duration_seconds,
            correct_count, attempted_count, sounds_practiced } = req.body;
    // Verify child_id matches parent's child
    const { rows } = await pool.query(`
      INSERT INTO ladn.phonics_game_sessions
        (child_id, game_type, phase, score, duration_seconds, correct_count, attempted_count, sounds_practiced)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [childId, game_type, phase, score, duration_seconds, correct_count, attempted_count,
        sounds_practiced && sounds_practiced.length ? sounds_practiced : null]);
    res.json({ ok: true, id: rows[0].id });
  } catch(e) {
    console.error('phonics game session:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

app.get('/welcome/memory-box', (req, res) => res.sendFile(path.join(WELCOME, 'memory-box.html')));
app.get('/welcome/menu', (req, res) => res.sendFile(path.join(WELCOME, 'menu.html')));

// ── /welcome/records — read-only parent records viewer ──────────────────────

app.get('/welcome/records', (req, res) => res.sendFile(path.join(WELCOME, 'records.html')));

// BFF: returns all children + scoped module records for the authenticated parent
app.get('/welcome/records/api/my-records', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(`
      SELECT c.id, c.first_name, c.last_name, c.room_id
      FROM ladn.parent_portal_access pa
      JOIN ladn.children c ON c.id = pa.child_id
      WHERE lower(pa.email) = $1 AND pa.is_active = true
      ORDER BY c.first_name
    `, [email]);
    const children = childRes.rows;
    if (!children.length) return res.json({ children: [], modules: [], records: [] });
    const childIds = children.map(c => c.id);

    const modRes = await pool.query(`
      SELECT id, slug, name, description, icon, attaches_to, fields
      FROM ladn.modules
      WHERE is_active = true
        AND portals @> '["parents"]'::jsonb
        AND (permissions->'parents'->'parent') @> '["view_own_child"]'::jsonb
      ORDER BY name
    `);
    const modules = modRes.rows;
    if (!modules.length) return res.json({ children, modules: [], records: [] });

    const applicableModules = modules.filter(m => m.attaches_to === 'child' || m.attaches_to === 'multi');
    const moduleIds = applicableModules.map(m => m.id);
    let records = [];
    if (moduleIds.length) {
      const recRes = await pool.query(`
        SELECT id, module_id, entity_type, entity_id, data, submitted_at, submitted_portal, related_ids
        FROM ladn.module_records
        WHERE module_id = ANY($1::int[])
          AND is_deleted = false
          AND (
            (entity_type = 'child' AND entity_id = ANY($2::int[]))
            OR
            (related_ids->'child' ?| ARRAY(SELECT i::text FROM unnest($2::int[]) AS i))
          )
        ORDER BY submitted_at DESC
        LIMIT 500
      `, [moduleIds, childIds]);
      records = recRes.rows;
    }

    res.json({ children, modules, records });
  } catch (e) {
    console.error('my-records error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Single record fetch — scoped to the parent's children
app.get('/welcome/records/api/module/:moduleId/record/:recordId', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(
      'SELECT child_id FROM ladn.parent_portal_access WHERE lower(email) = $1 AND is_active = true',
      [email]
    );
    const childIds = childRes.rows.map(r => r.child_id);
    if (!childIds.length) return res.status(404).json({ error: 'Not found' });

    const rec = await pool.query(`
      SELECT r.*, m.slug, m.name AS module_name, m.fields, m.icon, m.attaches_to
      FROM ladn.module_records r
      JOIN ladn.modules m ON m.id = r.module_id
      WHERE r.id = $1
        AND r.module_id = $2
        AND r.is_deleted = false
        AND m.is_active = true
        AND m.portals @> '["parents"]'::jsonb
        AND (
          (r.entity_type = 'child' AND r.entity_id = ANY($3::int[]))
          OR (related_ids->'child' ?| ARRAY(SELECT i::text FROM unnest($3::int[]) AS i))
        )
    `, [req.params.recordId, req.params.moduleId, childIds]);

    if (!rec.rows.length) return res.status(404).json({ error: 'Not found' });

    const record = rec.rows[0];
    const uploads = await pool.query(
      'SELECT id, field_key, filename FROM ladn.module_uploads WHERE record_id = $1',
      [record.id]
    );
    record._uploads = uploads.rows.map(u => ({ ...u, url: `/api/module-uploads/${u.id}` }));

    res.json(record);
  } catch (e) {
    console.error('single-record error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Primary school demo: homework + calendar (demo_primary schema) ────────────────────────
const { Pool: PrimaryPool } = require('pg');
function getPrimaryPool() {
  if (!getPrimaryPool._p) {
    getPrimaryPool._p = new PrimaryPool({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432'),
      database: process.env.PG_DB || 'wren',
      user: process.env.PG_USER || 'wren',
      password: process.env.PG_PASSWORD,
      options: '-c search_path=demo_primary,public',
      max: 4,
    });
  }
  return getPrimaryPool._p;
}

// GET /welcome/homework
app.get('/welcome/homework', (req, res) => res.sendFile(path.join(WELCOME, 'homework.html')));

// GET /welcome/calendar
app.get('/welcome/calendar', (req, res) => res.sendFile(path.join(WELCOME, 'calendar.html')));

// GET /api/primary-demo/homework — published homework for all active classes
app.get('/api/primary-demo/homework', async (req, res) => {
  try {
    const db = getPrimaryPool();
    const { rows } = await db.query(`
      SELECT h.id, h.title, h.description, h.due_date, h.type,
             h.estimated_duration_minutes, h.external_resource_url, h.attachment_paths,
             c.name AS class_name, c.id AS class_id, c.year_group,
             s.name AS subject_name
      FROM demo_primary.homework h
      LEFT JOIN demo_primary.classes c ON c.id=h.class_id
      LEFT JOIN demo_primary.subjects s ON s.id=h.subject_id
      WHERE h.is_published=true
      ORDER BY h.due_date ASC, h.set_at DESC
      LIMIT 50
    `);
    const childRes = await db.query(`SELECT id, first_name, last_name FROM demo_primary.children WHERE is_active=true ORDER BY first_name LIMIT 100`);
    res.json({ homework: rows, children: childRes.rows });
  } catch (e) {
    console.error('primary-demo homework:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/primary-demo/homework/:id/done — mark homework as done (writes submission)
app.post('/api/primary-demo/homework/:id/done', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const db = getPrimaryPool();
    const hwId = parseInt(req.params.id);
    const { pupil_id, content } = req.body;
    // Use a placeholder pupil_id = 1 if not provided (demo mode)
    const pid = pupil_id || 1;
    const existing = await db.query(
      'SELECT id FROM demo_primary.homework_submissions WHERE homework_id=$1 AND pupil_id=$2',
      [hwId, pid]
    );
    if (existing.rows.length) {
      await db.query(
        'UPDATE demo_primary.homework_submissions SET completed_at=now(), content=$1, parent_acknowledged=true WHERE id=$2',
        [content || null, existing.rows[0].id]
      );
    } else {
      await db.query(
        `INSERT INTO demo_primary.homework_submissions (homework_id,pupil_id,completed_at,content,parent_acknowledged)
         VALUES ($1,$2,now(),$3,true)`,
        [hwId, pid, content || null]
      );
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('primary-demo homework done:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/primary-demo/calendar — unified school calendar events
app.get('/api/primary-demo/calendar', async (req, res) => {
  try {
    const db = getPrimaryPool();
    const events = [];

    // Terms (as banner events)
    const terms = await db.query('SELECT * FROM demo_primary.terms ORDER BY start_date');
    for (const t of terms.rows) {
      events.push({ title: `📅 ${t.name}`, start: t.start_date, end: t.end_date, type: 'term', colour: '#4a9abf' });
      if (t.half_term_start) events.push({ title: `Half term`, start: t.half_term_start, end: t.half_term_end, type: 'half_term', colour: '#e07820' });
    }

    // Announcements with event_date set
    const anns = await db.query(`SELECT title, valid_from AS event_date, body AS description FROM demo_primary.school_announcements WHERE valid_from IS NOT NULL ORDER BY valid_from`);
    for (const a of anns.rows) {
      events.push({ title: `📢 ${a.title}`, start: a.event_date, type: 'announcement', colour: '#8b5cf6', description: a.description });
    }

    // School trips
    const trips = await db.query('SELECT * FROM demo_primary.school_trips ORDER BY trip_date');
    for (const t of trips.rows) {
      events.push({ title: `🚌 ${t.name}`, start: t.trip_date, end: t.return_time ? t.trip_date : null, type: 'trip', colour: '#22c55e', description: `To ${t.destination||'—'}` });
    }

    // Parents' evening slots (unique dates)
    const pe = await db.query('SELECT DISTINCT slot_date FROM demo_primary.parents_evening_slots ORDER BY slot_date');
    for (const p of pe.rows) {
      events.push({ title: `👨‍👩‍👧 Parents Evening`, start: p.slot_date, type: 'parents_evening', colour: '#f59e0b' });
    }

    // School clubs (first session of each club)
    const clubs = await db.query('SELECT name, day_of_week FROM demo_primary.school_clubs WHERE is_active=true ORDER BY name');
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    for (const c of clubs.rows) {
      events.push({ title: `🎨 ${c.name}`, recurring: `Weekly ${days[c.day_of_week]||''}`, type: 'club', colour: '#06b6d4', day_of_week: c.day_of_week });
    }

    res.json(events);
  } catch (e) {
    console.error('primary-demo calendar:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/primary-demo/calendar-token — generate or return ICS subscribe token
app.get('/api/primary-demo/calendar-token', async (req, res) => {
  const cryptoMod = require('crypto');
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim() || 'demo@wren.test';
  try {
    const db = getPrimaryPool();
    const { rows } = await db.query(`SELECT calendar_token FROM demo_primary.parent_portal_access WHERE lower(email)=$1 AND is_active=true LIMIT 1`, [email]);
    if (rows.length && rows[0].calendar_token) return res.json({ token: rows[0].calendar_token });
    const token = cryptoMod.randomBytes(32).toString('hex');
    try { await db.query(`UPDATE demo_primary.parent_portal_access SET calendar_token=$1 WHERE lower(email)=$2`, [token, email]); } catch (_) {}
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/primary-demo/calendar.ics?token=XXX
app.get('/api/primary-demo/calendar.ics', async (req, res) => {
  try {
    const db = getPrimaryPool();
    const icsLines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Wren//School Calendar//EN','X-WR-CALNAME:School Calendar'];
    const { rows: terms } = await db.query('SELECT * FROM demo_primary.terms ORDER BY start_date');
    const { rows: trips } = await db.query('SELECT * FROM demo_primary.school_trips ORDER BY trip_date');
    const { rows: pe } = await db.query('SELECT DISTINCT slot_date FROM demo_primary.parents_evening_slots ORDER BY slot_date');
    const { rows: anns } = await db.query('SELECT * FROM demo_primary.school_announcements WHERE valid_from IS NOT NULL');
    const pushEv = (summary, dtstart, dtend, uid, desc) => {
      const s = String(dtstart).slice(0,10).replace(/-/g,'');
      const e = dtend ? String(dtend).slice(0,10).replace(/-/g,'') : '';
      icsLines.push('BEGIN:VEVENT');
      icsLines.push(`DTSTART;VALUE=DATE:${s}`);
      if (e && e!==s) icsLines.push(`DTEND;VALUE=DATE:${e}`);
      icsLines.push(`SUMMARY:${summary.replace(/[\r\n]/g,' ')}`);
      icsLines.push(`UID:${uid}`);
      if (desc) icsLines.push(`DESCRIPTION:${desc.replace(/[\r\n]/g,' ').slice(0,200)}`);
      icsLines.push('END:VEVENT');
    };
    terms.forEach(t => { pushEv(t.name, t.start_date, t.end_date, `term-${t.id}@wren`, ''); if (t.half_term_start) pushEv('Half Term', t.half_term_start, t.half_term_end, `ht-${t.id}@wren`, ''); });
    trips.forEach(t => pushEv(`Trip: ${t.name}`, t.trip_date, t.trip_date, `trip-${t.id}@wren`, `To ${t.destination||'—'}`));
    pe.forEach(p => pushEv("Parents' Evening", p.slot_date, p.slot_date, `pe-${p.slot_date}@wren`, ''));
    anns.forEach(a => pushEv(a.title, a.valid_from, a.valid_from, `ann-${a.id}@wren`, (a.body||'').slice(0,200)));
    icsLines.push('END:VCALENDAR');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="school-calendar.ics"');
    res.send(icsLines.join('\r\n'));
  } catch (e) { res.status(500).send('Calendar generation failed'); }
});

// GET /api/primary-demo/behaviour-recognition — latest positive points for parent's children
app.get('/api/primary-demo/behaviour-recognition', async (req, res) => {
  try {
    const db = getPrimaryPool();
    const { rows } = await db.query(`
      SELECT bp.id, bp.category, bp.points, bp.awarded_at,
             CONCAT(ch.first_name,' ',ch.last_name) AS pupil_name,
             ch.first_name, c.name AS class_name
      FROM demo_primary.behaviour_points bp
      JOIN demo_primary.children ch ON ch.id=bp.pupil_id
      LEFT JOIN demo_primary.classes c ON c.year_group::text=ch.year_group
      WHERE bp.type='positive'
      ORDER BY bp.awarded_at DESC LIMIT 5
    `);
    res.json(rows);
  } catch (e) {
    console.error('primary-demo behaviour-recognition:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── External test flows (public — no auth, token-gated, Part 4 of security dashboard) ──
const crypto = require('crypto');
const { Pool: ExtPool } = require('pg');
function getExtPool() {
  if (!getExtPool._p) {
    getExtPool._p = new ExtPool({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5434'),
      database: process.env.PG_DB || 'wren',
      user: process.env.PG_USER || 'wren',
      password: process.env.PG_PASSWORD,
      options: '-c search_path=ladn,public',
      max: 3,
    });
  }
  return getExtPool._p;
}

// GET /external-test/:token — serve the in-browser test page
app.get('/external-test/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/external-test.html'));
});

// POST /api/security/external-test-result/:token — receives results from phone browser
app.post('/api/security/external-test-result/:token', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const db = getExtPool();
    const { rows: [row] } = await db.query(
      'SELECT id, expires_at, used_at FROM ladn.external_test_tokens WHERE token=$1', [req.params.token]
    );
    if (!row) return res.status(404).json({ error: 'Invalid token' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Token expired' });
    if (row.used_at) return res.status(409).json({ error: 'Token already used' });

    const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
    const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex');
    const ua = (req.headers['user-agent'] || '').slice(0, 500);

    await db.query(`
      UPDATE ladn.external_test_tokens
      SET used_at=now(), result_json=$1, visitor_user_agent=$2, visitor_ip_hash=$3
      WHERE id=$4
    `, [JSON.stringify(req.body || {}), ua, ipHash, row.id]);

    res.json({ ok: true });
  } catch (e) {
    console.error('[ext-test] result error:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Action Plans (parents read-only + comments, scope=parents-readonly) ───────

app.get('/welcome/action-plans', (req, res) => res.sendFile(path.join(WELCOME, 'action-plans.html')));

app.get('/api/action-plans', async (req, res) => {
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = require('../../src/db/pool').getPool();
  try {
    const { rows } = await db.query(`
      SELECT ap.*, ch.first_name || ' ' || ch.last_name AS child_name
      FROM ladn.action_plans ap
      LEFT JOIN ladn.children ch ON ch.id = ap.related_child_id
      WHERE ap.scope = 'parents-readonly'
        AND ap.archived_at IS NULL
        AND ap.related_child_id IN (
          SELECT child_id FROM ladn.parent_portal_access
          WHERE lower(email)=$1 AND is_active=true
        )
      ORDER BY ap.created_at DESC
    `, [email]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/action-plan-items', async (req, res) => {
  const planId = req.query.plan_id;
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = require('../../src/db/pool').getPool();
  try {
    const { rows: access } = await db.query(`
      SELECT 1 FROM ladn.action_plans ap
      JOIN ladn.parent_portal_access pa ON pa.child_id = ap.related_child_id
      WHERE ap.id=$1 AND ap.scope='parents-readonly' AND lower(pa.email)=$2 AND pa.is_active=true
    `, [planId, email]);
    if (!access.length) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await db.query(`
      SELECT i.*, s.first_name || ' ' || s.last_name AS assignee_name,
             (SELECT COUNT(*)::int FROM ladn.action_plan_comments c WHERE c.item_id=i.id) AS comment_count
      FROM ladn.action_plan_items i
      LEFT JOIN ladn.staff s ON s.id=i.assigned_staff_id
      WHERE i.plan_id=$1
      ORDER BY i.position ASC, i.deadline ASC NULLS LAST
    `, [planId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/action-plan-items/:id/comments', async (req, res) => {
  const db = require('../../src/db/pool').getPool();
  try {
    const { rows } = await db.query(`
      SELECT c.*,
             CASE WHEN c.author_type != 'parent' THEN s.first_name || ' ' || s.last_name ELSE 'You' END AS author_name
      FROM ladn.action_plan_comments c
      LEFT JOIN ladn.staff s ON s.id=c.author_id AND c.author_type != 'parent'
      WHERE c.item_id=$1 ORDER BY c.created_at ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action-plan-items/:id/comments', async (req, res) => {
  const commentBody = req.body?.body;
  if (!commentBody?.trim()) return res.status(400).json({ error: 'body required' });
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = require('../../src/db/pool').getPool();
  try {
    const { rows: access } = await db.query(`
      SELECT pa.child_id FROM ladn.action_plan_items i
      JOIN ladn.action_plans ap ON ap.id=i.plan_id
      JOIN ladn.parent_portal_access pa ON pa.child_id=ap.related_child_id
      WHERE i.id=$1 AND ap.scope='parents-readonly' AND lower(pa.email)=$2 AND pa.is_active=true
    `, [req.params.id, email]);
    if (!access.length) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await db.query(`
      INSERT INTO ladn.action_plan_comments (item_id, author_type, author_id, body)
      VALUES ($1, 'parent', 0, $2) RETURNING *
    `, [req.params.id, commentBody.trim()]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── iCal calendar feeds (child feed, child-token, school events) ──────────────
app.use('/api/calendar', require('../../src/routes/calendar-feeds'));

// ── Payments (parent-facing) ──────────────────────────────────────────────────
app.use('/api/payments', require('../../src/routes/payments'));
app.get('/welcome/payments',         (req, res) => res.sendFile(path.join(WELCOME, 'payments.html')));
app.get('/welcome/payments/success', (req, res) => res.sendFile(path.join(WELCOME, 'payments.html')));
app.get('/welcome/dd-setup',         (req, res) => res.sendFile(path.join(WELCOME, 'dd-setup.html')));

// ── Gov-Docs Corpus (parent-facing statutory docs) ────────────────────────────
app.use('/api/gov-corpus', require('../../src/routes/gov-corpus'));
app.get('/parents/policies-and-frameworks', (req, res) => res.sendFile(path.join(__dirname, 'public/parents/policies-and-frameworks.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

app.listen(process.env.PORT || 3000, () => console.log('Wren Parents running on :' + (process.env.PORT || 3000)));
