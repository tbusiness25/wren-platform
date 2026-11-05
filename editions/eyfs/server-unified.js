// Unified EYFS server — serves EYFS learning portal + admin portal demo.
// Dispatches by req.hostname:
//   admin.*    → admin portal  (was wren-admin container, port 83)
//   everything → EYFS learning portal (was wren-eyfs, port 80)
//
// Both portals use demo_eyfs schema + DEMO_MODE=true.
// Replaces: wren-eyfs + wren-admin (2 → 1 container).

require('dotenv').config({ path: __dirname + '/.env', override: false });

const express = require('express');
const path    = require('path');
const cors    = require('cors');
const helmet  = require('helmet');
const scopeFilter = require('../../src/middleware/scope-filter');

const app     = express();
const EDITION = process.env.WREN_EDITION || 'eyfs';
const SCHEMA  = process.env.PG_SCHEMA    || 'demo_eyfs';

app.set('trust proxy', 1);

// ── Portal detection ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  req._portal = req.hostname?.startsWith('admin.') ? 'admin' : 'learning';
  next();
});

// ── Payment webhooks — raw body needed, before express.json ──────────────────
const _webhooks = require('../../src/routes/payments-webhooks');
app.use('/api/stripe/webhook',     _webhooks.stripe);
app.use('/api/gocardless/webhook', _webhooks.gocardless);

app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || false, credentials: true }));
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      imgSrc:     ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      fontSrc:    ["'self'", "data:", "https://fonts.gstatic.com"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
    }
  }
}));
app.use(scopeFilter);

// ── No-cache for shell JS ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const p = req.path;
  if (p === '/js/wren-shell.js' || p === '/js/wren-module-renderer.js' ||
      p === '/js/wren-shell-v2.js' || p.startsWith('/sections/')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma',  'no-cache');
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

// ── EY portal app-shell pages (ported from LADN 2026-07-14) ──────────────────
// Must be registered BEFORE express.static so a bare /ey isn't directory-redirected
// and extensionless /ey/* paths don't fall through to the login.html SPA fallback.
// LADN-prod-only pages deliberately omitted here: new-starters (induction + apprentice
// RAG, /api/induction not mounted), send-email (email gateway), enrol-device (CF Access
// device-trust). All still gated on req._portal === 'learning'.
app.get('/ey', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.redirect(301, '/ey/home');
});
app.get('/ey/home', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/home.html'));
});
app.get('/ey/child/:id', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/child.html'));
});
// EY observation pages
app.get('/ey/observation/new', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/observation-new.html'));
});
app.get('/ey/observation/:id', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/observation-view.html'));
});
// EY group action pages
['observation','sleep','nappies','food','bottle','toilet','diary'].forEach(t => {
  app.get(`/ey/group/${t}`, (req, res, next) => {
    if (req._portal !== 'learning') return next();
    res.sendFile(path.join(__dirname, `public/ey/group/${t}.html`));
  });
});
// EY More-menu pages — route → public/ey/<page>.html (new-starters + send-email stripped, policies added)
// b139: toolbox/room-headcount/fledge-framework/how-wren-works/my-documents/new-starters added (generic product features)
['more','drafts','trackers','activities','reports','settings','help','register','kitchen','obs-tracker','my-shifts','messages','two-year-check','repairs','supervisions','action-plans','diary-all','sleep-chart','staff-clock','visitors','policies','toolbox','room-headcount','fledge-framework','how-wren-works','my-documents','new-starters','story-studio',
 // b247 (2026-08-28) — the basic phonics tracker, mirrored from the LADN edition.
 'phonics-tracker'].forEach(p => {
  app.get(`/ey/${p}`, (req, res, next) => {
    if (req._portal !== 'learning') return next();
    res.sendFile(path.join(__dirname, `public/ey/${p}.html`));
  });
});

