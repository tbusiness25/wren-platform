'use strict';
// b336 — Viewings: one booking system for the office, the rooms and the
// family. This router covers the AUTHENTICATED surfaces — Roost (book on a
// family's behalf, the week grid, slot settings) and the EY app (a room's own
// upcoming viewings + Confirm/Can't-do-this-one). The public, token-gated
// family picker lives in viewings-public.js; James's read-only endpoint lives
// in vapi.js. All three read/write the same viewing_slots/viewings tables via
// src/lib/viewings-shared.js so "what's open" can never disagree between them.
//
// Toby, 2026-09-17: "the staff working in the rooms are the ones who know
// their timetable" — so however a viewing is proposed (office picks a slot on
// the phone, or a family self-books through the tokenised link), it lands as
// 'requested' and only becomes real once the room confirms it. Confirm is the
// one moment that creates the calendar entry, schedules reminders and emails
// the family — a human action, never automatic on a timer (brief, item 5).

const express = require('express');
const router = express.Router();
const { getPool } = require('../db/pool');
const authenticate = require('../middleware/auth');
const { sendViaGmail, COMMS_MAILBOX } = require('../lib/gmail-sender');
const { notifyAsync } = require('../services/notification-dispatcher');
const eventReminders = require('../lib/event-reminders');
const VS = require('../lib/viewings-shared');
// b398 — the pipeline moves forward on its own, and never backwards.
const { advanceEnquiry, resolveEnquiryId } = require('../lib/enquiry-stage');
const { hasRole } = require('../middleware/auth'); // one role rule: ROLE_SATISFIES in src/middleware/auth.js

router.use(authenticate);

// Office/management level — Toby/the office manager (role 'admin' post-b271-rename) and the
// deputies (role 'manager') — plus room_leader, since a room leader is also
// someone who fields the phone sometimes. Matches the guard shape already used
// for the ad-hoc single-viewing flow in waitlist.js (requireManagerOrRoomLeader).
function requireOffice(req, res, next) {
  if (req.user && hasRole(req.user, ['admin', 'manager', 'room_leader'])) return next();
  return res.status(403).json({ error: 'Office or room-leader access required' });
}

// Confirm/decline: the room's OWN staff (matching room_id) may act on their
// room's viewings, and office-level staff may act on any room (Toby/the office manager
// booked it, a room leader is off sick, etc).
function canActOnRoom(user, roomId) {
  if (!user) return false;
  if (hasRole(user, ['admin', 'manager'])) return true;
  return Number(user.room_id) === Number(roomId);
}

// Strictly owner-level (Toby/the office manager/the business manager post-rename) — the one setting that
// turns on automatic parent emails must be a deliberate, narrow switch.
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Owner/admin access required for this setting' });
}

function esc(s) { return String(s == null ? '' : s); }

async function viewingWithFamily(db, id) {
  const { rows } = await db.query(
    `SELECT v.*, r.name AS room_name, r.display_name AS room_display_name
       FROM viewings v JOIN rooms r ON r.id = v.room_id WHERE v.id=$1`, [id]);
  const v = rows[0];
  if (!v) return null;
  const family = await VS.loadFamily(db, v.family_type, v.family_id);
  return { ...v, slot_date: VS.ymd(v.slot_date), family };
}

