// Load .env only as fallback — container env vars take priority
require('dotenv').config({ path: __dirname + '/.env', override: false });
const express = require('express');
const path = require('path');
const app = express();
app.set('trust proxy', 1);
app.set('wren_edition', 'ladn');
// ── Payment webhooks — registered BEFORE express.json() to preserve raw body ──
const _webhooks = require('../../src/routes/payments-webhooks');
app.use('/api/stripe/webhook',     _webhooks.stripe);
app.use('/api/gocardless/webhook', _webhooks.gocardless);

app.use(express.json({ limit: '20mb' }));
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
// no-cache for /js/wren-shell.js and /js/wren-module-renderer.js — these change often during development
app.use((req, res, next) => {
  if (req.path === '/js/wren-shell.js' || req.path === '/js/wren-module-renderer.js') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));           // ladn-specific first
app.use(express.static(path.join(__dirname, '../../public')));     // shared fallback
app.use(express.static(path.join(__dirname, '../eyfs/public')));   // eyfs as fallback
['auth','children','staff','observations','attendance','diary','sleep','medicine',
 'incidents','safeguarding','absence','enquiries','admin','parents','ai','curriculum',
 'phonics','reports'].forEach(r => {
  app.use(`/api/${r}`, require(`../../src/routes/${r}`));
});
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
app.use('/api/induction',     require('../../src/routes/induction'));
app.use('/api/performance',   require('../../src/routes/performance'));
app.use('/api/funding',       require('../../src/routes/funding'));
app.use('/api/clockin',       require('../../src/routes/clockin'));
app.use('/api/modules',        require('../../src/routes/modules'));
app.use('/api/module-uploads', require('../../src/routes/modules').uploadsHandler);
app.use('/api/transcribe',     require('../../src/routes/transcribe'));
app.use('/api/interventions',  require('../../src/routes/intervention'));
app.use('/api/repairs',        require('../../src/routes/repairs'));
app.use('/api/notifications',  require('../../src/routes/notifications'));
// Start notification dispatcher (polls every 30s for queued deliveries)
require('../../src/services/notification-dispatcher').startDispatcher();

// ── Prompt 13 — memory box ───────────────────────────────────────────────────
app.use('/api/memory-box',     require('../../src/routes/memory-box'));

// ── Rota ─────────────────────────────────────────────────────────────────────
app.use('/api/rota',           require('../../src/routes/rota'));
app.use('/api/vapi',           require('../../src/routes/vapi'));
app.use('/api/aria',           require('../../src/routes/aria'));

// ── PDF export (Prompt 08) ────────────────────────────────────────────────────
app.use('/api/export',         require('../../src/routes/export'));

// ── Menus pipeline ────────────────────────────────────────────────────────────
app.use('/api/menus',          require('../../src/routes/menus'));
app.get('/chef', (req, res) => res.sendFile(require('path').join(__dirname, 'public/chef.html')));
app.get('/food-diary', (req, res) => res.sendFile(require('path').join(__dirname, 'public/food-diary.html')));

// ── Decision Log (Prompt 22) ─────────────────────────────────────────────────
app.use('/api/decision-log', require('../../src/routes/decision-log'));

// ── Payments ─────────────────────────────────────────────────────────────────
app.use('/api/payments', require('../../src/routes/payments'));

app.get('/api/edition', (req, res) => res.json({ edition: 'ladn', schema: 'ladn', demo: false }));
app.get('/health', (req, res) => res.json({ ok: true, edition: 'ladn' }));
// Module form page — matches /modules/{slug} and serves module-form.html
app.get('/modules/:slug', (req, res) => {
  res.sendFile(require('path').join(__dirname, 'public/module-form.html'));
});
// ── iCal calendar feeds (staff timetable, school events) ─────────────────────
app.use('/api/calendar', require('../../src/routes/calendar-feeds'));

// ── Permission slips ──────────────────────────────────────────────────────────
app.use('/api/permission-slips', require('../../src/routes/permission-slips'));

// ── Safeguarding extended (CPOMS-parity: chronology, audit chain, DSL workflow, reports, CTF) ──
app.use('/api/safeguarding-ext',  require('../../src/routes/safeguarding-ext'));

// ── Risk assessments (Evolve standard: templates, hazards, sign-off, RIDDOR) ──
app.use('/api/risk-assessments',  require('../../src/routes/risk-assessments'));

// ── COSHH register ────────────────────────────────────────────────────────────
app.use('/api/coshh',             require('../../src/routes/coshh'));

// ── Fire safety (drills, equipment log) ───────────────────────────────────────
app.use('/api/fire-safety',       require('../../src/routes/fire-safety'));

// ── Gov-Docs Corpus (statutory document library) ──────────────────────────────
app.use('/api/gov-corpus', require('../../src/routes/gov-corpus'));

// ── Framework statements alias — GET /api/framework-statements?framework=EYFS ─
// Maps the short framework name used by the EY app shell to the internal key
const _FRAMEWORK_MAP = {
  EYFS: 'eyfs_statutory', B25: 'birth_to_5', CFE: 'development_matters',
  COEL: 'coel', SEND: 'eyfs_statutory',
};
app.get('/api/framework-statements', require('./../../src/middleware/auth'), async (req, res) => {
  const fw = _FRAMEWORK_MAP[req.query.framework] || req.query.framework || 'eyfs_statutory';
  const area  = req.query.area || null;
  const q     = req.query.q   || null;
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const db = require('../../src/db/pool').getPool();
  const params = [fw];
  let sql = 'SELECT id,framework,area,aspect,age_range,statement_code,statement_text,ordinal FROM framework_statements WHERE framework=$1 AND statement_text NOT LIKE \'(stub%\'';
  if (area) { params.push(area); sql += ` AND area=$${params.length}`; }
  if (q) { params.push(q); sql += ` AND (statement_text ILIKE '%'||$${params.length}||'%' OR area ILIKE '%'||$${params.length}||'%' OR aspect ILIKE '%'||$${params.length}||'%')`; }
  sql += ` ORDER BY framework, ordinal, id LIMIT $${params.length + 1}`;
  params.push(limit);
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── EY Observation pages (Prompt 05) ──────────────────────────────────────────
app.get('/ey/observation/new', (req, res) => res.sendFile(path.join(__dirname, 'public/ey/observation-new.html')));
app.get('/ey/observation/:id', (req, res) => res.sendFile(path.join(__dirname, 'public/ey/observation-view.html')));

// ── EY Group action pages + API (Prompt 06) ───────────────────────────────────
app.use('/api/daily-diary', require('../../src/routes/daily-diary-group'));
['observation','sleep','nappies','food','bottle','toilet'].forEach(t => {
  app.get(`/ey/group/${t}`, (req, res) =>
    res.sendFile(path.join(__dirname, `public/ey/group/${t}.html`)));
});

// ── EY More menu pages (Prompt 07) ────────────────────────────────────────────
['more','drafts','trackers','activities','reports','settings','help'].forEach(p => {
  app.get(`/ey/${p}`, (req, res) =>
    res.sendFile(path.join(__dirname, `public/ey/${p}.html`)));
});

app.use( (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));
app.listen(process.env.PORT || 3000, () => console.log('Wren LADN Production running'));
