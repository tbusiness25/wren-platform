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

// Minting a public no-login link is a management action.
const MGT = ['manager', 'deputy_manager', 'admin', 'headteacher', 'business_manager', 'room_leader', 'senior_practitioner'];
const mgtOnly = (req, res, next) =>
  MGT.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Manager or key-person access required' });

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
              last_accessed_at, access_count
         FROM leavers_gift_packages
        WHERE child_id = $1 ORDER BY created_at DESC LIMIT 1`, [req.params.child_id]);
    res.json({ package: rows[0] || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /gift/:child_id/generate — freeze a snapshot + mint a fresh token ────────
router.post('/gift/:child_id/generate', mgtOnly, async (req, res) => {
  const childId = parseInt(req.params.child_id, 10);
  const validDays = Math.min(Math.max(parseInt(req.body?.valid_days, 10) || 365, 7), 3650);
  try {
    const db = getPool();
    const snap = await K.gatherSnapshot(db, childId);
    if (!snap) return res.status(404).json({ error: 'Child not found' });

    // one active link per child — retire any previous active ones
    await db.query(`UPDATE leavers_gift_packages SET status='revoked' WHERE child_id=$1 AND status='active'`, [childId]);

    const token = newToken();
    const title = `${snap.child.display_name} — My Your Nursery Memory Book`;
    const { rows } = await db.query(
      `INSERT INTO leavers_gift_packages
         (child_id, token, status, title, snapshot, media_count, expires_at, created_by, created_by_name)
       VALUES ($1,$2,'active',$3,$4::jsonb,$5, now() + ($6 || ' days')::interval, $7, $8)
       RETURNING id, token, status, title, media_count, expires_at, created_at`,
      [childId, token, title, JSON.stringify(snap), (snap.media || []).length, String(validDays),
       req.user?.id || null, req.user?.name || req.user?.email || 'staff']);

    await recordAudit({ req, action: 'create', entity_type: 'leavers_gift', entity_id: rows[0].id,
      meta: { child_id: childId, media: rows[0].media_count, valid_days: validDays } });

    res.json({ package: rows[0], keepsake_url: `/keepsake/${token}`, download_url: `/keepsake/${token}/download` });
  } catch (e) { console.error('[leavers-gift] generate:', e.message); res.status(500).json({ error: e.message }); }
});

// ── GET /packages — list minted keepsakes ─────────────────────────────────────
router.get('/packages', mgtOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT g.id, g.child_id, g.token, g.status, g.title, g.media_count, g.expires_at,
              g.created_at, g.created_by_name, g.last_accessed_at, g.access_count,
              c.first_name, c.last_name, c.preferred_name
         FROM leavers_gift_packages g
         LEFT JOIN children c ON c.id = g.child_id
        ORDER BY g.created_at DESC LIMIT 200`);
    res.json({ packages: rows });
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

module.exports = router;
