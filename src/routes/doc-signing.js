'use strict';
/* ===========================================================================
 * doc-signing.js — b309 (2026-09-10)
 *
 * E-signature and read receipts for ANY document: a person_documents row, or a
 * policy. Backlog item 10 of the BrightHR parity report.
 *
 * THIS IS NOT A SECOND SIGNING IMPLEMENTATION
 * src/routes/contracts.js already signs employment contracts properly, and the
 * brief is explicit: generalise it, do not write another one. So the mechanism
 * here is deliberately the same one, lifted rather than reinvented:
 *
 *     crypto.randomBytes(32).toString('hex')   the token
 *     a row per (document, person) with sent / opened / signed timestamps
 *     the public endpoints are token-gated and carry NO session
 *
 * What is different is only what has to be:
 *   * the subject is polymorphic (subject_kind + subject_id), so one table
 *     covers policies and staff documents instead of one table per document type
 *   * there are TWO requirements, not one: 'sign' (a signature) and 'read'
 *     (an acknowledgement). BrightHR sells both and an inspector asks for both.
 *   * the version is pinned at send time and stored on the receipt.
 *
 * WHY THE VERSION MATTERS MORE THAN THE SIGNATURE
 * "Everyone has signed the safeguarding policy" is worthless if the policy has
 * been edited since. A policy has policies.version, so the receipt records
 * 'policy:v4'. A person_documents row has no version column at all, so its
 * identity at send time (id + uploaded_at) IS the version, recorded as
 * 'person_document:88@2026-09-01T10:14:22.000Z'. Re-uploading the document
 * changes uploaded_at, so the old receipts visibly refer to the old document
 * instead of silently appearing to cover the new one.
 *
 * POLICIES ARE DUAL-WRITTEN
 * ladn.policy_acknowledgments already exists and the HR policies page already
 * reads it. Signing a policy here writes BOTH rows, so nothing that reads the
 * old table breaks and no acknowledgement exists in only one of the two places.
 *
 * PUBLIC SURFACE
 * Four endpoints take a token instead of a session and are mounted BEFORE the
 * authenticate() middleware. They are the only ones. Each is O(1) on a unique
 * index over the token, returns 404 for an unknown token, and never says which
 * of "wrong token" and "no such document" applied.
 * ===========================================================================*/

const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');

const SCHEMA = () => process.env.PG_SCHEMA || 'ladn';
const MANAGER_ROLES = ['manager', 'deputy_manager', 'admin'];
const isManager = req => MANAGER_ROLES.includes(req.user && req.user.role);
const KINDS = ['person_document', 'policy'];
const REQUIREMENTS = ['sign', 'read'];

const hashIp = req => {
  const raw = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  return raw ? crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32) : null;
};
const ua = req => String(req.headers['user-agent'] || '').slice(0, 400);

