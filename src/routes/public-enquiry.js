// ─────────────────────────────────────────────────────────────────────────────
// Public website enquiry endpoint — UNAUTHENTICATED, rate-limited.
// Mounted in editions/ladn/server-unified.js BEFORE the auth-gated routes.
// Target of the Your Nursery public website registration form (via same-origin
// /api/enquiry nginx proxy on the nursery-website container).
//
// Inserts into enquiries with source='website', stage='new', status='new'.
// Append-only: does NOT touch the existing /api/public-enquiry endpoint.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Body parser scoped to this router (server-level express.json runs later, after auth)
// 2026-10-20: scoped to this router's own path. Unscoped, it ran on EVERY request (the router is mounted
// at the app root) and 413'd Vapi's 55-87KB tool-call bodies, so James never told Toby about calls.
router.use('/api/enquiry', express.json({ limit: '32kb' }));

// Simple anti-spam: cap submissions per IP. Behind nginx/Cloudflare we trust the
// proxy chain (app.set('trust proxy', 1) is set in server-unified.js).
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  max: 8,                   // 8 enquiries / IP / 10 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many enquiries. Please try again later.' },
});

function clean(v, maxLen) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (!s) return null;
  // Strip control chars (incl. CR/LF/tab), collapse runs of whitespace, cap length
  s = s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s{3,}/g, ' ').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s || null;
}

