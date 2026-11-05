'use strict';
/**
 * staff-about-me.js — b356 (2026-09-24). Mounted at /api/staff-about-me.
 *
 * "Meet the team" — a staff member's own words about themselves, shown to parents through the
 * existing parents-app endpoint (src/routes/parents.js GET /meet-the-team), which reads this
 * table directly rather than calling this router. This file is the HR-side self-service: fill
 * it in, control your own visibility. Photo reuses staff.photo_url (src/routes/staff.js POST
 * /:id/photo) — no third photo column.
 *
 *   GET /mine      my own row (defaults if never filled in) + is_visible
 *   PUT /mine      { years_here, likes_about_job, enjoys_doing, favourite_song, why_little_angels, is_visible }
 *
 * 2026-10-23 (keyperson-20261023) — the EY "My profile for parents" page uses the SAME row, so
 * there is still one profile per person whichever portal it is edited from:
 *   PUT /mine is now partial — only the fields present in the body change. The HR form always
 *   sends all six, so it behaves exactly as before; the EY page sends its own three
 *   (blurb, show_photo, is_visible) without wiping the HR fields.
 *   GET /mine     + blurb, show_photo, hidden_by_manager/reason, photo (inline data: URI —
 *                   /uploads/staff-photos needs an enrolled device on EY, a staff phone has none)
 *   POST   /mine/photo   { image: data:URI } — resized in the browser, cleaned here (EXIF/XMP/ICC
 *                         stripped by src/lib/image-safety.js), written to staff.photo_url
 *   DELETE /mine/photo   removes my photo (file + staff.photo_url) and un-publishes it
 *   GET  /team                 managers: every active staff member's parent profile + status
 *   PUT  /:staffId/moderation  managers: { hidden: bool, reason? } — hide/unhide from parents
 *   POST /:staffId/reset       managers: clear words + photo + switches back to "not shared"
 * Manager actions are audited (audit_log entity_type 'staff_about_me').
 */
const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const SPP = require('../lib/staff-parent-profile');

router.use(authenticate);
router.use((req, res, next) => (req.user && req.user.role === 'parent') ? res.status(403).json({ error: 'Staff only' }) : next());

const FIELDS = ['years_here', 'likes_about_job', 'enjoys_doing', 'favourite_song', 'why_little_angels'];
const MAX = { years_here: 60, likes_about_job: 800, enjoys_doing: 800, favourite_song: 200, why_little_angels: 800, blurb: SPP.BLURB_MAX };
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin', 'headteacher'];
const isManager = req => !!(req.user && MANAGER_ROLES.includes(req.user.role));

const schemaMissing = e => e && (e.code === '42P01' || e.code === '42703');
function fail(res, e, what) {
  if (e && e.status === 400) return res.status(400).json({ error: 'bad_request', message: e.message });
  if (schemaMissing(e)) return res.status(503).json({ error: 'schema_not_applied', message: 'Apply migrations/2026-09-24b-b356-recognition-inspection-parent-voice.sql and migrations/2026-10-23-keyperson-parent-profile.sql.' });
  console.error(`[staff-about-me] ${what} failed:`, e && (e.code || e.message || 'error'));
  return res.status(500).json({ error: 'Something went wrong.' });
}
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

