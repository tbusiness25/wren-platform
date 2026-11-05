const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');

const N8N_WEBHOOK = 'https://n8n.example-nursery.co.uk/webhook/away-mode-changed';
const mailer = require('../lib/gmail-sender');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// Toby's real mailbox (Groups can't hold a vacation responder). Overridable per-request.
// admin@/admissions@/wren@ etc. are ALIASES of this mailbox, so a single OOO here covers them all.
const OOO_MAILBOX = process.env.AWAY_OOO_MAILBOX || 'toby@example-nursery.co.uk';
// Where the OOO/staff-email tells people to go for cover. Must be a mailbox the DEPUTY
// actually reads (the deputy = staff@). NOT admissions@/admin@ — those are toby@ aliases and
// go unmonitored while away. Change to info@ if the deputy is a member of that group.
const COVER_EMAIL = process.env.AWAY_COVER_EMAIL || 'staff@example-nursery.co.uk';
// The shared nursery inbox behind info@ (a Group that delivers here). Away Mode sets a
// SECOND out-of-office on it — "we're on ratio, monitoring less, urgent → call & ask for
// the deputy" — so info@/staff@ and toby@ go on/off together with the set_ooo toggle.
const INFO_MAILBOX = process.env.AWAY_INFO_MAILBOX || 'staff@example-nursery.co.uk';

// Apply the away side-effects: set/clear Toby's out-of-office, and (on activation)
// email the team. All best-effort — never throws; returns a result summary.
async function applyAwaySideEffects(db, state, opts = {}) {
  const out = { ooo: { attempted: false }, staff: { attempted: false } };
  // Resolve the cover person (the deputy) — name, role, room — for the wording.
  let cover = null;
  try {
    const { rows } = await db.query(
      `SELECT s.first_name, s.last_name, s.role, r.name AS room_name
         FROM staff s LEFT JOIN rooms r ON r.id = s.room_id WHERE s.id = $1`, [state.cover_person_id]);
    if (rows.length) {
      const r = rows[0];
      cover = { first: r.first_name, name: `${r.first_name || ''} ${r.last_name || ''}`.trim(),
                role: (r.role || 'deputy manager').replace(/_/g, ' '), room: r.room_name || 'Baby Room' };
    }
  } catch (_) {}
  const rd = state.return_date ? new Date(state.return_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : null;
  const coverLine = cover
    ? `In the meantime, please speak to ${cover.name}, our ${cover.role}${cover.room ? ` in the ${cover.room}` : ''}.`
    : 'In the meantime, please speak to the deputy manager.';

  // 1) Out-of-office on Toby's mailbox — gated by the persisted set_ooo toggle
  if (state.set_ooo !== false && mailer.isConfigured()) {
    out.ooo.attempted = true;
    try {
      if (state.active) {
        const html = `<p>Thank you for your email.</p><p>Nursery Manager is currently on annual leave${rd ? ` and will be back on <strong>${rd}</strong>` : ''}. ${coverLine}</p>`
          + `<p>For anything urgent, please call the nursery on 020 7946 0000 or email <a href="mailto:${COVER_EMAIL}">${COVER_EMAIL}</a>${cover ? ` (${cover.first}, our ${cover.role})` : ''}.</p><p>Your Nursery</p>`;
        const text = `Thank you for your email. Nursery Manager is on annual leave${rd ? ` and will be back on ${rd}` : ''}. ${coverLine} For anything urgent please call 020 7946 0000 or email ${COVER_EMAIL}${cover ? ` (${cover.first}, our ${cover.role})` : ''}.`;
        await mailer.setVacationResponder({ mailbox: opts.ooo_mailbox || OOO_MAILBOX, enable: true,
          subject: `Out of office${rd ? ` — back ${rd}` : ''}`, html, text });
      } else {
        await mailer.setVacationResponder({ mailbox: opts.ooo_mailbox || OOO_MAILBOX, enable: false });
      }
      out.ooo.set = state.active;
    } catch (e) {
      out.ooo.error = mailer.isAuthScopeError && mailer.isAuthScopeError(e)
        ? 'Google SA lacks the gmail.settings.basic scope — add it in Workspace admin (Domain-wide delegation), then re-toggle.'
        : e.message;
    }

    // 1b) Shared nursery inbox (info@ → staff@) — a general "we're on ratio, monitoring
    // less" responder, set/cleared together with Toby's so both track Away Mode.
    if (INFO_MAILBOX && INFO_MAILBOX.toLowerCase() !== (opts.ooo_mailbox || OOO_MAILBOX).toLowerCase()) {
      out.info_ooo = { attempted: true };
      try {
        if (state.active) {
          const who = cover ? cover.first : 'the deputy manager';
          const where = cover && cover.room ? `the ${cover.room}` : 'the Baby Room';
          const html = `<p>Thank you for your email.</p>`
            + `<p>Our manager is currently away${rd ? ` (back on <strong>${rd}</strong>)` : ''}, and as our team are working directly with the children (on ratio), we are checking email less often than usual — so replies may take a little longer than normal.</p>`
            + `<p><strong>If your message is urgent, please call the nursery on 020 7946 0000 and ask for ${who} in ${where}.</strong> Otherwise, someone will get back to you as soon as we can.</p>`
            + `<p>Thank you for your patience,<br>Your Nursery</p>`;
          const text = `Thank you for your email. Our manager is currently away${rd ? ` (back on ${rd})` : ''}, and as our team are working directly with the children (on ratio), we are checking email less often than usual, so replies may take a little longer. If your message is urgent please call the nursery on 020 7946 0000 and ask for ${who} in ${where}. Otherwise someone will get back to you as soon as we can. Your Nursery.`;
          await mailer.setVacationResponder({ mailbox: INFO_MAILBOX, enable: true,
            subject: 'Your Nursery — we are monitoring email less right now', html, text });
        } else {
          await mailer.setVacationResponder({ mailbox: INFO_MAILBOX, enable: false });
        }
        out.info_ooo.set = state.active;
      } catch (e) { out.info_ooo.error = e.message; }
    }
  }

  // 2) Notify the team (activation only) — gated by the persisted email_team toggle
  if (state.active && state.email_team !== false && mailer.isConfigured()) {
    out.staff.attempted = true;
    try {
      const { rows: staff } = await db.query(
        `SELECT email FROM staff WHERE is_active=true AND email IS NOT NULL AND email<>'' AND id <> 1`);
      const to = staff.map(s => s.email).filter(Boolean);
      if (to.length) {
        const html = `<p>Hi team,</p><p>Toby is on annual leave${rd ? ` and will be back on <strong>${rd}</strong>` : ''}. `
          + `While he's away, ${cover ? `<strong>${cover.name}</strong> (${cover.role}${cover.room ? `, ${cover.room}` : ''})` : 'the deputy manager'} is covering — please go to ${cover ? cover.first : 'the deputy'} for anything you'd normally bring to Toby.</p><p>Thanks!</p>`;
        await mailer.sendViaGmail({ to: OOO_MAILBOX, bcc: to, subject: `Toby is on leave${rd ? ` (back ${rd})` : ''} — ${cover ? cover.first : 'deputy'} is covering`,
          html, fromName: 'Your Nursery' });
        out.staff.sent = to.length;
      } else out.staff.sent = 0;
    } catch (e) { out.staff.error = e.message; }
  }
  return { ...out, cover };
}

const managerOnly = (req, res, next) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) {
    return res.status(403).json({ error: 'Manager access required' });
  }
  next();
};

