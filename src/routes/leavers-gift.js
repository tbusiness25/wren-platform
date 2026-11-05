'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// Leavers keepsake — staff/manager side (PROMPT 46)
// Generates a rich, frozen memory package for a leaving child and mints a
// token-gated, no-login link (download + installable PWA). ADDITIVE. Reuses the
// leavers-book / memory-box / observations / first-words data via src/lib/keepsake.
// Mounted at /api/leavers-gift.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const K = require('../lib/keepsake');

router.use(authenticate);

// ── b343 (2026-09-21) — a room leader can make and send a memory book only for a child in their OWN room ─────────────────
// Toby: "Staff in the EY portal should be able to send them out (room leaders only)." Until now every route below let ANY
// room leader or senior practitioner mint, list and send for ANY child — there was simply no Roost/EY screen for them to do it
// from. The EY "Memory books" screen is that screen, so the rule is enforced HERE, on the server, on every call:
//
//   manager / deputy / admin / headteacher / business manager / owner   any child (unchanged)
//   room_leader, senior_practitioner   only a child whose room is the room THEY are set to lead (staff.room_id, re-read from the
//                                      database on every call — the JWT's room_id is frozen at login); anything else 403
//   everyone else (practitioner, apprentice, cook…)   403 — unchanged, mgtOnly below still says so
//
// "In their room" is the canonical room (src/lib/child-room.js: the booking is the truth, the profile only a fallback) as at the
// child's LEAVE DATE if they have already gone, else today — so a child who left last week is still in the room they left from.
// A room leader with no room set (staff.room_id is often NULL) leads nothing, and is told to ask the office rather than guessed.
const { canonicalRoom } = require('../lib/child-room');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js
const FULL_ACCESS = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager', 'owner'];
const ROOM_SCOPED = ['room_leader', 'senior_practitioner'];
const isRoomScoped = req => ROOM_SCOPED.includes(req.user && req.user.role);
const EMPTY_BOOK_MESSAGE = 'This keepsake holds no photos or videos — it would arrive as an empty memory book.';   // b326's words, unchanged

async function roomOfChild(db, childId) {
  const { rows: [c] } = await db.query(`SELECT to_char(leave_date, 'YYYY-MM-DD') AS ld FROM children WHERE id = $1`, [childId]);
  if (!c) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const on = c.ld && c.ld < today ? c.ld : today;
  return (await canonicalRoom(db, childId, on)).room_id;
}
async function guardChild(req, res, next, childId) {
  if (!isRoomScoped(req)) return next();
  const id = parseInt(childId, 10);
  if (!Number.isInteger(id)) return next();                 // the route itself will 404/400
  try {
    const room = await roomOfChild(getPool(), id);
    if (room == null || room !== req._leadRoom) {
      return res.status(403).json({ error: 'That child is not in your room.', reason: 'not_your_room' });
    }
    next();
  } catch (e) { console.error('[leavers-gift] room guard:', e.message); res.status(500).json({ error: 'Internal error' }); }
}
router.use(async (req, res, next) => {
  if (!isRoomScoped(req)) return next();
  try {
    const { rows: [st] } = await getPool().query(`SELECT room_id FROM staff WHERE id = $1 AND is_active = true`, [req.user.id]);
    req._leadRoom = st ? st.room_id : null;
  } catch (e) { return res.status(500).json({ error: 'Internal error' }); }
  if (req._leadRoom == null) {
    return res.status(403).json({ error: 'You are not set as the leader of a room. Please ask the office to set your room.', reason: 'no_room' });
  }
  // the two whole-nursery lists are the Roost view; a room leader has /room
  if (req.method === 'GET' && (req.path === '/packages' || req.path === '/candidates')) {
    return res.status(403).json({ error: 'Use the room list.', reason: 'room_list_only' });
  }
  next();
});
router.param('child_id', guardChild);
router.param('id', async (req, res, next, val) => {         // :id is a package id everywhere in this router
  if (!isRoomScoped(req)) return next();
  try {
    const { rows: [g] } = await getPool().query(`SELECT child_id FROM leavers_gift_packages WHERE id = $1`, [parseInt(val, 10) || 0]);
    if (!g) return next();                                  // the route answers 404
    return guardChild(req, res, next, g.child_id);
  } catch (e) { res.status(500).json({ error: 'Internal error' }); }
});

