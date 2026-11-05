'use strict';
/**
 * calendar-ics.js — b518 (2026-10-20)
 *
 * Read-only, token-protected iCal feeds, one per calendar layer, so Toby, the office manager
 * and the admissions lead can subscribe on their phones:
 *
 *   GET /api/public/calendar/:token.ics
 *
 * The token IS the authorisation (a 32-char base64url secret in
 * ladn.calendar_feed_tokens, scope 'cal-nursery' / 'cal-parents' / 'cal-managers',
 * minted per staff member by /api/calendar-hub/feeds and revocable from the same
 * page). It sits under /api/public/ for one reason: a calendar client sends no
 * JWT and no device header, and /api/public/ is the one prefix the device gate
 * exempts. Nothing else about it is public — an unknown token is a flat 404 with
 * no hint, and the feed is GET-only.
 *
 * WHAT A FEED CARRIES
 *   nursery  — the internal layer: staff meetings, visits, appointments,
 *              inspections, supplier visits, trips, opted-in staff birthdays.
 *   parents  — term dates, closures, inset days, stay-and-play, events, and the
 *              weekly planning overlay (theme + activities per day).
 *   managers — the managers' own layer. Minted only for a member of the hub.
 *
 * NO CHILD'S NAME, no parent's name and no child id is ever in a feed: every item
 * comes from src/lib/calendar-layers.js, which never selects one.
 *
 * Google Calendar sync (src/routes/google-cal.js) is untouched and keeps working
 * the way it does.
 */

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const CL = require('../lib/calendar-layers');
const { buildCalendar } = require('../lib/ical-builder');

const SCOPE_LAYER = { 'cal-nursery': 'nursery', 'cal-parents': 'parents', 'cal-managers': 'managers' };
const LAYER_NAME = {
  nursery: 'Your Nursery — Nursery (internal)',
  parents: 'Your Nursery — What’s on',
  managers: 'Your Nursery — Managers',
};

router.get('/api/public/calendar/:token.ics', async (req, res) => {
  const token = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return res.status(404).end();
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT scope, entity_id FROM calendar_feed_tokens
        WHERE token = $1 AND scope = ANY($2::varchar[]) LIMIT 1`,
      [token, Object.keys(SCOPE_LAYER)]);
    if (!rows.length) return res.status(404).end();
    const layer = SCOPE_LAYER[rows[0].scope];

    // A managers feed stays valid only while its owner is still in the hub.
    if (layer === 'managers') {
      const hub = await CL.managersHubIds(db);
      if (!hub.includes(Number(rows[0].entity_id))) return res.status(404).end();
    }

    // A rolling window: three months back, a year ahead. Enough for a phone, and
    // small enough that a client refetching every hour costs nothing.
    const today = new Date();
    const from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 3, 1)).toISOString().slice(0, 10);
    const to   = new Date(Date.UTC(today.getUTCFullYear() + 1, today.getUTCMonth(), 1)).toISOString().slice(0, 10);

    const items = await CL.collect(db, {
      from, to, layers: [layer],
      // The feed is a subscription, not a session: ask for exactly this layer and
      // nothing else, with a synthetic actor that can read it and no more.
      user: { id: Number(rows[0].entity_id), role: layer === 'managers' ? 'manager' : 'practitioner' },
      portal: 'feed',
      includePlanning: layer === 'parents',
      // The parents feed is a public subscription: published rows and published
      // term plans only, exactly what a family sees in the portal.
      publicView: layer === 'parents',
    });

    const events = items
      .filter(i => i.layer === layer)
      .map(i => {
        const allDay = !i.start_time;
        const dtstart = allDay ? i.date : `${i.date}T${i.start_time}:00`;
        let dtend = null;
        if (!allDay && i.end_time) dtend = `${i.end_date || i.date}T${i.end_time}:00`;
        else if (allDay && i.end_date && i.end_date !== i.date) {
          // RFC 5545: an all-day DTEND is exclusive, so add a day.
          const d = new Date(i.end_date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1);
          dtend = d.toISOString().slice(0, 10);
        }
        const desc = i.overlay
          ? [i.theme ? 'Theme: ' + i.theme : null,
             i.activities && i.activities.length ? 'Activities: ' + i.activities.join('; ') : null,
             i.resources && i.resources.length ? 'Resources: ' + i.resources.join('; ') : null,
             i.room_name ? 'Room: ' + i.room_name : null].filter(Boolean).join('\n')
          : [i.category_label || null, i.description || null].filter(Boolean).join(' — ');
        return {
          uid: `b518-${i.key.replace(/[^A-Za-z0-9:_-]/g, '')}@example-nursery.co.uk`,
          // No emoji in SUMMARY: src/lib/ical-builder.js folds at 75 CHARACTERS and
          // RFC 5545 counts 75 OCTETS, so a multi-byte glyph can push a folded line
          // over the limit. The category is in DESCRIPTION instead, which is where a
          // phone shows it anyway.
          summary: i.title,
          description: desc,
          location: i.location || null,
          allDay,            // ical-builder keys VALUE=DATE off this, not off the string
          dtstart, dtend,
        };
      });

    const ics = buildCalendar({
      name: LAYER_NAME[layer],
      description: `${LAYER_NAME[layer]} — read-only feed from Wren`,
      events,
    });
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="wren-${layer}.ics"`);
    res.setHeader('Cache-Control', 'private, max-age=900');
    res.send(ics);
  } catch (e) {
    console.error('[calendar-ics]', e.message);
    res.status(500).type('text/plain').send('Calendar unavailable');
  }
});

module.exports = router;
