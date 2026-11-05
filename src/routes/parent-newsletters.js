'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b263 — the parents' newsletter archive.
//
// Email is not a record. A family who deleted the email, or whose phone filed it
// under Promotions, has nowhere to look; and the whole point of sending six of
// these a year is that they accumulate into something.
//
// ── WHAT A PARENT SEES, AND WHY IT IS SCOPED THIS WAY ────────────────────────
// Exactly the newsletters that were SENT TO THEM — one row per newsletter in
// newsletter_sends carrying their address. Not "every newsletter": the audience
// picker can target 'just_left' or 'waiting_list' or 'staff', and a newsletter
// aimed at families who have left is not for the current parent body to browse.
// Scoping on the send record means the archive inherits whatever the audience
// was, automatically, with no second list of rules to keep in step.
//
// That also makes the app/email/both preference work properly: a parent who
// chose app-only still gets a newsletter_sends row (status 'app_only'), so the
// newsletter appears here even though no email was sent to them. The preference
// changes the delivery channel, not whether they are a recipient.
//
// ── WHY IT RE-RENDERS INSTEAD OF SERVING newsletters.rendered_html ───────────
// rendered_html is a frozen string from send time. If a family withdraws photo
// consent afterwards, that string still contains their child's name, and serving
// it would mean Wren's own permanent record ignoring a live withdrawal. So the
// archive re-renders from newsletter_sections through regateSectionsForRender()
// — the same gate the send path uses. The email that already went out cannot be
// recalled; the record we control can, and therefore should, stay current.
//
// (Contrast b246's termly update, which links a PDF rather than rendering: that
// is a per-child report and falls under the b238 "no report content living as a
// web page" rule. A newsletter is a broadcast bulletin — no per-child data
// beyond consented first names — so rendering it here is the right shape.)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const parentRouter = express.Router();

const { getPool } = require('../db/pool');
const { parentEmailOf } = require('../lib/parent-identity');
const { renderNewsletter } = require('../newsletter-renderer');
const { regateSectionsForRender } = require('../lib/newsletter-consent');

// GET /welcome/newsletters/api/list — the newsletters this family was sent.
parentRouter.get('/list', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const { rows } = await getPool().query(`
      SELECT n.id, n.title, n.subject, n.term, n.academic_year,
             n.sent_at, max(s.status) AS delivery,
             min(s.sent_at) AS recorded_at
        FROM newsletter_sends s
        JOIN newsletters n ON n.id = s.newsletter_id
       WHERE lower(s.parent_email) = lower($1)
         AND n.status = 'sent'
         -- b295: staff newsletters record their recipients in
         -- ladn.staff_newsletter_sends, not here, so they cannot appear in this
         -- join at all. Stated anyway: the ownership check is an email address,
         -- and a staff member's personal address can also be a parent's.
         AND COALESCE(n.audience,'parents') = 'parents'
       GROUP BY n.id, n.title, n.subject, n.term, n.academic_year, n.sent_at
       ORDER BY n.sent_at DESC NULLS LAST, n.id DESC
       LIMIT 60`, [email]);
    res.json({ newsletters: rows });
  } catch (e) {
    console.error('[b263 parent archive] list failed:', e.message);
    res.status(500).json({ error: 'Could not load newsletters' });
  }
});

// GET /welcome/newsletters/api/:id/html — one newsletter, re-rendered and
// re-gated. Ownership is the send record: no row for this address, no access.
parentRouter.get('/:id/html', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).send('Not authenticated');
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).send('Bad request');
  try {
    const db = getPool();
    const { rows: own } = await db.query(`
      SELECT 1 FROM newsletter_sends
       WHERE newsletter_id=$1 AND lower(parent_email)=lower($2) LIMIT 1`, [id, email]);
    if (!own.length) return res.status(404).send('Not found');

    const { rows: nl } = await db.query(
      "SELECT * FROM newsletters WHERE id=$1 AND status='sent' "
      + "AND COALESCE(audience,'parents') = 'parents'", [id]);   // b295
    if (!nl.length) return res.status(404).send('Not found');

    const { rows: sections } = await db.query(
      'SELECT * FROM newsletter_sections WHERE newsletter_id=$1 ORDER BY section_order, id', [id]);

    // Same gate as every other render path — see the header note above.
    const html = renderNewsletter(nl[0], await regateSectionsForRender(db, sections));
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'private, no-store');
    res.send(html);
  } catch (e) {
    console.error('[b263 parent archive] render failed:', e.message);
    res.status(500).send('Could not load this newsletter');
  }
});

module.exports = { parentRouter };
