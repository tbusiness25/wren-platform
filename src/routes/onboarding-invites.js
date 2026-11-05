'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Onboarding invites — MANAGER API (authed). Mounted at /api/onboarding-invites.
// The manager mints a single-use invite link for a new child (parent fills it) or
// a new staff member (they fill it). Public submission + the form pages live in
// onboarding-public.js. Approval activates the pending record here.
//
// Distinct from src/routes/onboarding.js (child settling/deposits) — different
// path, different table. Additive-only.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { getPool } = require('../db/pool');
const { recordAudit } = require('../utils/audit');
const { ensureTable, mintToken } = require('../lib/onboarding-invites-db');
const { sendEmail } = require('../lib/notifications');
const { provisionWrenId } = require('../lib/wren-id-provision');

router.use(authenticate);
const managerOnly = requireRole('manager', 'deputy_manager');

// The public form is portal-agnostic, but the intended shareable host is the
// parents portal. NB: parents.example-nursery.co.uk sits behind Cloudflare
// Access (email OTP) — brand-new external parents can't pass it yet. This is a
// known limitation flagged for Toby; we do NOT touch Cloudflare here.
async function inviteLink(type, token) {
  // Public nursery site proxies /onboard/* + /api/onboard/* same-origin to Wren
  // (2026-07-15, same pattern as the availability heat-map) — so invite links work
  // for genuinely-new parents with no Cloudflare Access relationship.
  // Host resolution: per-tenant settings row (live-editable) → env → parents domain.
  let host = null;
  try {
    const { rows } = await getPool().query(
      "SELECT value FROM settings WHERE key='onboard_public_host' LIMIT 1");
    host = rows[0]?.value || null;
  } catch (_) { /* settings unavailable — fall through */ }
  host = host || process.env.ONBOARD_PUBLIC_HOST || process.env.PARENTS_DOMAIN || process.env.ADMIN_DOMAIN || 'localhost';
  return `https://${host}/onboard/${type}?token=${token}`;
}

// Shared by the create-preview below and the explicit /invite/:id/send, so the
// two can never say something different about what the family was shown.
function inviteEmailContent(type, link, note) {
  const subject = type === 'child'
    ? 'Your Nursery — register your child'
    : 'Your Nursery — complete your onboarding';
  const safeNote = note ? note.replace(/[<>]/g, '') : '';
  const html =
    `<p>Hello,</p>` +
    `<p>Please use the secure link below to ${type === 'child'
      ? 'register your child with Your Nursery'
      : 'complete your staff onboarding details'}. It can be used once and expires in ${type === 'child' ? 28 : 7} days.</p>` +
    `<p><a href="${link}">${link}</a></p>` +
    (safeNote ? `<p>${safeNote}</p>` : '') +
    `<p>Thank you,<br>Your Nursery</p>`;
  return { subject, html };
}

