// ─────────────────────────────────────────────────────────────────────────────
// Public website enquiry endpoint — UNAUTHENTICATED, rate-limited.
// Mounted in editions/ladn/server-unified.js BEFORE the auth-gated routes.
// Target of the Little Angels public website registration form (via same-origin
// /api/enquiry nginx proxy on the nursery-website container).
//
// Inserts into enquiries with source='website', stage='new', status='new'.
// Append-only: does NOT touch the existing /api/public-enquiry endpoint.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Body parser scoped to this router (server-level express.json runs later, after auth)
router.use(express.json({ limit: '32kb' }));

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

  const db = require('../db/pool').getPool();
  try {
    const { rows } = await db.query(
      `INSERT INTO enquiries
         (child_first_name, child_last_name, child_dob,
          room_needed, preferred_room, preferred_days,
          start_date_requested, preferred_start_date,
          parent_name, parent_email, parent_phone,
          funded_hours_type, heard_about,
          source, stage, status, notes, message)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$6,$7,$8,$9,$10,$11,'website','new','new',$12,$12)
       RETURNING id`,
      [childFirst, childLast, childDob,
       preferredRoom, preferredDays,
       startReq,
       parentName, parentEmail.toLowerCase(), parentPhone,
       fundedHours, heardAbout,
       notesFull]
    );
    const enquiryId = rows[0].id;

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
      fetch(`https://api.telegram.org/bot${tgTok}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgChat, text: tgText, parse_mode: 'Markdown' }),
      }).catch(e => console.error('[public-enquiry] tg ping error:', e.message));
    }

    return res.status(201).json({ ok: true, id: enquiryId });
  } catch (e) {
    console.error('[public-enquiry]', e.message);
    return res.status(500).json({ error: 'Failed to submit enquiry. Please call or email us.' });
  }
});

module.exports = router;
