// Load .env only as fallback — container env vars take priority
require('dotenv').config({ path: __dirname + '/.env', override: false });
const express = require('express');
const path = require('path');
const scopeFilter = require('../../src/middleware/scope-filter');
const app = express();
app.set('trust proxy', 1);
// ── Payment webhooks — raw body needed, before express.json ──────────────────
const _webhooks = require('../../src/routes/payments-webhooks');
app.use('/api/stripe/webhook',     _webhooks.stripe);
app.use('/api/gocardless/webhook', _webhooks.gocardless);

app.use(express.json({ limit: '10mb' }));
app.use(require('cors')({ origin: process.env.ALLOWED_ORIGIN || false, credentials: true }));
app.use(require('helmet')({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc: ["'self'", "data:", "blob:", "https://www.twinkl.co.uk", "https://*.twinkl.co.uk", "https://ik.imagekit.io"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    }
  }
}));
app.use(scopeFilter);

// ── No-cache for all HTML responses ──────────────────────────────────────────
app.use((req, res, next) => {
  const orig = res.writeHead.bind(res);
  res.writeHead = function(statusCode, statusMessage, headers) {
    const ct = res.getHeader('Content-Type') || '';
    if (String(ct).includes('text/html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
      res.removeHeader('Last-Modified');
      res.removeHeader('ETag');
    }
    return orig(statusCode, statusMessage, headers);
  };
  next();
});

// ── First-run setup wizard gate (prompt 67) ─────────────────────────────────────
// Serve the wizard at /setup ONLY while settings.setup_complete is not 'true';
// after finish it 302s to login forever. Sub-assets (/setup/*) fall through to static.
const _setupPage = path.join(__dirname, '../../public/setup/index.html');
app.get(['/setup', '/setup/'], async (req, res) => {
  try {
    const { rows } = await require('../../src/db/pool').getPool()
      .query("SELECT value FROM settings WHERE key='setup_complete'");
    if (rows[0] && String(rows[0].value).toLowerCase() === 'true') return res.redirect(302, '/login.html');
  } catch (e) { /* fall through to wizard */ }
  res.sendFile(_setupPage);
});

// ── EY portal app-shell pages (ported from LADN 2026-07-14) ──────────────────
// Additive EY (early-years) surface for the secondary demo. Registered BEFORE
// express.static so bare /ey isn't directory-redirected and extensionless /ey/*
// paths don't fall through to the login SPA. This server has no per-hostname
// portal split (single app), so these are unconditional GET handlers.
// LADN-prod-only pages omitted: new-starters, send-email, enrol-device.
app.get('/ey', (req, res) => res.redirect(301, '/ey/home'));
app.get('/ey/home',            (req, res) => res.sendFile(path.join(__dirname, 'public/ey/home.html')));
app.get('/ey/child/:id',       (req, res) => res.sendFile(path.join(__dirname, 'public/ey/child.html')));
app.get('/ey/observation/new', (req, res) => res.sendFile(path.join(__dirname, 'public/ey/observation-new.html')));
app.get('/ey/observation/:id', (req, res) => res.sendFile(path.join(__dirname, 'public/ey/observation-view.html')));
['observation','sleep','nappies','food','bottle','toilet','diary'].forEach(t => {
  app.get(`/ey/group/${t}`, (req, res) => res.sendFile(path.join(__dirname, `public/ey/group/${t}.html`)));
});
// b139: how-wren-works/my-documents/new-starters added (generic, non-EYFS-specific product features)
['more','drafts','trackers','activities','reports','settings','help','register','kitchen','obs-tracker','my-shifts','messages','two-year-check','repairs','supervisions','action-plans','diary-all','sleep-chart','staff-clock','visitors','policies','how-wren-works','my-documents','new-starters','story-studio'].forEach(p => {
  app.get(`/ey/${p}`, (req, res) => res.sendFile(path.join(__dirname, `public/ey/${p}.html`)));
});
app.get('/ey/reports/summative',        (req, res) => res.sendFile(path.join(__dirname, 'public/ey/reports-summative.html')));
app.get('/ey/trackers/two-year-check',  (req, res) => res.sendFile(path.join(__dirname, 'public/ey/trackers.html')));
app.get('/ey/safeguarding/new',         (req, res) => res.sendFile(path.join(__dirname, 'public/ey/safeguarding-new.html')));
app.get('/ey/incident/new',             (req, res) => res.sendFile(path.join(__dirname, 'public/ey/incident-new.html')));
app.get('/ey/medicine/new',             (req, res) => res.sendFile(path.join(__dirname, 'public/ey/medicine-new.html')));
app.get('/ey/diary/entry',              (req, res) => res.sendFile(path.join(__dirname, 'public/ey/diary-entry.html')));
app.get('/ey/diary',                    (req, res) => res.sendFile(path.join(__dirname, 'public/ey/diary.html')));
app.get('/ey/inbox',                    (req, res) => res.sendFile(path.join(__dirname, 'public/ey/inbox.html')));
app.get('/ey/journey',                  (req, res) => res.sendFile(path.join(__dirname, 'public/ey/journey.html')));
app.get('/ey/log/select-action',        (req, res) => res.sendFile(path.join(__dirname, 'public/ey/log/select-action.html')));
app.use('/ey-legacy', express.static(path.join(__dirname, 'public/_legacy')));

// Secondary-specific HTML first, then shared public (CSS/JS) as fallback (b148: so
// this edition's own sw.js/manifest.webmanifest take precedence over the shared
// fallback of the same name).
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '../../public')));
// b152: secondary has no admin-portal hostname split (unlike eyfs/primary), so it never
// served editions/admin/public at all — every standalone Roost tool page (fee-schedule,
// recruitment, how-wren-works, fledge-framework, staff-celebrations, etc.) silently 200'd
// on the login-page catch-all below instead of 404ing, faking "present" in past parity
// passes. Registered last (after secondary's own public + shared public, which still win
// on any filename collision) so it only fills genuine gaps.
app.use(express.static(path.join(__dirname, '../admin/public')));