// b258 (2026-09-01) — clean URLs for the fifteen EY pages ported from LADN.
// A SEPARATE forEach rather than fifteen more strings in the array above, so the
// existing list is untouched and it is obvious at a glance what b258 added.
// Same shape, same portal guard, same public/ey/<page>.html target.
//
// Four of the nineteen LADN-only pages are deliberately NOT here — door,
// nursery-inbox, send-email and request-access are LADN site plumbing (the Dahua
// door station, LADN's Gmail service account, and the Cloudflare Access
// allowlist). The reasons are in wren-docs/b258-edition-rebuild-runbook.md.
['areas','my-tasks','phonics','phonics-group','plan-draft','planning','reflect',
 'resources','review-queue','risk-assessments','sen','setting-incident-new',
 'signin','termly-plan','termly-review'].forEach(p => {
  app.get(`/ey/${p}`, (req, res, next) => {
    if (req._portal !== 'learning') return next();
    res.sendFile(path.join(__dirname, `public/ey/${p}.html`));
  });
});
// EY Summative / Transition reports
app.get('/ey/reports/summative', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/reports-summative.html'));
});
// EY 2-year progress check — deep-link into trackers.html
app.get('/ey/trackers/two-year-check', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/trackers.html'));
});
// b243 (2026-08-28) — 2-year check review queue. Registered on its own, not
// appended to the route-array literal above (that is how route lists get
// accidentally rewritten). Does not shadow the existing exact-path
// '/ey/two-year-check' registration.
app.get('/ey/two-year-check/review', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/two-year-check-review.html'));
});
// b244 (2026-08-28) — Reports due. Same reason as above for its own registration.
// ── EY: CCTV footage request (b249, 2026-09-01) ──────────────────────────────
// Demo-edition parity with the LADN route of the same name. Registered on its
// own, not appended to any route-array literal.
app.get('/ey/cctv-request', (req, res, next) => {
  if (req._portal && req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/cctv-request.html'));
});

app.get('/ey/reports-due', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/reports-due.html'));
});
// b246 (2026-08-28) — Termly updates: the queue of who is owed one this
// half-term, and the five-section document itself. Its own registration for the
// same reason as the two above.
app.get('/ey/termly-update', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/termly-update.html'));
});
// b277 (2026-09-04) — the termly-update tracker: who has done theirs, who has
// not, and whether they were on time. Its own registration for the same reason.
app.get('/ey/termly-tracker', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/termly-tracker.html'));
});
// EY safeguarding entry page
app.get('/ey/safeguarding/new', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/safeguarding-new.html'));
});
// EY accident / incident report
app.get('/ey/incident/new', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/incident-new.html'));
});
// EY medicine log
app.get('/ey/medicine/new', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/medicine-new.html'));
});
// EY bottom-nav tabs: Diary and Inbox — /ey/diary/entry BEFORE /ey/diary
app.get('/ey/diary/entry', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/diary-entry.html'));
});
app.get('/ey/diary', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/diary.html'));
});
app.get('/ey/inbox', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/inbox.html'));
});
// EY bottom-nav tab: Learning Journey
app.get('/ey/journey', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/journey.html'));
});
// EY child-first action picker
app.get('/ey/log/select-action', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/log/select-action.html'));
});
// Legacy EY pages: serve from _legacy/ at /ey-legacy/* (learning only)
app.use('/ey-legacy', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  express.static(path.join(__dirname, 'public/_legacy'))(req, res, next);
});

// ── Static files: per-portal FIRST, shared public as fallback ────────────────
// (b148: shared must come AFTER per-portal, or the shared public/sw.js and any
// same-named file there would shadow each portal's own manifest/sw.js/assets.)
const _staticHandlers = {
  admin:    express.static(path.join(__dirname, '../admin/public')),
  learning: express.static(path.join(__dirname, 'public')),
};
app.use((req, res, next) => {
  const h = _staticHandlers[req._portal || 'learning'];
  h(req, res, next);
});
app.use(express.static(path.join(__dirname, '../../public')));

// ── Admin portal: SPA routes ─────────────────────────────────────────────────
app.get('/admin', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.redirect(301, '/admin/dashboard/today');
});
app.get('/admin/:section', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/app.html'));
});
app.get('/admin/:section/:tab', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/app.html'));
});
app.get('/study', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/study.html'));
});

