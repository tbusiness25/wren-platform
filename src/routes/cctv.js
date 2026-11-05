'use strict';
// ─────────────────────────────────────────────────────────────────────────────
// b249 — CCTV footage disclosure requests.
//
// The fields are the ten rows of "CCTV Footage Disclosure Request Form - Little
// Angels Day Nursery.docx", one for one. What the paper cannot do, and this
// does, is run the clock.
//
// ── TWO DEADLINES. THE SHORT ONE IS THE REAL ONE ─────────────────────────────
//   ONE CALENDAR MONTH  to respond. Statutory (CCTV Policy §6, UK GDPR Art. 12).
//   SEVEN DAYS          until the footage is overwritten and gone forever
//                       (Policy §4; the DPIA considered 30 days and rejected it).
//
//   Answer inside the month but act after the week and the answer is "sorry, it
//   was overwritten". So:
//     · the queue is ORDERED BY footage_expires_at, never by request date;
//     · every response carries days_to_overwrite, and the UI paints it red;
//     · submitting a request immediately raises the preserve action.
//   Getting this backwards would make the feature worse than the paper form,
//   because paper does not imply that anything is being taken care of.
//
// ── THREE DOORS, ONE TABLE ───────────────────────────────────────────────────
//   parentRouter   /welcome/cctv-request/api/*  — parents. Identity comes from
//                  b239's resolver via the portal-wide gate; NEVER a header,
//                  never a caller-supplied address.
//   router         /api/cctv/*                  — staff raise their own; managers
//                  get the queue and the decisions.
//   Decisions, identity verification and preservation are MANAGER ONLY, checked
//   server-side, and every state change writes ladn.cctv_request_audit.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const parentRouter = express.Router();

const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { parentEmailOf } = require('../lib/parent-identity');
const preserveLib = require('../lib/cctv-preserve');

let _notify = null;
try { _notify = require('../services/notification-dispatcher').notify; } catch (_) { _notify = null; }

const MANAGER_ROLES = new Set(['manager', 'deputy_manager', 'admin']);
const isManager = u => !!(u && MANAGER_ROLES.has(u.role));

// The five triggers in CCTV Policy §3. Free text is not enough: the policy
// enumerates them, an access outside them is a policy breach, and a log that
// cannot be counted by trigger cannot be reviewed at the annual review.
const TRIGGERS = {
  safeguarding: 'A safeguarding concern or allegation (including against a member of staff)',
  accident:     'An accident or injury where the cause is unclear or disputed',
  complaint:    'A complaint from a parent, carer or member of staff',
  security:     'A security incident (break-in, damage, intruder, missing property)',
  statutory:    'A lawful request from police, Ofsted, the LADO or another agency with statutory authority',
};

const DECISIONS = new Set(['disclose', 'redact', 'refuse']);

// ── The retention window, read from the policy row, not hard-coded ───────────
/**
 * Seven days, per CCTV Policy v1.1 §4 — but read from
 * ladn.retention_policies.cctv_footage so a DPO change to the policy moves the
 * clock without a code edit. The figure is then STAMPED onto the request
 * (retention_days), because a request raised under a 7-day policy must keep
 * showing the deadline it was raised under even if the policy later changes.
 */
const FALLBACK_RETENTION_DAYS = 7;
async function retentionDays(db) {
  try {
    const { rows } = await db.query(
      `SELECT EXTRACT(EPOCH FROM retention_rule) / 86400 AS days
         FROM retention_policies WHERE record_type = 'cctv_footage' LIMIT 1`);
    const d = Math.round(Number(rows[0] && rows[0].days));
    return Number.isFinite(d) && d > 0 ? d : FALLBACK_RETENTION_DAYS;
  } catch (_) {
    return FALLBACK_RETENTION_DAYS;
  }
}

