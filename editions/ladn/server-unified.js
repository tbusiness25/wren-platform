// Unified LADN server — serves admin, learning, HR, and parents portals
// in a single Express process, dispatching by req.hostname.
// Replaces: wren-ladn + wren-ladn-admin + wren-hr + wren-parents (4 → 1 container).
//
// Portal dispatch:
//   admin.*    → admin portal  (was wren-ladn-admin, port 85)
//   hr.*       → HR portal     (was wren-hr,         port 87)
//   parents.*  → parents portal(was wren-parents,     port 86)
//   everything → learning portal (was wren-ladn,     port 84)

require('dotenv').config({ path: __dirname + '/.env', override: false });
// Stale-compose guard (2026-07-04): compose env_file snapshots taken before a
// var was filled leave EMPTY STRINGS in container env, which override:false
// refuses to replace (bit us with XERO_*). Backfill empty/missing keys from the
// .env file — real non-empty container-env overrides still win.
try {
  const _envParsed = require('dotenv').parse(require('fs').readFileSync(__dirname + '/.env'));
  for (const [k, v] of Object.entries(_envParsed)) {
    if (v && (process.env[k] === undefined || process.env[k] === '')) process.env[k] = v;
  }
} catch (_) { /* .env missing is fine — container env is authoritative then */ }

const express    = require('express');
const cookieParser = require('cookie-parser');
const path       = require('path');
const crypto     = require('crypto');
const fs         = require('fs');
const { Pool }   = require('pg');
const jwt        = require('jsonwebtoken');

const app    = express();
const SCHEMA = process.env.PG_SCHEMA || 'ladn';

// ── Device-enrolment: create table + self-healing additive migration ─────────
// Prompt-22 (2026-06-29) widened device_type to parents/hr, added per-profile
// binding columns, and seeded per-portal enforcement toggles (all 'off'). These
// run idempotently on every boot so a fresh DB / rebuilt image self-heals.
function _initDeviceTable() {
  const pool = require('../../src/db/pool').getPool();
  pool.query(`
    CREATE TABLE IF NOT EXISTS ladn.enrolled_devices (
      id            bigserial PRIMARY KEY,
      device_uuid   text UNIQUE NOT NULL,
      label         text,
      device_type   text NOT NULL CHECK (device_type IN ('ey_tablet','admin_pc','parents','hr')),
      enrolled_by   integer,
      created_at    timestamptz DEFAULT now(),
      last_seen_at  timestamptz,
      revoked       boolean DEFAULT false
    )
  `)
  .then(() => pool.query(`ALTER TABLE ladn.enrolled_devices DROP CONSTRAINT IF EXISTS enrolled_devices_device_type_check`))
  .then(() => pool.query(`ALTER TABLE ladn.enrolled_devices ADD CONSTRAINT enrolled_devices_device_type_check CHECK (device_type IN ('ey_tablet','admin_pc','parents','hr'))`))
  .then(() => pool.query(`ALTER TABLE ladn.enrolled_devices ADD COLUMN IF NOT EXISTS bound_subject_type text`))
  .then(() => pool.query(`ALTER TABLE ladn.enrolled_devices ADD COLUMN IF NOT EXISTS bound_subject_id text`))
  .then(() => pool.query(`INSERT INTO ladn.settings(key,value) VALUES
      ('device_enforce_ey','off'),('device_enforce_admin','off'),
      ('device_enforce_parents','off'),('device_enforce_hr','off')
    ON CONFLICT (key) DO NOTHING`))
  .catch(e => console.error('[device-enrol] table init failed:', e.message));
}
_initDeviceTable();

// ── Device-enrolment helpers ───────────────────────────────────────────────
const DEVICE_TOKEN_DURATION = '90d';
// MASTER KILL-SWITCH (env). Effective enforcement for a portal =
//   DEVICE_LIVE_ENFORCE (env DEVICE_ENFORCE==='true')  AND  settings[device_enforce_<portal>]==='on'.
// Env is currently UNSET → DEVICE_LIVE_ENFORCE is false → EVERYTHING stays log-only no
// matter what the per-portal toggles say. Nothing locks until BOTH are turned on. This is
// the intentional safety: Toby flips the env master himself once tablets are confirmed.
const DEVICE_LIVE_ENFORCE   = process.env.DEVICE_ENFORCE === 'true';

// Portal → device_type wanted, and portal → settings enforce-key.
const DEVICE_PORTAL_TYPE   = { admin: 'admin_pc', learning: 'ey_tablet', ey: 'ey_tablet', parents: 'parents', hr: 'hr' };
const DEVICE_ENFORCE_KEY   = { admin: 'device_enforce_admin', learning: 'device_enforce_ey', ey: 'device_enforce_ey', parents: 'device_enforce_parents', hr: 'device_enforce_hr' };

// Per-portal enforce toggles cached ~30s to avoid a settings lookup per request.
let _enforceCache = { at: 0, map: {} };
async function _getEnforceMap() {
  if (Date.now() - _enforceCache.at < 30000) return _enforceCache.map;
  try {
    const pool = require('../../src/db/pool').getPool();
    const { rows } = await pool.query(
      `SELECT key, value FROM ladn.settings WHERE key IN
        ('device_enforce_ey','device_enforce_admin','device_enforce_parents','device_enforce_hr')`);
    const map = {};
    for (const r of rows) map[r.key] = r.value;
    _enforceCache = { at: Date.now(), map };
    return map;
  } catch { return _enforceCache.map || {}; }
}
function _bustEnforceCache() { _enforceCache.at = 0; }
async function _effectiveEnforce(portal) {
  if (!DEVICE_LIVE_ENFORCE) return false;          // env master OFF → nothing enforced
  const key = DEVICE_ENFORCE_KEY[portal];
  if (!key) return false;
  const map = await _getEnforceMap();
  return map[key] === 'on';
}

function _makeDeviceToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, {
    issuer: 'wren-device',
    expiresIn: DEVICE_TOKEN_DURATION,
  });
}

function _verifyDeviceToken(raw) {
  if (!raw) return null;
  try { return jwt.verify(raw, process.env.JWT_SECRET, { issuer: 'wren-device' }); } catch { return null; }
}

async function _deviceOk(req, wantType) {
  const raw = req.headers['x-wren-device'] || '';
  const d = _verifyDeviceToken(raw);
  if (d && d.exp && d.exp * 1000 < Date.now()) return null;
  if (!d || !d.device_uuid) return null;
  const pool = require('../../src/db/pool').getPool();
  const { rows } = await pool.query(
    `SELECT id, device_uuid, device_type, revoked FROM ladn.enrolled_devices WHERE device_uuid = $1`,
    [d.device_uuid],
  );
  if (!rows.length || rows[0].revoked) return false;
  if (rows[0].device_type !== wantType) return false;
  // Update last_seen
  pool.query(
    `UPDATE ladn.enrolled_devices SET last_seen_at = now() WHERE id = $1`,
    [rows[0].id],
  ).catch(() => {});
  return true;
}

// Identify the authenticated SUBJECT behind a parents/HR request (for per-profile
// auto-lock). Parents have id=0, so we key on their email; HR/staff key on staff id.
// Returns {type:'parent'|'staff', id:<text>, jwt} or null when unidentifiable.
function _subjectOf(req) {
  const hdr = req.headers['authorization'] || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-wren-token'] || '');
  if (!tok) return null;
  let d; try { d = jwt.verify(tok, process.env.JWT_SECRET); } catch { return null; }
  if (!d) return null;
  if (req._portal === 'parents') {
    const email = String(d.email || d.name || '').toLowerCase();
    if (!email || email.indexOf('@') === -1) return null;
    return { type: 'parent', id: email, jwt: d };
  }
  if (req._portal === 'hr') {
    if (d.id == null) return null;
    return { type: 'staff', id: String(d.id), jwt: d };
  }
  return null;
}

// The enrolled_devices row matching the request's X-Wren-Device token (verified +
// not revoked), or null. Unlike _deviceOk this does NOT enforce a type match — the
// caller decides — and returns the full row incl. binding columns.
async function _deviceRow(req) {
  const d = _verifyDeviceToken(req.headers['x-wren-device'] || '');
  if (!d || !d.device_uuid) return null;
  if (d.exp && d.exp * 1000 < Date.now()) return null;
  const pool = require('../../src/db/pool').getPool();
  const { rows } = await pool.query(
    `SELECT id, device_uuid, device_type, revoked, bound_subject_type, bound_subject_id
       FROM ladn.enrolled_devices WHERE device_uuid = $1`, [d.device_uuid]);
  if (!rows.length || rows[0].revoked) return null;
  return rows[0];
}

// Parents/HR per-profile auto-lock.
//   • No bound device yet for this subject  → ALLOW (default unlocked). If the request
//     carries an unbound device token of the right type, auto-claim it for the subject.
//   • Subject HAS ≥1 bound device           → the request must use one of theirs, else BLOCK.
// Returns {action:'allow'|'block', subject:<label>}. Fail-open on any DB/token error.
async function _profileDeviceGate(req, wantType) {
  const subject = _subjectOf(req);
  if (!subject) return { action: 'allow' };           // unidentifiable → nothing to lock to
  const label = `${subject.type}:${subject.id}`;
  const pool = require('../../src/db/pool').getPool();
  let bound;
  try {
    bound = (await pool.query(
      `SELECT id, device_uuid FROM ladn.enrolled_devices
        WHERE bound_subject_type=$1 AND bound_subject_id=$2 AND device_type=$3 AND revoked=false`,
      [subject.type, subject.id, wantType])).rows;
  } catch { return { action: 'allow', subject: label }; }  // fail-open

  const devRow = await _deviceRow(req).catch(() => null);

  if (!bound.length) {
    // First trusted device auto-claims the profile.
    if (devRow && devRow.device_type === wantType && !devRow.bound_subject_type) {
      pool.query(
        `UPDATE ladn.enrolled_devices SET bound_subject_type=$1, bound_subject_id=$2, last_seen_at=now()
          WHERE id=$3 AND bound_subject_type IS NULL`,
        [subject.type, subject.id, devRow.id]).catch(() => {});
      console.log(`[device] auto-bound ${wantType} device id=${devRow.id} → ${label}`);
    }
    return { action: 'allow', subject: label };
  }
  // Locked: require this request's device to be one of the subject's bound devices.
  if (devRow && bound.some(b => b.device_uuid === devRow.device_uuid)) {
    pool.query(`UPDATE ladn.enrolled_devices SET last_seen_at=now() WHERE id=$1`, [devRow.id]).catch(() => {});
    return { action: 'allow', subject: label };
  }
  return { action: 'block', subject: label };
}

function _deviceGate(wantType) {
  return async (req, res, next) => {
    let enforce = false;
    try { enforce = await _effectiveEnforce(req._portal); } catch { enforce = false; }

    // Owner (ladn.staff id=1) is ALWAYS exempt on every portal.
    const hdr = req.headers['authorization'] || '';
    const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-wren-token'] || '');
    if (tok) {
      try {
        const u = jwt.verify(tok, process.env.JWT_SECRET, {audience: req._portal || 'learning'});
        if (u && Number(u.id) === 1) return next();
      } catch { /* not a valid token; not owner */ }
    }

    // Parents / HR: per-profile auto-lock (default unlocked; first trusted device claims it).
    if (req._portal === 'parents' || req._portal === 'hr') {
      const verdict = await _profileDeviceGate(req, wantType);
      if (verdict.action === 'allow') return next();
      if (!enforce) {
        console.log(`[device] would-block ${req.method} ${req.originalUrl} on ${wantType} profile=${verdict.subject} (enforce=off, log-only)`);
        return next();
      }
      console.warn(`[device] blocked ${req.method} ${req.originalUrl} from ${req.ip} (device not bound to ${wantType} profile ${verdict.subject})`);
      return res.status(403).json({
        error: 'device_required',
        message: 'This account is locked to its trusted device(s). Use an enrolled device or ask an administrator to reset the binding.',
      });
    }

    // EY tablets / Admin PCs: SHARED devices — type-match only, no per-subject binding.
    const ok = await _deviceOk(req, wantType);
    if (ok) return next();
    if (!enforce) {
      console.log(`[device] would-block ${req.method} ${req.originalUrl} on ${wantType} (enforce=off, log-only)`);
      return next();
    }
    console.warn(`[device] blocked ${req.method} ${req.originalUrl} from ${req.ip} (no valid ${wantType} token)`);
    return res.status(403).json({
      error: 'device_required',
      message: `This device requires a valid ${wantType} token to access child data.`,
    });
  };
}

app.set('trust proxy', 1);

// ── Portal detection ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const h = req.hostname || '';
  if      (h.startsWith('admin.'))   req._portal = 'admin';
  else if (h.startsWith('hr.'))      req._portal = 'hr';
  else if (h.startsWith('parents.')) req._portal = 'parents';
  else                               req._portal = 'learning';
  next();
});

// ── Payment webhooks — raw body needed, must be before express.json ───────────
const _webhooks = require('../../src/routes/payments-webhooks');
app.use('/api/stripe/webhook',     _webhooks.stripe);
app.use('/api/gocardless/webhook', _webhooks.gocardless);

// ── Public enquiry form endpoint — NO AUTH (called from landing site + public form) ─
// Accepts: name/email/phone/message/source + optional child fields (ladn_site only)
app.post('/api/public-enquiry', express.json({ limit: '32kb' }), async (req, res) => {
  const { name, email, phone, message, source, org, tier,
          child_first_name, child_last_name, child_dob } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name and email required' });
  const allowedSources = ['wren_landing', 'ladn_site'];
  const src = allowedSources.includes(source) ? source : 'ladn_site';
  const db = require('../../src/db/pool').getPool();
  try {
    let enquiryId = null;
    const notesParts = [];
    if (message) notesParts.push(message);
    if (org)     notesParts.push(`Organisation: ${org}`);
    if (tier)    notesParts.push(`Tier interest: ${tier}`);
    const notes = notesParts.join('\n') || null;

    const { rows } = await db.query(`
      INSERT INTO ladn.enquiries
        (parent_name, parent_email, parent_phone, source, notes, message,
         child_first_name, child_last_name, child_dob, stage, status)
      VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,'new','new')
      RETURNING *
    `, [name, email.toLowerCase(), phone||null, src, notes,
        child_first_name||null, child_last_name||null, child_dob||null]);
    enquiryId = rows[0].id;

    // Dual-write to contacts CRM
    const { upsertContact, upsertThread, insertThreadMessage } = require('../../src/routes/contacts');
    const contactId = await upsertContact(db, { email, phone: phone||null, name, status: 'enquirer', enquiryId });
    const subject   = src === 'wren_landing'
      ? `Wren enquiry: ${name}${org ? ` (${org})` : ''}`
      : `Nursery enquiry: ${child_first_name ? child_first_name + ' ' + (child_last_name||'') : name}`;
    const threadId  = await upsertThread(db, contactId, subject);
    const body      = src === 'wren_landing'
      ? `Wren product enquiry\nFrom: ${name} <${email}>${org ? '\nOrg: '+org : ''}${tier ? '\nTier: '+tier : ''}${message ? '\n\n'+message : ''}`
      : `Nursery enquiry from ${name}${child_first_name ? '\nChild: '+child_first_name+' '+(child_last_name||'') : ''}${child_dob ? '\nDOB: '+child_dob : ''}${message ? '\n\n'+message : ''}`;
    await insertThreadMessage(db, {
      threadId, direction: 'in', source: 'enquiry_form',
      bodyText: body, senderEmail: email, senderPhone: phone||null,
      enquiryId,
    });

    // Telegram ping
    const tgTok = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;
    if (tgTok && tgChat) {
      const label = src === 'wren_landing' ? '🌱 *Wren product enquiry*' : '🏫 *Nursery enquiry* (LADN website)';
      const tgText = `${label}\nFrom: ${name} <${email}>${org ? '\nOrg: '+org : ''}${child_first_name ? '\nChild: '+child_first_name : ''}${message ? '\n> '+message.slice(0,160) : ''}`;
      fetch(`https://api.telegram.org/bot${tgTok}/sendMessage`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chat_id: tgChat, text: tgText, parse_mode: 'Markdown' }),
      }).catch(e => console.error('tg ping error:', e.message));
    }

    res.status(201).json({ ok: true, id: enquiryId });
  } catch (e) {
    console.error('[public-enquiry]', e.message);
    res.status(500).json({ error: 'Failed to submit enquiry' });
  }
});

// ── Public website registration form endpoint — NO AUTH, rate-limited ─────────
// Separate append-only route file; mounted BEFORE auth-gated routes.
// Target of the LADN public website form via same-origin /api/enquiry proxy.
app.use(require('../../src/routes/public-enquiry'));

// Customisable enquiry form config (Admin → Settings → Enquiry Form). Mounted
// pre-auth: /api/enquiry-form/public is open (website reads it to render the form);
// the manage endpoints self-gate to manager inside the route. (2026-07-07)
app.use(require('../../src/routes/enquiry-form'));

// ── Public availability heat-map + demand + "keep me on the list" — NO AUTH ───
// Parent-facing sanitised view over the admissions engine (no raw counts).
// Mounted BEFORE the auth/offsite gates so /api/public/* is reachable without a
// JWT; the LADN hosts sit behind Cloudflare Access, so it stays private until
// proxied from the public nursery site. Endpoints: GET /api/public/availability,
// POST /api/public/slot-interest, POST /api/public/keep-on-list.
app.use(require('../../src/routes/public-availability'));

// ── Leavers keepsake — PUBLIC, token-gated (PROMPT 46) — NO AUTH ──────────────
// Serves the installable memory-book PWA + no-login download at /keepsake/:token/*.
// An unguessable per-child token (minted by staff in Roost) is the access control;
// mounted BEFORE the auth/offsite gates so a parent can open/install it without a
// JWT or Cloudflare-Access session. Portal-agnostic (matches on path, any host).
app.use(require('../../src/routes/keepsake-public'));

