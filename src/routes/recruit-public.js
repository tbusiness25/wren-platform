'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b112 — Wren Recruit: PUBLIC endpoints (UNAUTHENTICATED, rate-limited).
// Mounted in editions/ladn/server-unified.js BEFORE the auth-gated routes, next
// to public-enquiry / public-availability. Portal-agnostic (matches on path).
//
// Reached from the Your Nursery public website (nursery-website container) via
// the existing same-origin  location /api/public/  nginx proxy → wren-ladn.
//
//   GET  /api/recruit/feed.xml               Indeed-compatible XML jobs feed
//   GET  /api/public/careers/feed.xml        (alias — reachable via the existing
//                                             /api/public/ proxy without new nginx)
//   GET  /api/public/careers                 published+open vacancies (list)
//   GET  /api/public/careers/:id             one published vacancy
//   POST /api/public/careers/apply           apply form (multipart CV) → applicant
//
// Additive: does NOT touch any existing route. CV files are written under the
// person-documents storage root with a recruit/ prefix (GDPR: non-staff data).
// ─────────────────────────────────────────────────────────────────────────────
const express   = require('express');
const rateLimit = require('express-rate-limit');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');

const router = express.Router();
const { getPool } = require('../db/pool');
// b213 — EYFS questions asked of Level 2 / Level 3 applicants. Never scored here.
const EYFS = require('../lib/eyfs-assessment');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const PUBLIC_SITE = process.env.PUBLIC_SITE_URL || 'https://example-nursery.co.uk';

// CV storage: person-documents root + recruit/ prefix (matches person-documents.js).
const STORE_BASE = process.env.PERSON_DOC_BASE
  || path.join(__dirname, '../../data/person-documents');
const RECRUIT_BASE = path.join(STORE_BASE, 'recruit');

