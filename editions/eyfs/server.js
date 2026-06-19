// Load .env only as fallback — container env vars take priority
require('dotenv').config({ path: __dirname + '/.env', override: false });
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const scopeFilter = require('../../src/middleware/scope-filter');

const app = express();
const EDITION = process.env.WREN_EDITION || 'eyfs';
const SCHEMA = process.env.PG_SCHEMA || 'demo_eyfs';

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
app.use(scopeFilter);

// Serve shared public files (CSS, JS)
// no-cache for /js/wren-shell.js and /js/wren-module-renderer.js — these change often during development
app.use((req, res, next) => {
  if (req.path === '/js/wren-shell.js' || req.path === '/js/wren-module-renderer.js') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

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

app.use(express.static(path.join(__dirname, '../../public')));
// Serve edition-specific public files (HTML pages)
app.use(express.static(path.join(__dirname, 'public')));

// ── Portal route aliases — clean URLs for each portal ──
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/portal.html')));
app.get('/portal', (req, res) => res.sendFile(path.join(__dirname, 'public/portal.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));
app.get('/parent', (req, res) => res.sendFile(path.join(__dirname, 'public/parent.html')));
app.get('/learning', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/hr', (req, res) => res.sendFile(path.join(__dirname, 'public/hr.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public/login.html')));

// Mount shared routes
app.use('/api/auth',         require('../../src/routes/auth'));
app.use('/api/children',     require('../../src/routes/children'));
app.use('/api/staff',        require('../../src/routes/staff'));
app.use('/api/observations', require('../../src/routes/observations'));
app.use('/api/attendance',   require('../../src/routes/attendance'));
app.use('/api/diary',        require('../../src/routes/diary'));
app.use('/api/sleep',        require('../../src/routes/sleep'));
app.use('/api/medicine',     require('../../src/routes/medicine'));
app.use('/api/incidents',    require('../../src/routes/incidents'));
app.use('/api/behaviour',     require('../../src/routes/behaviour'));
app.use('/api/sen',           require('../../src/routes/sen'));
app.use('/api/assessments',  require('../../src/routes/assessments'));
app.use('/api/safeguarding', require('../../src/routes/safeguarding'));
app.use('/api/absence',      require('../../src/routes/absence'));
app.use('/api/enquiries',    require('../../src/routes/enquiries'));
app.use('/api/admin',        require('../../src/routes/admin'));
app.use('/api/parents',      require('../../src/routes/parents'));
app.use('/api/ai',           require('../../src/routes/ai'));
app.use('/api/cpd',          require('../../src/routes/cpd'));
app.use('/api/curriculum',   require('../../src/routes/curriculum'));
app.use('/api/planning',            require('../../src/routes/planning'));
app.use('/api/next-steps',          require('../../src/routes/next-steps'));
app.use('/api/planned-activities',  require('../../src/routes/planned-activities'));
app.use('/api/phonics',      require('../../src/routes/phonics'));
app.use('/api/reports',      require('../../src/routes/reports'));
app.use('/api/it-settings',   require('../../src/routes/it-settings'));
app.use('/api/outings',       require('../../src/routes/outings'));
app.use('/api/action-plans',  require('../../src/routes/action-plans'));
app.use('/api/supervisions',  require('../../src/routes/supervisions'));
app.use('/api/activity-bank', require('../../src/routes/activity-bank'));
app.use('/api/first-words',   require('../../src/routes/first-words'));
app.use('/api/performance',   require('../../src/routes/performance'));
app.use('/api/funding',       require('../../src/routes/funding'));
app.use('/api/messages',      require('../../src/routes/messages'));
app.use('/api/newsletter',    require('../../src/routes/newsletter'));
// Convenience alias: GET /api/frameworks (also available at /api/it-settings/frameworks)
app.get('/api/frameworks', (req, res) => {
  const fs = require('fs'), p = require('path');
  try { res.json(JSON.parse(fs.readFileSync(p.join(__dirname, '../../data/framework-versions.json'), 'utf8'))); }
  catch { res.status(500).json({ error: 'Framework data unavailable' }); }
});

app.use('/api/modules',        require('../../src/routes/modules'));
app.use('/api/module-uploads', require('../../src/routes/modules').uploadsHandler);
app.use('/api/menus',          require('../../src/routes/menus'));
app.use('/api/notifications',  require('../../src/routes/notifications'));
app.use('/api/repairs',        require('../../src/routes/repairs'));

app.get('/api/edition', (req, res) => res.json({
  edition: EDITION,
  schema: SCHEMA,
  demo: process.env.DEMO_MODE === 'true'
}));

// POST /api/demo/reset — wipe mutable demo data and re-seed (DEMO_MODE only)
app.post('/api/demo/reset', async (req, res) => {
  if (process.env.DEMO_MODE !== 'true') {
    return res.status(403).json({ error: 'Not a demo environment' });
  }
  const secret = req.headers['x-demo-reset'];
  if (secret !== 'wren-demo-2026' && secret !== process.env.DEMO_RESET_SECRET) {
    return res.status(403).json({ error: 'Invalid reset secret' });
  }

  // Advisory lock — skip if another reset is in progress
  const { getPool } = require('../../src/db/pool');
  const db = getPool();
  const lockKey = 7777001; // arbitrary bigint advisory lock

  let lockAcquired = false;
  try {
    const { rows: lockRows } = await db.query('SELECT pg_try_advisory_lock($1)', [lockKey]);
    lockAcquired = lockRows[0]?.pg_try_advisory_lock === true;
    if (!lockAcquired) {
      return res.status(429).json({ error: 'Reset already in progress — try again in a moment' });
    }

    const fs = require('fs');
    const seedPath = require('path').join('/app/scripts', 'demo-seed-eyfs.sql');
    const fallbackPath = require('path').join(__dirname, '../../scripts/demo-seed-eyfs.sql');
    const sqlFile = fs.existsSync(seedPath) ? seedPath : fallbackPath;
    const fullSQL = fs.readFileSync(sqlFile, 'utf8');

    // Only run the MUTABLE section (everything after the marker comment)
    const marker = '-- MUTABLE DATA';
    const mutableIdx = fullSQL.indexOf(marker);
    const mutableSQL = mutableIdx >= 0
      ? `SET search_path TO ${process.env.PG_SCHEMA || 'demo_eyfs'};\n` + fullSQL.slice(mutableIdx)
      : fullSQL;

    await db.query(mutableSQL);
    return res.json({ ok: true, message: 'Demo data reset to seed state' });
  } catch (e) {
    console.error('[demo/reset]', e.message);
    return res.status(500).json({ error: e.message });
  } finally {
    if (lockAcquired) await db.query('SELECT pg_advisory_unlock($1)', [lockKey]).catch(() => {});
  }
});

app.get('/health', (req, res) => res.json({ ok: true, edition: EDITION, ts: Date.now() }));

// v2 SPA shell — Manager portal
app.get(/^\/app(\/.*)?$/, (req, res) => res.sendFile(path.join(__dirname, 'public/app.html')));

// SPA fallback — serve login for unknown routes
app.use( (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

const PORT = process.env.PORT || 3000;
// Groq proxy — keeps API key server-side
app.post('/api/groq/chat', async (req, res) => {
  const GROQ_KEY = process.env.GROQ_API_KEY;
  if (!GROQ_KEY) return res.status(503).json({ error: 'AI demo unavailable' });
  const { messages, model, max_tokens, stream } = req.body;
  try {
    const upstream = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: model || 'llama-3.1-8b-instant', messages, max_tokens: max_tokens || 400, stream: stream !== false, temperature: 0.7 })
    });
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => {
      if (['content-type','transfer-encoding','cache-control'].includes(k)) res.setHeader(k, v);
    });
    upstream.body.pipe(res);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


app.listen(PORT, () => console.log(`Wren ${EDITION.toUpperCase()} running on :${PORT} (schema: ${SCHEMA})`));
