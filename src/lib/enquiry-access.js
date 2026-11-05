'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// enquiry-access.js — b399 (2026-10-06), "enquiry mode" in the parents app.
//
// ONE place that grants or closes a family's pre-enrolment parents-portal
// access, so the manual Roost grant (src/routes/enquiry-portal.js), the
// automatic grant on a new website enquiry (src/routes/public-enquiry.js /
// the inline handler in server-unified.js) and the "Invite to the parents
// app" button on a bare waiting-list row all go through the same logic —
// never three copies of "create a provisional child + an access row".
//
// A provisional child is linked to its family by enquiries.id via
// children.enquiry_id — the SAME link the registration/approval/enrol paths
// already use to avoid a duplicate child record later. A waiting-list row
// with no enquiry yet gets a minimal one created on first grant, so every
// family on the pipeline — however it arrived — ends up on one link column.
// ─────────────────────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

let _schemaReady = null;
async function ensureSchema(db) {
  if (_schemaReady) return _schemaReady;
  _schemaReady = (async () => {
    await db.query(`ALTER TABLE children ADD COLUMN IF NOT EXISTS enquiry_id INTEGER`);
    await db.query(`ALTER TABLE parent_portal_access ADD COLUMN IF NOT EXISTS retired_at timestamptz`);
    await db.query(`ALTER TABLE parent_portal_access ADD COLUMN IF NOT EXISTS retired_reason text`);
    await db.query(`ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS ack_sent_at timestamptz`);
  })().catch(e => { _schemaReady = null; throw e; });
  return _schemaReady;
}

// b400 (2026-10-06) — "What's happening in [room]" needs a room for a family
// that has never had one assigned. enquiries.preferred_room / room_needed is
// free text ("Baby Room", "baby", or a day-pattern string that names no room
// at all) — matched the SAME way the rest of enquiries.js already reads it
// (`e.preferred_room || e.room_needed`, see enquiries.js:776 etc.), then
// loosely matched against the real rooms table. No match = no room_id set,
// which is a safe no-op: planning.html's existing room-tab buttons are
// clickable either way (item 4), so an unresolved room is "let them pick",
// not a dead end.
let _roomsCache = null;
async function _rooms(db) {
  if (_roomsCache) return _roomsCache;
  const { rows } = await db.query(`SELECT id, name FROM rooms`);
  _roomsCache = rows;
  return rows;
}
async function _resolveRoom(db, text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const rooms = await _rooms(db);
  const exact = rooms.find(r => r.name.toLowerCase() === t);
  if (exact) return exact;
  if (t.includes('baby')) return rooms.find(r => /baby/i.test(r.name)) || null;
  if (t.includes('pre')) return rooms.find(r => /pre/i.test(r.name)) || null;
  return null;
}

// Resolve (enquiryId, waitingListId) down to a single enquiryId, backfilling a
// minimal enquiry for a waiting-list row that has never had one (e.g. a direct
// import). `create` controls whether a missing link is created (grant path) or
// just read (close path — nothing to close for a family never granted access).
async function _resolveEnquiryId(db, { enquiryId, waitingListId }, { create } = {}) {
  if (enquiryId) return Number(enquiryId);
  if (!waitingListId) return null;
  const { rows } = await db.query(`SELECT * FROM waiting_list WHERE id=$1`, [waitingListId]);
  if (!rows.length) return null;
  const w = rows[0];
  if (w.enquiry_id) return w.enquiry_id;
  if (!create) return null;
  const ins = await db.query(
    `INSERT INTO enquiries (child_first_name, child_last_name, child_dob, parent_name,
       parent_email, parent_phone, room_needed, source, stage, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'waiting_list','on_waiting_list','new') RETURNING id`,
    [w.child_first_name, w.child_last_name, w.child_dob, w.parent_name,
     w.parent_email, w.parent_phone, w.room_needed]);
  const newId = ins.rows[0].id;
  await db.query(`UPDATE waiting_list SET enquiry_id=$1 WHERE id=$2 AND enquiry_id IS NULL`, [newId, waitingListId]);
  return newId;
}

/**
 * Create/reuse a provisional child + an 'enquiry' parent_portal_access row for
 * the family behind an enquiry (or a bare waiting-list row). Best-effort CF
 * allowlist grant included. Never throws — callers are usually fire-and-forget
 * (a new website enquiry) as well as a manager button that wants the detail.
 */