router.get('/mine', async (req, res) => {
  try {
    const db = getPool();
    const cols = await SPP.profileColumns(db);
    const pp = SPP.hasParentProfile(cols);
    const { rows } = await db.query(
      `SELECT years_here, likes_about_job, enjoys_doing, favourite_song, why_little_angels, is_visible,
              ${pp ? `blurb, show_photo, hidden_by_manager, hidden_reason,
                      to_char(hidden_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS hidden_at,` : ''}
              to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at
         FROM staff_about_me WHERE staff_id = $1`, [req.user.id]);
    const { rows: me } = await db.query(
      `SELECT photo_url, first_name, role, job_title FROM staff WHERE id = $1`, [req.user.id]);
    const s = me[0] || {};
    const profile = rows[0] || { years_here: null, likes_about_job: null, enjoys_doing: null, favourite_song: null, why_little_angels: null, is_visible: false };
    if (pp && !rows[0]) Object.assign(profile, { blurb: null, show_photo: false, hidden_by_manager: false, hidden_reason: null, hidden_at: null });
    res.json({
      profile,
      photo_url: s.photo_url || null,
      // 2026-10-23 — for the EY editor's preview: what a parent's card would say.
      photo: SPP.inlinePhoto(s.photo_url),
      first_name: s.first_name || null,
      role_label: SPP.roleLabel(s.role, s.job_title),
      parent_profile_supported: pp,
      blurb_max: SPP.BLURB_MAX,
    });
  } catch (e) { fail(res, e, 'mine'); }
});

router.put('/mine', async (req, res) => {
  const b = req.body || {};
  try {
    const db = getPool();
    const cols = await SPP.profileColumns(db);
    const pp = SPP.hasParentProfile(cols);
    const textFields = pp ? FIELDS.concat('blurb') : FIELDS;
    const set = {};
    for (const f of textFields) {
      if (!has(b, f)) continue;
      const raw = b[f];
      if (raw == null) { set[f] = null; continue; }
      const text = String(raw).replace(/\r\n?/g, '\n').trim();
      if (text.length > MAX[f]) return res.status(400).json({ error: 'too_long', field: f, message: `That field is over ${MAX[f]} characters.` });
      set[f] = text || null;
    }
    if (has(b, 'is_visible')) set.is_visible = b.is_visible === true || b.is_visible === 'true';
    if (pp && has(b, 'show_photo')) set.show_photo = b.show_photo === true || b.show_photo === 'true';
    const keys = Object.keys(set);
    if (!keys.length) return res.status(400).json({ error: 'nothing_to_save', message: 'Nothing to save.' });
    const vals = [req.user.id, ...keys.map(k => set[k])];
    await db.query(
      `INSERT INTO staff_about_me (staff_id, ${keys.join(', ')}, updated_at)
       VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(', ')}, now())
       ON CONFLICT (staff_id) DO UPDATE SET
         ${keys.map(k => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()`, vals);
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'save'); }
});

// ── 2026-10-23: my photo ─────────────────────────────────────────────────────
router.post('/mine/photo', async (req, res) => {
  try {
    const db = getPool();
    const saved = SPP.savePhoto(req.user.id, (req.body || {}).image);
    const { rows: before } = await db.query(`SELECT photo_url FROM staff WHERE id = $1`, [req.user.id]);
    await db.query(`UPDATE staff SET photo_url = $1, updated_at = now() WHERE id = $2`, [saved.url, req.user.id]);
    const old = before[0] && before[0].photo_url;
    if (old && old.split('?')[0] !== saved.url) SPP.removePhotoFile(old);
    res.json({ ok: true, photo: SPP.inlinePhoto(saved.url), width: saved.width, height: saved.height });
  } catch (e) { fail(res, e, 'photo'); }
});

router.delete('/mine/photo', async (req, res) => {
  try {
    const db = getPool();
    const cols = await SPP.profileColumns(db);
    const { rows } = await db.query(`SELECT photo_url FROM staff WHERE id = $1`, [req.user.id]);
    await db.query(`UPDATE staff SET photo_url = NULL, updated_at = now() WHERE id = $1`, [req.user.id]);
    if (rows[0] && rows[0].photo_url) SPP.removePhotoFile(rows[0].photo_url);
    if (SPP.hasParentProfile(cols)) {
      await db.query(`UPDATE staff_about_me SET show_photo = false, updated_at = now() WHERE staff_id = $1`, [req.user.id]);
    }
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'photo-delete'); }
});

// ── 2026-10-23: managers — see, hide, reset ─────────────────────────────────
router.get('/team', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Managers only' });
  try {
    const db = getPool();
    const cols = await SPP.profileColumns(db);
    const pp = SPP.hasParentProfile(cols);
    if (!pp) return res.status(503).json({ error: 'schema_not_applied', message: 'Apply migrations/2026-10-23-keyperson-parent-profile.sql.' });
    const { rows } = await db.query(`
      SELECT s.id, s.first_name, s.last_name, s.role, s.job_title, s.photo_url, r.name AS room_name,
             COALESCE(a.is_visible, false) AS is_visible, COALESCE(a.show_photo, false) AS show_photo,
             COALESCE(a.hidden_by_manager, false) AS hidden_by_manager, a.hidden_reason,
             to_char(a.hidden_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS hidden_at,
             hb.first_name AS hidden_by_name, a.blurb,
             to_char(a.updated_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS updated_at,
             (SELECT count(*)::int FROM children c
               WHERE c.key_person_id = s.id AND c.is_active = true
                 AND (c.leave_date IS NULL OR c.leave_date >= CURRENT_DATE)) AS key_children
        FROM staff s
        LEFT JOIN rooms r ON r.id = s.room_id
        LEFT JOIN staff_about_me a ON a.staff_id = s.id
        LEFT JOIN staff hb ON hb.id = a.hidden_by
       WHERE s.is_active = true AND COALESCE(s.role, '') NOT IN ('parent')
       ORDER BY (SELECT count(*) FROM children c WHERE c.key_person_id = s.id AND c.is_active = true) DESC,
                s.first_name, s.last_name`);
    res.json({
      staff: rows.map(s => ({
        id: s.id, name: `${s.first_name || ''} ${s.last_name || ''}`.trim(), first_name: s.first_name,
        role_label: SPP.roleLabel(s.role, s.job_title), room_name: s.room_name,
        key_children: s.key_children, blurb: s.blurb, has_photo: !!s.photo_url,
        photo: SPP.inlinePhoto(s.photo_url),
        is_visible: s.is_visible, show_photo: s.show_photo,
        hidden_by_manager: s.hidden_by_manager, hidden_reason: s.hidden_reason,
        hidden_at: s.hidden_at, hidden_by_name: s.hidden_by_name, updated_at: s.updated_at,
        parents_see: s.is_visible && !s.hidden_by_manager
          ? (s.show_photo && s.photo_url ? 'photo_and_words' : 'words') : 'name_only',
      })),
    });
  } catch (e) { fail(res, e, 'team'); }
});