// ── rooms (small convenience list for the pickers) ──────────────────────────
router.get('/rooms', async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT id, name, display_name FROM rooms ORDER BY id`);
    res.json({ rooms: rows });
  } catch (e) {
    console.error('[viewings rooms]', e.message);
    res.status(500).json({ error: 'Could not load rooms' });
  }
});

// ── family preview (for the "book on behalf" form — confirm before booking) ─
router.get('/family/:type/:id', requireOffice, async (req, res) => {
  const type = req.params.type;
  if (!['waiting_list', 'enquiry'].includes(type)) return res.status(400).json({ error: 'type must be waiting_list or enquiry' });
  try {
    const family = await VS.loadFamily(getPool(), type, parseInt(req.params.id, 10));
    if (!family) return res.status(404).json({ error: 'Not found' });
    res.json({ family });
  } catch (e) {
    console.error('[viewings family preview]', e.message);
    res.status(500).json({ error: 'Could not load family' });
  }
});

// ── the week grid — slot occurrences x what's booked in them ────────────────
// Any authenticated staff (Roost or EY, either room) may read this: "we all
// need to be aware and kept in check" (brief).
router.get('/grid', async (req, res) => {
  const db = getPool();
  const roomId = req.query.room_id ? parseInt(req.query.room_id, 10) : undefined;
  const days = req.query.days ? Math.min(31, Math.max(1, parseInt(req.query.days, 10) || 7)) : 7;
  try {
    const grid = await VS.computeSlotGrid(db, { roomId, from: req.query.from, days });
    // Attach a light family label to booked cells, without a second round trip
    // per cell — one lookup per distinct family already in the result.
    const need = grid.filter(g => g.viewing_id);
    const cache = new Map();
    for (const g of need) {
      const key = `${g.family_type}:${g.family_id}`;
      if (!cache.has(key)) cache.set(key, await VS.loadFamily(db, g.family_type, g.family_id));
      const fam = cache.get(key);
      g.family_label = fam ? `${fam.child_first_name || ''} ${fam.child_last_name || ''}`.trim() || fam.parent_name : null;
    }
    res.json({ grid });
  } catch (e) {
    console.error('[viewings grid]', e.message);
    res.status(500).json({ error: 'Could not load the viewing grid' });
  }
});

// ── list actual viewing rows (EY "my room's upcoming", Roost lists) ─────────
router.get('/', async (req, res) => {
  const db = getPool();
  const { room_id, status, from, to } = req.query;
  const clauses = [];
  const params = [];
  if (room_id) { params.push(parseInt(room_id, 10)); clauses.push(`v.room_id = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`v.status = $${params.length}`); }
  if (from) { params.push(from); clauses.push(`v.slot_date >= $${params.length}`); }
  if (to) { params.push(to); clauses.push(`v.slot_date <= $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  try {
    const { rows } = await db.query(
      `SELECT v.*, r.name AS room_name, r.display_name AS room_display_name
         FROM viewings v JOIN rooms r ON r.id = v.room_id
         ${where}
        ORDER BY v.slot_date, v.start_time`, params);
    const cache = new Map();
    const out = [];
    for (const v of rows) {
      const key = `${v.family_type}:${v.family_id}`;
      if (!cache.has(key)) cache.set(key, await VS.loadFamily(db, v.family_type, v.family_id));
      out.push({ ...v, slot_date: VS.ymd(v.slot_date), family: cache.get(key) });
    }
    res.json({ viewings: out });
  } catch (e) {
    console.error('[viewings list]', e.message);
    res.status(500).json({ error: 'Could not load viewings' });
  }
});

// ── book on a family's behalf — the phone case (Toby, the office manager or James/AI) ────
router.post('/', requireOffice, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const familyType = b.family_type;
  const familyId = parseInt(b.family_id, 10);
  const roomId = parseInt(b.room_id, 10);
  const date = String(b.date || '');
  const startTime = String(b.start_time || '');
  if (!['waiting_list', 'enquiry'].includes(familyType) || !Number.isInteger(familyId)) {
    return res.status(400).json({ error: 'family_type (waiting_list|enquiry) and family_id required' });
  }
  if (!Number.isInteger(roomId) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{1,2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ error: 'room_id, date (YYYY-MM-DD) and start_time (HH:MM) required' });
  }
  try {
    const family = await VS.loadFamily(db, familyType, familyId);
    if (!family) return res.status(404).json({ error: `${familyType} record not found` });

    const { rows: slotRows } = await db.query(
      `SELECT duration_minutes FROM viewing_slots WHERE room_id=$1 AND weekday=$2 AND start_time=$3 AND active=true`,
      [roomId, VS.isoWeekday(date), startTime]);
    if (!slotRows.length) return res.status(400).json({ error: 'That is not an open slot for this room and day' });
    const endTime = VS.addMinutes(startTime, slotRows[0].duration_minutes);

    const { rows } = await db.query(
      `INSERT INTO viewings
         (room_id, slot_date, start_time, end_time, status, family_type, family_id,
          requested_via, requested_by, notes)
       VALUES ($1,$2,$3,$4,'requested',$5,$6,'staff',$7,$8)
       RETURNING *`,
      [roomId, date, startTime, endTime, familyType, familyId, req.user.id, String(b.notes || '').slice(0, 2000) || null]);
    const v = rows[0];

    // b398 — booking a viewing moves the pipeline card to "tour_booked" on its
    // own, instead of sitting on "new" until someone remembers to drag it.
    try {
      const enquiryId = await resolveEnquiryId(db, familyType, familyId);
      if (enquiryId) await advanceEnquiry(db, enquiryId, 'tour_booked', { req, reason: 'viewing booked' });
    } catch (e) { console.error('[viewings book stage-advance]', e.message); }

    // Tell the room this needs a look — they're the ones who know their
    // timetable, and a request sitting unseen until the next morning-of sweep
    // defeats the point.
    const { rows: roomStaff } = await db.query(
      `SELECT id FROM staff WHERE room_id=$1 AND is_active=true`, [roomId]);
    for (const s of roomStaff) {
      try {
        await notifyAsync('viewing_booked', 'staff', s.id,
          `👋 Viewing requested — ${family.child_first_name || 'a family'}`,
          `${date} at ${startTime} · confirm it or say you can't do this one`,
          { relatedTable: 'viewings', relatedId: v.id, link: '/ey/viewings' });
      } catch (e) { console.error('[viewings book notify]', e.message); }
    }

    res.status(201).json({ ok: true, viewing: { ...v, slot_date: VS.ymd(v.slot_date), family } });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'That slot has just been taken — pick another.' });
    console.error('[viewings book]', e.message);
    res.status(500).json({ error: 'Book viewing failed: ' + e.message });
  }
});

