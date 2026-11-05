const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { notify } = require('../services/notification-dispatcher');
const { recordAudit } = require('../utils/audit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
// b237 (2026-08-27): the accidents.* capabilities existed in the matrix but this
// file read none of them — list/read/create/edit-any were open to every
// authenticated member of staff, so an apprentice could modify any accident
// record. requireCapability is the gate; the matrix is now the control.
const { requireCapability, requireCapabilityLevel, hasCapability } = require('../lib/capabilities');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// b237: `SELECT i.*` hands parent_signature_token to every member of staff who can
// read the accident book. That token is the whole of the parent's signing
// credential — POST /sign/:token needs nothing else — so anyone holding it can sign
// an accident form as the parent. Strip it unless the caller can actually sign off
// accidents. Nothing in the staff UI reads it: the token is handed back explicitly
// by POST /:id/notify-parent, which is already manager/deputy only.
async function _stripParentToken(user, rowOrRows) {
  if (await hasCapability(user, 'accidents.sign-off')) return rowOrRows;
  const scrub = r => { if (r) delete r.parent_signature_token; return r; };
  return Array.isArray(rowOrRows) ? rowOrRows.map(scrub) : scrub(rowOrRows);
}

// ── Ensure entry-time signature column exists (idempotent, non-destructive) ──
// Also adds photo_urls (attached accident/injury photos) + injury_nature (the EyLog
// "What Injury Occurred" structured picker) — all additive, never destructive.
let _migrated = false;
async function _ensureColumns() {
  if (_migrated) return;
  try {
    await getPool().query(
      `ALTER TABLE incidents ADD COLUMN IF NOT EXISTS signature_data text`
    );
    await getPool().query(
      `ALTER TABLE incidents ADD COLUMN IF NOT EXISTS photo_urls text[]`
    );
    await getPool().query(
      `ALTER TABLE incidents ADD COLUMN IF NOT EXISTS injury_nature text`
    );
    _migrated = true;
  } catch (e) {
    // Non-fatal: column may already exist or DB momentarily unavailable.
    console.error('[incidents] column migration:', e.message);
  }
}
_ensureColumns();

// GET /photo/:filename is exempted from authenticate() — every real caller renders it
// as a plain <img src>, which browsers never attach an Authorization header to, so it
// always 401'd. It does its own auth (header OR ?token= query fallback) instead. Mirrors
// the same exemption in observations.js.
// E3b: /sign/:token is answered BEFORE authenticate, not after. The parent signing
// route moved to src/routes/incident-sign-public.js; anything still calling the old
// path has no staff JWT (that was the whole bug), so behind the gate it would get a
// bare 401 and never see where the route went.
router.all('/sign/:token', (req, res) => {
  res.status(410).json({
    error: 'moved',
    message: 'Parent signatures are handled by the public link: /accident/:token',
  });
});

router.use((req, res, next) => {
  if (req.method === 'GET' && /^\/photo\//.test(req.path)) return next();
  return authenticate(req, res, next);
});

// Reject a non-numeric :id before it ever reaches a SQL query — used to 500 with a
// raw Postgres "invalid input syntax for type integer" error (bughunt 2026-07-21).
router.param('id', (req, res, next, id) => {
  if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'Invalid id' });
  next();
});

