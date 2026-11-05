const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
// b237 (2026-08-27) — admissions.* land here rather than admissions-engine.js,
// which is already blanket managerOnly. This is the pipeline staff work in.
const { requireCapability, requireCapabilityLevel, capabilityLevel, levelRank } = require('../lib/capabilities');
// b289 — per-row "where did this child come from / what happens next".
const provenance = require('../lib/pipeline-provenance');
// b398 — the pipeline moves forward on its own, and never backwards.
const { advanceEnquiry } = require('../lib/enquiry-stage');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

// login-20261023: through the one Telegram sender (src/lib/notifications.js) — same text and format,
// plus its dev/MAIL_DISABLED guard, which this private copy never had.
async function _tgPing(text) { return require('../lib/notifications').sendTelegramNow({ text, parse_mode: 'Markdown' }); }

router.use(authenticate);

// b491 (2026-10-12, security hardening item 6) — practitioner holds
// admissions.enquire at 'edit' level in role_capabilities (an admissions-pipeline
// grant, not an EY one), so requireCapability('admissions.enquire') below did
// NOT keep practitioners off the prospective-families pipeline, and most GETs on
// this router (stats/forecast/waiting-list/ai-scores/...) have no capability
// check at all. No EY/practitioner page calls /api/enquiries for anything —
// admissions is an office function.
router.use((req, res, next) => {
  if (hasRole(req.user, ['practitioner', 'apprentice'])) {
    return res.status(403).json({ error: 'Forbidden — enquiries/admissions is not available to this role' });
  }
  next();
});

