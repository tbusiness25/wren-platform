// ── Launch Prep — July 31 EyLog exit readiness (Prompt 66) ────────────────────
// One read-only status endpoint driving /launch-prep.html in Roost, plus a
// manager-gated parent-onboarding email action (dry-run / test / send).
// Every check is individually try/caught so a missing table degrades to an
// 'error' field on that section rather than failing the whole page.
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const gmail = require('../lib/gmail-sender');

const EYLOG_END = '2026-07-31';

function isManager(u) { return u && (u.role === 'manager' || Number(u.id) === 1); }

async function q1(db, sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows[0] || {};
}

router.get('/status', authenticate, async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const db = getPool();
  const out = {};
  const section = async (name, fn) => {
    try { out[name] = await fn(); }
    catch (e) { out[name] = { error: e.message }; }
  };

  await Promise.all([
    section('staff', async () => {
      const r = await q1(db, `
        SELECT COUNT(*) FILTER (WHERE id <> 1)::int AS total,
               COUNT(*) FILTER (WHERE id <> 1 AND pin_hash IS NOT NULL AND pin_hash <> '')::int AS with_pin,
               COUNT(*) FILTER (WHERE id <> 1 AND email IS NOT NULL AND email NOT ILIKE '%@demo%')::int AS with_email
        FROM staff WHERE is_active = true`);
      const { rows: roles } = await db.query(
        `SELECT role, COUNT(*)::int AS n FROM staff WHERE is_active = true GROUP BY role ORDER BY role`);
      return { ...r, roles: Object.fromEntries(roles.map(x => [x.role, x.n])) };
    }),

    section('children', async () => {
      // NB: most children carry a FUTURE leave_date (school leavers) — still enrolled.
      const r = await q1(db, `
        SELECT COUNT(*)::int AS total_active,
               COUNT(*) FILTER (WHERE room_id IS NOT NULL)::int AS with_room
        FROM children WHERE is_active = true AND (leave_date IS NULL OR leave_date > CURRENT_DATE)`);
      const { rows: missing } = await db.query(`
        SELECT first_name || ' ' || last_name AS name FROM children
        WHERE is_active = true AND (leave_date IS NULL OR leave_date > CURRENT_DATE) AND room_id IS NULL ORDER BY first_name`);
      const { rows: byRoom } = await db.query(`
        SELECT rm.name, COUNT(c.id)::int AS n FROM rooms rm
        LEFT JOIN children c ON c.room_id = rm.id AND c.is_active = true AND (c.leave_date IS NULL OR c.leave_date > CURRENT_DATE)
        GROUP BY rm.name ORDER BY rm.name`);
      return { ...r, missing_room: missing.map(m => m.name), by_room: Object.fromEntries(byRoom.map(x => [x.name, x.n])) };
    }),

    section('bookings', async () => q1(db, `
      SELECT COUNT(*)::int AS total,
             (SELECT source FROM child_bookings WHERE is_active GROUP BY source ORDER BY COUNT(*) DESC LIMIT 1) AS main_source,
             COUNT(*) FILTER (WHERE mon)::int AS mon, COUNT(*) FILTER (WHERE tue)::int AS tue,
             COUNT(*) FILTER (WHERE wed)::int AS wed, COUNT(*) FILTER (WHERE thu)::int AS thu,
             COUNT(*) FILTER (WHERE fri)::int AS fri
      FROM child_bookings WHERE is_active = true`)),

    section('parents', async () => q1(db, `
      SELECT (SELECT COUNT(*)::int FROM parent_portal_access WHERE is_active) AS portal_access,
             (SELECT COUNT(*)::int FROM children WHERE is_active AND (leave_date IS NULL OR leave_date > CURRENT_DATE) AND parent_1_email IS NOT NULL) AS children_with_parent_email`)),

    section('eylog_data', async () => q1(db, `
      SELECT (SELECT COUNT(*)::int FROM observations WHERE eylog_ref IS NOT NULL) AS observations_imported,
             (SELECT COUNT(*)::int FROM attendance) AS attendance_rows,
             (SELECT COUNT(*)::int FROM daily_diary) AS diary_rows,
             (SELECT COUNT(*)::int FROM framework_tracker) AS framework_tracker_entries`)),

    section('observations', async () => q1(db, `
      SELECT COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE array_length(linked_framework_ids,1) > 0)::int AS with_statements,
             COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS recent_7d
      FROM observations`)),

    section('register', async () => q1(db, `
      SELECT COUNT(*) FILTER (WHERE date = CURRENT_DATE)::int AS todays_seeded,
             COUNT(*) FILTER (WHERE date = CURRENT_DATE AND sign_in_time IS NOT NULL)::int AS todays_signed_in,
             MAX(date)::text AS last_register_date
      FROM attendance`)),

    section('funding', async () => q1(db, `
      SELECT COUNT(*)::int AS funded_children_this_term,
             COALESCE(SUM(cf.total_hours_week), 0)::numeric AS total_hours_week,
             MAX(ft.name) AS term_name
      FROM child_funding cf JOIN funding_terms ft ON cf.term_id = ft.id
      WHERE ft.is_current = true`)),

    section('banking', async () => q1(db, `
      -- custom-connection rows have no refresh token — access token is the signal
      SELECT COUNT(*) FILTER (WHERE provider = 'xero' AND oauth_access_token IS NOT NULL AND is_active)::int AS xero_connected,
             (SELECT MAX(last_sync_at) FROM finance_providers WHERE provider = 'xero')::text AS last_sync,
             (SELECT display_name FROM finance_providers WHERE provider='xero' AND is_active ORDER BY id LIMIT 1) AS display_name
      FROM finance_providers`)),
  ]);

  // Static / env checks
  out.email = {
    gmail_dwd_send: true, // verified working (prompts 31/63)
    gmail_readonly_dwd: false, // Toby adding admin.directory scopes — weekly sync self-heals
    smtp_configured: !!(process.env.SMTP_PASS && process.env.SMTP_PASS.length)
  };
  const days = Math.ceil((new Date(EYLOG_END) - Date.now()) / 86400000);
  out.eylog_exit = { account_ends: EYLOG_END, days_remaining: days };
  out.generated_at = new Date().toISOString();
  res.json(out);
});