// GET /by-practitioner — manager-only trend view (incidents grouped by reporting practitioner)
router.get('/by-practitioner', async (req, res) => {
  const isManager = hasRole(req.user, ['manager', 'deputy_manager', 'admin']);
  if (!isManager) return res.status(403).json({ error: 'Manager only' });

  const { from, to } = req.query;
  try {
    const db = getPool();
    const params = [];
    let dateFilter = '';

    if (from) {
      params.push(from);
      dateFilter += ` AND i.incident_date >= $${params.length}`;
    }
    if (to) {
      params.push(to);
      dateFilter += ` AND i.incident_date <= $${params.length}`;
    }

    const { rows } = await db.query(`
      SELECT
        s.id as staff_id,
        s.first_name || ' ' || s.last_name as staff_name,
        COUNT(i.id) as incident_count,
        COUNT(CASE WHEN i.incident_type ILIKE '%accident%' THEN 1 END) as accident_count,
        COUNT(CASE WHEN i.incident_type ILIKE '%incident%' THEN 1 END) as incident_count_specific,
        COUNT(CASE WHEN i.status = 'closed' THEN 1 END) as closed_count,
        COUNT(CASE WHEN i.status != 'closed' OR i.status IS NULL THEN 1 END) as open_count,
        json_agg(json_build_object(
          'id', i.id,
          'child_name', c.first_name || ' ' || c.last_name,
          'incident_date', i.incident_date,
          'incident_type', i.incident_type,
          'description', LEFT(i.description, 100),
          'status', COALESCE(i.status, 'open')
        ) ORDER BY i.incident_date DESC) as recent_incidents
      FROM staff s
      LEFT JOIN incidents i ON i.reported_by = s.id ${dateFilter}
      LEFT JOIN children c ON c.id = i.child_id
      GROUP BY s.id, s.first_name, s.last_name
      HAVING COUNT(i.id) > 0
      ORDER BY incident_count DESC, s.last_name
    `, params);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET / — all incidents (optional ?status=, ?child_id=)
// b237: accidents.create at view level is the right key here — the matrix has no
// separate accidents.view, and holding "can file an accident" is what the roles
// that need the accident book have in common.
router.get('/', requireCapability('accidents.create'), async (req, res) => {
  const status  = req.query.status;
  const childId = req.query.child_id ? parseInt(req.query.child_id, 10) : null;
  try {
    const db = getPool();
    let q = `
      SELECT i.*, c.first_name || ' ' || c.last_name as child_name, c.room_id,
             s.first_name || ' ' || s.last_name as reporter_name,
             r.name as room_name
      FROM incidents i
      JOIN children c ON c.id = i.child_id
      JOIN rooms r ON r.id = c.room_id
      LEFT JOIN staff s ON s.id = i.reported_by
    `;
    const params = [];
    const where = [];
    if (status)  { params.push(status);  where.push(`i.status=$${params.length}`); }
    if (childId) { params.push(childId); where.push(`i.child_id=$${params.length}`); }
    if (where.length) q += ' WHERE ' + where.join(' AND ');
    q += ' ORDER BY i.created_at DESC LIMIT 100';
    const { rows } = await db.query(q, params);
    res.json(await _stripParentToken(req.user, rows));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /:id
router.get('/:id', requireCapability('accidents.create'), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT i.*, c.first_name || ' ' || c.last_name as child_name,
             s.first_name || ' ' || s.last_name as reporter_name,
             to_char(i.incident_date, 'YYYY-MM-DD') AS incident_ymd,
             to_char(i.incident_time, 'HH24:MI') AS incident_hm
      FROM incidents i
      JOIN children c ON c.id = i.child_id
      LEFT JOIN staff s ON s.id = i.reported_by
      WHERE i.id=$1
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(await _stripParentToken(req.user, rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /
router.post('/', requireCapabilityLevel('accidents.create', 'edit'), async (req, res) => {
  const { child_id, incident_date, incident_time, incident_type, location,
          description, injury_description, injury_nature, first_aid_given,
          body_map_area, body_map_data, signature_data, witness_name, photo_urls } = req.body;
  if (!child_id || !description) {
    return res.status(400).json({ error: 'child_id and description required' });
  }
  try {
    await _ensureColumns();
    const db = getPool();
    // body_map_data is jsonb; serialise objects, pass null through.
    const bodyMapDataParam = (body_map_data === undefined || body_map_data === null)
      ? null
      : (typeof body_map_data === 'string' ? body_map_data : JSON.stringify(body_map_data));
    // photo_urls is text[]; node-pg maps a JS array directly. Only keep string URLs.
    const photoUrlsParam = Array.isArray(photo_urls)
      ? photo_urls.filter(u => typeof u === 'string' && u).slice(0, 10)
      : null;
    const { rows } = await db.query(`
      INSERT INTO incidents (child_id, reported_by, incident_date, incident_time,
        incident_type, location, description, injury_description, injury_nature, first_aid_given,
        body_map_area, body_map_data, signature_data, witness_name, photo_urls)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [child_id, req.user.id,
        incident_date || new Date().toISOString().split('T')[0],
        incident_time, incident_type, location,
        description, injury_description, injury_nature || null, first_aid_given,
        body_map_area || null, bodyMapDataParam, signature_data || null,
        // accept both 'witness_name' and the accident form's 'witnesses' key
        (witness_name || req.body.witnesses) || null, photoUrlsParam]);
    const { rows: childRow } = await db.query(
      `SELECT first_name || ' ' || last_name as name FROM children WHERE id=$1`, [child_id]
    ).catch(() => ({ rows: [] }));
    const childName = childRow[0]?.name || `Child #${child_id}`;
    const isSevere = ['head_injury','hospital','severe'].some(s =>
      (incident_type || '').toLowerCase().includes(s) ||
      (injury_description || '').toLowerCase().includes(s)
    );
    const category = isSevere ? 'incident_severe' : 'incident_reported';
    notify(category, 'all-managers', null,
      `${isSevere ? '🚨 Severe incident' : 'Incident reported'}: ${childName}`,
      `${incident_type || 'Incident'} at ${location || 'nursery'}. ${description.slice(0,200)}`,
      { priority: isSevere ? 'urgent' : 'normal',
        relatedTable: 'incidents', relatedId: rows[0].id,
        link: '/incidents.html' }
    );
    recordAudit({ req, action: 'create', entity_type: 'incident', entity_id: rows[0].id,
      meta: { child_id, incident_type: incident_type || null, severe: isSevere } });
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Accident DRAFTS (2026-11-02) ─────────────────────────────────────────────
// status='draft' rows are accidents typed up from the manager's notes that a
// practitioner still has to check, finish and publish from Nest
// (/ey/incident/new?id=N). A draft is NOT yet a filed accident: it is kept out
// of the parent Forms list (src/lib/parent-forms.js), the parent signing link
// (notify-parent below + incident-sign-public.js) and manager sign-off. It is
// "filed" — and the managers are told, exactly as POST / tells them — when its
// status moves draft → open here.
//
// Who may finish one: accidents.edit (edit) as before, OR — for a row that is
// still a draft — accidents.create (edit). A practitioner holds accidents.edit
// at 'view' only, so without this they could file a new accident but not finish
// a drafted one, which is the same act. The draft path is narrow: form fields
// only, status only 'draft' or 'open', and the UPDATE is conditional on the row
// still being a draft (a manager publishing it first wins).
const DRAFT_TAG_RE = /[ \t]*\[DRAFT from Toby['’]s notes[^\]]*\][ \t]*/gi;
function _stripDraftTag(text) {
  if (text == null) return text;
  return String(text).replace(DRAFT_TAG_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
const DRAFT_EDITABLE = new Set(['incident_type', 'incident_date', 'incident_time', 'location',
  'description', 'injury_description', 'injury_nature', 'first_aid_given', 'witness_name',
  'photo_urls', 'body_map_area', 'body_map_data', 'signature_data', 'status']);

async function _guardIncidentPut(req, res, next) {
  try {
    const { capabilityLevel, levelRank } = require('../lib/capabilities');
    if (levelRank(await capabilityLevel(req.user, 'accidents.edit')) >= levelRank('edit')) return next();
    if (levelRank(await capabilityLevel(req.user, 'accidents.create')) >= levelRank('edit')) {
      const { rows } = await getPool().query(`SELECT status FROM incidents WHERE id=$1`, [req.params.id]);
      if (rows.length && rows[0].status === 'draft') { req._draftOnly = true; return next(); }
    }
  } catch (e) { /* fall through to 403 */ }
  return res.status(403).json({ error: 'You do not have permission to edit this accident record',
    capability: 'accidents.edit', required_level: 'edit' });
}

// Tell the managers about a newly filed accident — the same message POST / sends.
async function _notifyFiled(db, row) {
  const { rows: childRow } = await db.query(
    `SELECT first_name || ' ' || last_name as name FROM children WHERE id=$1`, [row.child_id]
  ).catch(() => ({ rows: [] }));
  const childName = childRow[0]?.name || `Child #${row.child_id}`;
  const isSevere = ['head_injury','hospital','severe'].some(s =>
    (row.incident_type || '').toLowerCase().includes(s) ||
    (row.injury_description || '').toLowerCase().includes(s)
  );
  const category = isSevere ? 'incident_severe' : 'incident_reported';
  notify(category, 'all-managers', null,
    `${isSevere ? '🚨 Severe incident' : 'Incident reported'}: ${childName}`,
    `${row.incident_type || 'Incident'} at ${row.location || 'nursery'}. ${String(row.description || '').slice(0,200)}`,
    { priority: isSevere ? 'urgent' : 'normal',
      relatedTable: 'incidents', relatedId: row.id,
      link: '/incidents.html' }
  );
  return isSevere;
}

// PUT /:id
router.put('/:id', _guardIncidentPut, async (req, res) => {
  const { parent_notified, parent_notified_at, manager_reviewed,
          status, first_aid_given, description, injury_description, injury_nature,
          body_map_area, body_map_data, signature_data, photo_urls,
          incident_type, incident_date, incident_time, location } = req.body;
  // the accident form posts 'witnesses' (POST / accepts both); take either here too
  const witness_name = req.body.witness_name !== undefined ? req.body.witness_name : req.body.witnesses;
  try {
    await _ensureColumns();
    const db = getPool();
    const { rows: cur } = await db.query(`SELECT status, description FROM incidents WHERE id=$1`, [req.params.id]);
    if (!cur.length) return res.status(404).json({ error: 'Not found' });
    const wasDraft = cur[0].status === 'draft';
    const publishing = wasDraft && status !== undefined && status !== 'draft';
    if (req._draftOnly && status !== undefined && !['draft', 'open'].includes(status)) {
      return res.status(400).json({ error: "A draft can only be saved as a draft or published (status 'open')" });
    }
    if (!wasDraft && status === 'draft') {
      return res.status(400).json({ error: 'A filed accident cannot be turned back into a draft' });
    }
    const updates = [];
    const vals = [];
    const add = (col, val) => {
      if (val === undefined) return;
      if (req._draftOnly && !DRAFT_EDITABLE.has(col)) return;
      vals.push(val); updates.push(`${col}=$${vals.length}`);
    };
    add('parent_notified', parent_notified);
    add('parent_notified_at', parent_notified_at);
    add('manager_reviewed', manager_reviewed);
    add('manager_reviewed_at', manager_reviewed ? new Date() : undefined);
    add('status', status);
    add('incident_type', incident_type);
    if (incident_date !== undefined) {
      if (incident_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(incident_date))) {
        return res.status(400).json({ error: 'incident_date must be YYYY-MM-DD' });
      }
      add('incident_date', incident_date);
    }
    if (incident_time !== undefined) {
      if (incident_time !== null && incident_time !== '' && !/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(String(incident_time))) {
        return res.status(400).json({ error: 'incident_time must be HH:MM' });
      }
      add('incident_time', incident_time === '' ? null : incident_time);
    }
    add('location', location);
    add('first_aid_given', first_aid_given);
    // Publishing strips the "[DRAFT from Toby's notes …]" tag — from the text sent, or
    // from the stored text when the description itself was not re-sent.
    if (publishing) add('description', _stripDraftTag(description !== undefined ? description : cur[0].description));
    else add('description', description);
    add('injury_description', injury_description);
    add('injury_nature', injury_nature);
    // photo_urls: an edit can drop a photo — pass the new array (text[]) and it persists.
    if (photo_urls !== undefined) {
      add('photo_urls', Array.isArray(photo_urls)
        ? photo_urls.filter(u => typeof u === 'string' && u).slice(0, 10)
        : null);
    }
    add('body_map_area', body_map_area);
    if (body_map_data !== undefined) {
      add('body_map_data', body_map_data === null ? null
        : (typeof body_map_data === 'string' ? body_map_data : JSON.stringify(body_map_data)));
    }
    add('signature_data', signature_data);
    add('witness_name', witness_name);
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });
    // A drafted accident has no reporter yet: whoever publishes it files it.
    if (publishing) { vals.push(req.user.id); updates.push(`reported_by=COALESCE(reported_by, $${vals.length})`); }
    vals.push(req.params.id);
    // The draft-only path, and any publish, only lands while the row is still a draft —
    // so two people publishing at once notify the managers once, not twice.
    const draftCond = (req._draftOnly || publishing) ? ` AND status='draft'` : '';
    const { rows } = await db.query(
      `UPDATE incidents SET ${updates.join(',')} WHERE id=$${vals.length}${draftCond} RETURNING *`, vals
    );
    if (!rows.length) return res.status(409).json({ error: 'This draft has already been published — reload to see it' });
    let severe = null;
    if (publishing && rows[0].status !== 'draft') {
      try { severe = await _notifyFiled(db, rows[0]); } catch (e) { console.error('[incidents] publish notify:', e.message); }
    }
    recordAudit({ req, action: publishing ? 'publish' : 'update', entity_type: 'incident', entity_id: req.params.id,
      meta: { fields: updates.map(u => u.split('=')[0]), ...(publishing ? { from: 'draft', to: rows[0].status, severe } : {}),
              ...(req._draftOnly ? { via: 'draft-finish' } : {}) } });
    res.json(await _stripParentToken(req.user, rows[0]));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/notify-parent — generate parent signature link and mark notified
router.post('/:id/notify-parent', async (req, res) => {
  const isManager = hasRole(req.user, ['manager','deputy_manager', 'admin']);
  if (!isManager) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    // E3b: the token now expires. Minting a fresh one supersedes any outstanding
    // link for this incident, which is what a manager pressing the button again means.
    const days = Math.max(1, parseInt(process.env.INCIDENT_SIGN_TOKEN_DAYS || '14', 10) || 14);
    const { rows } = await db.query(
      `UPDATE incidents SET parent_notified=true, parent_notified_at=NOW(),
         parent_notified_by=$2, parent_signature_requested=true,
         parent_signature_token=gen_random_uuid(),
         parent_signature_expires_at=NOW() + ($3::int * INTERVAL '1 day')
       WHERE id=$1 AND status IS DISTINCT FROM 'draft'
       RETURNING id, parent_signature_token, parent_signature_expires_at, child_id`,
      [req.params.id, req.user.id, days]
    );
    if (!rows.length) {
      // 2026-11-02: a draft is not a filed accident — no parent link until it is published.
      const { rows: d } = await db.query(`SELECT 1 FROM incidents WHERE id=$1 AND status='draft'`, [req.params.id]);
      if (d.length) return res.status(409).json({ error: 'This accident is still a draft — publish it from Nest before sending it to the parent' });
      return res.status(404).json({ error: 'Not found' });
    }
    // E3b: this used to be ADMIN_BASE_URL — the Roost host, behind a Cloudflare Access
    // policy for the owner alone, so the link a parent was sent could never be opened
    // by that parent. It points at the PARENTS host and at the public, token-only page
    // (src/routes/incident-sign-public.js), not at an /api path.
    // NOTE for whoever reads this next: parents.example-nursery.co.uk is itself
    // behind Cloudflare Access (email OTP), which parents already use for the portal.
    // If a no-login link is ever wanted, set INCIDENT_SIGN_PUBLIC_BASE to the EY host,
    // which is what viewings-public.js does for the same reason.
    const baseUrl = (process.env.INCIDENT_SIGN_PUBLIC_BASE
                  || process.env.PARENTS_BASE_URL
                  || 'https://parents.example-nursery.co.uk').replace(/\/+$/, '');
    res.json({
      ok: true,
      sign_url: `${baseUrl}/accident/${rows[0].parent_signature_token}`,
      expires_at: rows[0].parent_signature_expires_at,
      token: rows[0].parent_signature_token,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// E3b (2026-10-20): /sign/:token USED TO LIVE HERE, and it was neither of the things
// its comment claimed. It sat behind this file's `authenticate`, so it was not public —
// a parent could not use it — and because any authenticated member of staff could POST
// it with a token from the accident book, staff could record the PARENT as having
// signed. Both halves now live in src/routes/incident-sign-public.js, mounted pre-auth
// and portal-agnostic, where the token is the only credential accepted and no staff JWT
// will do: GET /accident/:token, GET/POST /api/public/accident/:token[/sign].
//
// Deliberately NOT re-added here under any name. A staff JWT must not be able to sign
// as a parent, and the only way to guarantee that is for no authenticated route to
// offer it. Managers sign off their own half with POST /:id/sign-off below.
//
// Anything still calling GET/POST /api/incidents/sign/:token gets a 410 naming the new
// path rather than a confusing 404 — answered above `authenticate`, since such a caller
// has no staff JWT by definition.

// POST /:id/sign-off — manager signs off incident
// b237: the manager/deputy role check STAYS — the capability gate is added on top,
// so the stricter of the two wins. Loosening sign-off was never the intent.
router.post('/:id/sign-off', requireCapabilityLevel('accidents.sign-off', 'approve'), async (req, res) => {
  if (!hasRole(req.user, ['manager','deputy_manager', 'admin'])) return res.status(403).json({ error: 'Manager only' });
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE incidents SET manager_reviewed=true, manager_reviewed_at=NOW(),
         manager_sign_off_at=NOW(), manager_signed_by=$2, status='closed'
       WHERE id=$1 AND status IS DISTINCT FROM 'draft' RETURNING *`,
      [req.params.id, req.user.id]
    );
    // 2026-11-02: a draft cannot be signed off (closed) before it has been published.
    if (!rows.length) return res.status(409).json({ error: 'Not found, or still a draft — publish it from Nest first' });
    recordAudit({ req, action: 'sign-off', entity_type: 'incident', entity_id: req.params.id });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Incident photo upload / serve / delete ─────────────────────────────────────
// Mirrors the observation-photo mechanism (observations.js). Photos of the injury or
// the location of an accident/incident, matching EyLog's "Add a photo of the injury or
// the location of the accident/incident". Images only, ≤8MB, up to 6 per report.
const INC_UPLOAD_DIR = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'incidents')
  : path.join(__dirname, '../../data/ladn/uploads/incidents');

const _incStorage = multer.diskStorage({
  destination(req, file, cb) {
    fs.mkdirSync(INC_UPLOAD_DIR, { recursive: true });
    cb(null, INC_UPLOAD_DIR);
  },
  filename(req, file, cb) {
    const ext = (path.extname(file.originalname).toLowerCase() || '.jpg').replace(/[^.a-z0-9]/g, '');
    cb(null, `inc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}${ext || '.jpg'}`);
  },
});
const _incUpload = multer({
  storage: _incStorage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB per image
  fileFilter(req, file, cb) {
    cb(null, /^image\/(jpeg|png|webp|gif|heic|heif)$/.test(file.mimetype));
  },
});

// POST /upload — accident/incident photo upload (up to 6 images ≤8MB each)
router.post('/upload', requireCapabilityLevel('accidents.create', 'edit'), _incUpload.array('photos', 6), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files uploaded' });
  const urls = req.files.map(f => `/api/incidents/photo/${f.filename}`);
  res.json({ urls });
});

// GET /photo/:filename — serve an uploaded incident photo.
// Exempted from authenticate() above; a plain <img src> can't carry an Authorization
// header. b491 (2026-10-12): the ?token= fallback used to accept the same long-lived
// session JWT as the header path (release CHECK.md F1) — now a short-lived (≤10min)
// token signed with MEDIA_URL_KEY instead (src/lib/media-url.js), same claim shape
// so decoded.role below is unchanged. See observations.js's photo route for the
// fuller comment — this mirrors it.
router.get('/photo/:filename', async (req, res) => {
  const header = req.headers['authorization'] || '';
  const headerTok = header.startsWith('Bearer ') ? header.slice(7) : (req.headers['x-wren-token'] || '');
  let decoded;
  if (headerTok) {
    try {
      decoded = jwt.verify(headerTok, process.env.JWT_SECRET);
      if (!decoded.aud || decoded.aud !== (req._portal || 'learning')) {
        return res.status(401).json({ error: 'Invalid token audience' });
      }
    } catch {
      return res.status(401).json({ error: 'Invalid token' });
    }
  } else if (req.query.token) {
    decoded = require('../lib/media-url').verifySessionToken(req.query.token, req._portal || 'learning');
    if (!decoded) return res.status(403).json({ error: 'invalid_or_expired_media_url' });
    if ((req._portal || 'learning') === 'learning' && !(await require('../lib/device-token').isAllowed(req))) {
      return res.status(403).json({ error: 'device_required' });
    }
  } else {
    return res.status(401).json({ error: 'Unauthorised' });
  }
  const name = path.basename(req.params.filename); // strip path traversal
  // Parents never fetch incident photos through this route in the current flow;
  // restrict this endpoint to staff/manager portals only.
  if (decoded.role === 'parent') return res.status(403).json({ error: 'Forbidden' });
  const full = path.join(INC_UPLOAD_DIR, name);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Not found' });
  res.sendFile(full);
});

// DELETE /photo/:filename — remove a stored incident photo file from disk.
// Backs the "remove attached image" control: an unsaved (orphan) upload can be deleted
// so it doesn't linger; removing a photo from a saved incident is done via PUT photo_urls.
router.delete('/photo/:filename', (req, res) => {
  const name = path.basename(req.params.filename); // strip path traversal
  if (!/^inc_[a-z0-9_.]+$/i.test(name)) return res.status(400).json({ error: 'Invalid filename' });
  const full = path.join(INC_UPLOAD_DIR, name);
  try {
    if (fs.existsSync(full)) fs.unlinkSync(full);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
