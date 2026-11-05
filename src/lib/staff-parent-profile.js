'use strict';
/**
 * staff-parent-profile.js — 2026-10-23 (branch keyperson-20261023).
 *
 * What a parent may see about a member of staff, decided in ONE place, for the
 * two readers that need it: the parents' "Your child's key person" home card and
 * Meet the team (both src/routes/parents.js), and the staff member's own preview
 * plus the managers' list (src/routes/staff-about-me.js).
 *
 * WHERE IT IS STORED (nothing new — b356's row, extended)
 *   words     staff_about_me (blurb + b356's longer fields)
 *   photo     staff.photo_url (b356: "no third photo column")
 *   switches  staff_about_me.is_visible   — the staff member publishes their profile
 *             staff_about_me.show_photo   — and, separately, their photo
 *             staff_about_me.hidden_by_manager — a manager's override, wins over both
 *
 * WHAT A PARENT GETS
 *   Always (when this person is the child's key person or buddy): first name and a
 *   role label. The EYFS statutory framework (3.27) requires the setting to tell
 *   parents who their child's key person is, so the name is not opt-in.
 *   Only if published and not hidden: the blurb, b356's fields and — only if
 *   show_photo too — the photo. Never a surname, phone, email or staff id beyond
 *   the opaque one the card needs as a key.
 *
 * PHOTOS ARE INLINED, NOT LINKED
 *   /uploads/staff-photos is refused on the parents portal (server-unified.js, b491)
 *   and needs an enrolled device on EY, so a plain <img src> cannot load there. A
 *   published photo is sent as a data: URI instead — the parents' own API call
 *   carries the authorisation, and nothing new is opened on the static mount. The
 *   EY editor resizes to 480px before upload, so one photo is ~30–60 KB; anything
 *   over INLINE_MAX (an old unresized Roost upload) is left out rather than sent.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const IMG = require('./image-safety');

const PHOTO_DIR = '/app/uploads/staff-photos';
const PHOTO_URL_PREFIX = '/uploads/staff-photos/';
const UPLOAD_MAX = 600 * 1024;   // decoded bytes accepted from the EY editor
const INLINE_MAX = 400 * 1024;   // largest stored photo we will inline for a reader
const BLURB_MAX = 300;

const ROLE_LABELS = {
  practitioner: 'Nursery practitioner',
  senior_practitioner: 'Senior practitioner',
  apprentice: 'Apprentice practitioner',
  room_leader: 'Room leader',
  deputy_manager: 'Deputy manager',
  manager: 'Nursery manager',
  headteacher: 'Head teacher',
  senco: 'SENCo',
};
function roleLabel(role, jobTitle) {
  const jt = String(jobTitle || '').trim();
  if (jt && jt.length <= 60) return jt;
  if (ROLE_LABELS[role]) return ROLE_LABELS[role];
  const r = String(role || '').replace(/_/g, ' ').trim();
  return r ? r.charAt(0).toUpperCase() + r.slice(1) : 'Nursery team';
}

/** Which of this build's columns exist on staff_about_me in the current schema.
 *  Cached for a minute — the migration may land after the code. */