// ── EY: Confirm ───────────────────────────────────────────────────────────
router.patch('/:id/confirm', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await db.query(`SELECT * FROM viewings WHERE id=$1`, [id]);
    const v = rows[0];
    if (!v) return res.status(404).json({ error: 'Viewing not found' });
    if (!canActOnRoom(req.user, v.room_id)) return res.status(403).json({ error: 'Not your room' });
    if (v.status !== 'requested') return res.status(409).json({ error: `Viewing is ${v.status}, not requested` });

    const family = await VS.loadFamily(db, v.family_type, v.family_id);
    const childFirst = (family && family.child_first_name) || 'family';

    const { rows: roomStaff } = await db.query(
      `SELECT id FROM staff WHERE room_id=$1 AND is_active=true`, [v.room_id]);
    const staffIds = roomStaff.map(s => s.id);

    const { rows: evRows } = await db.query(`
      INSERT INTO events
        (title, description, event_date, start_time, end_time, location, audience,
         rsvp_required, is_published, created_by, staff_ids, source_table, source_id)
      VALUES ($1,$2,$3,$4,$5,$6,'staff',false,true,$7,$8,'viewings',$9)
      RETURNING id`,
      [`Viewing — ${childFirst}`,
       `Show-round for ${childFirst}${family && family.child_last_name ? ' ' + family.child_last_name : ''}`
         + (family && family.parent_name ? ` (parent: ${family.parent_name})` : '') + '.',
       VS.ymd(v.slot_date), v.start_time, v.end_time, 'Your Nursery',
       req.user.id, staffIds.length ? staffIds : null, v.id]);
    const eventId = evRows[0].id;

    const { rows: updRows } = await db.query(
      `UPDATE viewings SET status='confirmed', confirmed_by=$1, confirmed_at=now(), event_id=$2, updated_at=now()
        WHERE id=$3 RETURNING *`, [req.user.id, eventId, id]);

    // b531 (the admissions lead, 27 Oct) — confirming a viewing keeps the card on Tour booked
    // (it is booked, it hasn't happened yet). It moves to Tour done only when
    // someone marks the family as attended (PATCH /:id/attendance below). b398
    // moved it on confirm, so a family who never turned up showed as Tour done.
    try {
      const enquiryId = await resolveEnquiryId(db, v.family_type, v.family_id);
      if (enquiryId) await advanceEnquiry(db, enquiryId, 'tour_booked', { req, reason: 'viewing confirmed' });
    } catch (e) { console.error('[viewings confirm stage-advance]', e.message); }

    try { await eventReminders.scheduleEventReminders(db, eventId); }
    catch (e) { console.error('[viewings confirm reminders]', e.message); }

    // Office visibility — "we all need to be aware and kept in check".
    const { rows: office } = await db.query(`SELECT id FROM staff WHERE is_active=true AND role='admin'`);
    for (const s of office) {
      notifyAsync('viewing_confirmed', 'staff', s.id,
        `✅ Viewing confirmed — ${childFirst}`,
        `${VS.ymd(v.slot_date)} at ${v.start_time}, ${req.user.name || 'a staff member'} confirmed it.`,
        { relatedTable: 'events', relatedId: eventId, link: '/admin/viewings' }).catch(() => {});
    }

    // Mark any invite this booking came from as used (harmless no-op if none).
    await db.query(
      `UPDATE viewing_invites SET status='used', used_viewing_id=$1
        WHERE family_type=$2 AND family_id=$3 AND status IN ('pending','used') AND used_viewing_id IS NULL`,
      [id, v.family_type, v.family_id]).catch(() => {});

    // b398 — confirming the viewing no longer sends the parent email itself
    // (gap: "Viewing confirmation emails the parent with no preview"). It
    // still composes the draft so Roost/EY can show it, but a person now has
    // to press Send on PATCH /:id/send-confirmation below — the same
    // preview-before-send rule as the offer email.
    let emailPreview = null;
    if (family && family.parent_email) {
      const room = (await db.query(`SELECT display_name, name FROM rooms WHERE id=$1`, [v.room_id])).rows[0];
      const roomName = room ? (room.display_name || room.name) : '';
      emailPreview = viewingConfirmationEmail(family, v, roomName);
    }

    res.json({
      ok: true, viewing: { ...updRows[0], slot_date: VS.ymd(updRows[0].slot_date) },
      event_id: eventId, email_preview: emailPreview,
    });
  } catch (e) {
    console.error('[viewings confirm]', e.message);
    res.status(500).json({ error: 'Confirm failed: ' + e.message });
  }
});

