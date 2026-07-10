// Unified Primary server — serves admin, learning, HR, and parents portals
// in a single Express process, dispatching by Host-prefix (HTadmin./HThr./HTparents./else).
// Modelled on editions/ladn/server-unified.js.
//
// Portal dispatch:
//   HTadmin.*  → admin portal  (editions/admin/public)
//   HThr.*     → HR portal     (editions/hr/public)
//   HTparents.* → parents portal (editions/parents/public)
//   else       → learning      (editions/primary/public + editions/eyfs/public)

require('dotenv').config({ path: __dirname + '/.env', override: false });

const express    = require('express');
const cookieParser = require('cookie-parser');
const path       = require('path');
const fs         = require('fs');
const { Pool }   = require('pg');

const app    = express();
const SCHEMA = process.env.PG_SCHEMA || 'demo_primary';

app.set('trust proxy', 1);

// ── Portal detection (lowercased by Express) ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const h = (req.hostname || '').toLowerCase();
  if      (h.startsWith('htadmin.')   || h.startsWith('htps-admin.'))   req._portal = 'admin';
  else if (h.startsWith('hthr.')      || h.startsWith('htps-hr.'))      req._portal = 'hr';
  else if (h.startsWith('htparents.') || h.startsWith('htps-parents.')) req._portal = 'parents';
  else                                                                  req._portal = 'learning';  // incl. htps-learn.*
  next();
});

// ── Payment webhooks — raw body needed, must be before express.json ───────────
const _webhooks = require('../../src/routes/payments-webhooks');
app.use('/api/stripe/webhook',     _webhooks.stripe);
app.use('/api/gocardless/webhook', _webhooks.gocardless);

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: '20mb' }));

// ── Parents-portal authorisation guard ─────────────────────────────────────────
const _jwt = require('jsonwebtoken');
const PARENT_DENY = new Set([
  'staff','staff-analytics','children','observations','incidents','attendance','sleep',
  'medicine','safeguarding','safeguarding-ext','sen','cpd','supervisions','performance',
  'toil','rota','clockin','enquiries','contacts','repairs','kitchen','absence','outings',
  'risk-assessments','coshh','fire-safety','compliance-events','regulatory','inspection',
  'audit','admin','cockpit','finance','invoices','payments-admin','open-banking','newsletter',
  'reports','interventions','next-steps','planned-activities','activity-bank','decision-log',
  'email-triage','daily-briefing','away-mode','backup','migration','import','tasks','workflows',
  'vapi','vapi-actions','vapi-health','wellbeing','state','gias','contracts','courses',
  'handbook','policies','aria','insights','review','contracts',
]);
app.use('/api', (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const hdr = req.headers['authorization'] || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-wren-token'] || '');
  if (!tok) return next();
  let dec;
  try { dec = _jwt.verify(tok, process.env.JWT_SECRET); } catch { return next(); }
  if (dec && dec.role === 'parent') {
    const seg = (req.path.split('/').filter(Boolean)[0] || '').toLowerCase();
    if (PARENT_DENY.has(seg)) {
      return res.status(403).json({ error: 'Forbidden — not available on the parents portal' });
    }
  }
  next();
});

// ── HR portal: block child-facing HTML routes ──────────────────────────────────
const CHILD_ROUTE_PATTERNS = [
  'learning','observations','diary','sleep','children','medicine',
  'phonics','key-children','child-profile','safeguarding','incidents',
  'memory-box','activity-bank','first-words','curriculum','planning',
  'classroom-tools','seating-plan','census','pupil-premium','ehcp',
];
app.use((req, res, next) => {
  if (req._portal !== 'hr' || req.path.startsWith('/api/')) return next();
  const lc = req.path.toLowerCase().replace(/^\//, '').replace(/\.html$/, '');
  if (!CHILD_ROUTE_PATTERNS.some(p => lc === p || lc.startsWith(p + '/'))) return next();
  const pool = require('../../src/db/pool').getPool();
  pool.query(
    `INSERT INTO ${SCHEMA}.hr_blocked_routes(path,method,reason,ip,user_agent)
     VALUES($1,$2,$3,$4,$5)`,
    [req.path, req.method, 'child_facing_route_blocked',
     req.ip, (req.headers['user-agent'] || '').substring(0, 200)]
  ).catch(() => {});
  console.warn(`[HR-SECURITY] Blocked child-facing route: ${req.method} ${req.path}`);
  res.status(404).json({ error: 'Not found', note: 'This route is not available on the HR portal.' });
});

// ── HR DENY list for child data via API ────────────────────────────────────────
const HR_DENY = new Set([
  'children','observations','diary','daily-diary','sleep','sleep-checks','medicine',
  'incidents','safeguarding','safeguarding-ext','sen','phonics','memory-box','first-words',
  'curriculum','planning','activity-bank','planned-activities','next-steps','parent-reports',
  'leavers-book','outings','key-children','child-profile','framework-tracker','framework-statements',
]);
app.use('/api', (req, res, next) => {
  if (req._portal !== 'hr') return next();
  const seg = (req.path.split('/').filter(Boolean)[0] || '').toLowerCase();
  if (HR_DENY.has(seg)) {
    return res.status(403).json({ error: 'Forbidden — child data is not available on the HR portal' });
  }
  next();
});

app.use(require('cors')({ origin: process.env.ALLOWED_ORIGIN || false, credentials: true }));
app.use(require('helmet')({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'none'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc:     ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'", "data:", "https://fonts.gstatic.com"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
    }
  }
}));