router.put('/:staffId/moderation', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Managers only' });
  const staffId = Number(req.params.staffId);
  if (!Number.isInteger(staffId) || staffId <= 0) return res.status(400).json({ error: 'Bad staff id' });
  const hidden = (req.body || {}).hidden === true;
  const reason = String((req.body || {}).reason || '').trim().slice(0, 300) || null;
  try {
    const db = getPool();
    if (!SPP.hasParentProfile(await SPP.profileColumns(db))) return res.status(503).json({ error: 'schema_not_applied' });
    const { rows: st } = await db.query(`SELECT id FROM staff WHERE id = $1`, [staffId]);
    if (!st.length) return res.status(404).json({ error: 'Not found' });
    const { rows: prev } = await db.query(`SELECT hidden_by_manager FROM staff_about_me WHERE staff_id = $1`, [staffId]);
    await db.query(`
      INSERT INTO staff_about_me (staff_id, hidden_by_manager, hidden_by, hidden_at, hidden_reason, updated_at)
      VALUES ($1, $2, $3, CASE WHEN $2 THEN now() END, $4, now())
      ON CONFLICT (staff_id) DO UPDATE SET
        hidden_by_manager = EXCLUDED.hidden_by_manager, hidden_by = EXCLUDED.hidden_by,
        hidden_at = EXCLUDED.hidden_at, hidden_reason = EXCLUDED.hidden_reason, updated_at = now()`,
      [staffId, hidden, hidden ? req.user.id : null, hidden ? reason : null]);
    await recordAudit({ req, action: 'update', entity_type: 'staff_about_me', entity_id: staffId,
      diff: { hidden_by_manager: { from: prev[0] ? !!prev[0].hidden_by_manager : false, to: hidden } },
      meta: { via: 'ey-parent-profile', reason } });
    res.json({ ok: true, hidden_by_manager: hidden });
  } catch (e) { fail(res, e, 'moderation'); }
});

router.post('/:staffId/reset', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Managers only' });
  const staffId = Number(req.params.staffId);
  if (!Number.isInteger(staffId) || staffId <= 0) return res.status(400).json({ error: 'Bad staff id' });
  try {
    const db = getPool();
    if (!SPP.hasParentProfile(await SPP.profileColumns(db))) return res.status(503).json({ error: 'schema_not_applied' });
    const { rows: st } = await db.query(`SELECT photo_url FROM staff WHERE id = $1`, [staffId]);
    if (!st.length) return res.status(404).json({ error: 'Not found' });
    await db.query(`
      UPDATE staff_about_me SET blurb = NULL, years_here = NULL, likes_about_job = NULL, enjoys_doing = NULL,
             favourite_song = NULL, why_little_angels = NULL, is_visible = false, show_photo = false,
             hidden_by_manager = false, hidden_by = NULL, hidden_at = NULL, hidden_reason = NULL, updated_at = now()
       WHERE staff_id = $1`, [staffId]);
    await db.query(`UPDATE staff SET photo_url = NULL, updated_at = now() WHERE id = $1`, [staffId]);
    if (st[0].photo_url) SPP.removePhotoFile(st[0].photo_url);
    await recordAudit({ req, action: 'update', entity_type: 'staff_about_me', entity_id: staffId,
      meta: { via: 'ey-parent-profile', reset: true, photo_removed: !!st[0].photo_url } });
    res.json({ ok: true });
  } catch (e) { fail(res, e, 'reset'); }
});

module.exports = router;