// Shared by the preview above and the actual send below, so the two can never
// drift apart (same rule as the rest of the codebase: compose once).
function viewingConfirmationEmail(family, v, roomName) {
  const html = `<p>Hello${family.parent_name ? ' ' + esc(family.parent_name) : ''},</p>
    <p>Your viewing at Your Nursery is confirmed:</p>
    <p><b>${esc(VS.ymd(v.slot_date))} at ${esc(v.start_time)}</b><br>
    ${esc(roomName)}<br>
    123 Example Lane, AB1 2CD</p>
    <p>If you need to cancel or change this, just reply to this email or call the nursery.</p>
    <p>We look forward to seeing you.<br>Your Nursery</p>`;
  return { to: family.parent_email, subject: 'Your viewing is confirmed — Your Nursery', html };
}

// ── Roost/EY: send the confirmation email — the explicit "Send" press on the
// preview PATCH /:id/confirm returned. Editable: subject/html overrides from
// the preview the person was shown, same pattern as the waiting-list message
// route. Never auto-fires; this IS the human action.
router.patch('/:id/send-confirmation', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await db.query(`SELECT * FROM viewings WHERE id=$1`, [id]);
    const v = rows[0];
    if (!v) return res.status(404).json({ error: 'Viewing not found' });
    if (!canActOnRoom(req.user, v.room_id)) return res.status(403).json({ error: 'Not your room' });
    if (v.status !== 'confirmed') return res.status(409).json({ error: 'Only a confirmed viewing has a confirmation email to send' });

    const family = await VS.loadFamily(db, v.family_type, v.family_id);
    if (!family || !family.parent_email) return res.status(400).json({ error: 'No parent email on file for this family' });

    const room = (await db.query(`SELECT display_name, name FROM rooms WHERE id=$1`, [v.room_id])).rows[0];
    const roomName = room ? (room.display_name || room.name) : '';
    const draft = viewingConfirmationEmail(family, v, roomName);
    const subject = (req.body && req.body.subject) ? String(req.body.subject).slice(0, 300) : draft.subject;
    const html = (req.body && req.body.html) ? String(req.body.html).slice(0, 20000) : draft.html;

    const mailResult = await sendViaGmail({ to: family.parent_email, subject, html, from: COMMS_MAILBOX });
    if (mailResult.disabled) return res.status(502).json({ error: 'Send failed — no mail transport configured' });
    await db.query(`UPDATE viewings SET confirmation_email_sent_at=now() WHERE id=$1`, [id]);
    res.json({ ok: true, sent_to: family.parent_email });
  } catch (e) {
    console.error('[viewings send-confirmation]', e.message);
    res.status(500).json({ error: 'Send failed: ' + e.message });
  }
});

