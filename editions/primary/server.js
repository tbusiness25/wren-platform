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

// Shared public (CSS/JS) then primary-specific HTML
app.use(express.static(path.join(__dirname, '../../public')));
app.use(express.static(path.join(__dirname, 'public')));

// Shared routes
['auth','children','staff','observations','attendance','diary','incidents','safeguarding',
 'absence','enquiries','admin','parents','ai','curriculum','phonics','reports','medicine',
 'sleep','behaviour','sen','cpd','planning','assessments','notifications'].forEach(r => {
  try { app.use('/api/'+r, require('../../src/routes/'+r)); } catch(e) {}
});

// ── Universal HR/ops parity ported from LADN (2026-06-18) — integration-only routes excluded ──
['occupancy','work-patterns','voice-notes','review','cockpit','contracts','handbook','contacts','ai-helper','staff-analytics','supervisions','performance'].forEach(r => {
  try { app.use('/api/'+r, require('../../src/routes/'+r)); } catch(e) { console.error('mount '+r+':', e.message); }
});
try { app.use('/api/documents/workspaces', require('../../src/routes/document-workspaces')); } catch(e) { console.error('mount documents/workspaces:', e.message); }

try { app.use('/api/it-settings', require('../../src/routes/it-settings')); } catch(e) {}
app.get('/api/frameworks', (req, res) => {
  const fs = require('fs'), p = require('path');
  try { res.json(JSON.parse(fs.readFileSync(p.join(__dirname, '../../data/framework-versions.json'), 'utf8'))); }
  catch { res.status(500).json({ error: 'Framework data unavailable' }); }
});

// Primary-specific routes
try { app.use('/api/attendance-register', require('../../src/routes/attendance-register')); } catch(e) {}
try { app.use('/api/assessments-primary', require('../../src/routes/assessments-primary')); } catch(e) {}
try { app.use('/api/behaviour-primary',   require('../../src/routes/behaviour-primary')); } catch(e) {}
app.use('/api/menus', require('../../src/routes/menus'));

// School edition routes
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
try { app.use('/api/action-plans',        require('../../src/routes/primary-action-plans')); } catch(e) { console.error('action-plans route:', e.message); }
try { app.use('/api/calendar',            require('../../src/routes/school-calendar-events')); } catch(e) { console.error('calendar route:', e.message); }
try { app.use('/api/calendar',            require('../../src/routes/calendar-feeds')); } catch(e) { console.error('calendar-feeds route:', e.message); }
try { app.use('/api/primary-rota',        require('../../src/routes/primary-rota')); } catch(e) { console.error('primary-rota route:', e.message); }
try { app.use('/api/points',              require('../../src/routes/points')); } catch(e) { console.error('points route:', e.message); }
try { app.use('/api/points-admin',        require('../../src/routes/points-admin')); } catch(e) { console.error('points-admin route:', e.message); }
try { app.use('/api/twinkl',              require('../../src/routes/twinkl')); } catch(e) { console.error('twinkl route:', e.message); }

// Children's Area — parent auth + child PIN sessions + child-facing data
// HTML pages in public/parent/ are served by express.static above (no extra route needed)
try { app.use('/api/childrens-area', require('../../src/routes/childrens-area')); } catch(e) { console.error('childrens-area route:', e.message); }

// Primary-specific: exclusions (uses start_date/exclusion_type columns for demo_primary)
try { app.use('/api/exclusions', require('../../src/routes/exclusions-primary')); } catch(e) { console.error('exclusions-primary route:', e.message); }

// Primary-specific: CTF import/export without ladn. schema prefix
try { app.use('/api/ctf', require('../../src/routes/ctf-primary')); } catch(e) { console.error('ctf-primary route:', e.message); }

// Parent portal auth routes (mounted at /api/auth — adds /parent-login, /parent-otp, /parent-otp-verify)
// Also mounted at /api/parents for data routes (/children, /messages/:id, /invoices/:id, /checkout)
try {
  const parentsPortal = require('../../src/routes/parents-portal');
  app.use('/api/auth',    parentsPortal);
  app.use('/api/parents', parentsPortal);
} catch(e) { console.error('parents-portal route:', e.message); }
try { app.use('/api/payments', require('../../src/routes/payments-parent')); } catch(e) { console.error('payments-parent route:', e.message); }

// ── Universal routes — API parity with LADN ───────────────────────────────────
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

app.get('/api/edition', (req, res) => res.json({ edition: 'primary', schema: process.env.PG_SCHEMA, demo: process.env.DEMO_MODE === 'true' }));

app.post('/api/demo/reset', async (req, res) => {
  if (process.env.DEMO_MODE !== 'true') return res.status(403).json({ error: 'Not a demo environment' });
  if (req.headers['x-demo-reset'] !== 'wren-demo-2026' && req.headers['x-demo-reset'] !== process.env.DEMO_RESET_SECRET)
    return res.status(403).json({ error: 'Invalid reset secret' });
  const { getPool } = require('../../src/db/pool');
  const db = getPool();
  const lockKey = 7777002;
  let lockAcquired = false;
  try {
    const { rows } = await db.query('SELECT pg_try_advisory_lock($1)', [lockKey]);
    lockAcquired = rows[0]?.pg_try_advisory_lock === true;
    if (!lockAcquired) return res.status(429).json({ error: 'Reset already in progress' });
    const fs = require('fs');
    const seedPath = require('path').join('/app/scripts', 'demo-seed-primary.sql');
    const fallbackPath = require('path').join(__dirname, '../../scripts/demo-seed-primary.sql');
    const sqlFile = fs.existsSync(seedPath) ? seedPath : fallbackPath;
    const fullSQL = fs.readFileSync(sqlFile, 'utf8');
    const marker = '-- MUTABLE DATA';
    const mutableIdx = fullSQL.indexOf(marker);
    const mutableSQL = mutableIdx >= 0
      ? `SET search_path TO ${process.env.PG_SCHEMA || 'demo_primary'};\n` + fullSQL.slice(mutableIdx)
      : fullSQL;
    await db.query(mutableSQL);
    return res.json({ ok: true, message: 'Demo data reset to seed state' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
  finally { if (lockAcquired) await db.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {}); }
});

app.get('/health', (req, res) => res.json({ ok: true, edition: 'primary' }));

// v2 SPA shell — Manager portal
app.get(/^\/app(\/.*)?$/, (req, res) => res.sendFile(path.join(__dirname, 'public/app.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public/login.html'));
});
app.listen(process.env.PORT || 3000, () => console.log('Wren PRIMARY running'));
