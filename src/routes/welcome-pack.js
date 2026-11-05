'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b422 (2026-10-08) — Registration welcome pack. Mounted at /api/welcome-pack.
//
// the office manager (nursery admin), via Toby: "What happens when you move a child from
// Offer accepted to Registered? It should do what EyLog did: send them a
// confirmation email, get them to sign up to Wren, fill out the red book
// (vaccinations), get all their details, read our policies and procedures,
// permissions, funding declaration, allergy action plan — make sure all the
// workflows are set up. And in Settings a way to customise it."
//
// Nothing here emails a parent automatically (memory:
// feedback_no_auto_email_to_parents) — /:childId/send and /:childId/reminder
// are both an explicit person pressing Send on a preview they were shown.
// The checklist itself is never stored; src/lib/welcome-pack.js computes it
// live off the real tables each item already lives in.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { requireRole } = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const { sendEmailDetailed } = require('../lib/notifications');
const { ensureFamilyAccess } = require('../lib/family-access');
const WP = require('../lib/welcome-pack');

const managerOnly = requireRole('manager', 'deputy_manager', 'admin');

// b428 — this used to depend on src/lib/newsletter-branding.js (b373,
// 2026-10-01), which isn't in the release tree yet — a missing module there
// would crash-loop prod the moment this route was deployed without it. Reads
// the one field this route actually needs (the nursery's display name)
// directly, with no cross-build dependency.
async function getNurseryName(db) {
  try {
    const { rows } = await db.query(
      `SELECT key, value FROM settings WHERE key IN ('setting_name','nursery_name')`);
    const map = {};
    rows.forEach(r => { map[r.key] = r.value; });
    return (map.setting_name || map.nursery_name || '').trim() || 'Your Setting';
  } catch { return 'Your Setting'; }
}

// b428 — the family's normal Parents app sign-in link (same URL
// invoice-pdf.js/keepsake-mint.js/enquiry-ack-email.js already send parents),
// NOT a registration-form invite. By the time this route has a `child` loaded
// at all, the child record already exists (buildPreview/doSend only ever run
// with one) — so the old registration-form link was always wrong here: for an
// already-enrolled child, submitting that form tried to create a SECOND child
// record (500 children_name_dob_unique, or a duplicate pending child).
const PARENTS_APP_URL = process.env.PARENTS_APP_URL || 'https://parents.example-nursery.co.uk';

const UPLOAD_DIR = process.env.WELCOME_PACK_UPLOAD_DIR || path.join(__dirname, '../../data/welcome-pack-attachments');
const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); cb(null, UPLOAD_DIR); },
    filename(req, file, cb) {
      const ext = path.extname(file.originalname).toLowerCase() || '.bin';
      cb(null, `wp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext}`);
    },
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    const ok = ['.pdf', '.docx', '.doc', '.jpg', '.jpeg', '.png'];
    cb(null, ok.includes(path.extname(file.originalname).toLowerCase()));
  },
});

router.use(authenticate);

async function ensureSettingsRow(db) {
  await db.query(`INSERT INTO welcome_pack_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING`);
}

async function loadSettings(db) {
  await ensureSettingsRow(db);
  const { rows: [s] } = await db.query(`SELECT * FROM welcome_pack_settings WHERE id=true`);
  // stored_path is a server filesystem path — kept here for doSend() to read the file,
  // stripped (see publicAttachments) before anything goes to the client.
  const { rows: attachments } = await db.query(
    `SELECT id, title, filename, stored_path, size_bytes, content_type, sort_order, created_at
       FROM welcome_pack_attachments ORDER BY sort_order, id`);
  return { subject: s.subject, body_html: s.body_html, checklist_config: s.checklist_config || {}, attachments };
}

function publicAttachments(attachments) {
  return attachments.map(({ stored_path, ...rest }) => rest);
}