// ── EY: "Can't do this one" ──────────────────────────────────────────────────
router.patch('/:id/decline', async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await db.query(`SELECT * FROM viewings WHERE id=$1`, [id]);
    const v = rows[0];
    if (!v) return res.status(404).json({ error: 'Viewing not found' });
    if (!canActOnRoom(req.user, v.room_id)) return res.status(403).json({ error: 'Not your room' });
    if (!['requested', 'confirmed'].includes(v.status)) {
      return res.status(409).json({ error: `Viewing is already ${v.status}` });
    }

    const reason = String((req.body || {}).reason || '').slice(0, 500) || null;
    const { rows: updRows } = await db.query(
      `UPDATE viewings SET status='declined', declined_by=$1, declined_at=now(), decline_reason=$2, event_id=NULL, updated_at=now()
        WHERE id=$3 RETURNING *`, [req.user.id, reason, id]);

    // viewings.event_id FK's default NO ACTION blocks a delete while it still
    // points here — the UPDATE above clears it first so this can succeed
    // (caught the hard way: a swallowed FK-violation left two orphaned rows
    // in `events` during b336 verification — see scripts/b336-verify.js).
    if (v.event_id) {
      await db.query(`DELETE FROM events WHERE id=$1 AND source_table='viewings'`, [v.event_id])
        .catch(e => console.error('[viewings decline event cleanup]', e.message));
    }

    const family = await VS.loadFamily(db, v.family_type, v.family_id);
    const { rows: office } = await db.query(`SELECT id FROM staff WHERE is_active=true AND role IN ('admin','manager')`);
    for (const s of office) {
      notifyAsync('viewing_booked', 'staff', s.id,
        `⚠️ Viewing needs rebooking — ${(family && family.child_first_name) || 'a family'}`,
        `${VS.ymd(v.slot_date)} at ${v.start_time} — ${req.user.name || 'the room'} can't do this one.` + (reason ? ` (${reason})` : ''),
        { relatedTable: 'viewings', relatedId: v.id, link: '/admin/viewings' }).catch(() => {});
    }

    res.json({ ok: true, viewing: { ...updRows[0], slot_date: VS.ymd(updRows[0].slot_date) } });
  } catch (e) {
    console.error('[viewings decline]', e.message);
    res.status(500).json({ error: 'Decline failed: ' + e.message });
  }
});

// ── Roost: office-initiated cancel ───────────────────────────────────────────
router.patch('/:id/cancel', requireOffice, async (req, res) => {
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  try {
    const { rows } = await db.query(`SELECT * FROM viewings WHERE id=$1`, [id]);
    const v = rows[0];
    if (!v) return res.status(404).json({ error: 'Viewing not found' });
    if (['cancelled', 'attended', 'no_show'].includes(v.status)) {
      return res.status(409).json({ error: `Viewing is already ${v.status}` });
    }
    const { rows: updRows } = await db.query(
      `UPDATE viewings SET status='cancelled', cancelled_by=$1, cancelled_at=now(), event_id=NULL, updated_at=now()
        WHERE id=$2 RETURNING *`, [req.user.id, id]);
    if (v.event_id) {
      await db.query(`DELETE FROM events WHERE id=$1 AND source_table='viewings'`, [v.event_id])
        .catch(e => console.error('[viewings cancel event cleanup]', e.message));
    }
    res.json({ ok: true, viewing: { ...updRows[0], slot_date: VS.ymd(updRows[0].slot_date) } });
  } catch (e) {
    console.error('[viewings cancel]', e.message);
    res.status(500).json({ error: 'Cancel failed: ' + e.message });
  }
});