// ── Upload constraints (CV only) ─────────────────────────────────────────────
const MAX_CV_BYTES = 5 * 1024 * 1024; // 5MB
const CV_EXT = {
  '.pdf':  'application/pdf',
  '.doc':  'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const cvStorage = multer.diskStorage({
  destination(req, file, cb) {
    const dir = path.join(RECRUIT_BASE, 'tmp');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    cb(null, dir);
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase() || '.bin';
    cb(null, `cv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  },
});
const cvUpload = multer({
  storage: cvStorage,
  limits: { fileSize: MAX_CV_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (CV_EXT[ext]) return cb(null, true);
    cb(new Error('CV must be a PDF or Word document (.pdf, .doc, .docx).'));
  },
});

// ── Rate limiter (behind nginx/CF — trust proxy set in server-unified) ────────
const applyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,                       // 6 applications / IP / 15 min
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many applications from this device. Please try again later.' },
});

// ── helpers ──────────────────────────────────────────────────────────────────
function clean(v, maxLen) {
  if (v === undefined || v === null) return null;
  let s = String(v).trim();
  if (!s) return null;
  s = s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s{3,}/g, ' ').trim();
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s || null;
}
function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function cdata(s) { return `<![CDATA[${String(s == null ? '' : s).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`; }

// Minimal, dependency-free markdown → text/HTML for feed descriptions.
function mdToHtml(md) {
  if (!md) return '';
  const esc = xmlEscape(md);
  return esc
    .split(/\n{2,}/)
    .map(p => `<p>${p.replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

// Publicly-safe vacancy shape.
function pubVacancy(v) {
  return {
    id: v.id,
    title: v.title,
    room_role: v.room_role,
    description_md: v.description_md,
    salary_range: v.salary_range,
    hours: v.hours,
    employment_type: v.employment_type,
    posted_at: v.created_at,
  };
}

async function listPublished(db) {
  const { rows } = await db.query(
    `SELECT * FROM ${SCHEMA()}.recruit_vacancies
      WHERE published = true AND status = 'open'
      ORDER BY created_at DESC, id DESC`);
  return rows;
}

// ── GET feed.xml (Indeed-compatible) — canonical + /api/public alias ──────────
async function serveFeed(req, res) {
  try {
    const db = getPool();
    const rows = await listPublished(db);
    const jobs = rows.map(v => `  <job>
    <title>${cdata(v.title)}</title>
    <date>${cdata(new Date(v.created_at).toUTCString())}</date>
    <referencenumber>${cdata(v.id)}</referencenumber>
    <url>${cdata(`${PUBLIC_SITE}/careers.html#job-${v.id}`)}</url>
    <company>${cdata('Your Nursery')}</company>
    <city>${cdata('Ealing')}</city>
    <state>${cdata('London')}</state>
    <country>${cdata('GB')}</country>
    <postalcode>${cdata('AB1 2CD')}</postalcode>
    <streetaddress>${cdata('123 Example Lane')}</streetaddress>
    <email>${cdata('info@example-nursery.co.uk')}</email>
    <description>${cdata(mdToHtml(v.description_md) + (v.room_role ? `<p><b>Role:</b> ${xmlEscape(v.room_role)}</p>` : '') + (v.hours ? `<p><b>Hours:</b> ${xmlEscape(v.hours)}</p>` : ''))}</description>
    <salary>${cdata(v.salary_range || '')}</salary>
    <jobtype>${cdata(v.employment_type === 'apprenticeship' ? 'apprenticeship' : (v.hours && /part/i.test(v.hours) ? 'parttime' : 'fulltime'))}</jobtype>
    <category>${cdata('Childcare / Early Years')}</category>
  </job>`).join('\n');

    const xml = `<?xml version="1.0" encoding="utf-8"?>
<source>
  <publisher>Your Nursery</publisher>
  <publisherurl>${xmlEscape(PUBLIC_SITE)}</publisherurl>
  <lastBuildDate>${xmlEscape(new Date().toUTCString())}</lastBuildDate>
${jobs}
</source>
`;
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.send(xml);
  } catch (e) {
    console.error('[recruit-public] feed:', e.message);
    res.status(500).type('application/xml').send('<?xml version="1.0"?><source/>');
  }
}
router.get('/api/recruit/feed.xml', serveFeed);
router.get('/api/public/careers/feed.xml', serveFeed);

// ── GET /api/public/careers — list published+open vacancies ───────────────────
router.get('/api/public/careers', async (req, res) => {
  try {
    const rows = await listPublished(getPool());
    res.json({ vacancies: rows.map(pubVacancy) });
  } catch (e) {
    console.error('[recruit-public] list:', e.message);
    res.status(500).json({ error: 'Could not load vacancies.' });
  }
});

// ── GET /api/public/careers/assessment — the EYFS questions (b213) ────────────
// MUST stay above the /:id route below, which would otherwise swallow the path.
// Public by design: these are the questions, not the answers, and an applicant
// is entitled to read them before deciding to apply.
router.get('/api/public/careers/assessment', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=600');
  res.json(EYFS.publicAssessment());
});

// ── GET /api/public/careers/:id — one published vacancy ───────────────────────
router.get('/api/public/careers/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad id' });
    const { rows } = await getPool().query(
      `SELECT * FROM ${SCHEMA()}.recruit_vacancies
        WHERE id=$1 AND published=true AND status='open'`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Vacancy not found or no longer open.' });
    res.json(pubVacancy(rows[0]));
  } catch (e) {
    console.error('[recruit-public] get:', e.message);
    res.status(500).json({ error: 'Could not load vacancy.' });
  }
});

// ── POST /api/public/careers/apply — apply form (multipart) ───────────────────
router.post('/api/public/careers/apply', applyLimiter, (req, res) => {
  cvUpload.single('cv')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const tmpPath = req.file && req.file.path;
    const cleanup = () => { if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (_) {} } };
    try {
      const b = req.body || {};

      // Honeypot — hidden fields bots fill; humans leave blank. Fake success.
      if (clean(b.company, 200) || clean(b.website_hp, 200)) { cleanup(); return res.status(201).json({ ok: true }); }

      const name  = clean(b.name, 200);
      const email = clean(b.email, 320);
      const phone = clean(b.phone, 50);
      const cover = clean(b.cover_text || b.message, 4000);
      const vacancyId = b.vacancy_id != null && String(b.vacancy_id).trim() !== ''
        ? parseInt(b.vacancy_id, 10) : null;
      const consent = b.consent === true || b.consent === 'true' || b.consent === 'on' || b.consent === '1';

      if (!name || !email) { cleanup(); return res.status(400).json({ error: 'Your name and email are required.' }); }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { cleanup(); return res.status(400).json({ error: 'Please enter a valid email address.' }); }
      if (!consent) { cleanup(); return res.status(400).json({ error: 'Please tick the consent box to submit your application.' }); }

      // ── b213: qualification + (for Level 2/3) the ten EYFS answers ──────────
      // Anything we don't recognise is stored as NULL rather than guessed at.
      const qualRaw = clean(b.qualification, 40);
      const qualification = EYFS.QUALIFICATION_VALUES.includes(qualRaw) ? qualRaw : null;

      let assessment = null;
      if (EYFS.needsAssessment(qualification)) {
        let parsed = b.assessment;
        if (typeof parsed === 'string') {
          try { parsed = JSON.parse(parsed); }
          catch (_) { cleanup(); return res.status(400).json({ error: 'We could not read your answers. Please try again.' }); }
        }
        const built = EYFS.buildAssessment(parsed, qualification);
        if (!built.ok) { cleanup(); return res.status(400).json({ error: built.error }); }
        assessment = built.assessment;
      }

      const db = getPool();

      // Validate the vacancy is real + published (defence in depth); else NULL.
      let vId = null, vTitle = null;
      if (vacancyId != null && Number.isInteger(vacancyId)) {
        const { rows: vr } = await db.query(
          `SELECT id, title FROM ${SCHEMA()}.recruit_vacancies WHERE id=$1 AND published=true`, [vacancyId]);
        if (vr.length) { vId = vr[0].id; vTitle = vr[0].title; }
      }

      // Insert the applicant first so we have an id for the CV filename.
      const { rows: [app] } = await db.query(
        `INSERT INTO ${SCHEMA()}.recruit_applicants
           (vacancy_id, name, email, phone, cover_text, source, stage, gdpr_consent_at,
            qualification, assessment, assessment_submitted_at)
         VALUES ($1,$2,$3,$4,$5,'careers','applied', now(),
                 $6, $7::jsonb, CASE WHEN $7 IS NULL THEN NULL ELSE now() END)
         RETURNING id`,
        [vId, name, email.toLowerCase(), phone, cover,
         qualification, assessment ? JSON.stringify(assessment) : null]);
      const appId = app.id;

      // Move the CV into place (recruit/<applicant_id>/<file>).
      if (req.file) {
        try {
          const finalDir = path.join(RECRUIT_BASE, String(appId));
          fs.mkdirSync(finalDir, { recursive: true });
          const finalPath = path.join(finalDir, req.file.filename);
          fs.renameSync(req.file.path, finalPath);
          const ext = path.extname(req.file.originalname).toLowerCase();
          await db.query(
            `UPDATE ${SCHEMA()}.recruit_applicants
               SET cv_path=$1, cv_filename=$2, cv_mime=$3 WHERE id=$4`,
            [finalPath, req.file.originalname, CV_EXT[ext] || req.file.mimetype, appId]);
        } catch (fe) {
          console.error('[recruit-public] CV store failed:', fe.message);
          cleanup();
        }
      }

      // Manager notification (in-app) — reuses the notifications table.
      try {
        await db.query(
          `INSERT INTO ${SCHEMA()}.notifications
             (recipient_type, category, title, body, link, related_table, related_id, priority)
           VALUES ('all-managers','recruit_application',$1,$2,$3,'recruit_applicants',$4,'normal')`,
          [`New job application`,
           `${name} applied${vTitle ? ` for ${vTitle}` : ''}.`
             + (assessment ? ' EYFS answers attached — worth a read.' : ''),
           `/recruitment.html#applicant-${appId}`, appId]);
      } catch (ne) { console.error('[recruit-public] notify failed:', ne.message); }

      // Telegram ping (best-effort, non-blocking).
      {
        const txt = `🧑‍🍼 *New job application*\n`
          + `${name} <${email}>${phone ? `\nPhone: ${phone}` : ''}\n`
          + `${vTitle ? `Role: ${vTitle}\n` : ''}`
          + `${req.file ? 'CV attached ✔\n' : 'No CV attached\n'}`
          + `${qualification ? `Qualification: ${qualification.replace(/_/g, ' ')}\n` : ''}`
          + `${assessment ? 'EYFS questions answered ✔ (read them on Roost)\n' : ''}`
          + `${cover ? '> ' + cover.slice(0, 180) : ''}`;
        // login-20261023: through the one Telegram sender (src/lib/notifications.js), which carries the dev guard.
        require('../lib/notifications').sendTelegramNow({ text: txt, parse_mode: 'Markdown' });
      }

      return res.status(201).json({ ok: true, id: appId });
    } catch (e) {
      cleanup();
      console.error('[recruit-public] apply:', e.message);
      return res.status(500).json({ error: 'Could not submit your application. Please email info@example-nursery.co.uk.' });
    }
  });
});

module.exports = router;