// ── EYFS learning: portal route aliases ──────────────────────────────────────
app.get('/', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/portal.html'));
});
app.get('/portal', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/portal.html'));
});
app.get('/admin', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/admin.html'));
});
app.get('/parent', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/parent.html'));
});
app.get('/learning', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/index.html'));
});
app.get('/hr', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/hr.html'));
});
app.get('/login', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/login.html'));
});

// ── Shared API routes (both portals) ─────────────────────────────────────────
app.use('/api/auth',         require('../../src/routes/auth'));
app.use('/api/children',     require('../../src/routes/children'));
app.use('/api/staff',        require('../../src/routes/staff'));
app.use('/api/observations', require('../../src/routes/observations'));
app.use('/api/attendance',   require('../../src/routes/attendance'));
app.use('/api/diary',        require('../../src/routes/diary'));
app.use('/api/daily-diary',  require('../../src/routes/daily-diary-group'));
app.use('/api/sleep',        require('../../src/routes/sleep'));
app.use('/api/medicine',     require('../../src/routes/medicine'));
app.use('/api/incidents',    require('../../src/routes/incidents'));
app.use('/api/behaviour',    require('../../src/routes/behaviour'));
app.use('/api/sen',          require('../../src/routes/sen'));
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
app.use('/api/it-settings',  require('../../src/routes/it-settings'));
// First-run setup wizard API (prompt 67) — unauthenticated + self-gated on settings.setup_complete
try { app.use('/api/setup', require('../../src/routes/setup')); } catch(e) { console.error('mount setup:', e.message); }
app.use('/api/outings',      require('../../src/routes/outings'));
app.use('/api/action-plans',  require('../../src/routes/action-plans'));
app.use('/api/action-plan-items', require('../../src/routes/action-plan-items'));
app.use('/api/supervisions',  require('../../src/routes/supervisions'));
app.use('/api/activity-bank', require('../../src/routes/activity-bank'));
app.use('/api/first-words',   require('../../src/routes/first-words'));
app.use('/api/performance',   require('../../src/routes/performance'));
app.use('/api/funding',       require('../../src/routes/funding'));
app.use('/api/messages',      require('../../src/routes/messages'));
app.use('/api/newsletter',    require('../../src/routes/newsletter'));
app.use('/api/survey',        require('../../src/routes/survey'));
app.use('/api/modules',        require('../../src/routes/modules'));
app.use('/api/module-uploads', require('../../src/routes/modules').uploadsHandler);
app.use('/api/menus',          require('../../src/routes/menus'));
app.use('/api/notifications',  require('../../src/routes/notifications'));
app.use('/api/repairs',        require('../../src/routes/repairs'));
// b243 (2026-08-28) — statutory progress check at age two. The router self-gates
// on the edition family (EYFS only) and the lib loads the local model lazily, so
// a demo box with AI_PROVIDER=groq still drafts on the Ascent or not at all —
// a named child's developmental summary never goes to a hosted provider.
// try/catch because a mount failure here must not take the demo edition down.
try { app.use('/api/two-year-check', require('../../src/routes/two-year-check')); }
catch (e) { console.error('mount two-year-check:', e.message); }
// b528 (2026-10-26) — the evidence panel behind the review screen this edition
// also serves (/ey/two-year-check/review). Mounted here too or the panel 404s on
// the EYFS edition while working on LADN.
try { app.use('/api/report-evidence', require('../../src/routes/report-evidence')); }
catch (e) { console.error('mount report-evidence:', e.message); }
// b244 (2026-08-28) — the report cycle: when each child's settling-in report,
// six-month chat, termly update and 2-year check fall due, and which of the
// documents already on file satisfy them. A pure read; it drafts nothing, so
// there is no model involved and no sovereignty question to answer here.
try { app.use('/api/report-cycle', require('../../src/routes/report-cycle')); }
catch (e) { console.error('mount report-cycle:', e.message); }
// b246 (2026-08-28) — the termly update itself: five sections, one per half-term
// on the school term calendar, approved by a named practitioner before any
// parent sees it. Same self-gating and same lazy model load as b243 above, for
// the same reason — a named child's developmental record never leaves the
// local network.
try { app.use('/api/termly-update', require('../../src/routes/termly-update')); }
catch (e) { console.error('mount termly-update:', e.message); }