// ── Reference ────────────────────────────────────────────────────────────────
// A human-quotable reference, because a parent chasing this on the phone should
// not have to say "request number 41". Year-scoped and gap-tolerant: it is a
// label, not a count.
async function nextReference(db) {
  const year = new Date().getFullYear();
  const { rows } = await db.query(
    `SELECT COUNT(*)::int AS n FROM cctv_footage_requests
      WHERE reference LIKE $1`, [`CCTV-${year}-%`]);
  return `CCTV-${year}-${String((rows[0].n || 0) + 1).padStart(4, '0')}`;
}

// ── Audit ────────────────────────────────────────────────────────────────────
// Awaited, never fire-and-forget. A decision on someone's personal data that is
// not recorded did not happen in a way anyone can defend at an inspection.
async function auditReq(db, { requestId, event, actorType, actorEmail, actorStaffId, detail, req }) {
  await db.query(
    `INSERT INTO cctv_request_audit
       (request_id, event, actor_type, actor_email, actor_staff_id, detail, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [requestId, String(event).slice(0, 40), actorType,
     actorEmail ? String(actorEmail).toLowerCase().slice(0, 200) : null,
     actorStaffId || null,
     detail ? JSON.stringify(detail) : null,
     req ? String(req.ip || '').slice(0, 45) : null,
     req ? String(req.headers['user-agent'] || '').slice(0, 1000) : null]);
}

// ── Shaping ──────────────────────────────────────────────────────────────────
const DAY_MS = 86400000;

/**
 * daysToOverwrite — whole days from now until the footage is gone. Negative
 * means it already has been. Deliberately rounded DOWN (floor), so "0 days"
 * means today and never flatters the time left.
 */
function daysToOverwrite(row) {
  const t = new Date(row.footage_expires_at).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((t - Date.now()) / DAY_MS);
}

function shape(row, { forParent = false } = {}) {
  const days = daysToOverwrite(row);
  const out = {
    id: row.id,
    reference: row.reference,
    requester_type: row.requester_type,
    requester_name: row.requester_name,
    requester_relationship: row.requester_relationship,
    child_id: row.child_id,
    child_name: row.child_name || null,
    request_date: row.request_date,
    incident_date: row.incident_date,
    incident_time_from: row.incident_time_from,
    incident_time_to: row.incident_time_to,
    incident_location: row.incident_location,
    reason: row.reason,
    status: row.status,
    decision: row.decision,
    decision_reason: row.decision_reason,
    responded_on: row.responded_on,
    response_due_date: row.response_due_date,
    footage_expires_at: row.footage_expires_at,
    retention_days: row.retention_days,
    days_to_overwrite: days,
    footage_expired: days != null && days < 0,
    preserve_status: row.preserve_status,
    preserve_error: row.preserve_error,
    preserved: row.preserve_status === 'preserved',
    created_at: row.created_at,
  };
  if (forParent) return out;
  return {
    ...out,
    requester_email: row.requester_email,
    identity_verified: row.identity_verified,
    identity_verified_how: row.identity_verified_how,
    identity_verified_at: row.identity_verified_at,
    third_parties_visible: row.third_parties_visible,
    third_parties_note: row.third_parties_note,
    decision_by_name: row.decision_by_name || null,
    clip_path: row.clip_path ? true : false,   // presence only — never the path
    clip_bytes: row.clip_bytes,
    clip_verified_at: row.clip_verified_at,
    preserve_attempted_at: row.preserve_attempted_at,
  };
}

const SELECT_COLS = `
  r.*,
  TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) AS child_name,
  TRIM(COALESCE(s.first_name,'')  || ' ' || COALESCE(s.last_name,'')) AS decision_by_name
  FROM cctv_footage_requests r
  LEFT JOIN children c ON c.id = r.child_id
  LEFT JOIN staff    s ON s.id = r.decision_by`;

// ── Validation, shared by both doors ─────────────────────────────────────────
function validate(b) {
  const errs = [];
  const incidentDate = String(b.incident_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(incidentDate)) errs.push('incident_date must be YYYY-MM-DD');
  const today = new Date(); today.setHours(23, 59, 59, 999);
  if (incidentDate && new Date(incidentDate + 'T12:00:00') > today) errs.push('The incident cannot be in the future.');
  const reason = String(b.reason || '').trim();
  if (reason.length < 10) errs.push('Please say why you need the footage (at least a sentence).');
  const t = v => (v == null || v === '') ? null : (/^\d{2}:\d{2}$/.test(String(v)) ? String(v) : undefined);
  const from = t(b.incident_time_from), to = t(b.incident_time_to);
  if (from === undefined || to === undefined) errs.push('Times must be HH:MM.');
  return {
    errs,
    value: {
      incident_date: incidentDate,
      incident_time_from: from || null,
      incident_time_to: to || null,
      incident_location: String(b.incident_location || '').trim().slice(0, 300) || null,
      reason: reason.slice(0, 4000),
      requester_name: String(b.requester_name || '').trim().slice(0, 200) || null,
      requester_relationship: String(b.requester_relationship || '').trim().slice(0, 200) || null,
    },
  };
}

/**
 * create — the one INSERT, used by both the parent door and the staff door.
 *
 * Sets BOTH clocks at submission:
 *   response_due_date  = request date + 1 month  (statutory)
 *   footage_expires_at = incident + retention    (physical)
 * and records which retention figure was used, so a later policy change cannot
 * silently rewrite what a family was told.
 */
async function create(db, { requesterType, email, staffId, childId, value, req }) {
  const days = await retentionDays(db);
  const reference = await nextReference(db);
  // The window closes at the END of the incident day plus the retention period —
  // the recorder overwrites by age of recording, and the latest recording from
  // that day is made at closing time. Using the incident's own clock time would
  // claim the footage dies earlier than it does.
  const { rows } = await db.query(
    `INSERT INTO cctv_footage_requests
       (reference, requester_type, requester_email, requester_name, requester_relationship,
        requester_staff_id, child_id, request_date,
        incident_date, incident_time_from, incident_time_to, incident_location, reason,
        response_due_date, footage_expires_at, retention_days, status, preserve_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CURRENT_DATE,
             $8,$9,$10,$11,$12,
             (CURRENT_DATE + INTERVAL '1 month')::date,
             ($8::date + INTERVAL '1 day' + make_interval(days => $13::int)),
             $13::int, 'submitted', 'not_attempted')
     RETURNING *`,
    [reference, requesterType, String(email).toLowerCase(), value.requester_name, value.requester_relationship,
     staffId || null, childId || null,
     value.incident_date, value.incident_time_from, value.incident_time_to,
     value.incident_location, value.reason, days]);

  const row = rows[0];
  await auditReq(db, {
    requestId: row.id, event: 'submitted', actorType: requesterType,
    actorEmail: email, actorStaffId: staffId || null, req,
    detail: { reference, incident_date: value.incident_date, retention_days: days,
              footage_expires_at: row.footage_expires_at },
  });

  // The preserve action is raised NOW, not when a manager gets round to the
  // queue. With the cameras off this records 'disabled'/'unavailable' — which is
  // the honest state and appears on the screen in red. It is never 'preserved'.
  await attemptPreserve(db, row, { actorType: 'system', actorEmail: email, req });

  await notifyManagers(db, row);
  const { rows: full } = await db.query(`SELECT ${SELECT_COLS} WHERE r.id = $1`, [row.id]);
  return full[0];
}

/**
 * attemptPreserve — run the export and WRITE WHATEVER HAPPENED.
 *
 * The result is stamped on the row unconditionally, including the failures.
 * There is no branch here that leaves a failed attempt looking untried, and
 * none that writes 'preserved' without the library having stat'd a real file —
 * which the CHECK constraint independently refuses anyway.
 */
async function attemptPreserve(db, row, { actorType = 'system', actorEmail = null, actorStaffId = null, cameraId = null, req = null } = {}) {
  let r;
  try {
    r = await preserveLib.preserve(db, row, { cameraId });
  } catch (e) {
    // preserve() is documented never to throw. If it somehow does, that is
    // itself a failure to preserve and is recorded as one.
    r = { status: preserveLib.STATES.FAILED, error: `Preservation crashed: ${e.message}`,
          clip_path: null, clip_bytes: null, verified_at: null, detail: {} };
  }
  await db.query(
    `UPDATE cctv_footage_requests
        SET preserve_status = $1, preserve_error = $2, preserve_attempted_at = now(),
            clip_path = COALESCE($3, clip_path), clip_bytes = COALESCE($4, clip_bytes),
            clip_verified_at = COALESCE($5, clip_verified_at), updated_at = now()
      WHERE id = $6`,
    [r.status, r.error, r.clip_path, r.clip_bytes, r.verified_at, row.id]);
  await auditReq(db, {
    requestId: row.id, event: `preserve_${r.status}`, actorType, actorEmail, actorStaffId, req,
    detail: { ...r.detail, error: r.error, clip_bytes: r.clip_bytes },
  });
  return r;
}

async function notifyManagers(db, row) {
  if (!_notify) return;
  const days = daysToOverwrite(row);
  try {
    const { rows: mgrs } = await db.query(
      `SELECT id FROM staff WHERE is_active = true AND role IN ('manager','deputy_manager')`);
    for (const m of mgrs) {
      await _notify({
        recipient_type: 'staff', recipient_id: m.id, category: 'compliance',
        title: `📹 CCTV footage request ${row.reference}`,
        body: days != null && days >= 0
          ? `The footage is overwritten in ${days} day${days === 1 ? '' : 's'}. Decide and preserve before then — the one-month response deadline is not the deadline that matters.`
          : 'The footage for this request has already been overwritten. It still needs a response within one calendar month.',
        link: '/app.html#cameras', related_table: 'cctv_footage_requests', related_id: row.id,
        priority: 'high',
      });
    }
  } catch (e) { console.error('[cctv] manager notify:', e.message); }
}

// ═════════════════════════════════════════════════════════════════════════════
// PARENT DOOR — /welcome/cctv-request/api/*
// Identity is already resolved by the portal-wide gate in server-unified.js
// (_WELCOME_API_RE → requireParentIdentity). parentEmailOf reads NO header.
// ═════════════════════════════════════════════════════════════════════════════
parentRouter.get('/context', async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  try {
    const { rows: children } = await db.query(
      `SELECT c.id, COALESCE(c.preferred_name, c.first_name) AS name, c.last_name
         FROM parent_portal_access pa JOIN children c ON c.id = pa.child_id
        WHERE lower(pa.email) = $1 AND pa.is_active = true ORDER BY c.first_name`, [email]);
    const { rows } = await db.query(
      `SELECT ${SELECT_COLS} WHERE lower(r.requester_email) = $1 ORDER BY r.created_at DESC LIMIT 50`, [email]);
    res.json({
      children,
      requests: rows.map(r => shape(r, { forParent: true })),
      retention_days: await retentionDays(db),
      cameras_live: false,   // see the note on the page; nothing is recording yet
    });
  } catch (e) {
    console.error('[cctv] parent context:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

parentRouter.post('/create', express.json({ limit: '16kb' }), async (req, res) => {
  const email = parentEmailOf(req);
  if (!email) return res.status(401).json({ error: 'Not authenticated' });
  const db = getPool();
  const { errs, value } = validate(req.body || {});
  if (errs.length) return res.status(400).json({ error: errs.join(' ') });
  try {
    let childId = parseInt((req.body || {}).child_id, 10);
    if (Number.isFinite(childId)) {
      const own = await db.query(
        `SELECT 1 FROM parent_portal_access WHERE lower(email)=$1 AND child_id=$2 AND is_active=true`,
        [email, childId]);
      if (!own.rows.length) return res.status(403).json({ error: 'Not your child' });
    } else { childId = null; }
    const row = await create(db, { requesterType: 'parent', email, childId, value, req });
    res.json({ ok: true, request: shape(row, { forParent: true }) });
  } catch (e) {
    console.error('[cctv] parent create:', e.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// STAFF + MANAGER DOOR — /api/cctv/*
// ═════════════════════════════════════════════════════════════════════════════
router.use(authenticate);

router.get('/triggers', (req, res) => res.json({ triggers: TRIGGERS }));

// Any authenticated member of staff may raise a request (EY → More).
router.get('/mine', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT ${SELECT_COLS} WHERE r.requester_staff_id = $1 ORDER BY r.created_at DESC LIMIT 50`, [req.user.id]);
    res.json({ requests: rows.map(r => shape(r)), retention_days: await retentionDays(db) });
  } catch (e) {
    console.error('[cctv] mine:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/', express.json({ limit: '16kb' }), async (req, res) => {
  const db = getPool();
  const { errs, value } = validate(req.body || {});
  if (errs.length) return res.status(400).json({ error: errs.join(' ') });
  try {
    const { rows: me } = await db.query('SELECT email, first_name, last_name FROM staff WHERE id=$1', [req.user.id]);
    const email = (me[0] && me[0].email) || `staff-${req.user.id}@example-nursery.co.uk`;
    if (!value.requester_name && me[0]) value.requester_name = `${me[0].first_name} ${me[0].last_name}`.trim();
    let childId = parseInt((req.body || {}).child_id, 10);
    if (!Number.isFinite(childId)) childId = null;
    const row = await create(db, { requesterType: 'staff', email, staffId: req.user.id, childId, value, req });
    res.status(201).json({ ok: true, request: shape(row) });
  } catch (e) {
    console.error('[cctv] staff create:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Manager queue ────────────────────────────────────────────────────────────
function managerOnly(req, res, next) {
  if (!isManager(req.user)) {
    return res.status(403).json({ error: 'forbidden_role',
      message: 'Decisions about CCTV disclosure are manager-only (CCTV Policy §3).' });
  }
  next();
}

/**
 * GET /api/cctv/requests — the queue.
 *
 * ORDER BY footage_expires_at. Not created_at, not response_due_date. A request
 * raised this morning about something three days ago is more urgent than one
 * raised last week about yesterday, and sorting by arrival hides that.
 */
router.get('/requests', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const where = [];
    const vals = [];
    if (req.query.status === 'open') where.push(`r.status <> 'closed'`);
    else if (req.query.status) { vals.push(req.query.status); where.push(`r.status = $${vals.length}`); }
    const { rows } = await db.query(
      `SELECT ${SELECT_COLS}
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY (r.status = 'closed'), r.footage_expires_at ASC
       LIMIT 200`, vals);
    res.json({
      requests: rows.map(r => shape(r)),
      triggers: TRIGGERS,
      retention_days: await retentionDays(db),
      preserve: await preserveLib.status(db),
    });
  } catch (e) {
    console.error('[cctv] queue:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/requests/:id', managerOnly, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT ${SELECT_COLS} WHERE r.id = $1`, [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { rows: audit } = await db.query(
      `SELECT a.id, a.event, a.actor_type, a.actor_email, a.detail, a.created_at,
              TRIM(COALESCE(s.first_name,'') || ' ' || COALESCE(s.last_name,'')) AS actor_name
         FROM cctv_request_audit a
         LEFT JOIN staff s ON s.id = a.actor_staff_id
        WHERE a.request_id = $1 ORDER BY a.created_at`, [parseInt(req.params.id, 10)]);
    const { rows: views } = await db.query(
      `SELECT l.id, l.created_at, l.granted, l.trigger_reason, l.outcome, l.exported,
              c.name AS camera_name,
              TRIM(COALESCE(s.first_name,'') || ' ' || COALESCE(s.last_name,'')) AS staff_name
         FROM camera_access_log l
         LEFT JOIN cameras c ON c.id = l.camera_id
         LEFT JOIN staff s ON s.id = l.staff_id
        WHERE l.request_id = $1 ORDER BY l.created_at`, [parseInt(req.params.id, 10)]);
    res.json({ request: shape(rows[0]), audit, views });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH — identity verification, third parties, the decision, the response.
// Manager only, every change audited, and the decision fields move together.
router.patch('/requests/:id', managerOnly, express.json({ limit: '16kb' }), async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  try {
    const { rows: before } = await db.query('SELECT * FROM cctv_footage_requests WHERE id=$1', [id]);
    if (!before.length) return res.status(404).json({ error: 'Not found' });

    if (b.decision != null && b.decision !== '' && !DECISIONS.has(b.decision)) {
      return res.status(400).json({ error: 'decision must be disclose, redact or refuse' });
    }
    // A decision without a reason is not a decision anybody can defend — the
    // paper form has a "Reason for Decision" row for exactly this reason.
    if (b.decision && !String(b.decision_reason || before[0].decision_reason || '').trim()) {
      return res.status(400).json({ error: 'A decision needs a reason recorded against it.' });
    }

    const sets = [];
    const vals = [];
    const put = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };

    if (b.identity_verified != null) {
      put('identity_verified', !!b.identity_verified);
      put('identity_verified_how', String(b.identity_verified_how || '').slice(0, 500) || null);
      put('identity_verified_by', req.user.id);
      sets.push('identity_verified_at = now()');
    }
    if (b.third_parties_visible != null) {
      put('third_parties_visible', !!b.third_parties_visible);
      put('third_parties_note', String(b.third_parties_note || '').slice(0, 1000) || null);
    }
    if (b.decision) {
      put('decision', b.decision);
      put('decision_reason', String(b.decision_reason || before[0].decision_reason || '').slice(0, 4000));
      put('decision_by', req.user.id);
      sets.push('decision_at = now()');
      put('status', b.close ? 'closed' : 'decided');
      sets.push('responded_on = COALESCE(responded_on, CURRENT_DATE)');
    } else if (b.status && ['submitted', 'in_review', 'decided', 'closed'].includes(b.status)) {
      put('status', b.status);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });

    vals.push(id);
    const { rows } = await db.query(
      `UPDATE cctv_footage_requests SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${vals.length} RETURNING *`, vals);

    await auditReq(db, {
      requestId: id, event: b.decision ? `decision_${b.decision}` : 'updated',
      actorType: 'staff', actorStaffId: req.user.id, req,
      detail: { decision: b.decision || null, status: rows[0].status,
                identity_verified: rows[0].identity_verified,
                third_parties_visible: rows[0].third_parties_visible },
    });

    const { rows: full } = await db.query(`SELECT ${SELECT_COLS} WHERE r.id = $1`, [id]);
    res.json({ ok: true, request: shape(full[0]) });
  } catch (e) {
    console.error('[cctv] patch:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/cctv/requests/:id/preserve — try again, by hand.
 *
 * Returns HTTP 200 with the state either way, INCLUDING the failures: a 500
 * would be a stack trace in a log, and this has to be a red box on the manager's
 * screen. `ok` tells the caller whether a clip actually exists.
 */
router.post('/requests/:id/preserve', managerOnly, express.json({ limit: '4kb' }), async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await db.query('SELECT * FROM cctv_footage_requests WHERE id=$1', [id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const cameraId = parseInt((req.body || {}).camera_id, 10);
    const r = await attemptPreserve(db, rows[0], {
      actorType: 'staff', actorStaffId: req.user.id, req,
      cameraId: Number.isFinite(cameraId) ? cameraId : null,
    });
    const { rows: full } = await db.query(`SELECT ${SELECT_COLS} WHERE r.id = $1`, [id]);
    res.json({
      ok: r.status === preserveLib.STATES.PRESERVED,
      status: r.status, error: r.error, request: shape(full[0]),
    });
  } catch (e) {
    console.error('[cctv] preserve:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.parentRouter = parentRouter;
module.exports.TRIGGERS = TRIGGERS;
module.exports.retentionDays = retentionDays;
module.exports.daysToOverwrite = daysToOverwrite;
