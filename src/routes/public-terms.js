'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b285 — the Terms & Conditions, readable without a login.
//
// WHY THIS EXISTS. Before b285 the closures-and-52-week-fees rule was written
// out by hand in four places: the public website's #terms accordion, the
// enrolment form, /welcome/about/guide and /welcome/fees. Four copies of a
// contractual term is four chances to disagree with the document a family
// actually signed. This endpoint is what lets the last three of those render the
// document instead of paraphrasing it — and the first one (a static file) be
// regenerated from the same source at publish time.
//
// ── WHY IT IS PUBLIC, AND WHAT THAT IS SAFE TO EXPOSE ────────────────────────
// The Terms & Conditions are already published in full on example-nursery.co.uk
// to anyone with a browser — they have to be, because a family reads them before
// they register. So this returns exactly what the public website shows and
// nothing else: ONE row, matched by title, and only when it is active and marked
// parent_facing. No other policy is reachable through it, no child or parent data
// is touched, and there is no parameter to widen it — the title is a constant in
// this file, not a query string.
//
// Mounted before the auth and off-site gates in server-unified.js, beside the
// other /api/public/ routes, and reached from the nursery website through the
// same-origin nginx proxy that already forwards /api/public/.
//
// ── SHAPE ────────────────────────────────────────────────────────────────────
//   GET /api/public/terms                 JSON — version, full text, sections
//   GET /api/public/terms/section/:name   JSON — one section, e.g. "closures"
//   GET /api/public/terms/fragment        HTML — the website's clause accordion
//
// The fragment endpoint is the same HTML the publish writes into index.html. It
// exists so the generated file can be checked against what the server would
// produce, and so a site that would rather fetch than be rewritten can.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const termsDoc = require('../lib/terms-doc');

const TERMS_TITLE = 'Terms and Conditions';

// Small, honest cache. The document changes when a manager presses Publish —
// perhaps a few times a year — and this endpoint is hit by every visitor to the
// fees page. 60s is short enough that nobody waits for a correction and long
// enough that a burst of page loads is one query.
let CACHE = { at: 0, row: null };
const TTL_MS = 60 * 1000;

async function loadTerms() {
  if (CACHE.row && Date.now() - CACHE.at < TTL_MS) return CACHE.row;
  const { rows } = await getPool().query(
    `SELECT id, title, content, version, version_label, effective_date, published_at
       FROM policies
      WHERE title = $1 AND is_active = true AND parent_facing = true`, [TERMS_TITLE]);
  CACHE = { at: Date.now(), row: rows[0] || null };
  return CACHE.row;
}
// Publishing clears it, so an edit is visible immediately rather than up to a
// minute later. Exported rather than wired with an event so the call site is
// findable by grep.
function invalidate() { CACHE = { at: 0, row: null }; }

// pg hands a DATE back as a local-midnight JS Date. String(d).slice(0,10) gives
// "Fri Sep 04" and toISOString() can roll the day backwards; local getters are
// the only correct read (memory/reference_pg_date_ymd_trap.md).
const ymd = d => {
  if (!d) return null;
  const dt = d instanceof Date ? d : new Date(String(d) + 'T00:00:00');
  if (isNaN(dt)) return null;
  return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0');
};

const fmtDate = d => {
  if (!d) return null;
  // pg hands back DATE as a local-midnight Date — local getters only, never
  // toISOString() (memory/reference_pg_date_ymd_trap.md).
  const dt = d instanceof Date ? d : new Date(String(d) + 'T00:00:00');
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

function payload(row) {
  const parsed = termsDoc.parse(row.content);
  return {
    title: row.title,
    version: row.version,
    version_label: row.version_label || String(row.version),
    effective_date: ymd(row.effective_date),
    effective_date_display: fmtDate(row.effective_date),
    published_at: row.published_at,
    content: row.content,
    preamble: parsed.preamble,
    sections: parsed.sections.map(s => ({
      heading: s.heading,
      display: termsDoc.titleCase(s.heading),
      paragraphs: s.paragraphs,
    })),
  };
}

router.get('/api/public/terms', async (req, res) => {
  try {
    const row = await loadTerms();
    if (!row) return res.status(404).json({ error: 'not_published' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json(payload(row));
  } catch (e) {
    console.error('[public-terms] terms:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// One named section — what the guide, the fees page and the enrolment form use
// so that "the part about closures" is the document's own words.
router.get('/api/public/terms/section/:name', async (req, res) => {
  try {
    const row = await loadTerms();
    if (!row) return res.status(404).json({ error: 'not_published' });
    const s = termsDoc.section(row.content, String(req.params.name || '').replace(/[^a-z0-9 &-]/gi, ''));
    if (!s) return res.status(404).json({ error: 'no_such_section' });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      heading: s.heading,
      display: termsDoc.titleCase(s.heading),
      paragraphs: s.paragraphs,
      html: termsDoc.sectionHtml(row.content, req.params.name),
      version: row.version,
      version_label: row.version_label || String(row.version),
      effective_date_display: fmtDate(row.effective_date),
    });
  } catch (e) {
    console.error('[public-terms] section:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/api/public/terms/fragment', async (req, res) => {
  try {
    const row = await loadTerms();
    if (!row) return res.status(404).type('text/plain').send('not_published');
    res.set('Cache-Control', 'public, max-age=60');
    res.type('text/html').send(termsDoc.accordionHtml(row.content, {
      version: row.version, version_label: row.version_label,
      effective_date: fmtDate(row.effective_date),
    }));
  } catch (e) {
    console.error('[public-terms] fragment:', e.message);
    res.status(500).type('text/plain').send('error');
  }
});

module.exports = router;
module.exports.invalidate = invalidate;
module.exports.TERMS_TITLE = TERMS_TITLE;
