// Haven — care-home edition server (schema haven_demo, container wren-haven).
// Modelled on editions/eyfs/server.js. Single portal, PIN/JWT staff login.
// Load .env only as fallback — container env vars take priority
require('dotenv').config({ path: __dirname + '/.env', override: false });
const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');

const app = express();
const EDITION = process.env.WREN_EDITION || 'haven';
const SCHEMA = process.env.PG_SCHEMA || 'haven_demo';

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

// ── No-cache for all HTML responses ──────────────────────────────────────────
app.use((req, res, next) => {
  const orig = res.writeHead.bind(res);
  res.writeHead = function (statusCode, statusMessage, headers) {
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

// Shared public assets (CSS/JS) then Haven pages
app.use(express.static(path.join(__dirname, '../../public')));
app.use(express.static(path.join(__dirname, 'public')));

// ── Clean URLs ────────────────────────────────────────────────────────────────
const page = (f) => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
app.get('/', page('index.html'));
app.get('/login', page('login.html'));
app.get('/residents', page('residents.html'));
app.get('/resident', page('resident.html'));
app.get('/incidents', page('incidents.html'));
app.get('/safeguarding', page('safeguarding.html'));
app.get('/cqc', page('cqc.html'));
app.get('/cd-register', page('cd-register.html'));
app.get('/handover', page('handover.html'));
app.get('/staff', page('staff.html'));
app.get('/rota', page('rota.html'));

// ── Shared Wren routes (schema-agnostic via PG_SCHEMA search_path) ───────────
app.use('/api/auth',  require('../../src/routes/auth'));
app.use('/api/staff', require('../../src/routes/staff'));
app.use('/api/rota',  require('../../src/routes/rota'));

// ── Haven routes (care-home specific, editions/haven/routes/) ────────────────
app.use('/api/haven/residents',        require('./routes/residents'));
app.use('/api/haven/care-plans',       require('./routes/care-plans'));
app.use('/api/haven/risk-assessments', require('./routes/risk-assessments'));
app.use('/api/haven/incidents',        require('./routes/incidents'));
app.use('/api/haven/safeguarding',     require('./routes/safeguarding'));
app.use('/api/haven/cqc-notifications', require('./routes/cqc-notifications'));
app.use('/api/haven/mca-dols',         require('./routes/mca-dols'));
app.use('/api/haven/body-map',         require('./routes/body-map'));
app.use('/api/haven/scores',           require('./routes/clinical-scores'));
app.use('/api/haven/cd-register',      require('./routes/cd-register'));
app.use('/api/haven/notes',            require('./routes/notes'));
app.use('/api/haven/dashboard',        require('./routes/dashboard'));

app.get('/api/edition', (req, res) => res.json({
  edition: EDITION,
  schema: SCHEMA,
  demo: process.env.DEMO_MODE === 'true',
  product: 'Haven',
}));

app.get('/health', (req, res) => res.json({ ok: true, edition: EDITION, ts: Date.now() }));

// Fallback — API 404s as JSON, pages go to login
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

// Final error handler — no stack traces or internals ever reach the client
// (catches body-parser errors, route throws, etc.)
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[haven]', err.stack ? err.stack.split('\n')[0] : err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong — please try again' : 'Invalid request' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Haven (care-home edition) running on :${PORT} (schema: ${SCHEMA})`));