// ── Device-enrolment: /ey/enrol-device page + API routes ───────────────────────
// Enrol DEVICE_ENFORCE=off by default. Manager+ only. Owner always exempt everywhere.
// These routes must be BEFORE core middleware so they don't get caught by auth gates.
// Device-approval routes accept from learning or admin portals (manager+ role).
// Audience must match the portal that the token originated from.
const _DEV_ROUTES_ALLOW = ['learning','admin'];
const _DEV_ROUTES_VERIFY = {audience:['learning','admin']};

app.get('/ey/enrol-device', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Enrol Device</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .card{background:#fff;border-radius:12px;padding:2rem;max-width:420px;width:92%;box-shadow:0 2px 16px rgba(0,0,0,.08)}
  h1{font-size:1.4rem;margin-bottom:1.2rem}
  label{display:block;font-weight:600;margin:1rem 0 .3rem}
  input,select{width:100%;padding:.6rem;border:1px solid #ccc;border-radius:6px;font-size:1rem}
  button{margin-top:1.2rem;width:100%;padding:.7rem;background:#4a90d9;color:#fff;border:none;border-radius:6px;font-size:1rem;cursor:pointer}
  button:hover{background:#357ab8}
  .msg{margin-top:1rem;padding:.8rem;border-radius:6px;display:none}
  .msg.ok{display:block;background:#d4edda;color:#155724}
  .msg.err{display:block;background:#f8d7da;color:#721c24}
  .hint{font-size:.85rem;color:#666}
</style></head><body>
<div class="card">
  <h1>Enrol This Device</h1>
  <p class="hint">Open this page ON the device you want to enrol (tablet or admin PC).</p>
  <form id="f">
    <label for="label">Label</label>
    <input id="label" placeholder="e.g. Staff Tablet 1" required>
    <label for="type">Device Type</label>
    <select id="type">
      <option value="ey_tablet">EY Tablet</option>
      <option value="admin_pc">Admin PC</option>
    </select>
    <button type="submit" id="btn">Enrol</button>
  </form>
  <div id="msg" class="msg"></div>
  <div id="token-box" class="msg ok" style="word-break:break-all;display:none"></div>
</div>
<script>
  const KEY='wrenToken';
  const TOKEN_KEY='wrenToken';
  // Session-only by design (shared tablets must not persist logins). The token is
  // present here only when this page is opened IN-APP, same tab (sessionStorage
  // survives same-tab navigation). Cold-loading the URL directly will have no token
  // -> the submit handler shows a clear "open from the app" message.
  function getToken(){try{return sessionStorage.getItem(TOKEN_KEY)||null}catch(_){return null}}
  document.getElementById('f').onsubmit=async function(e){
    e.preventDefault();
    var tok=getToken();
    if(!tok){_showErr("Open this from the EY app: Settings → IT Settings → Enrol this device. (Logging in here directly won't carry your session.)");return}
    var btn=document.getElementById('btn');btn.textContent='Enrolling...';btn.disabled=true;
    var label=document.getElementById('label').value.trim();
    var type=document.getElementById('type').value;
    var r=await fetch('/api/devices/enrol',{method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},
      body:JSON.stringify({label:label,device_type:type})});
    if(!r.ok){var e=await r.json().catch(function(){return{}});_showErr(e.error||('HTTP '+r.status));btn.textContent='Enrol';btn.disabled=false;return}
    var data=await r.json();
    localStorage.setItem('wrenDevice',data.token);
    document.getElementById('token-box').style.display='block';
    document.getElementById('token-box').textContent='Device enrolled! Token saved to localStorage. You may close this page.';
    document.getElementById('f').style.display='none';
  };
  function _showErr(m){var el=document.getElementById('msg');el.className='msg err';el.textContent=m}
</script></body></html>`);
});

// ── Parents / HR "Trust this device" page (mirrors /ey/enrol-device) ───────────
// Explicit opt-in action. Once trusted, the profile auto-locks to this device (§2).
// Parents read their token from localStorage('wren_parent_token'); HR from
// sessionStorage('wrenToken'). On success the device token is saved to
// localStorage('wrenDevice') and sent as X-Wren-Device on subsequent requests.
function _enrolSelfPage(req, res, next, portal) {
  if (req._portal !== portal) return next();
  const isParents = portal === 'parents';
  const tokenJs = isParents
    ? "try{return localStorage.getItem('wren_parent_token')||sessionStorage.getItem('wrenToken')||null}catch(_){return null}"
    : "try{return sessionStorage.getItem('wrenToken')||sessionStorage.getItem('wren_token')||null}catch(_){return null}";
  const who = isParents ? 'parent account' : 'HR account';
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trust This Device</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
  .card{background:#1e293b;border:1px solid #2d3748;border-radius:12px;padding:1.8rem;max-width:440px;width:100%}
  h1{font-size:1.3rem;margin-bottom:.6rem}
  p.hint{font-size:.88rem;color:#94a3b8;line-height:1.5;margin-bottom:1rem}
  label{display:block;font-weight:600;margin:1rem 0 .3rem;font-size:.9rem}
  input{width:100%;padding:.6rem;border:1px solid #2d3748;border-radius:8px;font-size:1rem;background:#0f172a;color:#f1f5f9}
  button{margin-top:1.2rem;width:100%;padding:.75rem;background:#4a9abf;color:#fff;border:none;border-radius:10px;font-size:1rem;cursor:pointer}
  button:hover{background:#3b82a6}
  .msg{margin-top:1rem;padding:.8rem;border-radius:8px;display:none;font-size:.88rem}
  .msg.ok{display:block;background:#22c55e22;color:#4ade80}
  .msg.err{display:block;background:#ef444422;color:#f87171}
</style></head><body>
<div class="card">
  <h1>🔒 Trust This Device</h1>
  <p class="hint">Enrol the device you're using now as a trusted device for your ${who}. Once trusted, your account locks to your trusted device(s) for extra security. An administrator can reset this if you get a new phone or computer.</p>
  <form id="f">
    <label for="label">Device name</label>
    <input id="label" placeholder="e.g. ${isParents ? "Mum's iPhone" : 'My laptop'}" required>
    <button type="submit" id="btn">Trust this device</button>
  </form>
  <div id="msg" class="msg"></div>
</div>
<script>
  function getToken(){${tokenJs}}
  document.getElementById('f').onsubmit=async function(e){
    e.preventDefault();
    var tok=getToken();
    if(!tok){_show("Open this from inside your portal while signed in — logging in here directly won't carry your session.",false);return}
    var btn=document.getElementById('btn');btn.textContent='Enrolling…';btn.disabled=true;
    var label=document.getElementById('label').value.trim()||'My device';
    try{
      var r=await fetch('/api/devices/enrol-self',{method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+tok},
        body:JSON.stringify({label:label})});
      if(!r.ok){var e2=await r.json().catch(function(){return{}});_show('Failed: '+(e2.error||('HTTP '+r.status)),false);btn.textContent='Trust this device';btn.disabled=false;return}
      var d=await r.json();
      try{localStorage.setItem('wrenDevice',d.token)}catch(_){}
      document.getElementById('f').style.display='none';
      _show('✓ This device is now trusted. Your account is locked to it. You can close this page.',true);
    }catch(err){_show('Network error: '+err,false);btn.textContent='Trust this device';btn.disabled=false;}
  };
  function _show(m,ok){var el=document.getElementById('msg');el.className='msg '+(ok?'ok':'err');el.textContent=m}
</script></body></html>`);
}
app.get('/parents/enrol-device', (req, res, next) => _enrolSelfPage(req, res, next, 'parents'));
app.get('/hr/enrol-device',      (req, res, next) => _enrolSelfPage(req, res, next, 'hr'));

app.post('/api/devices/enrol', express.json(), (req, res, next) => {
  if (_DEV_ROUTES_ALLOW.indexOf(req._portal) === -1) return next();
  const tok = (req.headers['authorization'] || '').replace('Bearer ','');
  if (!tok) return res.status(401).json({error:'Unauthorised'});
  let user;
  try {
    const jwt2 = require('jsonwebtoken');
    user = jwt2.verify(tok, process.env.JWT_SECRET, _DEV_ROUTES_VERIFY);
  } catch { return res.status(401).json({error:'Invalid token'}); }
  if (!['manager','deputy_manager','owner'].includes(user.role))
    return res.status(403).json({error:'Manager+ only'});
  const body = req.body || {};
  const label = (body.label || '').slice(0,200);
  const deviceType = ['ey_tablet','admin_pc','parents','hr'].includes(body.device_type) ? body.device_type : 'ey_tablet';
  // Optional: pre-bind a parents/hr device to a subject (parent email / staff id).
  const bSubType = ['staff','parent'].includes(body.bound_subject_type) ? body.bound_subject_type : null;
  const bSubId   = bSubType && body.bound_subject_id ? String(body.bound_subject_id).slice(0,200).toLowerCase() : null;
  const deviceUuid = crypto.randomUUID();
  const pool = require('../../src/db/pool').getPool();
  pool.query(
    `INSERT INTO ladn.enrolled_devices(device_uuid,label,device_type,enrolled_by,bound_subject_type,bound_subject_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [deviceUuid,label,deviceType,user.id,bSubType,bSubId], async (err,result) => {
      if (err) { console.error('[device-enrol] insert failed:',err.message); return res.status(500).json({error:'Insert failed'}); }
      const token = _makeDeviceToken({device_uuid:deviceUuid,device_type:deviceType,iat:Math.floor(Date.now()/1000)});
      console.log(`[device-enrol] enrolled ${deviceType} ${label} (id=${result.rows[0].id})${bSubType?` bound→${bSubType}:${bSubId}`:''}`);
      try { res.json({id:result.rows[0].id,token}); }
      catch { /* ignore write err */ }
    });
});

app.get('/api/devices', (req, res, next) => {
  if (_DEV_ROUTES_ALLOW.indexOf(req._portal) === -1) return next();
  const tok = (req.headers['authorization'] || '').replace('Bearer ','');
  if (!tok) return res.status(401).json({error:'Unauthorised'});
  let user;
  try {
    const jwt2 = require('jsonwebtoken');
    user = jwt2.verify(tok, process.env.JWT_SECRET, _DEV_ROUTES_VERIFY);
  } catch { return res.status(401).json({error:'Invalid token'}); }
  if (!['manager','deputy_manager','owner'].includes(user.role))
    return res.status(403).json({error:'Manager+ only'});
  const pool = require('../../src/db/pool').getPool();
  pool.query(`SELECT id,device_uuid,label,device_type,enrolled_by,created_at,last_seen_at,revoked,
                     bound_subject_type,bound_subject_id
                FROM ladn.enrolled_devices ORDER BY created_at DESC`,
    async (err,rows) => {
      if (err) return res.status(500).json({error:err.message});
      const devices = rows.rows || [];
      // Resolve staff-bound subjects to names; parent subjects are emails (already readable).
      const staffIds = [...new Set(devices
        .filter(d => d.bound_subject_type === 'staff' && d.bound_subject_id)
        .map(d => parseInt(d.bound_subject_id,10)).filter(n => !isNaN(n)))];
      let nameById = {};
      if (staffIds.length) {
        try {
          const { rows: srows } = await pool.query(
            `SELECT id, first_name, last_name FROM ladn.staff WHERE id = ANY($1)`, [staffIds]);
          for (const s of srows) nameById[s.id] = `${s.first_name||''} ${s.last_name||''}`.trim();
        } catch { /* best-effort */ }
      }
      for (const d of devices) {
        if (d.bound_subject_type === 'staff') {
          d.bound_subject_name = nameById[parseInt(d.bound_subject_id,10)] || ('Staff #'+d.bound_subject_id);
        } else if (d.bound_subject_type === 'parent') {
          d.bound_subject_name = d.bound_subject_id;
        } else {
          d.bound_subject_name = null;
        }
      }
      res.json(devices);
    });
});

app.post('/api/devices/:id/revoke', (req, res, next) => {
  if (_DEV_ROUTES_ALLOW.indexOf(req._portal) === -1) return next();
  const tok = (req.headers['authorization'] || '').replace('Bearer ','');
  if (!tok) return res.status(401).json({error:'Unauthorised'});
  let user;
  try {
    const jwt2 = require('jsonwebtoken');
    user = jwt2.verify(tok, process.env.JWT_SECRET, _DEV_ROUTES_VERIFY);
  } catch { return res.status(401).json({error:'Invalid token'}); }
  if (!['manager','deputy_manager','owner'].includes(user.role))
    return res.status(403).json({error:'Manager+ only'});
  const pool = require('../../src/db/pool').getPool();
  pool.query('UPDATE ladn.enrolled_devices SET revoked=true WHERE id=$1', [req.params.id],
    (err) => { if (err) return res.status(500).json({error:err.message}); console.log(`[device-revoke] revoked device ${req.params.id}`); res.json({ok:true}); });
});

// Shared manager+ auth for the device-control endpoints below. Returns the verified
// user, or null after having already sent the appropriate 401/403 response.
function _devManagerAuth(req, res) {
  if (_DEV_ROUTES_ALLOW.indexOf(req._portal) === -1) { res.status(404).json({error:'Not found'}); return null; }
  const tok = (req.headers['authorization'] || '').replace('Bearer ','');
  if (!tok) { res.status(401).json({error:'Unauthorised'}); return null; }
  let user;
  try { user = require('jsonwebtoken').verify(tok, process.env.JWT_SECRET, _DEV_ROUTES_VERIFY); }
  catch { res.status(401).json({error:'Invalid token'}); return null; }
  if (!['manager','deputy_manager','owner'].includes(user.role)) { res.status(403).json({error:'Manager+ only'}); return null; }
  return user;
}

// ── Per-portal lock status (manager+). Reports env master + per-portal toggle + effective. ──
app.get('/api/devices/status', (req, res, next) => {
  if (_DEV_ROUTES_ALLOW.indexOf(req._portal) === -1) return next();
  const user = _devManagerAuth(req, res); if (!user) return;
  const pool = require('../../src/db/pool').getPool();
  pool.query(`SELECT key,value FROM ladn.settings WHERE key LIKE 'device_enforce%'`, (err, r) => {
    if (err) return res.status(500).json({error:err.message});
    const t = {}; (r.rows||[]).forEach(x => t[x.key] = x.value);
    const master = DEVICE_LIVE_ENFORCE; // env master kill-switch
    const portalRow = (portal) => {
      const toggle = (t[DEVICE_ENFORCE_KEY[portal]] || 'off');
      return { toggle, effective: !!(master && toggle === 'on') };
    };
    res.json({
      master,                                  // env DEVICE_ENFORCE === 'true'
      master_note: master
        ? 'Master ON — per-portal toggles are LIVE.'
        : 'Master switch DEVICE_ENFORCE is OFF — per-portal toggles take effect only once the master is enabled.',
      portals: { ey: portalRow('learning'), admin: portalRow('admin'),
                 parents: portalRow('parents'), hr: portalRow('hr') },
    });
  });
});

// ── Toggle a per-portal enforce flag (manager+). Writes ladn.settings live. ──
app.post('/api/devices/enforce', express.json(), (req, res, next) => {
  if (_DEV_ROUTES_ALLOW.indexOf(req._portal) === -1) return next();
  const user = _devManagerAuth(req, res); if (!user) return;
  const body = req.body || {};
  const KEYMAP = { ey:'device_enforce_ey', admin:'device_enforce_admin',
                   parents:'device_enforce_parents', hr:'device_enforce_hr' };
  const key = KEYMAP[body.portal];
  const state = body.state;
  if (!key || !['on','off'].includes(state)) return res.status(400).json({error:'bad portal/state'});
  const pool = require('../../src/db/pool').getPool();
  pool.query(
    `INSERT INTO ladn.settings(key,value,updated_by,updated_at) VALUES($1,$2,$3,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`,
    [key, state, user.id], (err) => {
      if (err) return res.status(500).json({error:err.message});
      _bustEnforceCache();
      console.log(`[device-enforce] ${key} := ${state} by staff ${user.id} (effective only if env master ON)`);
      res.json({ ok:true, key, state, master: DEVICE_LIVE_ENFORCE, effective: !!(DEVICE_LIVE_ENFORCE && state==='on') });
    });
});

// ── Unbind a device from its profile (manager+) — reset for a parent's new phone etc. ──
app.post('/api/devices/:id/unbind', (req, res, next) => {
  if (_DEV_ROUTES_ALLOW.indexOf(req._portal) === -1) return next();
  const user = _devManagerAuth(req, res); if (!user) return;
  const pool = require('../../src/db/pool').getPool();
  pool.query('UPDATE ladn.enrolled_devices SET bound_subject_type=NULL, bound_subject_id=NULL WHERE id=$1', [req.params.id],
    (err) => { if (err) return res.status(500).json({error:err.message}); console.log(`[device-unbind] cleared binding on device ${req.params.id} by staff ${user.id}`); res.json({ok:true}); });
});

// ── Self-enrol "Trust this device" (parents / HR portals). Binds device to the
//    authenticated subject so the profile auto-locks per §2. Behind the portal's
//    own auth (the subject's own token), NOT manager-gated. ──
app.post('/api/devices/enrol-self', express.json(), (req, res, next) => {
  if (req._portal !== 'parents' && req._portal !== 'hr') return next();
  const subject = _subjectOf(req);
  if (!subject) return res.status(401).json({error:'Sign in on this portal first'});
  const deviceType = req._portal === 'parents' ? 'parents' : 'hr';
  const label = (((req.body||{}).label) || 'My device').toString().slice(0,200);
  const deviceUuid = crypto.randomUUID();
  const enrolledBy = (subject.jwt && Number(subject.jwt.id)) || null;
  const pool = require('../../src/db/pool').getPool();
  pool.query(
    `INSERT INTO ladn.enrolled_devices(device_uuid,label,device_type,enrolled_by,bound_subject_type,bound_subject_id)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [deviceUuid,label,deviceType,enrolledBy,subject.type,subject.id], (err,result) => {
      if (err) { console.error('[device-enrol-self] insert failed:',err.message); return res.status(500).json({error:'Insert failed'}); }
      const token = _makeDeviceToken({device_uuid:deviceUuid,device_type:deviceType,iat:Math.floor(Date.now()/1000)});
      console.log(`[device-enrol-self] ${deviceType} enrolled & bound → ${subject.type}:${subject.id} (id=${result.rows[0].id})`);
      res.json({ id:result.rows[0].id, token, bound_to:`${subject.type}:${subject.id}` });
    });
});

// ── Device-enrolment: admin manage page (GET /admin/devices) ───────────────────
app.get('/admin/devices', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.send(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Device Management — {{edition_name}}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#f1f5f9;padding:20px;max-width:1100px;margin:0 auto}
  .page-title{font-size:1.3rem;margin-bottom:8px}
  .page-sub{font-size:.85rem;color:#94a3b8;margin-bottom:16px}
  .enforce-badge{display:inline-block;font-size:.78rem;font-weight:700;padding:4px 12px;border-radius:6px;margin-left:12px}
  .enforce-on{background:#dc262633;color:#ef4444}
  .enforce-off{background:#22c55e33;color:#22c55e}
  .card{background:#1e293b;border:1px solid #2d3748;border-radius:12px;padding:16px;margin-bottom:18px}
  .card h2{font-size:1rem;margin-bottom:4px}
  .card .sub{font-size:.8rem;color:#94a3b8;margin-bottom:12px}
  .banner{padding:11px 14px;border-radius:10px;font-size:.84rem;margin-bottom:16px;line-height:1.45}
  .banner-info{background:#3b82f622;border:1px solid #3b82f655;color:#93c5fd}
  .banner-warn{background:#dc262622;border:1px solid #dc262666;color:#fca5a5}
  .table-wrap{overflow-x:auto;background:#1e293b;border:1px solid #2d3748;border-radius:12px}
  table{width:100%;border-collapse:collapse;font-size:.82rem}
  th{text-align:left;padding:10px 14px;color:#64748b;font-size:.7rem;text-transform:uppercase;border-bottom:1px solid #2d3748}
  td{padding:10px 14px;border-bottom:1px solid #1a2336;white-space:nowrap}
  tr:hover td{background:#1a2336}
  .badge{display:inline-block;font-size:.68rem;font-weight:700;padding:2px 8px;border-radius:4px}
  .badge-tablet{background:#3b82f633;color:#60a5fa}
  .badge-pc{background:#a855f733;color:#c084fc}
  .badge-parents{background:#e0782033;color:#fbbf24}
  .badge-hr{background:#14b8a633;color:#2dd4bf}
  .badge-revoked{background:#ef444433;color:#f87171}
  .badge-active{background:#22c55e33;color:#4ade80}
  .btn-sm{padding:4px 12px;border-radius:6px;border:1px solid #2d3748;background:#1e293b;color:#f1f5f9;font-size:.78rem;cursor:pointer}
  .btn-sm:hover{background:#334155}
  .btn-sm.danger{border-color:#dc2626;color:#ef4444}
  .btn-sm.danger:hover{background:#dc262622}
  label{font-size:.78rem;color:#94a3b8;display:block;margin-bottom:3px}
  input,select{padding:.5rem;border:1px solid #2d3748;border-radius:8px;font-size:.85rem;background:#0f172a;color:#f1f5f9}
  .row{display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end}
  #msg{margin-top:12px;padding:10px;border-radius:8px;display:none;font-size:.85rem}
  #msg.ok{display:block;background:#22c55e22;color:#4ade80}
  #msg.err{display:block;background:#ef444422;color:#f87171}
  .empty{text-align:center;padding:40px;color:#475569;font-size:.9rem}
</style></head><body>
  <p class="page-title">Device Management&nbsp;<span id="enforce-badge" class="enforce-badge enforce-off">Log-only</span></p>
  <p class="page-sub">Lock / unlock each portal and manage enrolled devices. Owner (Toby) is always exempt everywhere.</p>

  <div id="master-banner" class="banner banner-info">Loading enforcement status…</div>

  <!-- ── Portal lock status ─────────────────────────────────────── -->
  <div class="card">
    <h2>🔐 Portal lock status</h2>
    <p class="sub">Each portal's per-portal toggle. <b>Effective</b> = master switch ON <i>and</i> this toggle ON. EY tablets &amp; admin PCs are shared (type-match); Parents &amp; HR auto-lock per profile to the first trusted device.</p>
    <div id="portal-status" class="table-wrap"><div class="empty">Loading…</div></div>
  </div>

  <!-- ── Enrol a device ─────────────────────────────────────────── -->
  <div class="card">
    <h2>＋ Enrol a device</h2>
    <p class="sub">Enrol the device you're on, or pre-enrol another (optionally bound to a parent email / staff id for Parents/HR).</p>
    <div style="margin-bottom:12px"><button class="btn-sm" id="enrol-this" style="padding:8px 16px;border-color:#3b82f6;color:#60a5fa">＋ Enrol THIS computer as an Admin PC</button> <span style="font-size:.8rem;color:#94a3b8">— do this once on Ayla's Chromebook while logged in as a manager</span></div>
    <form id="enrol-form" class="row">
      <div><label>Label</label><input id="ef-label" placeholder="e.g. Staff Tablet 5" style="width:180px"></div>
      <div><label>Type</label>
        <select id="ef-type">
          <option value="ey_tablet">EY Tablet</option>
          <option value="admin_pc">Admin PC</option>
          <option value="parents">Parents</option>
          <option value="hr">HR</option>
        </select>
      </div>
      <div id="ef-bind-wrap" style="display:none">
        <label>Bind to (optional)</label>
        <select id="ef-bsub-type">
          <option value="">— unbound —</option>
          <option value="parent">Parent (email)</option>
          <option value="staff">Staff (id)</option>
        </select>
      </div>
      <div id="ef-bsubid-wrap" style="display:none"><label>Email / staff id</label><input id="ef-bsub-id" placeholder="email or staff id" style="width:200px"></div>
      <div><button type="submit" class="btn-sm" style="padding:8px 16px;border-color:#22c55e;color:#4ade80">Enrol</button></div>
    </form>
  </div>

  <!-- ── Enrolled devices ───────────────────────────────────────── -->
  <div class="card">
    <div class="row" style="justify-content:space-between;margin-bottom:12px">
      <h2 style="margin:0">📱 Enrolled devices</h2>
      <div><label>Filter type</label>
        <select id="type-filter">
          <option value="">All types</option>
          <option value="ey_tablet">EY Tablet</option>
          <option value="admin_pc">Admin PC</option>
          <option value="parents">Parents</option>
          <option value="hr">HR</option>
        </select>
      </div>
    </div>
    <div id="table-wrap" class="table-wrap"><div class="empty">Loading…</div></div>
  </div>
  <div id="msg"></div>
<script>
  var TOKEN_KEY='wrenToken';function getToken(){return sessionStorage.getItem(TOKEN_KEY)}
  function _msg(t,ok){var m=document.getElementById('msg');m.style.display='block';m.style.background=ok?'#22c55e22':'#ef444422';m.style.color=ok?'#4ade80':'#f87171';m.textContent=(ok?'✓ ':'✕ ')+t}
  function _esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  var ALL_DEVICES=[];

  // ── Portal lock status ──
  async function loadStatus(){
    var r=await fetch('/api/devices/status',{headers:{'Authorization':'Bearer '+getToken()}});
    if(r.status===401){location.href='/login.html?return='+encodeURIComponent(location.pathname);return}
    if(!r.ok)return;
    var s=await r.json();
    var mb=document.getElementById('master-banner');
    if(s.master){mb.className='banner banner-warn';mb.textContent='⚠️ Master switch DEVICE_ENFORCE is ON — per-portal toggles below are LIVE and will block devices that fail the gate.';}
    else{mb.className='banner banner-info';mb.textContent='🛡️ Master switch DEVICE_ENFORCE is OFF (log-only). Per-portal toggles take effect only once the master is enabled — nothing is locked yet.';}
    var anyEff=['ey','admin','parents','hr'].some(function(p){return s.portals[p]&&s.portals[p].effective});
    var hb=document.getElementById('enforce-badge');
    if(anyEff){hb.textContent='Enforcing';hb.className='enforce-badge enforce-on';}else{hb.textContent='Log-only';hb.className='enforce-badge enforce-off';}
    var order=[['ey','EY (tablets)'],['admin','Roost / Admin'],['parents','Parents'],['hr','HR']];
    var rows=order.map(function(p){
      var key=p[0],name=p[1],row=s.portals[key]||{toggle:'off',effective:false};
      var eff=row.effective;
      var lockTxt=eff?'🔒 Locked':'🔓 Unlocked';
      var held=eff?'enforcing now':(row.toggle==='on'?'armed — waiting on master switch':'toggle off');
      var btnLabel=(row.toggle==='on'?'Turn toggle OFF':'Turn toggle ON');
      return '<tr><td><b>'+name+'</b></td><td><span class="badge '+(eff?'badge-revoked':'badge-active')+'">'+lockTxt+'</span></td>'+
        '<td style="color:#94a3b8">'+held+'</td><td>toggle: <b style="color:'+(row.toggle==='on'?'#fbbf24':'#64748b')+'">'+row.toggle.toUpperCase()+'</b></td>'+
        '<td><button class="btn-sm tgl" data-portal="'+key+'" data-state="'+(row.toggle==='on'?'off':'on')+'">'+btnLabel+'</button></td></tr>';
    }).join('');
    document.getElementById('portal-status').innerHTML='<table><thead><tr><th>Portal</th><th>Effective</th><th>Held by</th><th>Per-portal toggle</th><th>Action</th></tr></thead>'+rows+'</table>';
  }
  document.getElementById('portal-status').addEventListener('click',function(e){
    var b=e.target.closest('.tgl');if(!b)return;
    toggleEnforce(b.getAttribute('data-portal'),b.getAttribute('data-state'));
  });
  async function toggleEnforce(portal,state){
    var r=await fetch('/api/devices/enforce',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+getToken()},body:JSON.stringify({portal:portal,state:state})});
    if(!r.ok){var e=await r.json().catch(function(){return{}});_msg('Toggle failed: '+(e.error||r.status),false);return}
    _msg('Set '+portal+' per-portal toggle = '+state+'. (Effective only when the env master switch is ON.)',true);loadStatus();
  }

  // ── Enrolled devices ──
  function typeBadge(t){
    var cls=t==='ey_tablet'?'badge-tablet':t==='admin_pc'?'badge-pc':t==='parents'?'badge-parents':'badge-hr';
    return '<span class="badge '+cls+'">'+t+'</span>';
  }
  function renderDevices(){
    var filter=document.getElementById('type-filter').value;
    var devices=ALL_DEVICES.filter(function(d){return !filter||d.device_type===filter});
    var w=document.getElementById('table-wrap');
    if(!devices.length){w.innerHTML='<div class="empty">No devices'+(filter?' of this type':'')+'. Enrol via the form above, or open <a href="/ey/enrol-device" style="color:#60a5fa">/ey/enrol-device</a> (tablets), <a href="/parents/enrol-device" style="color:#60a5fa">/parents/enrol-device</a> or <a href="/hr/enrol-device" style="color:#60a5fa">/hr/enrol-device</a> on the target device.</div>';return}
    var rows=devices.map(function(d){
      var bound=d.bound_subject_name?('<span style="color:#fbbf24">'+_esc(d.bound_subject_name)+'</span>'):'<span style="color:#475569">— shared —</span>';
      var actions='';
      if(!d.revoked){
        if(d.bound_subject_type)actions+='<button class="btn-sm" onclick="unbind('+d.id+')">Unbind</button> ';
        actions+='<button class="btn-sm danger" onclick="revoke('+d.id+')">Revoke</button>';
      }
      return '<tr><td><code>'+_esc(d.device_uuid.slice(0,12))+'&hellip;</code></td><td>'+_esc(d.label)+'</td><td>'+typeBadge(d.device_type)+'</td><td>'+bound+'</td><td>'+(d.revoked?'<span class="badge badge-revoked">Revoked</span>':'<span class="badge badge-active">Active</span>')+'</td><td style="color:#64748b">'+(d.last_seen_at?new Date(d.last_seen_at).toLocaleString():'&mdash;')+'</td><td>'+actions+'</td></tr>';
    }).join('');
    w.innerHTML='<table><thead><tr><th>UUID</th><th>Label</th><th>Type</th><th>Bound to</th><th>Status</th><th>Last seen</th><th>Action</th></tr></thead>'+rows+'</table>';
  }
  document.getElementById('type-filter').addEventListener('change',renderDevices);
  async function loadDevices(){
    var r=await fetch('/api/devices',{headers:{'Authorization':'Bearer '+getToken()}});
    if(r.status===401){location.href='/login.html?return='+encodeURIComponent(location.pathname);return}
    if(!r.ok){var d=await r.json();_msg('Error: '+(d.error||r.status),false);return}
    var devices=await r.json();if(!Array.isArray(devices))devices=devices.devices||[];
    ALL_DEVICES=devices;renderDevices();
  }
  async function revoke(id){
    if(!confirm('Revoke this device? It will stop being recognised after the current token expires (up to 90 days).'))return;
    await fetch('/api/devices/'+id+'/revoke',{method:'POST',headers:{'Authorization':'Bearer '+getToken()}}).then(function(r){if(!r.ok)throw'fail'});
    _msg('Device revoked.',true);loadDevices();
  }
  async function unbind(id){
    if(!confirm('Unbind this device from its profile? The parent/HR account will be unlocked and re-claim the next trusted device it uses.'))return;
    await fetch('/api/devices/'+id+'/unbind',{method:'POST',headers:{'Authorization':'Bearer '+getToken()}}).then(function(r){if(!r.ok)throw'fail'});
    _msg('Device binding cleared.',true);loadDevices();
  }

  // ── Enrol form ──
  document.getElementById('enrol-this').onclick=async function(){
    var label=prompt('Label for this device (e.g. "Ayla Chromebook"):','Admin PC');
    if(!label)return;
    var r=await fetch('/api/devices/enrol',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+getToken()},body:JSON.stringify({label:label,device_type:'admin_pc'})});
    if(!r.ok){var e=await r.json().catch(function(){return{}});_msg('Enrol failed: '+(e.error||r.status),false);return}
    var d=await r.json();try{localStorage.setItem('wrenDevice',d.token)}catch(_){}
    _msg('This computer is now enrolled as an Admin PC. Reload the admin app to apply.',true);loadDevices();
  };
  function _syncBindVis(){
    var t=document.getElementById('ef-type').value;
    var show=(t==='parents'||t==='hr');
    document.getElementById('ef-bind-wrap').style.display=show?'':'none';
    document.getElementById('ef-bsubid-wrap').style.display=(show&&document.getElementById('ef-bsub-type').value)?'':'none';
  }
  document.getElementById('ef-type').addEventListener('change',_syncBindVis);
  document.getElementById('ef-bsub-type').addEventListener('change',_syncBindVis);
  document.getElementById('enrol-form').onsubmit=async function(e){
    e.preventDefault();
    var label=document.getElementById('ef-label').value.trim();
    if(!label){_msg('Enter a label.',false);return}
    var body={label:label,device_type:document.getElementById('ef-type').value};
    var bt=document.getElementById('ef-bsub-type').value;
    if((body.device_type==='parents'||body.device_type==='hr')&&bt){body.bound_subject_type=bt;body.bound_subject_id=document.getElementById('ef-bsub-id').value.trim();}
    var r=await fetch('/api/devices/enrol',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+getToken()},body:JSON.stringify(body)});
    if(!r.ok){var e2=await r.json().catch(function(){return{}});_msg('Enrol failed: '+(e2.error||r.status),false);return}
    _msg('Device enrolled. (Token issued; for shared/remote devices, open the enrol page on that device to store it.)',true);
    document.getElementById('ef-label').value='';loadDevices();
  };

  loadStatus().catch(function(){});
  loadDevices().catch(function(e){_msg('Failed to load devices: '+e,false)});
</script></body></html>`);
});

// ── Core middleware ───────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: '20mb' }));

// ── Parents-portal authorisation guard (2026-06-12 permissions-matrix fix) ────
// A valid parents-audience JWT (role=parent) passed the audience check but most
// staff/management routers only call authenticate() — no role gate — so a parent
// token could read /api/staff, /api/children, /api/observations, /api/incidents,
// /api/attendance, etc. This blocks the parent role from staff/management API
// prefixes on the parents portal. Parent-facing data still flows via /api/parents/*
// and the parent-safe routes below (NOT in the deny list). Fail-open on token
// errors (downstream authenticate() returns 401); only acts on a verified parent token.
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
  'handbook','policies','aria','intercom','insights','review','clockin','contracts',
  'induction','bookings','events','consents','parent-absence',
  // framework statement catalogue + tracker are staff reference material (2026-07-08):
  // linked statements must never be parent-visible, so deny even the generic catalogue
  'framework-statements','framework-tracker',
  // 2026-07-12 QA fix: a parent-role token could read the WHOLE child roster (names,
  // DOB, room, funding type, pupil-premium) via /api/funding/terms/:id/children — funding
  // was missing from this denylist. These prefixes are staff/finance-only, no legitimate
  // parents-portal use. (NOTE: child-facing prefixes like first-words / two-year-checks /
  // parent-reports leak OTHER children too but are parent-facing for a parent's OWN child —
  // those need per-route ownership checks, tracked as the allowlist follow-up, NOT a block.)
  'funding','funding-portal','xero','wages','payroll','safeguarding-research',
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
// ── HR-portal child-data guard (2026-06-16 audit fix) ──────────────────────
// A valid hr-audience JWT passed the audience check but child-data routers only
// call authenticate() (no portal/role gate), so an aud=hr token could read
// /api/children, /api/observations, /api/incidents, /api/sen, /api/outings, etc.
// HR must never expose child data (it runs on staff personal devices). Mirrors
// PARENT_DENY; blocks child-centric API prefixes on the HR portal for ALL hr
// tokens (managers use the Roost/admin portal for child data).
// ── Cook/chef role guard (2026-06-16) — kitchen staff (role='cook') are locked to
// kitchen + menu surfaces; child/HR/finance/staff routes return 403. Allow-list (deny by default).
const COOK_ALLOW = new Set(['auth','menus','menu','kitchen','notifications','notification-prefs',
  'features','edition','transcribe','voice-notes']);
app.use('/api', (req, res, next) => {
  const hdr = req.headers['authorization'] || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-wren-token'] || '');
  if (!tok) return next();
  let dec; try { dec = _jwt.verify(tok, process.env.JWT_SECRET); } catch { return next(); }
  if (dec && dec.role === 'cook') {
    const seg = (req.path.split('/').filter(Boolean)[0] || '').toLowerCase();
    // Allow cooks to read their OWN capabilities (for nav gating) but nothing else under /permissions.
    const allowPath = req.path === '/permissions/me';
    if (!allowPath && !COOK_ALLOW.has(seg)) return res.status(403).json({ error: 'Forbidden — kitchen access only' });
  }
  next();
});
const HR_DENY = new Set([
  'children','observations','diary','daily-diary','sleep','sleep-checks','medicine',
  'incidents','safeguarding','safeguarding-ext','sen','phonics','memory-box','first-words',
  'curriculum','planning','activity-bank','planned-activities','next-steps','parent-reports',
  'leavers-book','outings','key-children','child-profile','framework-tracker','framework-statements',
  'bookings','consents','parent-absence',
]);
app.use('/api', (req, res, next) => {
  if (req._portal !== 'hr') return next();
  const seg = (req.path.split('/').filter(Boolean)[0] || '').toLowerCase();
  if (HR_DENY.has(seg)) {
    return res.status(403).json({ error: 'Forbidden — child data is not available on the HR portal' });
  }
  next();
});

// ── On-site enforcement helpers (needed by both on-site and off-site gates) ──
// LADN-only file (not in the public mirror), so the nursery WAN IP fallback is safe here.
const NURSERY_IP = process.env.NURSERY_PUBLIC_IP || '138.248.166.79';
const _ONSITE_CHILD_DATA = new Set([
  'children','observations','diary','daily-diary','sleep','sleep-checks','medicine',
  'incidents','safeguarding','safeguarding-ext','sen','phonics','memory-box','first-words',
  'next-steps','key-children','child-profile','framework-tracker','framework-statements',
  'reports','parent-reports','attendance','leavers-book','outings','voice-notes',
]);
function _clientIp(req) {
  const cf = (req.headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf.replace('::ffff:', '');
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.ip || '').replace('::ffff:', '');
}
function _isOnSite(req) {
  const ip = _clientIp(req);
  if (!ip) return false;
  if (ip === NURSERY_IP) return true;
  if (/^127\./.test(ip) || ip === '::1') return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  const m = ip.match(/^100\.(\d+)\./);
  if (m && +m[1] >= 64 && +m[1] <= 127) return true;
  return false;
}

// ── Off-site permissions matrix (Priority 2). On-site = full per role.
// Off-site: owner(id=1)=everything, managers/deputies=everything EXCEPT
// child-GDPR/photos and finance, other staff=nothing sensitive.
const OFFSITE_CHILD = new Set([
  'children','observations','diary','daily-diary','sleep','sleep-checks','medicine',
  'incidents','safeguarding','safeguarding-ext','sen','phonics','memory-box','first-words',
  'next-steps','key-children','child-profile','framework-tracker','framework-statements',
  'reports','parent-reports','attendance','leavers-book','outings','voice-notes',
]);
const FINANCE_SET = new Set([
  'finance-dashboard','finance-forecast','finance-invoices','finance-payroll',
  'finance-reconcile','finance-wages','finance-xero',
  'invoices','payments','payments-admin','open-banking','xero','wages','payroll','reconcile',
  'funding','funding-portal','payments-parent',
]);

const _OFFSITE_DEFAULTS = {
  manager:     { deny: [...FINANCE_SET, ...OFFSITE_CHILD] },
  deputy_manager: { deny: [...FINANCE_SET, ...OFFSITE_CHILD] },
  staff:       { deny: [...FINANCE_SET, ...OFFSITE_CHILD,
    'rota','absence','cpd','supervisions','performance','toil',
  ]},
};

function _loadOffsiteMap() {
  if (process.env.OFFSITE_PERMS_JSON) {
    try { return JSON.parse(process.env.OFFSITE_PERMS_JSON); } catch { /* ignore */ }
  }
  return null;
}
const _OFFSITE_DENY = _loadOffsiteMap() || _OFFSITE_DEFAULTS;

function _offsiteGate(req, res, next) {
  const portal = req._portal;
  if (portal !== 'admin' && portal !== 'hr' && portal !== 'learning') return next();
  if (_isOnSite(req) || req.isTailscale) return next();
  const hdr = req.headers['authorization'] || '';
  const tok = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-wren-token'] || '');
  if (!tok) return next();
  let d;
  try { d = _jwt.verify(tok, process.env.JWT_SECRET); } catch { return next(); }
  if (d && Number(d.id) === 1) return next(); // owner (id=1) exempt, full off-site access
  const seg = (req.path.split('/').filter(Boolean)[0] || '').toLowerCase();
  // EY/learning portal: child data is on-site only for non-owner staff.
  if (portal === 'learning') {
    if (_ONSITE_CHILD_DATA.has(seg)) {
      return res.status(403).json({
        error: 'offsite_restricted',
        message: 'Child data is only available on the nursery network.',
      });
    }
    return next();
  }
  // admin/hr: role-based off-site deny matrix
  if (!d || !d.role) return next();
  const entry = _OFFSITE_DENY[d.role];
  if (!entry) return next();
  const denySet = new Set(entry.deny);
  for (const prefix of denySet) {
    if (seg === prefix || seg.startsWith(prefix + '/')) {
      return res.status(403).json({
        error: 'offsite_restricted',
        message: 'Access to this data requires the on-site network or owner credentials.',
      });
    }
  }
  next();
}
app.use('/api', (req, res, next) => _offsiteGate(req, res, next));

// ── Device-enrolment enforcement (on-site only; blocks off-site before this point) ──
// Want type differs by portal: learning=ey_tablet, admin=admin_pc, parents=parents, hr=hr.
// Effective enforcement is resolved per-portal inside _deviceGate (env master AND the
// per-portal settings toggle). With the env master unset, this is log-only everywhere.
app.use('/api', (req, res, next) => {
  const wantType = DEVICE_PORTAL_TYPE[req._portal] || 'ey_tablet';
  return _deviceGate(wantType)(req, res, next);
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

// ── Edition header + no-cache for shell JS ────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Wren-Edition', req._portal || 'learning');
  const p = req.path;
  if (p === '/js/wren-shell.js' || p === '/js/wren-module-renderer.js' ||
      p === '/js/wren-shell-v2.js' || p === '/js/wren-app-shell.js' ||
      p === '/js/wren-core.js' || p.startsWith('/sections/') ||
      p === '/js/wren-voice-capture.js' ||
      p === '/css/wren-shell-v2.css' || p === '/css/wren-app-shell.css' ||
      p === '/css/wren.css') {
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

// ── HR portal: block child-facing HTML routes ─────────────────────────────────
const CHILD_ROUTE_PATTERNS = [
  'learning','observations','diary','sleep','children','medicine',
  'phonics','key-children','child-profile','safeguarding','incidents',
  'memory-box','activity-bank','first-words','curriculum','planning',
];
app.use((req, res, next) => {
  if (req._portal !== 'hr' || req.path.startsWith('/api/')) return next();
  const lc = req.path.toLowerCase().replace(/^\//, '').replace(/\.html$/, '');
  if (!CHILD_ROUTE_PATTERNS.some(p => lc === p || lc.startsWith(p + '/'))) return next();
  const pool = require('../../src/db/pool').getPool();
  pool.query(
    `INSERT INTO ladn.hr_blocked_routes(path,method,reason,ip,user_agent,cf_email)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [req.path, req.method, 'child_facing_route_blocked',
     req.ip, (req.headers['user-agent'] || '').substring(0, 200),
     req.headers['cf-access-authenticated-user-email'] || null]
  ).catch(() => {});
  console.warn(`[HR-SECURITY] Blocked child-facing route: ${req.method} ${req.path} from ${req.ip}`);
  res.status(404).json({ error: 'Not found', note: 'This route is not available on the HR portal.' });
});

// ── HR section catch-all — serves /hr/:section from hr/public/:section.html ──
// Allows clean URLs like /hr/absences, /hr/my-profile, /hr/rota etc.
app.get('/hr/:section', (req, res, next) => {
  if (req._portal !== 'hr') return next();
  const p = path.join(__dirname, '../hr/public', req.params.section + '.html');
  if (fs.existsSync(p)) return res.sendFile(p);
  next();
});

// ── Public enquiry form — served on the EY (learning) portal hostname ────────
app.get('/enquire', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/enquire.html'));
});

// ── EY portal app shell pages — must be before express.static ────────────────
// (express.static would redirect /ey → /ey/ before named routes fire)
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
// ── EY observation pages (Prompt 05) ─────────────────────────────────────────
app.get('/ey/observation/new', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/observation-new.html'));
});
app.get('/ey/observation/:id', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/observation-view.html'));
});
// ── EY group action pages (Prompt 06) ────────────────────────────────────────
['observation','sleep','nappies','food','bottle','toilet','diary'].forEach(t => {
  app.get(`/ey/group/${t}`, (req, res, next) => {
    if (req._portal !== 'learning') return next();
    res.sendFile(path.join(__dirname, `public/ey/group/${t}.html`));
  });
});

// ── EY More-menu pages (Prompt 07) — route → public/ey/<page>.html ───────────
// These pages exist as files but their routes were never registered (lost/missed
// in Prompt 07). Without these, unmatched /ey/* falls through to login.html which
// then bounces an authed user to /ey/home — the "every link goes home" bug.
['more','drafts','trackers','activities','reports','settings','help','register','kitchen','obs-tracker','new-starters','my-shifts','messages','two-year-check','repairs','supervisions','action-plans','send-email','diary-all','sleep-chart','staff-clock','visitors'].forEach(p => {
  app.get(`/ey/${p}`, (req, res, next) => {
    if (req._portal !== 'learning') return next();
    res.sendFile(path.join(__dirname, `public/ey/${p}.html`));
  });
});

// ── EY Summative / Transition reports (eyparity-20260606) ────────────────────
app.get('/ey/reports/summative', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/reports-summative.html'));
});

// ── EY 2-year progress check — deep-link into trackers.html (trackers-20260607) ─
app.get('/ey/trackers/two-year-check', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/trackers.html'));
});

// ── EY safeguarding entry page (Prompt 16) ────────────────────────────────────
app.get('/ey/safeguarding/new', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/safeguarding-new.html'));
});

// ── EY accident / incident report (P2 child hub) ─────────────────────────────
app.get('/ey/incident/new', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/incident-new.html'));
});

// ── EY medicine log ──────────────────────────────────────────────────────────
app.get('/ey/medicine/new', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/medicine-new.html'));
});

// ── EY bottom-nav tabs: Diary and Inbox (Prompt 14) ─────────────────────────
// /ey/diary/entry must be registered BEFORE /ey/diary to avoid path shadowing
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

// ── EY bottom-nav tab: Learning Journey (eyredesign-20260605) ────────────────
app.get('/ey/journey', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/journey.html'));
});

// ── EY child-first action picker (child-first-20260522) ──────────────────────
app.get('/ey/log/select-action', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/ey/log/select-action.html'));
});

// ── Legacy EY pages: serve from _legacy/ at /ey-legacy/* (learning only) ─────
app.use('/ey-legacy', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  express.static(path.join(__dirname, 'public/_legacy'))(req, res, next);
});

// ── Parents portal & learning portal: root + legacy entry redirects ─────────
// This MUST come before _LEGACY_FILES redirects below, otherwise /index.html etc
// get caught by the per-file legacy 301 rather than redirecting to the new app.
app.get(['/', '/index.html', '/learning.html'], (req, res, next) => {
  if (req._portal === 'parents') return res.redirect('/welcome');
  if (req._portal === 'learning') return res.redirect(301, '/ey/home');
  next();
});

// ── Legacy EY pages: 301 from old root paths to /ey-legacy/ (grace period) ───
const _LEGACY_FILES = [
  'action-plans','activity-bank','chef','child-profile','clock','communications',
  'coshh','cpd','curriculum','diary','fire-safety','first-words','food-diary',
  'hr','incidents','intercom-answer','learning','medicine','memory-box','messages',
  'module-form','newsletter-ai','next-steps','notification-preferences','now-mode',
  'observations','outings','permission-slips','phonics','planning','profile',
  'repairs','reports','risk-assessments','safeguarding','sen','sign-slip',
  'sleep-checks','staff','supervision-form','supervision-record','supervision-review',
  'supervisions','totp-setup',
];
_LEGACY_FILES.forEach(name => {
  app.get(`/${name}.html`, (req, res, next) => {
    if (req._portal !== 'learning') return next();
    res.redirect(301, `/ey-legacy/${name}.html`);
  });
});

// ── Static files: per-portal edition public FIRST, shared public as fallback ──
// Shared must come AFTER edition-specific so edition files are never shadowed.
// ── Child profile photos — STAFF portals only (EY/admin); 404 on parents/HR/demos (GDPR, 2026-06-16) ──
const _childPhotoStatic = express.static('/app/uploads/child-photos', { fallthrough: false });
app.use('/uploads/child-photos', (req, res, next) => {
  if (req._portal === 'learning' || req._portal === 'admin') return _childPhotoStatic(req, res, (e) => res.status(404).end());
  return res.status(404).json({ error: 'Not found' });
});
// Staff profile photos — admin/EY portals only (2026-07-11).
const _staffPhotoStatic = express.static('/app/uploads/staff-photos', { fallthrough: false });
app.use('/uploads/staff-photos', (req, res, next) => {
  if (req._portal === 'learning' || req._portal === 'admin' || req._portal === 'hr') return _staffPhotoStatic(req, res, (e) => res.status(404).end());
  return res.status(404).json({ error: 'Not found' });
});
// ── First-run setup wizard gate (prompt 67) ─────────────────────────────────────
// On ladn (production) settings.setup_complete is seeded 'true', so /setup always
// 302s to login and the wizard never opens here. Kept for parity with school editions.
const _setupPage = path.join(__dirname, '../../public/setup/index.html');
app.get(['/setup', '/setup/'], async (req, res) => {
  try {
    const { rows } = await require('../../src/db/pool').getPool()
      .query("SELECT value FROM settings WHERE key='setup_complete'");
    if (rows[0] && String(rows[0].value).toLowerCase() === 'true') return res.redirect(302, '/login.html');
  } catch (e) { /* fall through to wizard */ }
  res.sendFile(_setupPage);
});
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
// Admin portal home → Cockpit (Prompt 34, 2026-06-30). Must run BEFORE the static dispatch
// below, which would otherwise serve the legacy standalone dashboard (index.html) at the bare
// domain root. The shell bounces a non-manager off this manager-only section to the Dashboard,
// so no admin role dead-ends. (index.html is still reachable directly at /index.html.)
app.get('/', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.redirect(302, '/admin/cockpit/comms');
});
app.use((req, res, next) => {
  const handlers = _staticHandlers[req._portal || 'learning'];
  let i = 0;
  const tryNext = () => { if (i >= handlers.length) return next(); handlers[i++](req, res, tryNext); };
  tryNext();
});

// ── Admin portal: SPA routes under /admin/* ───────────────────────────────────
// Home/landing is the Cockpit (Prompt 34, 2026-06-30). Server redirects to the cockpit's
// first tab (Comms); the shell client-side bounces a non-manager off this manager-only
// section back to the Dashboard, so no admin role dead-ends.
app.get('/admin', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.redirect(301, '/admin/cockpit/comms');
});
// New CSS Grid shell (wren-admin-shell.js) — test at /dashboard-new.html or /admin-new/*
app.get('/admin-new', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.redirect(301, '/admin-new/dashboard/today');
});
app.get('/admin-new/:section', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/dashboard-new.html'));
});
app.get('/admin-new/:section/:tab', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/dashboard-new.html'));
});
// ── Document Workspace SPA routes (before general catch-all) ─────────────────
app.get('/admin/documents/workspaces', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/documents/workspaces.html'));
});
app.get('/admin/documents/workspaces/new', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/documents/workspaces-new.html'));
});
app.get('/admin/documents/workspaces/:id', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/documents/workspace-detail.html'));
});

// ── Intercom answer page — full-page (before /admin/:section catch-all) ───────
app.get('/admin/intercom/answer/:id', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/intercom-answer.html'));
});

// Learning portal intercom answer page
app.get('/intercom/answer/:id', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  res.sendFile(path.join(__dirname, 'public/_legacy/intercom-answer.html'));
});

// ── Regulatory watcher pages (before /admin/:section catch-all) ───────────────
app.get('/admin/regulatory', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/regulatory.html'));
});
app.get('/admin/regulatory/alerts/:id', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/regulatory/alert-detail.html'));
});

