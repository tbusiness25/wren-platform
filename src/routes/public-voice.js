'use strict';
// ===========================================================================
// public-voice.js — b356 (2026-09-24). NO AUTH, rate-limited. Mounted with the other
// /api/public/* routers (public-availability, public-curriculum, public-terms), before the
// auth/offsite gates, so these are reachable from the public nursery website.
//
//   GET  /api/public/testimonials         approved family testimonials, for the website section
//   POST /api/public/ask-a-question       a prospective parent asks — genuinely no identity is
//                                          ever collected, so there is nothing to anonymise later
//
// The current-parent ANSWER side lives behind auth in parent-voice.js — a prospective family
// asking is public by definition, but only a logged-in current parent may answer.
// ===========================================================================
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { getPool } = require('../db/pool');

// 2026-10-20 (fix-feedback-voice): scoped to this router's own paths. Mounted at the app ROOT
// (server-unified.js, before the global express.json({limit:'20mb'})), an unscoped router.use(express.json)
// ran on EVERY request and, first parser wins, capped every JSON body in Wren at this limit — so
// every bug report with a screenshot (and any other JSON write over the cap) 413'd before auth.
router.use('/api/public', express.json({ limit: '16kb' }));

const askLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });

router.get('/api/public/testimonials', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, display_name, body FROM website_testimonials
        WHERE status = 'approved' ORDER BY display_order, submitted_at DESC LIMIT 60`);
    res.set('Cache-Control', 'public, max-age=120');
    res.json({ testimonials: rows });
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return res.json({ testimonials: [] });
    console.error('[public-voice] testimonials failed:', e.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

// POST /api/public/ask-a-question — a prospective parent, from the public website.
// honeypot field `website` (bots fill every field; a real visitor never sees it) mirrors the
// pattern in public-enquiry.js / public-availability.js.
router.post('/api/public/ask-a-question', askLimiter, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.status(201).json({ ok: true }); // honeypot tripped — pretend success, do nothing
  const body = String(b.body || '').replace(/\r\n?/g, '\n').trim();
  if (!body) return res.status(400).json({ error: 'empty', message: 'Write your question first.' });
  if (body.length > 1000) return res.status(400).json({ error: 'too_long', message: 'That is over 1000 characters — please shorten it.' });
  try {
    await getPool().query(
      `INSERT INTO parent_questions (body, asked_week) VALUES ($1, date_trunc('week', now() AT TIME ZONE 'Europe/London')::date)`,
      [body]);
    res.status(201).json({ ok: true, message: 'Thank you — a current parent will answer this soon.' });
  } catch (e) {
    if (e && (e.code === '42P01' || e.code === '42703')) return res.status(503).json({ error: 'schema_not_applied' });
    console.error('[public-voice] ask-a-question failed:', e.message);
    res.status(500).json({ error: 'Something went wrong.' });
  }
});

module.exports = router;