// Shared routes
['auth','children','staff','observations','attendance','diary','incidents','safeguarding',
 'absence','enquiries','admin','parents','ai','curriculum','reports','medicine',
 'sleep','behaviour','sen','cpd','planning','notifications',
 'phonics'].forEach(r => { // phonics added 2026-07-04 — page existed but API was unmounted (KS3 catch-up)
  try { app.use('/api/'+r, require('../../src/routes/'+r)); } catch(e) {}
});

// ── EY demo parity: additive mounts for pages ported from LADN (2026-07-14) ──
// Only routes the EY pages need that secondary did not already mount. Guarded so a
// missing module can never crash startup. two-year-checks omitted (no backing table).
['kitchen','messages','repairs','menu','activity-bank','first-words','action-plans','action-plan-items','parent-reports','rota','planned-activities','next-steps','visitors','funding'].forEach(r => {
  try { app.use('/api/'+r, require('../../src/routes/'+r)); } catch(e) { console.error('EY parity mount '+r+':', e.message); }
});
try { app.use('/api/daily-diary', require('../../src/routes/daily-diary-group')); } catch(e) { console.error('EY parity daily-diary:', e.message); }
// Framework statements has no standalone module — inline handler mirrors editions/eyfs.
try {
  const _fsAuth = require('../../src/middleware/auth');
  const _fsMap = { EYFS:'eyfs_statutory', CFE:'development_matters', DM:'development_matters', SEND:'send', Leuven:'leuven', Phonics:'phonics', ECERS:'ecers_3', ITERS:'iters_3' };
  app.get('/api/framework-statements', _fsAuth, async (req, res) => {
    const fw = _fsMap[req.query.framework] || req.query.framework || 'eyfs_statutory';
    if (['birth_to_5','eydj'].includes(fw)) return res.json([]); // product guard — LADN-only frameworks
    const area = req.query.area || null, q = req.query.q || null;
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const _fsPool = require('../../src/db/pool').getPool();
    const params = [fw];
    let sql = "SELECT id,framework,area,aspect,age_range,statement_code,statement_text,ordinal FROM framework_statements WHERE framework=$1 AND statement_text NOT LIKE '(stub%'";
    if (area) { params.push(area); sql += ` AND area=$${params.length}`; }
    if (q) { params.push(q); sql += ` AND (statement_text ILIKE '%'||$${params.length}||'%' OR area ILIKE '%'||$${params.length}||'%' OR aspect ILIKE '%'||$${params.length}||'%')`; }
    sql += ` ORDER BY framework, ordinal, id LIMIT $${params.length + 1}`; params.push(limit);
    try { const { rows } = await _fsPool.query(sql, params); res.json(rows); } catch(e) { res.status(500).json({ error: e.message }); }
  });
} catch(e) { console.error('framework-statements inline:', e.message); }