// Sickness analytics — 4-segment URL served by SPA shell (shell treats as staff/sickness-patterns)
app.get('/admin/staff/analytics/sickness', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/app.html'));
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
app.get('/admin/study', (req, res, next) => {
  if (req._portal !== 'admin') return next();
  res.sendFile(path.join(__dirname, '../admin/public/study.html'));
});

// ── Learning portal: named routes ────────────────────────────────────────────
app.get('/',          (req, res, next) => { if (req._portal !== 'learning') return next(); res.sendFile(path.join(__dirname, 'public/portal.html')); });
app.get('/portal',   (req, res, next) => { if (req._portal !== 'learning') return next(); res.sendFile(path.join(__dirname, 'public/portal.html')); });
app.get('/chef',     (req, res, next) => { if (req._portal !== 'learning') return next(); res.sendFile(path.join(__dirname, 'public/_legacy/chef.html')); });
app.get('/food-diary',(req, res, next) => { if (req._portal !== 'learning') return next(); res.sendFile(path.join(__dirname, 'public/_legacy/food-diary.html')); });
app.get('/modules/:slug', (req, res, next) => { if (req._portal !== 'learning') return next(); res.sendFile(path.join(__dirname, 'public/_legacy/module-form.html')); });
app.get(/^\/app(\/.*)?$/, (req, res, next) => { if (req._portal !== 'learning') return next(); res.redirect('/ey/home'); });

// ── Parents portal: /welcome/* page routes ───────────────────────────────────
const WELCOME = path.join(__dirname, '../parents/welcome');
const RESOURCES_ROOT = process.env.RESOURCES_ROOT || '/app/parents-resources';

function _parentsOnly(req, res, next) { if (req._portal !== 'parents') return next(); }

app.get('/welcome',                       (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'home.html')); });
app.get('/welcome/learning-journey',      (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'learning-journey.html')); });
app.get('/welcome/diary',                 (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'diary.html')); });
app.get('/welcome/baby-log',              (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'baby-log.html')); });
app.get('/welcome/planning',              (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'planning.html')); });
app.get('/welcome/surveys',              (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'surveys.html')); });
app.get('/welcome/newsletter',           (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'newsletter.html')); });
app.get('/welcome/menu',                 (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'menu.html')); });
app.get('/welcome/memory-box',           (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'memory-box.html')); });
// homework + calendar pages render PRIMARY-DEMO data (a fictional school roster) — not valid
// for LADN nursery parents and orphaned (no nav links). Redirect to the hub. (2026-06-29)
app.get('/welcome/homework',             (req, res, next) => { if (req._portal !== 'parents') return next(); res.redirect('/welcome'); });
app.get('/welcome/calendar',             (req, res, next) => { if (req._portal !== 'parents') return next(); res.redirect('/welcome'); });
app.get('/welcome/phonics',              (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'phonics.html')); });
app.get('/welcome/study',                (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'study.html')); });
app.get('/welcome/study/rewards',        (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'study-rewards.html')); });
app.get('/welcome/study/:slug/completed',(req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'study-completed.html')); });
app.get('/welcome/study/:slug',          (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'study-module.html')); });
app.get('/welcome/records',              (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'records.html')); });
app.get('/welcome/action-plans',         (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'action-plans.html')); });
app.get('/welcome/payments',             (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'payments.html')); });
app.get('/welcome/payments/success',     (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'payments.html')); });
app.get('/welcome/dd-setup',             (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'dd-setup.html')); });
app.get('/welcome/resources',            (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'resources.html')); });
// ── Parents: invoices/fees (read-only), consents, events/RSVP, report-absence (2026-07-01) ──
app.get('/welcome/invoices',             (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'invoices.html')); });
app.get('/welcome/consents',             (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'consents.html')); });
app.get('/welcome/events',               (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'events.html')); });
app.get('/welcome/absence',              (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'absence.html')); });
// ── Parents: leavers keepsake + GDPR data request / erasure (PROMPT 46) ──────
app.get('/welcome/keepsake',             (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'keepsake.html')); });
app.get('/welcome/data-request',         (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(WELCOME, 'data-request.html')); });
// ── Parents: gov-docs statutory corpus page (link-audit-20260522) ────────────
app.get('/parents/policies-and-frameworks', (req, res, next) => { if (req._portal !== 'parents') return next(); res.sendFile(path.join(__dirname, '../parents/public/parents/policies-and-frameworks.html')); });