// ── Roost + EY: mark attendance after the fact ───────────────────────────────
// b531 (the admissions lead, 27 Oct) — the room that showed the family round is the one that
// knows whether they came, so the room's own staff can mark it from the tablet
// (same canActOnRoom rule as Confirm), as well as the office from Roost. A
// mistake can be corrected (attended <-> no_show); the card never moves back.
router.patch('/:id/attendance', async (req, res) => {
  const status = (req.body || {}).status;
  if (!['attended', 'no_show'].includes(status)) return res.status(400).json({ error: "status must be 'attended' or 'no_show'" });
  const db = getPool();
  const id = parseInt(req.params.id, 10);
  try {
    const { rows: cur } = await db.query(`SELECT * FROM viewings WHERE id=$1`, [id]);
    if (!cur.length) return res.status(404).json({ error: 'Viewing not found' });
    const isOffice = req.user && ['admin', 'manager', 'room_leader'].includes(req.user.role);
    if (!isOffice && !canActOnRoom(req.user, cur[0].room_id)) return res.status(403).json({ error: 'Not your room' });
    if (VS.ymd(cur[0].slot_date) > VS.todayLondon()) return res.status(409).json({ error: 'This viewing hasn’t happened yet' });
    const { rows } = await db.query(
      `UPDATE viewings SET status=$1, attendance_marked_by=$2, attendance_marked_at=now(), updated_at=now()
        WHERE id=$3 AND status IN ('confirmed','attended','no_show') RETURNING *`, [status, req.user.id, id]);
    if (!rows.length) return res.status(409).json({ error: 'Only a confirmed viewing can be marked attended/no-show' });
    const v = rows[0];
    if (status === 'attended') {
      try {
        const enquiryId = await resolveEnquiryId(db, v.family_type, v.family_id);
        if (enquiryId) await advanceEnquiry(db, enquiryId, 'tour_done', { req, reason: 'viewing attended' });
      } catch (e) { console.error('[viewings attendance stage-advance]', e.message); }
    } else if (cur[0].status !== 'no_show') {
      const family = await VS.loadFamily(db, v.family_type, v.family_id);
      const { rows: office } = await db.query(`SELECT id FROM staff WHERE is_active=true AND role='admin'`);
      for (const s of office) {
        notifyAsync('viewing_booked', 'staff', s.id,
          `📞 Didn't come to their viewing — ${(family && family.child_first_name) || 'a family'}`,
          `${VS.ymd(v.slot_date)} at ${v.start_time} · follow up or rebook from Viewings → Follow up.`,
          { relatedTable: 'viewings', relatedId: v.id, link: '/admin/viewings' }).catch(() => {});
      }
    }
    res.json({ ok: true, viewing: { ...v, slot_date: VS.ymd(v.slot_date) } });
  } catch (e) {
    console.error('[viewings attendance]', e.message);
    res.status(500).json({ error: 'Attendance update failed' });
  }
});