// GET /api/away-mode — current state
router.get('/', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT am.id, am.active, am.return_date, am.cover_person_id,
             am.notify_callers, am.set_ooo, am.email_team, am.show_banner,
             am.updated_at,
             s.first_name || ' ' || s.last_name AS cover_person_name,
             u.first_name || ' ' || u.last_name AS updated_by_name
      FROM away_mode am
      LEFT JOIN staff s ON s.id = am.cover_person_id
      LEFT JOIN staff u ON u.id = am.updated_by
      WHERE am.id = 1
    `);
    if (!rows.length) return res.json({ active: false, return_date: null, cover_person_id: null });
    res.json(rows[0]);
  } catch (err) {
    console.error('away-mode GET error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

// GET /api/away-mode/banner — lightweight, ANY authenticated staff (not just managers).
// Powers the "manager away" banner in the portal shells. Returns minimal info only
// when away mode is active AND the show_banner toggle is on.
router.get('/banner', authenticate, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`
      SELECT am.active, am.show_banner, am.return_date,
             s.first_name AS cover_first,
             s.first_name || ' ' || s.last_name AS cover_name,
             replace(coalesce(s.role,'deputy manager'),'_',' ') AS cover_role
      FROM away_mode am LEFT JOIN staff s ON s.id = am.cover_person_id
      WHERE am.id = 1`);
    const r = rows[0];
    if (!r || !r.active || r.show_banner === false) return res.json({ show: false });
    const rd = r.return_date ? new Date(r.return_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' }) : null;
    res.json({ show: true, return_date: rd, cover_name: r.cover_name || null,
               cover_first: r.cover_first || null, cover_role: r.cover_role || null });
  } catch (e) { res.json({ show: false }); }
});

// PUT /api/away-mode — update state, fire N8N webhook
router.put('/', authenticate, managerOnly, async (req, res) => {
  const db = getPool();
  const { active, return_date, cover_person_id,
          notify_callers, set_ooo, email_team, show_banner } = req.body;
  if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
  if (active && !return_date) return res.status(400).json({ error: 'return_date required when active=true' });
  // Each toggle is optional; COALESCE keeps the stored value when omitted.
  const b = v => (v === undefined || v === null) ? null : Boolean(v);

  try {
    const { rows } = await db.query(`
      UPDATE away_mode
      SET active          = $1,
          return_date     = $2,
          cover_person_id = $3,
          notify_callers  = COALESCE($5, notify_callers),
          set_ooo         = COALESCE($6, set_ooo),
          email_team      = COALESCE($7, email_team),
          show_banner     = COALESCE($8, show_banner),
          updated_at      = now(),
          updated_by      = $4
      WHERE id = 1
      RETURNING id, active, return_date, cover_person_id, updated_at,
                notify_callers, set_ooo, email_team, show_banner
    `, [active, return_date || null, cover_person_id || null, req.user.id,
        b(notify_callers), b(set_ooo), b(email_team), b(show_banner)]);

    const state = rows[0];

    // Fire N8N webhook (fire and forget — N8N handles Google Workspace OOO)
    fetch(N8N_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        active: state.active,
        return_date: state.return_date,
        cover_person_id: state.cover_person_id,
        updated_by: req.user.id,
        updated_at: state.updated_at,
      }),
      signal: AbortSignal.timeout(8000),
    }).catch(e => console.error('away-mode n8n webhook error:', e.message));

    // Wren-native side-effects: set/clear Toby's OOO + email the team (best-effort).
    let effects = {};
    try { effects = await applyAwaySideEffects(db, state, req.body || {}); }
    catch (e) { console.error('away-mode side-effects error:', e.message); effects = { error: e.message }; }

    res.json({ ok: true, ...state, effects });
  } catch (err) {
    console.error('away-mode PUT error:', err.message);
    res.status(500).json({ error: 'DB error' });
  }
});

router.applyAwaySideEffects = applyAwaySideEffects; // exported for tests
module.exports = router;