// ── Parents: survey pages (inject CF email) ───────────────────────────────────
app.get('/welcome/surveys/annual', (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = req.headers['cf-access-authenticated-user-email'] || '';
  fs.readFile(path.join(WELCOME, 'survey-annual.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Survey unavailable');
    res.type('html').send(html.replace('__CF_EMAIL__', email));
  });
});
app.get('/welcome/surveys/eylog', (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = req.headers['cf-access-authenticated-user-email'] || '';
  fs.readFile(path.join(WELCOME, 'survey-eylog.html'), 'utf8', (err, html) => {
    if (err) return res.status(500).send('Survey unavailable');
    res.type('html').send(html.replace('__CF_EMAIL__', email));
  });
});

// Dynamic template-driven survey renderer — must come after literal /annual and /eylog routes
app.get('/welcome/surveys/:slug', (req, res, next) => {
  if (req._portal !== 'parents') return next();
  res.sendFile(path.join(WELCOME, 'survey-render.html'));
});

// ── Parents: resources file browser ──────────────────────────────────────────
function safeResourcePath(req) {
  const raw = (req.query.path || '').toString();
  if (raw.includes('..') || raw.includes('\\')) return null;
  const clean = raw.replace(/^\/+/, '').replace(/\/+$/, '');
  const abs = path.join(RESOURCES_ROOT, clean);
  if (!abs.startsWith(RESOURCES_ROOT)) return null;
  return abs;
}