// GET / — list all enquiries
router.get('/', requireCapability('admissions.enquire'), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT e.*, s.first_name || ' ' || s.last_name AS assigned_to_name,
             -- b532 — the child's EY number: the enrolled child's, else the waiting list's.
             COALESCE((SELECT c.eylog_ref FROM children c WHERE c.enquiry_id = e.id AND c.eylog_ref IS NOT NULL ORDER BY c.id LIMIT 1),
                      (SELECT w.ey_number FROM waiting_list w WHERE w.enquiry_id = e.id AND w.ey_number IS NOT NULL ORDER BY w.id LIMIT 1)) AS ey_number
      FROM enquiries e
      LEFT JOIN staff s ON e.assigned_to = s.id
      ORDER BY e.created_at DESC LIMIT 500
    `);
    // b289 — the pipeline board renders from this. Every card now carries where the
    // child came from and what happens next, because "is she coming across from
    // EyLog or does she need registering here?" is not answerable from the row.
    const enrolIdx = await provenance.loadEnrolmentIndex(db);
    res.json(rows.map(r => ({
      ...r,
      ...provenance.describe({ ...r, room_needed: r.preferred_room || r.room_needed }, enrolIdx),
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /stats — trend statistics for last 12 months
router.get('/stats', async (req, res) => {
  try {
    const db = getPool();
    const [byMonth, bySource, convRate, avgDays] = await Promise.all([
      db.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM') AS month, COUNT(*) AS count
        FROM enquiries
        WHERE created_at >= NOW() - INTERVAL '12 months'
        GROUP BY month ORDER BY month
      `),
      db.query(`
        SELECT COALESCE(source,'Unknown') AS source,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE stage='registered') AS converted
        FROM enquiries GROUP BY source ORDER BY total DESC
      `),
      db.query(`
        SELECT stage, COUNT(*) AS count FROM enquiries GROUP BY stage
      `),
      db.query(`
        SELECT ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/86400)::numeric,1) AS avg_days
        FROM enquiries WHERE stage='registered'
      `),
    ]);
    res.json({
      byMonth: byMonth.rows,
      bySource: bySource.rows,
      byStage: convRate.rows,
      avgDaysToRegistered: avgDays.rows[0]?.avg_days || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /forecast — predicted occupancy per room, next 6 months
router.get('/forecast', async (req, res) => {
  try {
    const db = getPool();
    const [rooms, enrolled, starters] = await Promise.all([
      db.query(`SELECT id, name, capacity FROM rooms ORDER BY id`),
      db.query(`
        SELECT r.id AS room_id, r.name AS room_name, COUNT(c.id) AS enrolled
        FROM rooms r
        LEFT JOIN children c ON c.room_id = r.id AND c.is_active = true
        GROUP BY r.id, r.name
      `),
      db.query(`
        SELECT room_needed,
               TO_CHAR(expected_start_date,'YYYY-MM') AS month,
               COUNT(*) AS starting
        FROM waiting_list_live
        WHERE expected_start_date BETWEEN NOW() AND NOW() + INTERVAL '6 months'
          AND status != 'placed'
        GROUP BY room_needed, month
      `),
    ]);

    const months = [];
    for (let i = 0; i < 6; i++) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() + i);
      months.push(d.toISOString().slice(0, 7));
    }

    const enrolledByRoom = {};
    enrolled.rows.forEach(r => { enrolledByRoom[r.room_id] = { name: r.room_name, count: parseInt(r.enrolled) }; });

    const startersByMonthRoom = {};
    starters.rows.forEach(r => {
      const k = `${r.month}:${r.room_needed}`;
      startersByMonthRoom[k] = parseInt(r.starting);
    });

    const result = months.map(month => {
      const roomData = rooms.rows.map(room => {
        const base = enrolledByRoom[room.id]?.count || 0;
        const key = `${month}:${room.name}`;
        const starting = startersByMonthRoom[key] || 0;
        const predicted = base + starting;
        return {
          room_id: room.id,
          room_name: room.name,
          capacity: room.capacity,
          enrolled: base,
          starting,
          predicted,
          utilisation: room.capacity ? Math.round((predicted / room.capacity) * 100) : 0,
        };
      });
      return { month, rooms: roomData };
    });

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST / — create enquiry
router.post('/', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  const { child_first_name, child_last_name, child_dob, room_needed, preferred_room,
          start_date_requested, preferred_start_date, preferred_days, funded_hours_type,
          parent_name, parent_email, parent_phone, source, notes, assigned_to } = req.body;
  // b532 (Toby, 28 Oct) — a phone number is mandatory: 14 live enquiries had none.
  if (!String(parent_phone || '').replace(/\D/g, '').length) {
    return res.status(400).json({ error: 'A parent phone number is required.' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO enquiries (child_first_name, child_last_name, child_dob, room_needed,
        preferred_room, start_date_requested, preferred_start_date, preferred_days,
        funded_hours_type, parent_name, parent_email, parent_phone, source, notes, assigned_to,
        enquiry_submitted_at, enquiry_date_source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now(),'enquiry')
      RETURNING *
    `, [child_first_name, child_last_name, child_dob||null, room_needed,
        preferred_room, start_date_requested||null, preferred_start_date||null,
        preferred_days||null, funded_hours_type,
        parent_name, parent_email, parent_phone, source, notes, assigned_to||null]);
    const enq = rows[0];
    res.status(201).json(enq);
    // Dual-write into unified comms (fire-and-forget — never block the response)
    _dualWriteEnquiry(db, enq).catch(() => {});
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function _dualWriteEnquiry(db, enq) {
  const { upsertContact, upsertThread, insertThreadMessage, STAGE_TO_STATUS } =
    require('./contacts');
  const status = STAGE_TO_STATUS[enq.stage || 'new'] || 'enquirer';
  const contactId = await upsertContact(db, {
    email: enq.parent_email, phone: enq.parent_phone,
    name: enq.parent_name, status, enquiryId: enq.id,
  });
  const threadId = await upsertThread(
    db, contactId, `Enquiry: ${enq.child_first_name} ${enq.child_last_name || ''}`
  );
  const body = `Enquiry for ${enq.child_first_name} ${enq.child_last_name || ''}\nStage: ${enq.stage || 'new'}${enq.notes ? '\nNotes: '+enq.notes : ''}${enq.message ? '\nMessage: '+enq.message : ''}`;
  await insertThreadMessage(db, {
    threadId, direction: 'in', source: 'enquiry_form',
    bodyText: body, senderEmail: enq.parent_email, senderPhone: enq.parent_phone,
    createdAt: enq.created_at, enquiryId: enq.id,
  });
  const src = enq.source === 'wren_landing' ? 'Wren landing' : (enq.source === 'ladn_site' ? 'LADN website' : (enq.source || 'unknown'));
  _tgPing(`📬 *New enquiry* (${src})\nFrom: ${enq.parent_name || 'Unknown'} ${enq.parent_email ? `<${enq.parent_email}>` : ''}\n${enq.child_first_name ? `Child: ${enq.child_first_name} ${enq.child_last_name || ''}` : ''}${enq.message ? `\nMsg: ${enq.message.slice(0,120)}` : ''}`);
}

// PUT /:id — update fields
// ── 3 Nov 2026: a card past "Waiting list" must have a waiting-list row ─────
// Moving a card by drag or by the drawer's stage list only changed enquiries.stage. Every
// step after "Waiting list" (allocate, the deposit & registration form, enrol) works from
// the family's waiting_list row, so a card moved straight to Forms & deposit had none and
// dead-ended: "No child record yet — the registration form has to come in first", with no
// way to send that form (A.P., 3 Nov; also 214 and 217). The move now makes the row, the
// same action as "→ Waiting list", so it needs the same permission as that button (b429).
const WL_STAGES = ['on_waiting_list', 'offer_made', 'offer_accepted'];
async function waitingListGate(db, enquiryId, stage, req) {
  if (!WL_STAGES.includes(stage)) return { needed: false };
  const { rows } = await db.query(`SELECT 1 FROM waiting_list_live WHERE enquiry_id=$1 LIMIT 1`, [enquiryId]);
  if (rows.length) return { needed: false };
  const level = await capabilityLevel(req.user, 'admissions.offer');
  return { needed: true, allowed: levelRank(level) >= levelRank('approve') };
}
const WL_GATE_FORBIDDEN = { error: 'capability_forbidden', capability: 'admissions.offer', required_level: 'approve',
  message: 'Moving a family past "Waiting list" adds them to the waiting list, which needs permission to offer places.' };

// PUT /:id/details — fill in or correct the family's details at any stage. Lands on the
// enquiry AND the family's waiting-list row (src/lib/family-details.js). Only the fields
// sent are changed, so the drawer sends just what was edited.
router.put('/:id/details', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  const FD = require('../lib/family-details');
  let values;
  try { values = FD.fromBody(req.body, FD.ENQUIRY_FIELDS); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!Object.keys(values).length) return res.status(400).json({ error: 'Nothing to change.' });
  try {
    const db = getPool();
    const row = await FD.update(db, 'enquiries', req.params.id, values);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const wl = await FD.mirrorToWaitlist(db, row.id, values);
    require('../utils/audit').recordAudit({ req, action: 'update', entity_type: 'enquiry', entity_id: Number(row.id),
      meta: { details_fields: Object.keys(values), waiting_list_id: wl ? wl.id : null } });
    res.json({ ...row, waiting_list_id: wl ? wl.id : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  const { stage, notes, lost_reason, preferred_start_date, preferred_room,
          preferred_days, funded_hours_type, assigned_to,
          parent_name, parent_email, parent_phone, room_needed } = req.body;
  try {
    const db = getPool();
    const gate = stage ? await waitingListGate(db, req.params.id, stage, req) : { needed: false };
    if (gate.needed && !gate.allowed) return res.status(403).json(WL_GATE_FORBIDDEN);
    const { rows } = await db.query(`
      UPDATE enquiries SET
        stage=COALESCE($1,stage),
        notes=COALESCE($2,notes),
        lost_reason=COALESCE($3,lost_reason),
        preferred_start_date=COALESCE($4::date,preferred_start_date),
        preferred_room=COALESCE($5,preferred_room),
        preferred_days=COALESCE($6,preferred_days),
        funded_hours_type=COALESCE($7,funded_hours_type),
        assigned_to=COALESCE($8::int,assigned_to),
        parent_name=COALESCE($9,parent_name),
        parent_email=COALESCE($10,parent_email),
        parent_phone=COALESCE($11,parent_phone),
        room_needed=COALESCE($12,room_needed),
        updated_at=NOW()
      WHERE id=$13 RETURNING *
    `, [stage, notes, lost_reason, preferred_start_date||null, preferred_room,
        preferred_days||null, funded_hours_type, assigned_to||null,
        parent_name, parent_email, parent_phone, room_needed, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (gate.needed) await convertToWaitingList(db, rows[0].id, req);
    res.json(rows[0]);
    // b399 (2026-10-06) — a closed enquiry loses its enquiry-mode portal access.
    if (stage === 'lost' || stage === 'declined') {
      require('../lib/enquiry-access').closeEnquiryAccess(getPool(), { enquiryId: rows[0].id, reason: 'enquiry closed' }).catch(() => {});
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/move — explicit stage move
router.post('/:id/move', requireCapabilityLevel('admissions.tour', 'edit'), async (req, res) => {
  const { stage } = req.body;
  if (!stage) return res.status(400).json({ error: 'stage required' });
  const valid = ['new','tour_booked','tour_done','on_waiting_list','offer_made','offer_accepted','registered','declined','lost'];
  if (!valid.includes(stage)) return res.status(400).json({ error: 'Invalid stage' });
  try {
    const db = getPool();
    const gate = await waitingListGate(db, req.params.id, stage, req);
    if (gate.needed && !gate.allowed) return res.status(403).json(WL_GATE_FORBIDDEN);
    const { rows } = await db.query(`
      UPDATE enquiries SET stage=$1, updated_at=NOW() WHERE id=$2 RETURNING *
    `, [stage, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    if (gate.needed) await convertToWaitingList(db, rows[0].id, req);
    res.json(rows[0]);
    // Dual-write: sync contact status when enquiry stage changes
    _dualWriteStageMove(db, rows[0], stage).catch(() => {});
    // b399 (2026-10-06) — a closed enquiry loses its enquiry-mode portal access.
    if (stage === 'lost' || stage === 'declined') {
      require('../lib/enquiry-access').closeEnquiryAccess(db, { enquiryId: rows[0].id, reason: 'enquiry closed' }).catch(() => {});
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function _dualWriteStageMove(db, enq, stage) {
  const { STAGE_TO_STATUS } = require('./contacts');
  const newStatus = STAGE_TO_STATUS[stage] || 'enquirer';
  if (!enq.parent_email) return;
  const { rows } = await db.query(
    `SELECT id, status FROM contacts WHERE lower(primary_email)=$1`,
    [enq.parent_email.toLowerCase()]
  );
  if (!rows.length) return;
  const contact = rows[0];
  if (contact.status === newStatus) return;
  await db.query(
    `UPDATE contacts SET status=$1, status_changed_at=now() WHERE id=$2`,
    [newStatus, contact.id]
  );
  await db.query(
    `INSERT INTO contact_status_history
       (contact_id,from_status,to_status,changed_at,notes)
     VALUES ($1,$2,$3,now(),'synced from enquiry stage change')`,
    [contact.id, contact.status, newStatus]
  );
}

// b428 — factored out of the route below so the suggested-moves "accept" action
// (enquiries.js, and never gmail-inbox-poller.js's auto-apply — see its b424Step)
// can create the real waiting_list row too, instead of just flipping
// enquiries.stage and leaving the family off the Waiting list tab entirely.
async function convertToWaitingList(db, enquiryId, req) {
  const { rows: enqRows } = await db.query(`SELECT * FROM enquiries WHERE id=$1`, [enquiryId]);
  if (!enqRows.length) return undefined; // sentinel: enquiry not found
  const e = enqRows[0];
  // b289 — the bare `ON CONFLICT DO NOTHING` here was decorative: there was no
  // constraint for it to conflict ON, so converting the same enquiry twice (or
  // converting an enquiry for a family already on the list from another source)
  // silently made a second row. Now it conflicts on family_key and blank-fills.
  const { rows: wlRows } = await db.query(`
    INSERT INTO waiting_list (child_first_name, child_last_name, child_dob, room_needed,
      expected_start_date, parent_name, parent_email, parent_phone, source, notes, enquiry_id,
      enquiry_submitted_at, enquiry_date_source,
      family_key)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
            wl_family_key($1::text,$2::text,$7::text))
    ON CONFLICT (family_key) WHERE family_key IS NOT NULL AND merged_into_id IS NULL
    DO UPDATE SET
      child_dob           = COALESCE(waiting_list.child_dob,             EXCLUDED.child_dob),
      room_needed         = COALESCE(NULLIF(waiting_list.room_needed,''),  EXCLUDED.room_needed),
      expected_start_date = COALESCE(waiting_list.expected_start_date,   EXCLUDED.expected_start_date),
      parent_name         = COALESCE(NULLIF(waiting_list.parent_name,''),  EXCLUDED.parent_name),
      parent_email        = COALESCE(NULLIF(waiting_list.parent_email,''), EXCLUDED.parent_email),
      parent_phone        = COALESCE(NULLIF(waiting_list.parent_phone,''), EXCLUDED.parent_phone),
      enquiry_id          = COALESCE(waiting_list.enquiry_id,            EXCLUDED.enquiry_id),
      -- b424 — carry the enquiry's own submitted date across rather than stamping
      -- "now" (the moment it joined the waiting list is not when the family enquired).
      enquiry_submitted_at = COALESCE(waiting_list.enquiry_submitted_at, EXCLUDED.enquiry_submitted_at),
      enquiry_date_source  = COALESCE(waiting_list.enquiry_date_source,  EXCLUDED.enquiry_date_source)
    RETURNING *
  `, [e.child_first_name, e.child_last_name, e.child_dob,
      e.preferred_room || e.room_needed,
      e.preferred_start_date || e.start_date_requested,
      e.parent_name, e.parent_email, e.parent_phone, e.source, e.notes, e.id,
      e.enquiry_submitted_at || e.created_at, e.enquiry_date_source || 'enquiry']);
  // b398 — through the helper, not a direct UPDATE: this used to move a card
  // BACKWARDS (an "offer accepted" card pressed "→ Waiting list" again fell
  // back to "on waiting list"). advanceEnquiry only ever moves a card
  // forward, so pressing this on an already-further-along card is now a
  // harmless no-op instead of a regression.
  await advanceEnquiry(db, enquiryId, 'on_waiting_list', { req, reason: 'added to waiting list' });
  return wlRows[0] || null;
}

// POST /:id/convert-to-waiting-list
router.post('/:id/convert-to-waiting-list', requireCapabilityLevel('admissions.offer', 'approve'), async (req, res) => {
  try {
    const db = getPool();
    const result = await convertToWaitingList(db, req.params.id, req);
    if (result === undefined) return res.status(404).json({ error: 'Enquiry not found' });
    res.status(201).json(result || { message: 'Already on waiting list' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// b428 — managers can correct the enquiry date b424 added (board/drawer "Enquired
// <date>", editable). Always stamps source='manual': a date a person typed in is
// better evidence than any of the inferred sources (date_added, audit_log, …),
// and 'manual' never gets overwritten by scripts/b424-backfill-enquiry-dates.js
// (its own ordering already treats an existing non-'unknown' source as settled).
router.put('/:id/enquiry-date', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  const d = String((req.body || {}).enquiry_submitted_at || '').trim();
  if (!d || isNaN(Date.parse(d))) return res.status(400).json({ error: 'enquiry_submitted_at (a valid date) is required' });
  try {
    const { rows } = await getPool().query(
      `UPDATE enquiries SET enquiry_submitted_at=$1::timestamptz, enquiry_date_source='manual', updated_at=NOW()
        WHERE id=$2 RETURNING id, enquiry_submitted_at, enquiry_date_source`, [d, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    require('../utils/audit').recordAudit({ req, action: 'update', entity_type: 'enquiry', entity_id: Number(req.params.id), meta: { enquiry_date_source: 'manual' } });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.put('/waiting-list/:id/enquiry-date', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  const d = String((req.body || {}).enquiry_submitted_at || '').trim();
  if (!d || isNaN(Date.parse(d))) return res.status(400).json({ error: 'enquiry_submitted_at (a valid date) is required' });
  try {
    const { rows } = await getPool().query(
      `UPDATE waiting_list SET enquiry_submitted_at=$1::timestamptz, enquiry_date_source='manual'
        WHERE id=$2 AND merged_into_id IS NULL RETURNING id, enquiry_submitted_at, enquiry_date_source`, [d, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    require('../utils/audit').recordAudit({ req, action: 'update', entity_type: 'waiting_list', entity_id: Number(req.params.id), meta: { enquiry_date_source: 'manual' } });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /waiting-list — list waiting list
//
// b366 — two query parameters, both off by default so every existing caller gets
// exactly what it got before:
//   ?stale=N     only families with no contact in N months. "Contact" is the most
//                recent of last_contacted_at and the enquiry date — a family who
//                enquired last week has been in touch, even if nobody logged a call.
//   ?archived=1  the archive instead of the working list.
//
// Reads the base table rather than waiting_list_live because the view enumerates
// its columns and so does not carry archived_at. The merged_into_id filter below
// is the view's entire WHERE clause, so this returns the same set it always did.
router.get('/waiting-list', async (req, res) => {
  try {
    const db = getPool();
    const wantArchived = ['1', 'true', 'yes'].includes(String(req.query.archived || '').toLowerCase());
    const staleMonths = Number(req.query.stale);
    const params = [];
    const where = [
      'wl.merged_into_id IS NULL',
      `(wl.status != 'placed' OR wl.status IS NULL)`,
      wantArchived ? 'wl.archived_at IS NOT NULL' : 'wl.archived_at IS NULL',
    ];
    if (Number.isFinite(staleMonths) && staleMonths > 0) {
      params.push(Math.min(120, Math.round(staleMonths)));
      where.push(`GREATEST(
                    COALESCE(wl.last_contacted_at, to_timestamp(0)),
                    COALESCE(e.created_at, wl.date_added, wl.created_at, to_timestamp(0))
                  ) < now() - make_interval(months => $${params.length})`);
    }
    const { rows } = await db.query(`
      SELECT wl.*, e.stage AS enquiry_stage,
             -- 2026-09-29 (the admissions lead) — when the family actually ENQUIRED: the linked enquiry's
             -- date, else the date EyMan/EyLog recorded (date_added), else the row's own date.
             -- created_at alone is the July/August 2026 import date for 52 of the 58 rows.
             -- b428 — prefer the real b424 columns first (set at creation from now on, and
             -- backfilled by scripts/b424-backfill-enquiry-dates.js for history).
             COALESCE(wl.enquiry_submitted_at, e.enquiry_submitted_at, e.created_at, wl.date_added, wl.created_at) AS enquired_at,
             COALESCE(wl.enquiry_date_source, e.enquiry_date_source) AS enquired_source,
             -- b366 — how long since anyone spoke to them, in whole months, so the
             -- list can say "18 months" rather than make the reader do the sum.
             (EXTRACT(EPOCH FROM (now() - GREATEST(
                COALESCE(wl.last_contacted_at, to_timestamp(0)),
                COALESCE(e.created_at, wl.date_added, wl.created_at, to_timestamp(0))
              ))) / 2629746)::int AS months_since_contact,
             ab.first_name || ' ' || ab.last_name AS archived_by_name
      FROM waiting_list wl
      LEFT JOIN enquiries e ON e.id = wl.enquiry_id
      LEFT JOIN staff ab ON ab.id = wl.archived_by
      -- b289: merged_into_id marks a row folded into another by the dedupe. The row
      -- is kept (waiting_list is production data) but it is NOT a second family and
      -- must never be listed, counted, ranked or emailed again.
      WHERE ${where.join('\n        AND ')}
      ORDER BY wl.priority ASC NULLS LAST, wl.date_added ASC
    `, params);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── b366 — archive / restore ────────────────────────────────────────────────
// Toby: "Archive, never delete." A family who stopped replying two years ago is
// not a family who was never there: the row keeps its enquiry date, its notes
// and its place in the history, and comes off the working list. Nothing here
// deletes anything, and a restore puts the row back exactly as it was.
router.post('/waiting-list/:id/archive', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  const reason = String((req.body || {}).reason || '').trim();
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE waiting_list
         SET archived_at = now(), archived_by = $2, archived_reason = NULLIF($3,''),
             notes = concat_ws(E'\n', notes, $4::text)
       WHERE id = $1 AND merged_into_id IS NULL AND archived_at IS NULL
       RETURNING id, archived_at, archived_reason`,
      [req.params.id, (req.user && req.user.id) || null, reason.slice(0, 500),
       `Archived ${new Date().toISOString().slice(0, 10)}${reason ? `: ${reason}` : ''}`]);
    if (!rows.length) return res.status(404).json({ error: 'Not found, or already archived' });
    try { require('../utils/audit').recordAudit({ req, action: 'archive', entity_type: 'waiting_list',
      entity_id: Number(req.params.id), meta: { reason } }); } catch (_) {}
    res.json({ ok: true, ...rows[0] });
    // b399 (2026-10-06) — an archived waiting-list row loses its enquiry-mode portal access.
    require('../lib/enquiry-access').closeEnquiryAccess(db, { waitingListId: req.params.id, reason: reason || 'waiting-list entry archived' }).catch(() => {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/waiting-list/:id/unarchive', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      UPDATE waiting_list
         SET archived_at = NULL, archived_by = NULL, archived_reason = NULL
       WHERE id = $1 AND archived_at IS NOT NULL
       RETURNING id`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found, or not archived' });
    try { require('../utils/audit').recordAudit({ req, action: 'unarchive', entity_type: 'waiting_list',
      entity_id: Number(req.params.id), meta: {} }); } catch (_) {}
    res.json({ ok: true, id: rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /waiting-list — create waiting list entry directly
router.post('/waiting-list', requireCapabilityLevel('admissions.offer', 'edit'), async (req, res) => {
  const { child_first_name, child_last_name, child_dob, room_needed,
          expected_start_date, parent_name, parent_email, parent_phone, source, notes, priority } = req.body;
  // b532 — a phone number is mandatory (42 of 49 waiting children had none).
  if (!String(parent_phone || '').replace(/\D/g, '').length) {
    return res.status(400).json({ error: 'A parent phone number is required.' });
  }
  try {
    const db = getPool();
    const { rows } = await db.query(`
      INSERT INTO waiting_list (child_first_name, child_last_name, child_dob, room_needed,
        expected_start_date, parent_name, parent_email, parent_phone, source, notes, priority,
        enquiry_submitted_at, enquiry_date_source,
        family_key, room_source)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),'waiting_list',
              -- b289: a manager typing a row is trusted to know it is a new child, so a
              -- name clash must NOT be silently folded into someone else's place in the
              -- queue. Key it only when nothing live already holds that key; otherwise
              -- leave family_key NULL so the row stands on its own and shows up in the
              -- duplicate report for a human to decide on.
              (SELECT wl_family_key($1::text,$2::text,$7::text)
                 WHERE NOT EXISTS (SELECT 1 FROM waiting_list w
                                    WHERE w.merged_into_id IS NULL
                                      AND w.family_key = wl_family_key($1::text,$2::text,$7::text))),
              CASE WHEN $4::text IS NULL OR $4::text = '' THEN NULL ELSE 'manual' END)
      RETURNING *
    `, [child_first_name, child_last_name, child_dob||null, room_needed,
        expected_start_date||null, parent_name, parent_email, parent_phone, source, notes, priority||3]);
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /waiting-list/:id/convert-to-child — create child record from waiting list
router.post('/waiting-list/:id/convert-to-child', requireCapabilityLevel('admissions.accept', 'approve'), async (req, res) => {
  try {
    const db = getPool();
    const { rows: wlRows } = await db.query(`SELECT * FROM waiting_list WHERE id=$1`, [req.params.id]);
    if (!wlRows.length) return res.status(404).json({ error: 'Waiting list entry not found' });
    const w = wlRows[0];
    const { room_id } = req.body;

    // b399 (2026-10-06) — reuse a provisional (enquiry-mode) child for this
    // family if one already exists, rather than creating a second child row:
    // the same reuse the registration-link path (onboarding-public.js) does.
    let provisionalChildId = null;
    if (w.enquiry_id) {
      const prov = await db.query(
        `SELECT id FROM children WHERE enquiry_id=$1 AND status='enquiry' LIMIT 1`, [w.enquiry_id]);
      provisionalChildId = prov.rows[0]?.id || null;
    }

    // 2026-10-06 — the waiting list holds the parent and the expected start; carry them
    // across. "Enrol" used to make a child with no parent and no start date, so the family
    // had no billing email or app access and the child showed on registers straight away.
    let childRows;
    if (provisionalChildId) {
      ({ rows: childRows } = await db.query(`
        UPDATE children SET room_id=COALESCE($2,room_id), is_active=true, status='pending',
               parent_1_name=COALESCE(parent_1_name,$3), parent_1_email=COALESCE(parent_1_email,$4),
               parent_1_phone=COALESCE(parent_1_phone,$5), start_date=COALESCE(start_date,$6), updated_at=now()
         WHERE id=$1 RETURNING *
      `, [provisionalChildId, room_id || null, w.parent_name || null,
          w.parent_email ? String(w.parent_email).trim().toLowerCase() : null,
          w.parent_phone || null, w.expected_start_date || null]));
    } else {
      ({ rows: childRows } = await db.query(`
        INSERT INTO children (first_name, last_name, date_of_birth, room_id, is_active,
                              parent_1_name, parent_1_email, parent_1_phone, start_date)
        VALUES ($1,$2,$3,$4,true,$5,$6,$7,$8)
        RETURNING *
      `, [w.child_first_name, w.child_last_name, w.child_dob, room_id||null,
          w.parent_name || null, w.parent_email ? String(w.parent_email).trim().toLowerCase() : null,
          w.parent_phone || null, w.expected_start_date || null]));
    }
    // ensureFamilyAccess also promotes any 'enquiry' access rows to 'parent' (b399).
    try { await require('../lib/family-access').ensureFamilyAccess(db, childRows[0].id); } catch (_) {}
    // b532 — the child keeps the EY number the office has used for them on the waiting list.
    const eyNumber = await require('../lib/ey-number').adoptWaitlistNumber(db, childRows[0].id, w.id);
    if (eyNumber) childRows[0].eylog_ref = eyNumber;

    // NB: waiting_list has no updated_at column (unlike enquiries) — don't set one.
    await db.query(`UPDATE waiting_list SET status='placed' WHERE id=$1`, [req.params.id]);
    // 2026-10-05: a deposit taken while the child was on the waiting list follows them.
    await db.query(`UPDATE child_deposits SET child_id=$1 WHERE waiting_list_id=$2 AND child_id IS NULL`,
      [childRows[0].id, req.params.id]).catch(() => {});
    // …and goes straight onto their account: LADN doesn't hold deposits (Toby, 5 Oct 2026).
    try {
      const { applyDepositToAccount } = require('../lib/deposits');
      const { rows: deps } = await db.query(`SELECT id FROM child_deposits WHERE child_id=$1 AND status='paid'`, [childRows[0].id]);
      for (const d of deps) await applyDepositToAccount(db, d.id, { source: 'manual' });
    } catch (_) { /* the deposit stays recorded; Roost shows it as held until applied */ }
    // b398 — ties the new child back to the enquiry that started this, same as
    // the self-service registration-link path, so neither route can disagree
    // about whether this family's enquiry has been linked.
    if (w.enquiry_id) {
      await db.query(`UPDATE children SET enquiry_id=$1 WHERE id=$2 AND enquiry_id IS NULL`,
        [w.enquiry_id, childRows[0].id]).catch(() => {});
    }
    // b531 — enrolling is the registration form being in (entered by the office).
    // With the deposit too, the card moves to Forms & deposit; Registered comes
    // when the welcome pack is sent.
    if (w.enquiry_id) {
      await require('../lib/enquiry-stage').tryAdvanceToRegistered(db, w.enquiry_id, { req, reason: 'enrolled from waiting list' });
    }
    res.status(201).json(childRows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/reply — store reply, mark enquiry replied
router.post('/:id/reply', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  try {
    const db = getPool();
    await db.query(
      `INSERT INTO enquiry_replies (enquiry_id, staff_id, body) VALUES ($1,$2,$3)`,
      [req.params.id, req.user.id, body]
    );
    await db.query(
      `UPDATE enquiries SET status='replied', replied_at=NOW(), replied_by=$1, updated_at=NOW() WHERE id=$2`,
      [req.user.id, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /:id — remove enquiry
router.delete('/:id', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  try {
    const db = getPool();
    await db.query(`DELETE FROM enquiries WHERE id=$1`, [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /stats-extended — 24-month trends + stage drop-off + time-in-stage
router.get('/stats-extended', async (req, res) => {
  try {
    const db = getPool();
    const monthKeys = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
      monthKeys.push(d.toISOString().slice(0, 7));
    }
    const [byMonth24, convByMonth, bySource, byStage, avgByStage] = await Promise.all([
      db.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM') AS month, COUNT(*) AS total,
               COUNT(*) FILTER (WHERE stage='registered') AS registered
        FROM enquiries
        WHERE created_at >= NOW() - INTERVAL '24 months'
        GROUP BY month ORDER BY month
      `),
      db.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM') AS month,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE stage IN ('registered','offer_accepted')) AS converted
        FROM enquiries
        WHERE created_at >= NOW() - INTERVAL '12 months'
        GROUP BY month ORDER BY month
      `),
      db.query(`
        SELECT COALESCE(source,'Unknown') AS source,
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE stage='registered') AS converted
        FROM enquiries GROUP BY source ORDER BY total DESC
      `),
      db.query(`SELECT stage, COUNT(*) AS count FROM enquiries GROUP BY stage`),
      db.query(`
        SELECT stage,
               ROUND(AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/86400)::numeric,1) AS avg_days
        FROM enquiries
        WHERE stage NOT IN ('new','declined','lost')
        GROUP BY stage
      `),
    ]);
    res.json({
      byMonth24: byMonth24.rows,
      convByMonth: convByMonth.rows,
      bySource: bySource.rows,
      byStage: byStage.rows,
      avgDaysByStage: avgByStage.rows,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /forecast-extended — 12-month weighted/optimistic/pessimistic scenarios
router.get('/forecast-extended', async (req, res) => {
  try {
    const db = getPool();
    const STAGE_WEIGHTS = {
      registered: 0.95, offer_accepted: 0.85, offer_made: 0.55,
      on_waiting_list: 0.35, tour_done: 0.25, tour_booked: 0.15,
      new: 0.08,
    };
    const [rooms, enrolled, pipeline, leavers] = await Promise.all([
      db.query(`SELECT id, name, capacity FROM rooms ORDER BY id`),
      db.query(`
        SELECT c.room_id, COUNT(*) AS enrolled
        FROM children c WHERE c.is_active=true GROUP BY c.room_id
      `),
      db.query(`
        SELECT COALESCE(preferred_room, room_needed) AS room_name,
               TO_CHAR(COALESCE(preferred_start_date, start_date_requested),'YYYY-MM') AS month,
               stage, COUNT(*) AS cnt
        FROM enquiries
        WHERE stage NOT IN ('registered','declined','lost')
          AND COALESCE(preferred_start_date, start_date_requested) BETWEEN NOW() AND NOW()+INTERVAL '12 months'
        GROUP BY room_name, month, stage
      `),
      db.query(`
        SELECT c.room_id, TO_CHAR(c.date_of_birth + INTERVAL '5 years','YYYY-MM') AS month, COUNT(*) AS cnt
        FROM children c WHERE c.is_active=true
          AND c.date_of_birth + INTERVAL '5 years' BETWEEN NOW() AND NOW()+INTERVAL '12 months'
        GROUP BY c.room_id, month
      `),
    ]);
    const months = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + i);
      months.push(d.toISOString().slice(0, 7));
    }
    const enrolledByRoom = {};
    enrolled.rows.forEach(r => { enrolledByRoom[r.room_id] = parseInt(r.enrolled); });
    const leaversByRoomMonth = {};
    leavers.rows.forEach(r => { leaversByRoomMonth[`${r.room_id}:${r.month}`] = parseInt(r.cnt); });

    const result = months.map(month => {
      const roomData = rooms.rows.map(room => {
        const base = enrolledByRoom[room.id] || 0;
        const leavingThisMonth = leaversByRoomMonth[`${room.id}:${month}`] || 0;
        const monthPipeline = pipeline.rows.filter(p => p.room_name === room.name && p.month === month);
        let weightedStarters = 0, optimisticStarters = 0, pessimisticStarters = 0;
        monthPipeline.forEach(p => {
          const cnt = parseInt(p.cnt);
          const w = STAGE_WEIGHTS[p.stage] || 0.1;
          weightedStarters += cnt * w;
          optimisticStarters += cnt;
          pessimisticStarters += p.stage === 'offer_accepted' || p.stage === 'registered' ? cnt : 0;
        });
        const realistic = Math.round(Math.max(0, base - leavingThisMonth + weightedStarters));
        const optimistic = Math.round(Math.max(0, base - leavingThisMonth + optimisticStarters));
        const pessimistic = Math.round(Math.max(0, base - leavingThisMonth + pessimisticStarters));
        return {
          room_id: room.id, room_name: room.name, capacity: room.capacity,
          base, leavers: leavingThisMonth,
          realistic, optimistic, pessimistic,
          realistic_pct: room.capacity ? Math.round(realistic / room.capacity * 100) : 0,
          optimistic_pct: room.capacity ? Math.round(optimistic / room.capacity * 100) : 0,
          pessimistic_pct: room.capacity ? Math.round(pessimistic / room.capacity * 100) : 0,
        };
      });
      return { month, rooms: roomData };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /occupancy-grid — EYworks-pattern grid: attendance by week×day×session×room
router.get('/occupancy-grid', async (req, res) => {
  try {
    const db = getPool();
    const { from, to, group_by = 'week' } = req.query;
    const fromDate = from || new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10);
    const toDate = to || new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10);

    const [roomsRes, gridRes] = await Promise.all([
      db.query(`SELECT id, name, capacity FROM rooms ORDER BY id`),
      db.query(`
        SELECT
          DATE_TRUNC($3, a.date)::date AS period_start,
          a.date,
          c.room_id,
          r.name AS room_name,
          r.capacity,
          COALESCE(a.session,'full_day') AS session,
          COUNT(DISTINCT a.child_id) FILTER (WHERE NOT COALESCE(a.absent,false)) AS places_occupied,
          COUNT(DISTINCT a.child_id) AS children_booked
        FROM attendance a
        JOIN children c ON c.id = a.child_id AND c.is_active = true
        JOIN rooms r ON r.id = c.room_id
        WHERE a.date BETWEEN $1::date AND $2::date
        GROUP BY period_start, a.date, c.room_id, r.name, r.capacity, COALESCE(a.session,'full_day')
        ORDER BY a.date, c.room_id, COALESCE(a.session,'full_day')
      `, [fromDate, toDate, group_by === 'month' ? 'month' : 'week']),
    ]);

    const rooms = roomsRes.rows;
    const periodMap = {};
    gridRes.rows.forEach(row => {
      const pKey = row.period_start;
      if (!periodMap[pKey]) periodMap[pKey] = { period_start: pKey, days: {} };
      const dKey = row.date instanceof Date ? row.date.toISOString().slice(0, 10) : String(row.date).slice(0, 10);
      if (!periodMap[pKey].days[dKey]) periodMap[pKey].days[dKey] = {};
      const rKey = `${row.room_id}:${row.session}`;
      periodMap[pKey].days[dKey][rKey] = {
        room_id: row.room_id, room_name: row.room_name,
        session: row.session, capacity: parseInt(row.capacity) || 0,
        places_occupied: parseInt(row.places_occupied) || 0,
        children_booked: parseInt(row.children_booked) || 0,
      };
    });
    res.json({ rooms, periods: Object.values(periodMap).sort((a, b) => a.period_start < b.period_start ? -1 : 1) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /occupancy-session — children attending a specific date/session/room
router.get('/occupancy-session', async (req, res) => {
  try {
    const db = getPool();
    const { date, session, room_id } = req.query;
    if (!date) return res.status(400).json({ error: 'date required' });
    const { rows } = await db.query(`
      SELECT c.id, c.first_name, c.last_name, c.date_of_birth,
             a.session, a.absent, a.sign_in_time, a.sign_out_time,
             r.name AS room_name
      FROM attendance a
      JOIN children c ON c.id = a.child_id
      JOIN rooms r ON r.id = c.room_id
      WHERE a.date = $1::date
        AND ($2::text IS NULL OR a.session = $2)
        AND ($3::int IS NULL OR c.room_id = $3::int)
      ORDER BY c.first_name, c.last_name
    `, [date, session || null, room_id || null]);
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /ai-scores — waiting list with AI scores
router.get('/ai-scores', async (req, res) => {
  try {
    const db = getPool();
    const [enquiriesRes, roomsRes, childrenRes] = await Promise.all([
      db.query(`
        SELECT e.*,
               EXTRACT(DAY FROM NOW() - e.created_at) AS days_waiting
        FROM enquiries e
        WHERE e.stage NOT IN ('registered','declined','lost')
        ORDER BY e.ai_score DESC NULLS LAST, e.created_at ASC
      `),
      db.query(`SELECT id, name, capacity FROM rooms`),
      db.query(`SELECT room_id, COUNT(*) AS enrolled FROM children WHERE is_active=true GROUP BY room_id`),
    ]);
    const roomCap = {};
    roomsRes.rows.forEach(r => { roomCap[r.name] = { capacity: r.capacity, id: r.id }; });
    const enrolled = {};
    childrenRes.rows.forEach(r => { enrolled[r.room_id] = parseInt(r.enrolled); });
    const withContext = enquiriesRes.rows.map(e => {
      const roomName = e.preferred_room || e.room_needed || '';
      const roomInfo = roomCap[roomName] || {};
      const cap = roomInfo.capacity || 0;
      const enr = enrolled[roomInfo.id] || 0;
      return { ...e, room_capacity: cap, room_enrolled: enr, room_spaces: Math.max(0, cap - enr) };
    });
    res.json(withContext);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/ai-score — compute and save AI score for one enquiry
router.post('/:id/ai-score', async (req, res) => {
  try {
    const db = getPool();
    const { rows: enqRows } = await db.query(`SELECT * FROM enquiries WHERE id=$1`, [req.params.id]);
    if (!enqRows.length) return res.status(404).json({ error: 'Not found' });
    const e = enqRows[0];

    const roomName = e.preferred_room || e.room_needed || '';
    const [roomRes, siblingRes, childrenRes] = await Promise.all([
      db.query(`SELECT id, capacity FROM rooms WHERE name=$1`, [roomName]),
      db.query(`SELECT COUNT(*) AS cnt FROM children WHERE last_name=$1 AND is_active=true`, [e.child_last_name]),
      db.query(`SELECT COUNT(*) AS enrolled FROM children c JOIN rooms r ON r.id=c.room_id WHERE r.name=$1 AND c.is_active=true`, [roomName]),
    ]);
    const room = roomRes.rows[0];
    const hasSibling = parseInt(siblingRes.rows[0]?.cnt || 0) > 0;
    const enrolled = parseInt(childrenRes.rows[0]?.enrolled || 0);
    const capacity = room?.capacity || 0;
    const spaces = Math.max(0, capacity - enrolled);
    const daysWaiting = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 86400000);
    const childAgeMonths = e.child_dob ? Math.floor((Date.now() - new Date(e.child_dob).getTime()) / (30.44 * 86400000)) : null;
    const hasFunding = e.funded_hours_type && e.funded_hours_type !== 'none';

    let score = 0;
    let reasons = [];

    if (spaces > 0) { score += 20; reasons.push(`${spaces} space${spaces>1?'s':''} available`); }
    else { score += 5; reasons.push('Room at capacity (waitlist)'); }
    if (hasSibling) { score += 18; reasons.push('Sibling already enrolled'); }
    if (hasFunding) { score += 15; reasons.push(`Eligible for funded hours (${e.funded_hours_type})`); }
    else { score += 5; }
    if (daysWaiting > 90) { score += 15; reasons.push(`${daysWaiting}d on waiting list`); }
    else if (daysWaiting > 30) { score += 10; reasons.push(`${daysWaiting}d on waiting list`); }
    else { score += 5; }
    if (childAgeMonths !== null) {
      if (roomName === 'Baby Room' && childAgeMonths >= 6 && childAgeMonths <= 24) { score += 20; reasons.push('Ideal age for Baby Room'); }
      else if (roomName === 'Pre-school' && childAgeMonths >= 24 && childAgeMonths <= 60) { score += 20; reasons.push('Ideal age for Pre-school'); }
      else if (childAgeMonths > 0) { score += 8; reasons.push('Age partially matches room range'); }
    }
    if (e.parent_email && e.parent_phone) { score += 7; reasons.push('Full contact details provided'); }
    else if (e.parent_email || e.parent_phone) { score += 3; }
    if (e.notes && e.notes.length > 20) { score += 5; reasons.push('Detailed notes on record'); }

    score = Math.min(100, score);
    const reason = reasons.join('. ') + '.';
    await db.query(`
      UPDATE enquiries SET ai_score=$1, ai_score_reason=$2, ai_score_updated_at=NOW(),
        ai_score_override=false WHERE id=$3
    `, [score, reason, req.params.id]);
    res.json({ id: parseInt(req.params.id), score, reason });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /:id/score-override — manager override with reason (audit logged)
router.post('/:id/score-override', async (req, res) => {
  const { score, reason } = req.body;
  if (score === undefined || !reason) return res.status(400).json({ error: 'score and reason required' });
  try {
    const db = getPool();
    await db.query(`
      UPDATE enquiries SET ai_score=$1, ai_score_reason=$2, ai_score_updated_at=NOW(),
        ai_score_override=true, ai_score_override_reason=$2, ai_score_override_by=$3
      WHERE id=$4
    `, [score, reason, req.user.id, req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /score-all — score up to 30 waiting-list enquiries
router.post('/score-all', async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(`
      SELECT id FROM enquiries
      WHERE stage NOT IN ('registered','declined','lost') AND ai_score IS NULL
      ORDER BY created_at ASC LIMIT 30
    `);
    const results = [];
    for (const row of rows) {
      try {
        const enq = await db.query(`SELECT * FROM enquiries WHERE id=$1`, [row.id]);
        if (!enq.rows.length) continue;
        const e = enq.rows[0];
        const roomName = e.preferred_room || e.room_needed || '';
        const [roomRes, sibRes, chrRes] = await Promise.all([
          db.query(`SELECT id, capacity FROM rooms WHERE name=$1`, [roomName]),
          db.query(`SELECT COUNT(*) AS cnt FROM children WHERE last_name=$1 AND is_active=true`, [e.child_last_name]),
          db.query(`SELECT COUNT(*) AS enrolled FROM children c JOIN rooms r ON r.id=c.room_id WHERE r.name=$1 AND c.is_active=true`, [roomName]),
        ]);
        const hasSibling = parseInt(sibRes.rows[0]?.cnt || 0) > 0;
        const enrolled = parseInt(chrRes.rows[0]?.enrolled || 0);
        const cap = roomRes.rows[0]?.capacity || 0;
        const spaces = Math.max(0, cap - enrolled);
        const daysWaiting = Math.floor((Date.now() - new Date(e.created_at).getTime()) / 86400000);
        const ageMonths = e.child_dob ? Math.floor((Date.now() - new Date(e.child_dob).getTime()) / (30.44 * 86400000)) : null;
        const hasFunding = e.funded_hours_type && e.funded_hours_type !== 'none';
        let score = 0;
        const reasons = [];
        if (spaces > 0) { score += 20; reasons.push(`${spaces} space${spaces>1?'s':''} available`); } else { score += 5; reasons.push('Room at capacity'); }
        if (hasSibling) { score += 18; reasons.push('Sibling enrolled'); }
        if (hasFunding) { score += 15; reasons.push(`Funded hours eligible (${e.funded_hours_type})`); } else { score += 5; }
        if (daysWaiting > 90) { score += 15; reasons.push(`${daysWaiting}d waiting`); } else if (daysWaiting > 30) { score += 10; } else { score += 5; }
        if (ageMonths !== null) {
          if (roomName === 'Baby Room' && ageMonths >= 6 && ageMonths <= 24) { score += 20; reasons.push('Ideal age for Baby Room'); }
          else if (roomName === 'Pre-school' && ageMonths >= 24 && ageMonths <= 60) { score += 20; reasons.push('Ideal age for Pre-school'); }
          else { score += 8; }
        }
        if (e.parent_email && e.parent_phone) { score += 7; }
        if (e.notes && e.notes.length > 20) { score += 5; }
        score = Math.min(100, score);
        await db.query(`UPDATE enquiries SET ai_score=$1, ai_score_reason=$2, ai_score_updated_at=NOW(), ai_score_override=false WHERE id=$3`,
          [score, reasons.join('. '), e.id]);
        results.push({ id: e.id, score });
      } catch {}
    }
    res.json({ scored: results.length, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /import-waiting-list — bulk import from an EyLog enquiry/waitlist CSV ──
// Body = raw CSV (Content-Type text/csv). Maps EyLog export headers -> waiting_list.
// Idempotent: skips rows already present (same child name + DOB). Manager-only.
function _wlParseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (q) { if (c === '"' && n === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r' && n === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; }
    else if (c === '\n' || c === '\r') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  row.push(field); if (row.some(f => f !== '')) rows.push(row);
  return rows.filter(r => r.some(c => c.trim() !== ''));
}
function _wlDate(s) {
  if (!s) return null; s = String(s).trim(); if (!s) return null;
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (m) { let y = m[3]; if (y.length === 2) y = '20' + y; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date(s); return isNaN(d) ? null : d.toISOString().slice(0, 10);
}
function _wlStatus(statusRaw, waitlistedRaw) {
  const s = (statusRaw || '').toLowerCase(), w = (waitlistedRaw || '').toLowerCase();
  if (/enrol|register|placed|accepted/.test(s)) return 'placed';
  if (/lost|declin|cancel|withdraw/.test(s)) return 'lost';
  if (/wait/.test(s) || /yes|true|^1$/.test(w)) return 'waiting';
  return s || 'waiting';
}
router.post('/import-waiting-list', authenticate, express.text({ type: () => true, limit: '20mb' }), async (req, res) => {
  if (!hasRole(req.user, ['manager', 'deputy_manager', 'admin'])) return res.status(403).json({ error: 'Manager only' });
  const text = typeof req.body === 'string' ? req.body : ((req.body && req.body.csv) || '');
  if (!text || text.length < 10) return res.status(400).json({ error: 'No CSV provided' });
  try {
    const rows = _wlParseCSV(text);
    if (rows.length < 2) return res.status(400).json({ error: 'CSV has no data rows' });
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const idx = nm => headers.indexOf(nm.toLowerCase());
    const cell = (r, ...names) => { for (const nm of names) { const i = idx(nm); if (i >= 0 && r[i] != null && String(r[i]).trim() !== '') return String(r[i]).trim(); } return null; };
    const db = getPool();
    let imported = 0, skipped = 0;
    for (let k = 1; k < rows.length; k++) {
      const r = rows[k];
      const fn = cell(r, 'Child First Name'), ln = cell(r, 'Child Last Name');
      if (!fn && !ln) { skipped++; continue; }
      const dob = _wlDate(cell(r, 'Child Date of Birth/Expected Date of Birth', 'Child Date of Birth', 'Child DOB'));
      const { rows: ex } = await db.query(
        `SELECT 1 FROM waiting_list_live WHERE lower(child_first_name)=lower($1)
           AND lower(coalesce(child_last_name,''))=lower(coalesce($2,''))
           AND coalesce(child_dob::text,'')=coalesce($3::text,'') LIMIT 1`, [fn, ln, dob]);
      if (ex.length) { skipped++; continue; }
      const parent = [cell(r, 'Parent First Name'), cell(r, 'Parent Last Name')].filter(Boolean).join(' ') || null;
      const notes = [
        cell(r, 'Stage') && `Stage: ${cell(r, 'Stage')}`,
        cell(r, 'Reason') && `Reason: ${cell(r, 'Reason')}`,
        cell(r, 'Requested Hours') && `Hours: ${cell(r, 'Requested Hours')}`,
        cell(r, 'Booking Type') && `Booking: ${cell(r, 'Booking Type')}`,
        cell(r, 'Attendance Schedule') && `Schedule: ${cell(r, 'Attendance Schedule')}`,
        cell(r, 'Preferred Session') && `Session: ${cell(r, 'Preferred Session')}`,
        cell(r, 'Tags') && `Tags: ${cell(r, 'Tags')}`,
        cell(r, 'Notes'),
      ].filter(Boolean).join(' · ') || null;
      await db.query(
        // b289 — the name+DOB existence check above already skips an exact repeat;
        // family_key additionally stops a row landing on top of a family that is
        // already here from the website form or the EyLog feed under a different DOB.
        `INSERT INTO waiting_list (child_first_name, child_last_name, child_dob, room_needed,
           expected_start_date, parent_name, parent_email, parent_phone, source, status, notes, date_added, added_at, created_at,
           family_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($12,NOW()),NOW(),
                 wl_family_key($1::text,$2::text,$7::text))
         ON CONFLICT (family_key) WHERE family_key IS NOT NULL AND merged_into_id IS NULL
         DO UPDATE SET
           child_dob           = COALESCE(waiting_list.child_dob,            EXCLUDED.child_dob),
           room_needed         = COALESCE(NULLIF(waiting_list.room_needed,''), EXCLUDED.room_needed),
           expected_start_date = COALESCE(waiting_list.expected_start_date,  EXCLUDED.expected_start_date),
           parent_email        = COALESCE(NULLIF(waiting_list.parent_email,''), EXCLUDED.parent_email),
           parent_phone        = COALESCE(NULLIF(waiting_list.parent_phone,''), EXCLUDED.parent_phone)`,
        [fn, ln, dob, cell(r, 'Waitlisted Room', 'Room'), _wlDate(cell(r, 'Preferred Start Date')),
         parent, cell(r, 'Parent Email'), cell(r, 'Parent Phone', 'Home Phone'),
         cell(r, 'Where did Parent hear about us? (Source)', 'Source', 'Utm Source'),
         _wlStatus(cell(r, 'Status'), cell(r, 'Waitlisted')), notes,
         _wlDate(cell(r, 'Waitlisted Date', 'Enquiry Date'))]);
      imported++;
    }
    res.json({ ok: true, imported, skipped, total: rows.length - 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 2026-09-29 (the admissions lead) — room on any row, and merging duplicates ─────────────────
// Families enquire twice (no reply, or half the details the first time). Deleting the
// second copy lost details and deleting the first lost their place. A merge keeps ONE
// record with the EARLIEST enquiry date, fills its blanks from the other, and marks the
// other merged (waiting_list: merged_into_id; enquiry: stage lost / "duplicate"). Nothing
// is deleted — both are production data.
const ROOMS_OK = ['Baby Room', 'Pre-school'];

router.post('/waiting-list/:id/room', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  const room = String((req.body || {}).room || '').trim();
  if (room && !ROOMS_OK.includes(room)) return res.status(400).json({ error: 'room must be Baby Room or Pre-school' });
  try {
    const db = getPool();
    // An EyMan booking pattern in room_needed is real data in the wrong column: keep it
    // in the notes rather than overwrite it.
    const { rows } = await db.query(`
      UPDATE waiting_list
         SET notes = CASE WHEN room_needed LIKE '%:%'
                          THEN concat_ws(E'\n', notes, 'EyMan booking pattern: ' || room_needed) ELSE notes END,
             room_needed = NULLIF($1,''),
             room_source = 'manual'
       WHERE id = $2 AND merged_into_id IS NULL
       RETURNING id, room_needed`, [room, req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, ...rows[0] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /merge  { keep:{type:'waiting'|'enquiry', id}, drop:{type, id} }
router.post('/merge', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  const { keep, drop } = req.body || {};
  const T = { waiting: 'waiting_list', enquiry: 'enquiries' };
  if (!keep || !drop || !T[keep.type] || !T[drop.type]) return res.status(400).json({ error: 'keep and drop {type,id} required' });
  if (keep.type === drop.type && Number(keep.id) === Number(drop.id)) return res.status(400).json({ error: 'Pick two different records' });
  if (keep.type === 'enquiry' && drop.type === 'waiting') {
    return res.status(400).json({ error: 'Keep the waiting-list record — it is further along. Merge the enquiry into it.' });
  }
  const db = getPool();
  const client = await db.connect();
  const who = (req.user && req.user.id) || null;
  try {
    await client.query('BEGIN');
    const get = async (t, id) => (await client.query(`SELECT * FROM ${T[t]} WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    const k = await get(keep.type, keep.id), d = await get(drop.type, drop.id);
    if (!k || !d) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Record not found' }); }
    if (d.merged_into_id) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'That record is already merged' }); }
    const enqDate = (r, t) => t === 'waiting' ? (r.date_added || r.created_at) : r.created_at;
    const earliest = [enqDate(k, keep.type), enqDate(d, drop.type)].filter(Boolean).map(x => new Date(x)).sort((a, b) => a - b)[0] || null;

    // Fill the kept record's blanks from the dropped one (never overwrite a value).
    const SHARED = ['child_first_name', 'child_last_name', 'child_dob', 'parent_name', 'parent_email',
                    'parent_phone', 'source'];
    const keepCols = new Set(Object.keys(k));
    const sets = [], vals = [];
    const blank = v => v == null || String(v).trim() === '';
    for (const c of SHARED) {
      if (keepCols.has(c) && blank(k[c]) && !blank(d[c])) { vals.push(d[c]); sets.push(`${c}=$${vals.length}`); }
    }
    // room: kept record's room if it is a real room, else the other's
    const realRoom = r => [r.preferred_room, r.room_needed].find(x => x && !String(x).includes(':'));
    if (!realRoom(k) && realRoom(d)) {
      const col = keep.type === 'waiting' ? 'room_needed' : 'preferred_room';
      vals.push(realRoom(d)); sets.push(`${col}=$${vals.length}`);
    }
    const note = `Merged ${new Date().toISOString().slice(0, 10)}: duplicate ${drop.type} #${drop.id} folded in` +
                 (d.notes ? ` (its notes: ${String(d.notes).slice(0, 500)})` : '');
    vals.push(note); sets.push(`notes = concat_ws(E'\\n', notes, $${vals.length}::text)`);
    if (earliest) {
      vals.push(earliest);
      sets.push(keep.type === 'waiting' ? `date_added = $${vals.length}` : `created_at = $${vals.length}`);
    }
    if (keep.type === 'waiting' && drop.type === 'enquiry' && !k.enquiry_id) { vals.push(d.id); sets.push(`enquiry_id=$${vals.length}`); }
    vals.push(k.id);
    await client.query(`UPDATE ${T[keep.type]} SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);

    if (drop.type === 'waiting') {
      await client.query(`UPDATE waiting_list SET merged_into_id=$1, merged_at=now(), merged_by=$2 WHERE id=$3`,
        [k.id, who, d.id]);
    } else {
      await client.query(`UPDATE enquiries SET stage='lost', lost_reason=$1, updated_at=now() WHERE id=$2`,
        [`Duplicate — merged into ${keep.type} #${k.id}`, d.id]);
    }
    await client.query('COMMIT');
    try { require('../utils/audit').recordAudit({ req, action: 'merge', entity_type: T[keep.type], entity_id: k.id,
      meta: { dropped: drop, earliest_enquiry: earliest } }); } catch (_) {}
    res.json({ ok: true, kept: keep, dropped: drop, enquired_at: earliest });
    // b399 (2026-10-06) — the dropped record's own enquiry-mode portal access
    // closes (the kept record carries the family forward); the KEPT record is
    // untouched even if it was itself in enquiry mode.
    const closeArgs = drop.type === 'waiting' ? { waitingListId: drop.id } : { enquiryId: drop.id };
    require('../lib/enquiry-access').closeEnquiryAccess(getPool(), { ...closeArgs, reason: `merged into ${keep.type} #${k.id}` }).catch(() => {});
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ═══════════════════════════════════════════════════════════════════════════
// b424 (2026-10-08) — pipeline board badges + email-detected stage suggestions.
// ═══════════════════════════════════════════════════════════════════════════