// ── Edition header + no-cache ──────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Wren-Edition', 'primary-' + (req._portal || 'learning'));
  next();
});

// ── No-cache for all HTML responses ─────────────────────────────────────────────
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
// after finish it 302s to login forever. Sub-assets (/setup/*.js, css, samples)
// fall through to the static handler below.
const _setupPage = path.join(__dirname, '../../public/setup/index.html');
app.get(['/setup', '/setup/'], async (req, res) => {
  try {
    const { rows } = await require('../../src/db/pool').getPool()
      .query("SELECT value FROM settings WHERE key='setup_complete'");
    if (rows[0] && String(rows[0].value).toLowerCase() === 'true') return res.redirect(302, '/login.html');
  } catch (e) { /* fall through to wizard */ }
  res.sendFile(_setupPage);
});

// ── Static files: per-portal edition public FIRST, shared public as fallback ─────
const _sharedStatic = express.static(path.join(__dirname, '../../public'));

const _staticHandlers = {
  admin:    [express.static(path.join(__dirname, '../admin/public')),    _sharedStatic],
  hr:       [express.static(path.join(__dirname, '../hr/public')),       _sharedStatic],
  parents:  [express.static(path.join(__dirname, '../parents/public')),  _sharedStatic],
  learning: [
    express.static(path.join(__dirname, 'public')),
    express.static(path.join(__dirname, '../eyfs/public')),
    _sharedStatic,
  ],
};
app.use((req, res, next) => {
  const handlers = _staticHandlers[req._portal || 'learning'];
  let i = 0;
  const tryNext = () => { if (i >= handlers.length) return next(); handlers[i++](req, res, tryNext); };
  tryNext();
});

// ── Portal app shell redirects ─────────────────────────────────────────────────
app.get(['/', '/index.html'], (req, res, next) => {
  if (req._portal === 'parents') return res.redirect('/parent');
  if (req._portal === 'admin') return res.redirect('/admin.html');
  if (req._portal === 'hr') return res.redirect('/hr.html');
  if (req._portal === 'learning') return res.redirect(301, '/app');
  next();
});

// ── Shared routes (inherited from primary/server.js) ────────────────────────────
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
app.use(require('../../src/middleware/scope-filter'));

// ── Shared route mounts ────────────────────────────────────────────────────────
const db = require('../../src/db/pool').getPool();

// Core shared routes
['auth','children','staff','observations','attendance','diary','incidents','safeguarding',
 'absence','enquiries','admin','parents','ai','curriculum','phonics','reports','medicine',
 'sleep','behaviour','sen','cpd','planning','assessments','notifications'].forEach(r => {
  try { app.use('/api/'+r, require('../../src/routes/'+r)); } catch(e) {}
});

// ── HR/ops parity ───────────────────────────────────────────────────────────────
['occupancy','work-patterns','voice-notes','review','cockpit','contracts','handbook','contacts','ai-helper','staff-analytics','supervisions','performance'].forEach(r => {
  try { app.use('/api/'+r, require('../../src/routes/'+r)); } catch(e) { console.error('mount '+r+':', e.message); }
});
try { app.use('/api/documents/workspaces', require('../../src/routes/document-workspaces')); } catch(e) { console.error('documents/workspaces:', e.message); }

try { app.use('/api/it-settings', require('../../src/routes/it-settings')); } catch(e) {}
// First-run setup wizard API (prompt 67) — unauthenticated + self-gated on settings.setup_complete
try { app.use('/api/setup', require('../../src/routes/setup')); } catch(e) { console.error('mount setup:', e.message); }
app.get('/api/frameworks', (req, res) => {
  const fsd = require('fs'), p = require('path');
  try { res.json(JSON.parse(fsd.readFileSync(p.join(__dirname, '../../data/framework-versions.json'), 'utf8'))); }
  catch { res.status(500).json({ error: 'Framework data unavailable' }); }
});

// ── Primary-specific routes ─────────────────────────────────────────────────────
try { app.use('/api/attendance-register', require('../../src/routes/attendance-register')); } catch(e) {}
try { app.use('/api/assessments-primary', require('../../src/routes/assessments-primary')); } catch(e) {}
try { app.use('/api/behaviour-primary',   require('../../src/routes/behaviour-primary')); } catch(e) {}
app.use('/api/menus', require('../../src/routes/menus'));