// ── Universal HR/ops parity ported from LADN (2026-06-18) — integration-only routes excluded ──
['occupancy','work-patterns','voice-notes','review','cockpit','contracts','handbook','contacts','ai-helper','staff-analytics','supervisions','performance'].forEach(r => {
  try { app.use('/api/'+r, require('../../src/routes/'+r)); } catch(e) { console.error('mount '+r+':', e.message); }
});
try { app.use('/api/documents/workspaces', require('../../src/routes/document-workspaces')); } catch(e) { console.error('mount documents/workspaces:', e.message); }

// ── b139 demo parity: generic product features ported from LADN (2026-07-22) ──
['occupancy-calendar','occupancy-sandbox','occupancy-v2','room-headcounts','fee-items','leave-weights','absence-fairness','sen-flag','custom-frameworks','person-documents','survey','comms','recruit','induction','story-studio','staff-occasions'].forEach(r => {
  try { app.use('/api/'+r, require('../../src/routes/'+r)); } catch(e) { console.error('mount '+r+':', e.message); }
});
try { app.use(require('../../src/routes/recruit-public')); } catch(e) { console.error('mount recruit-public:', e.message); }
// 2026-07-23 q01: /api/features/public was never mounted on this edition — wren-shell-v2.js
// calls it unconditionally on every page load, so every page 404'd on it (audit finding).
try { app.use('/api/features', require('../../src/routes/features')); } catch(e) { console.error('mount features:', e.message); }

try { app.use('/api/it-settings', require('../../src/routes/it-settings')); } catch(e) {}
// First-run setup wizard API (prompt 67) — unauthenticated + self-gated on settings.setup_complete
try { app.use('/api/setup', require('../../src/routes/setup')); } catch(e) { console.error('mount setup:', e.message); }
app.get('/api/frameworks', (req, res) => {
  const fs = require('fs'), p = require('path');
  try { res.json(JSON.parse(fs.readFileSync(p.join(__dirname, '../../data/framework-versions.json'), 'utf8'))); }
  catch { res.status(500).json({ error: 'Framework data unavailable' }); }
});

// Secondary-specific routes
try { app.use('/api/attendance-register', require('../../src/routes/attendance-register')); } catch(e) {}
try { app.use('/api/assessments-secondary', require('../../src/routes/assessments-secondary')); } catch(e) {}
try { app.use('/api/behaviour-secondary',   require('../../src/routes/behaviour-primary')); } catch(e) {}
try { app.use('/api/exclusions',            require('../../src/routes/exclusions')); } catch(e) {}
app.use('/api/menus', require('../../src/routes/menus'));

// School edition routes (shared with primary)
try { app.use('/api/homework',            require('../../src/routes/homework')); } catch(e) { console.error('homework route:', e.message); }
try { app.use('/api/classes',             require('../../src/routes/school-classes')); } catch(e) {}
try { app.use('/api/subjects',            require('../../src/routes/school-subjects')); } catch(e) {}
try { app.use('/api/clubs',               require('../../src/routes/school-clubs')); } catch(e) {}
try { app.use('/api/trips',               require('../../src/routes/school-trips')); } catch(e) {}
try { app.use('/api/teaching-resources',  require('../../src/routes/teaching-resources')); } catch(e) {}
try { app.use('/api/announcements',       require('../../src/routes/school-announcements')); } catch(e) {}
try { app.use('/api/behaviour-points',    require('../../src/routes/behaviour-points')); } catch(e) {}
try { app.use('/api/wellbeing',           require('../../src/routes/wellbeing')); } catch(e) {}
try { app.use('/api/policies',            require('../../src/routes/policies')); } catch(e) {}