// b277 (2026-09-04) — the watcher's tracker and its half-term staff report.
// The ROUTER is mounted here so the demo can show the board; the watcher SERVICE
// is deliberately NOT started on this edition. A demo has no real families, and
// a background job that publishes documents to them is not something a sales
// walkthrough should be able to trigger. LADN starts it in
// editions/ladn/server-unified.js.
try { app.use('/api/termly-watcher', require('../../src/routes/termly-watcher')); }
catch (e) { console.error('mount termly-watcher:', e.message); }

// ── b139 demo parity: generic product features ported from LADN (2026-07-22) ──
try { app.use('/api/occupancy',          require('../../src/routes/occupancy')); }          catch(e) { console.error('mount occupancy:', e.message); }
try { app.use('/api/occupancy-calendar', require('../../src/routes/occupancy-calendar')); }  catch(e) { console.error('mount occupancy-calendar:', e.message); }
try { app.use('/api/occupancy-sandbox',  require('../../src/routes/occupancy-sandbox')); }   catch(e) { console.error('mount occupancy-sandbox:', e.message); }
try { app.use('/api/occupancy-v2',       require('../../src/routes/occupancy-v2')); }        catch(e) { console.error('mount occupancy-v2:', e.message); }
try { app.use('/api/room-headcounts',    require('../../src/routes/room-headcounts')); }     catch(e) { console.error('mount room-headcounts:', e.message); }
try { app.use('/api/fee-items',          require('../../src/routes/fee-items')); }           catch(e) { console.error('mount fee-items:', e.message); }
try { app.use('/api/recruit',            require('../../src/routes/recruit')); }             catch(e) { console.error('mount recruit:', e.message); }
try { app.use(require('../../src/routes/recruit-public')); }                                 catch(e) { console.error('mount recruit-public:', e.message); }
try { app.use('/api/leave-weights',      require('../../src/routes/leave-weights')); }       catch(e) { console.error('mount leave-weights:', e.message); }
try { app.use('/api/absence-fairness',   require('../../src/routes/absence-fairness')); }    catch(e) { console.error('mount absence-fairness:', e.message); }
try { app.use('/api/sen-flag',           require('../../src/routes/sen-flag')); }            catch(e) { console.error('mount sen-flag:', e.message); }
try { app.use('/api/induction',          require('../../src/routes/induction')); }           catch(e) { console.error('mount induction:', e.message); }
try { app.use('/api/custom-frameworks',  require('../../src/routes/custom-frameworks')); }   catch(e) { console.error('mount custom-frameworks:', e.message); }
try { app.use('/api/person-documents',   require('../../src/routes/person-documents')); }    catch(e) { console.error('mount person-documents:', e.message); }
try { app.use('/api/story-studio',       require('../../src/routes/story-studio')); }        catch(e) { console.error('mount story-studio:', e.message); } // b152
try { app.use('/api/staff-occasions',    require('../../src/routes/staff-occasions')); }     catch(e) { console.error('mount staff-occasions:', e.message); } // b152

// ── Frameworks alias (EYFS learning) ─────────────────────────────────────────
app.get('/api/frameworks', (req, res) => {
  const fs = require('fs'), p = require('path');
  try { res.json(JSON.parse(fs.readFileSync(p.join(__dirname, '../../data/framework-versions.json'), 'utf8'))); }
  catch { res.status(500).json({ error: 'Framework data unavailable' }); }
});

