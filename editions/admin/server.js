// Load .env only as fallback — container env vars take priority
require('dotenv').config({ path: __dirname + '/.env', override: false });
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const EDITION = 'admin';
const SCHEMA = process.env.PG_SCHEMA || 'ladn';
app.set('wren_edition', EDITION);

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

// no-cache for shell JS and section fragments
app.use((req, res, next) => {
  if (req.path === '/js/wren-shell.js' || req.path === '/js/wren-module-renderer.js' ||
      req.path === '/js/wren-shell-v2.js' || req.path.startsWith('/sections/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '../../public')));

app.use('/api/auth',         require('../../src/routes/auth'));
app.use('/api/children',     require('../../src/routes/children'));
app.use('/api/staff',        require('../../src/routes/staff'));
app.use('/api/observations', require('../../src/routes/observations'));
app.use('/api/attendance',   require('../../src/routes/attendance'));
app.use('/api/absence',      require('../../src/routes/absence'));
app.use('/api/enquiries',    require('../../src/routes/enquiries'));
app.use('/api/admin',        require('../../src/routes/admin'));
app.use('/api/incidents',    require('../../src/routes/incidents'));
app.use('/api/safeguarding', require('../../src/routes/safeguarding'));
app.use('/api/parents',      require('../../src/routes/parents'));
app.use('/api/reports',      require('../../src/routes/reports'));
app.use('/api/ai',           require('../../src/routes/ai'));
app.use('/api/planning',            require('../../src/routes/planning'));
app.use('/api/next-steps',          require('../../src/routes/next-steps'));
app.use('/api/planned-activities',  require('../../src/routes/planned-activities'));
app.use('/api/messages',      require('../../src/routes/messages'));
app.use('/api/newsletter',    require('../../src/routes/newsletter'));
app.use('/api/survey',        require('../../src/routes/survey'));
app.use('/api/sen',           require('../../src/routes/sen'));
app.use('/api/outings',       require('../../src/routes/outings'));
app.use('/api/action-plans',      require('../../src/routes/action-plans'));
app.use('/api/action-plan-items', require('../../src/routes/action-plan-items'));
app.use('/api/supervisions',      require('../../src/routes/supervisions'));
app.use('/api/activity-bank', require('../../src/routes/activity-bank'));
app.use('/api/first-words',   require('../../src/routes/first-words'));
app.use('/api/cpd',           require('../../src/routes/cpd'));
app.use('/api/diary',         require('../../src/routes/diary'));
app.use('/api/sleep',         require('../../src/routes/sleep'));
app.use('/api/medicine',      require('../../src/routes/medicine'));
app.use('/api/phonics',       require('../../src/routes/phonics'));
app.use('/api/curriculum',    require('../../src/routes/curriculum'));
app.use('/api/performance',   require('../../src/routes/performance'));
app.use('/api/kitchen',       require('../../src/routes/kitchen'));
app.use('/api/funding',       require('../../src/routes/funding'));
app.use('/api/clockin',       require('../../src/routes/clockin'));

app.use('/api/modules',        require('../../src/routes/modules'));
app.use('/api/module-uploads', require('../../src/routes/modules').uploadsHandler);
app.use('/api/features',       require('../../src/routes/features'));
app.use('/api/transcribe',     require('../../src/routes/transcribe'));
app.use('/api/interventions',  require('../../src/routes/intervention'));
app.use('/api/repairs',        require('../../src/routes/repairs'));
app.use('/api/notifications',  require('../../src/routes/notifications'));
// Start notification dispatcher (polls every 30s for queued deliveries)
require('../../src/services/notification-dispatcher').startDispatcher();

// ── Prompt 11 cockpit routes ─────────────────────────────────────────────────
app.use('/api/tasks',               require('../../src/routes/tasks'));
app.use('/api/calendar',            require('../../src/routes/calendar'));
app.use('/api/comms',               require('../../src/routes/comms'));
app.use('/api/vapi',                require('../../src/routes/vapi'));
app.use('/api/aria',                require('../../src/routes/aria'));
app.use('/api/contacts',            require('../../src/routes/contacts'));
app.use('/api/ai-helper',           require('../../src/routes/ai-helper'));
app.use('/api/compliance-events',   require('../../src/routes/compliance-events'));
app.use('/api/invoices',            require('../../src/routes/invoices'));
app.use('/api/daily-briefing',      require('../../src/routes/daily-briefing'));

// ── Prompt 13 — parent reports, memory box, leavers book ────────────────────
app.use('/api/parent-reports',  require('../../src/routes/parent-reports'));
app.use('/api/memory-box',      require('../../src/routes/memory-box'));
app.use('/api/leavers-book',    require('../../src/routes/leavers-book'));

// ── Rota builder ─────────────────────────────────────────────────────────────
app.use('/api/rota',            require('../../src/routes/rota'));

// ── PDF export (Prompt 08) ─────────────────────────────────────────────────────
app.use('/api/export',          require('../../src/routes/export'));

// ── Audit log (Prompt 09) ─────────────────────────────────────────────────────
app.use('/api/audit',           require('../../src/routes/audit'));

// ── Menus pipeline ────────────────────────────────────────────────────────────
app.use('/api/menus',           require('../../src/routes/menus'));

// ── Study module admin ────────────────────────────────────────────────────────
app.use('/api/study',           require('../../src/routes/study'));

// ── Security dashboard ────────────────────────────────────────────────────────
app.use('/api/security',        require('../../src/routes/security'));
require('../../src/security/runner').startCron();

// ── Email triage ──────────────────────────────────────────────────────────────
app.use('/api/email-triage',    require('../../src/routes/email-triage'));

// ── State-of-nursery forecast (Prompt 23) ─────────────────────────────────────
app.use('/api/state',           require('../../src/routes/state-forecast'));

// ── Vapi pipeline health (Prompt 30) ─────────────────────────────────────────
app.use('/api/vapi-health',     require('../../src/routes/vapi-health'));

// ── Permissions matrix ────────────────────────────────────────────────────────
app.use('/api/permissions',     require('../../src/routes/permissions'));

// ── Vapi Actions queue ────────────────────────────────────────────────────────
app.use('/api/vapi-actions',    require('../../src/routes/vapi-actions'));

// ── AI features ───────────────────────────────────────────────────────────────
try { app.use('/api/ai', require('../../src/routes/ai-features')); } catch(e) { console.error('ai-features:', e.message); }

// ── CSV Import Wizard ─────────────────────────────────────────────────────────
app.use('/api/import', require('../../src/routes/import-wizard'));

// ── CTF 25 Import + Export ────────────────────────────────────────────────────
app.use('/api/ctf', require('../../src/routes/ctf'));

// ── Payments admin ────────────────────────────────────────────────────────────
app.use('/api/payments-admin', require('../../src/routes/payments-admin'));
app.use('/api/payments',       require('../../src/routes/payments'));

// ── Finance section (Prompt Finance) ─────────────────────────────────────────
app.use('/api/finance/dashboard',  require('../../src/routes/finance-dashboard'));
app.use('/api/finance/forecast',   require('../../src/routes/finance-forecast'));
app.use('/api/finance/invoices',   require('../../src/routes/finance-invoices'));
app.use('/api/finance/reconcile',  require('../../src/routes/finance-reconcile'));
app.use('/api/finance/wages',      require('../../src/routes/finance-wages'));
app.use('/api/finance/payroll',    require('../../src/routes/finance-payroll'));
app.use('/api/open-banking',       require('../../src/routes/open-banking'));
app.use('/api/migration',          require('../../src/routes/migration-helper'));

// ── Workflows (n8n templates) ─────────────────────────────────────────────────
try { app.use('/api/workflows', require('../../src/routes/workflows')); } catch(e) { console.error('workflows:', e.message); }

// ── Parent permissions matrix ─────────────────────────────────────────────────
try { app.use('/api/parent-permissions', require('../../src/routes/parent-permissions-matrix')); } catch(e) { console.error('parent-permissions:', e.message); }

// ── Permission slips (outing/trip consent) ────────────────────────────────────
app.use('/api/permission-slips', require('../../src/routes/permission-slips'));

// ── External API staff management ─────────────────────────────────────────────
try {
  const { staffExternalRouter } = require('../../src/routes/external-api');
  app.use('/api/external', staffExternalRouter);
} catch(e) { console.error('external-api-staff:', e.message); }

// ── GIAS school lookup ────────────────────────────────────────────────────────
try { app.use('/api/gias', require('../../src/routes/gias')); } catch(e) { console.error('gias:', e.message); }

// ── Funding Portal extension (council auto-fill) ──────────────────────────────
try { app.use('/api/funding-portal', require('../../src/routes/funding-portal')); } catch(e) { console.error('funding-portal:', e.message); }

// ── Staff contracts & handbook ────────────────────────────────────────────────
app.use('/api/contracts', require('../../src/routes/contracts'));
app.use('/api/handbook',  require('../../src/routes/handbook'));

app.get('/api/edition', (req, res) => res.json({
  edition: EDITION, schema: SCHEMA, demo: process.env.DEMO_MODE === 'true'
}));

app.get('/health', (req, res) => res.json({ ok: true, edition: EDITION }));

// ── Admin study page ──────────────────────────────────────────────────────────
app.get('/admin/study', (req, res) => res.sendFile(path.join(__dirname, 'public/study.html')));
app.get('/admin/study/pending', (req, res) => res.sendFile(path.join(__dirname, 'public/study.html')));
app.get('/study', (req, res) => res.sendFile(path.join(__dirname, 'public/study.html')));

// ── Regulatory watcher pages (must be before the /admin/:section catch-all) ────
app.get('/admin/regulatory', (req, res) => res.sendFile(path.join(__dirname, 'public/regulatory.html')));

// ── New SPA shell — serves app.html for all /admin/* navigation routes ────────
// Legacy pages remain at their existing paths (children.html, invoices.html, etc.)
// /sections/* are served as static fragments by express.static above
app.get('/admin', (req, res) => res.redirect(301, '/admin/dashboard/today'));
app.get('/admin/:section', (req, res) => res.sendFile(path.join(__dirname, 'public/app.html')));
app.get('/admin/:section/:tab', (req, res) => res.sendFile(path.join(__dirname, 'public/app.html')));

// ── Safeguarding extended + H&S ───────────────────────────────────────────────
app.use('/api/safeguarding-ext', require('../../src/routes/safeguarding-ext'));
app.use('/api/risk-assessments', require('../../src/routes/risk-assessments'));
app.use('/api/coshh',            require('../../src/routes/coshh'));
app.use('/api/fire-safety',      require('../../src/routes/fire-safety'));

// ── Inspection Mode ───────────────────────────────────────────────────────────
app.use('/api/inspection',       require('../../src/routes/inspection'));

// ── Document Updater & Merger ─────────────────────────────────────────────────
try { app.use('/api/documents/workspaces', require('../../src/routes/document-workspaces')); } catch(e) { console.error('document-workspaces:', e.message); }

// ── Regulatory feed watcher ────────────────────────────────────────────────────
app.use('/api/regulatory', require('../../src/routes/regulatory'));
require('../../src/services/regulatory-feed-poller').startPoller();
require('../../src/services/regulatory-alert-analyser').startAnalyser();

// ── Document workspace SPA routes ─────────────────────────────────────────────
app.get('/admin/documents/workspaces',      (req, res) => res.sendFile(path.join(__dirname, 'public/documents/workspaces.html')));
app.get('/admin/documents/workspaces/new',  (req, res) => res.sendFile(path.join(__dirname, 'public/documents/workspaces-new.html')));
app.get('/admin/documents/workspaces/:id',  (req, res) => res.sendFile(path.join(__dirname, 'public/documents/workspace-detail.html')));

// ── Regulatory alert detail page (4-segment path, no catch-all conflict) ──────
app.get('/admin/regulatory/alerts/:id', (req, res) => res.sendFile(path.join(__dirname, 'public/regulatory/alert-detail.html')));

// ── Gov-Docs Corpus (statutory document library) ──────────────────────────────
app.use('/api/gov-corpus', require('../../src/routes/gov-corpus'));
app.get('/admin/library', (req, res) => res.sendFile(path.join(__dirname, 'public/sections/gov-corpus.html')));

app.use( (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Wren ADMIN running on :${PORT} (schema: ${SCHEMA})`));