// Secondary-only routes
try { app.use('/api/exam-entries',           require('../../src/routes/exam-entries')); } catch(e) { console.error('exam-entries route:', e.message); }
try { app.use('/api/detentions',             require('../../src/routes/detentions')); } catch(e) { console.error('detentions route:', e.message); }
try { app.use('/api/secondary-timetable',    require('../../src/routes/secondary-timetable')); } catch(e) { console.error('secondary-timetable route:', e.message); }
try { app.use('/api/timetable-generate',    require('../../src/routes/secondary-timetable-generate')); } catch(e) { console.error('timetable-generate route:', e.message); }
try { app.use('/api/timetable/parse-constraints', require('../../src/routes/parse-constraints')); } catch(e) { console.error('parse-constraints route:', e.message); }
try { app.use('/api/points',              require('../../src/routes/points')); } catch(e) { console.error('points route:', e.message); }
try { app.use('/api/points-admin',        require('../../src/routes/points-admin')); } catch(e) { console.error('points-admin route:', e.message); }
try { app.use('/api/classroom',           require('../../src/routes/classroom')); } catch(e) { console.error('classroom route:', e.message); }
try { app.use('/api/twinkl',              require('../../src/routes/twinkl')); } catch(e) { console.error('twinkl route:', e.message); }

// ── iCal calendar feeds (staff, class, school events) ────────────────────────
try { app.use('/api/calendar', require('../../src/routes/calendar-feeds')); } catch(e) { console.error('calendar-feeds route:', e.message); }

// ── Secondary-specific: student portal + parent portal ────────────────────
try {
  const secStudent = require('../../src/routes/secondary-student');
  app.use('/api/secondary-student', secStudent);
} catch(e) { console.error('secondary-student route:', e.message); }

try {
  const secParents = require('../../src/routes/secondary-parents');
  app.use('/api/secondary-parent', secParents);
} catch(e) { console.error('secondary-parents route:', e.message); }
try { app.use('/api/payments', require('../../src/routes/payments-parent')); } catch(e) { console.error('payments-parent route:', e.message); }

// ── CTF import/export ─────────────────────────────────────────────────────
try { app.use('/api/ctf', require('../../src/routes/ctf-primary')); } catch(e) { console.error('ctf route:', e.message); }

// ── Universal routes — API parity with LADN ───────────────────────────────────
app.use('/api/audit',              require('../../src/routes/audit'));
app.use('/api/clockin',            require('../../src/routes/clockin'));
app.use('/api/transcribe',         require('../../src/routes/transcribe'));
app.use('/api/interventions',      require('../../src/routes/intervention'));
app.use('/api/decision-log',       require('../../src/routes/decision-log'));
app.use('/api/permission-slips',   require('../../src/routes/permission-slips'));
app.use('/api/toil',               require('../../src/routes/toil'));
app.use('/api/courses',            require('../../src/routes/courses'));
app.use('/api/revision-cards',     require('../../src/routes/revision-cards')('revision-cards-secondary')); // b165
app.use('/api/finance/dashboard',  require('../../src/routes/finance-dashboard'));
app.use('/api/finance/forecast',   require('../../src/routes/finance-forecast'));
app.use('/api/finance/invoices',   require('../../src/routes/finance-invoices'));
app.use('/api/finance/reconcile',  require('../../src/routes/finance-reconcile'));
app.use('/api/finance/wages',      require('../../src/routes/finance-wages'));
app.use('/api/finance/payroll',    require('../../src/routes/finance-payroll'));
try { app.use('/api/workflows',          require('../../src/routes/workflows')); }          catch(e) { console.error('workflows:', e.message); }
try { app.use('/api/backup',             require('../../src/routes/backup')); }             catch(e) { console.error('backup:', e.message); }
try { app.use('/api/parent-permissions', require('../../src/routes/parent-permissions-matrix')); } catch(e) { console.error('parent-permissions:', e.message); }
try { app.use('/api/gias',               require('../../src/routes/gias')); }               catch(e) { console.error('gias:', e.message); }
try {
  const { externalRouter, staffExternalRouter } = require('../../src/routes/external-api');
  app.use('/api/external', externalRouter);
  app.use('/api/external', staffExternalRouter);
} catch(e) { console.error('external-api:', e.message); }
app.use('/api/insights',          require('../../src/routes/insights'));
try { app.use('/api/newsletter',  require('../../src/routes/newsletter')); } catch(e) { console.error('newsletter route:', e.message); }
app.use('/api/safeguarding-ext',  require('../../src/routes/safeguarding-ext'));
app.use('/api/risk-assessments',  require('../../src/routes/risk-assessments'));
app.use('/api/coshh',             require('../../src/routes/coshh'));
app.use('/api/fire-safety',       require('../../src/routes/fire-safety'));
app.use('/api/inspection',        require('../../src/routes/inspection'));

