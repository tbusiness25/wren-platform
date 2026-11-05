'use strict';
// E3b (2026-10-20) — ACCIDENT FORM: the parent's side.
//
// What was wrong. POST /api/incidents/:id/notify-parent minted a signing token and
// handed back a link on the ROOST host (ADMIN_BASE_URL), which sits behind a
// Cloudflare Access policy for Toby alone — no parent could ever open it. And both
// halves of /api/incidents/sign/:token sat behind this app's `authenticate`, so the
// link needed a STAFF JWT: a parent could not use it, while any member of staff who
// had one could POST it and the form would record the PARENT as having signed.
//
// What this is. The token on its own is the credential, and nothing else is accepted:
//   GET  /accident/:token                      the page a parent opens
//   GET  /api/public/accident/:token            the record behind it (JSON)
//   POST /api/public/accident/:token/sign       the signature
// Mounted PUBLIC/pre-auth in server-unified.js on the same shelf as
// viewings-public.js, keepsake-public.js and onboarding-public.js, and
// portal-agnostic (matched on path), so the link works on the parents host.
//
// The controls the old route had none of:
//   • scoped   — the token selects exactly one incident and returns only that
//                child's accident; it is never an identifier for anything else.
//   • single-use— signing clears the token, so the link dies the moment it is used.
//   • expiring — parent_signature_expires_at, 14 days by default
//                (INCIDENT_SIGN_TOKEN_DAYS).
//   • rate-limited — per-IP on the page and tighter on the signature.
//   • audit-logged — every view, signature and refusal goes to the audit log.
//   • staff cannot sign as a parent — a staff JWT is not accepted here, and
//                incidents.js no longer carries a sign route that takes one.
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { getPool } = require('../db/pool');
const { recordAudit } = require('../utils/audit');

// SCOPED on purpose. This router is mounted at the app root, and a bare
// router.use(express.json()) there would be the FIRST body parser every request in Wren
// meets — the first parser wins, so it would cap every JSON body in the product at
// 64 KB. That is precisely the live bug fix-feedback-voice-20261020 is fixing in
// public-availability.js and four siblings (no staff bug report with a screenshot could
// ever be saved). Keep the path prefix.
router.use('/api/public/accident', express.json({ limit: '64kb' }));

// Rate limiting, keyed the way the rest of Wren's public routes key it.
//
// req.ip is NOT usable here. The chain is Cloudflare → cloudflared → nginx → this app
// and server-unified.js sets `trust proxy` to 1, i.e. one hop, so req.ip resolves to
// nginx and EVERY parent shares one value. A per-req.ip cap would therefore be a cap on
// the whole nursery at once: a handful of families signing on the same evening would
// start locking each other out. cf-connecting-ip is what auth.js, auth-google.js and
// auth-oidc.js key on, for exactly this reason.
//
// The signature is limited per TOKEN as well, which is the thing actually worth
// protecting: a wrong guess against one link cannot spend another family's budget, and
// the token is a v4 UUID, so guessing it is not the realistic attack anyway. The
// per-address cap is there to stop someone enumerating links from one source, and is
// set well above anything a real family does (a parent signs one form, once).
const ipKey = (req) => (req.headers['cf-connecting-ip'] || req.ip || 'unknown').toString();
const tooMany = (req, res) => res.status(429).json({
  error: 'rate_limited',
  message: 'Too many attempts. Please wait a few minutes and try again.',
});
const limiter = (max, keyGenerator) => rateLimit({
  windowMs: 10 * 60 * 1000, max, keyGenerator,
  standardHeaders: true, legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  handler: tooMany,
});

const pageLimiter   = limiter(120, ipKey);
const apiLimiter    = limiter(120, ipKey);
const signIpLimiter = limiter(60,  ipKey);
const signLimiter   = limiter(8,   (req) => 'tok:' + String(req.params.token || 'none'));

const TOKEN_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Audit without ever putting the token or the child's details in the log line.
// The real req is passed through (recordAudit reads req.ip, which is a getter on the
// prototype and would be lost by spreading it) and the actor is overridden instead:
// there is no logged-in user on this route by design.
function audit(req, action, incidentId, meta) {
  try {
    recordAudit({
      req, action,
      entity_type: 'incident',
      entity_id: incidentId == null ? null : String(incidentId),
      actor_type: 'parent',
      meta: meta || {},
    });
  } catch (_) { /* never block the parent on the audit write */ }
}