app.get('/welcome/resources/api/tree', (req, res, next) => {
  if (req._portal !== 'parents') return next();
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => ({ name: e.name, children: walk(path.join(dir, e.name)) }));
  }
  try { res.json(walk(RESOURCES_ROOT)); }
  catch { res.status(500).json({ error: 'Resources unavailable' }); }
});

app.get('/welcome/resources/api/list', (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const abs = safeResourcePath(req);
  if (!abs) return res.status(400).json({ error: 'Bad path' });
  fs.readdir(abs, { withFileTypes: true }, (err, entries) => {
    if (err) return res.status(404).json({ error: 'Not found' });
    const folders = [], files = [];
    entries.filter(e => !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
      if (e.isDirectory()) {
        let itemCount = 0;
        try { itemCount = fs.readdirSync(path.join(abs, e.name)).filter(n => !n.startsWith('.')).length; } catch {}
        folders.push({ name: e.name, itemCount });
      } else if (e.isFile()) {
        let size = 0;
        try { size = fs.statSync(path.join(abs, e.name)).size; } catch {}
        files.push({ name: e.name, size });
      }
    });
    res.json({ folders, files });
  });
});

app.get('/welcome/resources/file', (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const abs = safeResourcePath(req);
  if (!abs) return res.status(400).send('Bad path');
  fs.stat(abs, (err, stat) => {
    if (err || !stat.isFile()) return res.status(404).send('Not found');
    res.setHeader('Content-Disposition', 'inline; filename="' + path.basename(abs).replace(/"/g, '') + '"');
    res.sendFile(abs);
  });
});

// ── Parents: module upload scope guard (must be before shared uploadsHandler) ──
app.get('/api/module-uploads/:id', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).send('Not authenticated');
  const pool = require('../../src/db/pool').getPool();
  try {
    const up = await pool.query(`
      SELECT u.record_id, r.entity_type, r.entity_id, r.related_ids, m.portals
      FROM ladn.module_uploads u
      LEFT JOIN ladn.module_records r ON r.id = u.record_id
      LEFT JOIN ladn.modules m ON m.id = r.module_id
      WHERE u.id = $1
    `, [req.params.id]);
    if (!up.rows.length) return res.status(404).send('Not found');
    const { entity_type, entity_id, related_ids, portals } = up.rows[0];
    if (!portals || !Array.isArray(portals) || !portals.includes('parents')) return res.status(403).send('Forbidden');
    const childRes = await pool.query(
      'SELECT child_id FROM ladn.parent_portal_access WHERE lower(email) = $1 AND is_active = true',
      [email]
    );
    const childIds = childRes.rows.map(r => r.child_id);
    if (!childIds.length) return res.status(403).send('Forbidden');
    const isChild = entity_type === 'child' && childIds.includes(parseInt(entity_id));
    const isRelated = related_ids && Array.isArray(related_ids.child) &&
                      related_ids.child.some(id => childIds.includes(parseInt(id)));
    if (!isChild && !isRelated) return res.status(403).send('Forbidden');
    next();
  } catch (e) {
    console.error('upload-scope:', e.message);
    res.status(500).send('Internal error');
  }
});

