'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b341 — the ONE place a keepsake package is minted and its link emailed.
//
// Before b341 the mint lived inline in POST /api/leavers-gift/gift/:child_id/generate and the
// email inline in POST /api/leavers-gift/packages/:id/send. The parents' "Create my memory
// book" button needs the same two things, and a second copy would drift, so both routes now
// call these functions:
//
//   mintPackage()     snapshot (through the group-media gate — see keepsake.js) → revoke the
//                     child's previous active package → insert the new one, in ONE transaction
//                     so a failure cannot leave a family with no link at all.
//   sendLinkEmail()   the "your memory book" email. Parent-initiated or staff-initiated only.
//
// (scripts/keepsake-autogen.js, run by cron at 06:00 inside wren-ladn, still has its own inline
//  copy of the mint. It is under scripts/, which prod bind-mounts from the working tree, so it
//  was deliberately NOT edited by this build — see the b341 NOTES.)
// ─────────────────────────────────────────────────────────────────────────────
const crypto = require('crypto');
const K = require('./keepsake');
const { sendDirectEmail } = require('./direct-email');
const { longDate } = require('./leaving-notice');

const newToken = () => crypto.randomBytes(24).toString('base64url');

/**
 * @param {import('pg').Pool} db
 * @param {object} o
 * @param {number}  o.childId
 * @param {number} [o.validDays=365]     clamped 7..3650, as the Roost route always did
 * @param {'staff'|'parent'} [o.source]
 * @param {number|null} [o.createdBy]    staff id
 * @param {string} [o.createdByName]
 * @param {string|null} [o.createdByEmail]  the parent's address when source = 'parent'
 * @param {boolean} [o.requireMedia]     refuse (mint nothing, revoke nothing) when the snapshot
 *                                       holds no photos or videos — b326's rule, applied to the
 *                                       family-facing path
 * @param {number[]} [o.ownedChildIds]   override the family lookup (tests)
 * @returns {Promise<{ok:true, package:object, snap:object, revoked:number[]}
 *                  |{ok:false, reason:'not_found'}
 *                  |{ok:false, reason:'no_media', snap:object}>}
 */
async function mintPackage(db, o) {
  const childId = parseInt(o.childId, 10);
  const validDays = Math.min(Math.max(parseInt(o.validDays, 10) || 365, 7), 3650);
  // 2026-09-21 (Toby): "they should have all of the observations, because all are
  // for parents". b341 had limited a family-minted book to shared_with_parents, on
  // the reasoning that nobody reviews it first. Toby's call: an observation is
  // written about their child and belongs in their child's book. Staff-, cron- and
  // family-minted books are now the same book.
  const snapOpts = {};
  if (o.ownedChildIds) snapOpts.ownedChildIds = o.ownedChildIds;
  const snap = await K.gatherSnapshot(db, childId, snapOpts);
  if (!snap) return { ok: false, reason: 'not_found' };
  const mediaHeld = (snap.media || []).length;
  if (o.requireMedia && mediaHeld === 0) return { ok: false, reason: 'no_media', snap };

  const token = newToken();
  const title = `${snap.child.display_name} — My Your Nursery Memory Book`;
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // one active link per child — retire any previous active ones
    const rev = await client.query(
      `UPDATE leavers_gift_packages SET status='revoked' WHERE child_id=$1 AND status='active' RETURNING id`, [childId]);
    const ins = await client.query(
      `INSERT INTO leavers_gift_packages
         (child_id, token, status, title, snapshot, media_count, expires_at, created_by, created_by_name, source, created_by_email)
       VALUES ($1,$2,'active',$3,$4::jsonb,$5, now() + ($6 || ' days')::interval, $7, $8, $9, $10)
       RETURNING id, token, status, title, media_count, expires_at, created_at`,
      [childId, token, title, JSON.stringify(snap), mediaHeld, String(validDays),
       o.createdBy || null, o.createdByName || 'staff', o.source || 'staff', o.createdByEmail || null]);
    await client.query('COMMIT');
    return { ok: true, package: ins.rows[0], snap, revoked: rev.rows.map(r => r.id) };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    throw e;
  } finally {
    client.release();
  }
}

// The email is the one thing that still works after a family's login stops (portal access ends
// when a child leaves; the package outlives it), so it says when the link stops working.
function composeLinkEmail({ childName, url, expiresAt }) {
  const name = K.esc(childName || 'your child');
  const until = expiresAt ? longDate(new Date(expiresAt).toISOString().slice(0, 10)) : null;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1e293b">
           <h2 style="color:#4a9abf">A keepsake for ${name} 💛</h2>
           <p>As ${name} leaves us, we've made a little memory book of their time at Your Nursery —
           photos, observations, first words and more. It's yours to keep forever.</p>
           <p style="text-align:center;margin:28px 0">
             <a href="${url}" style="background:#e07820;color:#fff;text-decoration:none;padding:14px 30px;border-radius:8px;font-weight:700">Open ${name}'s Memory Book</a>
           </p>
           <p style="font-size:13px;color:#64748b">You can view it online or install it to keep offline. The link is private to your family.${until ? ` It works until ${K.esc(until)} — save the book to your device before then to keep it for good.` : ''}</p>
           <p style="font-size:12px;color:#94a3b8">Your Nursery · ${K.esc(K.NURSERY.phone)}</p>
         </div>`;
  const text = `A keepsake for ${childName || 'your child'}\n\nOpen the memory book: ${url}\n`
    + (until ? `The link works until ${until} — save the book to your device before then to keep it for good.\n` : '')
    + `\nYour Nursery · ${K.NURSERY.phone}`;
  return { subject: `${childName || 'Your child'}'s Memory Book from Your Nursery 💛`, html, text };
}

/** Email the link. Returns { sent, disabled, error, url }. Never throws. */
async function sendLinkEmail({ to, token, childName, expiresAt, eventType }) {
  const base = process.env.KEEPSAKE_PUBLIC_BASE || 'https://parents.example-nursery.co.uk';
  const url = `${base}/keepsake/${token}`;
  const parts = composeLinkEmail({ childName, url, expiresAt });
  const r = await sendDirectEmail({ to, subject: parts.subject, html: parts.html, text: parts.text, eventType: eventType || 'keepsake-link' });
  return Object.assign({ url }, r);
}

module.exports = { mintPackage, sendLinkEmail, composeLinkEmail, newToken };
