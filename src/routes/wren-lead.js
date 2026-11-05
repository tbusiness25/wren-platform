// ─────────────────────────────────────────────────────────────────────────────
// Wren PRODUCT-SALES lead capture — getwren.co.uk "Register interest" form.
// UNAUTHENTICATED, rate-limited + honeypot. Mounted in server-unified.js BEFORE
// the auth/offsite gates (like public-enquiry).
//
// ⚠️ These are SOFTWARE SALES leads, NOT nursery admissions. They must NEVER land
// in enquiries (that is Your Nursery' own admissions pipeline). They go to a
// separate table: public.wren_leads.
//
// Two routers exported:
//   module.exports        → public POST /api/wren-lead   (mount pre-auth, no gate)
//   module.exports.admin  → manager-only GET / + PATCH /:id/status
//                           (mount at /api/wren-leads, alongside authed API routes)
//
// Append-only: does not touch any existing route.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const rateLimit = require('express-rate-limit');

const SETTING_TYPES = ['nursery', 'childminder', 'primary', 'secondary', 'MAT', 'other'];
const STATUSES = ['new', 'contacted', 'closed'];

// Lazy, idempotent table bootstrap — runs once per process on first use. Uses
// CREATE TABLE IF NOT EXISTS so it is safe on any DB the unified server connects
// to (wren prod, wren_dev). public schema (NOT ladn) keeps sales leads separate.
let _tableReady = false;
async function ensureTable(db) {
  if (_tableReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS public.wren_leads (
      id            bigserial PRIMARY KEY,
      name          text NOT NULL,
      email         text NOT NULL,
      org           text,
      setting_type  text,          -- nursery/childminder/primary/secondary/MAT/other
      setting_size  text,
      tier_interest text,
      message       text,
      source        text,          -- CTA / page that sent the lead
      page_url      text,
      user_agent    text,
      status        text NOT NULL DEFAULT 'new',   -- new/contacted/closed
      created_at    timestamptz NOT NULL DEFAULT now()
    )`);
  // 2026-10-09 — the leads are also a mailing list (Toby: "treat it as a mailing list").
  // They registered interest, so they start subscribed; unsubscribing is one form away.
  await db.query(`ALTER TABLE public.wren_leads ADD COLUMN IF NOT EXISTS subscribed boolean NOT NULL DEFAULT true`);
  await db.query(`ALTER TABLE public.wren_leads ADD COLUMN IF NOT EXISTS unsubscribed_at timestamptz`);
  await db.query(`ALTER TABLE public.wren_leads ADD COLUMN IF NOT EXISTS last_mailed_at timestamptz`);
  await db.query(`ALTER TABLE public.wren_leads ADD COLUMN IF NOT EXISTS mail_count integer NOT NULL DEFAULT 0`);
  await db.query(`CREATE TABLE IF NOT EXISTS public.wren_lead_mailings (
      id bigserial PRIMARY KEY, subject text NOT NULL, body text NOT NULL,
      recipients integer NOT NULL DEFAULT 0, lead_ids bigint[] NOT NULL DEFAULT '{}',
      created_by integer, created_at timestamptz NOT NULL DEFAULT now())`);
  _tableReady = true;
}

function clean(v, maxLen) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (!s) return null;
  // Strip control chars (incl CR/LF/tab), collapse whitespace, cap length.
  s = s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s{3,}/g, ' ').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s || null;
}

// ── Public router: POST /api/wren-lead (UNAUTHENTICATED) ──────────────────────
const { singleInstanceOnly } = require('../lib/tenant-guard');

// ── b264: SINGLE-INSTANCE BY DESIGN ──────────────────────────────────────────
// getwren_leads holds people who asked about buying Wren. That is Wren-the-company's
// sales pipeline, not a setting's data, and it must stay in one place — a lead
// captured while a prospect happens to be browsing the htps demo is still a lead for
// the same pipeline. b264 de-qualified the SQL here; this refusal is what stops the
// de-qualified version from silently opening a second pipeline in another schema.
const GUARD = singleInstanceOnly('wren-lead', "Wren's own product-sales leads");

const pub = express.Router();
pub.use(GUARD);
// 2026-10-20 (fix-feedback-voice): scoped to this router's own paths. Mounted at the app ROOT
// (server-unified.js, before the global express.json({limit:'20mb'})), an unscoped router.use(express.json)
// ran on EVERY request and, first parser wins, capped every JSON body in Wren at this limit — so
// every bug report with a screenshot (and any other JSON write over the cap) 413'd before auth.
pub.use(['/api/wren-lead', '/api/public'], express.json({ limit: '32kb' })); // scoped; server-level json runs after auth

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 8,                   // 8 submissions / IP / 10 min (behind trusted proxy)
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again shortly, or email info@getwren.co.uk.' },
});

pub.post('/api/wren-lead', limiter, async (req, res) => {
  const b = req.body || {};

  // Honeypot — hidden fields bots fill; humans leave blank. Pretend success.
  if (clean(b.company, 200) || clean(b.website_hp, 200)) {
    return res.status(201).json({ ok: true });
  }

  const name  = clean(b.name, 200);
  const email = clean(b.email, 320);
  if (!name || !email) {
    return res.status(400).json({ error: 'Your name and email are required.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const org = clean(b.org || b.organisation || b.setting, 200);

  let settingType = clean(b.setting_type || b.settingType, 40);
  if (settingType) {
    const m = SETTING_TYPES.find(t => t.toLowerCase() === settingType.toLowerCase());
    settingType = m || 'other';
  }

  const settingSize  = clean(b.setting_size || b.size, 120);
  const tierInterest = clean(b.tier || b.tier_interest, 120);
  const message      = clean(b.message, 4000);
  const source       = clean(b.source, 120) || 'wren_landing';
  const pageUrl      = clean(b.page_url || b.pageUrl, 300);
  const ua           = (req.headers['user-agent'] || '').slice(0, 300) || null;

  const db = require('../db/pool').getPool();
  try {
    await ensureTable(db);
    const { rows } = await db.query(
      `INSERT INTO public.wren_leads
         (name, email, org, setting_type, setting_size, tier_interest,
          message, source, page_url, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [name, email.toLowerCase(), org, settingType, settingSize, tierInterest,
       message, source, pageUrl, ua]
    );
    const id = rows[0].id;

    // Telegram ping (best-effort, non-blocking).
    const tgTok = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;
    if (tgTok && tgChat) {
      const txt = `🐦 *New Wren sales lead*\n`
        + `Name: ${name} <${email}>\n`
        + `${org ? 'Setting: ' + org + '\n' : ''}`
        + `${settingType ? 'Type: ' + settingType + '\n' : ''}`
        + `${settingSize ? 'Size: ' + settingSize + '\n' : ''}`
        + `${tierInterest ? 'Tier: ' + tierInterest + '\n' : ''}`
        + `Source: ${source}\n`
        + `${message ? '> ' + message.slice(0, 300) : ''}`;
      require('../lib/notifications').sendTelegramNow({ text: txt, parse_mode: 'Markdown' });
    }

    // 2026-10-09 (Toby: "no emails came into my inbox from Wren, why not?") — leads only
    // pinged Telegram. Also email toby@. Sent FROM staff@ so it lands in his Inbox (a send as
    // admin@, his own alias, files as Sent only). A Wren sales lead is a business contact
    // who asked to hear from us — this is an internal notice to Toby, not a parent email.
    try {
      const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const rowsHtml = [['Name', name], ['Email', email], ['Setting', org], ['Type', settingType], ['Size', settingSize],
        ['Interested in', tierInterest], ['Page', pageUrl], ['Message', message]]
        .filter(r => r[1]).map(r => `<tr><td style="padding:4px 12px 4px 0;color:#666">${r[0]}</td><td style="padding:4px 0"><b>${esc(r[1])}</b></td></tr>`).join('');
      require('../lib/gmail-sender').sendViaGmail({
        to: process.env.WREN_LEAD_NOTIFY_TO || 'toby@example-nursery.co.uk',
        from: 'staff@example-nursery.co.uk', fromName: 'Wren leads', replyTo: email,
        subject: `New Wren lead: ${org || name}${settingType ? ' (' + settingType + (settingSize ? ', ' + settingSize : '') + ')' : ''}`,
        html: `<div style="font-family:Arial,sans-serif;font-size:14px"><p>Someone registered interest on getwren.co.uk.</p><table>${rowsHtml}</table>
               <p style="color:#666;font-size:12px">Reply to this email to answer them directly. All leads: Roost → Comms → Wren sales leads.</p></div>`,
      }).catch(e => console.error('[wren-lead] email notify error:', e.message));
    } catch (e) { console.error('[wren-lead] email notify setup:', e.message); }

    return res.status(201).json({ ok: true, id });
  } catch (e) {
    console.error('[wren-lead]', e.message);
    return res.status(500).json({ error: 'Could not submit right now. Please email info@getwren.co.uk.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// getwren.co.uk LEAD + FEEDBACK capture → getwren_leads (2026-08-03).
// Additive, CORS-safe (the landing site is a different origin), honeypot + the
// same rate-limiter. Feedback may be anonymous (message only); leads need
// name+email. Nothing here touches child data — these are marketing-site rows.
//   POST /api/public/lead      kind='lead'
//   POST /api/public/feedback  kind='feedback'
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');

let _glReady = false;
async function ensureGetwrenLeads(db) {
  if (_glReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS getwren_leads (
      id               bigserial PRIMARY KEY,
      kind             text NOT NULL DEFAULT 'lead',   -- 'lead' | 'feedback'
      name             text,
      email            text,
      org              text,
      edition_interest text,                           -- eyfs/primary/secondary/MAT/…
      message          text,
      source_page      text,
      utm              jsonb,
      user_agent       text,
      ip_hash          text,
      created_at       timestamptz NOT NULL DEFAULT now(),
      handled_at       timestamptz
    )`);
  await db.query(`CREATE INDEX IF NOT EXISTS getwren_leads_kind_created_idx
                    ON getwren_leads (kind, created_at DESC)`);
  _glReady = true;
}

// One-way, salted hash of the caller IP — lets us spot spam bursts without
// storing a raw IP (GDPR-lean). Salt from env, static fallback so it still runs.
function ipHash(req) {
  const ip = (req.ip || req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim();
  if (!ip) return null;
  const salt = process.env.GETWREN_IP_SALT || 'getwren-static-salt-v1';
  return crypto.createHash('sha256').update(salt + ip).digest('hex').slice(0, 32);
}

// Collect UTM/referrer info from an explicit object, utm_* fields, or the
// source_page query string. Returns a jsonb-ready object or null.
function parseUtm(b) {
  const out = {};
  if (b && typeof b.utm === 'object' && b.utm) {
    for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
      const v = clean(b.utm[k], 200); if (v) out[k] = v;
    }
  }
  for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
    const v = clean(b['utm_' + k], 200); if (v && !out[k]) out[k] = v;
  }
  const ref = clean(b && (b.referrer || b.ref), 300);
  if (ref) out.referrer = ref;
  const pageUrl = clean(b && (b.source_page || b.page_url || b.pageUrl), 500);
  if (pageUrl) {
    try {
      const u = new URL(pageUrl);
      for (const k of ['source', 'medium', 'campaign', 'term', 'content']) {
        const v = u.searchParams.get('utm_' + k); if (v && !out[k]) out[k] = clean(v, 200);
      }
    } catch (_) {}
  }
  return Object.keys(out).length ? out : null;
}

// Shared CORS headers for the cross-origin landing site.
function cors(res) {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
}
pub.options(['/api/public/lead', '/api/public/feedback'], (req, res) => { cors(res); res.status(204).end(); });

async function insertGetwren(kind, req, res) {
  cors(res);
  const b = req.body || {};
  // Honeypot — silent success so bots learn nothing.
  if (clean(b.company, 200) || clean(b.website_hp, 200)) return res.status(201).json({ ok: true });

  const name    = clean(b.name, 200);
  const email   = clean(b.email, 320);
  const org     = clean(b.org || b.organisation || b.setting, 200);
  const edition = clean(b.edition_interest || b.edition || b.setting_type || b.tier, 120);
  const message = clean(b.message || b.feedback, 4000);

  if (kind === 'lead') {
    if (!name || !email) return res.status(400).json({ error: 'Your name and email are required.' });
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  } else { // feedback
    if (!message) return res.status(400).json({ error: 'Please enter your feedback.' });
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const sourcePage = clean(b.source_page || b.page_url || b.pageUrl, 500);
  const utm = parseUtm(b);
  const ua  = (req.headers['user-agent'] || '').slice(0, 300) || null;

  const db = require('../db/pool').getPool();
  try {
    await ensureGetwrenLeads(db);
    const { rows } = await db.query(
      `INSERT INTO getwren_leads
         (kind, name, email, org, edition_interest, message, source_page, utm, user_agent, ip_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [kind, name, email ? email.toLowerCase() : null, org, edition, message,
       sourcePage, utm ? JSON.stringify(utm) : null, ua, ipHash(req)]
    );
    const id = rows[0].id;

    // Telegram ping (best-effort, non-blocking).
    const tgTok = process.env.TELEGRAM_BOT_TOKEN, tgChat = process.env.TELEGRAM_CHAT_ID;
    if (tgTok && tgChat) {
      const head = kind === 'feedback' ? '💬 *New getwren feedback*' : '🐦 *New getwren lead*';
      const txt = `${head}\n`
        + `${name ? 'Name: ' + name + (email ? ' <' + email + '>' : '') + '\n' : (email ? 'Email: ' + email + '\n' : '')}`
        + `${org ? 'Setting: ' + org + '\n' : ''}`
        + `${edition ? 'Interest: ' + edition + '\n' : ''}`
        + `${sourcePage ? 'Page: ' + sourcePage + '\n' : ''}`
        + `${message ? '> ' + message.slice(0, 300) : ''}`;
      require('../lib/notifications').sendTelegramNow({ text: txt, parse_mode: 'Markdown' });
    }
    return res.status(201).json({ ok: true, id });
  } catch (e) {
    console.error('[getwren-lead:' + kind + ']', e.message);
    return res.status(500).json({ error: 'Could not submit right now. Please email info@getwren.co.uk.' });
  }
}

// 2026-10-09 — unsubscribe from Wren update emails (getwren.co.uk/unsubscribe.html posts here).
// Same answer whether or not the address is on the list, so it can't be used to test addresses.
pub.post('/api/wren-lead/unsubscribe', limiter, async (req, res) => {
  const email = clean((req.body || {}).email, 320);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  try {
    const db = require('../db/pool').getPool();
    await ensureTable(db);
    await db.query(`UPDATE public.wren_leads SET subscribed = false, unsubscribed_at = COALESCE(unsubscribed_at, now())
                     WHERE lower(email) = lower($1)`, [email]);
    return res.json({ ok: true });
  } catch (e) { console.error('[wren-lead] unsubscribe:', e.message); return res.status(500).json({ error: 'Please try again, or reply to any Wren email with "unsubscribe".' }); }
});
pub.post('/api/public/lead',     limiter, (req, res) => insertGetwren('lead', req, res));
pub.post('/api/public/feedback', limiter, (req, res) => insertGetwren('feedback', req, res));

// ── Admin router: manager-only list + status toggle ───────────────────────────
// Mount at /api/wren-leads, alongside the other authed API routers. requireRole
// already bundles authenticate (see src/middleware/auth.js), so applying it at the
// router level gates every route here to a valid manager/deputy token.
const { requireRole } = require('../middleware/auth');

const admin = express.Router();
admin.use(GUARD);
admin.use(requireRole('manager', 'deputy_manager'));

// GET /api/wren-leads — newest first
admin.get('/', async (req, res) => {
  try {
    const db = require('../db/pool').getPool();
    await ensureTable(db);
    const { rows } = await db.query(
      `SELECT id, name, email, org, setting_type, setting_size, tier_interest,
              message, source, page_url, status, created_at, subscribed, last_mailed_at, mail_count
         FROM public.wren_leads
        ORDER BY created_at DESC
        LIMIT 500`
    );
    const counts = { new: 0, contacted: 0, closed: 0 };
    for (const r of rows) if (counts[r.status] !== undefined) counts[r.status]++;
    res.json({ leads: rows, counts, total: rows.length });
  } catch (e) {
    console.error('[wren-leads:list]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// PATCH /api/wren-leads/:id/status  { status: new|contacted|closed }
// ── Mailing list (2026-10-09) ────────────────────────────────────────────────
// Toby sends from his getwren address, which lives on his personal Google account, so Wren
// can't send it: Wren keeps the list and the wording, opens a BCC compose in Gmail, and
// records the mailing when he says it's sent.
admin.get('/mailing', async (req, res) => {
  try {
    const db = require('../db/pool').getPool();
    await ensureTable(db);
    const { rows: subs } = await db.query(`SELECT id, name, email, org FROM public.wren_leads
      WHERE subscribed AND email IS NOT NULL ORDER BY created_at`);
    // one address once, even if they registered twice
    const seen = new Set(); const recipients = subs.filter(r => { const k = String(r.email).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    const { rows: mailings } = await db.query(`SELECT id, subject, recipients, created_at FROM public.wren_lead_mailings ORDER BY created_at DESC LIMIT 10`);
    const { rows: [u] } = await db.query(`SELECT count(*)::int AS n FROM public.wren_leads WHERE NOT subscribed`);
    res.json({ recipients, mailings, unsubscribed: u.n });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
admin.post('/mailing/sent', express.json({ limit: '64kb' }), async (req, res) => {
  const subject = clean((req.body || {}).subject, 300);
  const body = String((req.body || {}).body || '').slice(0, 20000);
  const ids = [].concat((req.body || {}).lead_ids || []).map(n => parseInt(n, 10)).filter(Number.isInteger);
  if (!subject || !body.trim() || !ids.length) return res.status(400).json({ error: 'subject, body and lead_ids required' });
  try {
    const db = require('../db/pool').getPool();
    await ensureTable(db);
    const { rows: [m] } = await db.query(`INSERT INTO public.wren_lead_mailings (subject, body, recipients, lead_ids, created_by)
      VALUES ($1, $2, $3, $4::bigint[], $5) RETURNING id`, [subject, body, ids.length, ids, req.user && req.user.id]);
    await db.query(`UPDATE public.wren_leads SET last_mailed_at = now(), mail_count = mail_count + 1,
                           status = CASE WHEN status = 'new' THEN 'contacted' ELSE status END
                     WHERE id = ANY($1::bigint[]) AND subscribed`, [ids]);
    res.json({ ok: true, id: m.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
admin.patch('/:id/subscribed', express.json({ limit: '1kb' }), async (req, res) => {
  try {
    const on = !!(req.body && req.body.subscribed);
    const { rowCount } = await require('../db/pool').getPool().query(
      `UPDATE public.wren_leads SET subscribed = $2, unsubscribed_at = CASE WHEN $2 THEN NULL ELSE COALESCE(unsubscribed_at, now()) END WHERE id = $1`,
      [req.params.id, on]);
    res.json({ ok: rowCount > 0 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

admin.patch('/:id/status', express.json({ limit: '4kb' }), async (req, res) => {
  const st = String((req.body || {}).status || '').toLowerCase();
  if (!STATUSES.includes(st)) return res.status(400).json({ error: 'Invalid status' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  try {
    const db = require('../db/pool').getPool();
    const { rowCount } = await db.query(
      `UPDATE public.wren_leads SET status=$1 WHERE id=$2`, [st, id]
    );
    if (!rowCount) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error('[wren-leads:status]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = pub;
module.exports.admin = admin;