async function grantEnquiryAccess(db, ids, { staffId, publicForm } = {}) {
  await ensureSchema(db);
  // 2026-10-06 (review) — the public forms grant automatically, and the inline
  // /api/public-enquiry route has no rate limit of its own. A ceiling across the
  // whole nursery stops a bot filling children/allowlist with provisional rows;
  // real families (a handful a week) never reach it. The office's own "Invite to
  // the parents app" button is never limited.
  if (publicForm) {
    try {
      const { rows: [c] } = await db.query(
        `SELECT count(*)::int AS n FROM children WHERE status='enquiry' AND created_at > now() - interval '1 hour'`);
      if (c && c.n >= 6) return { ok: false, error: 'nursery-wide ceiling for automatic grants reached' };
    } catch (_) { /* never blocks on the check itself */ }
  }
  let enquiryId;
  try {
    enquiryId = await _resolveEnquiryId(db, ids, { create: true });
  } catch (e) { return { ok: false, error: 'resolve enquiry: ' + e.message }; }
  if (!enquiryId) return { ok: false, error: 'no enquiry or waiting-list entry to grant from' };

  let enq;
  try {
    const r = await db.query(`SELECT * FROM enquiries WHERE id=$1`, [enquiryId]);
    enq = r.rows[0];
  } catch (e) { return { ok: false, error: 'DB error: ' + e.message }; }
  if (!enq) return { ok: false, error: 'enquiry not found' };

  const email = String(enq.parent_email || '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return { ok: false, error: 'enquiry has no valid parent_email' };

  const client = await db.connect();
  let childId;
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT id FROM children WHERE enquiry_id=$1 LIMIT 1`, [enquiryId]);
    if (existing.rows.length) {
      childId = existing.rows[0].id;
    } else {
      const room = await _resolveRoom(client, enq.preferred_room || enq.room_needed).catch(() => null);
      const ins = await client.query(
        `INSERT INTO children (first_name, last_name, date_of_birth, status, is_active,
                                enquiry_id, parent_1_name, parent_1_email, primary_contact_email,
                                room_id, room)
         VALUES ($1,$2,$3,'enquiry',false,$4,$5,$6,$6,$7,$8) RETURNING id`,
        [enq.child_first_name || 'Enquiry', enq.child_last_name || `#${enquiryId}`,
         enq.child_dob || null, enquiryId, enq.parent_name || null, email,
         room ? room.id : null, room ? room.name : null]
      );
      childId = ins.rows[0].id;
    }
    await client.query(
      `INSERT INTO parent_portal_access (child_id, email, access_level, is_active)
       VALUES ($1,$2,'enquiry',true)
       ON CONFLICT (child_id, email) DO UPDATE SET is_active=true, access_level='enquiry',
         retired_at=NULL, retired_reason=NULL`,
      [childId, email]
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: 'DB error: ' + e.message };
  } finally { client.release(); }

  let cf = { ok: false, skipped: true };
  try { cf = await require('./access-grants').grantCfAllowlist(email); } catch (e) { cf = { ok: false, error: e.message }; }

  return { ok: true, enquiry_id: enquiryId, provisional_child_id: childId, email, cf_grant: cf };
}

/**
 * Deactivate enquiry-mode portal access for a closed enquiry / withdrawn or
 * merged waiting-list row. Keeps every row (retired_at/retired_reason, never
 * deleted) and marks the provisional child inactive so the next CF allowlist
 * sync drops the family. A no-op, not an error, when the family was never
 * granted access in the first place.
 */
async function closeEnquiryAccess(db, { enquiryId, waitingListId, reason } = {}) {
  await ensureSchema(db);
  let eid;
  try {
    eid = await _resolveEnquiryId(db, { enquiryId, waitingListId }, { create: false });
  } catch (e) { return { ok: false, error: e.message }; }
  if (!eid) return { ok: true, closed: 0, note: 'no linked enquiry — nothing to close' };

  try {
    const { rows: kids } = await db.query(
      `SELECT id FROM children WHERE enquiry_id=$1 AND status='enquiry'`, [eid]);
    let closed = 0;
    for (const k of kids) {
      const r = await db.query(
        `UPDATE parent_portal_access SET is_active=false, retired_at=now(), retired_reason=$2
          WHERE child_id=$1 AND access_level='enquiry' AND is_active=true`,
        [k.id, reason || 'enquiry closed']);
      closed += r.rowCount;
      await db.query(`UPDATE children SET is_active=false, updated_at=now() WHERE id=$1`, [k.id]);
    }
    return { ok: true, closed, provisional_children: kids.length };
  } catch (e) { return { ok: false, error: e.message }; }
}

/**
 * True when EVERY active parent_portal_access row for this email is
 * access_level='enquiry' — a parent who also has a real child is never
 * gated. False (never gated) for an address with no active rows at all;
 * that case is a 401 elsewhere, not an enquiry-mode decision.
 */
async function isEnquiryModeEmail(db, email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e || !EMAIL_RE.test(e)) return false;
  const { rows } = await db.query(
    `SELECT access_level FROM parent_portal_access WHERE lower(email)=$1 AND is_active=true`, [e]);
  if (!rows.length) return false;
  return rows.every(r => r.access_level === 'enquiry');
}

module.exports = { ensureSchema, grantEnquiryAccess, closeEnquiryAccess, isEnquiryModeEmail, EMAIL_RE };