// POST /send-parent-onboarding — {mode: 'dry_run'|'test'|'send', confirm}
// dry_run: preview only. test: ONE email to the manager test address.
// send: all active portal parents — requires confirm === 'SEND-TO-ALL-PARENTS'.
const TEST_ADDR = 'toby.jones1@gmail.com';

function onboardingEmail() {
  const url = 'https://parents.littleangelsealing.co.uk';
  const subject = 'Your Little Angels parent portal is ready 🐤';
  const text = `Hello!

Little Angels is moving to our own parent portal — here's how to get set up (it takes about a minute):

1. On your phone, open ${url}
2. Enter the email address this message was sent to
3. You'll receive a one-time code by email — type it in and you're in

Once you're in, you can add the portal to your home screen like an app:
- iPhone (Safari): tap the Share button, then "Add to Home Screen"
- Android (Chrome): tap the ⋮ menu, then "Add to Home screen"

From the portal you can see your child's daily diary, learning journey, photos, menus and messages — and message the team directly.

Any trouble logging in, just reply to this email.

The Little Angels team`;
  const html = text
    .split('\n\n')
    .map(p => `<p style="margin:0 0 14px;line-height:1.5">${p.replace(/\n/g, '<br>')}</p>`)
    .join('')
    .replace(url, `<a href="${url}">${url}</a>`);
  return { subject, text, html: `<div style="font-family:sans-serif;max-width:560px">${html}</div>` };
}

router.post('/send-parent-onboarding', authenticate, async (req, res) => {
  if (!isManager(req.user)) return res.status(403).json({ error: 'Forbidden' });
  const mode = req.body.mode || 'dry_run';
  const db = getPool();
  const { rows } = await db.query(
    `SELECT DISTINCT LOWER(email) AS email FROM parent_portal_access
     WHERE is_active AND email IS NOT NULL AND email LIKE '%@%' ORDER BY 1`);
  const recipients = rows.map(r => r.email);
  const tpl = onboardingEmail();

  if (mode === 'dry_run') {
    return res.json({
      mode, recipients: recipients.length,
      sample: recipients.slice(0, 3).map(e => e.replace(/^(..).*(@.*)$/, '$1…$2')),
      subject: tpl.subject, body_preview: tpl.text.slice(0, 400)
    });
  }

  if (mode === 'test') {
    const r = await gmail.sendViaGmail({ to: TEST_ADDR, subject: '[TEST] ' + tpl.subject, html: tpl.html, text: tpl.text });
    return res.json({ mode, sent_to: TEST_ADDR, ok: true, id: r?.id || null });
  }

  if (mode === 'send') {
    if (req.body.confirm !== 'SEND-TO-ALL-PARENTS') {
      return res.status(400).json({ error: 'confirm_required', hint: "pass confirm:'SEND-TO-ALL-PARENTS'" });
    }
    let sent = 0; const failed = [];
    for (const to of recipients) {
      try {
        await gmail.sendViaGmail({ to, subject: tpl.subject, html: tpl.html, text: tpl.text });
        sent++;
        await new Promise(r => setTimeout(r, 400)); // gentle pace for the Gmail API
      } catch (e) { failed.push(to); }
    }
    console.log(`[launch-prep] parent onboarding: sent ${sent}/${recipients.length} (by staff ${req.user.id})`);
    return res.json({ mode, sent, failed: failed.length });
  }

  res.status(400).json({ error: 'unknown_mode' });
});

module.exports = router;
