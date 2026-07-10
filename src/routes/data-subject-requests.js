'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// GDPR data-subject requests — manager queue (PROMPT 46)
// Parents request their child's data (subject access / portability) or erasure
// (right to be forgotten). A manager reviews and approves. Erasure is
// RETENTION-AWARE (driven by the PROMPT 45 retention_policies): statutory records
// — safeguarding, accident/incident, medication, financial, the attendance
// register — are RETAINED and flagged; the rest is erased/anonymised. Never a
// blind delete. Every step is written to audit_log.
// Mounted at /api/data-requests.
// ─────────────────────────────────────────────────────────────────────────────
const express = require('express');
const crypto  = require('crypto');
const fs   = require('fs');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { recordAudit } = require('../utils/audit');
const K = require('../lib/keepsake');

router.use(authenticate);

const MGR = ['manager', 'admin', 'headteacher', 'deputy_manager', 'business_manager'];
const mgrOnly = (req, res, next) =>
  MGR.includes(req.user?.role) ? next() : res.status(403).json({ error: 'Manager access required' });

// ── Retention-aware erasure policy (aligns with retention_policies) ──────
// ERASE: derived / developmental personal content with no standalone statutory
// retention duty on the setting once the child has left.
const ERASE_TABLES = [
  'observations', 'daily_diary', 'framework_tracker', 'first_words', 'next_steps',
  'child_about_me', 'memory_box_entries', 'parent_reports', 'leavers_books', 'leavers_gift_packages',
];
// RETAIN (untouched, counted + flagged): statutory records that MUST be kept.
const RETAIN_TABLES = [
  { table: 'safeguarding_concerns', why: 'Safeguarding — retain to 25th birthday (KCSIE / Working Together)' },
  { table: 'incidents',             why: 'Accident/incident — retain 3 years (RIDDOR / EYFS)' },
  { table: 'medicine_records',      why: 'Medication administration — retain 3 years (EYFS)' },
  { table: 'invoices',              why: 'Financial — retain 6 years (HMRC)' },
  { table: 'payments',              why: 'Financial — retain 6 years (HMRC)' },
  { table: 'child_funding',         why: 'Funding — retain 6 years (LA / HMRC)' },
  { table: 'attendance',            why: 'Attendance register — retain 3 years (EYFS statutory register)' },
  { table: 'child_bookings',        why: 'Attendance/booking register — retain 3 years' },
  { table: 'messages',              why: 'Parent communications — retain 3 years' },
];

async function childName(db, id) {
  const { rows } = await db.query('SELECT first_name, last_name, preferred_name FROM children WHERE id=$1', [id]);
  if (!rows.length) return null;
  const c = rows[0];
  return { id, name: `${c.preferred_name || c.first_name || ''} ${c.last_name || ''}`.trim(), first_name: c.first_name, last_name: c.last_name };
}