app.get('/api/edition', (req, res) => res.json({ edition: 'secondary', schema: process.env.PG_SCHEMA, demo: process.env.DEMO_MODE === 'true' }));

app.post('/api/demo/reset', async (req, res) => {
  if (process.env.DEMO_MODE !== 'true') return res.status(403).json({ error: 'Not a demo environment' });
  if (req.headers['x-demo-reset'] !== 'wren-demo-2026' && req.headers['x-demo-reset'] !== process.env.DEMO_RESET_SECRET)
    return res.status(403).json({ error: 'Invalid reset secret' });
  const { getPool } = require('../../src/db/pool');
  const db = getPool();
  const lockKey = 7777003;
  let lockAcquired = false;
  try {
    const { rows } = await db.query('SELECT pg_try_advisory_lock($1)', [lockKey]);
    lockAcquired = rows[0]?.pg_try_advisory_lock === true;
    if (!lockAcquired) return res.status(429).json({ error: 'Reset already in progress' });
    const fs = require('fs');
    const seedPath = require('path').join('/app/scripts', 'demo-seed-secondary.sql');
    const fallbackPath = require('path').join(__dirname, '../../scripts/demo-seed-secondary.sql');
    const sqlFile = fs.existsSync(seedPath) ? seedPath : fallbackPath;
    const fullSQL = fs.readFileSync(sqlFile, 'utf8');
    const marker = '-- MUTABLE DATA';
    const mutableIdx = fullSQL.indexOf(marker);
    const mutableSQL = mutableIdx >= 0
      ? `SET search_path TO ${process.env.PG_SCHEMA || 'demo_secondary'};\n` + fullSQL.slice(mutableIdx)
      : fullSQL;
    await db.query(mutableSQL);
    return res.json({ ok: true, message: 'Demo data reset to seed state' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
  finally { if (lockAcquired) await db.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {}); }
});

// ── b168 demo parity (2026-07-28) — ported from LADN, additive only ──────────
function _secondaryMount(routePath, mod){ try { app.use(routePath, require(mod)); } catch(e){ console.error('mount '+routePath+':', e.message); } }
_secondaryMount('/api/sen',           '../../src/routes/sen');
_secondaryMount('/api/next-steps',    '../../src/routes/next-steps');
_secondaryMount('/api/survey',        '../../src/routes/survey');
// b168 part 2 (2026-07-28) — automations/planner/visual-schedules are general
// product features (staff reminders, manager planner, SEN visual timetables),
// NOT EYFS-specific — corrected from part 1's over-broad EYFS-only skip.
_secondaryMount('/api/automations',      '../../src/routes/automations');
_secondaryMount('/api/planner',          '../../src/routes/planner');
_secondaryMount('/api/visual-schedules', '../../src/routes/visual-schedules');

app.get('/health', (req, res) => res.json({ ok: true, edition: 'secondary' }));

// v2 SPA shell — Manager portal
app.get(/^\/app(\/.*)?$/, (req, res) => res.sendFile(path.join(__dirname, 'public/app.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (req.path.startsWith('/parent/')) return res.sendFile(path.join(__dirname, 'public/parent/login.html'));
  if (req.path.startsWith('/student/')) return res.sendFile(path.join(__dirname, 'public/student/login.html'));
  res.sendFile(path.join(__dirname, 'public/login.html'));
});
app.listen(process.env.PORT || 3000, () => console.log('Wren SECONDARY running'));
