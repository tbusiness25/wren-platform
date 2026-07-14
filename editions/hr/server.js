// Load .env only as fallback — container env vars take priority
require('dotenv').config({ path: __dirname + '/.env', override: false });
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const { getPool } = require('../../src/db/pool');

const app = express();
const EDITION = 'hr';
const SCHEMA = process.env.PG_SCHEMA || 'ladn';

// Child-facing route patterns that must never be served by the HR portal.
const CHILD_ROUTE_PATTERNS = [
  'learning', 'observations', 'diary', 'sleep', 'children', 'medicine',
  'phonics', 'key-children', 'child-profile', 'safeguarding', 'incidents',
  'memory-box', 'activity-bank', 'first-words', 'curriculum', 'planning',
];

app.set('trust proxy', 1);
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || false, credentials: true }));
app.use(helmet({
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

// Add X-Wren-Edition header and no-cache to all HTML + JS responses
app.use((req, res, next) => {
  res.setHeader('X-Wren-Edition', EDITION);
  if (req.path === '/js/wren-shell.js' || req.path === '/js/wren-module-renderer.js') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

// Explicitly block child-facing HTML routes — log and return 404
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  const lcPath = req.path.toLowerCase().replace(/^\//, '').replace(/\.html$/, '');
  const isChildRoute = CHILD_ROUTE_PATTERNS.some(p => lcPath === p || lcPath.startsWith(p + '/'));
  if (!isChildRoute) return next();

  const db = getPool();
  db.query(
    `INSERT INTO ladn.hr_blocked_routes(path,method,reason,ip,user_agent,cf_email)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [req.path, req.method, 'child_facing_route_blocked',
     req.ip, (req.headers['user-agent'] || '').substring(0, 200),
     (req.headers['cf-access-authenticated-user-email'] || null)]
  ).catch(() => {});

  console.warn(`[HR-SECURITY] Blocked child-facing route: ${req.method} ${req.path} from ${req.ip}`);
  res.status(404).json({ error: 'Not found', note: 'This route is not available on the HR portal. Use the EY portal for child data.' });
});

app.use(express.static(path.join(__dirname, '../../public')));
app.use(express.static(path.join(__dirname, 'public')));

// Auth & staff core
app.use('/api/auth',         require('../../src/routes/auth'));
app.use('/api/staff',        require('../../src/routes/staff'));
app.use('/api/absence',      require('../../src/routes/absence'));
app.use('/api/cpd',          require('../../src/routes/cpd'));
app.use('/api/induction',    require('../../src/routes/induction'));
app.use('/api/supervisions', require('../../src/routes/supervisions'));
app.use('/api/performance',  require('../../src/routes/performance'));
app.use('/api/ai',           require('../../src/routes/ai'));
app.use('/api/features',     require('../../src/routes/features'));

// HR-specific routes
app.use('/api/toil',         require('../../src/routes/toil'));
app.use('/api/policies',     require('../../src/routes/policies'));
app.use('/api/wellbeing',    require('../../src/routes/wellbeing'));
app.use('/api/rota',         require('../../src/routes/rota'));
app.use('/api/action-plans',      require('../../src/routes/action-plans'));
app.use('/api/action-plan-items', require('../../src/routes/action-plan-items'));
app.use('/api/courses',           require('../../src/routes/courses'));
app.use('/api/repairs',           require('../../src/routes/repairs'));
app.use('/api/notifications',     require('../../src/routes/notifications'));
try { app.use('/api/ai', require('../../src/routes/ai-features')); } catch(e) { console.error('ai-features:', e.message); }

app.get('/api/edition', (req, res) => res.json({
  edition: EDITION, schema: SCHEMA, demo: process.env.DEMO_MODE === 'true'
}));

// Client-side security alert endpoint — no auth required so bad renders can still report
app.post('/api/security-alert', (req, res) => {
  const { alert_type, expected_edition, actual_edition, path: reqPath, details } = req.body || {};
  if (!alert_type) return res.status(400).json({ error: 'alert_type required' });
  const db = getPool();
  db.query(
    `INSERT INTO ladn.security_alerts(alert_type,origin,expected_edition,actual_edition,path,ip,user_agent,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['hr_edition_mismatch', req.headers.origin || null, expected_edition || null,
     actual_edition || null, reqPath || null, req.ip,
     (req.headers['user-agent'] || '').substring(0, 200),
     details ? JSON.stringify(details) : null]
  ).catch(() => {});
  console.warn(`[HR-SECURITY] Client alert: ${alert_type} from ${req.ip} — expected=${expected_edition} actual=${actual_edition}`);
  res.json({ ok: true });
});

app.get('/health', (req, res) => res.json({ ok: true, edition: EDITION }));

// Service worker — unregisters any stale SW and serves an inert worker for this origin
app.get('/sw.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
`);
});

// Catch-all: unauthenticated API → 404, everything else → login.html (no-store)
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wren HR running on :${PORT} (schema: ${SCHEMA})`));