// GET /api/welcome-pack/settings — the editable template, checklist toggles, attachments.
router.get('/settings', ...managerOnly, async (req, res) => {
  try {
    const settings = await loadSettings(getPool());
    res.json({ ...settings, attachments: publicAttachments(settings.attachments), item_defs: WP.ITEM_DEFS, merge_fields: WP.MERGE_FIELDS });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /api/welcome-pack/settings {subject, body_html, checklist_config}
router.put('/settings', ...managerOnly, async (req, res) => {
  const { subject, body_html, checklist_config } = req.body || {};
  if (!subject || !body_html) return res.status(400).json({ error: 'subject and body_html are required' });
  try {
    const db = getPool();
    await ensureSettingsRow(db);
    await db.query(
      `UPDATE welcome_pack_settings SET subject=$1, body_html=$2, checklist_config=$3, updated_by=$4, updated_at=now() WHERE id=true`,
      [subject, body_html, JSON.stringify(checklist_config || {}), req.user.id]);
    recordAudit({ req, action: 'update', entity_type: 'welcome_pack_settings', entity_id: 1, meta: {} });
    const updated = await loadSettings(db);
    res.json({ ...updated, attachments: publicAttachments(updated.attachments) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/welcome-pack/settings/attachments — upload one PDF/image/doc.
router.post('/settings/attachments', ...managerOnly, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (pdf, docx, jpg or png)' });
  try {
    const db = getPool();
    const { rows: [row] } = await db.query(
      `INSERT INTO welcome_pack_attachments (title, filename, stored_path, size_bytes, content_type, sort_order, created_by)
       VALUES ($1,$2,$3,$4,$5, (SELECT COALESCE(MAX(sort_order),0)+1 FROM welcome_pack_attachments), $6)
       RETURNING id, title, filename, size_bytes, content_type, sort_order, created_at`,
      [req.body.title || req.file.originalname, req.file.originalname, req.file.path, req.file.size, req.file.mimetype, req.user.id]);
    recordAudit({ req, action: 'create', entity_type: 'welcome_pack_attachment', entity_id: row.id, meta: { filename: row.filename } });
    res.status(201).json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/welcome-pack/settings/attachments/:id
router.delete('/settings/attachments/:id', ...managerOnly, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'bad id' });
  try {
    const db = getPool();
    const { rows: [row] } = await db.query(`DELETE FROM welcome_pack_attachments WHERE id=$1 RETURNING stored_path`, [id]);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.stored_path) fs.unlink(row.stored_path, () => {});
    recordAudit({ req, action: 'delete', entity_type: 'welcome_pack_attachment', entity_id: id, meta: {} });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// b429 — `kind` picks which items the {{checklist_list}} merge field renders:
// the full list (✓ against anything done) for a 'welcome' send, outstanding-
// only for a 'reminder'. Previously this always embedded the FULL list via
// the template, and doSend() then appended a SECOND, outstanding-only list
// after it for a reminder — two checklists in one email. Now there is one
// owner (this function) and ONE list, embedded once, for either kind; the
// GET preview route and doSend() both call this with the same `kind`, so a
// preview is byte-identical to what actually gets sent.
async function buildPreview(db, child, settings, kind = 'welcome') {
  const nurseryName = await getNurseryName(db);
  const { items, progress } = await WP.computeChecklist(db, child, settings.checklist_config);
  const signupLink = PARENTS_APP_URL;
  const checklistItems = kind === 'reminder' ? items.filter(it => it.applicable && !it.done) : items;
  // b429b — parent/child/nursery names were merged into body_html RAW: a name
  // containing &, < or > went out unescaped in both the preview iframe and
  // the actual email. renderTemplate() does a plain string substitution with
  // no escaping of its own, so the HTML-context fields must be pre-escaped
  // here; the plain-text subject keeps the raw values (escaping it would
  // turn an apostrophe into "O&#39;Brien" in the email's subject line).
  const rawFields = {
    parent_name: child.parent_1_name || child.parent_2_name || 'there',
    child_first_name: child.first_name,
    child_name: `${child.first_name} ${child.last_name}`.trim(),
    start_date: child.start_date ? new Date(child.start_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : 'to be confirmed',
    nursery_name: nurseryName,
    signup_link: signupLink,
  };
  const subject = WP.renderTemplate(settings.subject, rawFields);
  const htmlFields = {};
  for (const key in rawFields) htmlFields[key] = WP.esc(rawFields[key]);
  htmlFields.checklist_list = WP.checklistToHtml(checklistItems); // already HTML — do not escape again
  const body_html = WP.renderTemplate(settings.body_html, htmlFields);
  const recipients = WP.familyEmails(child);
  return { subject, body_html, recipients, items, progress, signup_link: signupLink };
}

async function loadChild(db, childId) {
  const { rows } = await db.query(`SELECT * FROM children WHERE id=$1`, [childId]);
  return rows[0] || null;
}

// GET /api/welcome-pack/progress — bulk checklist progress for the Pipeline board's
// Registered-stage badges (one call, not one per card).
router.get('/progress', ...managerOnly, async (req, res) => {
  try {
    const db = getPool();
    const settings = await loadSettings(db);
    const { rows: linked } = await db.query(
      `SELECT c.enquiry_id, c.id AS child_id FROM children c
        WHERE c.enquiry_id IS NOT NULL AND c.status <> 'left'`);
    const out = {};
    for (const row of linked) {
      const child = await loadChild(db, row.child_id);
      if (!child) continue;
      const { progress } = await WP.computeChecklist(db, child, settings.checklist_config);
      out[row.enquiry_id] = { child_id: row.child_id, ...progress };
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/welcome-pack/for-enquiry/:enquiryId — resolves the linked child (if any)
// so the admissions drawer can show the panel from the enquiry it already has open.
router.get('/for-enquiry/:enquiryId', ...managerOnly, async (req, res) => {
  const enquiryId = parseInt(req.params.enquiryId, 10);
  if (!Number.isInteger(enquiryId)) return res.status(400).json({ error: 'bad enquiry id' });
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT id FROM children WHERE enquiry_id=$1 LIMIT 1`, [enquiryId]);
    if (!rows.length) return res.json({ child_id: null });
    const childId = rows[0].id;
    const child = await loadChild(db, childId);
    const settings = await loadSettings(db);
    const preview = await buildPreview(db, child, settings);
    res.json({ child_id: childId, child_name: `${child.first_name} ${child.last_name}`.trim(), ...preview });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/welcome-pack/:childId?kind=welcome|reminder — checklist + rendered
// preview + attachments + last sends. `kind` picks which checklist the
// preview embeds — defaults to 'welcome'; the modal passes 'reminder' when
// previewing/sending a reminder, so this returns exactly what doSend() would.
router.get('/:childId', ...managerOnly, async (req, res) => {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  const kind = req.query.kind === 'reminder' ? 'reminder' : 'welcome';
  try {
    const db = getPool();
    const child = await loadChild(db, childId);
    if (!child) return res.status(404).json({ error: 'child not found' });
    const settings = await loadSettings(db);
    const preview = await buildPreview(db, child, settings, kind);
    const { rows: sends } = await db.query(
      `SELECT id, kind, subject, to_emails, sent_by, sent_at, sent_ok FROM welcome_pack_sends
        WHERE child_id=$1 ORDER BY sent_at DESC LIMIT 10`, [childId]);
    res.json({
      child_id: childId, child_name: `${child.first_name} ${child.last_name}`.trim(),
      ...preview, attachments: publicAttachments(settings.attachments), sends,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function doSend(req, res, kind) {
  const childId = parseInt(req.params.childId, 10);
  if (!Number.isInteger(childId)) return res.status(400).json({ error: 'bad child id' });
  try {
    const db = getPool();
    const child = await loadChild(db, childId);
    if (!child) return res.status(404).json({ error: 'child not found' });
    // b428 — grant the family parents-app access now (idempotent, same helper
    // every other "family becomes real" moment calls) so the sign-up link in
    // the email we're about to send actually works the first time it's used.
    try { await ensureFamilyAccess(db, childId); } catch (_) {}
    const settings = await loadSettings(db);
    // b429 — buildPreview(..., kind) already embeds the right checklist (full
    // for 'welcome', outstanding-only for 'reminder') exactly once, via the
    // {{checklist_list}} merge field — nothing is appended here any more. A
    // reminder used to get the full list from this SAME call, plus a second,
    // outstanding-only list appended below: two checklists in one email.
    const preview = await buildPreview(db, child, settings, kind);
    if (!preview.recipients.length) return res.status(400).json({ error: 'No parent email on file for this child' });
    if (kind === 'reminder' && !preview.items.some(it => it.applicable && !it.done)) {
      return res.status(400).json({ error: 'Nothing outstanding to remind about' });
    }

    const subject = (req.body && req.body.subject) ? String(req.body.subject) : preview.subject;
    const body_html = (req.body && req.body.body_html) ? String(req.body.body_html) : preview.body_html;

    // Attachments go out with the confirmation email, not a reminder nudge.
    const emailAttachments = kind === 'welcome' && settings.attachments.length
      ? settings.attachments.map(a => ({ filename: a.filename, content: fs.readFileSync(a.stored_path), contentType: a.content_type }))
      : undefined;
    // b428 — sendEmail() returning false (dev hard-stop, disabled prefs, no
    // transport configured, a real failure) was previously ignored: every
    // send was recorded and reported as sent regardless of whether anything
    // actually went out. Record and report the real outcome.
    // b429 — sendEmailDetailed() instead of sendEmail(): the UI used to say
    // "test environment" for EVERY failure, even a genuine send error on prod
    // (Gmail/SMTP/n8n all down). Keep the first real reason seen.
    let sentOk = true, failReason = null;
    for (const to of preview.recipients) {
      const r = await sendEmailDetailed(to, subject, body_html, kind === 'reminder' ? 'welcome_pack_reminder' : 'welcome_pack', emailAttachments);
      if (!r.ok) { sentOk = false; if (!failReason) failReason = r.reason; }
    }

    const attachmentIds = kind === 'welcome' ? settings.attachments.map(a => a.id) : [];
    const { rows: [row] } = await db.query(
      `INSERT INTO welcome_pack_sends (child_id, kind, subject, body_html, to_emails, attachment_ids, outstanding_keys, sent_by, sent_ok)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, sent_at`,
      [childId, kind, subject, body_html, preview.recipients.join(', '), JSON.stringify(attachmentIds),
       JSON.stringify(preview.items.filter(it => it.applicable && !it.done).map(it => it.key)), req.user.id, sentOk]);

    recordAudit({ req, action: 'create', entity_type: 'welcome_pack_send', entity_id: row.id,
      meta: { child_id: childId, kind, to: preview.recipients, sent_ok: sentOk } });

    // b531 — the welcome pack going out is what makes the family Registered.
    if (kind === 'welcome' && sentOk) {
      try { await require('../lib/enquiry-stage').advanceOnWelcomePack(db, childId, { req }); }
      catch (e) { console.error('[welcome-pack stage-advance]', e.message); }
    }

    res.status(201).json({
      ok: true, sent: sentOk, id: row.id, sent_at: row.sent_at, to: preview.recipients,
      note: sentOk ? undefined : `Not sent (${failReason || 'unknown reason'}) — recorded only.`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}

// POST /api/welcome-pack/:childId/send — the confirmation email. Person-pressed only.
router.post('/:childId/send', ...managerOnly, (req, res) => doSend(req, res, 'welcome'));

// POST /api/welcome-pack/:childId/reminder — outstanding items only. Person-pressed only.
router.post('/:childId/reminder', ...managerOnly, (req, res) => doSend(req, res, 'reminder'));

module.exports = router;