// School edition routes
try { app.use('/api/homework',            require('../../src/routes/homework')); } catch(e) {}
try { app.use('/api/classes',             require('../../src/routes/school-classes')); } catch(e) {}
try { app.use('/api/subjects',            require('../../src/routes/school-subjects')); } catch(e) {}
try { app.use('/api/clubs',               require('../../src/routes/school-clubs')); } catch(e) {}
try { app.use('/api/trips',               require('../../src/routes/school-trips')); } catch(e) {}
try { app.use('/api/teaching-resources',  require('../../src/routes/teaching-resources')); } catch(e) {}
try { app.use('/api/announcements',       require('../../src/routes/school-announcements')); } catch(e) {}
try { app.use('/api/behaviour-points',    require('../../src/routes/behaviour-points')); } catch(e) {}
try { app.use('/api/wellbeing',           require('../../src/routes/wellbeing')); } catch(e) {}
try { app.use('/api/policies',            require('../../src/routes/policies')); } catch(e) {}
try { app.use('/api/action-plans',        require('../../src/routes/primary-action-plans')); } catch(e) {}
try { app.use('/api/calendar',            require('../../src/routes/school-calendar-events')); } catch(e) {}
try { app.use('/api/calendar',            require('../../src/routes/calendar-feeds')); } catch(e) {}
try { app.use('/api/primary-rota',        require('../../src/routes/primary-rota')); } catch(e) {}
try { app.use('/api/points',              require('../../src/routes/points')); } catch(e) {}
try { app.use('/api/points-admin',        require('../../src/routes/points-admin')); } catch(e) {}
try { app.use('/api/twinkl',              require('../../src/routes/twinkl')); } catch(e) {}

// Children's Area
try { app.use('/api/childrens-area', require('../../src/routes/childrens-area')); } catch(e) {}

// Primary-specific: exclusions
try { app.use('/api/exclusions', require('../../src/routes/exclusions-primary')); } catch(e) {}

// CTF import/export
try { app.use('/api/ctf', require('../../src/routes/ctf-primary')); } catch(e) {}

// Parent portal auth + data
try {
  const parentsPortal = require('../../src/routes/parents-portal');
  app.use('/api/auth',    parentsPortal);
  app.use('/api/parents', parentsPortal);
} catch(e) {}
try { app.use('/api/payments', require('../../src/routes/payments-parent')); } catch(e) {}

// ── Universal routes ────────────────────────────────────────────────────────────
app.use('/api/audit',              require('../../src/routes/audit'));
app.use('/api/clockin',            require('../../src/routes/clockin'));
app.use('/api/transcribe',         require('../../src/routes/transcribe'));
app.use('/api/interventions',      require('../../src/routes/intervention'));
app.use('/api/decision-log',       require('../../src/routes/decision-log'));
app.use('/api/permission-slips',   require('../../src/routes/permission-slips'));
app.use('/api/toil',               require('../../src/routes/toil'));
app.use('/api/courses',            require('../../src/routes/courses'));
app.use('/api/finance/dashboard',  require('../../src/routes/finance-dashboard'));
app.use('/api/finance/forecast',   require('../../src/routes/finance-forecast'));
app.use('/api/finance/invoices',   require('../../src/routes/finance-invoices'));
app.use('/api/finance/reconcile',  require('../../src/routes/finance-reconcile'));
app.use('/api/finance/wages',      require('../../src/routes/finance-wages'));
app.use('/api/finance/payroll',    require('../../src/routes/finance-payroll'));
try { app.use('/api/workflows',          require('../../src/routes/workflows')); } catch(e) {}
try { app.use('/api/backup',             require('../../src/routes/backup')); } catch(e) {}
try { app.use('/api/parent-permissions', require('../../src/routes/parent-permissions-matrix')); } catch(e) {}
try { app.use('/api/gias',               require('../../src/routes/gias')); } catch(e) {}
try {
  const { externalRouter, staffExternalRouter } = require('../../src/routes/external-api');
  app.use('/api/external', externalRouter);
  app.use('/api/external', staffExternalRouter);
} catch(e) {}
app.use('/api/insights',          require('../../src/routes/insights'));
try { app.use('/api/newsletter',  require('../../src/routes/newsletter')); } catch(e) {}
app.use('/api/safeguarding-ext',  require('../../src/routes/safeguarding-ext'));
app.use('/api/risk-assessments',  require('../../src/routes/risk-assessments'));
app.use('/api/coshh',             require('../../src/routes/coshh'));
app.use('/api/fire-safety',       require('../../src/routes/fire-safety'));
app.use('/api/inspection',        require('../../src/routes/inspection'));

app.get('/api/edition', (req, res) => res.json({ edition: 'primary-unified', schema: SCHEMA }));

// ── Health ──
app.get('/health', (req, res) => res.json({ ok: true, edition: 'primary-unified', portal: req._portal }));

// ── Catch-all: serve login for non-API ──
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  // Map portal → default HTML entry point
  const htmlMap = { admin: 'admin.html', hr: 'hr.html', parents: 'parent/index.html', learning: 'app.html' };
  const html = htmlMap[req._portal] || 'login.html';
  res.sendFile(path.join(__dirname, 'public', html));
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Wren PRIMARY UNIFIED running on port ${PORT} (portals: admin/hr/parents/learning)`));