// GET /pipeline-status — one bulk call for every card's D/P/allergy/home-visit
// badges and "enquired <date>", same shape as /api/welcome-pack/progress.
router.get('/pipeline-status', requireCapability('admissions.enquire'), async (req, res) => {
  try {
    const status = await require('../lib/pipeline-status').loadPipelineStatus(getPool());
    res.json(status);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /suggested-moves — pending email-detected stage suggestions, for the chip on
// each card. Written by src/jobs/gmail-inbox-poller.js's b424Step.
router.get('/suggested-moves', requireCapability('admissions.enquire'), async (req, res) => {
  try {
    const { rows } = await getPool().query(`
      SELECT m.id, m.enquiry_id, m.to_stage, m.reason, m.source_email_subject, m.detected_at,
             e.child_first_name, e.child_last_name
        FROM pipeline_suggested_moves m
        JOIN enquiries e ON e.id = m.enquiry_id
       WHERE m.status = 'pending'
       ORDER BY m.detected_at DESC`);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/suggested-moves/:id/accept', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(
      `SELECT * FROM pipeline_suggested_moves WHERE id=$1 AND status='pending'`, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or already decided' });
    const m = rows[0];
    // b428 — "wants a place" has to create the real waiting_list row (the same
    // action the "Next stage → Waiting list" button runs), not just flip
    // enquiries.stage and leave the family off the Waiting list tab.
    // b429 — that makes this branch the SAME action as the convert-to-waiting-
    // list button, so it must require the same permission (admissions.offer
    // 'approve'), not the route's blanket admissions.enquire 'edit'.
    if (m.to_stage === 'on_waiting_list') {
      const level = await capabilityLevel(req.user, 'admissions.offer');
      if (levelRank(level) < levelRank('approve')) {
        return res.status(403).json({ error: 'capability_forbidden', capability: 'admissions.offer', required_level: 'approve' });
      }
      await convertToWaitingList(db, m.enquiry_id, req);
    } else {
      await advanceEnquiry(db, m.enquiry_id, m.to_stage, { req, reason: `email suggestion accepted: ${m.reason || ''}` });
    }
    await db.query(
      `UPDATE pipeline_suggested_moves SET status='accepted', decided_by=$2, decided_at=now() WHERE id=$1`,
      [m.id, req.user && req.user.id]);
    // b428 — an enquiry can have more than one open suggestion (different
    // to_stage values); deciding one shouldn't leave an older, now-stale chip
    // still sitting there for the same family.
    await db.query(
      `UPDATE pipeline_suggested_moves SET status='superseded', decided_by=$2, decided_at=now()
        WHERE enquiry_id=$1 AND status='pending' AND id<>$3`,
      [m.enquiry_id, req.user && req.user.id, m.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/suggested-moves/:id/dismiss', requireCapabilityLevel('admissions.enquire', 'edit'), async (req, res) => {
  try {
    const db = getPool();
    const { rows } = await db.query(
      `UPDATE pipeline_suggested_moves SET status='dismissed', decided_by=$2, decided_at=now()
        WHERE id=$1 AND status='pending' RETURNING id, enquiry_id`,
      [req.params.id, req.user && req.user.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found or already decided' });
    // b428 — same as accept: close any other open suggestion for this family too.
    await db.query(
      `UPDATE pipeline_suggested_moves SET status='superseded', decided_by=$2, decided_at=now()
        WHERE enquiry_id=$1 AND status='pending' AND id<>$3`,
      [rows[0].enquiry_id, req.user && req.user.id, rows[0].id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
// 3 Nov 2026: scripts/backfill-waiting-list-rows.js gives the cards stranded past
// "Waiting list" the row the move should have made, through the same function.
module.exports.convertToWaitingList = convertToWaitingList;