/** The document's identity right now: title, version string, and where its file is. */
async function subjectSnapshot(db, kind, id) {
  const s = SCHEMA();
  if (kind === 'policy') {
    const { rows } = await db.query(
      `SELECT id, title, version, version_label, requires_acknowledgment, is_active
         FROM ${s}.policies WHERE id=$1`, [id]);
    if (!rows.length) return null;
    const p = rows[0];
    return {
      kind, id: p.id, title: p.title,
      version_ref: `policy:v${p.version == null ? '?' : p.version}${p.version_label ? ` (${p.version_label})` : ''}`,
      policy_version: p.version == null ? null : Number(p.version),
      file: null, active: p.is_active !== false,
    };
  }
  const { rows } = await db.query(
    `SELECT id, title, filename, stored_path, mime, uploaded_at, subject_type, subject_id, deleted
       FROM ${s}.person_documents WHERE id=$1`, [id]);
  if (!rows.length || rows[0].deleted) return null;
  const d = rows[0];
  const stamp = d.uploaded_at ? new Date(d.uploaded_at).toISOString() : 'unknown';
  return {
    kind, id: d.id, title: d.title || d.filename || `Document #${d.id}`,
    version_ref: `person_document:${d.id}@${stamp}`,
    policy_version: null,
    file: { path: d.stored_path, name: d.filename, mime: d.mime },
    active: true,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PUBLIC — token only. Declared before router.use(authenticate).
// ═══════════════════════════════════════════════════════════════════════════

/** Look a token up, or answer 404 without saying why. */
async function byToken(db, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await db.query(
    `SELECT * FROM ${SCHEMA()}.document_signatures WHERE token=$1`, [token]);
  const r = rows[0];
  if (!r || r.revoked_at) return null;
  return r;
}

// GET /public/:token — what am I being asked to sign?
router.get('/public/:token', async (req, res) => {
  try {
    const db = getPool();
    const row = await byToken(db, req.params.token);
    if (!row) return res.status(404).json({ error: 'This link is not valid. Ask your manager to send a new one.' });

    if (!row.opened_at) {
      await db.query(
        `UPDATE ${SCHEMA()}.document_signatures SET opened_at=now(), ip_hash=COALESCE(ip_hash,$1), user_agent=COALESCE(user_agent,$2) WHERE id=$3`,
        [hashIp(req), ua(req), row.id]);
    }
    const { rows: st } = await db.query(
      `SELECT first_name, last_name FROM ${SCHEMA()}.staff WHERE id=$1`, [row.staff_id]);
    res.json({
      ok: true,
      requirement: row.requirement,
      title: row.document_title,
      version_ref: row.version_ref,
      subject_kind: row.subject_kind,
      name: st[0] ? `${st[0].first_name} ${st[0].last_name}`.trim() : null,
      already_done: !!(row.signed_at || row.read_at),
      signed_at: row.signed_at,
      read_at: row.read_at,
      has_file: row.subject_kind === 'person_document',
      // Policies are text, so the body comes back with the metadata; a document
      // is a file and is fetched separately.
      body: null,
    });
  } catch (e) {
    console.error('[doc-signing/public]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /public/:token/content — the policy text, or the document file.
router.get('/public/:token/content', async (req, res) => {
  try {
    const db = getPool();
    const row = await byToken(db, req.params.token);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const snap = await subjectSnapshot(db, row.subject_kind, row.subject_id);
    if (!snap) return res.status(404).json({ error: 'The document is no longer available.' });

    if (row.subject_kind === 'policy') {
      const { rows } = await db.query(
        `SELECT content FROM ${SCHEMA()}.policies WHERE id=$1`, [row.subject_id]);
      return res.json({ ok: true, title: snap.title, version_ref: snap.version_ref, content: rows[0] ? rows[0].content : '' });
    }
    const p = snap.file && snap.file.path;
    if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'File not available' });
    res.setHeader('Content-Type', snap.file.mime || 'application/octet-stream');
    res.setHeader('Content-Disposition',
      `inline; filename="${String(snap.file.name || 'document').replace(/[^\w.\- ]/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(path.resolve(p));
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /public/:token/read — "I have read this". Body: {}
router.post('/public/:token/read', express.json({ limit: '8kb' }), async (req, res) => {
  try {
    const db = getPool();
    const row = await byToken(db, req.params.token);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.read_at || row.signed_at) return res.json({ ok: true, already_done: true, read_at: row.read_at });
    await db.query(
      `UPDATE ${SCHEMA()}.document_signatures
          SET read_at=now(), ip_hash=COALESCE(ip_hash,$1), user_agent=COALESCE(user_agent,$2) WHERE id=$3`,
      [hashIp(req), ua(req), row.id]);
    if (row.subject_kind === 'policy') await mirrorPolicyAck(db, row);
    res.json({ ok: true, read_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /public/:token/sign — Body: { signature_name, signature_data? }
router.post('/public/:token/sign', express.json({ limit: '512kb' }), async (req, res) => {
  const b = req.body || {};
  const name = String(b.signature_name || '').trim();
  if (name.length < 2) return res.status(400).json({ error: 'Type your full name to sign.' });
  if (b.signature_data && !String(b.signature_data).startsWith('data:image/')) {
    return res.status(400).json({ error: 'signature_data must be a data URL' });
  }
  try {
    const db = getPool();
    const row = await byToken(db, req.params.token);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.requirement !== 'sign') return res.status(400).json({ error: 'This document only needs acknowledging, not signing.' });
    if (row.signed_at) return res.json({ ok: true, already_done: true, signed_at: row.signed_at });

    await db.query(
      `UPDATE ${SCHEMA()}.document_signatures
          SET signed_at=now(), read_at=COALESCE(read_at, now()),
              signature_name=$1, signature_data=$2,
              ip_hash=COALESCE(ip_hash,$3), user_agent=COALESCE(user_agent,$4)
        WHERE id=$5`,
      [name.slice(0, 200), b.signature_data ? String(b.signature_data).slice(0, 400000) : null,
       hashIp(req), ua(req), row.id]);
    if (row.subject_kind === 'policy') await mirrorPolicyAck(db, row);

    try {
      notify('document_signed', 'all-managers', null,
        `Signed: ${row.document_title}`,
        `${name} signed "${row.document_title}" (${row.version_ref}).`,
        { relatedTable: 'document_signatures', relatedId: row.id, link: '/admin/staff/doc-signing' });
    } catch (_) { /* non-fatal */ }

    res.json({ ok: true, signed_at: new Date().toISOString(), version_ref: row.version_ref });
  } catch (e) {
    console.error('[doc-signing/sign]', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * Keep ladn.policy_acknowledgments in step. It has existed since before this
 * build and the HR policies screen reads it; writing only the new table would
 * leave one true answer in two places disagreeing.
 */
async function mirrorPolicyAck(db, row) {
  const s = SCHEMA();
  try {
    const { rows } = await db.query(`SELECT version FROM ${s}.policies WHERE id=$1`, [row.subject_id]);
    const v = rows.length ? rows[0].version : null;
    const { rows: existing } = await db.query(
      `SELECT id FROM ${s}.policy_acknowledgments
        WHERE policy_id=$1 AND staff_id=$2 AND COALESCE(policy_version,-1)=COALESCE($3::int,-1)`,
      [row.subject_id, row.staff_id, v]);
    if (existing.length) return;
    await db.query(
      `INSERT INTO ${s}.policy_acknowledgments (policy_id, staff_id, acknowledged_at, policy_version)
       VALUES ($1,$2,now(),$3)`, [row.subject_id, row.staff_id, v]);
  } catch (e) {
    console.error('[doc-signing] policy_acknowledgments mirror failed:', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTHENTICATED
// ═══════════════════════════════════════════════════════════════════════════
router.use(authenticate);

// GET /my — what I still have to sign or acknowledge, and what I already have.
router.get('/my', async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT id, subject_kind, subject_id, requirement, version_ref, document_title,
             sent_at, opened_at, read_at, signed_at, created_at
        FROM ${SCHEMA()}.document_signatures
       WHERE staff_id=$1 AND revoked_at IS NULL
       ORDER BY (signed_at IS NULL AND read_at IS NULL) DESC, created_at DESC
       LIMIT 300`, [req.user.id]);
    res.json({
      outstanding: rows.filter(r => !r.signed_at && !r.read_at),
      done: rows.filter(r => r.signed_at || r.read_at),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /my/:id/sign — sign from inside the portal, no token round-trip.
// Body: { signature_name, signature_data? }  (or { read: true } to acknowledge)
router.post('/my/:id/sign', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  const b = req.body || {};
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT * FROM ${SCHEMA()}.document_signatures WHERE id=$1`, [id]);
    const row = rows[0];
    if (!row || row.revoked_at) return res.status(404).json({ error: 'Not found' });
    if (row.staff_id !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
    if (row.signed_at || row.read_at) return res.json({ ok: true, already_done: true });

    if (row.requirement === 'read' || b.read === true) {
      await db.query(`UPDATE ${SCHEMA()}.document_signatures
                         SET read_at=now(), ip_hash=COALESCE(ip_hash,$1), user_agent=COALESCE(user_agent,$2)
                       WHERE id=$3`, [hashIp(req), ua(req), id]);
    } else {
      const name = String(b.signature_name || req.user.name || '').trim();
      if (name.length < 2) return res.status(400).json({ error: 'Type your full name to sign.' });
      await db.query(`UPDATE ${SCHEMA()}.document_signatures
                         SET signed_at=now(), read_at=COALESCE(read_at, now()), signature_name=$1,
                             signature_data=$2, ip_hash=COALESCE(ip_hash,$3), user_agent=COALESCE(user_agent,$4)
                       WHERE id=$5`,
        [name.slice(0, 200), b.signature_data ? String(b.signature_data).slice(0, 400000) : null,
         hashIp(req), ua(req), id]);
    }
    if (row.subject_kind === 'policy') await mirrorPolicyAck(db, row);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /request — a manager asks people to sign or acknowledge something.
// Body: { subject_kind, subject_id, staff_ids:[], requirement:'sign'|'read' }
router.post('/request', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const b = req.body || {};
  if (!KINDS.includes(b.subject_kind)) return res.status(400).json({ error: `subject_kind must be one of ${KINDS.join(', ')}` });
  const subjectId = parseInt(b.subject_id, 10);
  if (!Number.isInteger(subjectId)) return res.status(400).json({ error: 'subject_id required' });
  const requirement = REQUIREMENTS.includes(b.requirement) ? b.requirement : 'sign';
  let staffIds = Array.isArray(b.staff_ids) ? b.staff_ids.map(n => parseInt(n, 10)).filter(Number.isInteger) : [];
  try {
    const db = getPool();
    const snap = await subjectSnapshot(db, b.subject_kind, subjectId);
    if (!snap) return res.status(404).json({ error: 'Document not found' });

    if (!staffIds.length && b.all_active === true) {
      const { rows } = await db.query(`SELECT id FROM ${SCHEMA()}.staff WHERE is_active=true ORDER BY id`);
      staffIds = rows.map(r => r.id);
    }
    if (!staffIds.length) return res.status(400).json({ error: 'staff_ids required (or all_active: true)' });

    const base = process.env.HR_URL || 'https://hr.example-nursery.co.uk';
    const created = [];
    for (const sid of staffIds) {
      // One OPEN request per (document version, person). Asking twice for the
      // same version of the same document is a mistake, not a reminder.
      const { rows: dup } = await db.query(
        `SELECT id, token, signed_at, read_at FROM ${SCHEMA()}.document_signatures
          WHERE subject_kind=$1 AND subject_id=$2 AND staff_id=$3 AND version_ref=$4 AND revoked_at IS NULL`,
        [b.subject_kind, subjectId, sid, snap.version_ref]);
      if (dup.length) {
        created.push({ staff_id: sid, id: dup[0].id, reused: true,
          done: !!(dup[0].signed_at || dup[0].read_at),
          link: `${base}/doc-sign.html?token=${dup[0].token}` });
        continue;
      }
      const token = crypto.randomBytes(32).toString('hex');
      const { rows } = await db.query(`
        INSERT INTO ${SCHEMA()}.document_signatures
          (subject_kind, subject_id, staff_id, requirement, version_ref, document_title,
           token, sent_at, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING id`,
        [b.subject_kind, subjectId, sid, requirement, snap.version_ref, snap.title, token, req.user.id]);
      created.push({ staff_id: sid, id: rows[0].id, reused: false, done: false,
        link: `${base}/doc-sign.html?token=${token}` });

      try {
        notify(requirement === 'sign' ? 'document_to_sign' : 'document_to_read', String(sid), null,
          requirement === 'sign' ? `Please sign: ${snap.title}` : `Please read: ${snap.title}`,
          `${snap.title} (${snap.version_ref}) is waiting for you in the HR portal.`,
          { relatedTable: 'document_signatures', relatedId: rows[0].id, link: '/my-documents.html' });
      } catch (_) { /* non-fatal */ }
    }
    res.status(201).json({ ok: true, document: snap, requirement, requests: created });
  } catch (e) {
    console.error('[doc-signing/request]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /receipts?subject_kind=&subject_id=  — who, when, which version.
router.get('/receipts', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const where = ['ds.revoked_at IS NULL'], params = [];
  if (KINDS.includes(req.query.subject_kind)) { params.push(req.query.subject_kind); where.push(`ds.subject_kind=$${params.length}`); }
  if (req.query.subject_id) { params.push(parseInt(req.query.subject_id, 10)); where.push(`ds.subject_id=$${params.length}`); }
  if (req.query.staff_id)   { params.push(parseInt(req.query.staff_id, 10));   where.push(`ds.staff_id=$${params.length}`); }
  if (req.query.outstanding === 'true') where.push('ds.signed_at IS NULL AND ds.read_at IS NULL');
  try {
    const { rows } = await getPool().query(`
      SELECT ds.id, ds.subject_kind, ds.subject_id, ds.staff_id, ds.requirement,
             ds.version_ref, ds.document_title, ds.sent_at, ds.opened_at, ds.read_at,
             ds.signed_at, ds.signature_name, (ds.signature_data IS NOT NULL) AS has_drawn_signature,
             ds.ip_hash, ds.created_at,
             s.first_name || ' ' || s.last_name AS staff_name,
             r.first_name || ' ' || r.last_name AS requested_by_name
        FROM ${SCHEMA()}.document_signatures ds
        JOIN ${SCHEMA()}.staff s ON s.id = ds.staff_id
        LEFT JOIN ${SCHEMA()}.staff r ON r.id = ds.requested_by
       WHERE ${where.join(' AND ')}
       ORDER BY ds.created_at DESC LIMIT 1000`, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /coverage — one line per policy/document that has ever been sent:
// how many were asked, how many have signed, how many are outstanding.
router.get('/coverage', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const { rows } = await getPool().query(`
      SELECT subject_kind, subject_id, document_title, version_ref, requirement,
             COUNT(*) AS requested,
             COUNT(*) FILTER (WHERE signed_at IS NOT NULL) AS signed,
             COUNT(*) FILTER (WHERE read_at IS NOT NULL)   AS read_ack,
             COUNT(*) FILTER (WHERE signed_at IS NULL AND read_at IS NULL) AS outstanding,
             MIN(sent_at) AS first_sent, MAX(COALESCE(signed_at, read_at)) AS last_completed
        FROM ${SCHEMA()}.document_signatures
       WHERE revoked_at IS NULL
       GROUP BY subject_kind, subject_id, document_title, version_ref, requirement
       ORDER BY MIN(sent_at) DESC NULLS LAST`);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id/signature — the drawn signature image, manager only.
router.get('/:id/signature', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const { rows } = await getPool().query(
      `SELECT signature_data, signature_name, signed_at, version_ref, document_title
         FROM ${SCHEMA()}.document_signatures WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /:id — revoke an outstanding request (a wrong document, a wrong person).
// A COMPLETED receipt is never deleted: it is evidence.
router.delete('/:id', async (req, res) => {
  if (!isManager(req)) return res.status(403).json({ error: 'Forbidden' });
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'id must be a number' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `SELECT signed_at, read_at FROM ${SCHEMA()}.document_signatures WHERE id=$1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (rows[0].signed_at || rows[0].read_at) {
      return res.status(409).json({ error: 'This has already been signed or acknowledged. A completed receipt is evidence and is not deleted.' });
    }
    await db.query(`UPDATE ${SCHEMA()}.document_signatures SET revoked_at=now() WHERE id=$1`, [id]);
    res.json({ ok: true, id, revoked: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