// ── GET / — the queue (optionally ?status= / ?child_id=) ──────────────────────
router.get('/', mgrOnly, async (req, res) => {
  try {
    const params = []; const where = [];
    if (req.query.status)   { params.push(req.query.status);   where.push(`r.status = $${params.length}`); }
    if (req.query.child_id) { params.push(req.query.child_id); where.push(`r.child_id = $${params.length}`); }
    const { rows } = await getPool().query(
      `SELECT r.*, c.first_name, c.last_name, c.preferred_name
         FROM data_subject_requests r
         LEFT JOIN children c ON c.id = r.child_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY CASE r.status WHEN 'requested' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END, r.requested_at DESC
        LIMIT 300`, params);
    const counts = await getPool().query(`SELECT status, count(*)::int n FROM data_subject_requests GROUP BY status`);
    res.json({ requests: rows, counts: Object.fromEntries(counts.rows.map(r => [r.status, r.n])) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST / — manager files a request on behalf of a parent (optional helper) ──
router.post('/', mgrOnly, async (req, res) => {
  const { child_id, request_type, requested_by_email, requester_name, reason } = req.body || {};
  if (!child_id || !['access', 'erasure'].includes(request_type))
    return res.status(400).json({ error: 'child_id and request_type (access|erasure) required' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `INSERT INTO data_subject_requests (child_id, request_type, requested_by_email, requester_name, reason, status)
       VALUES ($1,$2,$3,$4,$5,'requested') RETURNING *`,
      [child_id, request_type, requested_by_email || null, requester_name || (req.user?.name || 'staff'), reason || null]);
    await recordAudit({ req, action: 'create', entity_type: 'data_request', entity_id: rows[0].id, meta: { child_id, request_type } });
    res.json({ request: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/review — move to in_review ──────────────────────────────────────
router.post('/:id/review', mgrOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE data_subject_requests SET status='in_review', reviewed_by=$2, reviewed_by_name=$3, reviewed_at=now()
        WHERE id=$1 AND status='requested' RETURNING *`,
      [req.params.id, req.user?.id || null, req.user?.name || 'manager']);
    if (!rows.length) return res.status(404).json({ error: 'Not found or not in requested state' });
    await recordAudit({ req, action: 'update', entity_type: 'data_request', entity_id: req.params.id, meta: { status: 'in_review' } });
    res.json({ request: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/reject ──────────────────────────────────────────────────────────
router.post('/:id/reject', mgrOnly, async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `UPDATE data_subject_requests SET status='rejected', reviewed_by=$2, reviewed_by_name=$3, reviewed_at=now(),
              completed_at=now(), notes=$4
        WHERE id=$1 AND status IN ('requested','in_review') RETURNING *`,
      [req.params.id, req.user?.id || null, req.user?.name || 'manager', (req.body?.reason || '').slice(0, 1000) || null]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or already actioned' });
    await recordAudit({ req, action: 'update', entity_type: 'data_request', entity_id: req.params.id, meta: { status: 'rejected' } });
    res.json({ request: rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /:id/approve — release (access) or erase (erasure) ───────────────────
router.post('/:id/approve', mgrOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM data_subject_requests WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const reqRow = rows[0];
    if (!['requested', 'in_review', 'approved'].includes(reqRow.status))
      return res.status(400).json({ error: `Request already ${reqRow.status}` });

    if (reqRow.request_type === 'access') {
      // Mint a readable keepsake package + summarise a machine-readable export.
      const snap = await K.gatherSnapshot(db, reqRow.child_id);
      if (!snap) return res.status(404).json({ error: 'Child not found' });
      const token = crypto.randomBytes(24).toString('base64url');
      await db.query(`UPDATE leavers_gift_packages SET status='revoked' WHERE child_id=$1 AND status='active'`, [reqRow.child_id]);
      await db.query(
        `INSERT INTO leavers_gift_packages (child_id, token, status, title, snapshot, media_count, expires_at, created_by, created_by_name)
         VALUES ($1,$2,'active',$3,$4::jsonb,$5, now() + interval '90 days', $6, $7)`,
        [reqRow.child_id, token, `${snap.child.display_name} — Subject Access export`, JSON.stringify(snap),
         (snap.media || []).length, req.user?.id || null, req.user?.name || 'manager']);
      const result = {
        kind: 'access', released_at: new Date().toISOString(),
        stats: snap.stats, package_token: token,
        readable_url: `/keepsake/${token}`, download_url: `/keepsake/${token}/download`,
        machine_readable: `/api/data-requests/${req.params.id}/export.json`,
      };
      const upd = await db.query(
        `UPDATE data_subject_requests SET status='released', reviewed_by=$2, reviewed_by_name=$3,
                reviewed_at=COALESCE(reviewed_at, now()), completed_at=now(), result=$4::jsonb, package_token=$5
          WHERE id=$1 RETURNING *`,
        [req.params.id, req.user?.id || null, req.user?.name || 'manager', JSON.stringify(result), token]);
      await recordAudit({ req, action: 'export', entity_type: 'data_request', entity_id: req.params.id,
        meta: { child_id: reqRow.child_id, kind: 'subject_access', package_token: token } });
      return res.json({ request: upd.rows[0], result });
    }

    // ── ERASURE ──────────────────────────────────────────────────────────────
    if (reqRow.request_type === 'erasure') {
      if (!req.body?.confirm) return res.status(400).json({ error: 'confirm:true required for erasure' });
      if (parseInt(reqRow.child_id, 10) === 1) return res.status(400).json({ error: 'Refusing to erase protected record' });
      const result = await eraseChild(db, reqRow.child_id, req.params.id, req.user, req);
      const upd = await db.query(
        `UPDATE data_subject_requests SET status='erased', reviewed_by=$2, reviewed_by_name=$3,
                reviewed_at=COALESCE(reviewed_at, now()), completed_at=now(), result=$4::jsonb
          WHERE id=$1 RETURNING *`,
        [req.params.id, req.user?.id || null, req.user?.name || 'manager', JSON.stringify(result)]);
      return res.json({ request: upd.rows[0], result });
    }

    return res.status(400).json({ error: 'Unknown request_type' });
  } catch (e) { console.error('[data-requests] approve:', e.message); res.status(500).json({ error: e.message }); }
});

// ── The retention-aware erasure itself ────────────────────────────────────────
async function eraseChild(db, childId, requestId, actor, req) {
  const erased = {}, retained = {};
  // 1) collect media basenames to unlink AFTER commit (only if orphaned)
  let mediaBasenames = [];
  try {
    const mr = await db.query(`
      SELECT unnest(photo_urls) AS u FROM observations WHERE child_id=$1
      UNION ALL SELECT unnest(photo_urls) FROM daily_diary WHERE child_id=$1
      UNION ALL SELECT photo_url FROM children WHERE id=$1 AND photo_url IS NOT NULL`, [childId]);
    mediaBasenames = [...new Set(mr.rows.map(r => K.basenameOf(r.u)).filter(Boolean))];
  } catch (_) {}

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 2) delete developmental / derived personal content (savepoint per table)
    for (const t of ERASE_TABLES) {
      try {
        await client.query('SAVEPOINT s');
        const r = await client.query(`DELETE FROM ${t} WHERE child_id=$1`, [childId]);
        erased[t] = r.rowCount;
        await client.query('RELEASE SAVEPOINT s');
      } catch (_) { await client.query('ROLLBACK TO SAVEPOINT s').catch(() => {}); erased[t] = 'skipped'; }
    }
    // 3) anonymise the child record (keep a statutory tombstone, don't drop)
    const note = `Personal data erased ${new Date().toISOString().slice(0, 10)} under GDPR erasure request #${requestId}. ` +
      `Statutory records (safeguarding, accident/incident, medication, financial, attendance register) retained and flagged per the retention schedule.`;
    await client.query(`
      UPDATE children SET
        first_name='Former', last_name='child', preferred_name=NULL, preferred_forename=NULL, preferred_surname=NULL,
        parent_1_name=NULL, parent_1_email=NULL, parent_1_phone=NULL,
        parent_2_name=NULL, parent_2_email=NULL, parent_2_phone=NULL,
        emergency_contact_1_name=NULL, emergency_contact_1_phone=NULL, emergency_contact_1_relation=NULL,
        emergency_contact_2_name=NULL, emergency_contact_2_phone=NULL,
        address_line1=NULL, postcode=NULL, gp_name=NULL, gp_phone=NULL, nhs_number=NULL,
        allergies=NULL, dietary_requirements=NULL, medical_notes=NULL, notes=NULL,
        photo_url=NULL, photo_consent=false, media_consent=false,
        is_active=false, status='erased',
        erased_at=now(), erasure_request_id=$2, erasure_note=$3
      WHERE id=$1`, [childId, requestId, note]);
    // 4) revoke parent portal access + any live keepsake links
    try { await client.query(`UPDATE parent_portal_access SET is_active=false, email='erased-'||child_id||'@erased.invalid' WHERE child_id=$1`, [childId]); } catch (_) {}
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); client.release();
    throw e;
  }
  client.release();

  // 5) count the RETAINED statutory records (untouched) + flag each in the audit log
  for (const r of RETAIN_TABLES) {
    try {
      const c = await db.query(`SELECT count(*)::int n FROM ${r.table} WHERE child_id=$1`, [childId]);
      retained[r.table] = { count: c.rows[0].n, reason: r.why };
      if (c.rows[0].n > 0)
        await recordAudit({ req, action: 'update', entity_type: 'retained_record', entity_id: `${r.table}:${childId}`,
          meta: { child_id: childId, request_id: requestId, table: r.table, count: c.rows[0].n, reason: r.why } });
    } catch (_) { retained[r.table] = { count: 'n/a', reason: r.why }; }
  }

  // 6) unlink media files that are now orphaned (no remaining references anywhere)
  let mediaDeleted = 0;
  for (const b of mediaBasenames) {
    try {
      const ref = await db.query(`
        SELECT 1 FROM observations WHERE $1 = ANY(photo_urls) LIMIT 1`, ['/uploads/child-photos/' + b]).catch(() => ({ rows: [] }));
      // best-effort orphan check: if any obs/diary still references the basename, keep it
      const stillRef = await db.query(`
        SELECT 1 FROM (
          SELECT unnest(photo_urls) u FROM observations
          UNION ALL SELECT unnest(photo_urls) FROM daily_diary
          UNION ALL SELECT photo_url FROM children WHERE photo_url IS NOT NULL
        ) t WHERE t.u LIKE '%'||$1 LIMIT 1`, [b]).catch(() => ({ rows: [{ x: 1 }] }));
      if (stillRef.rows.length) continue;
      const p = K.resolveMediaPath(b);
      if (p) { fs.unlinkSync(p); mediaDeleted++; }
    } catch (_) {}
  }

  const summary = { kind: 'erasure', erased_at: new Date().toISOString(), erased, retained, media_deleted: mediaDeleted };
  await recordAudit({ req, action: 'delete', entity_type: 'child_erasure', entity_id: childId,
    meta: { request_id: requestId, erased, retained: Object.fromEntries(Object.entries(retained).map(([k, v]) => [k, v.count])), media_deleted: mediaDeleted } });
  return summary;
}

// ── GET /:id/export.json — machine-readable subject-access export (portability) ──
router.get('/:id/export.json', mgrOnly, async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`SELECT * FROM data_subject_requests WHERE id=$1`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    if (!['released', 'approved'].includes(r.status)) return res.status(400).json({ error: 'Request not released' });
    const childId = r.child_id;
    const tables = ['children', 'child_about_me', 'observations', 'daily_diary', 'framework_tracker',
      'first_words', 'next_steps', 'memory_box_entries', 'parent_reports', 'attendance', 'incidents'];
    const dump = {};
    for (const t of tables) {
      const q = await db.query(`SELECT * FROM ${t} WHERE child_id=$1`, [childId]).catch(() => ({ rows: [] }));
      dump[t] = q.rows;
    }
    await recordAudit({ req, action: 'export', entity_type: 'data_request', entity_id: req.params.id, meta: { format: 'json', child_id: childId } });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="subject-access-child-${childId}.json"`);
    res.send(JSON.stringify({
      generated_at: new Date().toISOString(),
      subject_access_request: { id: r.id, child_id: childId, released_at: r.completed_at },
      note: 'Machine-readable export under UK GDPR Art.15 (access) / Art.20 (portability). Some records may be retained separately under statutory retention duties.',
      data: dump,
    }, null, 2));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