// When a room leader's attempt comes back empty the office is told (the parents' button does the same): a bell row to managers,
// no more than one per child per six hours so a repeated tap cannot flood the bell. No names in it.
async function tellOfficeEmpty(req, childId) {
  if (FULL_ACCESS.includes(req.user && req.user.role)) return;             // a manager's own attempt needs no notice to managers
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT 1 FROM notifications WHERE category = 'keepsake_empty' AND related_id = $1 AND created_at > now() - interval '6 hours' LIMIT 1`, [childId]);
    if (!rows.length) {
      require('../services/notification-dispatcher').notify('keepsake_empty', 'all-managers', null,
        'A room leader tried to make a memory book and it came back empty',
        'The photos have not synced for this child. Nothing was sent. Check the EyLog media sync, then make the book in Roost.',
        { relatedTable: 'children', relatedId: childId, link: `/child-profile.html?id=${childId}` });
    }
    await recordAudit({ req, action: 'refuse', entity_type: 'leavers_gift', entity_id: childId, meta: { child_id: childId, reason: 'no_media', room_leader: true } });
  } catch (e) { console.error('[leavers-gift] tell office:', e.message); }
}

// Minting a public no-login link is a management action.
const MGT = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager', 'room_leader', 'senior_practitioner'];
const mgtOnly = (req, res, next) =>
  hasRole(req.user, MGT) ? next() : res.status(403).json({ error: 'Manager or key-person access required' });

const newToken = () => crypto.randomBytes(24).toString('base64url');

// ── GET /gift/:child_id/preview — what a keepsake would contain (no package minted) ──
router.get('/gift/:child_id/preview', mgtOnly, async (req, res) => {
  try {
    const snap = await K.gatherSnapshot(getPool(), req.params.child_id);
    if (!snap) return res.status(404).json({ error: 'Child not found' });
    res.json({ child: snap.child, stats: snap.stats, has_farewell: !!(snap.farewell && (snap.farewell.ai_highlights || snap.farewell.staff_farewell)) });
  } catch (e) { console.error('[leavers-gift] preview:', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /gift/:child_id — latest package for a child (so the UI can show the link) ──
router.get('/gift/:child_id', mgtOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT id, token, status, title, media_count, expires_at, created_at, created_by_name,
              last_accessed_at, access_count, sent_at, sent_to
         FROM leavers_gift_packages
        WHERE child_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.params.child_id]);
    // 2026-10-08: the page built the share link from location.origin — on Roost that is the
    // admin host, which only Toby can pass. Same fix as /packages: the server owns the base.
    res.json({ package: rows[0] || null, public_base: process.env.KEEPSAKE_PUBLIC_BASE || 'https://parents.example-nursery.co.uk' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /gift/:child_id/generate — freeze a snapshot + mint a fresh token ────────
router.post('/gift/:child_id/generate', mgtOnly, async (req, res) => {
  const childId = parseInt(req.params.child_id, 10);
  const validDays = Math.min(Math.max(parseInt(req.body?.valid_days, 10) || 365, 7), 3650);
  try {
    const db = getPool();
    // b341 — the mint itself (snapshot through the group-media gate, retire the previous active
    // link, insert the new one, one transaction) lives in src/lib/keepsake-mint.js so the
    // parents' "Create my memory book" button calls exactly the same routine.
    const minted = await require('../lib/keepsake-mint').mintPackage(db, {
      childId, validDays, source: 'staff',
      createdBy: req.user?.id || null, createdByName: req.user?.name || req.user?.email || 'staff',
      requireMedia: isRoomScoped(req),           // b343 — a manager's Roost button is unchanged; a room leader never mints an empty book
    });
    if (!minted.ok && minted.reason === 'no_media') {
      await tellOfficeEmpty(req, childId);
      return res.status(409).json({ error: EMPTY_BOOK_MESSAGE, reason: 'no_media', media_count: 0, child_id: childId, can_override: false,
        hint: 'Nothing was made. The office has been told and will check the photo sync.' });
    }
    if (!minted.ok) return res.status(404).json({ error: 'Child not found' });
    const pkg = minted.package, token = pkg.token;

    await recordAudit({ req, action: 'create', entity_type: 'leavers_gift', entity_id: pkg.id,
      meta: { child_id: childId, media: pkg.media_count, valid_days: validDays } });

    res.json({ package: pkg, keepsake_url: `/keepsake/${token}`, download_url: `/keepsake/${token}/download` });
  } catch (e) { console.error('[leavers-gift] generate:', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /packages — list minted keepsakes ─────────────────────────────────────
router.get('/packages', mgtOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT g.id, g.child_id, g.token, g.status, g.title, g.media_count, g.expires_at,
              g.created_at, g.created_by_name, g.last_accessed_at, g.access_count,
              g.sent_at, g.sent_to, g.sent_count,
              c.first_name, c.last_name, c.preferred_name,
              COALESCE(c.parent_1_email, c.primary_contact_email) AS parent_email
         FROM leavers_gift_packages g
         LEFT JOIN children c ON c.id = g.child_id
        ORDER BY g.created_at DESC LIMIT 200`);
    // 2026-09-24 — the page used to build the link itself as location.origin with 'admin.'
    // swapped for 'ey.', which ignored KEEPSAKE_PUBLIC_BASE entirely: the email said parents
    // and the Copy link button said ey, and Toby copied the wrong one. The server owns the
    // base now, so there is one answer and the page cannot disagree with the email.
    res.json({ packages: rows, public_base: process.env.KEEPSAKE_PUBLIC_BASE || 'https://parents.example-nursery.co.uk' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /packages/:id/revoke — kill a link ───────────────────────────────────
router.post('/packages/:id/revoke', mgtOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE leavers_gift_packages SET status='revoked' WHERE id=$1 RETURNING id, child_id, status`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    await recordAudit({ req, action: 'update', entity_type: 'leavers_gift', entity_id: req.params.id, meta: { revoked: true } });
    res.json({ ok: true, package: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /packages/:id — remove a keepsake record for good ──────────────────
// 2026-09-22 (Toby: "I think I've just minted a few of them, but there's no way to delete").
// Regenerating retires the previous link and mints a new one, so a child regenerated seven
// times leaves six dead rows behind and only revoke existed. This deletes one, with two
// refusals that matter:
//   • the child's CURRENT active link is never deleted — revoke it first, so nobody
//     silently destroys the link a family is holding;
//   • a link a family has actually OPENED is never deleted — that is their book, and the
//     record of them opening it is the only proof we sent it. Revoke stops the link; the
//     row stays.
// Managers only: a room leader can make and send books, not destroy the record of one.
router.delete('/packages/:id', mgtOnly, async (req, res) => {
  if (!hasRole(req.user, FULL_ACCESS)) {
    return res.status(403).json({ error: 'Only a manager can delete a keepsake record.' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT id, child_id, status, access_count, sent_at, media_count FROM leavers_gift_packages WHERE id = $1`,
      [parseInt(req.params.id, 10) || 0]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const pkg = rows[0];
    if (pkg.status === 'active') {
      return res.status(409).json({ error: 'This is the live link for this child. Revoke it first, then delete it.', reason: 'active' });
    }
    if ((pkg.access_count || 0) > 0) {
      return res.status(409).json({
        error: 'The family has opened this memory book, so the record stays. Revoking has already stopped the link working.',
        reason: 'opened' });
    }
    await db.query(`DELETE FROM leavers_gift_packages WHERE id = $1`, [pkg.id]);
    await recordAudit({ req, action: 'delete', entity_type: 'leavers_gift', entity_id: pkg.id,
      meta: { child_id: pkg.child_id, status: pkg.status, media: pkg.media_count, sent: !!pkg.sent_at } });
    res.json({ ok: true, deleted: pkg.id, child_id: pkg.child_id });
  } catch (e) { console.error('[leavers-gift] delete:', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /packages/:id/download — staff preview of the self-contained HTML book ──
router.get('/packages/:id/download', mgtOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT snapshot, title FROM leavers_gift_packages WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const html = K.renderStandaloneBook(rows[0].snapshot);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${(rows[0].title || 'memory-book').replace(/[^a-z0-9]+/gi, '-')}.html"`);
    res.send(html);
  } catch (e) { console.error('[leavers-gift] download:', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /packages/:id/book.zip — the memory book as a folder the family keeps ──
// 2026-09-23. The one we actually want families to have: index.html plus a media folder,
// in a single zip. They unzip it, double-click, and it opens in any browser with the
// photographs AND the videos playing — no app, no internet, nothing hosted by us, and it
// still works in ten years. The PDF stays for printing; the single-file HTML stays for
// small books. See src/lib/keepsake-zip.js for why it is built by hand.
router.get('/packages/:id/book.zip', mgtOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT snapshot, title FROM leavers_gift_packages WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const snap = rows[0].snapshot;
    const fs = require('fs');
    const { buildZip } = require('../lib/keepsake-zip');

    // Media lives beside the page, so the HTML just points at ./media/<file>.
    const entries = [];
    const seen = new Set();
    const all = [...(snap.media || [])];
    if (snap.child && snap.child.photo) all.unshift({ basename: snap.child.photo.basename });
    let bytes = 0, missing = 0;
    for (const m of all) {
      if (!m || !m.basename || seen.has(m.basename)) continue;
      const p = K.resolveMediaPath(m.basename);
      if (!p) { missing++; continue; }
      let st; try { st = fs.statSync(p); } catch (_) { missing++; continue; }
      seen.add(m.basename);
      entries.push({ name: 'media/' + m.basename, file: p });
      bytes += st.size;
    }
    const html = K.wrapDocument(
      K.renderBookInner(snap, (b) => (seen.has(b) ? './media/' + encodeURIComponent(b) : null)),
      `${snap.child.display_name} — My Your Nursery Memory Book`);
    entries.unshift({ name: 'index.html', data: html });
    entries.push({ name: 'READ ME FIRST.txt', data:
      `${snap.child.display_name}'s Memory Book\r\n` +
      `${'='.repeat(40)}\r\n\r\n` +
      `1. Unzip this folder (right-click and choose Extract All, or just double-tap on a phone).\r\n` +
      `2. Open "index.html". It opens in whatever web browser you already have.\r\n` +
      `3. That is it. The photographs and videos are in the "media" folder next to it — keep them\r\n` +
      `   together and the book works with no internet, on any device, for as long as you keep it.\r\n\r\n` +
      `There ${seen.size === 1 ? 'is 1 file' : `are ${seen.size} files`} in this book.\r\n\r\n` +
      `With love from everyone at Your Nursery.\r\n` });

    const zip = buildZip(entries);
    const name = (rows[0].title || 'memory-book').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
    if (missing) console.warn(`[leavers-gift] zip ${req.params.id}: ${missing} media file(s) not on disk`);
    await recordAudit({ req, action: 'download', entity_type: 'leavers_gift', entity_id: req.params.id,
      meta: { format: 'zip', files: seen.size, bytes } }).catch(() => {});
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.zip"`);
    res.setHeader('Content-Length', zip.length);
    res.send(zip);
  } catch (e) { console.error('[leavers-gift] zip:', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /packages/:id/book.pdf — staff preview of the PDF keepsake ────────────
router.get('/packages/:id/book.pdf', mgtOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT snapshot, title FROM leavers_gift_packages WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const pdf = await K.renderBookPDF(rows[0].snapshot);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(rows[0].title || 'memory-book').replace(/[^a-z0-9]+/gi, '-')}.pdf"`);
    res.send(pdf);
  } catch (e) { console.error('[leavers-gift] pdf:', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /room — one room's leavers, for the EY "Memory books" screen (b343) ─────────────────────────────────
// A room leader gets THEIR room. A manager or deputy chooses one (?room_id=, default the first). Leavers = leave date within the
// last 60 days or the next 90. Each carries what the one button beside it should do; no family address is ever returned.
router.get('/room', mgtOnly, async (req, res) => {
  try {
    const db = getPool();
    const rooms = (await db.query(`SELECT id, COALESCE(display_name, name) AS name FROM rooms ORDER BY id`)).rows;
    let roomId = isRoomScoped(req) ? req._leadRoom : (parseInt(req.query.room_id, 10) || (rooms[0] && rooms[0].id) || null);
    const room = rooms.find(r => r.id === roomId) || null;
    if (!room) return res.json({ room: null, rooms: isRoomScoped(req) ? [] : rooms, children: [] });
    const { rows } = await db.query(`
      SELECT c.id AS child_id, c.first_name, c.last_name, c.preferred_name, to_char(c.leave_date, 'YYYY-MM-DD') AS leave_date,
             (COALESCE(nullif(btrim(c.parent_1_email), ''), nullif(btrim(c.primary_contact_email), '')) IS NOT NULL) AS has_email,
             g.id AS package_id, g.media_count, g.sent_at, g.sent_count,
             jsonb_array_length(COALESCE(g.snapshot->'media', '[]'::jsonb)) AS snapshot_media
        FROM children c
        LEFT JOIN LATERAL (SELECT * FROM leavers_gift_packages g0
                            WHERE g0.child_id = c.id AND g0.status = 'active' AND (g0.expires_at IS NULL OR g0.expires_at > now())
                            ORDER BY g0.created_at DESC LIMIT 1) g ON true
       WHERE c.leave_date IS NOT NULL AND COALESCE(c.is_demo, false) = false
         AND c.leave_date >= CURRENT_DATE - 60 AND c.leave_date <= CURRENT_DATE + 90
       ORDER BY c.leave_date, c.first_name, c.id`);
    const children = [];
    for (const r of rows) {
      if ((await roomOfChild(db, r.child_id)) !== room.id) continue;
      const held = r.package_id ? Number(r.snapshot_media || 0) : null;
      const state = !r.package_id ? 'none' : held === 0 ? 'empty' : r.sent_at ? 'sent' : 'ready';
      children.push({
        child_id: r.child_id, name: [r.preferred_name || r.first_name, r.last_name].filter(Boolean).join(' '), leave_date: r.leave_date,
        state, package_id: r.package_id || null, media_count: held, sent_at: r.sent_at || null, sent_count: r.sent_count || 0, has_email: !!r.has_email,
        can_generate: state === 'none' || state === 'empty', can_send: (state === 'ready' || state === 'sent') && !!r.has_email,
      });
    }
    res.json({ room, rooms: isRoomScoped(req) ? [] : rooms, children });
  } catch (e) { console.error('[leavers-gift] room:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

// ── GET /candidates — this-year leavers WITHOUT an active keepsake ────────────
router.get('/candidates', mgtOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT c.id AS child_id, c.first_name, c.last_name, c.preferred_name, c.leave_date,
             COALESCE(c.parent_1_email, c.primary_contact_email) AS parent_email,
             (SELECT count(*) FROM observations o WHERE o.child_id=c.id AND o.photo_urls IS NOT NULL AND array_length(o.photo_urls,1)>0) AS photo_obs
        FROM children c
       WHERE c.leave_date IS NOT NULL AND COALESCE(c.is_demo,false)=false
         AND c.leave_date >= date_trunc('year', CURRENT_DATE)
         AND NOT EXISTS (SELECT 1 FROM leavers_gift_packages g WHERE g.child_id=c.id AND g.status='active')
       ORDER BY c.leave_date`);
    res.json({ candidates: rows });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Roles allowed to overrule the empty-keepsake guard below. Narrower than MGT on purpose:
// room leaders and senior practitioners can mint and send a keepsake, but sending a memory
// book with nothing in it is a decision for the person who runs the setting.
const OVERRIDE_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager'];

// ── POST /packages/:id/send — email the keepsake link to the family ───────────
router.post('/packages/:id/send', mgtOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT g.id, g.token, g.status, g.title, g.media_count, g.expires_at, g.child_id,
             jsonb_array_length(COALESCE(g.snapshot->'media','[]'::jsonb)) AS snapshot_media,
             c.first_name, c.preferred_name,
             COALESCE(c.parent_1_email, c.primary_contact_email) AS parent_email, c.parent_1_name
        FROM leavers_gift_packages g LEFT JOIN children c ON c.id=g.child_id
       WHERE g.id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Keepsake not found' });
    const p = rows[0];
    if (p.status !== 'active') return res.status(400).json({ error: `Keepsake is ${p.status} — regenerate before sending.` });

    // b326 — a family should never be emailed an empty memory book. media_count can go
    // stale (it is written at generate time), so the frozen snapshot is the authority.
    const mediaHeld = Number(p.snapshot_media || 0);
    if (mediaHeld === 0 && !(req.body && req.body.confirm_no_photos === true)) {
      await tellOfficeEmpty(req, p.child_id);
      return res.status(409).json({
        error: EMPTY_BOOK_MESSAGE,
        reason: 'no_media',
        media_count: 0,
        child_id: p.child_id,
        hint: 'Run the EyLog media sync and regenerate the keepsake first. To send it anyway, '
            + 're-send with confirm_no_photos: true (manager only).',
        can_override: hasRole(req.user, OVERRIDE_ROLES),
      });
    }
    if (mediaHeld === 0 && !hasRole(req.user, OVERRIDE_ROLES)) {
      return res.status(403).json({
        error: 'Sending a keepsake with no photos needs a manager.',
        reason: 'no_media_override_denied',
      });
    }

    // b343 — a room leader sends to the family's address on file, never to one typed into the request
    const to = (!isRoomScoped(req) && req.body && req.body.email) || p.parent_email;
    if (!to) return res.status(400).json({ error: 'No parent email on file — add one to the child, or pass an email.' });

    const base = process.env.KEEPSAKE_PUBLIC_BASE || 'https://parents.example-nursery.co.uk';
    const url = `${base}/keepsake/${p.token}`;
    const childName = p.preferred_name || p.first_name || 'your child';
    // b341 — the send is the shared one (src/lib/keepsake-mint.js). The old inline block set
    // sent = true whenever sendViaGmail did not throw, including the dev "mail-disabled" reply,
    // so a dev send reported emailed:true. It also now says when the link expires.
    const mail = await require('../lib/keepsake-mint').sendLinkEmail({
      to, token: p.token, childName, expiresAt: p.expires_at, eventType: 'keepsake-link-staff' });
    const sent = mail.sent;
    const err = mail.error || (mail.disabled ? 'mail is disabled in this environment' : null);
    await db.query(`UPDATE leavers_gift_packages SET sent_at=now(), sent_to=$2, sent_count=COALESCE(sent_count,0)+1 WHERE id=$1`, [p.id, to]);
    await recordAudit({ req, action: 'send', entity_type: 'leavers_gift', entity_id: p.id,
      meta: { child_id: p.child_id, to, media: mediaHeld, ...(mediaHeld === 0 ? { sent_empty_override: true } : {}) } });
    if (!sent) return res.status(200).json({ ok: true, emailed: false, to, note: 'Recorded, but email not sent (mail not configured / ' + (err || 'no sender') + '). Copy the link and share it manually.', keepsake_url: url });
    res.json({ ok: true, emailed: true, to, keepsake_url: url });
  } catch (e) { console.error('[leavers-gift] send:', e.message); res.status(500).json({ error: e.message }); }
});

// ── Restore keepsake access (2026-10-08) ────────────────────────────────────────
// Toby: "a parent says they don't have access to their memory journey anymore … I need an
// option to re-add them, or re-allow them an extra 20 days." The link itself is token-gated,
// but the parents domain sits behind Cloudflare Access, which only admits addresses on the
// allowlist — so a family whose address isn't on file (or was typed in on Send) can't reach
// it. Restore: re-opens the link if it expired or was withdrawn (unless a newer one replaced
// it), extends it by N days, adds any addresses the manager types to the family's allowlist
// for as long as the link lives (extra_emails), pushes the allowlist to Cloudflare now rather
// than at 07:17, and — only if ticked — emails the link. Managers only: adding an address
// to the edge allowlist is an access decision.
const EMAIL_OK = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
async function familyAddresses(db, pkgId) {
  const { rows } = await db.query(`
    SELECT g.id, g.child_id, g.status, g.expires_at, g.sent_to, COALESCE(g.extra_emails, '{}') AS extra_emails,
           c.parent_1_email, c.parent_2_email, c.primary_contact_email, c.preferred_name, c.first_name,
           (SELECT array_agg(DISTINCT lower(trim(pa.email))) FROM parent_portal_access pa
             WHERE pa.child_id = g.child_id AND pa.email IS NOT NULL AND pa.email NOT LIKE 'erased-%') AS portal_emails,
           EXISTS (SELECT 1 FROM leavers_gift_packages n WHERE n.child_id = g.child_id AND n.id <> g.id
                    AND n.status = 'active' AND (n.expires_at IS NULL OR n.expires_at > now())) AS superseded
      FROM leavers_gift_packages g LEFT JOIN children c ON c.id = g.child_id WHERE g.id = $1`, [pkgId]);
  if (!rows.length) return null;
  const r = rows[0];
  const on_file = [...new Set([r.parent_1_email, r.parent_2_email, r.primary_contact_email, r.sent_to, ...(r.portal_emails || [])]
    .filter(Boolean).map(e => String(e).trim().toLowerCase()).filter(e => EMAIL_OK.test(e)))];
  return { ...r, on_file, extra_emails: r.extra_emails || [] };
}

router.get('/packages/:id/access', mgtOnly, async (req, res) => {
  if (!hasRole(req.user, FULL_ACCESS)) return res.status(403).json({ error: 'Managers only.' });
  try {
    const f = await familyAddresses(getPool(), req.params.id);
    if (!f) return res.status(404).json({ error: 'Keepsake not found' });
    res.json({ id: f.id, status: f.status, expires_at: f.expires_at, superseded: f.superseded,
      on_file: f.on_file, extra_emails: f.extra_emails, sent_to: f.sent_to });
  } catch (e) { console.error('[leavers-gift] access:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

router.post('/packages/:id/restore', mgtOnly, async (req, res) => {
  if (!hasRole(req.user, FULL_ACCESS)) return res.status(403).json({ error: 'Managers only.' });
  const db = getPool();
  try {
    const f = await familyAddresses(db, req.params.id);
    if (!f) return res.status(404).json({ error: 'Keepsake not found' });
    if (f.status !== 'active' && f.superseded) {
      return res.status(409).json({ error: 'A newer keepsake link has replaced this one — restore that one instead.' });
    }
    const days = Math.max(1, Math.min(400, parseInt((req.body && req.body.days) || 20, 10) || 20));
    const typed = [].concat((req.body && req.body.emails) || []).join(',').split(/[\s,;]+/)
      .map(e => e.trim().toLowerCase()).filter(Boolean);
    const bad = typed.filter(e => !EMAIL_OK.test(e));
    if (bad.length) return res.status(400).json({ error: `Not an email address: ${bad.join(', ')}` });
    const added = typed.filter(e => !f.on_file.includes(e) && !f.extra_emails.includes(e));

    const { rows } = await db.query(`
      UPDATE leavers_gift_packages
         SET status = 'active',
             expires_at = GREATEST(COALESCE(expires_at, now()), now() + make_interval(days => $2)),
             extra_emails = ARRAY(SELECT DISTINCT unnest(COALESCE(extra_emails, '{}') || $3::text[]))
       WHERE id = $1
       RETURNING id, child_id, token, status, expires_at, extra_emails`, [f.id, days, added]);
    const pkg = rows[0];

    let allowlist;
    try {
      const n = await Promise.race([require('../lib/cf-allowlist').syncCFAllowlist(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Cloudflare did not answer in 20s')), 20000))]);
      allowlist = { synced: true, addresses: n };
    } catch (e) {
      console.error('[leavers-gift] restore: allowlist push failed:', e.message);
      allowlist = { synced: false, error: 'Cloudflare not updated yet (' + e.message + ') — the 07:17 sync will add them.' };
    }

    const sent = [];
    if (req.body && req.body.send === true) {
      const to = typed.length ? typed : (f.sent_to ? [f.sent_to] : f.on_file.slice(0, 1));
      for (const addr of to) {
        const mail = await require('../lib/keepsake-mint').sendLinkEmail({
          to: addr, token: pkg.token, childName: f.preferred_name || f.first_name || 'your child',
          expiresAt: pkg.expires_at, eventType: 'keepsake-link-staff' });
        sent.push({ to: addr, emailed: !!mail.sent, note: mail.error || (mail.disabled ? 'mail disabled here' : undefined) });
        if (mail.sent) await db.query(`UPDATE leavers_gift_packages SET sent_at=now(), sent_to=$2, sent_count=COALESCE(sent_count,0)+1 WHERE id=$1`, [pkg.id, addr]);
      }
    }
    await recordAudit({ req, action: 'update', entity_type: 'leavers_gift', entity_id: pkg.id,
      meta: { restored: true, from_status: f.status, days, added_emails: added.length, emailed: sent.filter(x => x.emailed).length, allowlist_synced: allowlist.synced } });
    const base = process.env.KEEPSAKE_PUBLIC_BASE || 'https://parents.example-nursery.co.uk';
    res.json({ ok: true, package: { id: pkg.id, status: pkg.status, expires_at: pkg.expires_at },
      keepsake_url: `${base}/keepsake/${pkg.token}`, admitted: [...new Set([...f.on_file, ...pkg.extra_emails])],
      added, allowlist, sent });
  } catch (e) { console.error('[leavers-gift] restore:', e.message); res.status(500).json({ error: 'Internal error' }); }
});

module.exports = router;