// ── Admin-only routes ─────────────────────────────────────────────────────────
app.use('/api/features',          require('../../src/routes/features'));
app.use('/api/kitchen',           require('../../src/routes/kitchen'));
app.use('/api/tasks',             require('../../src/routes/tasks'));
app.use('/api/calendar',          require('../../src/routes/calendar'));
app.use('/api/comms',             require('../../src/routes/comms'));
app.use('/api/vapi',              require('../../src/routes/vapi'));
app.use('/api/aria',              require('../../src/routes/aria'));
app.use('/api/compliance-events', require('../../src/routes/compliance-events'));
app.use('/api/invoices',          require('../../src/routes/invoices'));
app.use('/api/daily-briefing',    require('../../src/routes/daily-briefing'));
app.use('/api/parent-reports',    require('../../src/routes/parent-reports'));
app.use('/api/parents',           require('../../src/routes/parents'));
app.use('/api/memory-box',        require('../../src/routes/memory-box'));
app.use('/api/leavers-book',      require('../../src/routes/leavers-book'));
app.use('/api/rota',              require('../../src/routes/rota'));
app.use('/api/export',            require('../../src/routes/export'));
app.use('/api/audit',             require('../../src/routes/audit'));
app.use('/api/study',             require('../../src/routes/study'));
app.use('/api/security',          require('../../src/routes/security'));
app.use('/api/email-triage',      require('../../src/routes/email-triage'));
app.use('/api/state',             require('../../src/routes/state-forecast'));
app.use('/api/permissions',       require('../../src/routes/permissions'));
app.use('/api/vapi-actions',      require('../../src/routes/vapi-actions'));
app.use('/api/vapi-health',       require('../../src/routes/vapi-health'));
app.use('/api/import',            require('../../src/routes/import-wizard'));
app.use('/api/ctf',               require('../../src/routes/ctf'));
app.use('/api/payments-admin',    require('../../src/routes/payments-admin'));
app.use('/api/payments',          require('../../src/routes/payments'));
app.use('/api/finance/dashboard', require('../../src/routes/finance-dashboard'));
app.use('/api/finance/forecast',  require('../../src/routes/finance-forecast'));
app.use('/api/finance/invoices',  require('../../src/routes/finance-invoices'));
app.use('/api/finance/reconcile', require('../../src/routes/finance-reconcile'));
app.use('/api/finance/wages',     require('../../src/routes/finance-wages'));
app.use('/api/finance/payroll',   require('../../src/routes/finance-payroll'));
app.use('/api/open-banking',      require('../../src/routes/open-banking'));
app.use('/api/migration',         require('../../src/routes/migration-helper'));
try { app.use('/api/ai', require('../../src/routes/ai-features')); } catch (e) { console.error('ai-features:', e.message); }

// ── Universal routes — added for API parity with LADN ────────────────────────
app.use('/api/clockin',          require('../../src/routes/clockin'));
app.use('/api/transcribe',       require('../../src/routes/transcribe'));
app.use('/api/interventions',    require('../../src/routes/intervention'));
app.use('/api/decision-log',     require('../../src/routes/decision-log'));
app.use('/api/permission-slips', require('../../src/routes/permission-slips'));
app.use('/api/toil',             require('../../src/routes/toil'));
app.use('/api/policies',         require('../../src/routes/policies'));
// b249 — CCTV footage disclosure requests (demo-edition parity with LADN).
try { app.use('/api/cctv',       require('../../src/routes/cctv')); } catch (e) { console.error('mount cctv:', e.message); }
app.use('/api/wellbeing',        require('../../src/routes/wellbeing'));
app.use('/api/courses',          require('../../src/routes/courses'));
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
app.use('/api/safeguarding-ext',  require('../../src/routes/safeguarding-ext'));
app.use('/api/risk-assessments',  require('../../src/routes/risk-assessments'));
app.use('/api/coshh',             require('../../src/routes/coshh'));
app.use('/api/fire-safety',       require('../../src/routes/fire-safety'));
app.use('/api/inspection',        require('../../src/routes/inspection'));