function page(title, inner) {
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} — Your Nursery</title>
<style>
  :root{--brand:#e07820;--blue:#4a9abf;--ink:#1f2937;--muted:#6b7280;--line:#e5e7eb;--bg:#fbf7f0}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--ink)}
  .wrap{max-width:640px;margin:0 auto;padding:20px 16px 60px}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  h1{font-size:1.35rem;margin:0 0 4px}
  .sub{color:var(--muted);font-size:.9rem;margin:0 0 18px}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:16px;font-weight:800;color:var(--brand)}
  .brand .dot{width:30px;height:30px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--brand))}
  dl{margin:0 0 18px}
  dt{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin-top:14px}
  dd{margin:3px 0 0;font-size:.95rem;white-space:pre-wrap}
  label{display:block;font-weight:700;font-size:.85rem;margin:18px 0 6px}
  input[type=text]{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:9px;font:inherit;background:#fff;color:var(--ink)}
  .confirm{display:flex;gap:10px;align-items:flex-start;margin:16px 0;font-size:.88rem}
  .confirm input{margin-top:3px;width:18px;height:18px}
  button{width:100%;padding:13px 16px;border:0;border-radius:10px;background:linear-gradient(135deg,var(--blue),var(--brand));color:#fff;font-weight:800;font-size:1rem;cursor:pointer}
  button:disabled{opacity:.5;cursor:default}
  .err{display:none;margin-top:12px;padding:10px 12px;border-radius:9px;background:#fef2f2;color:#b91c1c;font-size:.86rem}
  .ok{text-align:center;padding:16px 6px}
  .ok .big{font-size:2.6rem}
  .foot{text-align:center;color:var(--muted);font-size:.78rem;margin-top:18px}
</style></head><body><div class="wrap">
  <div class="brand"><span class="dot"></span> Your Nursery</div>
  <div class="card">${inner}</div>
  <div class="foot">Your Nursery · 123 Example Lane, AB1 2CD · This is a secure single-use link.</div>
</div></body></html>`;
}

function gonePage(why) {
  const msg = why === 'expired'
    ? 'This link has expired. Please ask the nursery to send you a new one.'
    : why === 'signed'
      ? 'This accident form has already been signed. Thank you — there is nothing more to do.'
      : 'This link is not valid. Please check the link the nursery sent you, or get in touch.';
  return page('Link unavailable', `<h1>Link no longer available</h1><p class="sub">${esc(msg)}</p>`);
}

// One place that turns a token into a record, so the page and the API cannot
// disagree about whether a link is live. Returns { state, row } and never leaks a
// different incident: the token is the only selector.
async function loadByToken(token) {
  if (!TOKEN_RE.test(token || '')) return { state: 'invalid' };
  const { rows } = await getPool().query(`
    SELECT i.id, i.incident_date, i.incident_time, i.incident_type, i.location,
           i.description, i.injury_description, i.injury_nature, i.first_aid_given,
           i.body_map_area, i.parent_signed_at, i.parent_signature_expires_at,
           c.first_name AS child_first_name
      FROM incidents i
      JOIN children c ON c.id = i.child_id
     WHERE i.parent_signature_token = $1
       AND i.status IS DISTINCT FROM 'draft'`, [token]);  // 2026-11-02: a draft is never shown to a parent
  if (!rows.length) return { state: 'invalid' };
  const row = rows[0];
  if (row.parent_signed_at) return { state: 'signed', row };
  if (row.parent_signature_expires_at && new Date(row.parent_signature_expires_at) < new Date()) {
    return { state: 'expired', row };
  }
  return { state: 'live', row };
}

function fmtDate(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : new Date(String(d).slice(0, 10) + 'T12:00:00');
  return isNaN(dt) ? String(d) : dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

// ── the page a parent opens ──────────────────────────────────────────────────
router.get('/accident/:token', pageLimiter, async (req, res) => {
  let r;
  try { r = await loadByToken(req.params.token); }
  catch (e) { return res.status(500).type('html').send(gonePage('invalid')); }

  if (r.state === 'invalid') { audit(req, 'parent-sign-link-invalid', null, {}); return res.status(404).type('html').send(gonePage('invalid')); }
  if (r.state === 'signed')  { audit(req, 'parent-sign-link-already-signed', r.row.id, {}); return res.status(410).type('html').send(gonePage('signed')); }
  if (r.state === 'expired') { audit(req, 'parent-sign-link-expired', r.row.id, {}); return res.status(410).type('html').send(gonePage('expired')); }

  const i = r.row;
  audit(req, 'parent-sign-link-opened', i.id, {});

  const field = (label, value) => value ? `<dt>${esc(label)}</dt><dd>${esc(value)}</dd>` : '';
  res.type('html').send(page('Accident form', `
    <h1>Accident form</h1>
    <p class="sub">Please read this and sign to confirm you have been told about it. ${esc(i.child_first_name)}'s key person is happy to talk it through with you at any time.</p>
    <dl>
      ${field('Child', i.child_first_name)}
      ${field('Date', fmtDate(i.incident_date))}
      ${field('Time', i.incident_time)}
      ${field('Where', i.location)}
      ${field('What happened', i.description)}
      ${field('Injury', i.injury_description || i.injury_nature)}
      ${field('Part of the body', i.body_map_area)}
      ${field('First aid given', i.first_aid_given)}
    </dl>
    <label for="nm">Your name</label>
    <input id="nm" type="text" autocomplete="name" placeholder="Your full name">
    <div class="confirm"><input id="cf" type="checkbox">
      <label for="cf" style="font-weight:400;margin:0">I confirm I am ${esc(i.child_first_name)}'s parent or carer and that the nursery has told me about this accident.</label></div>
    <button id="go" disabled>Sign</button>
    <div class="err" id="err"></div>
    <script>
    (function(){
      var token = ${JSON.stringify(req.params.token)};
      var nm = document.getElementById('nm'), cf = document.getElementById('cf'),
          go = document.getElementById('go'), err = document.getElementById('err');
      function sync(){ go.disabled = !(cf.checked && nm.value.trim().length > 1); }
      nm.addEventListener('input', sync); cf.addEventListener('change', sync);
      go.addEventListener('click', function(){
        go.disabled = true; go.textContent = 'Signing…'; err.style.display = 'none';
        fetch('/api/public/accident/' + encodeURIComponent(token) + '/sign', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nm.value.trim(), confirmed: true })
        }).then(function(r){ return r.json().then(function(j){ return { s: r.status, j: j }; }); })
          .then(function(o){
            if (o.s >= 200 && o.s < 300) {
              document.querySelector('.card').innerHTML =
                '<div class="ok"><div class="big">\\u2713</div><h1>Thank you</h1>' +
                '<p class="sub">Your signature has been recorded. You can close this page.</p></div>';
              return;
            }
            go.disabled = false; go.textContent = 'Sign';
            err.textContent = (o.j && (o.j.message || o.j.error)) || 'Could not sign. Please try again.';
            err.style.display = 'block';
          }).catch(function(){
            go.disabled = false; go.textContent = 'Sign';
            err.textContent = 'No connection. Please try again.'; err.style.display = 'block';
          });
      });
    })();
    </script>`));
});

// ── the record behind the page ───────────────────────────────────────────────
router.get('/api/public/accident/:token', apiLimiter, async (req, res) => {
  try {
    const r = await loadByToken(req.params.token);
    if (r.state === 'invalid') return res.status(404).json({ error: 'invalid_link', message: 'This link is not valid.' });
    if (r.state === 'signed')  return res.status(410).json({ error: 'already_signed', message: 'This form has already been signed.' });
    if (r.state === 'expired') return res.status(410).json({ error: 'expired', message: 'This link has expired.' });
    const { parent_signature_expires_at, ...safe } = r.row;
    res.json(safe);
  } catch (e) { res.status(500).json({ error: 'server_error' }); }
});

// ── the signature ────────────────────────────────────────────────────────────
// Single-use: the UPDATE both sets parent_signed_at and clears the token, and it is
// guarded on parent_signed_at IS NULL, so a replay of the same request finds no row.
router.post('/api/public/accident/:token/sign', signIpLimiter, signLimiter, async (req, res) => {
  const { name, confirmed, signature_data } = req.body || {};
  if (!TOKEN_RE.test(req.params.token || '')) {
    return res.status(404).json({ error: 'invalid_link', message: 'This link is not valid.' });
  }
  if (confirmed !== true) {
    return res.status(400).json({ error: 'not_confirmed', message: 'Please tick the confirmation box.' });
  }
  const signedName = String(name || '').trim().slice(0, 120);
  if (signedName.length < 2) {
    return res.status(400).json({ error: 'name_required', message: 'Please enter your name.' });
  }
  const sig = typeof signature_data === 'string' ? signature_data.slice(0, 40000) : null;
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE incidents
         SET parent_signed_at = NOW(),
             parent_signed_name = $2,
             parent_signed_ip = $3,
             parent_signature_data = COALESCE($4, parent_signature_data),
             parent_signature_requested = false,
             parent_signature_token = NULL
       WHERE parent_signature_token = $1
         AND parent_signed_at IS NULL
         AND status IS DISTINCT FROM 'draft'
         AND (parent_signature_expires_at IS NULL OR parent_signature_expires_at > NOW())
      RETURNING id, parent_signed_at`,
      [req.params.token, signedName, req.ip || null, sig]);

    if (!rows.length) {
      // Either never valid, already used or expired — loadByToken says which, and the
      // token has been cleared by a successful sign so it reads as 'invalid' then.
      const r = await loadByToken(req.params.token);
      audit(req, 'parent-sign-refused', r.row ? r.row.id : null, { state: r.state });
      if (r.state === 'expired') return res.status(410).json({ error: 'expired', message: 'This link has expired. Please ask the nursery for a new one.' });
      return res.status(410).json({ error: 'already_signed', message: 'This link has already been used. If that was not you, please tell the nursery.' });
    }
    audit(req, 'parent-signed', rows[0].id, { name_given: true });
    res.json({ ok: true, signed_at: rows[0].parent_signed_at });
  } catch (e) {
    console.error('[incident-sign-public]', e.message);
    res.status(500).json({ error: 'server_error', message: 'Could not sign. Please try again.' });
  }
});

module.exports = router;