// ── Parents: memory-box GET (parent-scoped, before shared route) ──────────────
app.get('/api/memory-box', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(
      'SELECT child_id FROM ladn.parent_portal_access WHERE lower(email)=$1 AND is_active=true',
      [email]
    );
    const childIds = childRes.rows.map(r => r.child_id);
    if (!childIds.length) return res.json({ entries: [], children: [] });
    const { rows } = await pool.query(`
      SELECT mb.id, mb.child_id, mb.title, mb.description, mb.happened_on,
             mb.milestone_type, mb.created_at,
             c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as added_by_name
      FROM ladn.memory_box_entries mb
      LEFT JOIN ladn.children c ON c.id = mb.child_id
      LEFT JOIN ladn.staff s ON s.id = mb.added_by
      WHERE mb.child_id = ANY($1::int[]) AND mb.is_shared_with_parent = true
      ORDER BY mb.happened_on DESC, mb.created_at DESC
    `, [childIds]);
    const cRes = await pool.query(
      'SELECT id, first_name, last_name FROM ladn.children WHERE id = ANY($1::int[])',
      [childIds]
    );
    res.json({ entries: rows, children: cRes.rows });
  } catch (e) {
    console.error('parents memory-box:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Parents: action-plans + items (parent-scoped, before shared routes) ───────
app.get('/api/action-plans', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = require('../../src/db/pool').getPool();
  try {
    const { rows } = await db.query(`
      SELECT ap.*, ch.first_name || ' ' || ch.last_name AS child_name
      FROM ladn.action_plans ap
      LEFT JOIN ladn.children ch ON ch.id = ap.related_child_id
      WHERE ap.scope = 'parents-readonly' AND ap.archived_at IS NULL
        AND ap.related_child_id IN (
          SELECT child_id FROM ladn.parent_portal_access WHERE lower(email)=$1 AND is_active=true
        )
      ORDER BY ap.created_at DESC
    `, [email]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/action-plan-items', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const planId = req.query.plan_id;
  if (!planId) return res.status(400).json({ error: 'plan_id required' });
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = require('../../src/db/pool').getPool();
  try {
    const { rows: access } = await db.query(`
      SELECT 1 FROM ladn.action_plans ap
      JOIN ladn.parent_portal_access pa ON pa.child_id = ap.related_child_id
      WHERE ap.id=$1 AND ap.scope='parents-readonly' AND lower(pa.email)=$2 AND pa.is_active=true
    `, [planId, email]);
    if (!access.length) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await db.query(`
      SELECT i.*, s.first_name || ' ' || s.last_name AS assignee_name,
             (SELECT COUNT(*)::int FROM ladn.action_plan_comments c WHERE c.item_id=i.id) AS comment_count
      FROM ladn.action_plan_items i
      LEFT JOIN ladn.staff s ON s.id=i.assigned_staff_id
      WHERE i.plan_id=$1
      ORDER BY i.position ASC, i.deadline ASC NULLS LAST
    `, [planId]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/action-plan-items/:id/comments', async (req, res) => {
  const db = require('../../src/db/pool').getPool();
  try {
    const { rows } = await db.query(`
      SELECT c.*,
             CASE WHEN c.author_type != 'parent' THEN s.first_name || ' ' || s.last_name ELSE 'You' END AS author_name
      FROM ladn.action_plan_comments c
      LEFT JOIN ladn.staff s ON s.id=c.author_id AND c.author_type != 'parent'
      WHERE c.item_id=$1 ORDER BY c.created_at ASC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/action-plan-items/:id/comments', async (req, res) => {
  const commentBody = req.body?.body;
  if (!commentBody?.trim()) return res.status(400).json({ error: 'body required' });
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = require('../../src/db/pool').getPool();
  try {
    const { rows: access } = await db.query(`
      SELECT pa.child_id FROM ladn.action_plan_items i
      JOIN ladn.action_plans ap ON ap.id=i.plan_id
      JOIN ladn.parent_portal_access pa ON pa.child_id=ap.related_child_id
      WHERE i.id=$1 AND ap.scope='parents-readonly' AND lower(pa.email)=$2 AND pa.is_active=true
    `, [req.params.id, email]);
    if (!access.length) return res.status(403).json({ error: 'Access denied' });
    const { rows } = await db.query(`
      INSERT INTO ladn.action_plan_comments (item_id, author_type, author_id, body)
      VALUES ($1, 'parent', 0, $2) RETURNING *
    `, [req.params.id, commentBody.trim()]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Parents: phonics parent endpoints ────────────────────────────────────────
function _expectedPhaseFromDob(dob) {
  if (!dob) return 1;
  const ageMonths = (Date.now() - new Date(dob)) / (1000 * 60 * 60 * 24 * 30.44);
  if (ageMonths < 48) return 1;
  if (ageMonths < 54) return 2;
  if (ageMonths < 60) return 3;
  if (ageMonths < 72) return 4;
  if (ageMonths < 84) return 5;
  return 6;
}

app.get('/api/phonics/parent/overview', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(`
      SELECT c.id, c.first_name, c.last_name, c.date_of_birth
      FROM ladn.parent_portal_access pa
      JOIN ladn.children c ON c.id = pa.child_id
      WHERE lower(pa.email)=$1 AND pa.is_active=true
      ORDER BY c.first_name LIMIT 1
    `, [email]);
    if (!childRes.rows.length) return res.json({ child: null, progress: [], expected_phase: 1 });
    const child = childRes.rows[0];
    const expectedPhase = _expectedPhaseFromDob(child.date_of_birth);
    const progressRes = await pool.query(`
      SELECT ps.id as sound_id, ps.phase, ps.sound_code, ps.sound_type,
             ps.example_words, ps.pronunciation_guide, ps.rwi_action, ps.position_in_phase,
             cpp.confidence, cpp.last_assessed_at, cpp.notes
      FROM ladn.phonics_sounds ps
      LEFT JOIN ladn.child_phonics_progress cpp ON cpp.sound_id=ps.id AND cpp.child_id=$1
      WHERE ps.phase <= $2
      ORDER BY ps.phase, ps.position_in_phase
    `, [child.id, expectedPhase + 1]);
    res.json({ child, progress: progressRes.rows, expected_phase: expectedPhase });
  } catch (e) { console.error('phonics parent overview:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

app.post('/api/phonics/parent/game-session', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(
      'SELECT child_id FROM ladn.parent_portal_access WHERE lower(email)=$1 AND is_active=true LIMIT 1', [email]
    );
    if (!childRes.rows.length) return res.status(403).json({ error: 'Forbidden' });
    const childId = childRes.rows[0].child_id;
    const { game_type, phase, score, duration_seconds, correct_count, attempted_count, sounds_practiced } = req.body;
    const { rows } = await pool.query(`
      INSERT INTO ladn.phonics_game_sessions
        (child_id,game_type,phase,score,duration_seconds,correct_count,attempted_count,sounds_practiced)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
    `, [childId, game_type, phase, score, duration_seconds, correct_count, attempted_count,
        sounds_practiced?.length ? sounds_practiced : null]);
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { console.error('phonics game session:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ── Parents: records viewer ───────────────────────────────────────────────────
app.get('/welcome/learning-journey/api/journey', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const cr = await pool.query(`SELECT c.id, c.first_name, c.photo_url FROM ladn.parent_portal_access pa JOIN ladn.children c ON c.id=pa.child_id WHERE lower(pa.email)=$1 AND pa.is_active=true ORDER BY c.first_name`, [email]);
    const children = cr.rows; if (!children.length) return res.json({ children: [], observations: [] });
    const ids = children.map(c => c.id);
    const want = req.query.child_id ? [parseInt(req.query.child_id)].filter(id => ids.includes(id)) : ids;
    const scope = want.length ? want : ids;
    const or = await pool.query(`SELECT o.id, o.child_id, o.title, o.observation_text, o.eyfs_areas, o.photo_urls, o.created_at, s.first_name AS staff FROM ladn.observations o LEFT JOIN ladn.staff s ON s.id=o.staff_id WHERE o.child_id = ANY($1) AND o.shared_with_parents=true ORDER BY o.created_at DESC LIMIT 100`, [scope]);
    res.json({ children, observations: or.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ── Parents: leavers keepsake — active gift links for this parent's children ──
app.get('/welcome/keepsake/api/mine', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const { rows } = await pool.query(`
      SELECT g.token, g.title, g.media_count, g.expires_at, g.created_at,
             c.first_name, c.last_name, c.preferred_name
        FROM ladn.leavers_gift_packages g
        JOIN ladn.children c ON c.id = g.child_id
       WHERE g.status='active'
         AND g.child_id IN (SELECT child_id FROM ladn.parent_portal_access WHERE lower(email)=$1 AND is_active=true)
       ORDER BY g.created_at DESC`, [email]);
    res.json({ keepsakes: rows.map(r => ({
      name: r.preferred_name || r.first_name, media_count: r.media_count,
      expires_at: r.expires_at, created_at: r.created_at,
      url: `/keepsake/${r.token}`, download_url: `/keepsake/${r.token}/download`, pdf_url: `/keepsake/${r.token}/book.pdf`,
    })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Parents: GDPR data-subject requests (subject access / erasure) ────────────
app.get('/welcome/data-request/api/mine', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const cr = await pool.query(`SELECT c.id, c.first_name, c.last_name, c.preferred_name FROM ladn.parent_portal_access pa JOIN ladn.children c ON c.id=pa.child_id WHERE lower(pa.email)=$1 AND pa.is_active=true ORDER BY c.first_name`, [email]);
    const children = cr.rows; if (!children.length) return res.json({ children: [], requests: [] });
    const ids = children.map(c => c.id);
    const rr = await pool.query(`
      SELECT r.id, r.child_id, r.request_type, r.status, r.requested_at, r.completed_at, r.package_token,
             c.first_name, c.preferred_name
        FROM ladn.data_subject_requests r JOIN ladn.children c ON c.id=r.child_id
       WHERE r.child_id = ANY($1) ORDER BY r.requested_at DESC`, [ids]);
    res.json({
      children: children.map(c => ({ id: c.id, name: c.preferred_name || c.first_name, last_name: c.last_name })),
      requests: rr.rows.map(r => ({
        id: r.id, child_id: r.child_id, child_name: r.preferred_name || r.first_name,
        request_type: r.request_type, status: r.status,
        requested_at: r.requested_at, completed_at: r.completed_at,
        keepsake_url: r.package_token ? `/keepsake/${r.package_token}` : null,
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/welcome/data-request/api/create', express.json({ limit: '16kb' }), async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const b = req.body || {};
  const childId = parseInt(b.child_id, 10);
  const type = b.request_type;
  if (!['access', 'erasure'].includes(type)) return res.status(400).json({ error: 'request_type must be access or erasure' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const own = await pool.query('SELECT c.first_name, c.preferred_name FROM ladn.parent_portal_access pa JOIN ladn.children c ON c.id=pa.child_id WHERE lower(pa.email)=$1 AND pa.child_id=$2 AND pa.is_active=true', [email, childId]);
    if (!own.rows.length) return res.status(403).json({ error: 'Not your child' });
    // Don't stack duplicate open requests of the same type
    const dup = await pool.query(`SELECT id FROM ladn.data_subject_requests WHERE child_id=$1 AND request_type=$2 AND status IN ('requested','in_review')`, [childId, type]);
    if (dup.rows.length) return res.status(409).json({ error: 'You already have an open request of this type. We\'ll be in touch.' });
    const { rows } = await pool.query(
      `INSERT INTO ladn.data_subject_requests (child_id, request_type, requested_by_email, requester_name, reason, status)
       VALUES ($1,$2,$3,$4,$5,'requested') RETURNING id, status, request_type`,
      [childId, type, email, (b.requester_name || '').slice(0, 120) || null, (b.reason || '').slice(0, 1000) || null]);
    try {
      const { recordAudit } = require('../../src/utils/audit');
      await recordAudit({ req, action: 'create', entity_type: 'data_request', entity_id: rows[0].id,
        actor_type: 'parent', actor_email: email, meta: { child_id: childId, request_type: type } });
    } catch (_) {}
    res.json({ ok: true, request: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/welcome/diary/api/days', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const cr = await pool.query(`SELECT c.id, c.first_name FROM ladn.parent_portal_access pa JOIN ladn.children c ON c.id=pa.child_id WHERE lower(pa.email)=$1 AND pa.is_active=true ORDER BY c.first_name`, [email]);
    const children = cr.rows; if (!children.length) return res.json({ children: [], entries: [] });
    const ids = children.map(c => c.id);
    const want = req.query.child_id ? [parseInt(req.query.child_id)].filter(id => ids.includes(id)) : ids;
    const scope = want.length ? want : ids;
    const dr = await pool.query(`SELECT id, child_id, entry_type, occurred_at, duration_minutes, food_amount, nappy_state, drink_ml, drink_type, sleep_quality, notes, source FROM ladn.diary_entries WHERE child_id = ANY($1) AND deleted_at IS NULL AND (share_with_parents=true OR source='parent') ORDER BY occurred_at DESC LIMIT 80`, [scope]).catch(() => ({ rows: [] }));
    res.json({ children, entries: dr.rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Parent baby-log — parents write feeds/sleep/nappies for their OWN child (2026-06-16). source='parent'.
app.post('/welcome/baby-log/api/log', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const b = req.body || {};
  const childId = parseInt(b.child_id);
  const TYPES = ['drink','food','nappy','sleep','note'];
  if (!TYPES.includes(b.entry_type)) return res.status(400).json({ error: 'invalid entry_type' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const own = await pool.query('SELECT 1 FROM ladn.parent_portal_access WHERE lower(email)=$1 AND child_id=$2 AND is_active=true', [email, childId]);
    if (!own.rows.length) return res.status(403).json({ error: 'Not your child' });
    await pool.query(`INSERT INTO ladn.diary_entries
      (child_id, entry_type, occurred_at, duration_minutes, food_amount, nappy_state, drink_ml, drink_type, sleep_quality, notes, share_with_parents, source, logged_by_name)
      VALUES ($1,$2,COALESCE($3::timestamptz,now()),$4,$5,$6,$7,$8,$9,$10,true,'parent',$11)`,
      [childId, b.entry_type, b.occurred_at || null, b.duration_minutes || null, b.food_amount || null,
       b.nappy_state || null, b.drink_ml || null, b.drink_type || null, b.sleep_quality || null,
       (b.notes || '').slice(0,500) || null, (b.logged_by_name || 'Parent').slice(0,60)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/welcome/records/api/my-records', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(`
      SELECT c.id, c.first_name, c.last_name, c.room_id
      FROM ladn.parent_portal_access pa
      JOIN ladn.children c ON c.id = pa.child_id
      WHERE lower(pa.email)=$1 AND pa.is_active=true ORDER BY c.first_name
    `, [email]);
    const children = childRes.rows;
    if (!children.length) return res.json({ children: [], modules: [], records: [] });
    const childIds = children.map(c => c.id);
    const modRes = await pool.query(`
      SELECT id, slug, name, description, icon, attaches_to, fields
      FROM ladn.modules
      WHERE is_active=true AND portals @> '["parents"]'::jsonb
        AND (permissions->'parents'->'parent') @> '["view_own_child"]'::jsonb
      ORDER BY name
    `);
    const modules = modRes.rows;
    if (!modules.length) return res.json({ children, modules: [], records: [] });
    const applicable = modules.filter(m => m.attaches_to === 'child' || m.attaches_to === 'multi');
    const moduleIds = applicable.map(m => m.id);
    let records = [];
    if (moduleIds.length) {
      const recRes = await pool.query(`
        SELECT id, module_id, entity_type, entity_id, data, submitted_at, submitted_portal, related_ids
        FROM ladn.module_records
        WHERE module_id=ANY($1::int[]) AND is_deleted=false
          AND ((entity_type='child' AND entity_id=ANY($2::int[]))
               OR (related_ids->'child' ?| ARRAY(SELECT i::text FROM unnest($2::int[]) AS i)))
        ORDER BY submitted_at DESC LIMIT 500
      `, [moduleIds, childIds]);
      records = recRes.rows;
    }
    res.json({ children, modules, records });
  } catch (e) { console.error('my-records:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

app.get('/welcome/records/api/module/:moduleId/record/:recordId', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim();
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const pool = require('../../src/db/pool').getPool();
  try {
    const childRes = await pool.query(
      'SELECT child_id FROM ladn.parent_portal_access WHERE lower(email)=$1 AND is_active=true', [email]
    );
    const childIds = childRes.rows.map(r => r.child_id);
    if (!childIds.length) return res.status(404).json({ error: 'Not found' });
    const rec = await pool.query(`
      SELECT r.*, m.slug, m.name AS module_name, m.fields, m.icon, m.attaches_to
      FROM ladn.module_records r
      JOIN ladn.modules m ON m.id=r.module_id
      WHERE r.id=$1 AND r.module_id=$2 AND r.is_deleted=false AND m.is_active=true
        AND m.portals @> '["parents"]'::jsonb
        AND ((r.entity_type='child' AND r.entity_id=ANY($3::int[]))
             OR (related_ids->'child' ?| ARRAY(SELECT i::text FROM unnest($3::int[]) AS i)))
    `, [req.params.recordId, req.params.moduleId, childIds]);
    if (!rec.rows.length) return res.status(404).json({ error: 'Not found' });
    const record = rec.rows[0];
    const uploads = await pool.query(
      'SELECT id, field_key, filename FROM ladn.module_uploads WHERE record_id=$1', [record.id]
    );
    record._uploads = uploads.rows.map(u => ({ ...u, url: `/api/module-uploads/${u.id}` }));
    res.json(record);
  } catch (e) { console.error('single-record:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ── Parents: invoices/fees (READ-ONLY), consents, events/RSVP, report-absence ──
// (2026-07-01) All CF-Access email scoped to the parent's OWN children via
// ladn.parent_portal_access. No payment capture anywhere (Toby: view-only round).
const _parentPool = () => require('../../src/db/pool').getPool();
function _parentEmail(req) { return (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim(); }
async function _parentChildren(email) {
  const { rows } = await _parentPool().query(`
    SELECT c.id, c.first_name, c.last_name, c.room_id
    FROM ladn.parent_portal_access pa JOIN ladn.children c ON c.id=pa.child_id
    WHERE lower(pa.email)=$1 AND pa.is_active=true ORDER BY c.first_name`, [email]);
  return rows;
}

// §1 INVOICES / FEES — funding entitlement + invoice history + outstanding balance.
app.get('/welcome/invoices/api/summary', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = _parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = _parentPool();
  try {
    const children = await _parentChildren(email);
    if (!children.length) return res.json({ children: [], funding: [], invoices: [], outstanding_pence: 0 });
    const ids = children.map(c => c.id);
    // Current-term funding entitlement per child (read-only, informational).
    const funding = (await db.query(`
      SELECT cf.child_id, cf.funding_type, cf.universal_hours_week, cf.extended_hours_week,
             cf.total_hours_week, cf.stretched_funding, cf.thirty_hour_code,
             ft.name AS term_name
      FROM ladn.child_funding cf
      JOIN ladn.funding_terms ft ON ft.id=cf.term_id AND ft.is_current=true
      WHERE cf.child_id = ANY($1::int[])
    `, [ids])).rows;
    // Invoice history — strictly scoped to the parent's children.
    const invoices = (await db.query(`
      SELECT id, child_id, invoice_number, period_label, period_year, period_month,
             amount_pence, funding_deduction_pence, status, issued_on, due_on, paid_on,
             reference, line_items, notes
      FROM ladn.invoices
      WHERE child_id = ANY($1::int[])
      ORDER BY COALESCE(issued_on, created_at::date) DESC, id DESC
      LIMIT 200
    `, [ids])).rows;
    const OUTSTANDING = new Set(['issued', 'sent', 'overdue', 'partial', 'unpaid', 'pending']);
    const outstanding_pence = invoices
      .filter(iv => OUTSTANDING.has((iv.status || '').toLowerCase()))
      .reduce((s, iv) => s + (iv.amount_pence || 0), 0);
    res.json({ children, funding, invoices, outstanding_pence });
  } catch (e) { console.error('parents invoices summary:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// §2 CONSENTS — list + set (parent toggles). Dual-writes legacy children.* columns.
const _consentSvc = require('../../src/routes/consents');
app.get('/welcome/consents/api/list', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = _parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = _parentPool();
  try {
    const children = await _parentChildren(email);
    if (!children.length) return res.json({ children: [], types: _consentSvc.CONSENT_TYPES });
    const ids = children.map(c => c.id);
    const rows = (await db.query(
      'SELECT child_id, consent_type, granted, consent_date, source, updated_at FROM ladn.child_consents WHERE child_id = ANY($1::int[])',
      [ids]
    )).rows;
    const withConsents = children.map(c => ({
      ...c,
      consents: _consentSvc.mergeConsents(rows.filter(r => r.child_id === c.id)),
    }));
    res.json({ children: withConsents, types: _consentSvc.CONSENT_TYPES });
  } catch (e) { console.error('parents consents list:', e.message); res.status(500).json({ error: 'Internal error' }); }
});
app.post('/welcome/consents/api/set', express.json({ limit: '16kb' }), async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = _parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const { child_id, consent_type, granted } = req.body || {};
  const childId = parseInt(child_id, 10);
  if (!_consentSvc.TYPE_KEYS.has(consent_type)) return res.status(400).json({ error: 'Unknown consent_type' });
  const db = _parentPool();
  try {
    const own = await db.query('SELECT 1 FROM ladn.parent_portal_access WHERE lower(email)=$1 AND child_id=$2 AND is_active=true', [email, childId]);
    if (!own.rows.length) return res.status(403).json({ error: 'Not your child' });
    await _consentSvc.setConsent(db, childId, consent_type, granted === null ? null : !!granted, 'parent', 0);
    const rows = (await db.query('SELECT consent_type, granted, consent_date, source, updated_at FROM ladn.child_consents WHERE child_id=$1', [childId])).rows;
    res.json({ child_id: childId, consents: _consentSvc.mergeConsents(rows) });
  } catch (e) { console.error('parents consents set:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// §3 EVENTS + RSVP — upcoming published events + the parent's own RSVPs.
app.get('/welcome/events/api/list', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = _parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = _parentPool();
  try {
    const children = await _parentChildren(email);
    if (!children.length) return res.json({ children: [], events: [] });
    const ids = children.map(c => c.id);
    const roomIds = [...new Set(children.map(c => c.room_id).filter(Boolean))].map(String);
    // audience='all' OR audience matches one of the parent's children's rooms
    const events = (await db.query(`
      SELECT id, title, description, event_date, start_time, end_time, location, audience, rsvp_required, capacity
      FROM ladn.events
      WHERE is_published=true AND event_date >= CURRENT_DATE
        AND (audience='all' OR audience = ANY($1::text[]))
      ORDER BY event_date ASC, start_time ASC NULLS LAST
      LIMIT 100
    `, [roomIds.length ? roomIds : ['__none__']])).rows;
    const rsvps = events.length ? (await db.query(
      'SELECT event_id, child_id, response, headcount, note FROM ladn.event_rsvps WHERE child_id = ANY($1::int[])', [ids]
    )).rows : [];
    res.json({ children, events, rsvps });
  } catch (e) { console.error('parents events list:', e.message); res.status(500).json({ error: 'Internal error' }); }
});
app.post('/welcome/events/api/rsvp', express.json({ limit: '16kb' }), async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = _parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const b = req.body || {};
  const eventId = parseInt(b.event_id, 10), childId = parseInt(b.child_id, 10);
  const response = b.response === 'no' ? 'no' : 'yes';
  const headcount = Math.max(0, Math.min(20, parseInt(b.headcount, 10) || 1));
  const db = _parentPool();
  try {
    const own = await db.query('SELECT 1 FROM ladn.parent_portal_access WHERE lower(email)=$1 AND child_id=$2 AND is_active=true', [email, childId]);
    if (!own.rows.length) return res.status(403).json({ error: 'Not your child' });
    const ev = await db.query('SELECT 1 FROM ladn.events WHERE id=$1 AND is_published=true', [eventId]);
    if (!ev.rows.length) return res.status(404).json({ error: 'Event not found' });
    const { rows } = await db.query(`
      INSERT INTO ladn.event_rsvps (event_id, child_id, parent_email, response, headcount, note, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,now())
      ON CONFLICT (event_id, child_id) DO UPDATE
        SET response=EXCLUDED.response, headcount=EXCLUDED.headcount, note=EXCLUDED.note,
            parent_email=EXCLUDED.parent_email, updated_at=now()
      RETURNING *
    `, [eventId, childId, email, response, response === 'yes' ? headcount : 0, (b.note || '').slice(0, 300) || null]);
    res.json(rows[0]);
  } catch (e) { console.error('parents rsvp:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// §4 PARENT-REPORTED ABSENCE / HOLIDAY — writes the report + reflects it onto the
// register (attendance.absent=true for booked days) + notifies staff.
const { applyReportedAbsence } = require('../../src/services/register-absence');
app.get('/welcome/absence/api/list', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = _parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = _parentPool();
  try {
    const children = await _parentChildren(email);
    if (!children.length) return res.json({ children: [], absences: [] });
    const ids = children.map(c => c.id);
    const absences = (await db.query(`
      SELECT a.id, a.child_id, a.start_date, a.end_date, a.absence_type, a.reason, a.status, a.created_at
      FROM ladn.parent_reported_absences a
      WHERE a.child_id = ANY($1::int[]) AND a.end_date >= CURRENT_DATE - INTERVAL '60 days'
      ORDER BY a.start_date DESC LIMIT 50
    `, [ids])).rows;
    res.json({ children, absences });
  } catch (e) { console.error('parents absence list:', e.message); res.status(500).json({ error: 'Internal error' }); }
});
app.post('/welcome/absence/api/report', express.json({ limit: '16kb' }), async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = _parentEmail(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const b = req.body || {};
  const childId = parseInt(b.child_id, 10);
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  if (!DATE_RE.test(b.start_date || '') || !DATE_RE.test(b.end_date || '')) return res.status(400).json({ error: 'start_date and end_date (YYYY-MM-DD) required' });
  if (b.end_date < b.start_date) return res.status(400).json({ error: 'end_date must be on or after start_date' });
  const absenceType = b.absence_type === 'holiday' ? 'holiday' : 'absence';
  const db = _parentPool();
  try {
    const own = await db.query(
      'SELECT c.first_name, c.last_name FROM ladn.parent_portal_access pa JOIN ladn.children c ON c.id=pa.child_id WHERE lower(pa.email)=$1 AND pa.child_id=$2 AND pa.is_active=true',
      [email, childId]
    );
    if (!own.rows.length) return res.status(403).json({ error: 'Not your child' });
    const childName = `${own.rows[0].first_name} ${own.rows[0].last_name}`;
    const reason = (b.reason || '').slice(0, 500) || null;
    const ins = await db.query(`
      INSERT INTO ladn.parent_reported_absences (child_id, start_date, end_date, absence_type, reason, reported_by_email, applied_at)
      VALUES ($1,$2,$3,$4,$5,$6, now()) RETURNING *
    `, [childId, b.start_date, b.end_date, absenceType, reason, email]);
    // Reflect onto the register for booked, today-or-future days.
    let markedDates = [];
    try { markedDates = await applyReportedAbsence(db, childId, b.start_date, b.end_date, reason || `Parent-reported ${absenceType}`); }
    catch (e) { console.error('applyReportedAbsence:', e.message); }
    // In-app notification for managers.
    try {
      await db.query(`
        INSERT INTO ladn.notifications (recipient_type, recipient_id, category, title, body, link, related_table, related_id, priority)
        VALUES ('all-managers', NULL, 'absence', $1, $2, '/admin/family/absences', 'parent_reported_absences', $3, 'normal')
      `, [
        `Parent-reported ${absenceType}: ${childName}`,
        `${childName} — ${b.start_date}${b.end_date !== b.start_date ? ' to ' + b.end_date : ''}${reason ? ' · ' + reason : ''}`,
        ins.rows[0].id,
      ]);
    } catch (e) { console.error('absence notification:', e.message); }
    // Telegram staff alert (best-effort, proven path).
    try {
      const tok = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
      if (tok && chat) {
        const text = `🏝️ Parent-reported ${absenceType}\n${childName}: ${b.start_date}${b.end_date !== b.start_date ? '→' + b.end_date : ''}${reason ? '\nReason: ' + reason : ''}${markedDates.length ? '\nRegister marked absent: ' + markedDates.length + ' day(s)' : ''}`;
        const https = require('https');
        const payload = new URLSearchParams({ chat_id: chat, text }).toString();
        const r = https.request({ hostname: 'api.telegram.org', path: `/bot${tok}/sendMessage`, method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) } });
        r.on('error', () => {}); r.write(payload); r.end();
      }
    } catch (e) { console.error('absence telegram:', e.message); }
    res.status(201).json({ ...ins.rows[0], marked_dates: markedDates });
  } catch (e) { console.error('parents absence report:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ── Parents: primary-demo routes (homework, calendar, behaviour) ──────────────
let _primaryPool;
function getPrimaryPool() {
  if (!_primaryPool) {
    _primaryPool = new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5432'),
      database: process.env.PG_DB || 'wren',
      user: process.env.PG_USER || 'wren',
      password: process.env.PG_PASSWORD,
      options: '-c search_path=demo_primary,public',
      max: 4,
    });
  }
  return _primaryPool;
}

// (duplicate mounts — superseded by the redirects above; kept neutralised, not serving demo data)
app.get('/welcome/homework', (req, res, next) => { if (req._portal !== 'parents') return next(); res.redirect('/welcome'); });
app.get('/welcome/calendar', (req, res, next) => { if (req._portal !== 'parents') return next(); res.redirect('/welcome'); });

app.get('/api/primary-demo/homework', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  try {
    const db = getPrimaryPool();
    const { rows } = await db.query(`
      SELECT h.id,h.title,h.description,h.due_date,h.type,h.estimated_duration_minutes,
             h.external_resource_url,h.attachment_paths,
             c.name AS class_name, c.id AS class_id, c.year_group,
             s.name AS subject_name
      FROM demo_primary.homework h
      LEFT JOIN demo_primary.classes c ON c.id=h.class_id
      LEFT JOIN demo_primary.subjects s ON s.id=h.subject_id
      WHERE h.is_published=true ORDER BY h.due_date ASC, h.set_at DESC LIMIT 50
    `);
    const childRes = await db.query(`SELECT id,first_name,last_name FROM demo_primary.children WHERE is_active=true ORDER BY first_name LIMIT 100`);
    res.json({ homework: rows, children: childRes.rows });
  } catch (e) { console.error('primary-demo homework:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

app.post('/api/primary-demo/homework/:id/done', express.json({ limit: '64kb' }), async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  try {
    const db = getPrimaryPool();
    const hwId = parseInt(req.params.id);
    const { pupil_id, content } = req.body;
    const pid = pupil_id || 1;
    const existing = await db.query('SELECT id FROM demo_primary.homework_submissions WHERE homework_id=$1 AND pupil_id=$2', [hwId, pid]);
    if (existing.rows.length) {
      await db.query('UPDATE demo_primary.homework_submissions SET completed_at=now(),content=$1,parent_acknowledged=true WHERE id=$2', [content || null, existing.rows[0].id]);
    } else {
      await db.query(`INSERT INTO demo_primary.homework_submissions (homework_id,pupil_id,completed_at,content,parent_acknowledged) VALUES ($1,$2,now(),$3,true)`, [hwId, pid, content || null]);
    }
    res.json({ ok: true });
  } catch (e) { console.error('primary-demo homework done:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

app.get('/api/primary-demo/calendar', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  try {
    const db = getPrimaryPool();
    const events = [];
    const terms = await db.query('SELECT * FROM demo_primary.terms ORDER BY start_date');
    for (const t of terms.rows) {
      events.push({ title: `📅 ${t.name}`, start: t.start_date, end: t.end_date, type: 'term', colour: '#4a9abf' });
      if (t.half_term_start) events.push({ title: 'Half term', start: t.half_term_start, end: t.half_term_end, type: 'half_term', colour: '#e07820' });
    }
    const anns = await db.query(`SELECT title,valid_from AS event_date,body AS description FROM demo_primary.school_announcements WHERE valid_from IS NOT NULL ORDER BY valid_from`);
    for (const a of anns.rows) events.push({ title: `📢 ${a.title}`, start: a.event_date, type: 'announcement', colour: '#8b5cf6', description: a.description });
    const trips = await db.query('SELECT * FROM demo_primary.school_trips ORDER BY trip_date');
    for (const t of trips.rows) events.push({ title: `🚌 ${t.name}`, start: t.trip_date, type: 'trip', colour: '#22c55e', description: `To ${t.destination || '—'}` });
    const pe = await db.query('SELECT DISTINCT slot_date FROM demo_primary.parents_evening_slots ORDER BY slot_date');
    for (const p of pe.rows) events.push({ title: `👨‍👩‍👧 Parents Evening`, start: p.slot_date, type: 'parents_evening', colour: '#f59e0b' });
    const clubs = await db.query('SELECT name,day_of_week FROM demo_primary.school_clubs WHERE is_active=true ORDER BY name');
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    for (const c of clubs.rows) events.push({ title: `🎨 ${c.name}`, recurring: `Weekly ${days[c.day_of_week]||''}`, type: 'club', colour: '#06b6d4', day_of_week: c.day_of_week });
    res.json(events);
  } catch (e) { console.error('primary-demo calendar:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

app.get('/api/primary-demo/calendar-token', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  const email = (req.headers['cf-access-authenticated-user-email'] || '').toLowerCase().trim() || 'demo@wren.test';
  try {
    const db = getPrimaryPool();
    const { rows } = await db.query('SELECT calendar_token FROM demo_primary.parent_portal_access WHERE lower(email)=$1 AND is_active=true LIMIT 1', [email]);
    if (rows.length && rows[0].calendar_token) return res.json({ token: rows[0].calendar_token });
    const token = crypto.randomBytes(32).toString('hex');
    try { await db.query('UPDATE demo_primary.parent_portal_access SET calendar_token=$1 WHERE lower(email)=$2', [token, email]); } catch {}
    res.json({ token });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/primary-demo/calendar.ics', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  try {
    const db = getPrimaryPool();
    const icsLines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Wren//School Calendar//EN','X-WR-CALNAME:School Calendar'];
    const { rows: terms } = await db.query('SELECT * FROM demo_primary.terms ORDER BY start_date');
    const { rows: trips } = await db.query('SELECT * FROM demo_primary.school_trips ORDER BY trip_date');
    const { rows: pe }    = await db.query('SELECT DISTINCT slot_date FROM demo_primary.parents_evening_slots ORDER BY slot_date');
    const { rows: anns }  = await db.query('SELECT * FROM demo_primary.school_announcements WHERE valid_from IS NOT NULL');
    const pushEv = (summary, dtstart, dtend, uid, desc) => {
      const s = String(dtstart).slice(0,10).replace(/-/g,'');
      const e = dtend ? String(dtend).slice(0,10).replace(/-/g,'') : '';
      icsLines.push('BEGIN:VEVENT');
      icsLines.push(`DTSTART;VALUE=DATE:${s}`);
      if (e && e !== s) icsLines.push(`DTEND;VALUE=DATE:${e}`);
      icsLines.push(`SUMMARY:${summary.replace(/[\r\n]/g,' ')}`);
      icsLines.push(`UID:${uid}`);
      if (desc) icsLines.push(`DESCRIPTION:${desc.replace(/[\r\n]/g,' ').slice(0,200)}`);
      icsLines.push('END:VEVENT');
    };
    terms.forEach(t => { pushEv(t.name, t.start_date, t.end_date, `term-${t.id}@wren`, ''); if (t.half_term_start) pushEv('Half Term', t.half_term_start, t.half_term_end, `ht-${t.id}@wren`, ''); });
    trips.forEach(t => pushEv(`Trip: ${t.name}`, t.trip_date, t.trip_date, `trip-${t.id}@wren`, `To ${t.destination||'—'}`));
    pe.forEach(p => pushEv("Parents' Evening", p.slot_date, p.slot_date, `pe-${p.slot_date}@wren`, ''));
    anns.forEach(a => pushEv(a.title, a.valid_from, a.valid_from, `ann-${a.id}@wren`, (a.body||'').slice(0,200)));
    icsLines.push('END:VCALENDAR');
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="school-calendar.ics"');
    res.send(icsLines.join('\r\n'));
  } catch (e) { res.status(500).send('Calendar generation failed'); }
});

app.get('/api/primary-demo/behaviour-recognition', async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  try {
    const db = getPrimaryPool();
    const { rows } = await db.query(`
      SELECT bp.id,bp.category,bp.points,bp.awarded_at,
             CONCAT(ch.first_name,' ',ch.last_name) AS pupil_name,
             ch.first_name,c.name AS class_name
      FROM demo_primary.behaviour_points bp
      JOIN demo_primary.children ch ON ch.id=bp.pupil_id
      LEFT JOIN demo_primary.classes c ON c.year_group::text=ch.year_group
      WHERE bp.type='positive' ORDER BY bp.awarded_at DESC LIMIT 5
    `);
    res.json(rows);
  } catch (e) { console.error('primary-demo behaviour-recognition:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ── Parents: external test flow (security dashboard) ─────────────────────────
let _extPool;
function getExtPool() {
  if (!_extPool) {
    _extPool = new Pool({
      host: process.env.PG_HOST || 'localhost',
      port: parseInt(process.env.PG_PORT || '5434'),
      database: process.env.PG_DB || 'wren',
      user: process.env.PG_USER || 'wren',
      password: process.env.PG_PASSWORD,
      options: '-c search_path=ladn,public',
      max: 3,
    });
  }
  return _extPool;
}

app.get('/external-test/:token', (req, res, next) => {
  if (req._portal !== 'parents') return next();
  res.sendFile(path.join(__dirname, '../parents/public/external-test.html'));
});

app.post('/api/security/external-test-result/:token', express.json({ limit: '64kb' }), async (req, res, next) => {
  if (req._portal !== 'parents') return next();
  try {
    const db = getExtPool();
    const { rows: [row] } = await db.query('SELECT id,expires_at,used_at FROM ladn.external_test_tokens WHERE token=$1', [req.params.token]);
    if (!row) return res.status(404).json({ error: 'Invalid token' });
    if (new Date(row.expires_at) < new Date()) return res.status(410).json({ error: 'Token expired' });
    if (row.used_at) return res.status(409).json({ error: 'Token already used' });
    const rawIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
    const ipHash = crypto.createHash('sha256').update(rawIp).digest('hex');
    const ua = (req.headers['user-agent'] || '').slice(0, 500);
    await db.query(`UPDATE ladn.external_test_tokens SET used_at=now(),result_json=$1,visitor_user_agent=$2,visitor_ip_hash=$3 WHERE id=$4`,
      [JSON.stringify(req.body || {}), ua, ipHash, row.id]);
    res.json({ ok: true });
  } catch (e) { console.error('[ext-test] result error:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ── API routes — common to all portals ───────────────────────────────────────
app.use('/api/auth',         require('../../src/routes/auth'));
app.use('/api/staff',        require('../../src/routes/staff'));
app.use('/api/absence',      require('../../src/routes/absence'));
app.use('/api/cpd',          require('../../src/routes/cpd'));
app.use('/api/induction',    require('../../src/routes/induction'));
app.use('/api/supervisions', require('../../src/routes/supervisions'));
app.use('/api/performance',  require('../../src/routes/performance'));
app.use('/api/ai',           require('../../src/routes/ai'));
app.use('/api/occupancy',    require('../../src/routes/occupancy'));
app.use('/api/brain',        require('../../src/routes/brain')); // Wren Brain RAG (prompt 79)
app.use('/api/staff-research', require('../../src/routes/staff-research')); // research chatbot (prompt 78)
app.use('/api/admissions-engine', require('../../src/routes/admissions-engine'));
app.use('/api/waitlist-board', require('../../src/routes/waitlist-board')); // Parent Waitlist Board (2026-07-06)
app.use('/api/reports',      require('../../src/routes/reports'));
app.use('/api/action-plans',      require('../../src/routes/action-plans'));
app.use('/api/action-plan-items', require('../../src/routes/action-plan-items'));
app.use('/api/notifications',     require('../../src/routes/notifications'));
require('../../src/services/notification-dispatcher').startDispatcher();

// ── Task reminder drainer (P4 Actions a) ────────────────────────
try { require('../../src/services/task-reminder-drainer').startTaskReminderDrainer(); }   catch(e) { console.error('task-reminder-drainer:', e.message); }
try { require('../../src/services/planner-reminder-drainer').startPlannerReminderDrainer(); } catch(e) { console.error('planner-reminder-drainer:', e.message); }

// ── Termly-update reminder drainer (Prompt 28C) ─────────────────
try { require('../../src/services/termly-reminder-drainer').startTermlyReminderDrainer(); } catch(e) { console.error('termly-reminder-drainer:', e.message); }

// ── Staff clock-in/out reminder drainer (c04) ────────────────────
try { require('../../src/services/staff-clock-reminder-drainer').startStaffClockReminderDrainer(); } catch(e) { console.error('staff-clock-reminder-drainer:', e.message); }

// ── Notification cron jobs (working-hours queue drain + daily summary) ────────
try { require('../../src/jobs/notification-queue-drain').startQueueDrain(); } catch(e) { console.error('notification-queue-drain:', e.message); }
try { require('../../src/jobs/daily-summary-email').startCron(); }           catch(e) { console.error('daily-summary-cron:', e.message); }
try { require('../../src/jobs/comms-email-queue-drain').startEmailQueueDrain(); } catch(e) { console.error('comms-email-queue-drain:', e.message); }
try { require('../../src/jobs/gmail-inbox-poller').startInboxPoller(); }       catch(e) { console.error('gmail-inbox-poller:', e.message); }
try { require('../../src/jobs/cockpit-monitors').startCockpitMonitors(); }   catch(e) { console.error('cockpit-monitors:', e.message); }

app.use('/api/repairs',           require('../../src/routes/repairs'));
app.use('/api/modules',           require('../../src/routes/modules'));
app.use('/api/module-uploads',    require('../../src/routes/modules').uploadsHandler);
app.use('/api/export',            require('../../src/routes/export'));
app.use('/api/menus',             require('../../src/routes/menus'));
app.use('/api/rota',              require('../../src/routes/rota'));
app.use('/api/work-patterns',     require('../../src/routes/work-patterns'));
app.use('/api/messages',          require('../../src/routes/messages'));
app.use('/api/newsletter',        require('../../src/routes/newsletter'));
app.use('/api/planning',            require('../../src/routes/planning'));
app.use('/api/next-steps',          require('../../src/routes/next-steps'));
app.use('/api/visual-schedules',    require('../../src/routes/visual-schedules'));
app.use('/api/planned-activities',  require('../../src/routes/planned-activities'));
app.use('/api/survey',            require('../../src/routes/survey'));
try { app.use('/api/ai', require('../../src/routes/ai-features')); } catch (e) { console.error('ai-features:', e.message); }

// ── API routes — EY learning + admin (child data) ────────────────────────────
app.use('/api/children',     require('../../src/routes/children'));
app.use('/api/observations', require('../../src/routes/observations'));
app.use('/api/attendance',   require('../../src/routes/attendance'));
app.use('/api/attendance-monitoring', require('../../src/routes/attendance-monitoring')); // s04: Ofsted attendance pattern monitoring
app.use('/api/collectors',   require('../../src/routes/collectors'));    // s03: authorised collectors
app.use('/api/occupancy-sandbox', require('../../src/routes/occupancy-sandbox')); // occupancy/ratio what-if sandbox
app.use('/api/competitor-intel', require('../../src/routes/competitor-intel')); // Intelligence: competitor watch + social listening
app.use('/api/cf-access', require('../../src/routes/cf-access')); // Roost: Cloudflare Access management panel
app.use('/api/bookings',     require('../../src/routes/bookings'));
app.use('/api/consents',     require('../../src/routes/consents'));       // parents-portal consent mgmt (admin read/override)
app.use('/api/events',       require('../../src/routes/events'));         // nursery events + RSVP (admin)
app.use('/api/parent-absence', require('../../src/routes/parent-absence')); // parent-reported absence (admin read)
app.use('/api/diary',        require('../../src/routes/diary'));
app.use('/api/daily-diary',  require('../../src/routes/daily-diary-group'));
app.use('/api/menu',         require('../../src/routes/menu'));
app.use('/api/sleep',        require('../../src/routes/sleep'));
app.use('/api/medicine',     require('../../src/routes/medicine'));
app.use('/api/child-temperatures', require('../../src/routes/child-temperatures')); // Standalone temperature log (c05)
app.use('/api/incidents',    require('../../src/routes/incidents'));
app.use('/api/safeguarding', require('../../src/routes/safeguarding'));
app.use('/api/enquiries',    require('../../src/routes/enquiries'));
app.use('/api/admin',        require('../../src/routes/admin'));
app.use('/api/admin',        require('../../src/routes/notification-prefs'));
app.use('/api/custom-frameworks', require('../../src/routes/custom-frameworks'));
app.use('/api/launch-prep',  require('../../src/routes/launch-prep')); // July 31 EyLog-exit readiness (Prompt 66)
app.use('/api/parents',      require('../../src/routes/parents'));
app.use('/api/home-log',   require('../../src/routes/home-log'));
app.use('/api/curriculum',   require('../../src/routes/curriculum'));
app.use('/api/phonics',      require('../../src/routes/phonics'));
// First-run setup wizard API (prompt 67) — self-gated on settings.setup_complete.
// On ladn (production) setup_complete is seeded 'true', so every endpoint 403s.
try { app.use('/api/setup', require('../../src/routes/setup')); } catch(e) { console.error('mount setup:', e.message); }
app.use('/api/sen',          require('../../src/routes/sen'));
app.use('/api/outings',      require('../../src/routes/outings'));
app.use('/api/activity-bank', require('../../src/routes/activity-bank'));
app.use('/api/first-words',   require('../../src/routes/first-words'));
app.use('/api/funding',       require('../../src/routes/funding'));
try { app.use('/api/funding-portal', require('../../src/routes/funding-portal')); } catch(e) { console.error('funding-portal:', e.message); }
app.use('/api/clockin',       require('../../src/routes/clockin'));
app.use('/api/transcribe',    require('../../src/routes/transcribe'));
app.use('/api/telegram-voice', require('../../src/routes/telegram-voice')); // voice-note → whisper transcript (secret-gated, for bot wiring)
app.use('/api/interventions', require('../../src/routes/intervention'));
app.use('/api/memory-box',    require('../../src/routes/memory-box'));
app.use('/api/vapi',          require('../../src/routes/vapi'));
app.use('/api/aria',          require('../../src/routes/aria'));
app.use('/api/decision-log',  require('../../src/routes/decision-log'));
app.use('/api/payments',      require('../../src/routes/payments'));
app.use('/api/permission-slips', require('../../src/routes/permission-slips'));
app.use('/api/voice-notes',  require('../../src/routes/voice-notes'));
app.use('/api/away-mode',   require('../../src/routes/away-mode'));
app.use('/api/visitors',    require('../../src/routes/visitors'));

// ── Calendar: admin uses routes/calendar, others use routes/calendar-feeds ────
app.use('/api/calendar', (req, res, next) => {
  const r = req._portal === 'admin'
    ? require('../../src/routes/calendar')
    : require('../../src/routes/calendar-feeds');
  r(req, res, next);
});

// ── API routes — admin portal only ───────────────────────────────────────────
app.use('/api/features',           require('../../src/routes/features'));
app.use('/api/kitchen',            require('../../src/routes/kitchen'));
app.use('/api/tasks',              require('../../src/routes/tasks'));
app.use('/api/comms',              require('../../src/routes/comms'));
app.use('/api/vapi-health',        require('../../src/routes/vapi-health'));
app.use('/api/compliance-events',  require('../../src/routes/compliance-events'));
app.use('/api/invoices',           require('../../src/routes/invoices'));
app.use('/api/daily-briefing',     require('../../src/routes/daily-briefing'));
app.use('/api/daily-tasks',        require('../../src/routes/daily-tasks'));
app.use('/api/parent-reports',     require('../../src/routes/parent-reports'));
app.use('/api/two-year-checks',    require('../../src/routes/two-year-checks'));
app.use('/api/leavers-book',       require('../../src/routes/leavers-book'));
app.use('/api/leavers-gift',       require('../../src/routes/leavers-gift'));
app.use('/api/audit',              require('../../src/routes/audit'));
app.use('/api/study',              require('../../src/routes/study'));
app.use('/api/security',           require('../../src/routes/security'));
app.use('/api/email-triage',       require('../../src/routes/email-triage'));
app.use('/api/email-gateway',      require('../../src/routes/email-gateway'));
app.use('/api/planner',            require('../../src/routes/planner'));
app.use('/api/funding-declarations', require('../../src/routes/funding-declarations'));
app.use('/api/parent-change-requests', require('../../src/routes/parent-change-requests'));
app.use('/api/feedback',           require('../../src/routes/feedback'));
app.use('/api/absence-fairness',   require('../../src/routes/absence-fairness'));
app.use('/api/onboarding',        require('../../src/routes/onboarding'));
app.use('/api/state',              require('../../src/routes/state-forecast'));
app.use('/api/permissions',        require('../../src/routes/permissions'));
app.use('/api/vapi-actions',       require('../../src/routes/vapi-actions'));
app.use('/api/import',             require('../../src/routes/import-wizard'));
app.use('/api/ctf',                require('../../src/routes/ctf'));
app.use('/api/payments-admin',     require('../../src/routes/payments-admin'));
app.use('/api/finance/dashboard',  require('../../src/routes/finance-dashboard'));
app.use('/api/finance/forecast',   require('../../src/routes/finance-forecast'));
app.use('/api/finance/invoices',   require('../../src/routes/finance-invoices'));
app.use('/api/james', require('../../src/routes/james'));
app.use('/api/finance/reconcile',  require('../../src/routes/finance-reconcile'));
app.use('/api/finance/wages',      require('../../src/routes/finance-wages'));
app.use('/api/finance/payroll',    require('../../src/routes/finance-payroll'));
// Xero OAuth + sync + salary-per-room + funded-hours-recon + status/preferences
app.use('/api/finance',            require('../../src/routes/finance-xero'));
app.use('/api/open-banking',       require('../../src/routes/open-banking'));
app.use('/api/migration',          require('../../src/routes/migration-helper'));

// ── API routes — HR portal only ───────────────────────────────────────────────
app.use('/api/toil',     require('../../src/routes/toil'));
app.use('/api/policies', require('../../src/routes/policies'));
app.use('/api/policies-ai', require('../../src/routes/policies-ai')); // AI clarify/rewrite + source (2026-07-07)
app.use('/api/legislation', require('../../src/routes/legislation')); // DfE/Ofsted watcher (2026-07-07)
app.use('/api/data-governance', require('../../src/routes/data-governance'));
app.use('/api/data-requests', require('../../src/routes/data-subject-requests')); // PROMPT 46: GDPR subject-access + erasure queue
app.use('/api/gov-corpus', require('../../src/routes/gov-corpus')); // link-audit-20260522: was in parents/server.js, not migrated
app.use('/api/safeguarding-research', require('../../src/routes/safeguarding-research')); // P5: guarded web-research tool
app.use('/api/wellbeing', require('../../src/routes/wellbeing'));
app.use('/api/courses',  require('../../src/routes/courses'));
app.use('/api/review',   require('../../src/routes/review'));  // Review/autonomy queue (Phase 1 of 2031 vision)
app.use('/api/cockpit',  require('../../src/routes/cockpit')); // Management Cockpit (Roost) + Hermes-facing API

// ── Workflows (n8n templates) ─────────────────────────────────────────────────
try { app.use('/api/workflows', require('../../src/routes/workflows')); } catch(e) { console.error('workflows:', e.message); }

// ── Intelligence hub (n8n manager + SearXNG proxy) ───────────────────────────
try { app.use('/api/n8n-hub', require('../../src/routes/n8n-hub')); } catch(e) { console.error('n8n-hub:', e.message); }

// ── Backup (Layer 1/2/3 rclone-based) ────────────────────────────────────────
try { app.use('/api/backup', require('../../src/routes/backup')); } catch(e) { console.error('backup:', e.message); }

// ── Parent permissions matrix ─────────────────────────────────────────────────
try { app.use('/api/parent-permissions', require('../../src/routes/parent-permissions-matrix')); } catch(e) { console.error('parent-permissions:', e.message); }

// ── External API (Home Assistant / HACS) ─────────────────────────────────────
try {
  const { externalRouter, staffExternalRouter } = require('../../src/routes/external-api');
  app.use('/api/external', externalRouter);
  app.use('/api/external', staffExternalRouter);
} catch(e) { console.error('external-api:', e.message); }

// ── GIAS school lookup ────────────────────────────────────────────────────────
try { app.use('/api/gias', require('../../src/routes/gias')); } catch(e) { console.error('gias:', e.message); }

// ── Staff contracts & handbook ────────────────────────────────────────────────
app.use('/api/contracts', require('../../src/routes/contracts'));
app.use('/api/handbook',  require('../../src/routes/handbook'));

// ── Now Mode route ────────────────────────────────────────────────────────────
app.get('/now-mode', (req, res, next) => {
  if (req._portal === 'parents') return next();
  const p = req._portal === 'admin' ? '../admin' : req._portal === 'hr' ? '../hr' : '.';
  const base = require('path').join(__dirname, p, 'public/now-mode.html');
  const fallback = require('path').join(__dirname, 'public/now-mode.html');
  const fs = require('fs');
  res.sendFile(fs.existsSync(base) ? base : fallback);
});

// ── Admin: security cron (runs once at startup) ───────────────────────────────
try { require('../../src/security/runner').startCron(); } catch (e) { console.error('security cron:', e.message); }

// ── Admin: TOTP / edition endpoint ───────────────────────────────────────────
app.get('/api/edition', (req, res) => res.json({
  edition: req._portal || 'learning',
  schema: SCHEMA,
  demo: false,
  device_enforce: process.env.DEVICE_ENFORCE || 'false',
}));

// ── HR: client-side security alert ───────────────────────────────────────────
app.post('/api/security-alert', (req, res) => {
  const { alert_type, expected_edition, actual_edition, path: reqPath, details } = req.body || {};
  if (!alert_type) return res.status(400).json({ error: 'alert_type required' });
  const pool = require('../../src/db/pool').getPool();
  pool.query(
    `INSERT INTO ladn.security_alerts(alert_type,origin,expected_edition,actual_edition,path,ip,user_agent,details)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    ['hr_edition_mismatch', req.headers.origin || null, expected_edition || null,
     actual_edition || null, reqPath || null, req.ip,
     (req.headers['user-agent'] || '').substring(0, 200),
     details ? JSON.stringify(details) : null]
  ).catch(() => {});
  console.warn(`[HR-SECURITY] Client alert: ${alert_type} from ${req.ip}`);
  res.json({ ok: true });
});

// ── Vapi webhook (public, no auth) ───────────────────────────────────────────
app.use('/api/vapi/webhook', require('../../src/routes/vapi'));

// ── Insights ──────────────────────────────────────────────────────────────────
app.use('/api/insights', require('../../src/routes/insights'));

// ── Safeguarding extended (CPOMS-parity: chronology, audit chain, DSL workflow, reports, CTF) ──
app.use('/api/safeguarding-ext', require('../../src/routes/safeguarding-ext'));

// ── Risk assessments (Evolve standard: templates, hazards, sign-off, RIDDOR) ──
app.use('/api/risk-assessments', require('../../src/routes/risk-assessments'));

// ── COSHH register ────────────────────────────────────────────────────────────
app.use('/api/coshh',            require('../../src/routes/coshh'));

// ── Fire safety (drills, equipment log, summary) ──────────────────────────────
app.use('/api/fire-safety',      require('../../src/routes/fire-safety'));

// ── Inspection Mode ───────────────────────────────────────────────────────────
app.use('/api/inspection',       require('../../src/routes/inspection'));

// ── Document Updater & Merger ─────────────────────────────────────────────────
try { app.use('/api/documents/workspaces', require('../../src/routes/document-workspaces')); } catch(e) { console.error('document-workspaces:', e.message); }

// ── Regulatory feed watcher ────────────────────────────────────────────────────
try {
  app.use('/api/regulatory', require('../../src/routes/regulatory'));
  require('../../src/services/regulatory-feed-poller').startPoller();
  require('../../src/services/regulatory-alert-analyser').startAnalyser();
} catch(e) { console.error('regulatory:', e.message); }

// ── Unified Comms — contacts + AI helper (Phase 3) ───────────────────────────
app.use('/api/contacts',  require('../../src/routes/contacts'));
app.use('/api/ai-helper', require('../../src/routes/ai-helper'));

// ── Google Calendar (Phase 5) ─────────────────────────────────────────────────
try { app.use('/api/google-cal', require('../../src/routes/google-cal')); } catch(e) { console.error('google-cal:', e.message); }

// ── Vapi workers (Phase 4) ────────────────────────────────────────────────────
try { require('../../src/workers/vapi-audio-pull').startCron(); } catch(e) { console.error('vapi-audio-pull:', e.message); }
try { require('../../src/workers/vapi-daily-digest').startCron(); } catch(e) { console.error('vapi-daily-digest:', e.message); }

// ── Doorbell intercom (LADN only) ─────────────────────────────────────────────
const { router: intercomRouter, haWebhookRouter: intercomWebhookRouter, attachIntercomWS } = require('../../src/routes/intercom');
app.use('/api/intercom', intercomRouter);
app.use('/api/internal/ha-webhook', intercomWebhookRouter);
require('../../src/services/doorbell-listener').start();
require('../../src/services/ha-ladn').runDiscovery().catch(e => console.error('ha-ladn runDiscovery:', e.message));

// ── Learning: convenience aliases ────────────────────────────────────────────
app.get('/api/frameworks', (req, res, next) => {
  if (req._portal !== 'learning') return next();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/framework-versions.json'), 'utf8'));
    res.json(data);
  } catch { res.status(500).json({ error: 'Framework data unavailable' }); }
});

// ── Demo reset (learning only) ────────────────────────────────────────────────
app.post('/api/demo/reset', (req, res) => res.status(403).json({ error: 'Not a demo environment' }));

// ── Staff analytics (sickness patterns, manager/room_leader only) ─────────────
app.use('/api/staff-analytics', require('../../src/routes/staff-analytics'));

// ── Native AI assistant module (Prompt 40 — replaces dead OpenWebUI). Manager-only. ──
app.use('/api/assistant', require('../../src/routes/assistant'));

// ── PII Sanitiser (Prompt s02) — strips identifying data before cloud AI. Any staff. ──
app.use('/api/sanitiser', require('../../src/routes/sanitiser'));

// ── Website Builder (2026-07-12) — GrapesJS editor for the public nursery site. Manager/deputy only. ──
try { app.use('/api/website-builder', require('../../src/routes/website-builder')); } catch (e) { console.error('website-builder:', e.message); }

// ── Web Push subscriptions (Prompt s10) — VAPID key (public) + subscribe/unsubscribe (auth). ──
// VAPID public key must be accessible before login, so mount it first without auth
app.get('/api/push/vapid-public-key', (req, res) => {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  if (!publicKey) return res.status(503).json({ error: 'web_push_not_configured' });
  res.json({ publicKey });
});
// All other /api/push endpoints require authentication
app.use('/api/push', require('../../src/middleware/auth'), require('../../src/routes/push'));

// ── Framework statements alias (EY app shell uses /api/framework-statements) ──
// Maps short framework names (EYFS, B25…) to internal DB keys and proxies to
// the observations/statements catalogue endpoint logic.
const _FRAMEWORK_MAP = {
  EYFS: 'eyfs_statutory', B25: 'birth_to_5',
  CFE: 'development_matters', COEL: 'coel',
  // P4 multi-framework parity: SEND now has its own seeded set (was aliasing EYFS),
  // plus Leuven (wellbeing/involvement) and Phonics (Letters & Sounds).
  SEND: 'send', Leuven: 'leuven', Phonics: 'phonics',
  EYDJ: 'eydj', DM: 'development_matters',
  // Full EyLog developmental milestones (area → aspect → age_band → statement)
  EyLog: 'eylog_dev_matters', DevMatters: 'eylog_dev_matters',
};
const _authenticate = require('../../src/middleware/auth');
app.get('/api/framework-statements', _authenticate, async (req, res) => {
  const fw    = _FRAMEWORK_MAP[req.query.framework] || req.query.framework || 'eyfs_statutory';
  const area  = req.query.area  || null;
  const q     = req.query.q     || null;
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const db    = require('../../src/db/pool').getPool();
  const params = [fw];
  let sql = "SELECT id,framework,area,aspect,age_range,statement_code,statement_text,ordinal FROM framework_statements WHERE framework=$1 AND statement_text NOT LIKE '(stub%'";
  if (area) { params.push(area); sql += ` AND area=$${params.length}`; }
  if (q)    { params.push(q);    sql += ` AND (statement_text ILIKE '%'||$${params.length}||'%' OR area ILIKE '%'||$${params.length}||'%' OR aspect ILIKE '%'||$${params.length}||'%')`; }
  sql += ` ORDER BY framework, ordinal, id LIMIT $${params.length + 1}`;
  params.push(limit);
  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Service worker ────────────────────────────────────────────────────────────
app.get('/sw.js', (req, res) => {
  // SW is EY-only (registration is isEY-gated). On EY the static file
  // editions/ladn/public/sw.js shadows this route; on admin/hr/parents there is no
  // SW, so 404 rather than installing an EY service worker on a non-EY portal.
  if (req._portal !== 'learning') return res.status(404).end();
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.send(`
const CACHE_NAME = 'wren-ey-v20260617';

// Versioned assets (css/js/images carry ?v= query strings) are cache-first.
// EY HTML pages are NOT listed here on purpose: they fall through to the
// network-first branch (fresh online, cached only as an offline-reload fallback)
// so a docker-cp deploy is never masked by a stale cached page.
const STATIC_RE = [/^\\/css\\//, /^\\/js\\//, /^\\/images\\//];

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Auth: network-only, never cache
  if (url.pathname.startsWith('/api/auth/')) return;

  const isStatic = STATIC_RE.some(p => p.test(url.pathname));
  const isApi    = url.pathname.startsWith('/api/');

  if (isStatic) {
    // Cache-first: shell assets load offline
    e.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetch(req).then(res => {
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return res;
        });
      })
    );
  } else {
    // Network-first: navigations + API — live data on online; cache fallback offline
    e.respondWith(
      fetch(req).then(res => {
        if (res && res.ok && !isApi) {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return res;
      }).catch(() => caches.match(req))
    );
  }
});
  `.trim());
});

// ── HR: Ealing Early Years Partnership (Padlet embed page, added 2026-07-13) ──
// Clean URL for editions/hr/public/ealing-partnership.html (also reachable via
// static /ealing-partnership.html and the /hr/:section catch-all).
app.get('/ealing-partnership', (req, res, next) => {
  if (req._portal !== 'hr') return next();
  res.sendFile(path.join(__dirname, '../hr/public/ealing-partnership.html'));
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, portal: req._portal, edition: 'ladn', schema: SCHEMA }));

// ── SPA catch-all (per portal) ────────────────────────────────────────────────
const _loginFiles = {
  admin:    path.join(__dirname, '../admin/public/login.html'),
  hr:       path.join(__dirname, '../hr/public/login.html'),
  parents:  path.join(__dirname, '../parents/public/login.html'),
  learning: path.join(__dirname, 'public/login.html'),
};

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(_loginFiles[req._portal || 'learning']);
});

const PORT = process.env.PORT || 3000;
const _httpServer = app.listen(PORT, () =>
  console.log(`Wren LADN Unified on :${PORT} (schema: ${SCHEMA}) — portals: admin|hr|parents|learning via hostname`)
);
// Attach WebSocket server for intercom (after listen so server is ready)
attachIntercomWS(_httpServer);