// ── Ported from LADN for product parity (2026-06-18) ─────────────────────────
// Integration-only routes deliberately excluded: vapi*, n8n/workflows side, away-mode,
// google-cal, intercom, ha-webhook, frigate, regulatory poller. Self-built workflow
// engine (modules/notification-dispatcher) is already mounted above.
function _eyfsMount(routePath, mod){ try { app.use(routePath, require(mod)); } catch(e){ console.error('mount '+routePath+':', e.message); } }
_eyfsMount('/api/occupancy',           '../../src/routes/occupancy');
_eyfsMount('/api/work-patterns',       '../../src/routes/work-patterns');
_eyfsMount('/api/menu',                '../../src/routes/menu');
_eyfsMount('/api/voice-notes',         '../../src/routes/voice-notes');
_eyfsMount('/api/review',              '../../src/routes/review');
_eyfsMount('/api/cockpit',             '../../src/routes/cockpit');
_eyfsMount('/api/contracts',           '../../src/routes/contracts');
_eyfsMount('/api/handbook',            '../../src/routes/handbook');
_eyfsMount('/api/documents/workspaces','../../src/routes/document-workspaces');
_eyfsMount('/api/contacts',            '../../src/routes/contacts');
_eyfsMount('/api/ai-helper',           '../../src/routes/ai-helper');
_eyfsMount('/api/staff-analytics',     '../../src/routes/staff-analytics');
_eyfsMount('/api/funding-portal',      '../../src/routes/funding-portal');
_eyfsMount('/api/finance',             '../../src/routes/finance-xero');

// ── b258 (2026-09-01) — the routes behind the EY pages ported from LADN ──────
// Fifteen pages under editions/eyfs/public/ey/ arrived in b258. These are the
// shared routes they call. APPENDED, never replacing a mount above: every one of
// these was checked against the existing list first and none of them was already
// mounted.
//
// Each backing table is created in demo_eyfs by
// migrations/2026-09-01-b258-edition-parity.sql, which must be applied BEFORE
// this container is rebuilt — otherwise these routes mount fine and then 500 on
// a table that is not there.
//
// NOT mounted, deliberately, because the pages that use them are LADN plumbing
// and were not ported: /api/door + /api/intercom (the Dahua door station),
// /api/email-gateway and /api/comms/emails (LADN's Gmail service account),
// /api/access-requests (Cloudflare Access allowlist + LADN's Google Workspace
// group; the route also writes ladn.access_requests unconditionally).
_eyfsMount('/api/areas',              '../../src/routes/areas');
_eyfsMount('/api/plan-drafts',        '../../src/routes/plan-drafts');
// /api/resource-cards and /api/resource-inventory are NOT mounted here — the
// b168 demo-parity block further down already mounts both, and a second mount of
// the same router is a silent no-op at best.
_eyfsMount('/api/reflections',        '../../src/routes/reflections');
_eyfsMount('/api/knowledge',          '../../src/routes/knowledge');
_eyfsMount('/api/setting-incidents',  '../../src/routes/setting-incidents');
_eyfsMount('/api/staff-signin',       '../../src/routes/staff-signin');
_eyfsMount('/api/termly-reviews',     '../../src/routes/termly-reviews');
// b242's sidebar layout matrix. Presentation only — hiding a section here never
// grants or denies access; that stays with the b237 capability matrix.
_eyfsMount('/api/nav-layout',         '../../src/routes/nav-layout');

