'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// parent-enquiry-mode.js — b399 (2026-10-06).
//
// Gates the parents portal for a family that is on the pipeline but not yet
// enrolled — "enquiry mode". A parent is in enquiry mode when EVERY active
// parent_portal_access row for their email is access_level='enquiry'; a
// parent who also has a real child is never gated (resolved per-request —
// enrolling them lifts the gate the moment ensureFamilyAccess promotes the
// row, no cache to invalidate).
//
// Mounted path-less in editions/ladn/server-unified.js, BEFORE the /welcome/*
// page routes (same reason _requireVerifiedParentSession there is path-less —
// Express 5 does not match a bare RegExp passed to app.use()'s path arg).
//
// Default-deny: only the features an enquiring family needs are allowed
// (messages, the home log, notifications, nursery info pages, their own
// account, home). Everything else under /welcome/* and the shared
// parents-only API prefixes is refused — new pages added later are refused
// by default, which is the safe direction for this gate to fail in.
// ─────────────────────────────────────────────────────────────────────────────
const { resolveParentIdentity, parentEmailOf } = require('./parent-identity');
const { isEnquiryModeEmail } = require('./enquiry-access');

// Feature slug = the first /welcome/<slug> path segment. Covers both the page
// (GET /welcome/<slug>) and that feature's own nested API
// (/welcome/<slug>/api/..., matching _WELCOME_API_RE in server-unified.js).
const ALLOWED_WELCOME_FEATURES = new Set([
  'messages',
  'baby-log',
  'notifications',       // covers /welcome/notifications and /welcome/notifications/settings
  'menu',
  'policies',
  'fees',
  'about',
  'details',             // "Your account"
  // b400 (2026-10-06) — Toby: get the children in good habits before they
  // start with us. Covers /welcome/study (+ /rewards, /:slug, /:slug/completed),
  // /welcome/home-activities, /welcome/resources (+ its /api/tree,list,file,
  // guides,documents,phonics-materials — all one feature slug), /welcome/planning.
  'study',
  'home-activities',
  'resources',
  'planning',
  // b425b fix #5 — /welcome/study now redirects to /welcome/library?type=study_module
  // (b425); an enquiry family could reach study modules before that redirect and
  // lost them after, purely because 'library' was never added here. Enquiry
  // families see only what they already saw (their own study modules — the
  // catalogue itself still scopes everything else to a real enrolled family).
  'library',
]);

// Shared (non-/welcome-prefixed) parents API groups that belong to features
// NOT in the allow-list above (documents, memory box, next-steps). None of
// these are reachable in enquiry mode.
const REFUSED_SHARED_PREFIXES = ['/api/module-uploads', '/api/memory-box',
  '/api/action-plans', '/api/action-plan-items', '/api/phonics/parent'];

function _isAllowed(path) {
  if (path === '/welcome') return true; // home — renders its own cut-down screen
  const m = path.match(/^\/welcome\/([^/]+)/);
  if (m && ALLOWED_WELCOME_FEATURES.has(m[1])) return true;
  return false;
}

function _isInScope(path) {
  if (path === '/welcome' || path.startsWith('/welcome/')) return true;
  return REFUSED_SHARED_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
}

const _REFUSED_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Not available yet — Your Nursery</title>
<style>body{font-family:Arial,sans-serif;background:#fefcf8;color:#2a2a2a;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;text-align:center}
.box{max-width:420px}h1{font-size:1.3rem;color:#1e3d31}a{color:#2d5a4a}</style></head>
<body><div class="box"><h1>Not available yet</h1>
<p>This page opens once your child has a confirmed place with us. In the meantime you can
message the nursery or use the home log from your home screen.</p>
<p><a href="/welcome">&larr; Back to your home screen</a></p></div></body></html>`;

async function _refuse(req, res) {
  if (req.path.startsWith('/api/') || req.path.includes('/api/')) {
    return res.status(403).json({ error: 'enquiry_mode_restricted',
      message: 'This opens once your child has a confirmed place with us.' });
  }
  return res.status(403).send(_REFUSED_HTML);
}

async function enquiryModeGate(req, res, next) {
  if (req._portal !== 'parents') return next();
  if (!_isInScope(req.path)) return next();

  let email = parentEmailOf(req);
  if (!email) {
    try {
      const r = await resolveParentIdentity(req);
      if (r.ok) email = r.email;
    } catch { /* unresolved — leave to the existing gates / page render */ }
  }
  if (!email) return next();

  let enquiryOnly = false;
  try { enquiryOnly = await isEnquiryModeEmail(require('../db/pool').getPool(), email); }
  catch (e) { console.error('[parent-enquiry-mode]', e.message); return next(); }
  if (!enquiryOnly) return next();
  if (_isAllowed(req.path)) return next();
  return _refuse(req, res);
}

module.exports = { enquiryModeGate, ALLOWED_WELCOME_FEATURES };