// POST /invite {type:'child'|'staff', email?, note?, waiting_list_id?, enquiry_id?}
// → mint single-use token. 2026-10-06 (b398): no longer emails on creation —
// "the email goes as soon as you create the link (no preview)" was gap 5/11 in
// wren-docs/workflows/new-family-journey-2026-10-06.pdf. Creating a link now
// only ever returns a PREVIEW (subject/html); POST /invite/:id/send is the
// explicit human action that actually sends it.
router.post('/invite', managerOnly, async (req, res) => {
  const type = String(req.body.type || '').trim();
  if (!['child', 'staff'].includes(type)) {
    return res.status(400).json({ error: "type must be 'child' or 'staff'" });
  }
  let email = String(req.body.email || '').trim().slice(0, 320) || null;
  const note = String(req.body.note || '').trim().slice(0, 500) || null;
  const waitingListId = Number.isInteger(req.body.waiting_list_id) ? req.body.waiting_list_id : null;
  const enquiryId = Number.isInteger(req.body.enquiry_id) ? req.body.enquiry_id : null;
  try {
    await ensureTable();
    const db = getPool();

    // b398 — tie the link to the family it was minted for, and pre-fill the
    // email from them when the caller didn't type one in.
    if (type === 'child' && (waitingListId || enquiryId)) {
      let fam = null;
      if (waitingListId) {
        fam = (await db.query(`SELECT parent_email FROM waiting_list WHERE id=$1`, [waitingListId])).rows[0];
      } else if (enquiryId) {
        fam = (await db.query(`SELECT parent_email FROM enquiries WHERE id=$1`, [enquiryId])).rows[0];
      }
      if (!email && fam && fam.parent_email) email = fam.parent_email;
    }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email address' });
    }

    const token = mintToken();
    const { rows } = await db.query(
      `INSERT INTO onboarding_invites (type, token, email, note, status, created_by, expires_at,
         waiting_list_id, enquiry_id)
       VALUES ($1,$2,$3,$4,'pending',$5, now() + ($8 || ' days')::interval, $6, $7)
       RETURNING id, token, expires_at`,
      // b531 — a family's registration link lasts 28 days: the admissions lead sends it with
      // the deposit details months before the start, and families take a while.
      [type, token, email, note, req.user.id, waitingListId, enquiryId, type === 'child' ? '28' : '7']);
    const link = await inviteLink(type, token);
    const draft = inviteEmailContent(type, link, note);

    recordAudit({ req, action: 'create', entity_type: 'onboarding_invite', entity_id: rows[0].id,
      meta: { type, waiting_list_id: waitingListId, enquiry_id: enquiryId } });
    res.status(201).json({
      id: rows[0].id, token, link, email, expires_at: rows[0].expires_at,
      subject: draft.subject, html: draft.html,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /invite/:id/send {email?, subject?, html?} — the explicit "Send" press
// on the preview the create call above returned. Editable: a manager may
// retype the recipient or tweak the wording before it goes. Never fires on
// its own — this IS the human action (memory: feedback_no_auto_email_to_parents).
router.post('/invite/:id/send', managerOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    await ensureTable();
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM onboarding_invites WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const inv = rows[0];
    if (inv.status !== 'pending') return res.status(409).json({ error: 'This link has already been used or has expired' });

    const email = String((req.body && req.body.email) || inv.email || '').trim().slice(0, 320);
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    const link = await inviteLink(inv.type, inv.token);
    const draft = inviteEmailContent(inv.type, link, inv.note);
    const subject = (req.body && req.body.subject) ? String(req.body.subject).slice(0, 300) : draft.subject;
    const html = (req.body && req.body.html) ? String(req.body.html).slice(0, 20000) : draft.html;

    const emailSent = await sendEmail(email, subject, html, 'onboarding-invite');
    if (!emailSent) return res.status(502).json({ error: 'Send failed — no mail transport configured' });

    await db.query(
      `UPDATE onboarding_invites SET email=$2, emailed_at=now(), email_status='sent', send_count=send_count+1
        WHERE id=$1`, [id, email]);
    recordAudit({ req, action: 'send', entity_type: 'onboarding_invite', entity_id: id, meta: { email } });
    res.json({ ok: true, emailSent: true, sent_to: email });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /list?type= — outstanding (still-pending) invites. Tokens are NOT returned
// here (single-use secret); the link is shown once at create time.
router.get('/list', managerOnly, async (req, res) => {
  const type = req.query.type;
  try {
    await ensureTable();
    const { rows } = await getPool().query(
      `SELECT id, type, email, note, status, created_at, expires_at
         FROM onboarding_invites
        WHERE status='pending'${type ? ' AND type=$1' : ''}
        ORDER BY created_at DESC`,
      type ? [type] : []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /pending?type= — submitted invites awaiting manager approval, with a
// minimal display summary captured at submit time.
router.get('/pending', managerOnly, async (req, res) => {
  const type = req.query.type;
  try {
    await ensureTable();
    const { rows } = await getPool().query(
      `SELECT id, type, email, note, submitted_at, submitted_entity_id, submitted_summary, expires_at
         FROM onboarding_invites
        WHERE status='submitted'${type ? ' AND type=$1' : ''}
        ORDER BY submitted_at DESC NULLS LAST`,
      type ? [type] : []);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /approve/:id — activate the pending record. Nothing goes live without this.
// b405 — optional body {red_book_seen, birth_cert_seen}: a staff-side tick that
// the approving manager has physically seen the child's red book (NHS personal
// child health record) and/or birth certificate. Never a parent upload, never
// required by this route — a missing body still approves exactly as before
// (e.g. a very early registration before the red book exists yet). When either
// is true, seen_by/seen_at are stamped to the acting manager and now().
router.post('/approve/:id', managerOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  const redBookSeen = !!(req.body && req.body.red_book_seen === true);
  const birthCertSeen = !!(req.body && req.body.birth_cert_seen === true);
  try {
    await ensureTable();
    const db = getPool();
    const { rows } = await db.query('SELECT * FROM onboarding_invites WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const inv = rows[0];
    if (inv.status !== 'submitted') return res.status(409).json({ error: 'not awaiting approval' });
    if (!inv.submitted_entity_id) return res.status(409).json({ error: 'no submission linked' });

    let familyAccess = null;
    if (inv.type === 'child') {
      await db.query(`UPDATE children SET status='active', is_active=true, updated_at=NOW() WHERE id=$1`,
        [inv.submitted_entity_id]);
      // 2026-10-06 — approval is when a family becomes real: billing email, parents-app
      // access and the family payment reference, so they can see, be sent and pay bills.
      // Never fails the approval; never sends anything.
      try { familyAccess = await require('../lib/family-access').ensureFamilyAccess(db, inv.submitted_entity_id); }
      catch (e) { familyAccess = { ok: false, reason: e.message }; }
    } else {
      await db.query(`UPDATE staff SET is_active=true, updated_at=NOW() WHERE id=$1`,
        [inv.submitted_entity_id]);
    }
    await db.query(
      `UPDATE onboarding_invites
          SET status='approved', approved_at=now(), approved_by=$1,
              red_book_seen=$3, birth_cert_seen=$4,
              seen_by = CASE WHEN $3 OR $4 THEN $1 ELSE seen_by END,
              seen_at = CASE WHEN $3 OR $4 THEN now() ELSE seen_at END
        WHERE id=$2`,
      [req.user.id, id, redBookSeen, birthCertSeen]);
    recordAudit({ req, action: 'approve', entity_type: 'onboarding_' + inv.type,
      entity_id: inv.submitted_entity_id,
      meta: { invite_id: id, red_book_seen: redBookSeen, birth_cert_seen: birthCertSeen } });

    // ── b306 — the sixth thing, which used to be a script somebody had to
    //    remember ────────────────────────────────────────────────────────────
    //  ACTIVATION is the trigger, not creation: an identity account should exist
    //  only for somebody who actually works here, and that is the line this
    //  handler has just crossed.
    //
    //  IT MUST NOT BE ABLE TO LOSE HER. Her staff row, her invite, her induction
    //  workbook and her approval are all committed above. authentik being
    //  unreachable is not a reason to fail an approval — so this never throws,
    //  the outcome is written to her staff row, and the Wren ID tab in Roost
    //  offers the retry. No password is set and no email is sent here; a
    //  credential is a separate, explicit act by a named manager.
    let wrenId = null;
    if (inv.type === 'staff') {
      wrenId = await provisionWrenId(db, inv.submitted_entity_id, req);
    }

    res.json({ ok: true, type: inv.type, entity_id: inv.submitted_entity_id, wren_id: wrenId, family_access: familyAccess });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /reject/:id — decline a submission. The record is left INACTIVE (never
// deleted — production data is retained) and the invite is marked rejected.
router.post('/reject/:id', managerOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    await ensureTable();
    const { rows } = await getPool().query(
      `UPDATE onboarding_invites SET status='rejected' WHERE id=$1 AND status='submitted'
       RETURNING id, type, submitted_entity_id`, [id]);
    if (!rows.length) return res.status(409).json({ error: 'not awaiting approval' });
    recordAudit({ req, action: 'reject', entity_type: 'onboarding_' + rows[0].type,
      entity_id: rows[0].submitted_entity_id, meta: { invite_id: id } });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /invite/:id — remove an UNUSED invite (pending/expired/rejected only).
// Never removes an invite whose submission was created/approved, so no child or
// staff record is ever orphaned. Used for cleanup + the prod smoke test.
router.delete('/invite/:id', managerOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    await ensureTable();
    const { rowCount } = await getPool().query(
      `DELETE FROM onboarding_invites WHERE id=$1 AND status IN ('pending','expired','rejected')`, [id]);
    recordAudit({ req, action: 'delete', entity_type: 'onboarding_invite', entity_id: id });
    res.json({ ok: true, deleted: rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