// ── Roost: mint a family link + optionally email it (item 4) ────────────────
// A human staff action ("office sends a link"), not a timer — same rule as the
// confirmation email. feedback_no_auto_email_to_parents (brief pointer) is
// about UNPROMPTED automation; a staff member pressing "send" is the prompt.
router.post('/invites', requireOffice, async (req, res) => {
  const db = getPool();
  const b = req.body || {};
  const familyType = b.family_type;
  const familyId = parseInt(b.family_id, 10);
  if (!['waiting_list', 'enquiry'].includes(familyType) || !Number.isInteger(familyId)) {
    return res.status(400).json({ error: 'family_type (waiting_list|enquiry) and family_id required' });
  }
  try {
    const family = await VS.loadFamily(db, familyType, familyId);
    if (!family) return res.status(404).json({ error: `${familyType} record not found` });
    const roomId = await VS.resolveFamilyRoomId(db, family);
    const crypto = require('crypto');
    const token = crypto.randomBytes(24).toString('base64url');
    const { rows } = await db.query(
      `INSERT INTO viewing_invites (family_type, family_id, room_id, token, created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, token, expires_at`,
      [familyType, familyId, roomId, token, req.user.id]);
    // The apex domain (example-nursery.co.uk) is a DIFFERENT container
    // (nursery-website, :8086) — /viewing/:token only exists on wren-ladn's own
    // portal hosts. Same fix as leavers-gift.js's KEEPSAKE_PUBLIC_BASE: default
    // to ey.* because it carries no Cloudflare Access gate (parents.* and
    // admin.* both do), and the route is portal-agnostic so it works there
    // regardless of the "ey" in the hostname. Same open question already
    // flagged to Toby for onboarding invites (memory: project_onboarding_
    // invites.md) — see NOTES for the pointer.
    const base = process.env.VIEWING_PUBLIC_BASE || 'https://ey.example-nursery.co.uk';
    const url = `${base}/viewing/${token}`;

    let mailResult = { disabled: true, sent: false };
    const draft = inviteEmail(family, url);
    if (b.send_email && family.parent_email) {
      try {
        mailResult = await sendViaGmail({ to: family.parent_email, subject: draft.subject, html: draft.html, from: COMMS_MAILBOX });
        mailResult.sent = !mailResult.disabled;
        if (mailResult.sent) await db.query(`UPDATE viewing_invites SET email_sent_at=now() WHERE id=$1`, [rows[0].id]);
      } catch (e) { console.error('[viewings invite email]', e.message); }
    }
    res.status(201).json({ ok: true, id: rows[0].id, token, url, expires_at: rows[0].expires_at, mail_disabled: !!mailResult.disabled, emailed: !!mailResult.sent,
      email_preview: family.parent_email ? { to: family.parent_email, ...draft } : null });
  } catch (e) {
    console.error('[viewings invite]', e.message);
    res.status(500).json({ error: 'Could not create invite link' });
  }
});

// Shared by the preview above and the send below, so they can never differ.
function inviteEmail(family, url) {
  const html = `<p>Hello${family.parent_name ? ' ' + esc(family.parent_name) : ''},</p>
        <p>Please pick a time for your viewing at Your Nursery using the link below:</p>
        <p><a href="${esc(url)}">${esc(url)}</a></p>
        <p>Your Nursery · 123 Example Lane, AB1 2CD</p>`;
  return { subject: 'Book your viewing — Your Nursery', html };
}

// b531 — Roost: send a link that was minted above with send_email:false, after
// the person has seen the preview. The explicit Send press; never on a timer.
router.post('/invites/:id/send', requireOffice, async (req, res) => {
  const db = getPool();
  try {
    const { rows } = await db.query(`SELECT * FROM viewing_invites WHERE id=$1`, [parseInt(req.params.id, 10)]);
    const inv = rows[0];
    if (!inv) return res.status(404).json({ error: 'Link not found' });
    if (inv.status !== 'pending') return res.status(409).json({ error: `This link is already ${inv.status}` });
    const family = await VS.loadFamily(db, inv.family_type, inv.family_id);
    if (!family || !family.parent_email) return res.status(400).json({ error: 'No parent email on file for this family' });
    const base = process.env.VIEWING_PUBLIC_BASE || 'https://ey.example-nursery.co.uk';
    const draft = inviteEmail(family, `${base}/viewing/${inv.token}`);
    const mailResult = await sendViaGmail({ to: family.parent_email, subject: draft.subject, html: draft.html, from: COMMS_MAILBOX });
    if (mailResult.disabled) return res.status(502).json({ error: 'Send failed — no mail transport configured' });
    await db.query(`UPDATE viewing_invites SET email_sent_at=now() WHERE id=$1`, [inv.id]);
    res.json({ ok: true, sent_to: family.parent_email });
  } catch (e) {
    console.error('[viewings invite send]', e.message);
    res.status(500).json({ error: 'Send failed: ' + e.message });
  }
});

// ── Roost: slot settings ("a setting, not constants") ────────────────────────
router.get('/slots', async (req, res) => {
  try {
    const { rows } = await getPool().query(
      `SELECT vs.*, r.name AS room_name, r.display_name AS room_display_name
         FROM viewing_slots vs JOIN rooms r ON r.id = vs.room_id
        ORDER BY vs.room_id, vs.weekday, vs.start_time`);
    res.json({ slots: rows });
  } catch (e) {
    console.error('[viewings slots list]', e.message);
    res.status(500).json({ error: 'Could not load slot settings' });
  }
});