// Framework statements — product set only. B25 (birth_to_5), COEL and EYDJ are
// LADN-internal and never exposed in the product edition (Development Matters is the default).
const _eyfsFrameworkMap = {
  EYFS: 'eyfs_statutory', CFE: 'development_matters', DM: 'development_matters',
  SEND: 'send', Leuven: 'leuven', Phonics: 'phonics', ECERS: 'ecers_3', ITERS: 'iters_3',
};
const _eyfsAuthenticate = require('../../src/middleware/auth');
app.get('/api/framework-statements', _eyfsAuthenticate, async (req, res) => {
  const fw    = _eyfsFrameworkMap[req.query.framework] || req.query.framework || 'eyfs_statutory';
  if (['birth_to_5', 'eydj'].includes(fw)) return res.json([]); // product guard — never serve LADN-only frameworks
  const area  = req.query.area || null;
  const q     = req.query.q || null;
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const db    = require('../../src/db/pool').getPool();
  const params = [fw];
  let sql = "SELECT id,framework,area,aspect,age_range,statement_code,statement_text,ordinal FROM framework_statements WHERE framework=$1 AND statement_text NOT LIKE '(stub%'";
  if (area) { params.push(area); sql += ` AND area=$${params.length}`; }
  if (q)    { params.push(q);    sql += ` AND (statement_text ILIKE '%'||$${params.length}||'%' OR area ILIKE '%'||$${params.length}||'%' OR aspect ILIKE '%'||$${params.length}||'%')`; }
  sql += ` ORDER BY framework, ordinal, id LIMIT $${params.length + 1}`;
  params.push(limit);
  try { const { rows } = await db.query(sql, params); res.json(rows); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── b168 demo parity (2026-07-28) — "cool stuff" ported from LADN ────────────
_eyfsMount('/api/resource-cards',     '../../src/routes/resource-cards');
_eyfsMount('/api/setting-content',    '../../src/routes/setting-content'); // b257 — setting's own programmes/lessons/media (mount-backed)
_eyfsMount('/api/resource-inventory', '../../src/routes/resource-inventory');
_eyfsMount('/api/story-studio',       '../../src/routes/story-studio');
_eyfsMount('/api/custom-frameworks',  '../../src/routes/custom-frameworks');
_eyfsMount('/api/planner',            '../../src/routes/planner');
// b353 — Morning Starters (Reception). Demo eyfs only, deliberately never
// mounted in editions/ladn — see scripts/morning-starters/generate.js.
try { app.use('/api/morning-starters', require('../../src/routes/morning-starters')('morning-starters-eyfs')); } catch(e){ console.error('mount /api/morning-starters:', e.message); }
_eyfsMount('/api/automations',        '../../src/routes/automations');
_eyfsMount('/api/visual-schedules',   '../../src/routes/visual-schedules');
_eyfsMount('/api/sen-flag',           '../../src/routes/sen-flag');

// ── Demo reset (EYFS learning only) ──────────────────────────────────────────
app.post('/api/demo/reset', async (req, res) => {
  if (process.env.DEMO_MODE !== 'true') return res.status(403).json({ error: 'Not a demo environment' });
  const secret = req.headers['x-demo-reset'];
  if (secret !== 'wren-demo-2026' && secret !== process.env.DEMO_RESET_SECRET) return res.status(403).json({ error: 'Invalid reset secret' });
  const { getPool } = require('../../src/db/pool');
  const db = getPool();
  const lockKey = 7777001;
  let lockAcquired = false;
  try {
    const { rows } = await db.query('SELECT pg_try_advisory_lock($1)', [lockKey]);
    lockAcquired = rows[0]?.pg_try_advisory_lock === true;
    if (!lockAcquired) return res.status(429).json({ error: 'Reset already in progress' });
    const fs = require('fs');
    const seedPath = require('path').join('/app/scripts', 'demo-seed-eyfs.sql');
    const fallbackPath = require('path').join(__dirname, '../../scripts/demo-seed-eyfs.sql');
    const sqlFile = fs.existsSync(seedPath) ? seedPath : fallbackPath;
    const fullSQL = fs.readFileSync(sqlFile, 'utf8');
    const marker = '-- MUTABLE DATA';
    const idx = fullSQL.indexOf(marker);
    const mutableSQL = idx >= 0
      ? `SET search_path TO ${SCHEMA};\n` + fullSQL.slice(idx)
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

// ── Groq proxy (demo AI, EYFS learning only) ──────────────────────────────────
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Admin security cron ───────────────────────────────────────────────────────
try { require('../../src/security/runner').startCron(); } catch (e) { console.error('security cron:', e.message); }

app.get('/api/edition', (req, res) => res.json({
  edition: req._portal === 'admin' ? 'admin' : EDITION,
  schema: SCHEMA,
  demo: process.env.DEMO_MODE === 'true',
}));

app.get('/health',  (req, res) => res.json({ ok: true, portal: req._portal, edition: EDITION, ts: Date.now() }));
app.get('/healthz', (req, res) => res.json({ ok: true, portal: req._portal, edition: EDITION, ts: Date.now() }));

// ── SPA fallback per portal ───────────────────────────────────────────────────
// EYFS learning: v2 SPA shell
app.get(/^\/app(\/.*)?$/, (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/app.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  const loginFile = req._portal === 'admin'
    ? path.join(__dirname, '../admin/public/login.html')
    : path.join(__dirname, 'public/login.html');
  res.sendFile(loginFile);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`Wren EYFS Unified on :${PORT} (schema: ${SCHEMA}) — portals: admin|learning via hostname`)
);