let _cols = { at: 0, set: null };
async function profileColumns(db) {
  if (_cols.set && Date.now() - _cols.at < 60000) return _cols.set;
  const { rows } = await db.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'staff_about_me'`);
  _cols = { at: Date.now(), set: new Set(rows.map(r => r.column_name)) };
  return _cols.set;
}
const hasParentProfile = cols => cols.has('blurb') && cols.has('show_photo') && cols.has('hidden_by_manager');

/** A stored /uploads/staff-photos/<file> as a data: URI, or null. Never throws. */
function inlinePhoto(photoUrl) {
  try {
    if (!photoUrl || typeof photoUrl !== 'string') return null;
    const bare = photoUrl.split('?')[0];
    if (!bare.startsWith(PHOTO_URL_PREFIX)) return null;
    const name = bare.slice(PHOTO_URL_PREFIX.length);
    if (!name || name.includes('/') || name.includes('..')) return null;
    const file = path.join(PHOTO_DIR, name);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > INLINE_MAX) return null;
    const buf = fs.readFileSync(file);
    const kind = IMG.sniff(buf);
    if (!kind || kind.kind !== 'image') return null;
    return `data:${kind.mime};base64,${buf.toString('base64')}`;
  } catch (_) { return null; }
}

/**
 * Validate + clean an uploaded data: URI and write it for this staff member.
 * Returns { url } or throws an Error with .status 400.
 */
function savePhoto(staffId, dataUrl) {
  const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
  const m = /^data:image\/[a-z+.-]+;base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) throw bad('Please choose a photo (JPEG, PNG or WebP).');
  let buf = Buffer.from(m[1].replace(/\s+/g, ''), 'base64');
  if (!buf.length) throw bad('That photo is empty.');
  if (buf.length > UPLOAD_MAX) throw bad('That photo is too big — try another one.');
  const kind = IMG.sniff(buf);
  if (!kind || !['image/jpeg', 'image/png', 'image/webp'].includes(kind.mime)) {
    throw bad('Please choose a JPEG, PNG or WebP photo.');
  }
  const r = IMG.strip(buf, kind.mime);
  if (!r.stripped) throw bad('Could not read that photo — try another one.');
  buf = r.buffer;
  if (IMG.hasMetadata(buf, kind.mime)) throw bad('Could not clean that photo — try another one.');
  const dim = IMG.dimensions(buf, kind.mime);
  if (!dim || dim.width < 64 || dim.height < 64 || dim.width > 2000 || dim.height > 2000) {
    throw bad('That photo is an unexpected size — try another one.');
  }
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  // A fresh name each time: a cached old photo can never be shown in place of the
  // new one, and the old file is removed by the caller once the row points here.
  const name = `${Number(staffId)}-${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}${kind.ext}`;
  fs.writeFileSync(path.join(PHOTO_DIR, name), buf, { mode: 0o640 });
  return { url: PHOTO_URL_PREFIX + name, bytes: buf.length, width: dim.width, height: dim.height };
}

/** Delete a stored staff photo file (only ever inside PHOTO_DIR). Never throws. */
function removePhotoFile(photoUrl) {
  try {
    const bare = String(photoUrl || '').split('?')[0];
    if (!bare.startsWith(PHOTO_URL_PREFIX)) return;
    const name = bare.slice(PHOTO_URL_PREFIX.length);
    if (!name || name.includes('/') || name.includes('..')) return;
    fs.unlinkSync(path.join(PHOTO_DIR, name));
  } catch (_) { /* already gone */ }
}

/**
 * The parent-safe card for each of these staff ids (active staff only).
 * Returns Map(id → card). `full` adds b356's longer fields for Meet the team.
 */
async function parentCards(db, staffIds, { full = false } = {}) {
  const ids = [...new Set((staffIds || []).filter(v => v != null).map(Number))];
  const out = new Map();
  if (!ids.length) return out;
  let cols;
  try { cols = await profileColumns(db); } catch (_) { cols = new Set(); }
  const haveTable = cols.size > 0;
  const pp = hasParentProfile(cols);
  const { rows } = await db.query(`
    SELECT s.id, s.first_name, s.role, s.job_title, s.photo_url
           ${haveTable ? `, a.is_visible, a.years_here, a.likes_about_job, a.enjoys_doing,
                           a.favourite_song, a.why_little_angels` : ''}
           ${pp ? ', a.blurb, a.show_photo, a.hidden_by_manager' : ''}
      FROM staff s
      ${haveTable ? 'LEFT JOIN staff_about_me a ON a.staff_id = s.id' : ''}
     WHERE s.id = ANY($1::int[]) AND s.is_active IS NOT FALSE`, [ids]);
  for (const s of rows) {
    const published = !!(s.is_visible && !(pp && s.hidden_by_manager));
    const card = {
      id: s.id,
      first_name: String(s.first_name || '').trim() || 'Your key person',
      role_label: roleLabel(s.role, s.job_title),
      published,
      blurb: published && pp ? (s.blurb || null) : null,
      photo: published && pp && s.show_photo ? inlinePhoto(s.photo_url) : null,
    };
    if (full && published) {
      Object.assign(card, {
        years_here: s.years_here || null, likes_about_job: s.likes_about_job || null,
        enjoys_doing: s.enjoys_doing || null, favourite_song: s.favourite_song || null,
        why_little_angels: s.why_little_angels || null,
      });
    }
    out.set(s.id, card);
  }
  return out;
}

module.exports = {
  PHOTO_DIR, PHOTO_URL_PREFIX, BLURB_MAX, UPLOAD_MAX,
  roleLabel, profileColumns, hasParentProfile, inlinePhoto, savePhoto, removePhotoFile, parentCards,
};