router.post('/slots', requireOffice, async (req, res) => {
  const b = req.body || {};
  const roomId = parseInt(b.room_id, 10);
  const weekday = parseInt(b.weekday, 10);
  const startTime = String(b.start_time || '');
  const duration = Number.isFinite(parseInt(b.duration_minutes, 10)) ? parseInt(b.duration_minutes, 10) : 30;
  if (!Number.isInteger(roomId) || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 || !/^\d{1,2}:\d{2}$/.test(startTime)) {
    return res.status(400).json({ error: 'room_id, weekday (0=Mon..6=Sun) and start_time (HH:MM) required' });
  }
  try {
    const { rows } = await getPool().query(
      `INSERT INTO viewing_slots (room_id, weekday, start_time, duration_minutes, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (room_id, weekday, start_time) DO UPDATE SET active=true, duration_minutes=$4
       RETURNING *`, [roomId, weekday, startTime, duration, req.user.id]);
    res.status(201).json({ ok: true, slot: rows[0] });
  } catch (e) {
    console.error('[viewings slots create]', e.message);
    res.status(500).json({ error: 'Could not save slot' });
  }
});

router.patch('/slots/:id', requireOffice, async (req, res) => {
  const b = req.body || {};
  const fields = [];
  const params = [];
  if (typeof b.active === 'boolean') { params.push(b.active); fields.push(`active=$${params.length}`); }
  if (b.duration_minutes != null) { params.push(parseInt(b.duration_minutes, 10)); fields.push(`duration_minutes=$${params.length}`); }
  if (b.start_time) { params.push(String(b.start_time)); fields.push(`start_time=$${params.length}`); }
  if (!fields.length) return res.status(400).json({ error: 'Nothing to update' });
  fields.push('updated_at=now()');
  params.push(parseInt(req.params.id, 10));
  try {
    const { rows } = await getPool().query(
      `UPDATE viewing_slots SET ${fields.join(', ')} WHERE id=$${params.length} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: 'Slot not found' });
    res.json({ ok: true, slot: rows[0] });
  } catch (e) {
    console.error('[viewings slots update]', e.message);
    res.status(500).json({ error: 'Could not update slot' });
  }
});

// ── settings: parent reminders (default OFF, owner-only to flip) ────────────
router.get('/settings', requireOffice, async (req, res) => {
  try {
    const { rows } = await getPool().query(`SELECT value FROM settings WHERE key='viewing_parent_reminders_enabled'`);
    res.json({ parent_reminders_enabled: (rows[0] && rows[0].value === 'true') || false });
  } catch (e) {
    console.error('[viewings settings get]', e.message);
    res.status(500).json({ error: 'Could not load settings' });
  }
});

router.patch('/settings', requireAdmin, async (req, res) => {
  const enabled = (req.body || {}).parent_reminders_enabled === true;
  try {
    await getPool().query(
      `INSERT INTO settings (key, value, updated_by, updated_at) VALUES ('viewing_parent_reminders_enabled',$1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value=$1, updated_by=$2, updated_at=now()`,
      [enabled ? 'true' : 'false', req.user.id]);
    res.json({ ok: true, parent_reminders_enabled: enabled });
  } catch (e) {
    console.error('[viewings settings patch]', e.message);
    res.status(500).json({ error: 'Could not update settings' });
  }
});

// A single-viewing lookup by id — registered LAST, after every literal
// single-segment route above (/rooms, /grid, /slots, /settings), so none of
// them are ever swallowed by this param route. (Express 5 / path-to-regexp v6+
// also dropped the `:id(\d+)` inline-regex constraint this used to lean on —
// plain :id here, validated with parseInt in the handler.)
router.get('/:id', async (req, res) => {
  try {
    const v = await viewingWithFamily(getPool(), parseInt(req.params.id, 10));
    if (!v) return res.status(404).json({ error: 'Viewing not found' });
    res.json({ viewing: v });
  } catch (e) {
    console.error('[viewings get]', e.message);
    res.status(500).json({ error: 'Could not load viewing' });
  }
});

module.exports = router;