function cleanDate(v) {
  const s = clean(v, 20);
  if (!s) return null;
  // Expect YYYY-MM-DD from <input type=date>
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

// ── b265: the registration permissions ───────────────────────────────────────
// Toby: "The point is that parents are aware of it before starting and know what
// type of nursery we are. IE child first." So the permissions are answered on
// the enquiry form, before anyone starts, and parked on the enquiry until a
// child row exists — enquiry-portal.js writes them into child_consents then.
//
// Shape from the form: { permissions: { "<consent_type>": true|false } }
// Only known keys survive, and only real booleans: a key we do not recognise,
// or an unanswered optional item, is dropped rather than guessed at.
const PERMS = require('../lib/child-permissions');

function cleanPermissions(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out = {};
  for (const [k, raw] of Object.entries(v)) {
    if (!PERMS.TYPE_KEYS.has(k)) continue;
    if (raw === true || raw === 'true' || raw === 'yes' || raw === 1) out[k] = true;
    else if (raw === false || raw === 'false' || raw === 'no' || raw === 0) out[k] = false;
    // anything else (null, '', undefined) = the family did not answer. Leave it out.
  }
  return Object.keys(out).length ? out : null;
}

// enquiries.permissions is added by scripts/b265-consent-schema.sql. This route
// also runs on tenants and demo schemas that have not had it applied yet, and a
// public enquiry form failing to submit is far worse than a permissions block
// not being stored — so check once, then use the shape that actually exists.
let _hasPermsCol = null;
async function hasPermissionsColumn(db) {
  if (_hasPermsCol !== null) return _hasPermsCol;
  try {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.columns
        WHERE table_name='enquiries' AND column_name='permissions'
          AND table_schema = ANY(current_schemas(false)) LIMIT 1`);
    _hasPermsCol = rows.length > 0;
  } catch { _hasPermsCol = false; }
  if (!_hasPermsCol) console.warn('[public-enquiry] enquiries.permissions missing — b265 permissions not stored');
  return _hasPermsCol;
}

// Normalise preferred_days into a text[] for the enquiries.preferred_days column.
function cleanDays(v) {
  if (!v) return null;
  let arr;
  if (Array.isArray(v)) arr = v;
  else arr = String(v).split(',');
  arr = arr.map(x => clean(x, 40)).filter(Boolean).slice(0, 12);
  return arr.length ? arr : null;
}

router.post('/api/enquiry', limiter, async (req, res) => {
  const b = req.body || {};

  // Honeypot — a hidden field bots will fill; humans leave blank.
  if (clean(b.company, 200) || clean(b.website_hp, 200)) {
    // Pretend success so bots do not learn the trap.
    return res.status(201).json({ ok: true });
  }

  const parentName  = clean(b.parent_name, 200);
  const parentEmail = clean(b.parent_email, 320);
  const parentPhone = clean(b.parent_phone, 50);

  if (!parentName || !parentEmail) {
    return res.status(400).json({ error: 'Your name and email are required.' });
  }
  // b532 (Toby, 28 Oct) — the nursery needs a number to call back on.
  if (String(parentPhone || '').replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'Please enter a phone number we can call you on.' });
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parentEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const childFirst   = clean(b.child_first_name, 120);
  const childLast    = clean(b.child_last_name, 120);
  const childDob     = cleanDate(b.child_dob);
  const startReq     = cleanDate(b.start_date_requested || b.preferred_start_date);

  // Room — normalise to Baby Room / Pre-school
  let preferredRoom = clean(b.preferred_room || b.room, 60);
  if (preferredRoom) {
    const r = preferredRoom.toLowerCase();
    if (r.includes('baby')) preferredRoom = 'Baby Room';
    else if (r.includes('pre')) preferredRoom = 'Pre-school';
  }

  const preferredDays = cleanDays(b.preferred_days || b.preferred_session || b.session);
  const notes         = clean(b.notes || b.message, 4000);

  // Funded-hours type — accept 15h / 30h / 2yr / none (matches admin pipeline values)
  let fundedHours = clean(b.funded_hours_type || b.funded_hours || b.funded, 40);
  if (fundedHours && fundedHours.toLowerCase() === 'none') fundedHours = null;

  // "How did you hear about us?" — captured EyLog-parity, distinct from source='website'
  const heardAbout = clean(b.heard_about || b.source_detail || b.how_heard || b.heard, 120);

  // Custom fields (admin-added via Settings → Enquiry Form) arrive as custom_* keys.
  // Append them to notes so nothing a parent entered is lost.
  const customLines = Object.keys(b)
    .filter(k => /^custom_/.test(k))
    .map(k => {
      const v = Array.isArray(b[k]) ? b[k].map(x => clean(x, 200)).filter(Boolean).join(', ') : clean(b[k], 500);
      return v ? `${k.replace(/^custom_/, '').replace(/_/g, ' ')}: ${v}` : null;
    })
    .filter(Boolean);
  const notesFull = customLines.length ? [notes, ...customLines].filter(Boolean).join('\n') : notes;

  // b265 — the permissions the family answered on the form, if the form showed
  // them. `permissions_ack` is the box confirming they read the block; without
  // it we still record the answers but do not claim they were acknowledged.
  const permissions = cleanPermissions(b.permissions);
  const permsAck = b.permissions_ack === true || b.permissions_ack === 'yes' || b.permissions_ack === 'true';

  const db = require('../db/pool').getPool();
  try {
    const withPerms = await hasPermissionsColumn(db);
    const baseCols = `child_first_name, child_last_name, child_dob,
          room_needed, preferred_room, preferred_days,
          start_date_requested, preferred_start_date,
          parent_name, parent_email, parent_phone,
          funded_hours_type, heard_about,
          source, stage, status, notes, message,
          enquiry_submitted_at, enquiry_date_source`;
    const baseVals = `$1,$2,$3,$4,$4,$5,$6,$6,$7,$8,$9,$10,$11,'website','new','new',$12,$12,now(),'enquiry'`;
    const params = [childFirst, childLast, childDob,
       preferredRoom, preferredDays,
       startReq,
       parentName, parentEmail.toLowerCase(), parentPhone,
       fundedHours, heardAbout,
       notesFull];
    if (withPerms) params.push(permissions ? JSON.stringify(permissions) : null, permsAck);
    const { rows } = await db.query(
      `INSERT INTO enquiries (${baseCols}${withPerms ? ', permissions, permissions_agreed_at' : ''})
       VALUES (${baseVals}${withPerms ? ", $13::jsonb, CASE WHEN $14::boolean THEN now() ELSE NULL END" : ''})
       RETURNING id`, params);
    const enquiryId = rows[0].id;

    // b399 (2026-10-06) — enquiry mode + the acknowledgement email. Both
    // best-effort and never block the submit: the family's "thank you" above
    // only needs { ok:true, id } to already be true by the time either runs.
    (async () => {
      try {
        const { rows: s } = await db.query(
          `SELECT key, value FROM settings WHERE key IN ('enquiry_app_mode_enabled','enquiry_ack_email_enabled')`);
        const cfg = Object.fromEntries(s.map(r => [r.key, r.value]));
        const appModeOn = cfg.enquiry_app_mode_enabled !== 'false';
        if (appModeOn && parentEmail) {
          await require('../lib/enquiry-access').grantEnquiryAccess(db, { enquiryId }, { publicForm: true });
        }
        const ackOn = cfg.enquiry_ack_email_enabled !== 'false';
        if (ackOn) {
          await require('../lib/enquiry-ack-email').sendEnquiryAcknowledgement(db, enquiryId, { enquiryModeOn: appModeOn });
        }
      } catch (e) { console.error('[public-enquiry] b399 ack/grant error:', e.message); }
    })();

    // Telegram ping (best-effort, non-blocking)
    const tgTok = process.env.TELEGRAM_BOT_TOKEN;
    const tgChat = process.env.TELEGRAM_CHAT_ID;
    if (tgTok && tgChat) {
      const childLabel = childFirst ? `${childFirst} ${childLast || ''}`.trim() : '(child not named)';
      const tgText = `🏫 *New website enquiry*\n`
        + `Parent: ${parentName} <${parentEmail}>${parentPhone ? '\nPhone: ' + parentPhone : ''}\n`
        + `Child: ${childLabel}${childDob ? ' (DOB ' + childDob + ')' : ''}\n`
        + `${preferredRoom ? 'Room: ' + preferredRoom + '\n' : ''}`
        + `${preferredDays ? 'Days: ' + preferredDays.join(', ') + '\n' : ''}`
        + `${startReq ? 'Start: ' + startReq + '\n' : ''}`
        + `${notes ? '> ' + notes.slice(0, 200) : ''}`;
      // login-20261023: through the one Telegram sender (src/lib/notifications.js), which carries the dev guard.
      require('../lib/notifications').sendTelegramNow({ text: tgText, parse_mode: 'Markdown' });
    }

    // Email ping too (Toby 2026-07-28: "when there's a new enquiry I want email
    // notification as well"). Best-effort, non-blocking, never fails the submit.
    try {
      const { sendViaGmail } = require('../lib/gmail-sender');
      const to = process.env.ENQUIRY_NOTIFY_EMAIL || 'toby@example-nursery.co.uk';
      const childLabel2 = childFirst ? `${childFirst} ${childLast || ''}`.trim() : '(child not named)';
      const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      sendViaGmail({
        to,
        subject: `New enquiry — ${childLabel2} (${parentName})`,
        html: `<h3>New website enquiry #${enquiryId}</h3>
<table cellpadding="4" style="font-family:Arial,sans-serif;font-size:14px">
<tr><td><b>Parent</b></td><td>${esc(parentName)} &lt;${esc(parentEmail)}&gt;${parentPhone ? ' · ' + esc(parentPhone) : ''}</td></tr>
<tr><td><b>Child</b></td><td>${esc(childLabel2)}${childDob ? ' (DOB ' + esc(childDob) + ')' : ''}</td></tr>
${preferredRoom ? `<tr><td><b>Room</b></td><td>${esc(preferredRoom)}</td></tr>` : ''}
${preferredDays ? `<tr><td><b>Days</b></td><td>${esc(preferredDays.join(', '))}</td></tr>` : ''}
${startReq ? `<tr><td><b>Start</b></td><td>${esc(startReq)}</td></tr>` : ''}
${notes ? `<tr><td valign="top"><b>Notes</b></td><td>${esc(notes).slice(0, 1000)}</td></tr>` : ''}
</table>
<p><a href="https://admin.example-nursery.co.uk/admin/admissions/pipeline">Open Admissions pipeline →</a></p>`,
      }).catch(e => console.error('[public-enquiry] email ping error:', e.message));
    } catch (e) { console.error('[public-enquiry] email ping setup error:', e.message); }

    return res.status(201).json({ ok: true, id: enquiryId });
  } catch (e) {
    console.error('[public-enquiry]', e.message);
    return res.status(500).json({ error: 'Failed to submit enquiry. Please call or email us.' });
  }
});

module.exports = router;
